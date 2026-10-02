import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join, dirname, basename } from "node:path";
import { createServer } from "node:http";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import ffmpeg from "ffmpeg-static";
import { setTimeout as delay } from "node:timers/promises";
import {
  createFrameSource,
  frameSourceArguments,
  PpmFrameParser,
  FrameMetadataPairer,
} from "./frame-source.mjs";
const ppm = (rgb = [10, 20, 30], width = 1, height = 1) =>
  Buffer.concat([
    Buffer.from(`P6\n${width} ${height}\n255\n`),
    Buffer.from(rgb),
  ]);
const info = (index, time, width = 1, height = 1) =>
  `[Parsed_showinfo_3 @ 0x001] n: ${index} pts: ${Math.round(Number(time) * 90000)} pts_time:${time} fmt:rgb24 sar:1/1 s:${width}x${height} i:P iskey:1 type:I checksum:0\n`;
const timeBase = "[Parsed_showinfo_3 @ ptr] config in time_base: 1/90000\n";
const metadataPairer = (onFrame, maximumPending) => {
  const value = new FrameMetadataPairer(onFrame, maximumPending);
  value.pushLine(timeBase);
  return value;
};
const frame = (index, width = 1, height = 1) => ({
  index,
  width,
  height,
  rgb: Buffer.alloc(width * height * 3, index),
});
test("PPM parser preserves arbitrary pixel bytes across every chunk boundary", () => {
  const source = Buffer.concat([
    ppm([10, 13, 32, 80, 54, 255], 2, 1),
    ppm([0, 255, 10]),
  ]);
  for (let boundary = 0; boundary <= source.length; boundary++) {
    const frames = [];
    const parser = new PpmFrameParser((value) => frames.push(value));
    parser.push(source.subarray(0, boundary));
    parser.push(source.subarray(boundary));
    parser.finish();
    assert.equal(frames.length, 2);
    assert.deepEqual(frames[0].rgb, Buffer.from([10, 13, 32, 80, 54, 255]));
    assert.equal(frames[0].width, 2);
    assert.equal(frames[1].index, 1);
  }
  const frames = [];
  const parser = new PpmFrameParser((value) => frames.push(value));
  for (const byte of source) parser.push(Buffer.from([byte]));
  assert.equal(frames.length, 2);
});
test("PPM parser rejects oversized, malformed, and incomplete frames with bounded headers", () => {
  for (const header of [
    "P6\n1281 1\n255\n",
    "P6\n1 721\n255\n",
    "P6\n0 1\n255\n",
    "P3\n1 1\n255\n",
    "P6\n1 1\n65535\n",
    "P6\n1.5 1\n255\n",
    "A".repeat(129),
  ]) {
    assert.throws(
      () => new PpmFrameParser(() => {}).push(Buffer.from(header)),
      /invalid/,
    );
  }
  const parser = new PpmFrameParser(() => {});
  parser.push(ppm().subarray(0, -1));
  assert.throws(() => parser.finish(), /invalid/);
});
test("PPM parser pauses at a complete frame without consuming the next frame's bytes", () => {
  const received = [];
  const parser = new PpmFrameParser((value) => {
    received.push(value);
    return false;
  });
  const first = ppm([1, 2, 3]),
    second = ppm([4, 5, 6]);
  const bytes = Buffer.concat([first, second]);
  const consumed = parser.push(bytes);
  assert.equal(consumed, first.length);
  assert.equal(received.length, 1);
  assert.equal(parser.push(bytes.subarray(consumed)), second.length);
  parser.finish();
  assert.deepEqual(
    received.map((value) => [...value.rgb]),
    [
      [1, 2, 3],
      [4, 5, 6],
    ],
  );
});
test("metadata pairs exact indices regardless of pipe order and retains media PTS", () => {
  const output = [];
  const pairer = metadataPairer((value) => output.push(value));
  pairer.pushLine(info(0, 123.4));
  pairer.pushLine("[Parsed_showinfo_3 @ ptr] config out time_base: 0/0\n");
  pairer.pushFrame(frame(0));
  pairer.pushFrame(frame(1));
  assert.equal(output.length, 1);
  pairer.pushLine(info(1, 123.5));
  pairer.finish();
  assert.deepEqual(
    output.map((item) => [item.index, item.mediaSeconds, item.rgb[0]]),
    [
      [0, 123.4, 0],
      [1, 123.5, 1],
    ],
  );
  assert.ok(output[0].receivedAt <= Date.now());
  assert.ok(Number.isFinite(output[0].receivedMonotonic));
});
test("pairing rejects missing, out-of-order, invalid, or differently sized metadata", () => {
  for (const metadata of [
    info(1, 0),
    info(0, "N/A"),
    info(0, "Infinity"),
    info(0, 0, 1281),
    "[Parsed_showinfo_3 @ ptr] n: 0 missing_pts\n",
  ]) {
    assert.throws(() => metadataPairer(() => {}).pushLine(metadata), /invalid/);
  }
  const mismatch = metadataPairer(() => {});
  mismatch.pushFrame(frame(0));
  assert.throws(() => mismatch.pushLine(info(0, 0, 2)), /invalid/);
  const missing = metadataPairer(() => {});
  missing.pushFrame(frame(0));
  assert.throws(() => missing.finish(), /invalid/);
  const outOfOrder = metadataPairer(() => {});
  assert.throws(() => outOfOrder.pushFrame(frame(1)), /invalid/);
});
test("integer PTS preserves sub-frame precision even when printed pts_time is rounded", () => {
  const output = [];
  const pairer = metadataPairer((value) => output.push(value));
  pairer.pushLine(
    info(0, 60000.123).replace("pts_time:60000.123", "pts_time:60000.1"),
  );
  pairer.pushFrame(frame(0));
  assert.equal(output[0].mediaSeconds, 60000.123);
  assert.throws(
    () => new FrameMetadataPairer(() => {}).pushLine(info(0, 0)),
    /invalid/,
  );
  assert.throws(
    () => pairer.pushLine("[Parsed_showinfo_3 @ ptr] config in time_base: 1/0"),
    /invalid/,
  );
});
test("unmatched metadata and frame queues are bounded", () => {
  const frames = metadataPairer(() => {}, 2);
  frames.pushFrame(frame(0));
  frames.pushFrame(frame(1));
  assert.throws(() => frames.pushFrame(frame(2)), /invalid/);
  const metadata = metadataPairer(() => {}, 2);
  metadata.pushLine(info(0, 0));
  metadata.pushLine(info(1, 0.1));
  assert.throws(() => metadata.pushLine(info(2, 0.2)), /invalid/);
});
test("network input validation and decoder arguments restrict protocols and preserve source timing", () => {
  for (const input of [
    "file:///secret",
    "ftp://host/video",
    "pipe:0",
    "https://host/a#fragment",
    "https://host/a\npassword",
    "https://host/%0apassword",
    "https://host/a b",
    "not-url",
  ]) {
    assert.throws(() => frameSourceArguments(input));
  }
  const args = frameSourceArguments("rtsp://user:secret@localhost/live");
  assert.ok(args.includes("-copyts"));
  assert.equal(args[args.indexOf("-rtsp_transport") + 1], "tcp");
  assert.ok(!args.includes("-tls_verify"));
  const secureArgs = frameSourceArguments("https://localhost/live");
  assert.equal(secureArgs[secureArgs.indexOf("-tls_verify") + 1], "1");
  assert.equal(
    args[args.indexOf("-protocol_whitelist") + 1],
    "http,https,tcp,tls,udp,rtp,crypto",
  );
  assert.match(
    args[args.indexOf("-vf") + 1],
    /select=.*prev_selected_t.*min\(1280,iw\).*min\(720,ih\).*format=rgb24,showinfo/,
  );
  assert.ok(!args.join(" ").includes("setpts"));
  assert.ok(!args[args.indexOf("-vf") + 1].includes("fps="));
  assert.equal(args[args.indexOf("-thread_queue_size") + 1], "512");
  assert.throws(() =>
    frameSourceArguments("relative.mp4", { localFile: true }),
  );
});
test("only HTTP(S) uses output pacing after selection without delaying input reads", () => {
  for (const protocol of ["http", "https"]) {
    const args = frameSourceArguments(`${protocol}://localhost/live`);
    const filter = args[args.indexOf("-vf") + 1];
    assert.equal(args.includes("-re"), false);
    assert.equal(args.includes("-readrate"), false);
    assert.match(filter, /^select=.*',realtime=limit=2:speed=1,scale=/);
    assert.equal(filter.match(/realtime=/g)?.length, 1);
    assert.equal(args[args.indexOf("-thread_queue_size") + 1], "512");
    assert.equal(args[args.indexOf("-fps_mode") + 1], "passthrough");
    assert.ok(args.includes("-copyts"));
    assert.ok(!filter.includes("setpts"));
    assert.ok(!filter.includes("fps="));
  }
  for (const [input, options] of [
    ["rtsp://localhost/live", {}],
    ["rtsps://localhost/live", {}],
    [resolve("fixture.mp4"), { localFile: true }],
  ]) {
    const args = frameSourceArguments(input, options);
    assert.ok(!args.includes("-re"));
    assert.ok(!args[args.indexOf("-vf") + 1].includes("realtime="));
  }
});
async function fakeSource(options = {}) {
  const child = new EventEmitter();
  child.pid = 123;
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.signals = [];
  child.kill = (signal) => {
    child.signals.push(signal);
    if (!options.manualClose) queueMicrotask(() => child.emit("close", null));
    return true;
  };
  let spawnOptions;
  const source = await createFrameSource(
    options.localFile
      ? resolve("fixture.mp4")
      : "http://user:secret@localhost/video",
    {
      ffmpegPath: "fixture-ffmpeg",
      startupTimeoutMs: 2000,
      frameTimeoutMs: 2000,
      ...options,
      spawn(_executable, _args, value) {
        spawnOptions = value;
        return child;
      },
    },
  );
  child.stderr.write(timeBase);
  return {
    ...source,
    child,
    spawnOptions,
    send(index, time = index / 10) {
      child.stderr.write(info(index, time));
      child.stdout.write(ppm([index, 20, 30]));
    },
  };
}
test("slow consumers receive only the newest complete pending frame without pixel/PTS mixing", async () => {
  let release;
  const blocked = new Promise((resolve) => {
    release = resolve;
  });
  const received = [];
  const source = await fakeSource({
    onFrame: async (value) => {
      received.push(value);
      if (value.index === 0) await blocked;
    },
  });
  assert.deepEqual(source.spawnOptions, {
    windowsHide: true,
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
  });
  source.send(0, 42);
  source.send(1, 42.1);
  source.send(2, 42.2);
  source.send(3, 42.3);
  assert.equal(received.length, 1);
  release();
  await delay(0);
  assert.deepEqual(
    received.map((value) => [value.index, value.mediaSeconds, value.rgb[0]]),
    [
      [0, 42, 0],
      [3, 42.3, 3],
    ],
  );
  await source.stop();
});
test("either pipe can lead by many frames at EOF without overflowing the pairing limit", async () => {
  for (const leadingPipe of ["metadata", "pixels"]) {
    const received = [];
    const source = await fakeSource({
      localFile: true,
      maximumPending: 2,
      onFrame: async (value) => {
        received.push(value);
        await delay(1);
      },
    });
    const metadata = Array.from({ length: 32 }, (_, index) =>
      info(index, 60000 + index / 10),
    ).join("");
    const pixels = Buffer.concat(
      Array.from({ length: 32 }, (_, index) => ppm([index, 20, 30])),
    );
    if (leadingPipe === "metadata") {
      source.child.stderr.write(metadata);
      assert.equal(source.child.stderr.isPaused(), true);
      source.child.stdout.write(pixels);
    } else {
      source.child.stdout.write(pixels);
      assert.equal(source.child.stdout.isPaused(), true);
      source.child.stderr.write(metadata);
    }
    await Promise.all(
      [source.child.stdout, source.child.stderr].map(
        (stream) =>
          new Promise((resolve) => {
            stream.once("end", resolve);
            stream.end();
          }),
      ),
    );
    source.child.emit("close", 0);
    await source.completion;
    assert.deepEqual(source.child.signals, []);
    assert.equal(received.at(-1).index, 31);
    for (const value of received) {
      assert.equal(value.rgb[0], value.index);
      assert.equal(value.mediaSeconds, 60000 + value.index / 10);
    }
  }
});
test("metadata deferred by pipe backpressure still rejects invalid frame order", async () => {
  const source = await fakeSource({ maximumPending: 1, onFrame: () => {} });
  source.child.stderr.write(info(0, 0) + info(2, 0.2));
  assert.equal(source.child.stderr.isPaused(), true);
  source.child.stdout.write(ppm());
  await assert.rejects(source.completion, /invalid frame metadata/);
  await source.stop();
});
test("stop releases a pipe paused for unmatched metadata or pixels and awaits cleanup", async () => {
  for (const leadingPipe of ["metadata", "pixels"]) {
    const source = await fakeSource({ maximumPending: 1, onFrame: () => {} });
    const stream =
      leadingPipe === "metadata" ? source.child.stderr : source.child.stdout;
    stream.write(
      leadingPipe === "metadata"
        ? info(0, 0) + info(1, 0.1)
        : Buffer.concat([ppm(), ppm()]),
    );
    assert.equal(stream.isPaused(), true);
    await source.stop();
    assert.equal(stream.isPaused(), false);
    assert.deepEqual(source.child.signals, ["SIGTERM"]);
  }
});
test("stop waits for both child close and the active consumer, and cancels pending frames", async () => {
  let release;
  const blocked = new Promise((resolve) => {
    release = resolve;
  });
  const received = [];
  const source = await fakeSource({
    manualClose: true,
    onFrame: async (value) => {
      received.push(value);
      await blocked;
    },
  });
  source.send(0);
  source.send(1);
  let stopped = false;
  const stopping = source.stop().then(() => {
    stopped = true;
  });
  await delay(0);
  assert.equal(stopped, false);
  source.child.emit("close", 0);
  await delay(0);
  assert.equal(stopped, false);
  release();
  await stopping;
  assert.equal(received.length, 1);
  assert.deepEqual(source.child.signals, ["SIGTERM"]);
});
test("startup and frame-stall watchdogs stop the process and report sanitized failures", async () => {
  for (const receivedFrame of [false, true]) {
    const errors = [];
    const source = await fakeSource({
      startupTimeoutMs: 25,
      frameTimeoutMs: 25,
      onFrame: () => {},
      onError: (value) => errors.push(value.message),
    });
    if (receivedFrame) source.send(0);
    await delay(50);
    await assert.rejects(
      source.completion,
      receivedFrame ? /No camera frames/ : /startup timed out/,
    );
    assert.equal(errors.length, 1);
    assert.ok(!errors[0].includes("secret"));
    assert.equal(source.child.signals[0], "SIGTERM");
    await source.stop();
  }
});
test("decoder errors, truncated frames, and overlong logs never expose connection credentials", async () => {
  for (const failure of ["exit", "partial", "log", "consumer"]) {
    const errors = [];
    const source = await fakeSource({
      onFrame: () => {
        if (failure === "consumer")
          throw new Error("http://user:secret@localhost");
      },
      onError: (value) => errors.push(value.message),
    });
    if (failure === "exit") {
      source.child.stderr.write("Failed http://user:secret@localhost\n");
      source.child.emit("close", 1);
    }
    if (failure === "partial") {
      source.child.stdout.write(ppm().subarray(0, -1));
      source.child.emit("close", 0);
    }
    if (failure === "log") source.child.stderr.write("secret".repeat(1400));
    if (failure === "consumer") source.send(0);
    await assert.rejects(source.completion);
    assert.equal(errors.length, 1);
    assert.ok(!errors[0].includes("secret"));
    await source.stop();
  }
});
test("real FFmpeg decodes a localhost PPM fixture with source PTS, RGB pixels, and no upscaling", async (t) => {
  const fixture = Buffer.concat(
    Array(5).fill(ppm([240, 10, 20, 30, 220, 40], 2, 1)),
  );
  const server = createServer((_request, response) => {
    response.writeHead(200, {
      "Content-Type": "image/x-portable-pixmap",
      "Content-Length": fixture.length,
    });
    response.end(fixture);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const received = [];
  const directory = await mkdtemp(join(tmpdir(), "velocity-frame-tests-"));
  t.after(async () => {
    const target = resolve(directory);
    assert.equal(dirname(target), resolve(tmpdir()));
    assert.ok(basename(target).startsWith("velocity-frame-tests-"));
    await rm(target, { recursive: true, force: true });
  });
  const file = join(directory, "fixture.ppm");
  await writeFile(file, fixture);
  const local = await createFrameSource(file, {
    localFile: true,
    onFrame: (value) => received.push(value),
  });
  await local.completion;
  assert.ok(received.length > 0);
  assert.equal(received[0].width, 2);
  assert.equal(received[0].height, 1);
  assert.deepEqual(received[0].rgb, Buffer.from([240, 10, 20, 30, 220, 40]));
  assert.equal(received[0].mediaSeconds, 0);
  const networkFrames = [];
  const remote = await createFrameSource(
    `http://127.0.0.1:${server.address().port}/fixture.ppm`,
    { onFrame: (value) => networkFrames.push(value), startupTimeoutMs: 2000 },
  );
  t.after(() => remote.stop());
  await assert.rejects(remote.completion, /stream stopped/);
  assert.ok(networkFrames.length > 0);
  assert.deepEqual(networkFrames[0].rgb, received[0].rgb);
});
test("real FFmpeg retains sparse irregular source PTS without synthesizing ten-fps frames", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "velocity-frame-tests-"));
  t.after(async () => {
    const target = resolve(directory);
    assert.equal(dirname(target), resolve(tmpdir()));
    assert.ok(basename(target).startsWith("velocity-frame-tests-"));
    await rm(target, { recursive: true, force: true });
  });
  const file = join(directory, "irregular.mkv");
  await promisify(execFile)(
    ffmpeg,
    [
      "-hide_banner",
      "-loglevel",
      "error",
      "-nostdin",
      "-f",
      "lavfi",
      "-i",
      "color=c=red:s=16x16:r=10",
      "-frames:v",
      "4",
      "-vf",
      "settb=1/1000,setpts='60000123+if(eq(N,0),0,if(eq(N,1),234,if(eq(N,2),776,1400)))'",
      "-enc_time_base",
      "1:1000",
      "-fps_mode",
      "passthrough",
      "-c:v",
      "ffv1",
      file,
    ],
    { windowsHide: true },
  );
  const emitted = [];
  const pairer = new FrameMetadataPairer((value) => emitted.push(value));
  const parser = new PpmFrameParser((value) => pairer.pushFrame(value));
  let partial = "";
  const source = await createFrameSource(file, {
    localFile: true,
    onFrame: () => {},
    spawn(executable, args, options) {
      const child = spawn(executable, args, options);
      child.stdout.on("data", (chunk) => parser.push(chunk));
      child.stderr.on("data", (chunk) => {
        partial += chunk.toString("utf8");
        const lines = partial.split("\n");
        partial = lines.pop();
        for (const line of lines) pairer.pushLine(line);
      });
      return child;
    },
  });
  t.after(() => source.stop());
  await source.completion;
  parser.finish();
  pairer.finish();
  assert.deepEqual(
    emitted.map((value) => value.mediaSeconds),
    [60000.123, 60000.357, 60000.899, 60001.523],
  );
  assert.deepEqual(
    emitted.map((value) => value.index),
    [0, 1, 2, 3],
  );
});
test("the sampling filter admits a source-clock rollback instead of withholding frames until catch-up", async () => {
  const args = frameSourceArguments("http://localhost/fixture");
  const filter = args[args.indexOf("-vf") + 1];
  const { stdout, stderr } = await promisify(execFile)(
    ffmpeg,
    [
      "-hide_banner",
      "-loglevel",
      "info",
      "-nostdin",
      "-f",
      "lavfi",
      "-i",
      "color=c=red:s=16x16:r=10:d=0.6",
      "-vf",
      `settb=1/1000,setpts='if(lt(N,3),N*100,N*100-300)',${filter}`,
      "-fps_mode",
      "passthrough",
      "-c:v",
      "ppm",
      "-f",
      "image2pipe",
      "pipe:1",
    ],
    { windowsHide: true, encoding: "buffer" },
  );
  const output = [];
  const pairer = new FrameMetadataPairer((value) => output.push(value));
  for (const line of stderr.toString().split("\n")) pairer.pushLine(line);
  const parser = new PpmFrameParser((value) => pairer.pushFrame(value));
  parser.push(stdout);
  parser.finish();
  pairer.finish();
  assert.deepEqual(
    output.map((value) => value.mediaSeconds),
    [0, 0.1, 0.2, 0, 0.1, 0.2],
  );
});
test("fifteen-fps input supplies ten distinct observations per second with original varying PTS", async () => {
  const args = frameSourceArguments("http://localhost/fixture");
  const filter = args[args.indexOf("-vf") + 1];
  const { stdout, stderr } = await promisify(execFile)(
    ffmpeg,
    [
      "-hide_banner",
      "-loglevel",
      "info",
      "-nostdin",
      "-f",
      "lavfi",
      "-i",
      "color=c=red:s=16x16:r=15:d=1",
      "-vf",
      filter,
      "-fps_mode",
      "passthrough",
      "-c:v",
      "ppm",
      "-f",
      "image2pipe",
      "pipe:1",
    ],
    { windowsHide: true, encoding: "buffer" },
  );
  const output = [];
  const pairer = new FrameMetadataPairer((value) => output.push(value), 16);
  for (const line of stderr.toString().split("\n")) pairer.pushLine(line);
  const parser = new PpmFrameParser((value) => pairer.pushFrame(value));
  parser.push(stdout);
  parser.finish();
  pairer.finish();
  assert.deepEqual(
    output.map((value) => value.mediaSeconds),
    [0, 2, 3, 5, 6, 8, 9, 11, 12, 14].map((index) => index / 15),
  );
});
test("native output pacing preserves large source PTS and bounds forward-gap and rollback waits", async () => {
  const args = frameSourceArguments("https://localhost/fixture");
  const filter = args[args.indexOf("-vf") + 1];
  const { stdout, stderr } = await promisify(execFile)(
    ffmpeg,
    [
      "-hide_banner",
      "-loglevel",
      "info",
      "-nostdin",
      "-copyts",
      "-f",
      "lavfi",
      "-i",
      "color=c=red:s=16x16:r=10:d=0.6",
      "-vf",
      `settb=1/1000,setpts='60000123+if(lt(N,2),N*300,if(lt(N,4),600000+(N-2)*300,50+(N-4)*300))',${filter}`,
      "-fps_mode",
      "passthrough",
      "-threads",
      "1",
      "-c:v",
      "ppm",
      "-f",
      "image2pipe",
      "pipe:1",
    ],
    { windowsHide: true, encoding: "buffer", timeout: 6000 },
  );
  const output = [];
  const pairer = new FrameMetadataPairer((value) => output.push(value));
  for (const line of stderr.toString().split("\n")) pairer.pushLine(line);
  const parser = new PpmFrameParser((value) => pairer.pushFrame(value));
  parser.push(stdout);
  parser.finish();
  pairer.finish();
  assert.deepEqual(
    output.map((value) => value.mediaSeconds),
    [60000.123, 60000.423, 60600.123, 60600.423, 60000.173, 60000.473],
  );
  assert.deepEqual(
    output.map((value) => value.index),
    [0, 1, 2, 3, 4, 5],
  );
  assert.ok(output.every((value) => value.rgb.length === 16 * 16 * 3));
});
test(
  "stop interrupts native output pacing and confirms decoder close before returning",
  { timeout: 10000 },
  async (t) => {
    const received = [];
    let firstFrameResolve;
    const firstFrame = new Promise((resolve) => {
      firstFrameResolve = resolve;
    });
    let childClosed = false;
    let child;
    const source = await createFrameSource(
      "http://localhost/injected-fixture",
      {
        startupTimeoutMs: 5000,
        frameTimeoutMs: 5000,
        onFrame(value) {
          received.push(value);
          firstFrameResolve();
        },
        spawn(executable, args, options) {
          const outputArgs = args.slice(args.indexOf("-map"));
          const filterIndex = outputArgs.indexOf("-vf") + 1;
          outputArgs[filterIndex] =
            `settb=1/1000,setpts='N*1800',${outputArgs[filterIndex]}`;
          child = spawn(
            executable,
            [
              "-hide_banner",
              "-loglevel",
              "info",
              "-nostdin",
              "-f",
              "lavfi",
              "-i",
              "color=c=blue:s=64x64:r=10:d=1",
              ...outputArgs,
            ],
            options,
          );
          child.once("close", () => {
            childClosed = true;
          });
          return child;
        },
      },
    );
    t.after(() => source.stop());
    await Promise.race([
      firstFrame,
      source.completion.then(() => {
        throw new Error("The synthetic source ended before its first frame.");
      }),
    ]);
    await delay(75);
    assert.equal(received.length, 1);
    assert.equal(received[0].mediaSeconds, 0);
    await source.stop();
    assert.equal(childClosed, true);
    assert.ok(child.exitCode !== null || child.signalCode !== null);
    assert.equal(received.length, 1);
    await source.stop();
  },
);
