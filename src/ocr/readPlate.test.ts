import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Worker } from "tesseract.js";
const mocks = vi.hoisted(() => ({ createWorker: vi.fn() }));
vi.mock("tesseract.js", () => ({
  createWorker: mocks.createWorker,
  OEM: { LSTM_ONLY: 1 },
  PSM: { SINGLE_LINE: 7 },
}));
import { readPlate, releasePlateReader } from "./readPlate";
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}
const reading = (text = "AB12 CDE") => ({ data: { text, confidence: 88 } });
function worker() {
  return {
    setParameters: vi.fn().mockResolvedValue(undefined),
    recognize: vi.fn().mockResolvedValue(reading()),
    terminate: vi.fn().mockResolvedValue(undefined),
  };
}
const canvas = {} as HTMLCanvasElement;
beforeEach(() => {
  vi.useFakeTimers();
  mocks.createWorker.mockReset();
});
afterEach(() => {
  releasePlateReader();
  vi.clearAllTimers();
  vi.useRealTimers();
});
describe("compatibility OCR cancellation", () => {
  it("caps the queue, immediately terminates active recognition and rejects queued callers", async () => {
    const old = worker();
    const ongoing = deferred<ReturnType<typeof reading>>();
    old.recognize.mockReturnValue(ongoing.promise);
    mocks.createWorker.mockResolvedValueOnce(old);
    const first = readPlate(canvas);
    const second = readPlate(canvas);
    const cancelled = Promise.allSettled([first, second]);
    await vi.waitFor(() => expect(old.recognize).toHaveBeenCalledTimes(1));
    await expect(readPlate(canvas)).rejects.toThrow(/busy/);
    releasePlateReader();
    expect(old.terminate).toHaveBeenCalledTimes(1);
    expect(await cancelled).toEqual([
      {
        status: "rejected",
        reason: expect.objectContaining({ name: "AbortError" }),
      },
      {
        status: "rejected",
        reason: expect.objectContaining({ name: "AbortError" }),
      },
    ]);
    const fresh = worker();
    mocks.createWorker.mockResolvedValueOnce(fresh);
    await expect(readPlate(canvas)).resolves.toEqual({
      plate: "AB12CDE",
      confidence: 88,
    });
    ongoing.resolve(reading("OLD123"));
    await vi.advanceTimersByTimeAsync(0);
    expect(old.recognize).toHaveBeenCalledTimes(1);
    expect(fresh.terminate).not.toHaveBeenCalled();
  });
  it("disposes a cancelled late initializer without installing it over a new active worker", async () => {
    const initializing = deferred<Worker>();
    mocks.createWorker.mockReturnValueOnce(initializing.promise);
    const oldRead = readPlate(canvas);
    const oldResult = Promise.allSettled([oldRead]);
    await vi.waitFor(() => expect(mocks.createWorker).toHaveBeenCalledTimes(1));
    releasePlateReader();
    expect((await oldResult)[0].status).toBe("rejected");
    const fresh = worker();
    const freshRecognition = deferred<ReturnType<typeof reading>>();
    fresh.recognize.mockReturnValueOnce(freshRecognition.promise);
    mocks.createWorker.mockResolvedValueOnce(fresh);
    const newRead = readPlate(canvas);
    await vi.waitFor(() => expect(fresh.recognize).toHaveBeenCalledTimes(1));
    const old = worker();
    initializing.resolve(old as unknown as Worker);
    await vi.waitFor(() => expect(old.terminate).toHaveBeenCalledTimes(1));
    expect(old.setParameters).not.toHaveBeenCalled();
    expect(fresh.terminate).not.toHaveBeenCalled();
    freshRecognition.resolve(reading("NEW456"));
    await expect(newRead).resolves.toEqual({ plate: "NEW456", confidence: 88 });
  });
  it("terminates immediately when cancellation occurs during parameter initialization", async () => {
    const initializing = deferred<void>();
    const active = worker();
    active.setParameters.mockReturnValueOnce(initializing.promise);
    mocks.createWorker.mockResolvedValueOnce(active);
    const pending = Promise.allSettled([readPlate(canvas)]);
    await vi.waitFor(() =>
      expect(active.setParameters).toHaveBeenCalledTimes(1),
    );
    releasePlateReader();
    expect(active.terminate).toHaveBeenCalledTimes(1);
    expect((await pending)[0].status).toBe("rejected");
    initializing.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(active.recognize).not.toHaveBeenCalled();
    expect(active.terminate).toHaveBeenCalledTimes(1);
  });
  it("late rejection/finally from a cancelled read cannot kill a new worker or reset its idle timer", async () => {
    const old = worker();
    const ongoing = deferred<ReturnType<typeof reading>>();
    old.recognize.mockReturnValueOnce(ongoing.promise);
    mocks.createWorker.mockResolvedValueOnce(old);
    const cancelled = Promise.allSettled([readPlate(canvas)]);
    await vi.waitFor(() => expect(old.recognize).toHaveBeenCalledTimes(1));
    releasePlateReader();
    await cancelled;
    const fresh = worker();
    mocks.createWorker.mockResolvedValueOnce(fresh);
    await readPlate(canvas);
    await vi.advanceTimersByTimeAsync(119000);
    ongoing.reject(new Error("Old worker failed after cancellation"));
    await vi.advanceTimersByTimeAsync(0);
    expect(fresh.terminate).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1000);
    expect(fresh.terminate).toHaveBeenCalledTimes(1);
  });
  it("times out stuck initialization, rejects its queue and permits an independent replacement", async () => {
    const initializing = deferred<Worker>();
    mocks.createWorker.mockReturnValueOnce(initializing.promise);
    const results = Promise.allSettled([readPlate(canvas), readPlate(canvas)]);
    await vi.waitFor(() => expect(mocks.createWorker).toHaveBeenCalledTimes(1));
    await vi.advanceTimersByTimeAsync(120000);
    for (const result of await results) {
      expect(result.status).toBe("rejected");
      if (result.status === "rejected")
        expect(result.reason.message).toMatch(/timed out/);
    }
    const fresh = worker();
    mocks.createWorker.mockResolvedValueOnce(fresh);
    await expect(readPlate(canvas)).resolves.toMatchObject({
      plate: "AB12CDE",
    });
    const late = worker();
    initializing.resolve(late as unknown as Worker);
    await vi.waitFor(() => expect(late.terminate).toHaveBeenCalledTimes(1));
    expect(fresh.terminate).not.toHaveBeenCalled();
  });
});
