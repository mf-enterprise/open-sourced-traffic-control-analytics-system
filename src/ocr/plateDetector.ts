import type {
  PlateCandidate,
  PlateWorkerRequest,
  PlateWorkerResponse,
  PlateRecognition,
} from "./plateDetector.worker";
import { plateRecognitionSize, normalizeRecognizedPlate } from "./plateModel";
export { plateRecognitionSize, normalizeRecognizedPlate } from "./plateModel";
export type { PlateCandidate, PlateRecognition } from "./plateDetector.worker";
let worker: Worker | null = null;
let loading: Promise<void> | null = null;
let finishLoading: (() => void) | null = null;
let rejectLoading: ((error: Error) => void) | null = null;
let loadTimer: ReturnType<typeof setTimeout> | undefined;
let ready = false;
let generation = 0;
let nextId = 0;
let status = "Preparing optional plate detector…";
const listeners = new Set<(message: string) => void>();
const pending = new Map<
  number,
  {
    reject: (error: Error) => void;
    timer?: ReturnType<typeof setTimeout>;
  } & (
    | {
        kind: "detect";
        resolve: (value: PlateCandidate[]) => void;
      }
    | {
        kind: "recognize";
        resolve: (value: PlateRecognition) => void;
      }
  )
>();
function report(message: string) {
  status = message;
  for (const listener of listeners) {
    try {
      listener(message);
    } catch {}
  }
}
function stop(error: Error) {
  generation++;
  worker?.terminate();
  worker = null;
  ready = false;
  clearTimeout(loadTimer);
  rejectLoading?.(error);
  finishLoading = null;
  rejectLoading = null;
  loading = null;
  for (const operation of pending.values()) {
    clearTimeout(operation.timer);
    operation.reject(error);
  }
  pending.clear();
}
export function releasePlateDetector(): void {
  const error = new Error("Plate detection was cancelled.");
  error.name = "AbortError";
  stop(error);
  status = "Preparing optional plate detector…";
}
export async function loadPlateDetector(
  onStatus?: (message: string) => void,
): Promise<void> {
  if (onStatus) {
    listeners.add(onStatus);
    try {
      onStatus(status);
    } catch {}
  }
  try {
    if (ready) return;
    let waitForReady = loading;
    if (!loading) {
      if (typeof Worker === "undefined")
        throw new Error(
          "This browser does not support the local plate-detection worker.",
        );
      const currentGeneration = generation;
      const created = new Worker(
        new URL("./plateDetector.worker.ts", import.meta.url),
        { type: "module", name: "velocity-plate-detector" },
      );
      worker = created;
      loading = new Promise<void>((resolve, reject) => {
        finishLoading = resolve;
        rejectLoading = reject;
      });
      waitForReady = loading;
      loadTimer = setTimeout(
        () =>
          stop(
            new Error(
              "Plate detector initialization timed out. Check the optional model setup and retry.",
            ),
          ),
        120000,
      );
      created.onmessage = ({ data }: MessageEvent<PlateWorkerResponse>) => {
        if (currentGeneration !== generation || worker !== created) return;
        if (data.type === "status") {
          report(data.message);
          return;
        }
        if (data.type === "ready") {
          ready = true;
          clearTimeout(loadTimer);
          finishLoading?.();
          finishLoading = null;
          rejectLoading = null;
          return;
        }
        if (data.type === "error" && data.id === undefined) {
          stop(new Error(data.message));
          return;
        }
        if (
          data.type !== "result" &&
          data.type !== "recognized" &&
          data.type !== "error"
        )
          return;
        const operation = pending.get(data.id!);
        if (!operation) return;
        clearTimeout(operation.timer);
        pending.delete(data.id!);
        if (data.type === "result" && operation.kind === "detect")
          operation.resolve(data.candidates);
        else if (data.type === "recognized" && operation.kind === "recognize")
          operation.resolve(normalizeRecognizedPlate(data.recognition));
        else
          operation.reject(
            new Error(
              data.type === "error"
                ? data.message
                : "Unexpected plate worker response.",
            ),
          );
      };
      created.onerror = (event) => {
        event.preventDefault();
        if (currentGeneration === generation)
          stop(
            new Error(
              "The local plate worker failed. Run node scripts/fetch-plate-model.mjs and npm run setup:vision, rebuild, then retry.",
            ),
          );
      };
      created.onmessageerror = () => {
        if (currentGeneration === generation)
          stop(new Error("The plate worker returned an unreadable response."));
      };
      try {
        created.postMessage({
          type: "initialize",
        } satisfies PlateWorkerRequest);
      } catch (error) {
        stop(error instanceof Error ? error : new Error(String(error)));
      }
    }
    await waitForReady;
  } finally {
    if (onStatus) listeners.delete(onStatus);
  }
}
export function detectPlates(
  source: HTMLCanvasElement,
): Promise<PlateCandidate[]> {
  if (pending.size >= 2)
    return Promise.reject(
      new Error("Plate detector is busy; wait for the current suggestions."),
    );
  const width = source.width,
    height = source.height;
  if (
    !Number.isInteger(width) ||
    !Number.isInteger(height) ||
    width < 1 ||
    height < 1
  )
    return Promise.reject(
      new Error("The evidence crop must have valid pixel dimensions."),
    );
  let pixels: ImageData;
  try {
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 640;
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (!context)
      throw new Error("The browser could not create a plate input canvas.");
    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = "high";
    context.drawImage(source, 0, 0, 640, 640);
    pixels = context.getImageData(0, 0, 640, 640);
  } catch (error) {
    return Promise.reject(
      new Error(
        `The evidence pixels could not be read for plate detection. ${error instanceof Error ? error.message : String(error)}`,
      ),
    );
  }
  const id = ++nextId;
  const requestedGeneration = generation;
  return new Promise<PlateCandidate[]>((resolve, reject) => {
    pending.set(id, { kind: "detect", resolve, reject });
    void loadPlateDetector()
      .then(() => {
        if (requestedGeneration !== generation || !pending.has(id)) return;
        const operation = pending.get(id)!;
        operation.timer = setTimeout(
          () =>
            stop(
              new Error(
                "Plate detection timed out on this device. Retry when CPU resources are available.",
              ),
            ),
          60000,
        );
        worker!.postMessage(
          {
            type: "detect",
            id,
            pixels: pixels.data.buffer,
            width,
            height,
          } satisfies PlateWorkerRequest,
          [pixels.data.buffer],
        );
      })
      .catch((error: unknown) => {
        const operation = pending.get(id);
        if (!operation) return;
        clearTimeout(operation.timer);
        pending.delete(id);
        operation.reject(
          error instanceof Error ? error : new Error(String(error)),
        );
      });
  });
}
export function recognizePlate(
  source: HTMLCanvasElement,
  onStatus?: (message: string) => void,
): Promise<PlateRecognition> {
  if (pending.size >= 2)
    return Promise.reject(
      new Error("Plate detector is busy; wait for the current suggestions."),
    );
  let pixels: ImageData;
  let size: ReturnType<typeof plateRecognitionSize>;
  try {
    size = plateRecognitionSize(source.width, source.height);
    const canvas = document.createElement("canvas");
    canvas.width = size.contentWidth;
    canvas.height = 48;
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (!context)
      throw new Error("The browser could not create a plate text canvas.");
    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = "high";
    context.drawImage(source, 0, 0, size.contentWidth, 48);
    pixels = context.getImageData(0, 0, size.contentWidth, 48);
  } catch (error) {
    return Promise.reject(
      new Error(
        `The plate pixels could not be read. ${error instanceof Error ? error.message : String(error)}`,
      ),
    );
  }
  const id = ++nextId;
  const requestedGeneration = generation;
  if (onStatus) {
    listeners.add(onStatus);
    try {
      onStatus("Preparing local plate text recognition…");
    } catch {}
  }
  return new Promise<PlateRecognition>((resolve, reject) => {
    pending.set(id, { kind: "recognize", resolve, reject });
    void loadPlateDetector()
      .then(() => {
        if (requestedGeneration !== generation || !pending.has(id)) return;
        const operation = pending.get(id)!;
        operation.timer = setTimeout(
          () =>
            stop(
              new Error(
                "Plate text recognition timed out. Retry or use the explicit Tesseract fallback.",
              ),
            ),
          120000,
        );
        worker!.postMessage(
          {
            type: "recognize",
            id,
            pixels: pixels.data.buffer,
            width: size.width,
            contentWidth: size.contentWidth,
          } satisfies PlateWorkerRequest,
          [pixels.data.buffer],
        );
      })
      .catch((error: unknown) => {
        const operation = pending.get(id);
        if (!operation) return;
        clearTimeout(operation.timer);
        pending.delete(id);
        operation.reject(
          error instanceof Error ? error : new Error(String(error)),
        );
      });
  }).finally(() => {
    if (onStatus) listeners.delete(onStatus);
  });
}
