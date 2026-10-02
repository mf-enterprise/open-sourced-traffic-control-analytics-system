import { readFile, writeFile, mkdir, stat } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import { createFrameSource } from "../server/frame-source.mjs";
import { createMonitorEngine } from "../server/monitor-engine.mjs";
import { loadVisionShared } from "../server/vision-shared.mjs";
const [inputArgument, outputArgument] = process.argv.slice(2);
if (!inputArgument || !outputArgument || process.argv.length !== 4)
  throw new Error(
    "Usage: node scripts/evaluate-native-traffic.mjs <video> <new report.json>",
  );
const input = resolve(inputArgument),
  output = resolve(outputArgument);
try {
  await stat(output);
  throw new Error("Preserve the earlier report: choose a new output path.");
} catch (error) {
  if (error.code !== "ENOENT") throw error;
}
await mkdir(dirname(output), { recursive: true });
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const inputBytes = await readFile(input);
const shared = await loadVisionShared();
const countingLine = { a: { x: 0.04, y: 0.55 }, b: { x: 0.28, y: 0.55 } };
const tracker = new shared.VehicleTracker(null);
const counter = new shared.CrossingCounter(countingLine);
const perTrack = new Map(),
  frames = [],
  crossingEvents = [];
const started = performance.now();
const engine = await createMonitorEngine();
const initializationMs = performance.now() - started;
let source,
  complete = false,
  error = null,
  produced = 0,
  lastTime = null,
  gaps = 0;
const hardDeadline = setTimeout(() => {
  error = new Error("Evaluation exceeded its 150-second bound.");
  void source?.stop();
}, 150000);
try {
  source = await createFrameSource(input, {
    localFile: true,
    fps: 10,
    spawn(executable, arguments_, options) {
      const args = [...arguments_];
      args.splice(args.indexOf("-i"), 0, "-re");
      const child = spawn(executable, args, options);
      let partial = "";
      child.stderr.on("data", (chunk) => {
        const lines = (partial + chunk.toString("utf8")).split("\n");
        partial = lines.pop();
        for (const line of lines) {
          const match = /showinfo.*\bn:\s*(\d+)\s+pts:/.exec(line);
          if (match) produced = Math.max(produced, Number(match[1]) + 1);
        }
      });
      return child;
    },
    async onFrame(frame) {
      if (error) throw error;
      if (
        lastTime !== null &&
        (frame.mediaSeconds <= lastTime || frame.mediaSeconds - lastTime > 3)
      ) {
        gaps++;
        tracker.breakContinuity();
        counter.breakContinuity();
        for (const instance of perTrack.values()) instance.breakContinuity();
        await engine.resetContext();
      }
      lastTime = frame.mediaSeconds;
      const prediction = await engine.processFrame(frame);
      const tracks = tracker.update(
        prediction.detections,
        frame.mediaSeconds,
        frame.width,
        frame.height,
      );
      assert(
        tracks.every((track) => track.speedKmh === null),
        "This uncalibrated evaluation must not produce speeds",
      );
      const counts = counter.update(
        tracks,
        frame.width,
        frame.height,
        frame.mediaSeconds,
      );
      const active = new Map(tracks.map((track) => [track.id, track]));
      for (const track of tracks)
        if (!perTrack.has(track.id))
          perTrack.set(track.id, new shared.CrossingCounter(countingLine));
      let instrumentedTotal = 0;
      const frameEvents = [];
      for (const [id, instance] of perTrack) {
        const before = instance.snapshot,
          track = active.get(id);
        const after = instance.update(
          track ? [track] : [],
          frame.width,
          frame.height,
          frame.mediaSeconds,
        );
        instrumentedTotal += after.total;
        if (after.total > before.total) {
          const event = {
            eventId: `crossing-${crossingEvents.length + 1}`,
            trackId: id,
            timeSeconds: frame.mediaSeconds,
            direction: after.forward > before.forward ? "forward" : "reverse",
            className: track.className,
            bbox: track.bbox,
            ageSeconds: track.age,
          };
          crossingEvents.push(event);
          frameEvents.push(event);
        }
      }
      assert.equal(
        instrumentedTotal,
        counts.total,
        "Event instrumentation must agree with the production aggregate counter",
      );
      frames.push({
        index: frame.index,
        timeSeconds: frame.mediaSeconds,
        width: frame.width,
        height: frame.height,
        rawDetections: prediction.rawDetections,
        detections: prediction.detections,
        tracks,
        crossingEvents: frameEvents,
        crossingCounts: counts,
        timings: prediction.timings,
      });
    },
  });
  await source.completion;
  if (error) throw error;
  assert(frames.length > 0, "No decoded frames");
  complete = true;
} catch (failure) {
  error = failure;
} finally {
  clearTimeout(hardDeadline);
  await source?.stop();
  await engine.close();
}
const implementation = {};
for (const file of [
  "server/frame-source.mjs",
  "server/vision-engine.mjs",
  "server/vision-input.mjs",
  "server/generated/vision-shared.mjs",
  "src/vision/tracker.ts",
  "src/vision/counting.ts",
])
  implementation[file] = digest(await readFile(file));
const report = {
  complete,
  createdAt: new Date().toISOString(),
  error: error ? String(error.stack ?? error) : null,
  scope:
    "One paced offline clip using production native processing. Class performance, other roads, speed accuracy and deployment-wide counting accuracy are not established.",
  video: {
    path: input,
    sha256: digest(inputBytes),
    bytes: inputBytes.length,
    width: frames[0]?.width,
    height: frames[0]?.height,
  },
  engine: engine.info,
  implementation,
  timestamps:
    "The local clip's integer PTS and time base, sampled by media-time bucket without repeating frames. Capture transcoding may have changed the original camera cadence. No processing-wall-time motion measurement or speed validation.",
  matchingPolicy: {
    matchingToleranceSeconds: 0.375,
    declaration:
      "Existing annotation protocol retained before inspecting predictions; one-to-one time-window/direction matching includes all annotated events.",
  },
  countingLine,
  sampledFps: 10,
  initializationMs,
  elapsedMs: performance.now() - started,
  summary: {
    sampledFrames: produced,
    processedFrames: frames.length,
    droppedFrames: produced - frames.length,
    gaps,
    firstMediaTimeSeconds: frames[0]?.timeSeconds,
    lastMediaTimeSeconds: frames.at(-1)?.timeSeconds,
    crossingCounts: counter.snapshot,
  },
  crossingEvents,
  frames,
};
await writeFile(output, JSON.stringify(report, null, 2) + "\n");
console.log(
  JSON.stringify(
    {
      output,
      complete,
      provider: engine.info.provider,
      summary: report.summary,
    },
    null,
    2,
  ),
);
if (!complete) process.exitCode = 1;
