import type { Calibration, Point } from "./types";
const EPSILON = 1e-9;
function cross(a: Point, b: Point, c: Point): number {
  return (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x);
}
export function validateCalibration(calibration: Calibration): string | null {
  if (
    !Number.isFinite(calibration.widthMeters) ||
    calibration.widthMeters <= 0 ||
    !Number.isFinite(calibration.lengthMeters) ||
    calibration.lengthMeters <= 0
  ) {
    return "Enter a positive measured road width and length in metres.";
  }
  if (
    !Array.isArray(calibration.points) ||
    calibration.points.length !== 4 ||
    calibration.points.some(
      (p) =>
        !p ||
        !Number.isFinite(p.x) ||
        !Number.isFinite(p.y) ||
        p.x < 0 ||
        p.x > 1 ||
        p.y < 0 ||
        p.y > 1,
    )
  ) {
    return "Place all four calibration corners inside the video.";
  }
  const points = calibration.points;
  const turns = points.map((p, i) =>
    cross(p, points[(i + 1) % 4], points[(i + 2) % 4]),
  );
  if (
    turns.some((turn) => Math.abs(turn) < EPSILON) ||
    !turns.every((turn) => Math.sign(turn) === Math.sign(turns[0]))
  ) {
    return "Arrange the corners around a convex road rectangle without crossing its edges.";
  }
  const twiceArea = Math.abs(
    points.reduce((sum, p, i) => {
      const next = points[(i + 1) % 4];
      return sum + p.x * next.y - p.y * next.x;
    }, 0),
  );
  if (twiceArea < 0.002)
    return "Use a larger calibration area for a stable perspective estimate.";
  return null;
}
export function pointInPolygon(
  point: Point,
  polygon: readonly Point[],
): boolean {
  if (
    !Number.isFinite(point.x) ||
    !Number.isFinite(point.y) ||
    polygon.length < 3
  )
    return false;
  let direction = 0;
  for (let i = 0; i < polygon.length; i++) {
    const a = polygon[i];
    const b = polygon[(i + 1) % polygon.length];
    const side = (b.x - a.x) * (point.y - a.y) - (b.y - a.y) * (point.x - a.x);
    if (Math.abs(side) <= EPSILON) continue;
    if (direction !== 0 && Math.sign(side) !== direction) return false;
    direction = Math.sign(side);
  }
  return true;
}
function solve(matrix: number[][]): number[] | null {
  const n = matrix.length;
  for (let column = 0; column < n; column++) {
    let pivot = column;
    for (let row = column + 1; row < n; row++) {
      if (Math.abs(matrix[row][column]) > Math.abs(matrix[pivot][column]))
        pivot = row;
    }
    if (Math.abs(matrix[pivot][column]) < 1e-12) return null;
    [matrix[column], matrix[pivot]] = [matrix[pivot], matrix[column]];
    const divisor = matrix[column][column];
    for (let k = column; k <= n; k++) matrix[column][k] /= divisor;
    for (let row = 0; row < n; row++) {
      if (row === column) continue;
      const factor = matrix[row][column];
      for (let k = column; k <= n; k++)
        matrix[row][k] -= factor * matrix[column][k];
    }
  }
  const result = matrix.map((row) => row[n]);
  return result.every(Number.isFinite) ? result : null;
}
export function createGroundProjection(
  calibration: Calibration,
): ((point: Point) => Point | null) | null {
  if (validateCalibration(calibration)) return null;
  const destinations: Point[] = [
    { x: 0, y: 0 },
    { x: 1, y: 0 },
    { x: 1, y: 1 },
    { x: 0, y: 1 },
  ];
  const matrix: number[][] = [];
  calibration.points.forEach(({ x, y }, i) => {
    const { x: u, y: v } = destinations[i];
    matrix.push([x, y, 1, 0, 0, 0, -u * x, -u * y, u]);
    matrix.push([0, 0, 0, x, y, 1, -v * x, -v * y, v]);
  });
  const h = solve(matrix);
  if (!h) return null;
  const { widthMeters, lengthMeters } = calibration;
  return ({ x, y }: Point): Point | null => {
    const denominator = h[6] * x + h[7] * y + 1;
    if (!Number.isFinite(denominator) || Math.abs(denominator) < 1e-8)
      return null;
    const result = {
      x: ((h[0] * x + h[1] * y + h[2]) / denominator) * widthMeters,
      y: ((h[3] * x + h[4] * y + h[5]) / denominator) * lengthMeters,
    };
    return Number.isFinite(result.x) && Number.isFinite(result.y)
      ? result
      : null;
  };
}
export function intersectionOverUnion(
  a: readonly number[],
  b: readonly number[],
): number {
  const overlapWidth = Math.max(
    0,
    Math.min(a[0] + a[2], b[0] + b[2]) - Math.max(a[0], b[0]),
  );
  const overlapHeight = Math.max(
    0,
    Math.min(a[1] + a[3], b[1] + b[3]) - Math.max(a[1], b[1]),
  );
  const intersection = overlapWidth * overlapHeight;
  const union = a[2] * a[3] + b[2] * b[3] - intersection;
  return union > 0 ? intersection / union : 0;
}
