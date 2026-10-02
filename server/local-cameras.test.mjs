import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import {
  createLocalCameras,
  parseLocalCameraListing,
  readLocalCameraSource,
} from "./local-cameras.mjs";
import { frameSourceArguments, createFrameSource } from "./frame-source.mjs";
const alternative = String.raw`@device_pnp_\\?\usb#vid_0000&pid_0000#test\global`;
const log = (line) => `[dshow @ 000001234] ${line}\r\n`;
const device = (name = "Road camera", path = alternative, type = "video") =>
  log(`"${name}" (${type})`) + log(`  Alternative name "${path}"`);
const terminal =
  "[in#0 @ 1234] Error opening input: Immediate exit requested\r\nError opening input file dummy.\r\n";
const listing = (content = device()) => content + terminal;
const idPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
class FakeProcess extends EventEmitter {
  constructor() {
    super();
    this.pid = 1234567;
    this.stderr = new PassThrough();
    this.stdout = new PassThrough();
    this.kills = [];
    this.closed = false;
    this.onKill = () => queueMicrotask(() => this.close(null, "SIGTERM"));
  }
  kill(signal) {
    this.kills.push(signal);
    this.onKill(signal);
    return true;
  }
  close(code = 0, signal = null) {
    if (this.closed) return;
    this.closed = true;
    this.stderr.end();
    this.stdout.end();
    this.emit("close", code, signal);
  }
}
function harness(outputs = [listing()], extra = {}) {
  const calls = [],
    children = [];
  const registry = createLocalCameras({
    platform: "win32",
    ffmpegPath: "fake-ffmpeg",
    timeoutMs: 1000,
    killTimeoutMs: 15,
    spawn: (executable, args, options) => {
      const child = new FakeProcess();
      calls.push({ executable, args, options });
      children.push(child);
      const content =
        outputs[Math.min(children.length - 1, outputs.length - 1)];
      if (content !== null)
        setImmediate(() => {
          if (typeof content === "function") content(child);
          else {
            child.stderr.write(content);
            child.close();
          }
        });
      return child;
    },
    ...extra,
  });
  return { registry, calls, children };
}
test("discovery lists only paired video devices and hides native paths", async () => {
  const h = harness([
    listing(
      device("Same name") +
        device("Same name", "@device_sw_other") +
        device("Microphone secret", "@device_cm_audio", "audio"),
    ),
  ]);
  const result = await h.registry.list();
  assert.equal(result.supported, true);
  assert.equal(result.reason, null);
  assert.deepEqual(
    result.devices.map((value) => value.name),
    ["Same name", "Same name"],
  );
  assert.notEqual(result.devices[0].id, result.devices[1].id);
  result.devices.forEach((value) => assert.match(value.id, idPattern));
  assert.doesNotMatch(JSON.stringify(result), /@device|Microphone|alternative/);
  const call = h.calls[0];
  assert.deepEqual(call.args, [
    "-hide_banner",
    "-nostdin",
    "-loglevel",
    "info",
    "-list_devices",
    "true",
    "-f",
    "dshow",
    "-i",
    "dummy",
  ]);
  assert.deepEqual(call.options, {
    windowsHide: true,
    shell: false,
    stdio: ["ignore", "ignore", "pipe"],
  });
  assert.equal(h.children[0].closed, true);
  await h.registry.close();
});
test("parser preserves exact alternative names and accepts video pins on mixed devices", () => {
  assert.deepEqual(
    parseLocalCameraListing(
      listing(device(" Road 🎥 ", alternative, "audio, video")),
    ),
    [{ name: "Road 🎥", alternativeName: alternative }],
  );
  assert.deepEqual(
    parseLocalCameraListing(
      listing(device("Microphone", "@device_cm_audio", "audio")),
    ),
    [],
  );
  assert.deepEqual(
    parseLocalCameraListing(
      log("Could not enumerate video devices (or none found).") + terminal,
    ),
    [],
  );
});
test("parser rejects unpaired, malformed, ambiguous and unsafe device records", () => {
  const invalid = [
    log('"Road camera" (video)'),
    log(`Alternative name "${alternative}"`),
    device("Road", "@device_sw_test:audio=Microphone"),
    device("Road", "@device_sw_test\u0000"),
    device("Road", "file:///secret"),
    device("Road", "@device_" + "x".repeat(4097)),
    device("Road", '@device_sw_"quoted"'),
    device("Road") + device("Another", alternative),
    log('"Road" (video)') +
      log('"Microphone" (audio)') +
      log('Alternative name "@device_audio"'),
    "x".repeat(256 * 1024 + 1),
    Array.from({ length: 65 }, (_, index) =>
      device("Road", `@device_sw_${index}`),
    ).join(""),
    "Unexpected internal error secret-password",
  ];
  for (const value of invalid)
    assert.throws(
      () => parseLocalCameraListing(value),
      (error) => error.status === 503 && !error.message.includes("secret"),
    );
});
test("public device names are bounded and cannot expose URL credentials", () => {
  for (const name of [
    "https://user:pw@host",
    "data:private",
    "blob:private",
    "user:secret@host",
    alternative,
    "bad\u0000name",
    "  ",
  ])
    assert.equal(parseLocalCameraListing(device(name))[0].name, "USB camera");
  assert.equal(
    parseLocalCameraListing(device("🎥".repeat(120)))[0].name.length,
    80,
  );
});
test("opaque IDs persist across refresh, vanish on removal and cannot be guessed or replayed", async () => {
  const h = harness([
    listing(),
    listing(),
    listing(log("Could not enumerate video devices (or none found).")),
    listing(),
  ]);
  const first = await h.registry.list();
  const id = first.devices[0].id;
  assert.equal((await h.registry.list()).devices[0].id, id);
  assert.deepEqual((await h.registry.list()).devices, []);
  await assert.rejects(h.registry.resolve(id), { status: 400 });
  assert.equal(h.calls.length, 3);
  assert.notEqual((await h.registry.list()).devices[0].id, id);
  for (const value of [
    alternative,
    { id },
    "123",
    "11111111-1111-4111-8111-111111111111",
  ])
    await assert.rejects(h.registry.resolve(value), { status: 400 });
  assert.equal(h.calls.length, 4);
  await h.registry.close();
});
test("resolving refreshes presence, rejects unplugged devices and does not open a camera", async () => {
  const h = harness([
    listing(),
    listing(log("Could not enumerate video devices (or none found).")),
  ]);
  const id = (await h.registry.list()).devices[0].id;
  await assert.rejects(h.registry.resolve(id), { status: 409 });
  assert.equal(h.calls.length, 2);
  assert.ok(h.calls.every((call) => call.args.includes("-list_devices")));
  await h.registry.close();
});
test("device IDs are registry scoped and capabilities cannot be forged, serialized or used after close", async () => {
  const h = harness();
  const id = (await h.registry.list()).devices[0].id;
  const result = await h.registry.resolve(id);
  assert.deepEqual(
    { name: result.name, type: result.type },
    { name: "Road camera", type: "usb" },
  );
  assert.equal(JSON.stringify(result.source), "{}");
  assert.ok(Object.isFrozen(result.source));
  assert.deepEqual(readLocalCameraSource(result.source), {
    protocol: "dshow:",
    value: `video=${alternative}`,
  });
  for (const bad of [
    null,
    alternative,
    {},
    { protocol: "dshow:", value: `video=${alternative}` },
    JSON.parse(JSON.stringify(result.source)),
  ])
    assert.equal(readLocalCameraSource(bad), null);
  const other = harness();
  await assert.rejects(other.registry.resolve(id), { status: 400 });
  await other.registry.close();
  await h.registry.close();
  assert.throws(
    () => readLocalCameraSource(result.source),
    /no longer available/,
  );
});
test("successful refresh revokes already issued capabilities for removed devices", async () => {
  const h = harness([
    listing(),
    listing(),
    listing(log("Could not enumerate video devices (or none found).")),
  ]);
  const id = (await h.registry.list()).devices[0].id;
  const { source } = await h.registry.resolve(id);
  await h.registry.list();
  assert.throws(() => frameSourceArguments(source), /no longer available/);
  await h.registry.close();
});
test("unsupported operating systems report capability without launching FFmpeg", async () => {
  const h = harness([], { platform: "linux" });
  assert.deepEqual((await h.registry.list()).devices, []);
  assert.equal((await h.registry.list()).supported, false);
  await assert.rejects(
    h.registry.resolve("11111111-1111-4111-8111-111111111111"),
    { status: 400 },
  );
  assert.equal(h.calls.length, 0);
  await h.registry.close();
});
test("listing assembles split UTF-8 and accepts older FFmpeg immediate-exit code", async () => {
  const content = Buffer.from(listing(device("Caméra 🎥")));
  const h = harness([
    (child) => {
      for (const byte of content) child.stderr.write(Buffer.from([byte]));
      child.close(1);
    },
  ]);
  assert.equal((await h.registry.list()).devices[0].name, "Caméra 🎥");
  await h.registry.close();
});
test("discovery errors never return raw diagnostics or partial inventories", async () => {
  for (const content of [
    (child) => {
      child.stderr.write(listing());
      child.close(23);
    },
    (child) => {
      child.stderr.write(device() + "secret path failed");
      child.close();
    },
    (child) => {
      child.stderr.write(Buffer.from([0xff, 0xfe]));
      child.stderr.write(listing());
      child.close();
    },
    (child) => {
      child.stderr.write(listing());
      child.close(null, "SIGKILL");
    },
    (child) => {
      child.pid = undefined;
      child.emit("error", new Error("secret-native-path"));
    },
  ]) {
    const h = harness([content]);
    await assert.rejects(
      h.registry.list(),
      (error) => error.status === 503 && !error.message.includes("secret"),
    );
    await h.registry.close();
  }
  const h = harness([], {
    spawn() {
      throw new Error("secret-native-path");
    },
  });
  await assert.rejects(
    h.registry.list(),
    (error) => error.status === 503 && !error.message.includes("secret"),
  );
  await h.registry.close();
});
test("overflow terminates enumeration and rejects before a partial list can escape", async () => {
  const h = harness([
    (child) => child.stderr.write(Buffer.alloc(256 * 1024 + 1, 65)),
  ]);
  await assert.rejects(h.registry.list(), { status: 503 });
  assert.equal(h.children[0].closed, true);
  assert.deepEqual(h.children[0].kills, ["SIGTERM"]);
  await h.registry.close();
});
test("stream and running-process errors stop discovery without disclosing native errors", async () => {
  for (const event of ["stream", "process"]) {
    const h = harness([
      (child) => {
        if (event === "stream")
          child.stderr.emit("error", new Error("private-driver-path"));
        else child.emit("error", new Error("private-driver-path"));
      },
    ]);
    await assert.rejects(
      h.registry.list(),
      (error) => error.status === 503 && !error.message.includes("private"),
    );
    assert.equal(h.children[0].closed, true);
    assert.deepEqual(h.children[0].kills, ["SIGTERM"]);
    await h.registry.close();
  }
});
test("timeout waits for process close and escalates to SIGKILL when needed", async () => {
  const h = harness(
    [
      (child) => {
        child.onKill = (signal) => {
          if (signal === "SIGKILL")
            setImmediate(() => child.close(null, signal));
        };
      },
    ],
    { timeoutMs: 15 },
  );
  await assert.rejects(h.registry.list(), { status: 504 });
  assert.equal(h.children[0].closed, true);
  assert.deepEqual(h.children[0].kills, ["SIGTERM", "SIGKILL"]);
  await h.registry.close();
});
test("abort before discovery launches no process", async () => {
  const h = harness();
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(h.registry.list({ signal: controller.signal }), {
    status: 409,
  });
  assert.equal(h.calls.length, 0);
  await h.registry.close();
});
test("sole caller abort waits for cleanup; late output cannot register a device", async () => {
  const h = harness([null]);
  const controller = new AbortController();
  const pending = h.registry.list({ signal: controller.signal });
  const rejected = assert.rejects(pending, { status: 409 });
  h.children[0].onKill = () =>
    setTimeout(() => {
      h.children[0].stderr.write(listing());
      h.children[0].close();
    }, 10);
  controller.abort();
  await rejected;
  assert.equal(h.children[0].closed, true);
  await h.registry.close();
});
test("concurrent callers share a scan and one cancellation cannot interrupt another", async () => {
  const h = harness([null]);
  const controller = new AbortController();
  const first = h.registry.list({ signal: controller.signal });
  const second = h.registry.list();
  const rejected = assert.rejects(first, { status: 409 });
  controller.abort();
  await rejected;
  assert.equal(h.children[0].kills.length, 0);
  h.children[0].stderr.write(listing());
  h.children[0].close();
  assert.equal((await second).devices.length, 1);
  assert.equal(h.calls.length, 1);
  await h.registry.close();
});
test("close cancels current work, waits for cleanup and remains idempotent", async () => {
  const h = harness([null]);
  const pending = h.registry.list();
  const rejected = assert.rejects(pending, { status: 409 });
  const closing = h.registry.close();
  assert.equal(h.registry.close(), closing);
  await Promise.all([closing, rejected]);
  assert.equal(h.children[0].closed, true);
  await assert.rejects(h.registry.list(), { status: 503 });
});
test("unconfirmed cleanup latches failure and forbids another discovery process", async () => {
  const h = harness(
    [
      (child) => {
        child.onKill = () => {};
      },
    ],
    { timeoutMs: 10, killTimeoutMs: 10 },
  );
  await assert.rejects(h.registry.list(), { code: "LOCAL_CAMERA_CLEANUP" });
  await assert.rejects(h.registry.list(), { code: "LOCAL_CAMERA_CLEANUP" });
  await assert.rejects(h.registry.close(), { code: "LOCAL_CAMERA_CLEANUP" });
  assert.equal(h.calls.length, 1);
  h.children[0].close();
});
test("failed termination calls cannot report a running enumeration as cleaned up", async () => {
  const h = harness(
    [
      (child) => {
        child.onKill = () => {
          throw new Error("private-kill-error");
        };
      },
    ],
    { timeoutMs: 10, killTimeoutMs: 10 },
  );
  await assert.rejects(h.registry.list(), { code: "LOCAL_CAMERA_CLEANUP" });
  assert.equal(h.children[0].closed, false);
  assert.deepEqual(h.children[0].kills, ["SIGTERM", "SIGKILL"]);
  await assert.rejects(h.registry.close(), { code: "LOCAL_CAMERA_CLEANUP" });
  h.children[0].close();
});
test("DirectShow arguments use the trusted exact alternative, device timestamps and no audio", async () => {
  const h = harness();
  const id = (await h.registry.list()).devices[0].id;
  const { source } = await h.registry.resolve(id);
  const args = frameSourceArguments(source);
  assert.equal(args[args.indexOf("-i") + 1], `video=${alternative}`);
  assert.equal(args[args.indexOf("-f") + 1], "dshow");
  assert.equal(args[args.indexOf("-use_video_device_timestamps") + 1], "1");
  assert.equal(args[args.indexOf("-thread_queue_size") + 1], "4");
  assert.equal(args[args.indexOf("-rtbufsize") + 1], "67108864");
  for (const value of [
    "-re",
    "-rw_timeout",
    "-reconnect",
    "-tls_verify",
    "-protocol_whitelist",
    "-framerate",
    "-video_size",
  ])
    assert.equal(args.includes(value), false);
  assert.ok(args.includes("-copyts") && args.includes("-an"));
  assert.equal(args[args.indexOf("-fps_mode") + 1], "passthrough");
  assert.doesNotMatch(args[args.indexOf("-vf") + 1], /realtime|setpts|fps=/);
  for (const value of [
    `video=${alternative}`,
    { type: "usb", deviceId: id },
    { protocol: "dshow:", value: alternative },
  ])
    assert.throws(() => frameSourceArguments(value));
  assert.throws(
    () => frameSourceArguments(source, { localFile: true }),
    /cannot use file/,
  );
  await h.registry.close();
});
test("DirectShow decoded frames retain device PTS and callback failure drains the child", async () => {
  const h = harness();
  const id = (await h.registry.list()).devices[0].id;
  const { source } = await h.registry.resolve(id);
  const child = new FakeProcess();
  const frames = [],
    errors = [];
  const capture = await createFrameSource(source, {
    ffmpegPath: "fake-ffmpeg",
    spawn: () => child,
    onFrame: (frame) => {
      frames.push(frame);
      throw new Error("private-consumer-error");
    },
    onError: (error) => {
      errors.push(error.message);
      throw new Error("private-error-callback");
    },
  });
  const completion = assert.rejects(
    capture.completion,
    /frame consumer stopped unexpectedly/,
  );
  child.stderr.write(
    "[Parsed_showinfo_3 @ 1] config in time_base: 1/10000000\n[Parsed_showinfo_3 @ 1] n: 0 pts: 123456789 pts_time:12.3457 fmt:rgb24 s:1x1\n",
  );
  child.stdout.write(
    Buffer.concat([Buffer.from("P6\n1 1\n255\n"), Buffer.from([1, 2, 3])]),
  );
  await completion;
  assert.equal(frames.length, 1);
  assert.equal(frames[0].mediaSeconds, 12.3456789);
  assert.deepEqual(errors, ["The video frame consumer stopped unexpectedly."]);
  assert.equal(child.closed, true);
  await capture.stop();
  await capture.stop();
  await h.registry.close();
});
test("registry close during decoder import invalidates the capability before capture can start", async () => {
  const h = harness();
  const id = (await h.registry.list()).devices[0].id;
  const { source } = await h.registry.resolve(id);
  let spawned = false;
  const capture = createFrameSource(source, {
    spawn: () => {
      spawned = true;
      return new FakeProcess();
    },
    onFrame() {},
  });
  const rejected = assert.rejects(capture, /no longer available/);
  await h.registry.close();
  await rejected;
  assert.equal(spawned, false);
});
test("local discovery timeout options are validated before any process can start", () => {
  for (const value of [0, -1, NaN, Infinity, 60001])
    assert.throws(() => createLocalCameras({ timeoutMs: value }), /outside/);
  for (const value of [0, -1, NaN, Infinity, 10001])
    assert.throws(
      () => createLocalCameras({ killTimeoutMs: value }),
      /outside/,
    );
});
