import { readFile, writeFile, mkdir, stat } from "node:fs/promises";
import { resolve, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import assert from "node:assert/strict";
import { build } from "esbuild";
import * as ort from "onnxruntime-web";
import ffmpeg from "ffmpeg-static";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const selfTestIndex = args.indexOf("--self-test");
const selfTest = selfTestIndex >= 0;
if (selfTest) args.splice(selfTestIndex, 1);
function option(name) {
  const index = args.indexOf(name);
  if (index < 0) return undefined;
  if (!args[index + 1] || args[index + 1].startsWith("--"))
    throw new Error(`Missing value for ${name}`);
  const value = args[index + 1];
  args.splice(index, 2);
  return value;
}
const truthArgument = option("--truth");
const matchingArgument = option("--match-only");
const replayArgument = option("--replay-detections");
if (matchingArgument && replayArgument)
  throw new Error("Choose matching-only or detection replay, not both.");
const fps = Number(option("--fps") ?? 8);
if (args.includes("--help")) {
  console.log(
    "node scripts/evaluate-traffic-video.mjs [video.mp4] [output.json] [--fps 8] [--truth truth.json]\nTracker replay: --replay-detections baseline.json [new-output.json] [--truth truth.json]\nMatching only: --match-only predictions.json --truth truth.json\nTruth: {crossings:[{id,startSeconds,endSeconds,direction:'forward'|'reverse',className?}]}\nforward means downward across the fixed A→B line.",
  );
  process.exit(0);
}
if (!Number.isFinite(fps) || fps <= 0 || fps > 60)
  throw new Error("FPS must be between 0 and 60.");
if (args.length > 2 || args.some((arg) => arg.startsWith("--")))
  throw new Error("Unexpected argument. Use --help.");
const videoPath = resolve(root, args[0] ?? "artifacts/temporal-nest.mp4");
const outputPath = resolve(
  root,
  replayArgument
    ? (args[0] ?? "artifacts/temporal-replay-predictions.json")
    : (args[1] ?? "artifacts/temporal-predictions.json"),
);
if (
  replayArgument &&
  resolve(root, replayArgument).toLowerCase() === outputPath.toLowerCase()
)
  throw new Error(
    "Detection replay must write a different file; preserve the original baseline.",
  );
const countingLine = { a: { x: 0.04, y: 0.55 }, b: { x: 0.28, y: 0.55 } };
const matchingToleranceSeconds = 0.375;
const digest = (data) => createHash("sha256").update(data).digest("hex");
const vehicleClasses = new Set([
  "car",
  "truck",
  "bus",
  "motorcycle",
  "bicycle",
]);
function matchCrossings(events, truth) {
  const annotations = truth.crossings ?? truth.events;
  if (!Array.isArray(annotations))
    throw new Error("Truth file must contain a crossings or events array.");
  const targets = annotations.map((source, index) => {
    const event = {
      ...source,
      startSeconds: source.startSeconds ?? source.timeMin,
      endSeconds: source.endSeconds ?? source.timeMax,
    };
    if (
      !Number.isFinite(event.startSeconds) ||
      !Number.isFinite(event.endSeconds) ||
      event.startSeconds < 0 ||
      event.endSeconds < event.startSeconds ||
      !["forward", "reverse"].includes(event.direction)
    )
      throw new Error(`Invalid crossing annotation ${index}.`);
    return { ...event, id: event.id ?? `truth-${index + 1}` };
  });
  if (new Set(targets.map((target) => target.id)).size !== targets.length)
    throw new Error("Truth crossing IDs must be unique.");
  const predictions = [...events].sort(
    (a, b) => a.timeSeconds - b.timeSeconds || a.trackId - b.trackId,
  );
  const edges = predictions.map((prediction) =>
    targets
      .map((target, index) => ({ target, index }))
      .filter(
        ({ target }) =>
          prediction.direction === target.direction &&
          prediction.timeSeconds >=
            Math.max(0, target.startSeconds - matchingToleranceSeconds) &&
          prediction.timeSeconds <=
            target.endSeconds + matchingToleranceSeconds,
      )
      .sort(
        (a, b) =>
          Math.abs(
            prediction.timeSeconds -
              (a.target.startSeconds + a.target.endSeconds) / 2,
          ) -
            Math.abs(
              prediction.timeSeconds -
                (b.target.startSeconds + b.target.endSeconds) / 2,
            ) || a.index - b.index,
      )
      .map(({ index }) => index),
  );
  const owner = Array(targets.length).fill(-1);
  function augment(index, visited) {
    for (const target of edges[index]) {
      if (visited.has(target)) continue;
      visited.add(target);
      if (owner[target] < 0 || augment(owner[target], visited)) {
        owner[target] = index;
        return true;
      }
    }
    return false;
  }
  predictions.forEach((_, index) => augment(index, new Set()));
  const used = new Set(owner.filter((index) => index >= 0));
  const matches = owner.flatMap((predictionIndex, truthIndex) =>
    predictionIndex < 0
      ? []
      : [
          {
            truth: targets[truthIndex],
            prediction: predictions[predictionIndex],
            classAgreement: targets[truthIndex].className
              ? targets[truthIndex].className ===
                predictions[predictionIndex].className
              : null,
          },
        ],
  );
  return {
    method:
      "Maximum-cardinality one-to-one matching by annotated media-time interval expanded by the predeclared tolerance and direction; deterministic nearest-interval-midpoint edge order. Class labels do not determine crossing matches. Boundary and uncertain annotations remain included.",
    matchingToleranceSeconds,
    truePositives: matches.length,
    falsePositives: predictions.filter((_, index) => !used.has(index)),
    falseNegatives: targets.filter((_, index) => owner[index] < 0),
    matches,
    precision: predictions.length ? matches.length / predictions.length : null,
    recall: targets.length ? matches.length / targets.length : null,
  };
}
if (matchingArgument) {
  if (!truthArgument) throw new Error("Matching-only mode requires --truth.");
  const predictionsPath = resolve(root, matchingArgument);
  const report = JSON.parse(await readFile(predictionsPath, "utf8"));
  if (!report.complete || !Array.isArray(report.crossingEvents))
    throw new Error("A complete temporal prediction report is required.");
  const truthBytes = await readFile(resolve(root, truthArgument));
  report.evaluation = matchCrossings(
    report.crossingEvents,
    JSON.parse(truthBytes),
  );
  report.truth = {
    path: relative(root, resolve(root, truthArgument)),
    sha256: digest(truthBytes),
  };
  await writeFile(predictionsPath, JSON.stringify(report, null, 2) + "\n");
  console.log(
    JSON.stringify({
      matchingComplete: true,
      output: predictionsPath,
      truePositives: report.evaluation.truePositives,
      falsePositives: report.evaluation.falsePositives.length,
      falseNegatives: report.evaluation.falseNegatives.length,
    }),
  );
  process.exit(0);
}
async function probeVideo(path) {
  const metadata = await stat(path);
  if (!metadata.isFile() || metadata.size <= 0)
    throw new Error("The video capture is missing or empty.");
  const result = await new Promise((done, fail) => {
    const child = spawn(
      ffmpeg,
      [
        "-hide_banner",
        "-nostdin",
        "-i",
        path,
        "-map",
        "0:v:0",
        "-frames:v",
        "1",
        "-vf",
        "showinfo",
        "-f",
        "null",
        "-",
      ],
      { windowsHide: true, stdio: ["ignore", "ignore", "pipe"] },
    );
    let stderr = "";
    child.stderr.on("data", (data) => {
      stderr += data;
    });
    child.on("error", fail);
    child.on("close", (code) =>
      code === 0
        ? done(stderr)
        : fail(new Error(`Video validation failed: ${stderr.slice(-4000)}`)),
    );
  });
  const shape = result.match(/\bn:\s*0\b[^\n]*?\bs:(\d+)x(\d+)/);
  if (!shape)
    throw new Error(
      "Could not determine decoded frame dimensions from FFmpeg showinfo.",
    );
  const width = Number(shape[1]),
    height = Number(shape[2]);
  if (width * height > 20000000)
    throw new Error("Capture resolution exceeds the evaluation memory limit.");
  return {
    width,
    height,
    bytes: metadata.size,
    sha256: digest(await readFile(path)),
  };
}
async function sharedImplementation() {
  const sourceFiles = [
    "src/vision/yolox.ts",
    "src/vision/tracker.ts",
    "src/vision/counting.ts",
    "src/vision/geometry.ts",
    "src/vision/types.ts",
  ];
  const hashes = {};
  for (const path of sourceFiles)
    hashes[path] = digest(await readFile(resolve(root, path)));
  const bundle = await build({
    stdin: {
      contents:
        "export {decodeYoloxOutput,LargeVehicleVerifier} from './src/vision/yolox'; export {VehicleTracker} from './src/vision/tracker'; export {CrossingCounter} from './src/vision/counting';",
      sourcefile: "temporal-evaluation-entry.ts",
      resolveDir: root,
    },
    bundle: true,
    write: false,
    platform: "node",
    format: "esm",
    external: ["onnxruntime-web", "onnxruntime-web/*"],
  });
  const code = bundle.outputFiles[0].text;
  return {
    module: await import(
      "data:text/javascript;base64," + Buffer.from(code).toString("base64")
    ),
    hashes,
    bundleSha256: digest(code),
  };
}
function decodeVideo(path, width, height) {
  const child = spawn(
    ffmpeg,
    [
      "-hide_banner",
      "-nostdin",
      "-i",
      path,
      "-map",
      "0:v:0",
      "-an",
      "-sn",
      "-dn",
      "-vf",
      `setpts=PTS-STARTPTS,fps=fps=${fps}:round=near,showinfo,format=bgr24`,
      "-fps_mode",
      "passthrough",
      "-f",
      "rawvideo",
      "-pix_fmt",
      "bgr24",
      "pipe:1",
    ],
    { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] },
  );
  const metadata = new Map(),
    waiters = new Map();
  let stderr = "",
    partial = "",
    spawnError = null,
    closed = false;
  child.stderr.on("data", (chunk) => {
    stderr = (stderr + chunk).slice(-16000);
    partial += chunk;
    const lines = partial.split(/\r?\n/);
    partial = lines.pop() ?? "";
    for (const line of lines) {
      const match = line.match(
        /\bn:\s*(\d+)\b.*?\bpts_time:([-+0-9.eE]+).*?\bs:(\d+)x(\d+)/,
      );
      if (!match) continue;
      const frame = {
        index: Number(match[1]),
        timeSeconds: Number(match[2]),
        width: Number(match[3]),
        height: Number(match[4]),
      };
      if (
        frame.width !== width ||
        frame.height !== height ||
        !Number.isFinite(frame.timeSeconds)
      ) {
        spawnError = new Error(
          "Unexpected frame metadata or resolution transition.",
        );
        child.kill();
        continue;
      }
      const waiter = waiters.get(frame.index);
      if (waiter) {
        waiters.delete(frame.index);
        waiter.resolve(frame);
      } else metadata.set(frame.index, frame);
    }
  });
  child.on("error", (error) => {
    spawnError = error;
  });
  const finished = new Promise((done) =>
    child.on("close", (code) => {
      closed = true;
      for (const waiter of waiters.values())
        waiter.reject(
          new Error("Decoder ended before frame timestamps arrived."),
        );
      waiters.clear();
      done({ code, error: spawnError, stderr });
    }),
  );
  async function timestamp(index) {
    if (metadata.has(index)) {
      const frame = metadata.get(index);
      metadata.delete(index);
      return frame;
    }
    if (closed)
      throw new Error(`Missing timestamp for decoded frame ${index}.`);
    return new Promise((resolveFrame, reject) =>
      waiters.set(index, { resolve: resolveFrame, reject }),
    );
  }
  async function* frames() {
    const bytesPerFrame = width * height * 3;
    let buffer = Buffer.allocUnsafe(bytesPerFrame),
      offset = 0,
      index = 0;
    for await (const chunk of child.stdout) {
      let position = 0;
      while (position < chunk.length) {
        const count = Math.min(bytesPerFrame - offset, chunk.length - position);
        chunk.copy(buffer, offset, position, position + count);
        offset += count;
        position += count;
        if (offset === bytesPerFrame) {
          const frame = await timestamp(index++);
          yield { ...frame, pixels: buffer };
          buffer = Buffer.allocUnsafe(bytesPerFrame);
          offset = 0;
        }
      }
    }
    const result = await finished;
    if (result.error || result.code !== 0 || offset)
      throw (
        result.error ??
        new Error(
          `FFmpeg decode failed (${result.code}, ${offset} incomplete bytes): ${result.stderr.slice(-3000)}`,
        )
      );
  }
  return { frames, child, finished };
}
function tensorData(pixels, width, height, crop = [0, 0, width, height]) {
  const [left, top, cropWidth, cropHeight] = crop;
  const ratio = Math.min(640 / cropWidth, 640 / cropHeight);
  const targetWidth = Math.floor(cropWidth * ratio),
    targetHeight = Math.floor(cropHeight * ratio);
  const plane = 640 * 640,
    data = new Float32Array(plane * 3).fill(114);
  for (let y = 0; y < targetHeight; y++) {
    const sy = Math.max(
      0,
      Math.min(cropHeight - 1, ((y + 0.5) * cropHeight) / targetHeight - 0.5),
    );
    const y0 = Math.floor(sy),
      y1 = Math.min(cropHeight - 1, y0 + 1),
      fy = sy - y0;
    for (let x = 0; x < targetWidth; x++) {
      const sx = Math.max(
        0,
        Math.min(cropWidth - 1, ((x + 0.5) * cropWidth) / targetWidth - 0.5),
      );
      const x0 = Math.floor(sx),
        x1 = Math.min(cropWidth - 1, x0 + 1),
        fx = sx - x0;
      const p00 = ((top + y0) * width + left + x0) * 3,
        p10 = ((top + y0) * width + left + x1) * 3;
      const p01 = ((top + y1) * width + left + x0) * 3,
        p11 = ((top + y1) * width + left + x1) * 3;
      for (let channel = 0; channel < 3; channel++) {
        const upper =
          pixels[p00 + channel] * (1 - fx) + pixels[p10 + channel] * fx;
        const lower =
          pixels[p01 + channel] * (1 - fx) + pixels[p11 + channel] * fx;
        data[channel * plane + y * 640 + x] = Math.round(
          upper * (1 - fy) + lower * fy,
        );
      }
    }
  }
  return data;
}
if (selfTest) {
  const predictions = [
    { trackId: 1, timeSeconds: 0.5, direction: "reverse", className: "car" },
    { trackId: 2, timeSeconds: 0.8, direction: "reverse", className: "car" },
    { trackId: 3, timeSeconds: 0.8, direction: "forward", className: "car" },
  ];
  const truth = {
    events: [
      {
        id: "a",
        timeMin: 0,
        timeMax: 0.3,
        direction: "reverse",
        className: "car",
      },
      {
        id: "b",
        timeMin: 0.4,
        timeMax: 0.5,
        direction: "reverse",
        className: "car",
      },
    ],
  };
  const matched = matchCrossings(predictions, truth);
  assert.equal(
    matched.truePositives,
    2,
    "A later event can reassign the first greedy choice to maximize one-to-one matches",
  );
  assert.equal(
    matched.falsePositives.length,
    1,
    "Wrong direction remains unmatched",
  );
  assert.equal(matched.falseNegatives.length, 0);
  const boundaryTruth = {
    crossings: [
      {
        id: "boundary",
        startSeconds: 0,
        endSeconds: 0.125,
        direction: "reverse",
      },
    ],
  };
  assert.equal(
    matchCrossings([predictions[0]], boundaryTruth).truePositives,
    1,
  );
  assert.equal(
    matchCrossings(
      [{ ...predictions[0], timeSeconds: 0.500001 }],
      boundaryTruth,
    ).truePositives,
    0,
    "Tolerance cannot silently expand",
  );
  const pixelData = Buffer.from([10, 20, 30, 40, 50, 60]);
  const letterbox = tensorData(pixelData, 2, 1);
  assert.deepEqual(
    [letterbox[0], letterbox[640 * 640], letterbox[2 * 640 * 640]],
    [10, 20, 30],
  );
  assert.equal(letterbox[640 * 320], 114, "Bottom letterbox is gray114");
  const cropped = tensorData(pixelData, 2, 1, [1, 0, 1, 1]);
  assert.deepEqual(
    [cropped[0], cropped[640 * 640], cropped[2 * 640 * 640]],
    [40, 50, 60],
  );
  console.log(
    "Temporal evaluator self-test passed: one-to-one matching, fixed tolerance, direction, BGR channels, padding and crop mapping.",
  );
  process.exit(0);
}
const replayBytes = replayArgument
  ? await readFile(resolve(root, replayArgument))
  : null;
