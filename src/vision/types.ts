export interface Point {
  x: number;
  y: number;
}
export interface Calibration {
  points: [Point, Point, Point, Point];
  widthMeters: number;
  lengthMeters: number;
}
export interface Detection {
  bbox: [number, number, number, number];
  className: string;
  score: number;
}
export interface SpeedSample {
  timeSeconds: number;
  imagePoint: Point;
}
export type SpeedMeasurementMethod =
  "ground-plane-median-v2" | "ground-plane-geometric-median-v3";
export interface SpeedMeasurement {
  method: SpeedMeasurementMethod;
  samples: SpeedSample[];
  velocityMps: Point;
  speedKmh: number;
  pairCount: number;
}
export interface Track extends Detection {
  id: number;
  speedKmh: number | null;
  speedMeasurement?: SpeedMeasurement | null;
  speedSampleCount?: number;
  speedSpanSeconds?: number;
  trail: Point[];
  age: number;
}
export const ROAD_CLASSES = [
  "person",
  "bicycle",
  "car",
  "motorcycle",
  "bus",
  "truck",
] as const;
