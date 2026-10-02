import { describe, expect, it } from "vitest";
import { createCaptureSnapshot, MOTOR_VEHICLE_CLASSES } from "../useTraffic";
import type { Calibration, SpeedMeasurement, Track } from "./types";
import { calculateSpeedMeasurement } from "./speedMeasurement";
const measurement = (): SpeedMeasurement => ({
  method: "ground-plane-median-v2",
  samples: [
    { timeSeconds: 11.05, imagePoint: { x: 0.5, y: 0.14 } },
    { timeSeconds: 11.45, imagePoint: { x: 0.5, y: 0.3 } },
    { timeSeconds: 11.85, imagePoint: { x: 0.5, y: 0.46 } },
    { timeSeconds: 12.25, imagePoint: { x: 0.5, y: 0.62 } },
  ],
  velocityMps: { x: 0, y: 20 },
  speedKmh: 72,
  pairCount: 6,
});
describe("capture provenance", () => {
  it("retains exact frame metadata even when later observations and settings change", () => {
    const calibration: Calibration = {
      points: [
        { x: 0.1, y: 0.1 },
        { x: 0.9, y: 0.1 },
        { x: 0.9, y: 0.9 },
        { x: 0.1, y: 0.9 },
      ],
      widthMeters: 10,
      lengthMeters: 40,
    };
    const track: Track = {
      id: 3,
      className: "car",
      bbox: [10, 20, 100, 50],
      score: 0.87,
      speedKmh: 72,
      speedMeasurement: measurement(),
      age: 2,
      trail: [],
    };
    const sample = {
      time: 12.25,
      captureTime: "2026-10-02T15:00:00.000Z",
      limit: 60,
      calibration,
      source: "camera" as const,
      sourceName: "Road camera",
      frameWidth: 3840,
      frameHeight: 2160,
    };
    const capture = createCaptureSnapshot(
      track,
      sample,
      "session:3",
      "data:image/jpeg;base64,frame",
    );
    const originalMeasurement = measurement();
    track.speedMeasurement!.samples[0].imagePoint.y = 0.9;
    track.speedMeasurement!.samples[0].timeSeconds = 18;
    track.speedMeasurement!.samples.push({
      timeSeconds: 18.5,
      imagePoint: { x: 0.3, y: 0.95 },
    });
    track.speedMeasurement!.velocityMps.y = 30;
    track.speedMeasurement!.pairCount = 10;
    track.speedMeasurement!.speedKmh = 108;
    track.score = 0.5;
    track.speedKmh = 90;
    track.className = "truck";
    track.bbox[0] = 200;
    sample.time = 18;
    sample.limit = 30;
    sample.sourceName = "New camera";
    sample.frameWidth = 640;
    calibration.widthMeters = 20;
    calibration.points[0].x = 0.3;
    expect(capture).toMatchObject({
      sourceTimestamp: 12.25,
      confidence: 0.87,
      speedKmh: 72,
      speedLimit: 60,
      sourceName: "Road camera",
      className: "car",
      clientEventId: "session:3",
      trackId: 3,
      vehicleBox: [5, 10, 50, 25],
    });
    expect(capture.calibration!.widthMeters).toBe(10);
    expect(capture.calibration!.points[0].x).toBe(0.1);
    expect(Object.isFrozen(capture)).toBe(true);
    expect(Object.isFrozen(capture.calibration)).toBe(true);
    expect(Object.isFrozen(capture.calibration!.points[0])).toBe(true);
    expect(Object.isFrozen(capture.vehicleBox)).toBe(true);
    expect(capture.speedMeasurement).toEqual(originalMeasurement);
    expect(capture.speedMeasurement).not.toBe(track.speedMeasurement);
    expect(Object.isFrozen(capture.speedMeasurement)).toBe(true);
    expect(Object.isFrozen(capture.speedMeasurement!.samples)).toBe(true);
    expect(Object.isFrozen(capture.speedMeasurement!.samples[0])).toBe(true);
    expect(
      Object.isFrozen(capture.speedMeasurement!.samples[0].imagePoint),
    ).toBe(true);
    expect(Object.isFrozen(capture.speedMeasurement!.velocityMps)).toBe(true);
    const replay = calculateSpeedMeasurement(
      capture.speedMeasurement!.samples,
      capture.calibration!,
      capture.speedMeasurement!.method,
    );
    expect(replay?.speedKmh).toBeCloseTo(capture.speedKmh, 10);
    expect(replay?.pairCount).toBe(capture.speedMeasurement!.pairCount);
  });
  it("keeps demo and legacy speeds separate from real calculation traces", () => {
    const sample = {
      time: 12.25,
      captureTime: "2026-10-02T15:00:00.000Z",
      limit: 60,
      calibration: null,
      source: "demo" as const,
      sourceName: "Demo",
    };
    const track: Track = {
      id: 1,
      className: "car",
      bbox: [0, 0, 10, 10],
      score: 1,
      speedKmh: 72,
      speedMeasurement: measurement(),
      age: 1,
      trail: [],
    };
    expect(
      createCaptureSnapshot(track, sample, "demo", "frame").speedMeasurement,
    ).toBeNull();
    delete track.speedMeasurement;
    expect(
      createCaptureSnapshot(
        track,
        { ...sample, source: "camera" },
        "legacy",
        "frame",
      ).speedMeasurement,
    ).toBeNull();
  });
  it("clips vehicle bounds to the image and uses each rounded JPEG axis without including the footer", () => {
    const sample = {
      time: 0,
      captureTime: "2026-10-02T15:00:00.000Z",
      limit: 60,
      calibration: null,
      source: "demo" as const,
      sourceName: "Demo",
      frameWidth: 4000,
      frameHeight: 2001,
    };
    const track: Track = {
      id: 1,
      className: "car",
      bbox: [-10, 1951, 4010, 100],
      score: 1,
      speedKmh: 70,
      age: 1,
      trail: [],
    };
    const box = createCaptureSnapshot(track, sample, "id", "frame").vehicleBox!;
    expect(box[0]).toBe(0);
    expect(box[2]).toBe(1920);
    expect(box[1]).toBeCloseTo((1951 / 2001) * 960, 10);
    expect(box[1] + box[3]).toBeCloseTo(960, 10);
    expect(() =>
      createCaptureSnapshot(
        { ...track, bbox: [4001, 0, 10, 10] },
        sample,
        "id",
        "frame",
      ),
    ).toThrow(/intersect/);
    expect(() =>
      createCaptureSnapshot(
        { ...track, bbox: [0, 0, NaN, 10] },
        sample,
        "id",
        "frame",
      ),
    ).toThrow(/bounds/);
    expect(() =>
      createCaptureSnapshot(
        track,
        { ...sample, frameHeight: undefined },
        "id",
        "frame",
      ),
    ).toThrow(/dimensions/);
    const {
      frameWidth: _width,
      frameHeight: _height,
      ...legacySample
    } = sample;
    expect(
      createCaptureSnapshot(track, legacySample, "old", "frame").vehicleBox,
    ).toBeNull();
  });
  it("rejects absent or invalid measured speed", () => {
    const sample = {
      time: 0,
      captureTime: "",
      limit: 60,
      calibration: null,
      source: "demo" as const,
      sourceName: "Demo",
    };
    const track: Track = {
      id: 1,
      className: "car",
      bbox: [0, 0, 10, 10],
      score: 1,
      speedKmh: null,
      age: 1,
      trail: [],
    };
    expect(() => createCaptureSnapshot(track, sample, "id", "frame")).toThrow();
    expect(() =>
      createCaptureSnapshot({ ...track, speedKmh: NaN }, sample, "id", "frame"),
    ).toThrow();
  });
  it("restricts speed violation capture eligibility to motor vehicles", () => {
    expect(
      ["car", "truck", "bus", "motorcycle"].every((name) =>
        MOTOR_VEHICLE_CLASSES.has(name),
      ),
    ).toBe(true);
    expect(MOTOR_VEHICLE_CLASSES.has("person")).toBe(false);
    expect(MOTOR_VEHICLE_CLASSES.has("bicycle")).toBe(false);
  });
});