const replay = replayBytes ? JSON.parse(replayBytes) : null;
if (
  replay &&
  (!replay.complete ||
    !Array.isArray(replay.frames) ||
    !replay.frames.length ||
    replay.frames.some((frame) => !Array.isArray(frame.detections)))
)
  throw new Error(
    "A complete report with saved verified detections is required.",
  );
if (
  replay &&
  JSON.stringify(replay.countingLine) !== JSON.stringify(countingLine)
)
  throw new Error("Replay baseline has a different counting line.");
const video = replay ? replay.video : await probeVideo(videoPath);
const shared = await sharedImplementation();
const {
  decodeYoloxOutput,
  LargeVehicleVerifier,
  VehicleTracker,
  CrossingCounter,
} = shared.module;
const modelBytes = replay
  ? null
  : await readFile(resolve(root, "public/models/yolox_s.onnx"));
const modelSha256 = replay ? replay.model.sha256 : digest(modelBytes);
if (
  modelSha256 !==
  "c5c2d13e59ae883e6af3b45daea64af4833a4951c92d116ec270d9ddbe998063"
)
  throw new Error(
    "The model differs from the verified official YOLOX-S release.",
  );
ort.env.wasm.numThreads = 1;
const session = replay
  ? null
  : await ort.InferenceSession.create(modelBytes, {
      executionProviders: ["wasm"],
      graphOptimizationLevel: "all",
    });
