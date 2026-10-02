import { createGroundProjection, pointInPolygon } from "./geometry";
import type {
  Calibration,
  Point,
  SpeedMeasurement,
  SpeedMeasurementMethod,
  SpeedSample,
} from "./types";
function median(values: number[]): number {
  values.sort((a, b) => a - b);
  const middle = Math.floor(values.length / 2);
  return values.length % 2
    ? values[middle]
    : (values[middle - 1] + values[middle]) / 2;
}
export function geometricMedianVelocity(
  vectors: readonly Point[],
): Point | null {
  if (
    !Array.isArray(vectors) ||
    !vectors.length ||
    vectors.length > (48 * 47) / 2 ||
    vectors.some((p) => !p || !Number.isFinite(p.x) || !Number.isFinite(p.y))
  )
    return null;
  const n = vectors.length;
  const center = vectors.reduce(
    (sum, p) => ({ x: sum.x + p.x / n, y: sum.y + p.y / n }),
    { x: 0, y: 0 },
  );
  const radius = Math.max(
    ...vectors.map((p) => Math.hypot(p.x - center.x, p.y - center.y)),
  );
  if (!Number.isFinite(radius)) return null;
  if (radius === 0) return { ...vectors[0] };
  const points = vectors.map((p) => ({
    x: (p.x - center.x) / radius,
    y: (p.y - center.y) / radius,
  }));
  const restore = (p: Point): Point | null => {
    const result = {
      x: center.x + p.x * radius,
      y: center.y + p.y * radius,
    };
    return Number.isFinite(result.x) && Number.isFinite(result.y)
      ? result
      : null;
  };
  const anchor = points[0];
  let farthest = anchor;
  let longest = 0;
  for (const p of points) {
    const distance = Math.hypot(p.x - anchor.x, p.y - anchor.y);
    if (distance > longest) {
      longest = distance;
      farthest = p;
    }
  }
  if (longest === 0) return { ...vectors[0] };
  const axis = {
    x: (farthest.x - anchor.x) / longest,
    y: (farthest.y - anchor.y) / longest,
  };
  if (
    points.every(
      (p) =>
        Math.abs((p.x - anchor.x) * axis.y - (p.y - anchor.y) * axis.x) <=
        1e-12,
    )
  ) {
    const ordered = points
      .map((p, index) => ({
        index,
        along: (p.x - anchor.x) * axis.x + (p.y - anchor.y) * axis.y,
      }))
      .sort((a, b) => a.along - b.along);
    const upper = vectors[ordered[Math.floor(n / 2)].index];
    if (n % 2) return { ...upper };
    const lower = vectors[ordered[n / 2 - 1].index];
    return { x: lower.x / 2 + upper.x / 2, y: lower.y / 2 + upper.y / 2 };
  }
  const tolerance = 1e-9 * n;
  function evaluate(at: Point) {
    let rx = 0,
      ry = 0,
      inverseDistance = 0,
      coincident = 0,
      nearestDistance = Infinity;
    let nearest = points[0];
    for (const p of points) {
      const dx = p.x - at.x;
      const dy = p.y - at.y;
      const distance = Math.hypot(dx, dy);
      if (distance < nearestDistance) {
        nearestDistance = distance;
        nearest = p;
      }
      if (distance === 0) {
        coincident++;
      } else {
        rx += dx / distance;
        ry += dy / distance;
        inverseDistance += 1 / distance;
      }
    }
    const norm = Math.hypot(rx, ry);
    return {
      rx,
      ry,
      norm,
      inverseDistance,
      coincident,
      residual: Math.max(0, norm - coincident),
      nearest,
      nearestDistance,
    };
  }
  let current = { x: 0, y: 0 };
  const maxIterations = n <= 64 ? 2048 : 512;
  for (let iteration = 0; iteration < maxIterations; iteration++) {
    const state = evaluate(current);
    if (state.residual <= tolerance) return restore(current);
    if (
      (iteration === 0 ||
        (state.nearestDistance > 0 && state.nearestDistance < 1e-7)) &&
      evaluate(state.nearest).residual <= tolerance
    )
      return { ...vectors[points.indexOf(state.nearest)] };
    const factor = (1 - state.coincident / state.norm) / state.inverseDistance;
    const next = {
      x: current.x + state.rx * factor,
      y: current.y + state.ry * factor,
    };
    if (!Number.isFinite(next.x) || !Number.isFinite(next.y)) return null;
    current = next;
  }
  return null;
}
export function calculateSpeedMeasurement(
  samples: readonly SpeedSample[],
  calibration: Calibration,
  method: SpeedMeasurementMethod = "ground-plane-geometric-median-v3",
): SpeedMeasurement | null {
  if (
    (method !== "ground-plane-median-v2" &&
      method !== "ground-plane-geometric-median-v3") ||
    !Array.isArray(samples) ||
    samples.length < 4 ||
    samples.length > 48 ||
    !calibration
  )
    return null;
  const project = createGroundProjection(calibration);
  if (!project) return null;
  const ground = [];
  for (let i = 0; i < samples.length; i++) {
    const sample = samples[i];
    const point = sample?.imagePoint;
    if (
      !sample ||
      !Number.isFinite(sample.timeSeconds) ||
      sample.timeSeconds < 0 ||
      !point ||
      !Number.isFinite(point.x) ||
      !Number.isFinite(point.y) ||
      point.x < 0 ||
      point.x > 1 ||
      point.y < 0 ||
      point.y > 1 ||
      !pointInPolygon(point, calibration.points) ||
      (i > 0 &&
        (sample.timeSeconds - samples[i - 1].timeSeconds < 1 / 30 - 1e-6 ||
          sample.timeSeconds - samples[i - 1].timeSeconds > 0.5 + 1e-6))
    )
      return null;
    const projected = project(point);
    if (!projected) return null;
    ground.push(projected);
  }
  const span = samples.at(-1)!.timeSeconds - samples[0].timeSeconds;
  if (span < 0.5 - 1e-6 || span > 1.6 + 1e-6) return null;
  const vx: number[] = [],
    vy: number[] = [];
  for (let i = 0; i < samples.length - 1; i++) {
    for (let j = i + 1; j < samples.length; j++) {
      const elapsed = samples[j].timeSeconds - samples[i].timeSeconds;
      if (elapsed < 0.2 - 1e-6) continue;
      vx.push((ground[j].x - ground[i].x) / elapsed);
      vy.push((ground[j].y - ground[i].y) / elapsed);
    }
  }
  if (!vx.length) return null;
  const velocityMps =
    method === "ground-plane-median-v2"
      ? { x: median(vx), y: median(vy) }
      : geometricMedianVelocity(vx.map((x, i) => ({ x, y: vy[i] })));
  if (!velocityMps) return null;
  const speedKmh = Math.hypot(velocityMps.x, velocityMps.y) * 3.6;
  if (!Number.isFinite(speedKmh)) return null;
  return {
    method,
    samples: samples.map(({ timeSeconds, imagePoint }) => ({
      timeSeconds,
      imagePoint: { ...imagePoint },
    })),
    velocityMps,
    speedKmh,
    pairCount: vx.length,
  };
}
