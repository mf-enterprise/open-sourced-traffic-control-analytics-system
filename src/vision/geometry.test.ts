import { describe, expect, it } from "vitest";
import {
  createGroundProjection,
  intersectionOverUnion,
  pointInPolygon,
  validateCalibration,
} from "./geometry";
import type { Calibration, Point } from "./types";
const calibration: Calibration = {
  points: [
    { x: 0.3, y: 0.2 },
    { x: 0.7, y: 0.2 },
    { x: 0.95, y: 0.9 },
    { x: 0.05, y: 0.9 },
  ],
  widthMeters: 12,
  lengthMeters: 50,
};
describe("perspective calibration", () => {
  it("maps all four perspective corners to the measured rectangle", () => {
    const project = createGroundProjection(calibration)!;
    const expected = [
      { x: 0, y: 0 },
      { x: 12, y: 0 },
      { x: 12, y: 50 },
      { x: 0, y: 50 },
    ];
    calibration.points.forEach((point, index) => {
      const result = project(point)!;
      expect(result.x).toBeCloseTo(expected[index].x, 8);
      expect(result.y).toBeCloseTo(expected[index].y, 8);
    });
  });
  it("recovers known interior ground points from a projective camera transform", () => {
    const image = ({ x, y }: Point): Point => ({
      x: (0.4 * x - 0.15 * y + 0.3) / (1 - 0.3 * y),
      y: (0.43 * y + 0.2) / (1 - 0.3 * y),
    });
    const unit: Point[] = [
      { x: 0, y: 0 },
      { x: 1, y: 0 },
      { x: 1, y: 1 },
      { x: 0, y: 1 },
    ];
    const project = createGroundProjection({
      ...calibration,
      points: unit.map(image) as Calibration["points"],
    })!;
    for (const point of [
      { x: 0.25, y: 0.2 },
      { x: 0.6, y: 0.7 },
      { x: 0.5, y: 0.5 },
    ]) {
      const ground = project(image(point))!;
      expect(ground.x).toBeCloseTo(point.x * 12, 8);
      expect(ground.y).toBeCloseTo(point.y * 50, 8);
    }
  });
  it("rejects crossed, collinear, tiny, out-of-frame, and invalid dimension input", () => {
    const bad: Calibration[] = [
      {
        ...calibration,
        points: [
          calibration.points[0],
          calibration.points[2],
          calibration.points[1],
          calibration.points[3],
        ],
      },
      {
        ...calibration,
        points: [
          { x: 0, y: 0 },
          { x: 0.3, y: 0.3 },
          { x: 0.6, y: 0.6 },
          { x: 0.9, y: 0.9 },
        ],
      },
      {
        ...calibration,
        points: [
          { x: 0, y: 0 },
          { x: 0.001, y: 0 },
          { x: 0.001, y: 0.001 },
          { x: 0, y: 0.001 },
        ],
      },
      {
        ...calibration,
        points: [
          { x: -0.1, y: 0 },
          ...calibration.points.slice(1),
        ] as Calibration["points"],
      },
      { ...calibration, widthMeters: 0 },
      { ...calibration, lengthMeters: Infinity },
    ];
    bad.forEach((value) => {
      expect(validateCalibration(value)).toBeTypeOf("string");
      expect(createGroundProjection(value)).toBeNull();
    });
  });
  it("includes polygon edges and rejects contacts outside the road", () => {
    expect(pointInPolygon({ x: 0.5, y: 0.5 }, calibration.points)).toBe(true);
    expect(pointInPolygon(calibration.points[0], calibration.points)).toBe(
      true,
    );
    expect(pointInPolygon({ x: 0.05, y: 0.2 }, calibration.points)).toBe(false);
    expect(pointInPolygon({ x: NaN, y: 0.5 }, calibration.points)).toBe(false);
  });
  it("does not change an existing transform when dimensions are mutated", () => {
    const local = { ...calibration };
    const project = createGroundProjection(local)!;
    local.widthMeters = 1000;
    expect(project(calibration.points[1])!.x).toBeCloseTo(12);
  });
});
describe("intersection over union", () => {
  it("handles overlap and disjoint boxes", () => {
    expect(intersectionOverUnion([0, 0, 10, 10], [5, 0, 10, 10])).toBeCloseTo(
      1 / 3,
    );
    expect(intersectionOverUnion([0, 0, 10, 10], [20, 0, 10, 10])).toBe(0);
    expect(intersectionOverUnion([0, 0, 0, 0], [0, 0, 0, 0])).toBe(0);
  });
});