const decoder = replay
  ? null
  : decodeVideo(videoPath, video.width, video.height);
const sourceFrames = replay ? replay.frames : decoder.frames();
const verifier = new LargeVehicleVerifier(),
  tracker = new VehicleTracker(null),
  counter = new CrossingCounter(countingLine);
const perTrackCounters = new Map(),
  histories = new Map(),
  frames = [],
  crossingEvents = [];
let inferenceMilliseconds = 0,
  inferenceRuns = 0,
  cropRuns = 0,
  previousTime = -Infinity,
  complete = false,
  failure = null;
const started = performance.now();
const interrupt = () => {
  failure = new Error("Evaluation interrupted.");
  decoder?.child.kill();
};
process.once("SIGINT", interrupt);
process.once("SIGTERM", interrupt);
async function infer(frame, crop) {
  if (!session)
    throw new Error("A detection-only replay must not invoke the model.");
  const input = new ort.Tensor(
    "float32",
    tensorData(frame.pixels, video.width, video.height, crop),
    [1, 3, 640, 640],
  );
  let outputs;
  const begin = performance.now();
  try {
    outputs = await session.run({ [session.inputNames[0]]: input });
    const output = outputs[session.outputNames[0]];
    return decodeYoloxOutput(
      output.data,
      output.dims,
      crop?.[2] ?? video.width,
      crop?.[3] ?? video.height,
      crop ? 0.6 : 0.35,
    );
  } finally {
    inferenceMilliseconds += performance.now() - begin;
    inferenceRuns++;
    if (crop) cropRuns++;
    input.dispose();
    if (outputs) Object.values(outputs).forEach((output) => output.dispose());
  }
}
try {
  for await (const frame of sourceFrames) {
    if (failure) throw failure;
    if (frame.timeSeconds <= previousTime)
      throw new Error("Decoded media timestamps are not strictly increasing.");
    previousTime = frame.timeSeconds;
    const rawDetections = replay ? frame.rawDetections : await infer(frame);
    const detections = replay
      ? frame.detections
      : await verifier.verify(
          rawDetections,
          video.width,
          video.height,
          frame.timeSeconds * 1000,
          (crop) => infer(frame, crop),
        );
    const tracks = tracker.update(
      detections,
      frame.timeSeconds,
      video.width,
      video.height,
    );
    if (tracks.some((track) => track.speedKmh !== null))
      throw new Error(
        "Uncalibrated temporal evaluation must not produce speeds.",
      );
    const counts = counter.update(
      tracks,
      video.width,
      video.height,
      frame.timeSeconds,
    );
    const active = new Map(tracks.map((track) => [track.id, track]));
    for (const track of tracks) {
      if (!perTrackCounters.has(track.id))
        perTrackCounters.set(track.id, new CrossingCounter(countingLine));
      let history = histories.get(track.id);
      if (!history) {
        history = {
          id: track.id,
          firstSeenSeconds: frame.timeSeconds,
          lastSeenSeconds: frame.timeSeconds,
          lastClassName: track.className,
          firstBbox: track.bbox,
          lastBbox: track.bbox,
          observations: 0,
          classes: {},
          classChanges: [],
          maximumObservationGapSeconds: 0,
        };
        histories.set(track.id, history);
      }
      if (history.lastClassName !== track.className)
        history.classChanges.push({
          timeSeconds: frame.timeSeconds,
          from: history.lastClassName,
          to: track.className,
        });
      history.maximumObservationGapSeconds = Math.max(
        history.maximumObservationGapSeconds,
        frame.timeSeconds - history.lastSeenSeconds,
      );
      history.lastSeenSeconds = frame.timeSeconds;
      history.lastClassName = track.className;
      history.lastBbox = track.bbox;
      history.observations++;
      history.classes[track.className] =
        (history.classes[track.className] ?? 0) + 1;
    }
    const frameEvents = [];
    let instrumentedCount = 0;
    for (const [id, instance] of perTrackCounters) {
      const before = instance.snapshot;
      const track = active.get(id);
      const after = instance.update(
        track ? [track] : [],
        video.width,
        video.height,
        frame.timeSeconds,
      );
      instrumentedCount += after.total;
      if (after.total > before.total) {
        const event = {
          eventId: `crossing-${crossingEvents.length + 1}`,
          trackId: id,
          timeSeconds: frame.timeSeconds,
          direction: after.forward > before.forward ? "forward" : "reverse",
          className: track.className,
          bbox: track.bbox,
          ageSeconds: track.age,
        };
        crossingEvents.push(event);
        frameEvents.push(event);
      }
    }
    if (instrumentedCount !== counts.total)
      throw new Error(
        "Per-track event instrumentation differs from the shared aggregate counter.",
      );
    frames.push({
      index: frame.index,
      timeSeconds: frame.timeSeconds,
      rawDetections,
      detections,
      tracks,
      crossingEvents: frameEvents,
      crossingCounts: counts,
    });
    if (frames.length % 16 === 0)
      console.log(
        JSON.stringify({
          frames: frames.length,
          mediaSeconds: frame.timeSeconds,
          crossings: counts.total,
          observedIds: histories.size,
          elapsedSeconds: Math.round((performance.now() - started) / 1000),
        }),
      );
  }
  if (!frames.length)
    throw new Error("The capture contained no sampled frames.");
  complete = true;
} catch (error) {
  failure = error;
} finally {
  if (decoder) {
    if (decoder.child.exitCode === null) decoder.child.kill();
    await decoder.finished;
  }
  if (session) await session.release();
  process.off("SIGINT", interrupt);
  process.off("SIGTERM", interrupt);
}
const elapsedSeconds = (performance.now() - started) / 1000;
const identities = [...histories.values()];
const lastClassCounts = {};
for (const history of identities)
  lastClassCounts[history.lastClassName] =
    (lastClassCounts[history.lastClassName] ?? 0) + 1;
