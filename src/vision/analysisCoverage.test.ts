import { describe, expect, it } from "vitest";
import {
  AnalysisCoverage,
  hasAnalysisGap,
  segmentedTrendPath,
} from "./analysisCoverage";
import { isMediaDiscontinuity } from "./mediaClock";
describe("analysis coverage", () => {
  it("distinguishes suspended analysis from an ordinary advancing media timeline", () => {
    expect(isMediaDiscontinuity(30, 30)).toBe(false);
    expect(hasAnalysisGap(30)).toBe(true);
    expect(hasAnalysisGap(0.9)).toBe(false);
    expect(hasAnalysisGap(3)).toBe(false);
    expect(hasAnalysisGap(3.01)).toBe(true);
    expect(hasAnalysisGap(NaN)).toBe(true);
  });
  it("keeps unobserved buckets unknown and only records zero from an analyzed empty frame", () => {
    const coverage = new AnalysisCoverage(4);
    expect(coverage.snapshot).toEqual([null, null, null, null]);
    coverage.record(0, 4);
    coverage.record(9, 0);
    expect(coverage.snapshot).toEqual([4, null, null, 0]);
  });
  it("retains earlier observations but never fills an interrupted interval with zeros", () => {
    const coverage = new AnalysisCoverage(6);
    coverage.record(0, 3);
    coverage.record(3, 5);
    coverage.gap(4, 12);
    coverage.record(12.2, 7);
    expect(coverage.snapshot).toEqual([null, 3, null, null, null, null]);
    coverage.record(15, 2);
    expect(coverage.snapshot).toEqual([3, null, null, null, null, 2]);
  });
  it("marks a frozen media bucket unknown after a wall-clock pause and resumes in the next bucket", () => {
    const coverage = new AnalysisCoverage(3);
    coverage.record(4, 6);
    coverage.gap(4, 4);
    coverage.record(4.1, 8);
    expect(coverage.snapshot).toEqual([null, null, null]);
    coverage.record(6, 1);
    expect(coverage.snapshot).toEqual([null, null, 1]);
  });
  it("bounds long gaps and returns detached snapshots", () => {
    const coverage = new AnalysisCoverage(3);
    coverage.record(0, 2);
    coverage.gap(1, 1000);
    expect(coverage.snapshot).toEqual([null, null, null]);
    const copy = coverage.snapshot;
    copy[0] = 99;
    expect(coverage.snapshot[0]).toBe(null);
    coverage.reset();
    coverage.record(0, 0);
    expect(coverage.snapshot).toEqual([null, null, 0]);
  });
  it("breaks chart paths at unknown intervals while preserving measured zeros", () => {
    const path = segmentedTrendPath([0, 2, null, 0, 3]);
    expect(path.match(/M/g)).toHaveLength(2);
    expect(path.match(/L/g)).toHaveLength(2);
    expect(segmentedTrendPath([null, null])).toBe("");
    expect(segmentedTrendPath([0])).toBe("M1 32");
  });
});
