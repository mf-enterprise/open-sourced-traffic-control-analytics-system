import { describe, expect, it } from "vitest";
import { CrossingCounter, type CountingLine } from "./counting";
import type { Track } from "./types";
const line: CountingLine = { a: { x: 0.2, y: 0.5 }, b: { x: 0.8, y: 0.5 } };
const width = 1000,
  height = 600;
const vehicle = (
  id: number,
  x: number,
  y: number,
  age = 1,
  className = "car",
): Track => ({
  id,
  bbox: [x * width - 25, y * height - 40, 50, 40],
  className,
  age,
  score: 0.9,
  speedKmh: null,
  trail: [],
});
const update = (counter: CrossingCounter, tracks: Track[], time: number) =>
  counter.update(tracks, width, height, time);
describe("directional crossing counter", () => {
  it("preserves cumulative counts and counted IDs across a continuity break", () => {
    const counter = new CrossingCounter(line);
    update(
      counter,
      [vehicle(1, 0.4, 0.45), vehicle(2, 0.6, 0.55, 1, "truck")],
      10,
    );
    const before = update(
      counter,
      [vehicle(1, 0.4, 0.55, 1.1), vehicle(2, 0.6, 0.45, 1.1, "truck")],
      10.1,
    );
    counter.breakContinuity();
    expect(counter.snapshot).toEqual(before);
    const resumed = (tracks: Track[], time: number) =>
      counter.update(
        tracks.map((track) => ({
          ...track,
          bbox: track.bbox.map((value) => value * 2) as Track["bbox"],
        })),
        width * 2,
        height * 2,
        time,
      );
    expect(
      resumed(
        [
          vehicle(1, 0.4, 0.45, 2),
          vehicle(2, 0.6, 0.55, 2, "truck"),
          vehicle(3, 0.5, 0.45, 0.2, "bus"),
        ],
        0,
      ),
    ).toEqual(before);
    const after = resumed(
      [
        vehicle(1, 0.4, 0.55, 2.1),
        vehicle(2, 0.6, 0.45, 2.1, "truck"),
        vehicle(3, 0.5, 0.55, 0.3, "bus"),
      ],
      0.1,
    );
    expect(after.total).toBe(3);
    expect(after.forward).toBe(2);
    expect(after.reverse).toBe(1);
    expect(after.classes).toEqual({
      car: 1,
      truck: 1,
      bus: 1,
      motorcycle: 0,
      bicycle: 0,
    });
  });
  it("does not invent an unseen crossing when the same uncounted ID resumes on the other side", () => {
    const counter = new CrossingCounter(line);
    update(counter, [vehicle(1, 0.5, 0.45)], 0);
    counter.breakContinuity();
    expect(update(counter, [vehicle(1, 0.5, 0.55, 1.1)], 0.1).total).toBe(0);
    expect(update(counter, [vehicle(1, 0.5, 0.45, 1.2)], 0.2).reverse).toBe(1);
  });
  it("counts both directions and vehicle classes using bottom-center, without speed calibration", () => {
    const counter = new CrossingCounter(line);
    update(
      counter,
      [vehicle(1, 0.4, 0.45), vehicle(2, 0.6, 0.56, 1, "truck")],
      0,
    );
    const result = update(
      counter,
      [vehicle(1, 0.4, 0.52), vehicle(2, 0.6, 0.47, 1.1, "truck")],
      0.1,
    );
    expect(result.total).toBe(2);
    expect(result.forward).toBe(1);
    expect(result.reverse).toBe(1);
    expect(result.classes.car).toBe(1);
    expect(result.classes.truck).toBe(1);
  });
  it("requires an established side and ignores parked vehicles and initial appearances", () => {
    const counter = new CrossingCounter(line);
    update(counter, [vehicle(1, 0.5, 0.5), vehicle(2, 0.5, 0.55)], 0);
    update(counter, [vehicle(1, 0.5, 0.55), vehicle(2, 0.5, 0.55)], 0.1);
    update(
      counter,
      [vehicle(1, 0.5, 0.55), vehicle(2, 0.5, 0.55), vehicle(3, 0.5, 0.4)],
      0.2,
    );
    expect(counter.snapshot.total).toBe(0);
    expect(update(counter, [vehicle(1, 0.5, 0.45)], 0.3).reverse).toBe(1);
  });
  it("debounces line jitter and confirms a crossing only outside the opposite deadband edge", () => {
    const counter = new CrossingCounter(line);
    update(counter, [vehicle(1, 0.5, 0.47)], 0);
    [0.498, 0.504, 0.496, 0.507, 0.5, 0.506].forEach((y, index) => {
      expect(
        update(counter, [vehicle(1, 0.5, y)], (index + 1) * 0.1).total,
      ).toBe(0);
    });
    expect(update(counter, [vehicle(1, 0.5, 0.512)], 0.7).total).toBe(1);
  });
  it("counts each identity once total even if it crosses back and forth repeatedly", () => {
    const counter = new CrossingCounter(line);
    [0.45, 0.55, 0.45, 0.55, 0.45].forEach((y, index) =>
      update(counter, [vehicle(1, 0.5, y)], index * 0.1),
    );
    expect(counter.snapshot.total).toBe(1);
    expect(counter.snapshot.forward).toBe(1);
    expect(counter.snapshot.reverse).toBe(0);
  });
  it("does not count the infinite line extension or a path around an endpoint", () => {
    const counter = new CrossingCounter(line);
    update(counter, [vehicle(1, 0.9, 0.45), vehicle(2, 0.75, 0.45)], 0);
    update(counter, [vehicle(1, 0.9, 0.55), vehicle(2, 0.9, 0.497)], 0.1);
    update(counter, [vehicle(2, 0.9, 0.503)], 0.2);
    update(counter, [vehicle(2, 0.75, 0.55)], 0.3);
    expect(counter.snapshot.total).toBe(0);
  });
  it("uses the observed crossing location rather than where the vehicle exits the deadband", () => {
    const counter = new CrossingCounter(line);
    update(counter, [vehicle(1, 0.75, 0.45)], 0);
    update(counter, [vehicle(1, 0.75, 0.501)], 0.1);
    expect(update(counter, [vehicle(1, 0.9, 0.55)], 0.2).total).toBe(1);
  });
  it("supports diagonal and vertical lines with direction determined by endpoint order", () => {
    const vertical = new CrossingCounter({
      a: { x: 0.5, y: 0.2 },
      b: { x: 0.5, y: 0.8 },
    });
    update(vertical, [vehicle(1, 0.6, 0.5)], 0);
    expect(update(vertical, [vehicle(1, 0.4, 0.5)], 0.1).forward).toBe(1);
    const diagonal = new CrossingCounter({
      a: { x: 0.2, y: 0.2 },
      b: { x: 0.8, y: 0.8 },
    });
    update(diagonal, [vehicle(1, 0.5, 0.4)], 0);
    expect(update(diagonal, [vehicle(1, 0.5, 0.6)], 0.1).forward).toBe(1);
  });
  it("counts an endpoint crossing, and handles a sample exactly on the line", () => {
    const counter = new CrossingCounter(line);
    update(counter, [vehicle(1, 0.2, 0.45)], 0);
    expect(update(counter, [vehicle(1, 0.2, 0.5)], 0.1).total).toBe(0);
    expect(update(counter, [vehicle(1, 0.2, 0.55)], 0.2).total).toBe(1);
  });
  it("excludes people and unknown classes, while counting bicycles, buses, and motorcycles", () => {
    const counter = new CrossingCounter(line);
    const classes = ["person", "dog", "bicycle", "bus", "motorcycle"];
    update(
      counter,
      classes.map((name, index) => vehicle(index, 0.5, 0.45, 1, name)),
      0,
    );
    const result = update(
      counter,
      classes.map((name, index) => vehicle(index, 0.5, 0.55, 1.1, name)),
      0.1,
    );
    expect(result.total).toBe(3);
    expect(result.classes.bicycle).toBe(1);
    expect(result.classes.bus).toBe(1);
    expect(result.classes.motorcycle).toBe(1);
    expect("person" in result.classes).toBe(false);
  });
  it("does not bridge a track history through a person classification or invalid box", () => {
    const counter = new CrossingCounter(line);
    update(counter, [vehicle(1, 0.5, 0.45), vehicle(2, 0.5, 0.45)], 0);
    const broken = vehicle(2, 0.5, 0.5);
    broken.bbox[2] = Number.NaN;
    update(counter, [vehicle(1, 0.5, 0.5, 1, "person"), broken], 0.1);
    expect(
      update(counter, [vehicle(1, 0.5, 0.55), vehicle(2, 0.5, 0.55)], 0.2)
        .total,
    ).toBe(0);
  });
  it("never invents a crossing over a gap longer than 1.5 seconds", () => {
    const counter = new CrossingCounter(line);
    update(counter, [vehicle(1, 0.5, 0.45)], 0);
    update(counter, [], 1);
    expect(update(counter, [vehicle(1, 0.5, 0.55, 3)], 1.6).total).toBe(0);
    expect(update(counter, [vehicle(1, 0.5, 0.45, 3.1)], 1.7).reverse).toBe(1);
  });
  it("retains already-counted IDs across stale motion without counting them twice", () => {
    const counter = new CrossingCounter(line);
    update(counter, [vehicle(1, 0.5, 0.45, 1)], 0);
    update(counter, [vehicle(1, 0.5, 0.55, 1.1)], 0.1);
    update(counter, [], 2);
    update(counter, [vehicle(1, 0.5, 0.45, 4)], 3);
    expect(update(counter, [vehicle(1, 0.5, 0.55, 4.1)], 3.1).total).toBe(1);
  });
  it("reused IDs with a lower track age must establish a new side before counting", () => {
    const counter = new CrossingCounter(line);
    update(counter, [vehicle(1, 0.5, 0.45, 10)], 0);
    update(counter, [vehicle(1, 0.5, 0.55, 10.1)], 0.1);
    expect(update(counter, [vehicle(1, 0.5, 0.45, 0)], 0.2).total).toBe(1);
    expect(update(counter, [vehicle(1, 0.5, 0.55, 0.1)], 0.3).total).toBe(2);
  });
  it("duplicate timestamps and duplicate IDs in one frame are idempotent", () => {
    const counter = new CrossingCounter(line);
    update(counter, [vehicle(1, 0.5, 0.45), vehicle(1, 0.5, 0.55)], 0);
    expect(counter.snapshot.total).toBe(0);
    expect(update(counter, [vehicle(1, 0.5, 0.55)], 0).total).toBe(0);
    expect(
      update(counter, [vehicle(1, 0.5, 0.55), vehicle(1, 0.5, 0.45)], 0.1)
        .total,
    ).toBe(1);
    expect(update(counter, [vehicle(1, 0.5, 0.55)], 0.1).total).toBe(1);
  });
  it("resets counts and motion on timestamp rollback or intrinsic resolution changes", () => {
    const counter = new CrossingCounter(line);
    update(counter, [vehicle(1, 0.5, 0.45)], 10);
    update(counter, [vehicle(1, 0.5, 0.55)], 10.1);
    expect(update(counter, [vehicle(1, 0.5, 0.45)], 5).total).toBe(0);
    expect(update(counter, [vehicle(1, 0.5, 0.55)], 5.1).total).toBe(1);
    expect(counter.update([], 1920, 1080, 5.2).total).toBe(0);
  });
  it("validates line coordinates and minimum length, and copies the supplied configuration", () => {
    const counter = new CrossingCounter(line);
    expect(() =>
      counter.setLine({ a: { x: 0.2, y: 0.2 }, b: { x: 0.249, y: 0.2 } }),
    ).toThrow(RangeError);
    expect(() =>
      counter.setLine({ a: { x: -0.1, y: 0.2 }, b: { x: 0.8, y: 0.2 } }),
    ).toThrow(RangeError);
    expect(() =>
      counter.setLine({ a: { x: 0.2, y: Number.NaN }, b: { x: 0.8, y: 0.2 } }),
    ).toThrow(RangeError);
    expect(
      () =>
        new CrossingCounter({ a: { x: 0.55, y: 0.5 }, b: { x: 0.6, y: 0.5 } }),
    ).not.toThrow();
    const mutable = { a: { x: 0.2, y: 0.5 }, b: { x: 0.8, y: 0.5 } };
    counter.setLine(mutable);
    mutable.a.y = 0.9;
    mutable.b.y = 0.9;
    update(counter, [vehicle(1, 0.5, 0.45)], 0);
    expect(update(counter, [vehicle(1, 0.5, 0.55)], 0.1).total).toBe(1);
  });
  it("preserves counts for the identical line and clears them for a changed or disabled line", () => {
    const counter = new CrossingCounter(line);
    update(counter, [vehicle(1, 0.5, 0.45)], 0);
    update(counter, [vehicle(1, 0.5, 0.55)], 0.1);
    counter.setLine({ a: { ...line.a }, b: { ...line.b } });
    expect(counter.snapshot.total).toBe(1);
    counter.setLine({ a: line.b, b: line.a });
    expect(counter.snapshot.total).toBe(0);
    counter.setLine(null);
    update(counter, [vehicle(1, 0.5, 0.45)], 1);
    expect(update(counter, [vehicle(1, 0.5, 0.55)], 1.1).total).toBe(0);
  });
  it("can invalidate the line while retaining historical counts until a new line is configured", () => {
    const counter = new CrossingCounter(line);
    update(counter, [vehicle(1, 0.5, 0.45)], 0);
    const before = update(counter, [vehicle(1, 0.5, 0.55)], 0.1);
    counter.setLine(null, true);
    expect(counter.snapshot).toEqual(before);
    update(counter, [vehicle(2, 0.5, 0.45)], 0.2);
    expect(update(counter, [vehicle(2, 0.5, 0.55)], 0.3)).toEqual(before);
    counter.setLine(null);
    expect(counter.snapshot).toEqual(before);
    counter.setLine(line);
    expect(counter.snapshot.total).toBe(0);
    update(counter, [vehicle(3, 0.5, 0.45)], 0.4);
    expect(update(counter, [vehicle(3, 0.5, 0.55)], 0.5).total).toBe(1);
  });
  it("returns detached frozen snapshots, ignores invalid frame metadata, and retains its line after reset", () => {
    const counter = new CrossingCounter(line);
    const before = update(counter, [vehicle(1, 0.5, 0.45)], 0);
    counter.update([vehicle(1, 0.5, 0.55)], 0, height, 0.1);
    counter.update([vehicle(1, 0.5, 0.55)], width, height, Number.NaN);
    const after = update(counter, [vehicle(1, 0.5, 0.55)], 0.2);
    expect(before.total).toBe(0);
    expect(before.classes.car).toBe(0);
    expect(after.total).toBe(1);
    expect(Object.isFrozen(after)).toBe(true);
    expect(Object.isFrozen(after.classes)).toBe(true);
    expect(counter.snapshot).not.toBe(counter.snapshot);
    counter.reset();
    expect(counter.snapshot.total).toBe(0);
    update(counter, [vehicle(1, 0.5, 0.45)], 2);
    expect(update(counter, [vehicle(1, 0.5, 0.55)], 2.1).total).toBe(1);
  });
});
