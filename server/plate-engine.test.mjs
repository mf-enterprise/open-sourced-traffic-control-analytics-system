import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { build } from "esbuild";
import sharp from "sharp";
import {
  createNativePlateReader,
  createPlateEngine,
  readVehiclePlate,
  verifyPlateAsset,
} from "./plate-engine.mjs";
const bundled = await build({
  stdin: {
    contents:
      "export * from './src/ocr/plateModel'; export * from './src/ocr/plateText';",
    resolveDir: process.cwd(),
    sourcefile: "plate-test-helpers.ts",
  },
  bundle: true,
  write: false,
  platform: "node",
  format: "esm",
});
const shared = await import(
  "data:text/javascript;base64," +
    Buffer.from(bundled.outputFiles[0].text).toString("base64")
);
const frame = (width = 180, height = 80) => ({
  rgb: new Uint8Array(width * height * 3).fill(120),
  width,
  height,
});
const candidate = (bbox = [20, 10, 120, 25], score = 0.2) => ({ bbox, score });
const policy = (
  candidates,
  recognition = { plate: "AB12CDE", confidence: 92 },
) => ({
  shared,
  detect: async () => candidates,
  recognize: async () => recognition,
});
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((a, b) => {
    resolve = a;
    reject = b;
  });
  return { promise, resolve, reject };
};
test("one region returns only an unverified candidate and actual model scores", async () => {
  const result = await readVehiclePlate(frame(), policy([candidate()]));
  assert.deepEqual(result.plateBox, [20, 10, 120, 25]);
  assert.equal(result.plate, "AB12CDE");
  assert.equal(result.confidence, 92);
  assert.equal(result.detectorScore, 0.2);
  assert.equal(result.state, "read");
  assert.match(result.reason, /Unverified/);
});
test("multiple distinct possible plates abstain even when only one is large enough to read", async () => {
  const result = await readVehiclePlate(frame(), {
    ...policy([candidate(), candidate([150, 15, 12, 6], 0.051)]),
    recognize: async () => {
      throw Error("must not guess");
    },
  });
  assert.equal(result.state, "ambiguous");
  assert.equal(result.plate, null);
  assert.equal(result.plateBox, null);
});
test("native detail is checked inward, before padding/resizing and before OCR", async () => {
  for (const box of [
    [10, 10, 79, 18],
    [10, 10, 80, 17],
    [-10, 0, 89, 18],
  ]) {
    const result = await readVehiclePlate(frame(), {
      ...policy([candidate(box)]),
      recognize: async () => {
        throw Error("must not upscale to pass");
      },
    });
    assert.equal(result.state, "unreadable");
    assert.equal(result.plate, null);
  }
  assert.equal(
    (await readVehiclePlate(frame(), policy([candidate([10, 10, 80, 18])])))
      .state,
    "read",
  );
});
test("no region, out-of-crop region and insufficient whole vehicle pixels abstain", async () => {
  assert.equal(
    (await readVehiclePlate(frame(), policy([]))).state,
    "unreadable",
  );
  assert.equal(
    (await readVehiclePlate(frame(), policy([candidate([500, 400, 90, 20])])))
      .plateBox,
    null,
  );
  assert.equal(
    (
      await readVehiclePlate(frame(79, 100), {
        detect: async () => {
          throw Error("no model needed");
        },
      })
    ).state,
    "unreadable",
  );
});
test("unsupported script, malformed candidate strings and low scores are not read", async () => {
  for (const recognition of [
    { plate: "香港AB123", confidence: 99 },
    { plate: "A", confidence: 99 },
    { plate: "AB123", confidence: 74.99 },
  ]) {
    const result = await readVehiclePlate(
      frame(),
      policy([candidate()], recognition),
    );
    assert.equal(result.state, "unreadable");
    assert.equal(result.plate, null);
  }
  const accepted = await readVehiclePlate(
    frame(),
    policy([candidate()], { plate: "O0 I1", confidence: 75 }),
  );
  assert.equal(accepted.plate, "O0I1");
  assert.equal(accepted.confidence, 75);
});
test("snapshot freezes both pixels and dimensions across asynchronous detection", async () => {
  const input = frame(),
    gate = deferred();
  let inspected;
  const read = readVehiclePlate(input, {
    shared,
    detect: async () => {
      await gate.promise;
      return [candidate()];
    },
    recognize: async (frozen, box) => {
      inspected = {
        width: frozen.width,
        height: frozen.height,
        pixel: frozen.rgb[0],
        box,
      };
      return { plate: "AB123", confidence: 90 };
    },
  });
  input.width = 5;
  input.height = 2;
  input.rgb.fill(0);
  gate.resolve();
  assert.equal((await read).state, "read");
  assert.deepEqual(inspected, {
    width: 180,
    height: 80,
    pixel: 120,
    box: [15, 8, 130, 29],
  });
});
test("invalid inference outputs and input rasters fail with sanitized errors", async () => {
  await assert.rejects(
    readVehiclePlate({ ...frame(), width: 1.5 }, policy([])),
    { code: "PLATE_INPUT" },
  );
  await assert.rejects(
    readVehiclePlate(frame(), policy([{ bbox: [0, 0, NaN, 25], score: 0.2 }])),
    { code: "PLATE_OUTPUT" },
  );
  await assert.rejects(
    readVehiclePlate(
      frame(),
      policy([candidate()], { plate: "AB123", confidence: Infinity }),
    ),
    { code: "PLATE_OUTPUT" },
  );
});
test("shared preprocessing keeps RGB detector order and BGR48 zero-padded OCR order", () => {
  const pixels = new Uint8ClampedArray(640 * 640 * 4);
  pixels.set([255, 127, 0, 255]);
  const detector = shared.plateRgbaToTensor(pixels);
  assert.equal(detector[0], 1);
  assert.equal(detector[640 * 640 * 2], 0);
  assert.ok(Math.abs(detector[640 * 640] - 127 / 255) < 1e-7);
  const textPixels = new Uint8ClampedArray(80 * 48 * 4);
  textPixels.set([255, 127, 0, 255]);
  const text = shared.plateRecognitionTensor(textPixels, 80, 320);
  assert.equal(text[0], -1);
  assert.equal(text[320 * 48 * 2], 1);
  assert.equal(text[80], 0);
  assert.equal(text[320 * 48 + 80], 0);
  assert.deepEqual(shared.plateRecognitionSize(80, 18), {
    width: 320,
    contentWidth: 214,
  });
});
test("pinned dictionary passes exact SHA verification and a one-byte mutation fails", async () => {
  const bytes = await readFile(
    new URL(
      "../public/models/plate-recognizer.dictionary.json",
      import.meta.url,
    ),
  );
  verifyPlateAsset(bytes, "dictionary");
  const corrupted = Buffer.from(bytes);
  corrupted[100] ^= 1;
  assert.throws(() => verifyPlateAsset(corrupted, "dictionary"), {
    code: "PLATE_ASSET",
  });
  assert.throws(() => verifyPlateAsset(new Uint8Array(5), "detector"), {
    code: "PLATE_ASSET",
  });
  assert.throws(() => verifyPlateAsset(bytes, "unknown"), {
    code: "PLATE_ASSET",
  });
});
class FakeWorker extends EventEmitter {
  messages = [];
  kills = 0;
  exitCode = null;
  send(message, callback) {
    this.messages.push(message);
    callback?.(null);
  }
  kill(signal) {
    assert.equal(signal, "SIGKILL");
    this.kills++;
    queueMicrotask(() => {
      this.exitCode = 0;
      this.emit("exit", 0);
    });
    return true;
  }
  reply(result, extra = {}) {
    this.emit("message", { id: this.messages.at(-1).id, result, ...extra });
  }
}
const good = {
  state: "read",
  plate: "AB123",
  confidence: 92,
  plateBox: [20, 10, 120, 25],
  detectorScore: 0.2,
  reason: "Unverified test candidate",
};
test("worker creation is lazy, one RPC is bounded, caller buffers remain owned", async () => {
  const child = new FakeWorker();
  let created = 0;
  const engine = await createPlateEngine({
    spawnWorker: () => {
      created++;
      return child;
    },
  });
  assert.equal(created, 0);
  assert.equal(engine.info.assetsVerified, false);
  assert.equal((await engine.read(frame(30, 40))).state, "unreadable");
  assert.equal(created, 0);
  const input = frame(),
    operation = engine.read(input);
  input.rgb.fill(0);
  input.width = 1;
  assert.equal(child.messages[0].frame.rgb[0], 120);
  assert.equal(child.messages[0].frame.width, 180);
  await assert.rejects(engine.read(frame()), { code: "PLATE_BUSY" });
  child.reply(good);
  assert.deepEqual(await operation, good);
  await engine.close();
  await engine.close();
  assert.equal(child.kills, 1);
  await assert.rejects(engine.read(frame()), { code: "PLATE_CLOSED" });
});
test("close cancels pending reads, drains the child and ignores late results", async () => {
  const child = new FakeWorker(),
    engine = await createPlateEngine({ spawnWorker: () => child });
  const operation = engine.read(frame());
  const rejected = assert.rejects(operation, { name: "AbortError" });
  await engine.close();
  await rejected;
  child.reply(good);
  assert.equal(child.kills, 1);
});
test("deadline terminates the worker and leaves no active request or reusable engine", async () => {
  const child = new FakeWorker(),
    engine = await createPlateEngine({
      spawnWorker: () => child,
      timeoutMs: 10,
    });
  await assert.rejects(engine.read(frame()), { code: "PLATE_TIMEOUT" });
  await engine.close();
  assert.equal(child.kills, 1);
  await assert.rejects(engine.read(frame()), { code: "PLATE_CLOSED" });
});
test("failed kill without exit confirmation rejects cleanup rather than claiming a drained child", async () => {
  const child = new FakeWorker();
  child.kill = () => {
    child.kills++;
    return false;
  };
  const engine = await createPlateEngine({
    spawnWorker: () => child,
    cleanupTimeoutMs: 10,
  });
  const operation = engine.read(frame());
  const cancelled = assert.rejects(operation, { name: "AbortError" });
  await assert.rejects(engine.close(), { code: "PLATE_CLEANUP" });
  await cancelled;
  await assert.rejects(engine.close(), { code: "PLATE_CLEANUP" });
  assert.equal(child.kills, 1);
});
test("a real unresponsive local child is killed and its exit is confirmed on deadline", async () => {
  let child;
  const engine = await createPlateEngine({
    timeoutMs: 150,
    spawnWorker: () => {
      child = spawn(
        process.execPath,
        ["-e", "process.on('message',()=>{});setInterval(()=>{},1000)"],
        {
          stdio: ["ignore", "ignore", "ignore", "ipc"],
          serialization: "advanced",
          windowsHide: true,
        },
      );
      return child;
    },
  });
  await assert.rejects(engine.read(frame()), { code: "PLATE_TIMEOUT" });
  await engine.close();
  assert.ok(child.exitCode !== null || child.signalCode !== null);
});
test("unexpected exit, malformed response and private native errors fail closed", async () => {
  for (const respond of [
    (child) => child.emit("exit", 1),
    (child) => child.reply({ ...good, plateBox: [0, 0, 500, 25] }),
    (child) =>
      child.reply(null, {
        error: { code: "PLATE_ASSET", message: "secret/path" },
      }),
  ]) {
    const child = new FakeWorker(),
      engine = await createPlateEngine({ spawnWorker: () => child });
    const operation = engine.read(frame());
    respond(child);
    await assert.rejects(
      operation,
      (cause) =>
        !cause.message.includes("secret") && /^PLATE_/.test(cause.code),
    );
    await engine.close();
  }
});
test(
  "real pinned CPU models: readable fixture and native Nest abstention",
  { skip: process.env.RUN_NATIVE_PLATE_TESTS !== "1", timeout: 60000 },
  async () => {
    const positive = await readFile("artifacts/plate-positive.png");
    assert.equal(
      createHash("sha256").update(positive).digest("hex"),
      "c154c3e0873fa35076ecf4f611d345c092450217fe75737b2a77183018218255",
    );
    const nest = await readFile("artifacts/nest-validation-frame.jpg");
    assert.equal(
      createHash("sha256").update(nest).digest("hex"),
      "974c5ad215f3b299813a1ab2b2e67e6c20723b90cd9a3268d16489b8afd95d50",
    );
    const crop = async (bytes, box) => {
      const { data, info } = await sharp(bytes)
        .extract({ left: box[0], top: box[1], width: box[2], height: box[3] })
        .removeAlpha()
        .raw()
        .toBuffer({ resolveWithObject: true });
      return { rgb: data, width: info.width, height: info.height };
    };
    const begun = performance.now();
    const engine = await createNativePlateReader({ shared });
    const initializationMs = performance.now() - begun;
    try {
      const positiveFrame = await crop(positive, [45, 40, 410, 235]);
      const started = performance.now(),
        first = await engine.read(positiveFrame),
        coldReadMs = performance.now() - started;
      const warm = performance.now(),
        second = await engine.read(positiveFrame),
        warmReadMs = performance.now() - warm;
      const negativeFrame = await crop(nest, [50, 379, 136, 135]);
      const negativeStarted = performance.now(),
        negative = await engine.read(negativeFrame),
        negativeReadMs = performance.now() - negativeStarted;
      console.log(
        JSON.stringify({
          plateBenchmark: {
            initializationMs,
            coldReadMs,
            warmReadMs,
            negativeReadMs,
            first,
            second,
            negative,
            info: engine.info,
          },
        }),
      );
      assert.equal(first.state, "read");
      assert.equal(first.plate, "5AU5341");
      assert.equal(second.plate, "5AU5341");
      assert.equal(negative.state, "ambiguous");
      assert.equal(negative.plate, null);
    } finally {
      await engine.close();
    }
  },
);
