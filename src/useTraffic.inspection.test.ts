import { describe, expect, it, vi } from "vitest";
import { LatestAnalyzedVehicleFrame, type CaptureSample } from "./useTraffic";
import type { Track } from "./vision/types";
const track = (id = 7, className = "car"): Track => ({
  id,
  className,
  bbox: [100, 200, 300, 120],
  score: 0.91,
  speedKmh: null,
  speedMeasurement: null,
  age: 1.2,
  trail: [{ x: 0.2, y: 0.3 }],
});
const sample = (): CaptureSample => ({
  time: 12.5,
  captureTime: "2026-10-02T21:00:00.000Z",
  limit: 50,
  calibration: null,
  source: "camera",
  sourceName: "Foreground fixture",
});
const frame = (label: string) => ({
  width: 1280,
  height: 720,
  toDataURL: vi.fn(() => `data:image/jpeg;base64,${btoa(label)}`),
});
describe("foreground vehicle inspection frame ownership", () => {
  it("serializes only on click and pairs copied metadata with the exact analyzed raw frame", () => {
    const retained = new LatestAnalyzedVehicleFrame();
    const raw = frame("analyzed frame"),
      newerDisplay = frame("newer display with HUD");
    const observed = track(),
      captured = sample();
    retained.retain(raw, [observed], captured, "source-a");
    expect(raw.toDataURL).not.toHaveBeenCalled();
    expect(retained.eventIds).toEqual(["source-a:7"]);
    observed.bbox[0] = 600;
    observed.trail[0].x = 0.9;
    observed.score = 0.6;
    captured.time = 99;
    captured.sourceName = "Replacement source";
    const inspection = retained.inspect(7, "source-a:7")!;
    expect(raw.toDataURL).toHaveBeenCalledExactlyOnceWith("image/jpeg", 0.94);
    expect(newerDisplay.toDataURL).not.toHaveBeenCalled();
    expect(inspection.imageUrl).toBe(
      `data:image/jpeg;base64,${btoa("analyzed frame")}`,
    );
    expect(inspection).toMatchObject({
      sourceId: "source-a",
      frameId: 1,
      frameWidth: 1280,
      frameHeight: 720,
      sourceTimestamp: 12.5,
      sourceName: "Foreground fixture",
      captureTime: "2026-10-02T21:00:00.000Z",
    });
    expect(inspection.track.bbox).toEqual([100, 200, 300, 120]);
    expect(inspection.track.trail).toEqual([{ x: 0.2, y: 0.3 }]);
    expect(inspection.track.score).toBe(0.91);
    expect(Object.isFrozen(inspection)).toBe(true);
    expect(Object.isFrozen(inspection.track.bbox)).toBe(true);
  });
  it("replaces its only retained bundle and cannot inspect an ID from a previous frame", () => {
    const retained = new LatestAnalyzedVehicleFrame();
    const first = frame("first"),
      next = frame("next");
    retained.retain(first, [track(7)], sample(), "source-a");
    const frozen = retained.inspect(7)!;
    retained.retain(next, [track(8)], { ...sample(), time: 13 }, "source-a");
    expect(retained.eventIds).toEqual(["source-a:8"]);
    expect(retained.inspect(7, "source-a:7")).toBeNull();
    const newer = retained.inspect(8, "source-a:8")!;
    expect(newer.frameId).toBe(2);
    expect(newer.sourceTimestamp).toBe(13);
    expect(newer.imageUrl).toBe(`data:image/jpeg;base64,${btoa("next")}`);
    expect(frozen.track.id).toBe(7);
    expect(frozen.sourceTimestamp).toBe(12.5);
    expect(frozen.imageUrl).toBe(`data:image/jpeg;base64,${btoa("first")}`);
  });
  it("rejects a history selection after source/session ID reuse without serializing another vehicle", () => {
    const retained = new LatestAnalyzedVehicleFrame();
    retained.retain(frame("old"), [track(7)], sample(), "source-a");
    retained.clear();
    const next = frame("new source");
    retained.retain(next, [track(7)], sample(), "source-b");
    expect(retained.inspect(7, "source-a:7")).toBeNull();
    expect(next.toDataURL).not.toHaveBeenCalled();
    expect(retained.inspect(7, "source-b:7")?.sourceId).toBe("source-b");
  });
  it("clears availability on invalidation and refuses a resized retained canvas", () => {
    const retained = new LatestAnalyzedVehicleFrame();
    const raw = frame("before resize");
    retained.retain(raw, [track()], sample(), "source-a");
    raw.width = 640;
    expect(retained.inspect(7)).toBeNull();
    expect(retained.eventIds).toEqual([]);
    expect(raw.toDataURL).not.toHaveBeenCalled();
    retained.retain(frame("fresh"), [track()], sample(), "source-a");
    retained.clear();
    expect(retained.eventIds).toEqual([]);
    expect(retained.inspect(7)).toBeNull();
  });
  it("requires no speeding case, omits pedestrians and preserves bicycle inspection", () => {
    const retained = new LatestAnalyzedVehicleFrame();
    const raw = frame("ordinary traffic");
    retained.retain(
      raw,
      [track(1, "person"), track(2, "bicycle"), track(3)],
      sample(),
      "source-a",
    );
    expect(retained.eventIds).toEqual(["source-a:2", "source-a:3"]);
    expect(retained.inspect(1)).toBeNull();
    expect(retained.inspect(2)?.track.className).toBe("bicycle");
    const inspection = retained.inspect(3)!;
    expect(inspection.track.speedKmh).toBeNull();
    expect(inspection.track.speedMeasurement).toBeNull();
  });
  it("keeps demo flow separate and propagates frame serialization failures", () => {
    const retained = new LatestAnalyzedVehicleFrame();
    const raw = frame("demo");
    retained.retain(raw, [track()], { ...sample(), source: "demo" }, "demo-a");
    expect(retained.inspect(7)).toBeNull();
    expect(raw.toDataURL).not.toHaveBeenCalled();
    raw.toDataURL.mockImplementation(() => {
      throw new Error("Frame access denied");
    });
    retained.retain(raw, [track()], sample(), "source-a");
    expect(() => retained.inspect(7)).toThrow("Frame access denied");
  });
});
