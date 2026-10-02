import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { availableParallelism } from "node:os";
import { prepareRgbTensor } from "./vision-input.mjs";
import { loadVisionShared } from "./vision-shared.mjs";
export const YOLOX_MODEL_SHA256 =
  "c5c2d13e59ae883e6af3b45daea64af4833a4951c92d116ec270d9ddbe998063";
function interrupted() {
  const error = new Error(
    "Vision frame was invalidated by a context reset or engine shutdown.",
  );
  error.name = "AbortError";
  return error;
}
export function createFrameProcessor({
  infer,
  verifier,
  info,
  release = async () => {},
}) {
  let active = null,
    closed = false,
    closing = null,
    generation = 0;
  let previousTime = null,
    previousSize = null;
  const resetContext = () => {
    generation++;
    previousTime = null;
    previousSize = null;
    verifier.reset();
  };
  return {
    info: Object.freeze({ ...info }),
    resetContext,
    processFrame({ rgb, width, height, mediaSeconds } = {}) {
      if (closed) return Promise.reject(new Error("Vision engine is closed."));
      if (active) {
        const error = new Error(
          "Vision engine is busy. Keep only the latest waiting frame instead of queuing frames.",
        );
        error.code = "VISION_BUSY";
        return Promise.reject(error);
      }
      if (
        !Number.isFinite(mediaSeconds) ||
        mediaSeconds < 0 ||
        (previousTime !== null && mediaSeconds <= previousTime)
      ) {
        return Promise.reject(
          new RangeError(
            "Frame mediaSeconds must increase strictly; call resetContext() after a seek or source change.",
          ),
        );
      }
      const frameGeneration = generation,
        started = performance.now();
      let frozen,
        fullTensor,
        preprocessingMs = 0;
      try {
        fullTensor = prepareRgbTensor(rgb, width, height);
        frozen = Uint8Array.from(rgb);
        preprocessingMs = performance.now() - started;
      } catch (error) {
        return Promise.reject(error);
      }
      if (
        previousSize &&
        (previousSize.width !== width || previousSize.height !== height)
      )
        verifier.reset();
      previousTime = mediaSeconds;
      previousSize = { width, height };
      const operation = (async () => {
        let inferenceMs = 0,
          modelRuns = 0,
          cropRuns = 0;
        const check = () => {
          if (closed || generation !== frameGeneration) throw interrupted();
        };
        const run = async (crop) => {
          check();
          const pre = performance.now();
          const data = crop
            ? prepareRgbTensor(frozen, width, height, crop)
            : fullTensor;
          if (crop) preprocessingMs += performance.now() - pre;
          const begin = performance.now();
          try {
            const detections = await infer(data, {
              width: crop?.[2] ?? width,
              height: crop?.[3] ?? height,
              minConfidence: crop ? 0.6 : 0.35,
            });
            check();
            return detections;
          } finally {
            inferenceMs += performance.now() - begin;
            modelRuns++;
            if (crop) cropRuns++;
          }
        };
        const rawDetections = await run();
        const detections = await verifier.verify(
          rawDetections,
          width,
          height,
          mediaSeconds * 1000,
          run,
        );
        check();
        return {
          mediaSeconds,
          width,
          height,
          rawDetections,
          detections,
          timings: {
            totalMs: performance.now() - started,
            preprocessingMs,
            inferenceMs,
            modelRuns,
            cropRuns,
          },
        };
      })();
      active = operation;
      return operation.finally(() => {
        if (active === operation) active = null;
      });
    },
    close() {
      if (closing) return closing;
      closed = true;
      resetContext();
      closing = (async () => {
        try {
          await active;
        } catch {}
        await release();
      })();
      return closing;
    },
  };
}
export async function createVisionEngine({
  modelPath = new URL("../public/models/yolox_s.onnx", import.meta.url),
  provider = "auto",
  intraOpNumThreads = Math.min(4, availableParallelism()),
} = {}) {
  if (!["auto", "cpu", "dml"].includes(provider))
    throw new RangeError("Vision provider must be auto, cpu, or dml.");
  if (
    !Number.isSafeInteger(intraOpNumThreads) ||
    intraOpNumThreads < 1 ||
    intraOpNumThreads > 64
  )
    throw new RangeError(
      "Vision CPU thread count must be an integer from 1 to 64.",
    );
  const model = await readFile(modelPath);
  const modelSha256 = createHash("sha256").update(model).digest("hex");
  if (modelSha256 !== YOLOX_MODEL_SHA256)
    throw new Error(
      "YOLOX model checksum mismatch. Run npm run setup:vision to restore the pinned model.",
    );
  const [ort, shared] = await Promise.all([
    import("onnxruntime-node"),
    loadVisionShared(),
  ]);
  const candidates =
    provider === "auto"
      ? process.platform === "win32"
        ? ["dml", "cpu"]
        : ["cpu"]
      : [provider];
  const failures = [];
  let session, selected;
  for (const candidate of candidates) {
    try {
      session = await ort.InferenceSession.create(model, {
        executionProviders: [candidate],
        graphOptimizationLevel: "all",
        intraOpNumThreads,
        executionMode: "sequential",
        ...(candidate === "dml" ? { enableMemPattern: false } : {}),
      });
      selected = candidate;
      break;
    } catch (error) {
      failures.push(
        `${candidate}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  if (!session)
    throw new Error(
      `Native vision initialization failed. ${failures.join("; ")}`,
    );
  const info = {
    model: "YOLOX-S 0.1.1rc0",
    modelSha256,
    runtime: "onnxruntime-node",
    runtimeVersion: ort.env.versions.node ?? "unknown",
    provider: selected,
    intraOpNumThreads,
    initializationWarnings: failures,
    sourceHashes: shared.sourceHashes,
    sharedBundleSha256: shared.bundleSha256,
    confidenceFloor: 0.35,
    cropConfidenceFloor: 0.6,
    preprocessing:
      "RGB -> rounded half-pixel bilinear raw BGR NCHW640, top-left114 padding",
  };
  return createFrameProcessor({
    info,
    verifier: new shared.LargeVehicleVerifier(),
    release: () => session.release(),
    infer: async (data, { width, height, minConfidence }) => {
      const input = new ort.Tensor("float32", data, [1, 3, 640, 640]);
      let outputs;
      try {
        outputs = await session.run({ [session.inputNames[0]]: input });
        const output = outputs[session.outputNames[0]];
        if (!output)
          throw new Error("Native detector returned no output tensor.");
        return shared.decodeYoloxOutput(
          output.data,
          output.dims,
          width,
          height,
          minConfidence,
        );
      } finally {
        input.dispose();
        if (outputs)
          for (const value of Object.values(outputs)) value.dispose();
      }
    },
  });
}
