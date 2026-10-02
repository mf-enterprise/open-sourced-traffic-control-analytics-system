import { describe, expect, it } from "vitest";
import type { SpeedMeasurement } from "../vision/types";
import {
  mergeCases,
  permanentFailure,
  retryDelay,
  serializeCapturePayload,
  type StoredCase,
} from "./queue";
const record = (
  id: string,
  state: StoredCase["state"],
  updatedAt: string,
): StoredCase => ({
  id,
  clientEventId: id,
  trackId: 1,
  sourceName: "Camera",
  sourceKind: "camera",
  className: "car",
  speedKmh: 60,
  speedLimit: 50,
  confidence: 0.9,
  captureTime: "2026-10-02T12:00:00Z",
  sourceTimestamp: 3,
  calibration: null,
  evidenceUrl: `/api/cases/${id}/evidence`,
  evidenceSha256: "hash",
  evidenceBytes: 100,
  simulation: false,
  state,
  plate: "",
  notes: "",
  reviewer: "",
  createdAt: "2026-10-02T12:00:00Z",
  updatedAt,
});
describe("durable case coordination", () => {
  it("round-trips the complete calculation trace independently of later caller mutations", () => {
    const speedMeasurement: SpeedMeasurement = {
      method: "ground-plane-median-v2",
      samples: [
        { timeSeconds: 1.8, imagePoint: { x: 0.4, y: 0.1 } },
        { timeSeconds: 2.2, imagePoint: { x: 0.4, y: 0.3 } },
        { timeSeconds: 2.6, imagePoint: { x: 0.4, y: 0.5 } },
        { timeSeconds: 3, imagePoint: { x: 0.4, y: 0.7 } },
      ],
      velocityMps: { x: 0, y: 60 / 3.6 },
      speedKmh: 60,
      pairCount: 6,
    };
    const expected = JSON.parse(JSON.stringify(speedMeasurement));
    const payload = {
      ...record("event-trace", "draft", "2026-10-02T12:00:00Z"),
      evidence: "data:image/jpeg;base64,frame",
      speedMeasurement,
    };
    const queued = serializeCapturePayload(payload);
    speedMeasurement.samples[0].imagePoint.x = 0.9;
    speedMeasurement.samples[0].timeSeconds = 40;
    speedMeasurement.samples.length = 0;
    speedMeasurement.velocityMps.y = 80;
    speedMeasurement.speedKmh = 288;
    const restored = JSON.parse(queued);
    expect(restored.speedMeasurement).toEqual(expected);
    expect(restored.speedMeasurement.speedKmh).toBe(restored.speedKmh);
    expect(restored.sourceTimestamp).toBe(3);
    const { speedMeasurement: _trace, ...legacy } = payload;
    expect(
      JSON.parse(serializeCapturePayload(legacy)).speedMeasurement,
    ).toBeUndefined();
    expect(
      JSON.parse(serializeCapturePayload({ ...legacy, speedMeasurement: null }))
        .speedMeasurement,
    ).toBeNull();
  });
  it("preserves captured bounds by value in the queued JSON and accepts old payloads", () => {
    const vehicleBox: [number, number, number, number] = [10, 20, 100, 50];
    const payload = {
      ...record("event-1", "draft", "2026-10-02T12:00:00Z"),
      evidence: "data:image/jpeg;base64,frame",
      vehicleBox,
    };
    const json = serializeCapturePayload(payload);
    vehicleBox[0] = 500;
    payload.sourceName = "Another camera";
    expect(JSON.parse(json).vehicleBox).toEqual([10, 20, 100, 50]);
    expect(JSON.parse(json).sourceName).toBe("Camera");
    const { vehicleBox: _box, ...legacy } = payload;
    expect(
      JSON.parse(serializeCapturePayload(legacy)).vehicleBox,
    ).toBeUndefined();
    expect(
      JSON.parse(serializeCapturePayload({ ...legacy, vehicleBox: null }))
        .vehicleBox,
    ).toBeNull();
  });
  it("backs off transient retries to one minute and stops permanent invalid requests", () => {
    expect([1, 2, 3, 7, 20].map(retryDelay)).toEqual([
      1000, 2000, 4000, 60000, 60000,
    ]);
    expect(permanentFailure(400)).toBe(true);
    expect(permanentFailure(409)).toBe(true);
    expect(permanentFailure(413)).toBe(true);
    expect(permanentFailure(429)).toBe(false);
    expect(permanentFailure(503)).toBe(false);
    expect(permanentFailure(0)).toBe(false);
  });
  it("does not let a late list response reverse a review or hide an acknowledged case", () => {
    const approved = record(
      "VEL-2026-000001",
      "approved",
      "2026-10-02T12:01:00Z",
    );
    const newCase = record("VEL-2026-000002", "draft", "2026-10-02T12:02:00Z");
    const stale = record(approved.id, "draft", "2026-10-02T12:00:00Z");
    const merged = mergeCases([approved, newCase], [stale]);
    expect(merged).toHaveLength(2);
    expect(merged.find((item) => item.id === approved.id)?.state).toBe(
      "approved",
    );
    expect(
      mergeCases([approved], [{ ...stale, updatedAt: approved.updatedAt }])[0]
        .state,
    ).toBe("approved");
  });
});
