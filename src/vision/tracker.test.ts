import { describe, expect, it } from "vitest";
import { VehicleTracker } from "./tracker";
import { calculateSpeedMeasurement } from "./speedMeasurement";
import type { Calibration, Detection, Track } from "./types";
const calibration: Calibration = {
  points: [
    { x: 0, y: 0 },
    { x: 1, y: 0 },
    { x: 1, y: 1 },
    { x: 0, y: 1 },
  ],
  widthMeters: 20,
  lengthMeters: 100,
};
const width = 1000;
const height = 1000;
const detection = (
  x: number,
  contactY: number,
  className = "car",
): Detection => ({
  bbox: [x - 40, contactY - 50, 80, 50],
  className,
  score: 0.91,
});
function runStraight(
  tracker: VehicleTracker,
  speedMetersPerSecond = 10,
  start = 0,
): Track {
  let track: Track | undefined;
  for (let i = 0; i <= 12; i++) {
    const t = i * 0.1;
    track = tracker.update(
      [detection(400, 200 + speedMetersPerSecond * t * 10)],
      start + t,
      width,
      height,
    )[0];
  }
  return track!;
}
function confirm(
  tracker: VehicleTracker,
  detections: Detection[],
  start = 0,
  w = width,
  h = height,
): Track[] {
  tracker.update(detections, start, w, h);
  tracker.update(detections, start + 0.1, w, h);
  return tracker.update(detections, start + 0.2, w, h);
}
describe("class voting", () => {
  it.each([
    { first: "bus", consensus: "car" },
    { first: "car", consensus: "bus" },
  ])(
    "counts the first $first observation once when later frames agree on $consensus",
    ({ first, consensus }) => {
      const tracker = new VehicleTracker(null);
      expect(
        tracker.update(
          [{ ...detection(200, 300, first), score: 0.8 }],
          0,
          width,
          height,
        ),
      ).toEqual([]);
      expect(
        tracker.update(
          [{ ...detection(200, 300, consensus), score: 0.56 }],
          0.11,
          width,
          height,
        ),
      ).toEqual([]);
      const tracks = tracker.update(
        [{ ...detection(200, 300, consensus), score: 0.56 }],
        0.22,
        width,
        height,
      );
      expect(tracks).toHaveLength(1);
      expect(tracks[0].id).toBe(1);
      expect(tracks[0].className).toBe(consensus);
      expect(tracks[0].score).toBe(0.56);
    },
  );
  it("still confirms a genuine bus and tolerates one later car classification", () => {
    const tracker = new VehicleTracker(null);
    const confirmed = confirm(tracker, [
      { ...detection(200, 300, "bus"), score: 0.7 },
    ]);
    expect(confirmed[0].className).toBe("bus");
    const momentaryError = tracker.update(
      [{ ...detection(200, 300, "car"), score: 0.7 }],
      0.3,
      width,
      height,
    );
    expect(momentaryError[0].id).toBe(confirmed[0].id);
    expect(momentaryError[0].className).toBe("bus");
  });
});
describe("calibrated speed", () => {
  it("keeps rolling-window membership and estimates stable across clock origins", () => {
    const results = [0, 10, 100000].map((offset) => {
      const tracker = new VehicleTracker(calibration);
      let current: Track | undefined;
      for (let i = 0; i <= 22; i++) {
        const t = i / 10;
        current = tracker.update(
          [detection(400, 200 + 10 * t * t)],
          t + offset,
          width,
          height,
        )[0];
      }
      return current!;
    });
    for (const result of results) {
      expect(result.speedSampleCount).toBe(17);
      expect(result.speedSpanSeconds).toBeCloseTo(1.6, 8);
      expect(result.speedMeasurement!.pairCount).toBe(
        results[0].speedMeasurement!.pairCount,
      );
      expect(result.speedKmh).toBeCloseTo(results[0].speedKmh!, 7);
    }
  });
  it("recovers identity after a gap but waits for fresh speed observations", () => {
    const tracker = new VehicleTracker(calibration);
    const before = runStraight(tracker);
    const recovered = tracker.update(
      [detection(400, 320)],
      1.8,
      width,
      height,
    )[0];
    expect(recovered.id).toBe(before.id);
    expect(recovered.speedKmh).toBeNull();
    expect(recovered.speedMeasurement).toBeNull();
    expect(recovered.speedSampleCount).toBe(1);
    let current = recovered;
    for (let i = 19; i <= 22; i++) {
      current = tracker.update([detection(400, 320)], i / 10, width, height)[0];
      expect(current.speedKmh).toBeNull();
    }
    current = tracker.update([detection(400, 320)], 2.3, width, height)[0];
    expect(current.id).toBe(before.id);
    expect(current.speedKmh).toBe(0);
    expect(current.speedMeasurement!.samples[0].timeSeconds).toBe(1.8);
  });
  it("returns an independently replayable trace and isolates it from later caller mutation", () => {
    const tracker = new VehicleTracker(calibration);
    const track = runStraight(tracker);
    expect(track.speedMeasurement).not.toBeNull();
    expect(
      calculateSpeedMeasurement(track.speedMeasurement!.samples, calibration),
    ).toEqual(track.speedMeasurement);
    expect(track.speedMeasurement!.speedKmh).toBe(track.speedKmh);
    track.speedMeasurement!.samples[0].imagePoint.y = 0.99;
    const next = tracker.update([detection(400, 330)], 1.3, width, height)[0];
    expect(next.speedKmh).toBeCloseTo(36, 5);
    expect(next.speedMeasurement!.samples[0].imagePoint.y).toBeCloseTo(0.2);
    tracker.setCalibration(null);
    const cleared = tracker.update(
      [detection(400, 340)],
      1.4,
      width,
      height,
    )[0];
    expect(cleared.speedKmh).toBeNull();
    expect(cleared.speedMeasurement).toBeNull();
  });
  it("does not carry a hidden smoothing tail after all moving samples expire", () => {
    const tracker = new VehicleTracker(calibration);
    runStraight(tracker);
    let last: Track | undefined;
    for (let i = 13; i <= 30; i++)
      last = tracker.update([detection(400, 320)], i / 10, width, height)[0];
    expect(last!.speedKmh).toBe(0);
    expect(
      last!.speedMeasurement!.samples.every((s) => s.imagePoint.y === 0.32),
    ).toBe(true);
    expect(
      calculateSpeedMeasurement(last!.speedMeasurement!.samples, calibration)!
        .speedKmh,
    ).toBe(0);
  });
  it("measures a known 36 km/h trajectory using media timestamps", () => {
    const track = runStraight(new VehicleTracker(calibration));
    expect(track.id).toBe(1);
    expect(track.speedKmh).toBeCloseTo(36, 5);
    expect(track.age).toBeCloseTo(1.2);
    expect(track.speedSampleCount).toBe(13);
    expect(track.speedSpanSeconds).toBeCloseTo(1.2);
  });
  it("requires at least 0.5 seconds of observations", () => {
    const tracker = new VehicleTracker(calibration);
    for (let i = 0; i < 5; i++) {
      expect(
        tracker.update(
          [detection(400, 200 + i * 10)],
          i * 0.1,
          width,
          height,
        )[0]?.speedKmh ?? null,
      ).toBeNull();
    }
    expect(
      tracker.update([detection(400, 250)], 0.5, width, height)[0].speedKmh,
    ).toBeCloseTo(36);
  });
  it("uses irregular frame intervals without assuming a frame rate", () => {
    const tracker = new VehicleTracker(calibration);
    let result: Track[] = [];
    for (const t of [0, 0.07, 0.19, 0.36, 0.55, 0.81, 1.14]) {
      result = tracker.update(
        [detection(400, 200 + t * 100)],
        t,
        width,
        height,
      );
    }
    expect(result[0].id).toBe(1);
    expect(result[0].speedKmh).toBeCloseTo(36, 4);
  });
  it("retains enough media-time history when inference is exceptionally fast", () => {
    const tracker = new VehicleTracker(calibration);
    let result: Track[] = [];
    for (let frame = 0; frame <= 240; frame++) {
      const time = frame / 240;
      result = tracker.update(
        [detection(400, 200 + time * 100)],
        time,
        width,
        height,
      );
    }
    expect(result[0].speedKmh).toBeCloseTo(36, 4);
    expect(result[0].speedSpanSeconds).toBeCloseTo(1, 4);
    expect(result[0].speedSampleCount).toBeLessThanOrEqual(32);
  });
  it("reports null without valid calibration and never exposes speed outside the polygon", () => {
    expect(runStraight(new VehicleTracker(null)).speedKmh).toBeNull();
    expect(
      runStraight(new VehicleTracker({ ...calibration, widthMeters: -2 }))
        .speedKmh,
    ).toBeNull();
    const tracker = new VehicleTracker({
      ...calibration,
      points: [
        { x: 0.2, y: 0.2 },
        { x: 0.8, y: 0.2 },
        { x: 0.8, y: 0.6 },
        { x: 0.2, y: 0.6 },
      ],
    });
    for (let i = 0; i <= 8; i++)
      tracker.update([detection(400, 450 + i * 10)], i * 0.1, width, height);
    const result = tracker.update([detection(400, 610)], 1, width, height)[0];
    expect(result.speedKmh).toBeNull();
    expect(result.speedSampleCount).toBe(0);
  });
  it("discards old samples when calibration changes while retaining identity", () => {
    const tracker = new VehicleTracker(calibration);
    expect(runStraight(tracker).speedKmh).toBeCloseTo(36);
    tracker.setCalibration({ ...calibration, lengthMeters: 50 });
    const first = tracker.update([detection(400, 330)], 1.3, width, height)[0];
    expect(first.id).toBe(1);
    expect(first.speedKmh).toBeNull();
    const track = runStraight(
      new VehicleTracker({ ...calibration, lengthMeters: 50 }),
    );
    expect(track.speedKmh).toBeCloseTo(18);
  });
  it("rejects a physically impossible calibration-induced jump rather than clamping speed", () => {
    const tracker = new VehicleTracker({ ...calibration, lengthMeters: 10000 });
    expect(runStraight(tracker).speedKmh).toBeNull();
  });
  it("resists one jittery bounding box in an otherwise stationary sequence", () => {
    const tracker = new VehicleTracker(calibration);
    let last: Track | undefined;
    for (let i = 0; i <= 12; i++) {
      last = tracker.update(
        [detection(400, i === 8 ? 215 : 200)],
        i * 0.1,
        width,
        height,
      )[0];
    }
    expect(last!.speedKmh).toBeCloseTo(0, 4);
  });
});
describe("identity tracking", () => {
  it("breaks confirmed and tentative continuity while preserving IDs and calibration", () => {
    const tracker = new VehicleTracker(calibration);
    expect(runStraight(tracker, 10, 10).speedKmh).toBeCloseTo(36);
    expect(tracker.update([detection(800, 600)], 11.3, width, height)).toEqual(
      [],
    );
    tracker.breakContinuity();
    let tracks: Track[] = [];
    for (let frame = 0; frame <= 5; frame++) {
      tracks = tracker.update(
        [detection(200, 100 + frame * 5)],
        frame / 10,
        500,
        500,
      );
      if (frame < 2) expect(tracks).toEqual([]);
      if (frame === 2) {
        expect(tracks[0].id).toBe(3);
        expect(tracks[0].age).toBeCloseTo(0.2);
        expect(tracks[0].speedSampleCount).toBe(3);
        expect(tracks[0].speedKmh).toBeNull();
      }
    }
    expect(tracks[0].id).toBe(3);
    expect(tracks[0].speedKmh).toBeCloseTo(36);
  });
  const smallBox = (x: number, y: number): Detection => ({
    className: "car",
    score: 0.9,
    bbox: [x - 12, y - 10, 24, 20],
  });
  function movingTrack() {
    const tracker = new VehicleTracker(null);
    for (let frame = 0; frame <= 8; frame++)
      tracker.update(
        [smallBox(400, 500 - frame * 2)],
        frame / 10,
        width,
        height,
      );
    return tracker;
  }
  it("recovers the same moving vehicle after a long gap in its established direction", () => {
    const tracker = movingTrack();
    const recovered = tracker.update([smallBox(400, 454)], 2.3, width, height);
    expect(recovered).toHaveLength(1);
    expect(recovered[0].id).toBe(1);
  });
  it("does not force a new identity when a vehicle stops during an occlusion", () => {
    const tracker = movingTrack();
    const recovered = tracker.update([smallBox(400, 484)], 2.3, width, height);
    expect(recovered[0].id).toBe(1);
  });
  it("gives an opposite-direction arrival a new identity after the original vehicle disappears", () => {
    const tracker = movingTrack();
    expect(tracker.update([smallBox(410, 510)], 2.3, width, height)).toEqual(
      [],
    );
    expect(tracker.update([smallBox(410, 513)], 2.4, width, height)).toEqual(
      [],
    );
    const incoming = tracker.update([smallBox(410, 516)], 2.5, width, height);
    expect(incoming).toHaveLength(1);
    expect(incoming[0].id).toBe(2);
    expect(incoming[0].age).toBeCloseTo(0.2);
  });
  it("does not interpret stationary bounding-box jitter as a reliable heading", () => {
    const tracker = new VehicleTracker(null);
    for (let frame = 0; frame <= 8; frame++)
      tracker.update(
        [smallBox(400 + (frame % 2 ? 1 : -1), 500 + (frame % 2 ? 2 : -2))],
        frame / 10,
        width,
        height,
      );
    expect(tracker.update([smallBox(402, 501)], 2.3, width, height)[0].id).toBe(
      1,
    );
  });
  it("keeps an established identity when recent motion history is insufficient", () => {
    const tracker = new VehicleTracker(null);
    confirm(tracker, [smallBox(400, 500)]);
    expect(tracker.update([smallBox(400, 500)], 1.3, width, height)[0].id).toBe(
      1,
    );
    expect(tracker.update([smallBox(400, 496)], 1.4, width, height)[0].id).toBe(
      1,
    );
    expect(tracker.update([smallBox(400, 505)], 2.6, width, height)[0].id).toBe(
      1,
    );
  });
  it("retains identity across a missed frame and expires long absences", () => {
    const tracker = new VehicleTracker(null);
    expect(confirm(tracker, [detection(200, 300)])[0].id).toBe(1);
    tracker.update([detection(210, 300)], 0.3, width, height);
    expect(tracker.update([], 0.4, width, height)).toEqual([]);
    expect(
      tracker.update([detection(230, 300)], 0.5, width, height)[0].id,
    ).toBe(1);
    expect(confirm(tracker, [detection(230, 300)], 3.1)[0].id).toBe(2);
  });
  it("matches one-to-one even when observations arrive in a different order", () => {
    const tracker = new VehicleTracker(null);
    confirm(tracker, [detection(200, 300), detection(500, 300)]);
    const next = tracker.update(
      [detection(490, 300), detection(210, 300)],
      0.3,
      width,
      height,
    );
    expect(next).toHaveLength(2);
    expect(next[0].id).toBe(1);
    expect(next[0].bbox[0]).toBe(170);
    expect(next[1].id).toBe(2);
    expect(next[1].bbox[0]).toBe(450);
    const single = tracker.update([detection(220, 300)], 0.4, width, height);
    expect(single).toHaveLength(1);
    expect(single[0].id).toBe(1);
  });
  it("uses motion to preserve identities as same-class objects cross", () => {
    const tracker = new VehicleTracker(null);
    let tracks: Track[] = [];
    for (let i = 0; i <= 12; i++) {
      const detections = [
        detection(200 + i * 20, 300),
        detection(460 - i * 20, 310),
      ];
      tracks = tracker.update(
        i % 2 ? detections.reverse() : detections,
        i * 0.1,
        width,
        height,
      );
    }
    expect(tracks).toHaveLength(2);
    expect(tracks[0].id).toBe(1);
    expect(tracks[0].bbox[0]).toBe(400);
    expect(tracks[1].id).toBe(2);
    expect(tracks[1].bbox[0]).toBe(180);
  });
  it("does not match pedestrians to cars but tolerates a truck/car model-label flicker", () => {
    const tracker = new VehicleTracker(null);
    confirm(tracker, [detection(200, 300)]);
    const truck = tracker.update(
      [detection(210, 300, "truck")],
      0.3,
      width,
      height,
    )[0];
    expect(truck.id).toBe(1);
    expect(truck.className).toBe("car");
    expect(confirm(tracker, [detection(210, 300, "person")], 0.4)[0].id).toBe(
      2,
    );
  });
  it("resets identities and measurement history on seeking backwards or resetting", () => {
    const tracker = new VehicleTracker(calibration);
    runStraight(tracker, 10, 10);
    expect(tracker.update([detection(400, 200)], 0, width, height)).toEqual([]);
    const afterSeek = confirm(tracker, [detection(400, 200)])[0];
    expect(afterSeek.id).toBe(1);
    expect(afterSeek.age).toBeCloseTo(0.2);
    expect(afterSeek.speedKmh).toBeNull();
    tracker.reset();
    expect(confirm(tracker, [detection(400, 200)], 50)[0].id).toBe(1);
  });
  it("resets on source resolution changes and ignores malformed input", () => {
    const tracker = new VehicleTracker(calibration);
    runStraight(tracker);
    const changed = confirm(tracker, [detection(400, 200)], 2, 1920, 1080)[0];
    expect(changed.age).toBeCloseTo(0.2);
    expect(changed.speedKmh).toBeNull();
    expect(tracker.update([detection(400, 200)], NaN, width, height)).toEqual(
      [],
    );
    expect(
      tracker.update(
        [{ ...detection(400, 200), bbox: [NaN, 0, 50, 50] }],
        3,
        width,
        height,
      ),
    ).toEqual([]);
    expect(
      tracker.update([detection(400, 200, "chair")], 4, width, height),
    ).toEqual([]);
  });
  it("does not treat duplicate timestamps as new speed samples and returns independent snapshots", () => {
    const tracker = new VehicleTracker(calibration);
    const first = confirm(tracker, [detection(400, 200)])[0];
    first.trail[0].x = -1;
    first.bbox[0] = -1;
    const second = tracker.update([detection(400, 200)], 0.2, width, height)[0];
    expect(second.speedSampleCount).toBe(3);
    expect(second.speedKmh).toBeNull();
    expect(second.trail[0].x).toBe(0.4);
    expect(second.bbox[0]).toBe(360);
  });
});
describe("temporal detection confirmation", () => {
  it("hides isolated false detections and persistent low-confidence background boxes", () => {
    const tracker = new VehicleTracker(null);
    expect(
      tracker.update([detection(800, 300, "bus")], 0, width, height),
    ).toEqual([]);
    for (let i = 1; i <= 20; i++) {
      const background = { ...detection(800, 300, "bus"), score: 0.41 };
      expect(tracker.update([background], i * 0.1, width, height)).toEqual([]);
    }
    const car = confirm(tracker, [detection(300, 400)], 2.1)[0];
    expect(car.className).toBe("car");
    expect(car.id).toBe(2);
  });
  it("requires three distinct observations and at least 0.2 seconds before exposure", () => {
    const tracker = new VehicleTracker(null);
    expect(tracker.update([detection(200, 300)], 0, width, height)).toEqual([]);
    expect(tracker.update([detection(210, 300)], 0.01, width, height)).toEqual(
      [],
    );
    expect(tracker.update([detection(220, 300)], 0.02, width, height)).toEqual(
      [],
    );
    expect(tracker.update([detection(240, 300)], 0.04, width, height)).toEqual(
      [],
    );
    expect(
      tracker.update([detection(400, 300)], 0.2, width, height)[0].id,
    ).toBe(1);
  });
  it("does not let repeated inference of the same timestamp confirm an identity", () => {
    const tracker = new VehicleTracker(null);
    for (let i = 0; i < 12; i++) {
      expect(tracker.update([detection(200, 300)], 0, width, height)).toEqual(
        [],
      );
    }
    expect(tracker.update([detection(200, 300)], 0.2, width, height)).toEqual(
      [],
    );
    expect(
      tracker.update([detection(200, 300)], 0.3, width, height)[0].id,
    ).toBe(1);
  });
  it("requires two high-confidence observations even when many weak matches exist", () => {
    const tracker = new VehicleTracker(null);
    const strong = { ...detection(200, 300), score: 0.75 };
    const weak = { ...strong, score: 0.4 };
    expect(tracker.update([strong], 0, width, height)).toEqual([]);
    expect(tracker.update([weak], 0.1, width, height)).toEqual([]);
    expect(tracker.update([weak], 0.2, width, height)).toEqual([]);
    expect(tracker.update([strong], 0.3, width, height)[0].id).toBe(1);
  });
  it("keeps established IDs through confidence dips without creating new weak tracks", () => {
    const tracker = new VehicleTracker(null);
    confirm(tracker, [detection(200, 300)]);
    const tracks = tracker.update(
      [
        { ...detection(210, 300), score: 0.37 },
        { ...detection(700, 400, "person"), score: 0.4 },
        { ...detection(800, 400, "bus"), score: 0.45 },
      ],
      0.3,
      width,
      height,
    );
    expect(tracks).toHaveLength(1);
    expect(tracks[0].id).toBe(1);
    expect(tracks[0].score).toBe(0.37);
    expect(
      tracker.update([detection(220, 300)], 0.4, width, height)[0].id,
    ).toBe(1);
  });
  it("retains a confirmed stationary identity across a two-second detection gap", () => {
    const tracker = new VehicleTracker(null);
    confirm(tracker, [detection(200, 300)]);
    expect(tracker.update([], 0.7, width, height)).toEqual([]);
    expect(tracker.update([], 1.5, width, height)).toEqual([]);
    const reappeared = tracker.update(
      [{ ...detection(200, 300), score: 0.4 }],
      2.2,
      width,
      height,
    );
    expect(reappeared).toHaveLength(1);
    expect(reappeared[0].id).toBe(1);
  });
  it("expires tentative identities promptly so unrelated flashes cannot accumulate confirmation", () => {
    const tracker = new VehicleTracker(null);
    tracker.update([detection(200, 300)], 0, width, height);
    expect(tracker.update([detection(200, 300)], 0.8, width, height)).toEqual(
      [],
    );
    expect(tracker.update([detection(200, 300)], 0.9, width, height)).toEqual(
      [],
    );
    expect(tracker.update([detection(200, 300)], 1, width, height)[0].id).toBe(
      2,
    );
  });
  it("supports a stricter initiation threshold while keeping association independently permissive", () => {
    const tracker = new VehicleTracker(null, {
      initiationConfidence: 0.75,
      associationConfidence: 0.35,
    });
    const medium = { ...detection(200, 300), score: 0.7 };
    expect(confirm(tracker, [medium])).toEqual([]);
    const strong = { ...medium, score: 0.85 };
    expect(confirm(tracker, [strong], 0.3)[0].id).toBe(1);
    const weak = { ...medium, score: 0.36 };
    expect(tracker.update([weak], 0.6, width, height)[0].id).toBe(1);
    expect(
      tracker.update([{ ...weak, score: 0.34 }], 0.7, width, height),
    ).toEqual([]);
  });
});