const report = {
  complete,
  createdAt: new Date().toISOString(),
  error: failure ? String(failure.stack ?? failure) : null,
  video: replay ? video : { path: relative(root, videoPath), ...video },
  sampledFps: replay ? replay.sampledFps : fps,
  replayOf: replay
    ? {
        path: relative(root, resolve(root, replayArgument)),
        sha256: digest(replayBytes),
        originalImplementation: replay.implementation,
        reused:
          "Exact saved verified detections and media timestamps. Detector and contextual verifier are not rerun; only the current shared tracker and counter are evaluated.",
      }
    : null,
  timestamps:
    "FFmpeg showinfo PTS after zero-origin normalization and fps resampling; tracker and contextual verification use this media time, never CPU wall time.",
  model: {
    name: "YOLOX-S",
    release: "0.1.1rc0",
    sha256: modelSha256,
    backend: replay
      ? "Saved verified detections; no model inference"
      : "ONNX Runtime WASM, one CPU thread",
    confidenceFloor: 0.35,
    trackerInitiationConfidence: 0.55,
  },
  implementation: {
    sourceSha256: shared.hashes,
    bundledSha256: shared.bundleSha256,
  },
  countingLine,
  matchingPolicy: {
    matchingToleranceSeconds,
    declaration:
      "Fixed before inspecting model predictions against ground truth; never tuned after observing misses. Boundary events are included.",
  },
  scope: replay
    ? "Regression replay of previously saved verified detections against the current shared tracker/counter on the same clip. This is not an independent held-out evaluation or a model/browser performance test. Original baseline remains unchanged. No speed calibration or estimates. Matching tolerance remains fixed."
    : "One offline replay across the declared finite left-road counting line, not full-scene object precision or general class accuracy. No road calibration and no speed estimates. Decode, contextual verification, tracking and crossing algorithms are the exact shared application implementation. Deterministic BGR bilinear preprocessing may differ slightly from browser canvas sampling. Media sampling is 8fps by default; measured CPU processing throughput is separate from browser realtime performance. No accuracy claims without independent annotations.",
  summary: {
    sampledFrames: frames.length,
    firstMediaTimeSeconds: frames[0]?.timeSeconds ?? null,
    lastMediaTimeSeconds: frames.at(-1)?.timeSeconds ?? null,
    elapsedReplayWallSeconds: elapsedSeconds,
    processedFramesPerWallSecond: frames.length / elapsedSeconds,
    modelRuns: inferenceRuns,
    cropRuns,
    totalModelInferenceSeconds: inferenceMilliseconds / 1000,
    observedTrackIds: identities.length,
    observedVehicleTrackIds: identities.filter((history) =>
      vehicleClasses.has(history.lastClassName),
    ).length,
    lastClassCounts,
    identitiesWithClassChanges: identities.filter(
      (history) => history.classChanges.length,
    ).length,
    totalClassChanges: identities.reduce(
      (sum, history) => sum + history.classChanges.length,
      0,
    ),
    crossingCounts: counter.snapshot,
  },
  identities,
  crossingEvents,
  frames,
};
if (truthArgument && complete) {
  const truthBytes = await readFile(resolve(root, truthArgument));
  report.truth = {
    path: relative(root, resolve(root, truthArgument)),
    sha256: digest(truthBytes),
  };
  report.evaluation = matchCrossings(crossingEvents, JSON.parse(truthBytes));
}
await mkdir(dirname(outputPath), { recursive: true });
await writeFile(outputPath, JSON.stringify(report, null, 2) + "\n");
console.log(
  JSON.stringify({ complete, output: outputPath, ...report.summary }),
);
if (failure) {
  console.error(failure);
  process.exitCode = 1;
}
