import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  decodePlateOutputs,
  plateRgbaToTensor,
  plateRecognitionTensor,
  decodePlateCtc,
} from "./plateDetector.worker";
import type {
  PlateWorkerRequest,
  PlateWorkerResponse,
} from "./plateDetector.worker";
import {
  detectPlates,
  loadPlateDetector,
  releasePlateDetector,
  recognizePlate,
  plateRecognitionSize,
  normalizeRecognizedPlate,
} from "./plateDetector";
describe("official PP-OCRv6 recognition adapter", () => {
  it("preserves crop aspect at height 48 and pads to the official minimum width", () => {
    expect(plateRecognitionSize(83, 22)).toEqual({
      width: 320,
      contentWidth: 182,
    });
    expect(plateRecognitionSize(1001, 100)).toEqual({
      width: 480,
      contentWidth: 480,
    });
    expect(plateRecognitionSize(10000, 10)).toEqual({
      width: 3200,
      contentWidth: 3200,
    });
    expect(() => plateRecognitionSize(0, 22)).toThrow(/dimensions/);
  });
  it("uses BGR normalization and normalized zero padding without stretching the crop", () => {
    const pixels = new Uint8ClampedArray(2 * 48 * 4);
    pixels.set([255, 128, 0, 255, 0, 64, 255, 255]);
    const tensor = plateRecognitionTensor(pixels, 2, 320),
      plane = 48 * 320;
    expect(tensor[0]).toBe(-1);
    expect(tensor[1]).toBe(1);
    expect(tensor[plane]).toBeCloseTo(128 / 127.5 - 1);
    expect(tensor[plane * 2]).toBe(1);
    expect(tensor[2]).toBe(0);
    expect(tensor[plane * 2 + 319]).toBe(0);
    expect(() => plateRecognitionTensor(pixels, 2, 319)).toThrow(/pixels/);
  });
  it("collapses adjacent CTC duplicates but preserves repeats separated by blank", () => {
    const chars = ["", "O", "0", "I", "1"];
    const sequence = [1, 1, 2, 0, 2, 3, 4, 0, 4];
    const values = new Float32Array(sequence.length * chars.length);
    sequence.forEach((index, time) => {
      values[time * chars.length + index] = 0.8;
    });
    const result = decodePlateCtc(
      values,
      [1, sequence.length, chars.length],
      chars,
    );
    expect(result.plate).toBe("O00I11");
    expect(result.confidence).toBeCloseTo(80);
  });
  it("averages original retained probabilities without a second softmax or blank-score inflation", () => {
    const chars = ["", "A", "B"];
    const values = new Float32Array([
      0.1, 0.9, 0, 0.01, 0.99, 0, 0.999, 0.001, 0, 0.2, 0.2, 0.6,
    ]);
    const result = decodePlateCtc(values, [1, 4, 3], chars);
    expect(result.plate).toBe("AB");
    expect(result.confidence).toBeCloseTo(75);
    expect(
      decodePlateCtc(new Float32Array([1, 0, 0]), [1, 1, 3], chars),
    ).toEqual({ plate: "", confidence: 0 });
  });
  it("rejects mismatched dictionary and nonfinite or non-probability outputs", () => {
    expect(() =>
      decodePlateCtc(new Float32Array(3), [1, 1, 3], ["", "A"]),
    ).toThrow(/dictionary/);
    expect(() =>
      decodePlateCtc(new Float32Array([Number.NaN, 1]), [1, 1, 2], ["", "A"]),
    ).toThrow(/probabilities/);
    expect(() =>
      decodePlateCtc(new Float32Array([-0.1, 1.1]), [1, 1, 2], ["", "A"]),
    ).toThrow(/probabilities/);
  });
  it("abstains on unsupported letters without silently stripping a province prefix", () => {
    expect(
      normalizeRecognizedPlate({ plate: "京A12345", confidence: 94 }),
    ).toEqual({
      plate: "",
      rawText: "京A12345",
      confidence: 94,
      unsupportedScript: true,
    });
    expect(
      normalizeRecognizedPlate({ plate: "O0 · I1-AB", confidence: 87 }),
    ).toEqual({
      plate: "O0I1AB",
      rawText: "O0 · I1-AB",
      confidence: 87,
      unsupportedScript: false,
    });
    expect(
      normalizeRecognizedPlate({ plate: "Ä123", confidence: 90 })
        .unsupportedScript,
    ).toBe(true);
  });
});
const logitDims = [1, 300, 1];
const boxDims = [1, 300, 4];
function predictions() {
  return {
    logits: new Float32Array(300).fill(-100),
    boxes: new Float32Array(1200),
  };
}
function box(
  data: ReturnType<typeof predictions>,
  index: number,
  score: number,
  coordinates: number[],
) {
  data.logits[index] = Math.log(score / (1 - score));
  data.boxes.set(coordinates, index * 4);
}
function decode(
  data: ReturnType<typeof predictions>,
  width = 800,
  height = 400,
) {
  return decodePlateOutputs(
    data.logits,
    logitDims,
    data.boxes,
    boxDims,
    width,
    height,
  );
}
describe("plate model specification", () => {
  it("converts stretched RGBA into RGB NCHW normalized once to 0..1", () => {
    const pixels = new Uint8ClampedArray(640 * 640 * 4);
    pixels.set([255, 128, 0, 13, 0, 64, 255, 255]);
    const tensor = plateRgbaToTensor(pixels);
    expect(tensor[0]).toBe(1);
    expect(tensor[1]).toBe(0);
    expect(tensor[640 * 640]).toBeCloseTo(128 / 255);
    expect(tensor[640 * 640 + 1]).toBeCloseTo(64 / 255);
    expect(tensor[2 * 640 * 640]).toBe(0);
    expect(tensor[2 * 640 * 640 + 1]).toBe(1);
    expect(() => plateRgbaToTensor(new Uint8ClampedArray(4))).toThrow(/640/);
  });
  it("preserves compressed model scores and maps boxes to non-square source coordinates", () => {
    const data = predictions();
    box(data, 0, 0.12, [0.5, 0.6, 0.4, 0.1]);
    const results = decode(data);
    expect(results).toHaveLength(1);
    expect(results[0].score).toBeCloseTo(0.12);
    [240, 220, 320, 40].forEach((value, i) =>
      expect(results[0].bbox[i]).toBeCloseTo(value, 4),
    );
  });
  it("applies the documented low candidate floor without converting it to certainty", () => {
    const data = predictions();
    box(data, 0, 0.049, [0.1, 0.1, 0.1, 0.1]);
    box(data, 1, 0.051, [0.8, 0.8, 0.1, 0.1]);
    expect(decode(data)).toHaveLength(1);
    expect(decode(data)[0].score).toBeCloseTo(0.051);
  });
  it("clips edge proposals and rejects malformed/nonfinite/outside-center boxes", () => {
    const data = predictions();
    box(data, 0, 0.2, [0.02, 0.95, 0.2, 0.2]);
    box(data, 1, 0.3, [0.5, 0.5, -0.1, 0.2]);
    box(data, 2, 0.3, [1.1, 0.5, 0.2, 0.2]);
    box(data, 3, 0.3, [0.5, Number.NaN, 0.2, 0.2]);
    box(data, 4, 0.3, [0.5, 0.5, 0.2, 0.2]);
    data.logits[4] = Number.NaN;
    const results = decode(data);
    expect(results).toHaveLength(1);
    [0, 340, 96, 60].forEach((value, i) =>
      expect(results[0].bbox[i]).toBeCloseTo(value, 4),
    );
  });
  it("keeps the highest original score per overlapping plate and at most five distinct proposals", () => {
    const data = predictions();
    box(data, 0, 0.4, [0.1, 0.5, 0.05, 0.1]);
    box(data, 1, 0.9, [0.101, 0.5, 0.05, 0.1]);
    for (let i = 2; i < 10; i++)
      box(data, i, 0.8 - i * 0.03, [i / 11, 0.5, 0.05, 0.1]);
    const results = decode(data);
    expect(results).toHaveLength(5);
    expect(results[0].score).toBeCloseTo(0.9);
    expect(
      results.some((candidate) => Math.abs(candidate.score - 0.4) < 1e-5),
    ).toBe(false);
    expect(
      results.every(
        (candidate, index) =>
          index === 0 || candidate.score <= results[index - 1].score,
      ),
    ).toBe(true);
  });
  it("rejects incompatible graphs and invalid source dimensions", () => {
    const data = predictions();
    expect(() =>
      decodePlateOutputs(
        data.logits,
        [1, 1, 300],
        data.boxes,
        boxDims,
        800,
        400,
      ),
    ).toThrow(/outputs/);
    expect(() =>
      decodePlateOutputs(
        data.logits,
        logitDims,
        new Float32Array(20),
        boxDims,
        800,
        400,
      ),
    ).toThrow(/outputs/);
    expect(() => decode(data, 0, 400)).toThrow(/dimensions/);
    expect(() => decode(data, 800, Number.NaN)).toThrow(/dimensions/);
  });
});
class FakeWorker {
  static instances: FakeWorker[] = [];
  onmessage: ((event: MessageEvent<PlateWorkerResponse>) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  onmessageerror: (() => void) | null = null;
  messages: PlateWorkerRequest[] = [];
  terminated = false;
  constructor() {
    FakeWorker.instances.push(this);
  }
  postMessage(message: PlateWorkerRequest) {
    this.messages.push(message);
  }
  terminate() {
    this.terminated = true;
  }
  emit(data: PlateWorkerResponse) {
    this.onmessage?.({ data } as MessageEvent<PlateWorkerResponse>);
  }
  requests() {
    return this.messages.filter(
      (
        message,
      ): message is Extract<
        PlateWorkerRequest,
        {
          type: "detect";
        }
      > => message.type === "detect",
    );
  }
}
describe("optional worker lifecycle", () => {
  beforeEach(() => {
    releasePlateDetector();
    FakeWorker.instances = [];
    vi.stubGlobal("Worker", FakeWorker);
    vi.stubGlobal("document", {
      createElement: () => ({
        width: 0,
        height: 0,
        getContext: () => ({
          drawImage: vi.fn(),
          getImageData: (
            _x: number,
            _y: number,
            width: number,
            height: number,
          ) => ({
            data: new Uint8ClampedArray(width * height * 4).fill(23),
          }),
        }),
      }),
    });
  });
  afterEach(() => {
    releasePlateDetector();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });
  const source = () => ({ width: 800, height: 400 }) as HTMLCanvasElement;
  it("shares lazy startup and rejects a third outstanding detection instead of growing a queue", async () => {
    const first = detectPlates(source());
    const second = detectPlates(source());
    await expect(detectPlates(source())).rejects.toThrow(/busy/);
    expect(FakeWorker.instances).toHaveLength(1);
    const worker = FakeWorker.instances[0];
    worker.emit({ type: "ready" });
    await vi.waitFor(() => expect(worker.requests()).toHaveLength(2));
    for (const request of worker.requests())
      worker.emit({ type: "result", id: request.id, candidates: [] });
    await expect(first).resolves.toEqual([]);
    await expect(second).resolves.toEqual([]);
  });
  it("freezes the source dimensions and pixels before awaiting model initialization", async () => {
    const crop = source();
    const result = detectPlates(crop);
    crop.width = 123;
    crop.height = 456;
    const worker = FakeWorker.instances[0];
    worker.emit({ type: "ready" });
    await vi.waitFor(() => expect(worker.requests()).toHaveLength(1));
    const request = worker.requests()[0];
    expect([request.width, request.height]).toEqual([800, 400]);
    expect(new Uint8ClampedArray(request.pixels)[0]).toBe(23);
    worker.emit({
      type: "result",
      id: request.id,
      candidates: [{ bbox: [1, 2, 3, 4], score: 0.12 }],
    });
    await expect(result).resolves.toEqual([
      { bbox: [1, 2, 3, 4], score: 0.12 },
    ]);
  });
  it("cancels pending work and ignores stale responses from a released worker", async () => {
    const first = detectPlates(source()).catch((error: Error) => error);
    const oldWorker = FakeWorker.instances[0];
    oldWorker.emit({ type: "ready" });
    await vi.waitFor(() => expect(oldWorker.requests()).toHaveLength(1));
    const oldId = oldWorker.requests()[0].id;
    releasePlateDetector();
    expect(((await first) as Error).name).toBe("AbortError");
    expect(oldWorker.terminated).toBe(true);
    const next = detectPlates(source());
    const newWorker = FakeWorker.instances[1];
    oldWorker.emit({
      type: "result",
      id: oldId,
      candidates: [{ bbox: [9, 9, 9, 9], score: 0.99 }],
    });
    newWorker.emit({ type: "ready" });
    await vi.waitFor(() => expect(newWorker.requests()).toHaveLength(1));
    newWorker.emit({
      type: "result",
      id: newWorker.requests()[0].id,
      candidates: [],
    });
    await expect(next).resolves.toEqual([]);
  });
  it("reports missing model errors and allows a fresh initialization retry", async () => {
    const loading = loadPlateDetector();
    FakeWorker.instances[0].emit({
      type: "error",
      message: "Run node scripts/fetch-plate-model.mjs and retry.",
    });
    await expect(loading).rejects.toThrow(/fetch-plate-model/);
    const retry = loadPlateDetector(() => {
      throw new Error("Unmounted listener");
    });
    FakeWorker.instances[1].emit({ type: "ready" });
    await expect(retry).resolves.toBeUndefined();
  });
  it("rejects a synchronous startup transport failure and permits a fresh worker", async () => {
    vi.spyOn(FakeWorker.prototype, "postMessage").mockImplementationOnce(() => {
      throw new Error("Worker transport failed");
    });
    await expect(loadPlateDetector()).rejects.toThrow(
      "Worker transport failed",
    );
    expect(FakeWorker.instances[0].terminated).toBe(true);
    const retry = loadPlateDetector();
    FakeWorker.instances[1].emit({ type: "ready" });
    await expect(retry).resolves.toBeUndefined();
  });
  it("freezes recognition crop pixels, preserves the raw score, and reports unsupported scripts", async () => {
    const crop = { width: 83, height: 22 } as HTMLCanvasElement;
    const statuses = vi.fn();
    const result = recognizePlate(crop, statuses);
    crop.width = 500;
    const worker = FakeWorker.instances[0];
    worker.emit({ type: "ready" });
    await vi.waitFor(() =>
      expect(
        worker.messages.some((message) => message.type === "recognize"),
      ).toBe(true),
    );
    const request = worker.messages.find(
      (message) => message.type === "recognize",
    )!;
    if (request.type !== "recognize") throw new Error("Missing OCR request");
    expect([request.width, request.contentWidth]).toEqual([320, 182]);
    expect(request.pixels.byteLength).toBe(182 * 48 * 4);
    worker.emit({ type: "status", message: "Reading original crop" });
    worker.emit({
      type: "recognized",
      id: request.id,
      recognition: { plate: "京A12345", confidence: 91.25 },
    });
    await expect(result).resolves.toEqual({
      plate: "",
      confidence: 91.25,
      rawText: "京A12345",
      unsupportedScript: true,
    });
    expect(statuses).toHaveBeenCalledWith("Reading original crop");
    const calls = statuses.mock.calls.length;
    worker.emit({ type: "status", message: "Next request" });
    expect(statuses).toHaveBeenCalledTimes(calls);
  });
  it("shares the queue cap across localization and OCR and cancels both on release", async () => {
    const detection = detectPlates(source()).catch((error: Error) => error);
    const recognition = recognizePlate(source()).catch((error: Error) => error);
    await expect(recognizePlate(source())).rejects.toThrow(/busy/);
    releasePlateDetector();
    expect(((await detection) as Error).name).toBe("AbortError");
    expect(((await recognition) as Error).name).toBe("AbortError");
  });
});
