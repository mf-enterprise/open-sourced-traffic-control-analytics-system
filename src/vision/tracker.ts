import {
  createGroundProjection,
  intersectionOverUnion,
  pointInPolygon,
} from "./geometry";
import { ROAD_CLASSES } from "./types";
import { calculateSpeedMeasurement } from "./speedMeasurement";
import type {
  Calibration,
  Detection,
  Point,
  Track,
  SpeedMeasurement,
} from "./types";
type GroundSample = Point & {
  time: number;
};
interface InternalTrack extends Detection {
  id: number;
  born: number;
  lastSeen: number;
  velocity: Point;
  motionSamples: GroundSample[];
  trail: Point[];
  samples: (GroundSample & {
    imagePoint: Point;
  })[];
  speedKmh: number | null;
  speedMeasurement: SpeedMeasurement | null;
  votes: Map<string, number>;
  observations: number;
  highConfidenceObservations: number;
  confirmed: boolean;
}
export interface TrackerOptions {
  initiationConfidence?: number;
  associationConfidence?: number;
}
const KEEP_ALIVE_SECONDS = 2.5;
const TENTATIVE_KEEP_ALIVE_SECONDS = 0.65;
const TENTATIVE_MAX_SECONDS = 1.25;
const CONFIRMATION_SPAN_SECONDS = 0.2;
const MOTION_HISTORY_SECONDS = 0.8;
const HISTORY_SECONDS = 1.6;
const MIN_SPEED_SPAN_SECONDS = 0.5;
const UNMATCHED_COST = 0.92;
const IMPOSSIBLE_COST = 1e6;
const VEHICLE_CLASSES = new Set(["car", "truck", "bus"]);
function center(bbox: readonly number[]): Point {
  return { x: bbox[0] + bbox[2] / 2, y: bbox[1] + bbox[3] / 2 };
}
function assign(costs: number[][]): number[] {
  const rows = costs.length;
  if (!rows) return [];
  const columns = costs[0].length;
  const u = Array<number>(rows + 1).fill(0);
  const v = Array<number>(columns + 1).fill(0);
  const p = Array<number>(columns + 1).fill(0);
  const way = Array<number>(columns + 1).fill(0);
  for (let i = 1; i <= rows; i++) {
    p[0] = i;
    let column = 0;
    const minimum = Array<number>(columns + 1).fill(Infinity);
    const used = Array<boolean>(columns + 1).fill(false);
    do {
      used[column] = true;
      const row = p[column];
      let delta = Infinity;
      let next = 0;
      for (let j = 1; j <= columns; j++) {
        if (used[j]) continue;
        const reduced = costs[row - 1][j - 1] - u[row] - v[j];
        if (reduced < minimum[j]) {
          minimum[j] = reduced;
          way[j] = column;
        }
        if (minimum[j] < delta) {
          delta = minimum[j];
          next = j;
        }
      }
      for (let j = 0; j <= columns; j++) {
        if (used[j]) {
          u[p[j]] += delta;
          v[j] -= delta;
        } else minimum[j] -= delta;
      }
      column = next;
    } while (p[column] !== 0);
    do {
      const previous = way[column];
      p[column] = p[previous];
      column = previous;
    } while (column !== 0);
  }
  const assignments = Array<number>(rows).fill(-1);
  for (let column = 1; column <= columns; column++) {
    if (p[column] > 0) assignments[p[column] - 1] = column - 1;
  }
  return assignments;
}
function sanitize(
  detection: Detection,
  width: number,
  height: number,
): Detection | null {
  if (
    !ROAD_CLASSES.some((name) => name === detection.className) ||
    !Number.isFinite(detection.score) ||
    detection.score < 0 ||
    !Array.isArray(detection.bbox) ||
    detection.bbox.length !== 4 ||
    !detection.bbox.every(Number.isFinite)
  )
    return null;
  const [x, y, w, h] = detection.bbox;
  if (w <= 0 || h <= 0) return null;
  const left = Math.max(0, x);
  const top = Math.max(0, y);
  const right = Math.min(width, x + w);
  const bottom = Math.min(height, y + h);
  if (right - left < 2 || bottom - top < 2) return null;
  return {
    bbox: [left, top, right - left, bottom - top],
    className: detection.className,
    score: Math.min(1, detection.score),
  };
}
export class VehicleTracker {
  private tracks = new Map<number, InternalTrack>();
  private nextId = 1;
  private lastTimestamp: number | null = null;
  private frameWidth = 0;
  private frameHeight = 0;
  private calibration: Calibration | null = null;
  private project: ((point: Point) => Point | null) | null = null;
  private initiationConfidence: number;
  private associationConfidence: number;
  constructor(calibration: Calibration | null, options: TrackerOptions = {}) {
    this.initiationConfidence = this.confidence(
      options.initiationConfidence,
      0.55,
    );
    this.associationConfidence = Math.min(
      this.initiationConfidence,
      this.confidence(options.associationConfidence, 0.35),
    );
    this.setCalibration(calibration);
  }
  private confidence(value: number | undefined, fallback: number): number {
    return value !== undefined &&
      Number.isFinite(value) &&
      value > 0 &&
      value <= 1
      ? value
      : fallback;
  }
  setCalibration(calibration: Calibration | null): void {
    const projection = calibration ? createGroundProjection(calibration) : null;
    this.calibration =
      projection && calibration
        ? {
            points: calibration.points.map((point) => ({
              ...point,
            })) as Calibration["points"],
            widthMeters: calibration.widthMeters,
            lengthMeters: calibration.lengthMeters,
          }
        : null;
    this.project = projection;
    for (const track of this.tracks.values()) {
      track.samples = [];
      track.speedKmh = null;
      track.speedMeasurement = null;
    }
  }
  reset(): void {
    this.breakContinuity();
    this.nextId = 1;
  }
  breakContinuity(): void {
    this.tracks.clear();
    this.lastTimestamp = null;
    this.frameWidth = 0;
    this.frameHeight = 0;
  }
  update(
    detections: Detection[],
    timestampSeconds: number,
    width: number,
    height: number,
  ): Track[] {
    if (
      !Number.isFinite(timestampSeconds) ||
      timestampSeconds < 0 ||
      !Number.isFinite(width) ||
      !Number.isFinite(height) ||
      width <= 0 ||
      height <= 0
    )
      return [];
    if (
      (this.lastTimestamp !== null &&
        timestampSeconds < this.lastTimestamp - 1e-6) ||
      (this.frameWidth !== 0 &&
        (width !== this.frameWidth || height !== this.frameHeight))
    )
      this.reset();
    this.lastTimestamp = timestampSeconds;
    this.frameWidth = width;
    this.frameHeight = height;
    for (const [id, track] of this.tracks) {
      if (
        timestampSeconds - track.lastSeen >
          (track.confirmed
            ? KEEP_ALIVE_SECONDS
            : TENTATIVE_KEEP_ALIVE_SECONDS) ||
        (!track.confirmed &&
          timestampSeconds - track.born > TENTATIVE_MAX_SECONDS)
      )
        this.tracks.delete(id);
    }
    const observations = detections
      .map((d) => sanitize(d, width, height))
      .filter(
        (d): d is Detection =>
          d !== null && d.score >= this.associationConfidence,
      );
    const existing = [...this.tracks.values()];
    const diagonal = Math.hypot(width, height);
    const costs = existing.map((track) => [
      ...observations.map((d) =>
        this.matchCost(track, d, timestampSeconds, diagonal),
      ),
      ...existing.map(() => UNMATCHED_COST),
    ]);
    const assignments = assign(costs);
    const used = new Set<number>();
    const visible: InternalTrack[] = [];
    existing.forEach((track, index) => {
      const assigned = assignments[index];
      if (
        assigned < 0 ||
        assigned >= observations.length ||
        costs[index][assigned] >= UNMATCHED_COST
      )
        return;
      used.add(assigned);
      this.observe(
        track,
        observations[assigned],
        timestampSeconds,
        width,
        height,
      );
      visible.push(track);
    });
    observations.forEach((detection, index) => {
      if (used.has(index) || detection.score < this.initiationConfidence)
        return;
      const track: InternalTrack = {
        ...detection,
        id: this.nextId++,
        born: timestampSeconds,
        lastSeen: timestampSeconds,
        velocity: { x: 0, y: 0 },
        motionSamples: [],
        trail: [],
        samples: [],
        speedKmh: null,
        speedMeasurement: null,
        votes: new Map(),
        observations: 0,
        highConfidenceObservations: 0,
        confirmed: false,
      };
      this.observe(track, detection, timestampSeconds, width, height);
      this.tracks.set(track.id, track);
      visible.push(track);
    });
    return visible
      .filter((track) => track.confirmed)
      .sort((a, b) => a.id - b.id)
      .map((track) => ({
        id: track.id,
        bbox: [...track.bbox],
        className: track.className,
        score: track.score,
        speedKmh: track.speedKmh,
        speedMeasurement: track.speedMeasurement
          ? structuredClone(track.speedMeasurement)
          : null,
        age: Math.max(0, timestampSeconds - track.born),
        speedSampleCount: track.samples.length,
        speedSpanSeconds: track.samples.length
          ? track.samples[track.samples.length - 1].time - track.samples[0].time
          : 0,
        trail: track.trail.map((point) => ({ ...point })),
      }));
  }
  private matchCost(
    track: InternalTrack,
    detection: Detection,
    timestamp: number,
    diagonal: number,
  ): number {
    const sameClass = track.className === detection.className;
    if (
      !sameClass &&
      !(
        VEHICLE_CLASSES.has(track.className) &&
        VEHICLE_CLASSES.has(detection.className)
      )
    )
      return IMPOSSIBLE_COST;
    const elapsed = Math.max(0, timestamp - track.lastSeen);
    const predicted = [...track.bbox];
    predicted[0] += track.velocity.x * elapsed;
    predicted[1] += track.velocity.y * elapsed;
    const predictedCenter = center(predicted);
    const observedCenter = center(detection.bbox);
    const distance = Math.hypot(
      predictedCenter.x - observedCenter.x,
      predictedCenter.y - observedCenter.y,
    );
    const gate =
      Math.max(
        Math.hypot(track.bbox[2], track.bbox[3]) * 0.95,
        diagonal * 0.028,
      ) +
      elapsed * diagonal * 0.04;
    const areaRatio =
      (detection.bbox[2] * detection.bbox[3]) / (track.bbox[2] * track.bbox[3]);
    if (distance > gate || areaRatio < 0.2 || areaRatio > 5)
      return IMPOSSIBLE_COST;
    if (
      elapsed > 1 &&
      (distance > gate * 0.65 || areaRatio < 0.4 || areaRatio > 2.5)
    )
      return IMPOSSIBLE_COST;
    if (elapsed > 1 && this.contradictsPriorMotion(track, observedCenter))
      return IMPOSSIBLE_COST;
    const overlap = intersectionOverUnion(predicted, detection.bbox);
    const sizePenalty = Math.min(
      1,
      Math.abs(Math.log(areaRatio)) / Math.log(5),
    );
    return (
      0.46 * (1 - overlap) +
      (0.44 * distance) / gate +
      0.1 * sizePenalty +
      (sameClass ? 0 : 0.1)
    );
  }
  private contradictsPriorMotion(
    track: InternalTrack,
    candidate: Point,
  ): boolean {
    const history = track.motionSamples;
    if (history.length < 3) return false;
    const first = history[0],
      last = history[history.length - 1];
    if (last.time - first.time < 0.25) return false;
    const dx = last.x - first.x,
      dy = last.y - first.y;
    const displacement = Math.hypot(dx, dy);
    const boxDiagonal = Math.hypot(track.bbox[2], track.bbox[3]);
    if (displacement < Math.max(2, boxDiagonal * 0.2)) return false;
    let pathLength = 0;
    for (let index = 1; index < history.length; index++) {
      pathLength += Math.hypot(
        history[index].x - history[index - 1].x,
        history[index].y - history[index - 1].y,
      );
    }
    if (pathLength <= 0 || displacement / pathLength < 0.7) return false;
    const signedProgress =
      ((candidate.x - last.x) * dx + (candidate.y - last.y) * dy) /
      displacement;
    return signedProgress < -Math.max(2, boxDiagonal * 0.25);
  }
  private observe(
    track: InternalTrack,
    detection: Detection,
    timestamp: number,
    width: number,
    height: number,
  ): void {
    const elapsed = timestamp - track.lastSeen;
    if (track.observations === 0 || elapsed > 1e-5) {
      track.observations++;
      if (detection.score >= this.initiationConfidence)
        track.highConfidenceObservations++;
      if (
        track.observations >= 3 &&
        track.highConfidenceObservations >= 2 &&
        timestamp - track.born >= CONFIRMATION_SPAN_SECONDS - 1e-6
      )
        track.confirmed = true;
    }
    if (elapsed > 1e-5) {
      const before = center(track.bbox);
      const after = center(detection.bbox);
      const blend = track.trail.length < 2 ? 1 : 0.65;
      track.velocity.x =
        ((after.x - before.x) / elapsed) * blend +
        track.velocity.x * (1 - blend);
      track.velocity.y =
        ((after.y - before.y) / elapsed) * blend +
        track.velocity.y * (1 - blend);
    }
    for (const [name, vote] of track.votes) track.votes.set(name, vote * 0.88);
    track.votes.set(
      detection.className,
      (track.votes.get(detection.className) ?? 0) + detection.score,
    );
    let bestVote = -1;
    for (const [name, vote] of track.votes) {
      if (vote > bestVote) {
        bestVote = vote;
        track.className = name;
      }
    }
    track.bbox = [...detection.bbox];
    track.score = detection.score;
    track.lastSeen = timestamp;
    const lastMotion = track.motionSamples[track.motionSamples.length - 1];
    if (!lastMotion || timestamp > lastMotion.time + 1e-5) {
      track.motionSamples.push({ ...center(track.bbox), time: timestamp });
      track.motionSamples = track.motionSamples
        .filter((sample) => timestamp - sample.time <= MOTION_HISTORY_SECONDS)
        .slice(-24);
    }
    const contact = {
      x: (track.bbox[0] + track.bbox[2] / 2) / width,
      y: (track.bbox[1] + track.bbox[3]) / height,
    };
    const previousPoint = track.trail[track.trail.length - 1];
    if (
      !previousPoint ||
      Math.hypot(contact.x - previousPoint.x, contact.y - previousPoint.y) >
        0.001
    ) {
      track.trail.push(contact);
      if (track.trail.length > 40) track.trail.shift();
    }
    this.measureSpeed(track, contact, timestamp);
  }
  private measureSpeed(
    track: InternalTrack,
    contact: Point,
    timestamp: number,
  ): void {
    const ground =
      this.project &&
      this.calibration &&
      pointInPolygon(contact, this.calibration.points)
        ? this.project(contact)
        : null;
    if (!ground) {
      track.samples = [];
      track.speedKmh = null;
      track.speedMeasurement = null;
      return;
    }
    const previous = track.samples[track.samples.length - 1];
    if (previous && timestamp - previous.time < 1 / 30 - 1e-6) return;
    const maxSpeed =
      track.className === "person"
        ? 60
        : track.className === "bicycle"
          ? 130
          : 300;
    if (
      previous &&
      (timestamp - previous.time > 0.5 + 1e-6 ||
        Math.hypot(ground.x - previous.x, ground.y - previous.y) >
          (maxSpeed / 3.6) * (timestamp - previous.time) + 0.8)
    ) {
      track.samples = [];
      track.speedKmh = null;
      track.speedMeasurement = null;
    }
    track.samples.push({
      ...ground,
      time: timestamp,
      imagePoint: { ...contact },
    });
    track.samples = track.samples
      .filter((sample) => timestamp - sample.time <= HISTORY_SECONDS + 1e-6)
      .slice(-48);
    if (
      track.samples.length < 4 ||
      timestamp - track.samples[0].time < MIN_SPEED_SPAN_SECONDS - 1e-6
    ) {
      track.speedKmh = null;
      track.speedMeasurement = null;
      return;
    }
    const measurement = calculateSpeedMeasurement(
      track.samples.map(({ time, imagePoint }) => ({
        timeSeconds: time,
        imagePoint,
      })),
      this.calibration!,
    );
    track.speedMeasurement =
      measurement && measurement.speedKmh <= maxSpeed ? measurement : null;
    track.speedKmh = track.speedMeasurement?.speedKmh ?? null;
  }
}
