import type { ObjectDetection } from "@tensorflow-models/coco-ssd";
import type { Detection } from "./types";
import { ROAD_CLASSES } from "./types";
let detector: ObjectDetection | null = null;
let advanced: typeof import("./yolox") | null = null;
let fallbackReason = "";
export function resetDetectorContext() {
  advanced?.resetYoloxVerification();
}
export function getDetectorInfo() {
  return {
    name: advanced
      ? `YOLOX-S · ${advanced.yoloxBackend()}`
      : detector
        ? "COCO-SSD · compatibility mode"
        : "Vision engine not loaded",
    fallbackReason,
  };
}
let loading: Promise<void> | null = null;
let status = "Preparing vision engine…";
const listeners = new Set<(text: string) => void>();
let inferenceQueue: Promise<void> = Promise.resolve();
export interface DetectorOptions {
  minConfidence?: number;
}
function report(message: string): void {
  status = message;
  for (const listener of listeners) {
    try {
      listener(message);
    } catch {}
  }
}
export async function loadDetector(
  onStatus?: (text: string) => void,
): Promise<void> {
  if (detector || advanced) {
    onStatus?.(status);
    return;
  }
  if (onStatus) {
    listeners.add(onStatus);
    try {
      onStatus(status);
    } catch {}
  }
  if (!loading) {
    loading = (async () => {
      try {
        report("Initializing browser vision…");
        try {
          const model = await import("./yolox");
          await model.loadYolox(report);
          advanced = model;
          return;
        } catch (error) {
          fallbackReason =
            error instanceof Error ? error.message : String(error);
          console.warn(
            "YOLOX initialization failed; loading compatible detector:",
            fallbackReason,
          );
          report("Loading compatible vision engine…");
        }
        const [tf, cocoSsd] = await Promise.all([
          import("@tensorflow/tfjs"),
          import("@tensorflow-models/coco-ssd"),
        ]);
        let accelerated = false;
        try {
          accelerated = await tf.setBackend("webgl");
          await tf.ready();
        } catch {
          accelerated = false;
        }
        if (!accelerated) {
          if (!(await tf.setBackend("cpu")))
            throw new Error("No compatible browser compute backend was found.");
          await tf.ready();
        }
        report(
          accelerated
            ? "Downloading COCO-SSD model · first run may take a moment…"
            : "Downloading COCO-SSD model · CPU mode…",
        );
        detector = await cocoSsd.load({ base: "mobilenet_v2" });
        report(
          accelerated
            ? "Vision engine ready · WebGL"
            : "Vision engine ready · CPU",
        );
      } catch (error) {
        detector = null;
        report("Vision engine could not load");
        const detail = error instanceof Error ? error.message : String(error);
        throw new Error(
          `Unable to load the vision model. Check your internet connection and allow model downloads from storage.googleapis.com, then retry. ${detail}`,
        );
      } finally {
        loading = null;
      }
    })();
  }
  try {
    await loading;
  } finally {
    if (onStatus) listeners.delete(onStatus);
  }
}
export async function detectFrame(
  source: HTMLVideoElement | HTMLCanvasElement,
  options: DetectorOptions = {},
): Promise<Detection[]> {
  if (!detector && !advanced)
    throw new Error(
      "The vision engine is not ready. Load the model before starting analysis.",
    );
  const video = "videoWidth" in source;
  const width = video ? source.videoWidth : source.width;
  const height = video ? source.videoHeight : source.height;
  if (width <= 0 || height <= 0 || (video && source.readyState < 2)) return [];
  const minimum = options.minConfidence;
  const minConfidence =
    minimum !== undefined &&
    Number.isFinite(minimum) &&
    minimum > 0 &&
    minimum <= 1
      ? minimum
      : 0.35;
  const result = inferenceQueue.then(async (): Promise<Detection[]> => {
    try {
      if (advanced)
        return await advanced.detectYolox(source, { minConfidence });
      const predictions = await detector!.detect(source, 80, minConfidence);
      return predictions
        .filter((prediction) =>
          ROAD_CLASSES.some((name) => name === prediction.class),
        )
        .map((prediction) => ({
          bbox: [...prediction.bbox] as Detection["bbox"],
          className: prediction.class,
          score: prediction.score,
        }));
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      if (/security|taint|cross.origin|cors/i.test(detail)) {
        throw new Error(
          "This video cannot be read by the browser. Upload a local video file or use a video URL that permits cross-origin access.",
        );
      }
      throw new Error(
        `Frame analysis failed. Try reloading the video or restarting analysis. ${detail}`,
      );
    }
  });
  inferenceQueue = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}
