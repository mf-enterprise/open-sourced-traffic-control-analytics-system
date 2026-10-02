import type { Track } from "./types";
export interface CountingLine {
  readonly a: {
    readonly x: number;
    readonly y: number;
  };
  readonly b: {
    readonly x: number;
    readonly y: number;
  };
}
export type CountedVehicleClass =
  "car" | "truck" | "bus" | "motorcycle" | "bicycle";
export interface CrossingCounts {
  readonly total: number;
  readonly forward: number;
  readonly reverse: number;
  readonly classes: Readonly<Record<CountedVehicleClass, number>>;
}
type Point = {
  x: number;
  y: number;
};
type Side = -1 | 0 | 1;
interface Motion {
  point: Point;
  distance: number;
  side: Side;
  pendingCrossing: boolean;
  lastSeen: number;
  lastAge: number | null;
}
const VEHICLES = new Set<string>([
  "car",
  "truck",
  "bus",
  "motorcycle",
  "bicycle",
]);
const DEADBAND = 0.008;
const MINIMUM_LINE_LENGTH = 0.05;
const MAXIMUM_ABSENCE_SECONDS = 1.5;
const EPSILON = 1e-10;
const emptyClasses = (): Record<CountedVehicleClass, number> => ({
  car: 0,
  truck: 0,
  bus: 0,
  motorcycle: 0,
  bicycle: 0,
});
function sideOf(distance: number): Side {
  return distance > DEADBAND + EPSILON
    ? 1
    : distance < -DEADBAND - EPSILON
      ? -1
      : 0;
}
function finitePoint(point: CountingLine["a"] | undefined): boolean {
  return (
    !!point &&
    Number.isFinite(point.x) &&
    Number.isFinite(point.y) &&
    point.x >= 0 &&
    point.x <= 1 &&
    point.y >= 0 &&
    point.y <= 1
  );
}
export class CrossingCounter {
  private line: CountingLine | null = null;
  private length = 0;
  private motion = new Map<number, Motion>();
  private counted = new Map<number, number | null>();
  private total = 0;
  private forward = 0;
  private reverse = 0;
  private classes = emptyClasses();
  private timestamp: number | null = null;
  private width: number | null = null;
  private height: number | null = null;
  constructor(line: CountingLine | null = null) {
    this.setLine(line);
  }
  setLine(line: CountingLine | null, preserveCounts = false): void {
    let length = 0;
    if (line !== null) {
      if (!finitePoint(line?.a) || !finitePoint(line?.b))
        throw new RangeError(
          "Counting line endpoints must be finite normalized coordinates between 0 and 1.",
        );
      length = Math.hypot(line.b.x - line.a.x, line.b.y - line.a.y);
      if (length + EPSILON < MINIMUM_LINE_LENGTH)
        throw new RangeError(
          "The counting line must be at least 0.05 of the normalized frame in length.",
        );
    }
    const unchanged =
      line === null
        ? this.line === null
        : this.line !== null &&
          line.a.x === this.line.a.x &&
          line.a.y === this.line.a.y &&
          line.b.x === this.line.b.x &&
          line.b.y === this.line.b.y;
    if (unchanged) return;
    this.line = line === null ? null : { a: { ...line.a }, b: { ...line.b } };
    this.length = length;
    if (preserveCounts) this.breakContinuity();
    else this.reset();
  }
  reset(): void {
    this.breakContinuity();
    this.counted.clear();
    this.total = 0;
    this.forward = 0;
    this.reverse = 0;
    this.classes = emptyClasses();
  }
  breakContinuity(): void {
    this.motion.clear();
    this.timestamp = null;
    this.width = null;
    this.height = null;
  }
  get snapshot(): CrossingCounts {
    return Object.freeze({
      total: this.total,
      forward: this.forward,
      reverse: this.reverse,
      classes: Object.freeze({ ...this.classes }),
    });
  }
  private signedDistance(point: Point): number {
    const line = this.line!;
    return (
      ((line.b.x - line.a.x) * (point.y - line.a.y) -
        (line.b.y - line.a.y) * (point.x - line.a.x)) /
      this.length
    );
  }
  private crossing(
    previous: Motion,
    point: Point,
    distance: number,
  ): {
    side: -1 | 1;
    finite: boolean;
  } | null {
    const before =
      Math.abs(previous.distance) <= EPSILON ? 0 : previous.distance;
    const after = Math.abs(distance) <= EPSILON ? 0 : distance;
    if ((before === 0 && after === 0) || before * after > 0) return null;
    let fraction: number;
    let side: -1 | 1;
    if (before === 0) {
      fraction = 0;
      side = after > 0 ? 1 : -1;
    } else if (after === 0) {
      fraction = 1;
      side = before < 0 ? 1 : -1;
    } else {
      fraction = before / (before - after);
      side = after > 0 ? 1 : -1;
    }
    const x = previous.point.x + (point.x - previous.point.x) * fraction;
    const y = previous.point.y + (point.y - previous.point.y) * fraction;
    const line = this.line!;
    const projection =
      ((x - line.a.x) * (line.b.x - line.a.x) +
        (y - line.a.y) * (line.b.y - line.a.y)) /
      (this.length * this.length);
    return {
      side,
      finite:
        Number.isFinite(fraction) &&
        Number.isFinite(projection) &&
        projection >= -EPSILON &&
        projection <= 1 + EPSILON,
    };
  }
  update(
    tracks: readonly Track[],
    width: number,
    height: number,
    timestampSeconds: number,
  ): CrossingCounts {
    if (
      !Number.isFinite(width) ||
      !Number.isFinite(height) ||
      width <= 0 ||
      height <= 0 ||
      !Number.isFinite(timestampSeconds) ||
      timestampSeconds < 0
    )
      return this.snapshot;
    if (
      (this.timestamp !== null && timestampSeconds < this.timestamp) ||
      (this.width !== null && (width !== this.width || height !== this.height))
    )
      this.reset();
    if (this.timestamp === timestampSeconds) return this.snapshot;
    this.timestamp = timestampSeconds;
    this.width = width;
    this.height = height;
    if (!this.line) return this.snapshot;
    for (const [id, state] of this.motion) {
      if (timestampSeconds - state.lastSeen > MAXIMUM_ABSENCE_SECONDS)
        this.motion.delete(id);
    }
    const seen = new Set<number>();
    for (const track of tracks) {
      if (!Number.isSafeInteger(track.id) || seen.has(track.id)) continue;
      seen.add(track.id);
      if (!VEHICLES.has(track.className)) {
        this.motion.delete(track.id);
        continue;
      }
      const [x, y, boxWidth, boxHeight] = track.bbox;
      const point = {
        x: (x + boxWidth / 2) / width,
        y: (y + boxHeight) / height,
      };
      if (
        !track.bbox.every(Number.isFinite) ||
        boxWidth <= 0 ||
        boxHeight <= 0 ||
        !Number.isFinite(point.x) ||
        !Number.isFinite(point.y)
      ) {
        this.motion.delete(track.id);
        continue;
      }
      const distance = this.signedDistance(point);
      if (!Number.isFinite(distance)) {
        this.motion.delete(track.id);
        continue;
      }
      const age =
        Number.isFinite(track.age) && track.age >= 0 ? track.age : null;
      let previous = this.motion.get(track.id);
      const countedAge = this.counted.get(track.id);
      if (
        age !== null &&
        ((previous?.lastAge !== null &&
          previous?.lastAge !== undefined &&
          age + EPSILON < previous.lastAge) ||
          (countedAge !== null &&
            countedAge !== undefined &&
            age + EPSILON < countedAge))
      ) {
        previous = undefined;
        this.motion.delete(track.id);
        this.counted.delete(track.id);
      }
      const side = sideOf(distance);
      if (!previous) {
        this.motion.set(track.id, {
          point,
          distance,
          side,
          pendingCrossing: false,
          lastSeen: timestampSeconds,
          lastAge: age,
        });
        if (this.counted.has(track.id) && age !== null)
          this.counted.set(track.id, age);
        continue;
      }
      if (previous.side === 0) {
        if (side !== 0) previous.side = side;
      } else {
        const crossing = this.crossing(previous, point, distance);
        if (crossing)
          previous.pendingCrossing =
            crossing.side !== previous.side && crossing.finite;
        if (side !== 0) {
          if (
            side !== previous.side &&
            previous.pendingCrossing &&
            !this.counted.has(track.id)
          ) {
            this.total++;
            if (side === 1) this.forward++;
            else this.reverse++;
            this.classes[track.className as CountedVehicleClass]++;
            this.counted.set(track.id, age);
          }
          previous.side = side;
          previous.pendingCrossing = false;
        }
      }
      previous.point = point;
      previous.distance = distance;
      previous.lastSeen = timestampSeconds;
      previous.lastAge = age;
      if (this.counted.has(track.id) && age !== null)
        this.counted.set(track.id, age);
    }
    return this.snapshot;
  }
}
