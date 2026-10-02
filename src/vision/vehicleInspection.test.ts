import { describe, expect, it } from "vitest";
import {
  createVehicleInspection,
  serializeVehicleInspection,
  vehicleInspectionCropBounds,
  type VehicleInspectionInput,
} from "./vehicleInspection";
function fixture(): VehicleInspectionInput {
  return {
    sourceName: "Triangle camera",
    sourceKind: "camera",
    sourceId: "source-session-a",
    frameId: 83,
    frameWidth: 1280,
    frameHeight: 720,
    sourceTimestamp: 12.25,
    captureTime: "2026-10-02T18:40:00.000Z",
    imageUrl: "data:image/jpeg;base64,/9j/",
    track: {
      id: 7,
      bbox: [100.25, 200.75, 89.5, 65.5],
      className: "car",
      score: 0.91,
      speedKmh: null,
      trail: [{ x: 0.1, y: 0.2 }],
      age: 1.2,
    },
  };
}
describe("frozen observational vehicle inspection", () => {
  it("works without speed or calibration and freezes only the selected track by value", () => {
    const input = fixture();
    const expected = structuredClone(input.track);
    const snapshot = createVehicleInspection({
      ...input,
      otherTracks: [{ id: 99 }],
    } as VehicleInspectionInput);
    input.track.bbox[0] = 600;
    input.track.trail[0].x = 0.9;
    input.track.className = "truck";
    input.track.score = 0.4;
    input.sourceName = "Changed source";
    expect(snapshot.track).toEqual({ ...expected, speedMeasurement: null });
    expect(snapshot.sourceName).toBe("Triangle camera");
    expect(snapshot).not.toHaveProperty("otherTracks");
    expect(snapshot).not.toHaveProperty("calibration");
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.track)).toBe(true);
    expect(Object.isFrozen(snapshot.track.bbox)).toBe(true);
    expect(Object.isFrozen(snapshot.track.trail)).toBe(true);
    expect(Object.isFrozen(snapshot.track.trail[0])).toBe(true);
  });
  it.each([
    "ground-plane-median-v2" as const,
    "ground-plane-geometric-median-v3" as const,
  ])("deep-copies %s without requiring or inventing a trace", (method) => {
    const input = fixture();
    input.track.speedKmh = 72;
    input.track.speedMeasurement = {
      method,
      samples: [0, 1, 2, 3].map((index) => ({
        timeSeconds: 11.05 + index * 0.4,
        imagePoint: { x: 0.5, y: 0.14 + index * 0.16 },
      })),
      velocityMps: { x: 0, y: 20 },
      speedKmh: 72,
      pairCount: 6,
    };
    const expected = structuredClone(input.track.speedMeasurement);
    const snapshot = createVehicleInspection(input);
    input.track.speedMeasurement.samples[0].imagePoint.x = 0.7;
    input.track.speedMeasurement.samples[0].timeSeconds = 500;
    input.track.speedMeasurement.velocityMps.y = 40;
    input.track.speedMeasurement.samples.length = 0;
    expect(snapshot.track.speedMeasurement).toEqual(expected);
    expect(Object.isFrozen(snapshot.track.speedMeasurement)).toBe(true);
    expect(Object.isFrozen(snapshot.track.speedMeasurement!.samples)).toBe(
      true,
    );
    expect(Object.isFrozen(snapshot.track.speedMeasurement!.samples[0])).toBe(
      true,
    );
    expect(
      Object.isFrozen(snapshot.track.speedMeasurement!.samples[0].imagePoint),
    ).toBe(true);
    expect(Object.isFrozen(snapshot.track.speedMeasurement!.velocityMps)).toBe(
      true,
    );
    const demo = createVehicleInspection({
      ...fixture(),
      sourceKind: "demo",
      track: { ...snapshot.track },
    });
    expect(demo.track.speedMeasurement).toBeNull();
    expect(demo.track.speedKmh).toBe(72);
  });
  it("clips partially visible bounds and crops native integer pixels without growing beyond the selected box", () => {
    const input = fixture();
    input.track.bbox = [-2.5, 699.2, 53.3, 80.1];
    const snapshot = createVehicleInspection(input);
    expect(snapshot.track.bbox[0]).toBe(0);
    expect(snapshot.track.bbox[1]).toBe(699.2);
    expect(snapshot.track.bbox[2]).toBeCloseTo(50.8);
    expect(snapshot.track.bbox[3]).toBeCloseTo(20.8);
    const crop = vehicleInspectionCropBounds(snapshot, 1280, 720);
    expect(crop).toEqual([0, 700, 50, 20]);
    expect(Object.isFrozen(crop)).toBe(true);
    expect(input.track.bbox).toEqual([-2.5, 699.2, 53.3, 80.1]);
    expect(
      vehicleInspectionCropBounds(
        createVehicleInspection(fixture()),
        1280,
        720,
      ),
    ).toEqual([101, 201, 88, 65]);
  });
  it("rejects wrong natural image dimensions rather than rescaling another frame to fit", () => {
    const snapshot = createVehicleInspection(fixture());
    for (const [width, height] of [
      [640, 360],
      [1280, 721],
      [720, 1280],
      [0, 0],
      [NaN, 720],
    ]) {
      expect(() =>
        vehicleInspectionCropBounds(snapshot, width, height),
      ).toThrow(/dimensions do not match/);
    }
  });
  it.each([
    { frameWidth: 0 },
    { frameHeight: 719.5 },
    { frameId: -1 },
    { frameId: NaN },
    { sourceTimestamp: -0.1 },
    { sourceTimestamp: Infinity },
    { captureTime: "not-a-date" },
    { sourceId: "" },
    { sourceName: " " },
    { imageUrl: "https://camera.example/live.jpg" },
    { imageUrl: "data:image/svg+xml;base64,PHN2Zz4=" },
  ])("rejects invalid or unfrozen frame metadata %j", (change) => {
    expect(() =>
      createVehicleInspection({ ...fixture(), ...change }),
    ).toThrow();
  });
  it.each([
    { bbox: [1281, 20, 30, 40] },
    { bbox: [0, 0, 0, 10] },
    { bbox: [0, NaN, 30, 40] },
    { score: 1.1 },
    { score: NaN },
    { id: 1.5 },
    { age: -1 },
    { speedKmh: -2 },
    { className: "unknown vehicle" },
    { trail: [{ x: 1.1, y: 0.5 }] },
  ])("rejects invalid selected-track geometry or metadata %j", (change) => {
    const input = fixture();
    expect(() =>
      createVehicleInspection({
        ...input,
        track: { ...input.track, ...change } as VehicleInspectionInput["track"],
      }),
    ).toThrow();
  });
  it("does not manufacture a larger crop from a subpixel vehicle", () => {
    const input = fixture();
    input.track.bbox = [0.2, 0.2, 0.5, 0.5];
    const snapshot = createVehicleInspection(input);
    expect(() => vehicleInspectionCropBounds(snapshot, 1280, 720)).toThrow(
      /too few original pixels/,
    );
  });
  it("exports a retained candidate as explicitly unverified without a case or pixels", () => {
    const inspection = createVehicleInspection(fixture());
    const candidate = {
      text: "AB12CDE",
      originalOcrScore: 91.5,
      verified: true,
      state: "approved",
    };
    const json = serializeVehicleInspection(inspection, candidate);
    candidate.text = "DIFFERENT";
    const output = JSON.parse(json);
    expect(output.kind).toBe("vehicle-observation");
    expect(output.ticketCreated).toBe(false);
    expect(output.simulation).toBe(false);
    expect(output.registration).toEqual({
      text: "AB12CDE",
      originalOcrScore: 91.5,
      textMayBeOperatorEdited: true,
      verification: "unverified",
    });
    expect(output.track.id).toBe(7);
    expect(output).not.toHaveProperty("imageUrl");
    expect(output).not.toHaveProperty("state");
    expect(
      JSON.parse(serializeVehicleInspection(inspection)).registration,
    ).toBeNull();
    expect(
      JSON.parse(
        serializeVehicleInspection(
          createVehicleInspection({ ...fixture(), sourceKind: "demo" }),
          candidate,
        ),
      ).registration,
    ).toBeNull();
    expect(() =>
      serializeVehicleInspection(inspection, {
        text: "<script>",
        originalOcrScore: 90,
      }),
    ).toThrow();
    expect(() =>
      serializeVehicleInspection(inspection, {
        text: "AB12CDE",
        originalOcrScore: NaN,
      }),
    ).toThrow();
  });
});
