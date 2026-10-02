import { describe, expect, it } from "vitest";
import { isMediaDiscontinuity } from "./mediaClock";
describe("media clock continuity", () => {
  it("accepts normal camera cadence, timestamp quantization, and minor jitter", () => {
    for (const [media, wall] of [
      [1 / 60, 1 / 60],
      [1 / 30, 1 / 60],
      [0.125, 0.13],
      [0.2, 0.15],
      [-0.01, 0.016],
      [0, 0],
    ]) {
      expect(isMediaDiscontinuity(media, wall)).toBe(false);
    }
  });
  it("does not mistake a stalled or paused frame for a timeline cut", () => {
    expect(isMediaDiscontinuity(0, 0.1)).toBe(false);
    expect(isMediaDiscontinuity(0, 30)).toBe(false);
    expect(isMediaDiscontinuity(0.03, 5)).toBe(false);
  });
  it("accepts actual media advancement while browser callbacks were suspended", () => {
    expect(isMediaDiscontinuity(30, 30)).toBe(false);
    expect(isMediaDiscontinuity(55, 60)).toBe(false);
    expect(isMediaDiscontinuity(120.1, 120)).toBe(false);
    expect(isMediaDiscontinuity(30, 0.1)).toBe(true);
  });
  it("detects backward resets while tolerating the stated rounding boundary", () => {
    expect(isMediaDiscontinuity(-0.05, 0.1)).toBe(false);
    expect(isMediaDiscontinuity(-0.051, 0.1)).toBe(true);
    expect(isMediaDiscontinuity(-25, 0.1)).toBe(true);
  });
  it("detects seek-to-live jumps on resume without rejecting ordinary resume", () => {
    expect(isMediaDiscontinuity(12, 0.016)).toBe(true);
    expect(isMediaDiscontinuity(0.04, 0.03)).toBe(false);
    expect(isMediaDiscontinuity(100, 30)).toBe(true);
  });
  it("uses the greater of one second and twice actual elapsed wall time", () => {
    expect(isMediaDiscontinuity(1, 0.1)).toBe(false);
    expect(isMediaDiscontinuity(1.01, 0.1)).toBe(true);
    expect(isMediaDiscontinuity(4, 2)).toBe(false);
    expect(isMediaDiscontinuity(4.01, 2)).toBe(true);
  });
  it("treats invalid clock inputs as unsafe to join", () => {
    for (const [media, wall] of [
      [NaN, 0.1],
      [Infinity, 1],
      [-Infinity, 1],
      [0.1, NaN],
      [0.1, Infinity],
      [0.1, -Infinity],
      [0.1, -0.01],
    ]) {
      expect(isMediaDiscontinuity(media, wall)).toBe(true);
    }
  });
});
