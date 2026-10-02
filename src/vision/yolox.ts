import type { Detection } from "./types";
import type { InferenceSession, Tensor } from "onnxruntime-web";
const INPUT_SIZE = 640;
const OUTPUT_ROWS = 8400;
const MODEL_URL = "/models/yolox_s.onnx";
const ROAD_LABELS = new Map<number, string>([
  [0, "person"],
  [1, "bicycle"],
  [2, "car"],
  [3, "motorcycle"],
  [5, "bus"],
  [7, "truck"],
]);
let session: InferenceSession | null = null;
let runtime: typeof import("onnxruntime-web/webgpu") | null = null;
let loading: Promise<void> | null = null;
let inferenceQueue: Promise<void> = Promise.resolve();
let processingCanvas: HTMLCanvasElement | null = null;
let frozenCanvas: HTMLCanvasElement | null = null;
let cropCanvas: HTMLCanvasElement | null = null;
let lastVideoSource: HTMLVideoElement | null = null;
let largeVehicleVerifier: LargeVehicleVerifier | null = null;
let verificationGeneration = 0;
let backend = "Not loaded";
let status = "Preparing YOLOX-S vision…";
const listeners = new Set<(message: string) => void>();
export function yoloxBackend(): string {
  return backend;
}
export function resetYoloxVerification(): void {
  verificationGeneration++;
  largeVehicleVerifier?.reset();
  lastVideoSource = null;
}
function report(message: string) {
  status = message;
  for (const listener of listeners) {
    try {
      listener(message);
    } catch {}
  }
}
function assertOutput(output: Tensor | undefined): asserts output is Tensor {
  if (
    !output ||
    output.type !== "float32" ||
    output.dims.length !== 3 ||
    output.dims[0] !== 1 ||
    output.dims[1] !== OUTPUT_ROWS ||
    output.dims[2] !== 85
  ) {
    throw new Error(
      "Unexpected YOLOX output. Install the official YOLOX-S 640 model using npm run setup:vision.",
    );
  }
}
export async function loadYolox(
  onStatus?: (message: string) => void,
): Promise<void> {
  if (session) {
    onStatus?.(`YOLOX-S ready · ${backend}`);
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
        report("Loading YOLOX-S · 640 px precision model…");
        runtime = await import("onnxruntime-web/webgpu");
        runtime.env.wasm.numThreads = 1;
        runtime.env.wasm.wasmPaths = new URL(
          "/onnx/",
          window.location.href,
        ).href;
        const response = await fetch(MODEL_URL, {
          signal: AbortSignal.timeout(90000),
        });
        if (!response.ok)
          throw new Error(
            `Model download returned HTTP ${response.status}. Run node scripts/fetch-vision-model.mjs and retry.`,
          );
        const model = await response.arrayBuffer();
        if (model.byteLength !== 35858002)
          throw new Error(
            "YOLOX model is missing or incomplete. Run node scripts/fetch-vision-model.mjs and retry.",
          );
        const providers =
          typeof navigator !== "undefined" && "gpu" in navigator
            ? (["webgpu", "wasm"] as const)
            : (["wasm"] as const);
        const failures: {
          provider: string;
          error: unknown;
        }[] = [];
        for (const provider of providers) {
          let candidate: InferenceSession | null = null;
          try {
            report(
              `Preparing YOLOX-S · ${provider === "webgpu" ? "WebGPU" : "CPU"}…`,
            );
            candidate = await runtime.InferenceSession.create(model, {
              executionProviders: [provider],
              graphOptimizationLevel: "all",
            });
            const input = new runtime.Tensor(
              "float32",
              new Float32Array(3 * INPUT_SIZE * INPUT_SIZE).fill(114),
              [1, 3, INPUT_SIZE, INPUT_SIZE],
            );
            let outputs: Record<string, Tensor> | undefined;
            try {
              outputs = await candidate.run({
                [candidate.inputNames[0]]: input,
              });
              assertOutput(outputs[candidate.outputNames[0]]);
            } finally {
              input.dispose();
              if (outputs)
                Object.values(outputs).forEach((output) => output.dispose());
            }
            session = candidate;
            backend = provider === "webgpu" ? "WebGPU" : "CPU / WASM";
            report(`YOLOX-S ready · ${backend}`);
            return;
          } catch (error) {
            failures.push({ provider, error });
            console.warn(`[YOLOX-S] ${provider} initialization failed`, error);
            if (candidate) await candidate.release().catch(() => undefined);
          }
        }
        throw new AggregateError(
          failures.map((failure) => failure.error),
          failures
            .map(
              ({ provider, error }) =>
                `${provider}: ${error instanceof Error ? error.message : String(error)}`,
            )
            .join(" | "),
        );
      } catch (error) {
        session = null;
        backend = "Unavailable";
        report("YOLOX-S could not load");
        throw new Error(
          `Unable to initialize local YOLOX-S. Verify the model and ONNX runtime assets are installed, then restart analysis. ${error instanceof Error ? error.message : String(error)}`,
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
export function rgbaToBgrTensor(
  rgba: Uint8ClampedArray,
  width: number,
  height: number,
): Float32Array {
  const pixels = width * height;
  if (
    !Number.isSafeInteger(pixels) ||
    pixels <= 0 ||
    rgba.length !== pixels * 4
  )
    throw new Error("Invalid image dimensions.");
  const data = new Float32Array(pixels * 3);
  for (let i = 0; i < pixels; i++) {
    data[i] = rgba[i * 4 + 2];
    data[pixels + i] = rgba[i * 4 + 1];
    data[pixels * 2 + i] = rgba[i * 4];
  }
  return data;
}
function intersectionOverUnion(a: Detection, b: Detection): number {
  const [ax, ay, aw, ah] = a.bbox,
    [bx, by, bw, bh] = b.bbox;
  const intersection =
    Math.max(0, Math.min(ax + aw, bx + bw) - Math.max(ax, bx)) *
    Math.max(0, Math.min(ay + ah, by + bh) - Math.max(ay, by));
  return intersection / Math.max(1e-8, aw * ah + bw * bh - intersection);
}
const isLargeVehicle = (detection: Detection) =>
  detection.className === "bus" || detection.className === "truck";
export function needsLargeVehicleVerification(
  detection: Detection,
  width: number,
  height: number,
): boolean {
  return (
    isLargeVehicle(detection) &&
    (detection.score < 0.8 ||
      detection.bbox[2] * detection.bbox[3] > width * height * 0.15)
  );
}
export function largeVehicleCrop(
  detection: Detection,
  width: number,
  height: number,
): Detection["bbox"] {
  const [x, y, w, h] = detection.bbox;
  const left = Math.max(0, Math.floor(x - w * 0.2)),
    top = Math.max(0, Math.floor(y - h * 0.2));
  const right = Math.min(width, Math.ceil(x + w * 1.2)),
    bottom = Math.min(height, Math.ceil(y + h * 1.2));
  return [left, top, right - left, bottom - top];
}
export function confirmsLargeVehicle(
  original: Detection,
  crop: Detection["bbox"],
  results: Detection[],
): boolean {
  return results.some(
    (result) =>
      isLargeVehicle(result) &&
      result.score >= 0.6 &&
      intersectionOverUnion(original, {
        ...result,
        bbox: [
          result.bbox[0] + crop[0],
          result.bbox[1] + crop[1],
          result.bbox[2],
          result.bbox[3],
        ],
      }) >= 0.5,
  );
}
type VerificationEntry = {
  detection: Detection;
  accepted: boolean;
  firstPositiveAt: number | null;
  checkedAt: number;
  lastSeen: number;
};
export class LargeVehicleVerifier {
  private cache: VerificationEntry[] = [];
  private dimensions = "";
  private generation = 0;
  reset() {
    this.generation++;
    this.cache = [];
    this.dimensions = "";
  }
  async verify(
    detections: Detection[],
    width: number,
    height: number,
    now: number,
    inferCrop: (crop: Detection["bbox"]) => Promise<Detection[]>,
  ): Promise<Detection[]> {
    const dimensions = `${width}x${height}`;
    if (
      dimensions !== this.dimensions ||
      this.cache.some((entry) => now < entry.checkedAt)
    )
      this.reset();
    this.dimensions = dimensions;
    const generation = this.generation;
    this.cache = this.cache.filter((entry) => now - entry.lastSeen < 30000);
    const accepted = new Set<Detection>();
    const pending: {
      detection: Detection;
      entry?: VerificationEntry;
    }[] = [];
    for (const detection of detections) {
      if (!isLargeVehicle(detection)) {
        accepted.add(detection);
        continue;
      }
      const entry = this.cache.find(
        (item) =>
          item.detection.className === detection.className &&
          intersectionOverUnion(item.detection, detection) >= 0.6,
      );
      if (!entry && !needsLargeVehicleVerification(detection, width, height)) {
        accepted.add(detection);
        continue;
      }
      if (entry) entry.lastSeen = now;
      const retryAfter =
        entry && !entry.accepted && entry.firstPositiveAt !== null ? 120 : 750;
      if (entry && now - entry.checkedAt < retryAfter) {
        if (entry.accepted) accepted.add(detection);
      } else pending.push({ detection, entry });
    }
    pending.sort(
      (a, b) =>
        (a.entry?.checkedAt ?? -Infinity) - (b.entry?.checkedAt ?? -Infinity),
    );
    for (const { detection, entry } of pending.slice(0, 2)) {
      const crop = largeVehicleCrop(detection, width, height);
      const verified =
        crop[2] >= 2 &&
        crop[3] >= 2 &&
        confirmsLargeVehicle(detection, crop, await inferCrop(crop));
      if (generation !== this.generation) return [];
      const firstPositiveAt = verified ? (entry?.firstPositiveAt ?? now) : null;
      const independentlyConfirmed =
        verified &&
        entry?.firstPositiveAt !== null &&
        entry?.firstPositiveAt !== undefined &&
        now - entry.firstPositiveAt >= 120;
      const result: VerificationEntry = {
        detection: { ...detection, bbox: [...detection.bbox] },
        accepted: independentlyConfirmed,
        firstPositiveAt,
        checkedAt: now,
        lastSeen: now,
      };
      if (entry) Object.assign(entry, result);
      else this.cache.push(result);
      if (independentlyConfirmed) accepted.add(detection);
    }
    if (this.cache.length > 200)
      this.cache = this.cache
        .sort((a, b) => b.lastSeen - a.lastSeen)
        .slice(0, 200);
    return generation === this.generation
      ? detections.filter((detection) => accepted.has(detection))
      : [];
  }
}
export function decodeYoloxOutput(
  data: Float32Array,
  dims: readonly number[],
  width: number,
  height: number,
  minConfidence = 0.35,
): Detection[] {
  if (
    dims.length !== 3 ||
    dims[0] !== 1 ||
    dims[1] !== OUTPUT_ROWS ||
    dims[2] !== 85 ||
    data.length !== OUTPUT_ROWS * 85
  )
    throw new Error("Unsupported YOLOX output shape.");
  if (![width, height].every((value) => Number.isFinite(value) && value > 0))
    return [];
  const minimum =
    Number.isFinite(minConfidence) && minConfidence > 0 && minConfidence <= 1
      ? minConfidence
      : 0.35;
  const ratio = Math.min(INPUT_SIZE / width, INPUT_SIZE / height);
  const candidates: Detection[] = [];
  let row = 0;
  for (const stride of [8, 16, 32]) {
    const gridSize = INPUT_SIZE / stride;
    for (let y = 0; y < gridSize; y++)
      for (let x = 0; x < gridSize; x++, row++) {
        const offset = row * 85;
        const objectness = data[offset + 4];
        if (
          !Number.isFinite(objectness) ||
          objectness < minimum ||
          objectness > 1
        )
          continue;
        let classId = 0,
          classScore = data[offset + 5];
        for (let c = 1; c < 80; c++)
          if (data[offset + 5 + c] > classScore) {
            classId = c;
            classScore = data[offset + 5 + c];
          }
        const score = objectness * classScore;
        const className = ROAD_LABELS.get(classId);
        if (
          !className ||
          !Number.isFinite(score) ||
          score < minimum ||
          score > 1
        )
          continue;
        const cx = ((data[offset] + x) * stride) / ratio;
        const cy = ((data[offset + 1] + y) * stride) / ratio;
        const boxWidth = (Math.exp(data[offset + 2]) * stride) / ratio;
        const boxHeight = (Math.exp(data[offset + 3]) * stride) / ratio;
        if (
          ![cx, cy, boxWidth, boxHeight].every(Number.isFinite) ||
          boxWidth <= 0 ||
          boxHeight <= 0
        )
          continue;
        if (cx < 0 || cy < 0 || cx >= width || cy >= height) continue;
        const left = Math.max(0, cx - boxWidth / 2),
          top = Math.max(0, cy - boxHeight / 2);
        const right = Math.min(width, cx + boxWidth / 2),
          bottom = Math.min(height, cy + boxHeight / 2);
        if (right - left < 2 || bottom - top < 2) continue;
        candidates.push({
          className,
          score,
          bbox: [left, top, right - left, bottom - top],
        });
      }
  }
  candidates.sort((a, b) => b.score - a.score);
  const kept: Detection[] = [];
  for (const candidate of candidates.slice(0, 1000)) {
    if (!kept.some((other) => intersectionOverUnion(candidate, other) > 0.45))
      kept.push(candidate);
    if (kept.length >= 100) break;
  }
  return kept;
}
async function inferYoloxImage(
  source: HTMLCanvasElement,
  minConfidence?: number,
): Promise<Detection[]> {
  const width = source.width,
    height = source.height;
  processingCanvas ??= document.createElement("canvas");
  processingCanvas.width = INPUT_SIZE;
  processingCanvas.height = INPUT_SIZE;
  const context = processingCanvas.getContext("2d", {
    willReadFrequently: true,
  });
  if (!context)
    throw new Error("The browser could not prepare an analysis canvas.");
  context.fillStyle = "rgb(114,114,114)";
  context.fillRect(0, 0, INPUT_SIZE, INPUT_SIZE);
  const ratio = Math.min(INPUT_SIZE / width, INPUT_SIZE / height);
  context.drawImage(
    source,
    0,
    0,
    Math.floor(width * ratio),
    Math.floor(height * ratio),
  );
  const input = new runtime!.Tensor(
    "float32",
    rgbaToBgrTensor(
      context.getImageData(0, 0, INPUT_SIZE, INPUT_SIZE).data,
      INPUT_SIZE,
      INPUT_SIZE,
    ),
    [1, 3, INPUT_SIZE, INPUT_SIZE],
  );
  let outputs: Record<string, Tensor> | undefined;
  try {
    outputs = await session!.run({ [session!.inputNames[0]]: input });
    const output = outputs[session!.outputNames[0]];
    assertOutput(output);
    return decodeYoloxOutput(
      output.data as Float32Array,
      output.dims,
      width,
      height,
      minConfidence,
    );
  } finally {
    input.dispose();
    if (outputs) Object.values(outputs).forEach((output) => output.dispose());
  }
}
export async function detectYolox(
  source: HTMLVideoElement | HTMLCanvasElement,
  options: {
    minConfidence?: number;
  } = {},
): Promise<Detection[]> {
  if (!session || !runtime)
    throw new Error("Load YOLOX-S before starting analysis.");
  const generation = verificationGeneration;
  const operation = inferenceQueue.then(async () => {
    if (generation !== verificationGeneration) return [];
    const verifier = (largeVehicleVerifier ??= new LargeVehicleVerifier());
    try {
      const video = "videoWidth" in source;
      const width = video ? source.videoWidth : source.width,
        height = video ? source.videoHeight : source.height;
      if (width <= 0 || height <= 0 || (video && source.readyState < 2))
        return [];
      if (video && source !== lastVideoSource) {
        verifier.reset();
        lastVideoSource = source;
      }
      frozenCanvas ??= document.createElement("canvas");
      frozenCanvas.width = width;
      frozenCanvas.height = height;
      const frozenContext = frozenCanvas.getContext("2d");
      if (!frozenContext)
        throw new Error("The browser could not freeze an analysis frame.");
      frozenContext.drawImage(source, 0, 0);
      const detections = await inferYoloxImage(
        frozenCanvas,
        options.minConfidence,
      );
      if (generation !== verificationGeneration) return [];
      const verified = await verifier.verify(
        detections,
        width,
        height,
        performance.now(),
        async (crop) => {
          if (generation !== verificationGeneration) return [];
          cropCanvas ??= document.createElement("canvas");
          cropCanvas.width = crop[2];
          cropCanvas.height = crop[3];
          const context = cropCanvas.getContext("2d");
          if (!context)
            throw new Error(
              "The browser could not prepare a verification crop.",
            );
          context.drawImage(
            frozenCanvas!,
            crop[0],
            crop[1],
            crop[2],
            crop[3],
            0,
            0,
            crop[2],
            crop[3],
          );
          return inferYoloxImage(cropCanvas, 0.6);
        },
      );
      return generation === verificationGeneration ? verified : [];
    } catch (error) {
      if (generation !== verificationGeneration) return [];
      throw error;
    } finally {
      if (generation !== verificationGeneration) verifier.reset();
    }
  });
  inferenceQueue = operation.then(
    () => undefined,
    () => undefined,
  );
  return operation;
}
