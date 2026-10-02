import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { createServer } from "node:http";
import { createServer as createTcpServer } from "node:net";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import { createCameraGateway, validateCameraConfig } from "./cameras.mjs";
async function removeTestDirectory(directory) {
  const target = resolve(directory);
  assert.equal(dirname(target), resolve(tmpdir()));
  assert.ok(basename(target).startsWith("velocity-camera-tests-"));
  await rm(target, { recursive: true, force: true, maxRetries: 3 });
}
function segmentBytes() {
  const buffer = Buffer.alloc(188 * 4);
  for (let offset = 0; offset < buffer.length; offset += 188)
    buffer[offset] = 0x47;
  return buffer;
}
async function fixture(t, options = {}) {
  const root = await mkdtemp(join(tmpdir(), "velocity-camera-tests-"));
  const children = [];
  const gateway = createCameraGateway({
    tmpRoot: root,
    ffmpegPath: "test-ffmpeg",
    pollIntervalMs: 2,
    startupTimeoutMs: 100,
    ...options,
    spawn(executable, args, spawnOptions) {
      const child = new EventEmitter();
      child.stderr = new PassThrough();
      child.kills = [];
      child.kill = (signal) => {
        child.kills.push(signal);
        queueMicrotask(() => child.emit("close", 0));
        return true;
      };
      children.push({ child, executable, args, options: spawnOptions });
      const directory = dirname(args.at(-1));
      if (options.failure) {
        queueMicrotask(() => {
          child.stderr.write(options.failure);
          child.emit("close", 1);
        });
      } else if (!options.hang) {
        writeFileSync(join(directory, "segment-000000000.ts"), segmentBytes());
        writeFileSync(
          join(directory, "index.m3u8"),
          "#EXTM3U\n#EXT-X-TARGETDURATION:1\n#EXTINF:1,\nsegment-000000000.ts\n",
        );
      }
      return child;
    },
  });
  t.after(async () => {
    await gateway.close();
    await removeTestDirectory(root);
  });
  return { gateway, root, children };
}
function response() {
  return {
    status: 0,
    headers: {},
    body: undefined,
    setHeader(name, value) {
      this.headers[name] = value;
    },
    writeHead(status, headers) {
      this.status = status;
      Object.assign(this.headers, headers);
    },
    end(body) {
      this.body = body;
    },
  };
}
async function waitFor(predicate, message, timeoutMs = 1000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolveWait) => setTimeout(resolveWait, 5));
  }
  assert.fail(message);
}
test("camera guards reject non-network protocols, malformed credentials, controls, and host injection", () => {
  for (const url of [
    "file:///etc/passwd",
    "concat:http://camera/a|file:/secret",
    "data:video/mp4;base64,AAAA",
    "ftp://camera/video",
    "pipe:0",
    "http://camera/video\n-extra",
    "http://user:%0a@camera/stream",
    "http://camera/%0d%0a",
    "http://camera/video#fragment",
  ]) {
    assert.throws(
      () => validateCameraConfig({ type: "url", url }),
      (error) => error.status === 400,
    );
  }
  for (const host of [
    "",
    "http://camera",
    "camera/path",
    "user@camera",
    "camera\n",
    "camera:80",
    "-invalid",
  ]) {
    assert.throws(
      () => validateCameraConfig({ type: "onvif", host }),
      (error) => error.status === 400,
    );
  }
  assert.throws(
    () =>
      validateCameraConfig({
        type: "onvif",
        host: "camera.local",
        password: "secret\rheader",
      }),
    (error) => error.status === 400,
  );
  assert.throws(
    () =>
      validateCameraConfig({
        type: "onvif",
        host: "camera.local",
        port: 65536,
      }),
    (error) => error.status === 400,
  );
  assert.throws(
    () => validateCameraConfig({ type: "rtsp", url: "https://camera/video" }),
    (error) => error.status === 400,
  );
  assert.throws(
    () =>
      validateCameraConfig({
        type: "url",
        url: "https://camera/video",
        extra: true,
      }),
    (error) => error.status === 400,
  );
});
test("camera guards support IP cameras and encode literal credentials exactly once", () => {
  assert.equal(
    validateCameraConfig({ type: "onvif", host: "[::1]" }).host,
    "::1",
  );
  assert.equal(
    validateCameraConfig({ type: "onvif", host: "192.168.1.10", port: 8899 })
      .port,
    8899,
  );
  const result = validateCameraConfig({
    type: "rtsp",
    url: "rtsp://camera.local/live",
    username: "user@office",
    password: "p%0a:ss/word",
  });
  const url = new URL(result.url);
  assert.equal(decodeURIComponent(url.username), "user@office");
  assert.equal(decodeURIComponent(url.password), "p%0a:ss/word");
});
test("gateway serves a playable stream and closes process and temporary files", async (t) => {
  const { gateway, root, children } = await fixture(t);
  const camera = await gateway.connect({
    type: "rtsp",
    url: "rtsp://camera.local/live",
    username: "operator",
    password: "private-password",
    name: "Entrance",
  });
  assert.deepEqual(Object.keys(camera).sort(), [
    "id",
    "name",
    "playbackUrl",
    "status",
    "type",
  ]);
  assert.equal(camera.status, "live");
  assert.ok(!JSON.stringify(camera).includes("private-password"));
  const child = children[0];
  assert.equal(child.options.shell, false);
  assert.equal(child.options.windowsHide, true);
  const protocols =
    child.args[child.args.indexOf("-protocol_whitelist") + 1].split(",");
  assert.ok(!protocols.includes("file") && !protocols.includes("concat"));
  assert.equal(child.args[child.args.indexOf("-rtsp_transport") + 1], "tcp");
  assert.ok(
    !child.args.includes("-rw_timeout"),
    "RTSP demuxer uses -timeout; it rejects HTTP rw_timeout.",
  );
  const playlist = response();
  assert.equal(
    await gateway.handle(
      { method: "GET" },
      playlist,
      new URL(camera.playbackUrl, "http://local"),
    ),
    true,
  );
  assert.equal(playlist.status, 200);
  assert.match(playlist.body.toString(), /#EXTM3U/);
  const segment = response();
  await gateway.handle(
    { method: "HEAD" },
    segment,
    new URL(
      camera.playbackUrl.replace("index.m3u8", "segment-000000000.ts"),
      "http://local",
    ),
  );
  assert.equal(segment.status, 200);
  assert.equal(segment.body, undefined);
  assert.ok(segment.headers["Content-Length"] > 0);
  const status = response();
  await gateway.handle(
    { method: "GET" },
    status,
    new URL(camera.playbackUrl.replace("index.m3u8", "status"), "http://local"),
  );
  assert.equal(JSON.parse(status.body).status, "live");
  assert.equal(await gateway.disconnect(camera.id), true);
  assert.equal(await gateway.disconnect(camera.id), false);
  assert.deepEqual(child.child.kills, ["SIGTERM"]);
  assert.deepEqual(await readdir(root), []);
});
test("gateway limits concurrent pending ONVIF connections before processes start", async (t) => {
  const discoveries = [];
  const { gateway, children } = await fixture(t, {
    resolveOnvif: () =>
      new Promise((resolveUri) => discoveries.push(resolveUri)),
  });
  const first = gateway.connect({ type: "onvif", host: "camera-one.local" });
  const second = gateway.connect({ type: "onvif", host: "camera-two.local" });
  await assert.rejects(
    gateway.connect({ type: "url", url: "https://camera.local/live.m3u8" }),
    (error) => error.status === 409,
  );
  assert.equal(children.length, 0);
  discoveries.forEach((resolveUri) => resolveUri("rtsp://192.168.1.15/stream"));
  assert.equal((await first).status, "live");
  assert.equal((await second).status, "live");
});
test("ONVIF responses cannot introduce local file access", async (t) => {
  const { gateway, children, root } = await fixture(t, {
    resolveOnvif: async () => "file:///private/document",
  });
  await assert.rejects(
    gateway.connect({ type: "onvif", host: "camera.local" }),
    (error) => error.status === 400 && !error.message.includes("/private/"),
  );
  assert.equal(children.length, 0);
  assert.deepEqual(await readdir(root), []);
});
test("failed camera processes expose sanitized errors and release the session", async (t) => {
  const { gateway, root } = await fixture(t, {
    failure:
      "rtsp://operator:private-password@camera.local/live: 401 Unauthorized",
  });
  await assert.rejects(
    gateway.connect({
      type: "rtsp",
      url: "rtsp://operator:private-password@camera.local/live",
    }),
    (error) => {
      assert.equal(error.status, 502);
      assert.match(error.message, /authentication failed/);
      assert.ok(
        !error.message.includes("private-password") &&
          !error.message.includes("rtsp:"),
      );
      return true;
    },
  );
  assert.deepEqual(await readdir(root), []);
});
test("startup timeout terminates a stalled process and removes generated data", async (t) => {
  const { gateway, children, root } = await fixture(t, {
    hang: true,
    startupTimeoutMs: 25,
  });
  await assert.rejects(
    gateway.connect({ type: "url", url: "http://camera.local/video" }),
    (error) => error.status === 504,
  );
  assert.deepEqual(children[0].child.kills, ["SIGTERM"]);
  assert.deepEqual(await readdir(root), []);
});
test("shutdown cancels unresolved discovery without starting a late subprocess", async (t) => {
  let resolveDiscovery;
  const { gateway, children } = await fixture(t, {
    resolveOnvif: () =>
      new Promise((resolveUri) => {
        resolveDiscovery = resolveUri;
      }),
  });
  const connecting = gateway.connect({ type: "onvif", host: "camera.local" });
  await gateway.close();
  resolveDiscovery("rtsp://camera.local/live");
  await assert.rejects(connecting, (error) => error.status === 409);
  assert.equal(children.length, 0);
  await assert.rejects(
    gateway.connect({ type: "url", url: "http://camera.local/live" }),
    (error) => error.status === 503,
  );
});
test("only exact generated playlist and segment filenames can be served", async (t) => {
  const { gateway } = await fixture(t);
  const camera = await gateway.connect({
    type: "url",
    url: "https://camera.local/live.m3u8",
  });
  for (const file of [
    "secret.txt",
    "..%2fsecret",
    "segment-1.ts",
    "index.m3u8.tmp",
    "%2e%2e",
    "segment-000000001.ts:secret",
  ]) {
    const result = response();
    assert.equal(
      await gateway.handle({ method: "GET" }, result, {
        pathname: `/api/cameras/${camera.id}/${file}`,
      }),
      true,
    );
    assert.equal(result.status, 404);
  }
  const rejected = response();
  await gateway.handle(
    { method: "POST" },
    rejected,
    new URL(camera.playbackUrl, "http://local"),
  );
  assert.equal(rejected.status, 405);
  assert.equal(
    await gateway.handle({ method: "GET" }, response(), {
      pathname: "/api/not-a-camera",
    }),
    false,
  );
});
test("browser-abandoned sessions expire, release both camera slots, and await file cleanup at shutdown", async (t) => {
  let clock = 0;
  const { gateway, children, root } = await fixture(t, {
    idleTimeoutMs: 100,
    idleCheckIntervalMs: 5,
    now: () => clock,
  });
  const first = await gateway.connect({
    type: "rtsp",
    url: "rtsp://camera-one.local/live",
  });
  await gateway.connect({ type: "rtsp", url: "rtsp://camera-two.local/live" });
  await assert.rejects(
    gateway.connect({ type: "rtsp", url: "rtsp://camera-three.local/live" }),
    (error) => error.status === 409,
  );
  clock = 101;
  await waitFor(
    () => children.every(({ child }) => child.kills.length === 1),
    "Idle sessions did not stop their FFmpeg processes.",
  );
  const expired = response();
  await gateway.handle(
    { method: "GET" },
    expired,
    new URL(first.playbackUrl, "http://local"),
  );
  assert.equal(expired.status, 404);
  const replacement = await gateway.connect({
    type: "rtsp",
    url: "rtsp://replacement.local/live",
  });
  assert.equal(replacement.status, "live");
  await gateway.close();
  assert.deepEqual(await readdir(root), []);
  assert.ok(children.every(({ child }) => child.kills.length === 1));
});
test("successful playlist, segment, and status requests refresh idle lifetime; rejected requests do not", async (t) => {
  let clock = 0;
  const { gateway, children, root } = await fixture(t, {
    idleTimeoutMs: 100,
    idleCheckIntervalMs: 5,
    now: () => clock,
  });
  const camera = await gateway.connect({
    type: "url",
    url: "https://camera.local/live.m3u8",
  });
  for (const [time, file, method] of [
    [80, "index.m3u8", "GET"],
    [160, "segment-000000000.ts", "HEAD"],
    [240, "status", "GET"],
  ]) {
    clock = time;
    const result = response();
    await gateway.handle(
      { method },
      result,
      new URL(camera.playbackUrl.replace("index.m3u8", file), "http://local"),
    );
    assert.equal(result.status, 200);
    await new Promise((resolveWait) => setTimeout(resolveWait, 10));
    assert.equal(children[0].child.kills.length, 0);
  }
  clock = 320;
  for (const [method, file, expected] of [
    ["GET", "secret.txt", 404],
    ["POST", "status", 405],
    ["GET", "segment-999999999.ts", 404],
  ]) {
    const result = response();
    await gateway.handle(
      { method },
      result,
      new URL(camera.playbackUrl.replace("index.m3u8", file), "http://local"),
    );
    assert.equal(result.status, expected);
  }
  clock = 341;
  await waitFor(
    async () =>
      children[0].child.kills.length === 1 &&
      (await readdir(root)).length === 0,
    "Rejected requests kept an idle session alive.",
  );
});
test("ended and errored FFmpeg sessions are still reaped after their last viewer request", async (t) => {
  let clock = 0;
  const { gateway, children, root } = await fixture(t, {
    idleTimeoutMs: 100,
    idleCheckIntervalMs: 5,
    now: () => clock,
  });
  const ended = await gateway.connect({
    type: "rtsp",
    url: "rtsp://ended.local/live",
  });
  const failed = await gateway.connect({
    type: "rtsp",
    url: "rtsp://failed.local/live",
  });
  children[0].child.emit("close", 0);
  children[1].child.emit("error", new Error("Synthetic process error"));
  const result = response();
  await gateway.handle(
    { method: "GET" },
    result,
    new URL(ended.playbackUrl.replace("index.m3u8", "status"), "http://local"),
  );
  assert.equal(JSON.parse(result.body).status, "ended");
  clock = 101;
  await waitFor(
    async () => (await readdir(root)).length === 0,
    "Ended/errored sessions retained temporary files.",
  );
  for (const camera of [ended, failed]) {
    const missing = response();
    await gateway.handle(
      { method: "GET" },
      missing,
      new URL(
        camera.playbackUrl.replace("index.m3u8", "status"),
        "http://local",
      ),
    );
    assert.equal(missing.status, 404);
  }
});
const integration = process.env.CAMERA_INTEGRATION === "1";
test(
  "real FFmpeg converts a network HLS fixture into playable HLS",
  { skip: !integration, timeout: 40000 },
  async (t) => {
    const executable = (await import("ffmpeg-static")).default;
    const root = await mkdtemp(join(tmpdir(), "velocity-camera-tests-"));
    const fixtureDirectory = join(root, "fixture");
    await import("node:fs/promises").then((fs) => fs.mkdir(fixtureDirectory));
    const generated = spawn(
      executable,
      [
        "-hide_banner",
        "-loglevel",
        "error",
        "-y",
        "-f",
        "lavfi",
        "-i",
        "testsrc2=size=320x180:rate=15",
        "-t",
        "8",
        "-an",
        "-c:v",
        "libx264",
        "-preset",
        "ultrafast",
        "-g",
        "15",
        "-sc_threshold",
        "0",
        "-f",
        "hls",
        "-hls_time",
        "1",
        "-hls_list_size",
        "0",
        "-hls_segment_filename",
        join(fixtureDirectory, "source-%03d.ts"),
        join(fixtureDirectory, "source.m3u8"),
      ],
      { shell: false, windowsHide: true, stdio: "ignore" },
    );
    const generatedCode = await new Promise((resolveExit, reject) => {
      generated.once("error", reject);
      generated.once("close", resolveExit);
    });
    assert.equal(generatedCode, 0);
    await writeFile(
      join(fixtureDirectory, "local-file.m3u8"),
      `#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:1\n#EXTINF:1,\n${pathToFileURL(join(fixtureDirectory, "source-000.ts")).href}\n#EXT-X-ENDLIST\n`,
    );
    const sourceServer = createServer(async (request, result) => {
      const name = request.url.slice(1);
      if (!/^(?:source\.m3u8|local-file\.m3u8|source-\d{3}\.ts)$/.test(name)) {
        result.writeHead(404);
        result.end();
        return;
      }
      try {
        result.writeHead(200, {
          "Content-Type": name.endsWith(".ts")
            ? "video/mp2t"
            : "application/vnd.apple.mpegurl",
        });
        result.end(await readFile(join(fixtureDirectory, name)));
      } catch {
        result.writeHead(404);
        result.end();
      }
    });
    await new Promise((resolveListen) =>
      sourceServer.listen(0, "127.0.0.1", resolveListen),
    );
    const gateway = createCameraGateway({
      tmpRoot: root,
      startupTimeoutMs: 25000,
    });
    t.after(async () => {
      await gateway.close();
      await new Promise((resolveClose) => sourceServer.close(resolveClose));
      await removeTestDirectory(root);
    });
    const camera = await gateway.connect({
      type: "url",
      url: `http://127.0.0.1:${sourceServer.address().port}/source.m3u8`,
      name: "Synthetic HLS test",
    });
    assert.equal(camera.status, "live");
    const result = response();
    await gateway.handle(
      { method: "GET" },
      result,
      new URL(camera.playbackUrl, "http://local"),
    );
    assert.equal(result.status, 200);
    assert.match(result.body.toString(), /#EXT-X-PROGRAM-DATE-TIME/);
    const segment = result.body
      .toString()
      .split(/\r?\n/)
      .find((line) => /^segment-\d+\.ts$/.test(line));
    assert.ok(segment);
    const media = response();
    await gateway.handle(
      { method: "GET" },
      media,
      new URL(
        camera.playbackUrl.replace("index.m3u8", segment),
        "http://local",
      ),
    );
    assert.equal(media.status, 200);
    assert.ok(media.body.length > 1880);
    assert.equal(media.body[0], 0x47);
    await gateway.disconnect(camera.id);
    await assert.rejects(
      gateway.connect({
        type: "url",
        url: `http://127.0.0.1:${sourceServer.address().port}/local-file.m3u8`,
      }),
      (error) =>
        error.status === 502 && !error.message.includes(fixtureDirectory),
    );
  },
);
function annexBNals(bytes) {
  const found = [];
  let start = -1;
  for (let i = 0; i < bytes.length - 3; i++) {
    let prefix = 0;
    if (bytes[i] === 0 && bytes[i + 1] === 0 && bytes[i + 2] === 1) prefix = 3;
    else if (
      bytes[i] === 0 &&
      bytes[i + 1] === 0 &&
      bytes[i + 2] === 0 &&
      bytes[i + 3] === 1
    )
      prefix = 4;
    if (!prefix) continue;
    if (start >= 0 && i > start) found.push(bytes.subarray(start, i));
    start = i + prefix;
    i += prefix - 1;
  }
  if (start >= 0) found.push(bytes.subarray(start));
  return found;
}
async function rtspFixture(nals) {
  const sps = nals.find((nal) => (nal[0] & 31) === 7);
  const pps = nals.find((nal) => (nal[0] & 31) === 8);
  assert.ok(sps && pps);
  const frames = [];
  for (const nal of nals) {
    if ((nal[0] & 31) === 9 || !frames.length) frames.push([]);
    frames.at(-1).push(nal);
  }
  const sockets = new Set();
  const server = createTcpServer((socket) => {
    sockets.add(socket);
    let incoming = Buffer.alloc(0),
      timer,
      sequence = 0,
      timestamp = 0,
      frameIndex = 0,
      channel = 0;
    const sendRtp = (payload, marker) => {
      const packet = Buffer.alloc(12 + payload.length);
      packet[0] = 0x80;
      packet[1] = 96 | (marker ? 0x80 : 0);
      packet.writeUInt16BE(sequence++ & 0xffff, 2);
      packet.writeUInt32BE(timestamp >>> 0, 4);
      packet.writeUInt32BE(0x12345678, 8);
      payload.copy(packet, 12);
      const interleaved = Buffer.alloc(4);
      interleaved[0] = 0x24;
      interleaved[1] = channel;
      interleaved.writeUInt16BE(packet.length, 2);
      socket.write(Buffer.concat([interleaved, packet]));
    };
    const sendFrame = () => {
      const frame = frames[frameIndex++ % frames.length];
      frame.forEach((nal, index) => {
        if (nal.length <= 1200) {
          sendRtp(nal, index === frame.length - 1);
          return;
        }
        for (let offset = 1; offset < nal.length; offset += 1198) {
          const end = Math.min(nal.length, offset + 1198);
          const payload = Buffer.alloc(2 + end - offset);
          payload[0] = (nal[0] & 0xe0) | 28;
          payload[1] =
            (nal[0] & 31) |
            (offset === 1 ? 0x80 : 0) |
            (end === nal.length ? 0x40 : 0);
          nal.copy(payload, 2, offset, end);
          sendRtp(payload, end === nal.length && index === frame.length - 1);
        }
      });
      timestamp += 6000;
    };
    socket.on("data", (data) => {
      incoming = Buffer.concat([incoming, data]);
      while (incoming.length) {
        if (incoming[0] === 0x24) {
          if (
            incoming.length < 4 ||
            incoming.length < 4 + incoming.readUInt16BE(2)
          )
            return;
          incoming = incoming.subarray(4 + incoming.readUInt16BE(2));
          continue;
        }
        const end = incoming.indexOf("\r\n\r\n");
        if (end < 0) return;
        const request = incoming.subarray(0, end).toString();
        incoming = incoming.subarray(end + 4);
        const method = request.split(" ")[0];
        const cseq = /CSeq:\s*(\d+)/i.exec(request)?.[1] ?? "1";
        const base = `rtsp://127.0.0.1:${server.address().port}/live/`;
        let body = "",
          headers = "";
        if (method === "OPTIONS")
          headers =
            "Public: OPTIONS, DESCRIBE, SETUP, PLAY, GET_PARAMETER, TEARDOWN\r\n";
        if (method === "DESCRIBE") {
          body = `v=0\r\no=- 0 0 IN IP4 127.0.0.1\r\ns=Synthetic camera\r\nc=IN IP4 127.0.0.1\r\nt=0 0\r\na=control:*\r\nm=video 0 RTP/AVP 96\r\na=rtpmap:96 H264/90000\r\na=fmtp:96 packetization-mode=1;profile-level-id=${sps.subarray(1, 4).toString("hex")};sprop-parameter-sets=${sps.toString("base64")},${pps.toString("base64")}\r\na=control:trackID=0\r\na=framerate:15\r\n`;
          headers = `Content-Type: application/sdp\r\nContent-Base: ${base}\r\n`;
        }
        if (method === "SETUP") {
          channel = Number(/interleaved=(\d+)-/i.exec(request)?.[1] ?? 0);
          headers = `Transport: RTP/AVP/TCP;unicast;interleaved=${channel}-${channel + 1}\r\nSession: test-camera;timeout=60\r\n`;
        }
        if (method === "PLAY")
          headers = `Session: test-camera\r\nRange: npt=0.000-\r\nRTP-Info: url=${base}trackID=0;seq=${sequence};rtptime=${timestamp}\r\n`;
        socket.write(
          `RTSP/1.0 200 OK\r\nCSeq: ${cseq}\r\n${headers}Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`,
        );
        if (method === "PLAY" && !timer) {
          sendFrame();
          timer = setInterval(sendFrame, 1000 / 15);
        }
        if (method === "TEARDOWN") {
          clearInterval(timer);
          socket.end();
        }
      }
    });
    socket.on("error", () => {});
    socket.once("close", () => {
      clearInterval(timer);
      sockets.delete(socket);
    });
  });
  await new Promise((resolveListen) =>
    server.listen(0, "127.0.0.1", resolveListen),
  );
  return {
    url: `rtsp://127.0.0.1:${server.address().port}/live`,
    close: async () => {
      sockets.forEach((socket) => socket.destroy());
      await new Promise((resolveClose) => server.close(resolveClose));
    },
  };
}
test(
  "real FFmpeg reads a live RTSP/TCP camera and produces usable HLS",
  { skip: !integration, timeout: 40000 },
  async (t) => {
    const executable = (await import("ffmpeg-static")).default;
    const root = await mkdtemp(join(tmpdir(), "velocity-camera-tests-"));
    const fixturePath = join(root, "source.h264");
    const generated = spawn(
      executable,
      [
        "-hide_banner",
        "-loglevel",
        "error",
        "-y",
        "-f",
        "lavfi",
        "-i",
        "testsrc2=size=320x180:rate=15",
        "-t",
        "4",
        "-an",
        "-c:v",
        "libx264",
        "-preset",
        "ultrafast",
        "-tune",
        "zerolatency",
        "-x264-params",
        "repeat-headers=1:aud=1:keyint=15:min-keyint=15:scenecut=0",
        "-f",
        "h264",
        fixturePath,
      ],
      { shell: false, windowsHide: true, stdio: "ignore" },
    );
    const generatedCode = await new Promise((resolveExit, reject) => {
      generated.once("error", reject);
      generated.once("close", resolveExit);
    });
    assert.equal(generatedCode, 0);
    const source = await rtspFixture(annexBNals(await readFile(fixturePath)));
    let diagnostics = "";
    const gateway = createCameraGateway({
      tmpRoot: root,
      startupTimeoutMs: 25000,
      spawn: (...arguments_) => {
        const child = spawn(...arguments_);
        child.stderr.on("data", (data) => {
          diagnostics += data.toString();
        });
        return child;
      },
    });
    t.after(async () => {
      await gateway.close();
      await source.close();
      await removeTestDirectory(root);
    });
    const camera = await gateway
      .connect({ type: "rtsp", url: source.url, name: "Synthetic RTSP test" })
      .catch((error) =>
        assert.fail(
          `${error.message} (synthetic fixture diagnostics: ${diagnostics})`,
        ),
      );
    assert.equal(camera.status, "live");
    const result = response();
    await gateway.handle(
      { method: "GET" },
      result,
      new URL(camera.playbackUrl, "http://local"),
    );
    assert.equal(result.status, 200);
    assert.match(result.body.toString(), /#EXTINF/);
  },
);
