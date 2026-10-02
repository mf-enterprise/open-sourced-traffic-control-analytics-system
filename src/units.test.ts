import { describe, expect, it } from "vitest";
import {
  dualSpeed,
  formatSpeed,
  speedFromKmh,
  speedToKmh,
  speedUnitLabel,
} from "./units";
describe("speed display units", () => {
  it("converts 60 km/h using the exact international-mile conversion", () => {
    expect(speedFromKmh(60, "mph")).toBeCloseTo(37.28227153424004, 12);
    expect(speedToKmh(60, "mph")).toBeCloseTo(96.56064, 10);
  });
  it("roundtrips stored measurements and policy limits without rounding them", () => {
    for (const value of [0, 5, 37.28227, 60, 73.124987, 200]) {
      expect(speedToKmh(speedFromKmh(value, "mph"), "mph")).toBeCloseTo(
        value,
        12,
      );
      expect(speedFromKmh(value, "kmh")).toBe(value);
      expect(speedToKmh(value, "kmh")).toBe(value);
    }
  });
  it("rounds only display strings and always labels the unit", () => {
    expect(formatSpeed(60, "mph")).toBe("37.3 mph");
    expect(formatSpeed(60, "kmh", 0)).toBe("60 km/h");
    expect(dualSpeed(60)).toBe("60.0 km/h / 37.3 mph");
    expect(speedUnitLabel("mph")).toBe("mph");
  });
  it("changing display units preserves the canonical over-limit decision", () => {
    const speed = 60.04,
      limit = 60;
    expect(speed > limit).toBe(true);
    expect(speedFromKmh(speed, "mph") > speedFromKmh(limit, "mph")).toBe(true);
    expect(formatSpeed(speed, "mph")).toBe(formatSpeed(limit, "mph"));
  });
});
