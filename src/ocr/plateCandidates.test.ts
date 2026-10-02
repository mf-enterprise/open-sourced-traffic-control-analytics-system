import { describe, expect, it } from "vitest";
import {
  clipVehicleBox,
  hasAutomaticReadDetail,
  mapPlateSuggestions,
} from "./plateCandidates";
describe("evidence plate coordinates", () => {
  it("does not search an old case without recorded vehicle bounds", () => {
    expect(clipVehicleBox(null, 1280, 752)).toBeNull();
    expect(clipVehicleBox([NaN, 1, 10, 10], 1280, 752)).toBeNull();
    expect(clipVehicleBox([20, 20, -3, 8], 1280, 752)).toBeNull();
  });
  it("clips pixel bounds to the actual evidence image", () => {
    expect(clipVehicleBox([-20, -4, 70, 34], 100, 80)).toEqual([0, 0, 50, 30]);
    expect(clipVehicleBox([90, 70, 20, 20], 100, 80)).toEqual([90, 70, 10, 10]);
    expect(clipVehicleBox([110, 0, 20, 20], 100, 80)).toBeNull();
  });
  it("maps a plate back to evidence pixels without changing its model score", () => {
    const [suggestion] = mapPlateSuggestions(
      [{ bbox: [40, 60, 100, 20], score: 0.071 }],
      [100, 200, 300, 150],
      1000,
      800,
    );
    for (const [key, value] of Object.entries({
      x: 0.136,
      y: 0.323,
      width: 0.108,
      height: 0.029,
    }))
      expect(suggestion.crop[key as keyof typeof suggestion.crop]).toBeCloseTo(
        value,
        10,
      );
    expect(suggestion.score).toBe(0.071);
    expect(suggestion.sourceWidth).toBe(100);
  });
  it("rounds fractional vehicle bounds inward instead of reading adjacent pixels", () => {
    expect(clipVehicleBox([100.8, 100.8, 100.4, 50.4], 1000, 800)).toEqual([
      101, 101, 100, 50,
    ]);
  });
  it("keeps padding inside the target vehicle, excluding adjacent vehicles/footer", () => {
    const [suggestion] = mapPlateSuggestions(
      [{ bbox: [80, 40, 50, 30], score: 0.2 }],
      [100, 100, 100, 50],
      1000,
      800,
    );
    expect(
      (suggestion.crop.x + suggestion.crop.width) * 1000,
    ).toBeLessThanOrEqual(200);
    expect(
      (suggestion.crop.y + suggestion.crop.height) * 800,
    ).toBeLessThanOrEqual(150);
  });
  it("rejects invalid candidates and withholds tiny crops from automatic OCR", () => {
    expect(
      mapPlateSuggestions(
        [{ bbox: [1, 2, 3, 4], score: NaN }],
        [0, 0, 300, 200],
        640,
        480,
      ),
    ).toEqual([]);
    const [small] = mapPlateSuggestions(
      [{ bbox: [0, 0, 16, 5], score: 0.9 }],
      [0, 0, 300, 200],
      640,
      480,
    );
    expect(hasAutomaticReadDetail(small)).toBe(false);
    expect(
      hasAutomaticReadDetail({ ...small, sourceWidth: 80, sourceHeight: 18 }),
    ).toBe(true);
  });
});
