import { describe, expect, it } from "vitest";
import {
  calculateSpeedMeasurement,
  geometricMedianVelocity,
} from "./speedMeasurement";
import type {
  Calibration,
  Point,
  SpeedMeasurementMethod,
  SpeedSample,
} from "./types";
const calibration: Calibration = {
  points: [
    { x: 0, y: 0 },
    { x: 1, y: 0 },
    { x: 1, y: 1 },
    { x: 0, y: 1 },
  ],
  widthMeters: 40,
  lengthMeters: 200,
};
const straight = (): SpeedSample[] =>
  [0, 0.07, 0.19, 0.36, 0.55, 0.81, 1.14].map((timeSeconds) => ({
    timeSeconds,
    imagePoint: {
      x: (5 + 3 * timeSeconds) / 40,
      y: (30 + 4 * timeSeconds) / 200,
    },
  }));
describe("reproducible recent-window speed", () => {
  it("keeps pair membership stable when the media-clock origin changes", () => {
    const samples = [0, 0.1, 0.3, 0.5].map((timeSeconds) => ({
      timeSeconds,
      imagePoint: { x: (20 + 10 * timeSeconds ** 2) / 40, y: 0.5 },
    }));
    for (const offset of [0, 10, 100000]) {
      const result = calculateSpeedMeasurement(
        samples.map((s) => ({ ...s, timeSeconds: s.timeSeconds + offset })),
        calibration,
      )!;
      expect(result.pairCount).toBe(5);
      expect(result.speedKmh).toBeCloseTo(18, 7);
    }
  });
  it("permits a 0.5-second sampling gap but rejects one outside the declared tolerance", () => {
    const samples = [0, 0.1, 0.2, 0.7].map((timeSeconds) => ({
      timeSeconds,
      imagePoint: { x: 0.5, y: 0.5 },
    }));
    expect(calculateSpeedMeasurement(samples, calibration)!.speedKmh).toBe(0);
    samples[3].timeSeconds = 0.700002;
    expect(calculateSpeedMeasurement(samples, calibration)).toBeNull();
  });
  it("recovers an analytic 3–4–5 m/s trajectory through an independent perspective camera", () => {
    const image = (u: number, v: number) => ({
      x: (0.12 + 0.7 * u + 0.1 * v) / (1 + 0.35 * v),
      y: (0.1 + 0.03 * u + 0.75 * v) / (1 + 0.35 * v),
    });
    const tilted: Calibration = {
      ...calibration,
      points: [image(0, 0), image(1, 0), image(1, 1), image(0, 1)],
    };
    const samples = straight().map(({ timeSeconds, imagePoint }) => ({
      timeSeconds,
      imagePoint: image(imagePoint.x, imagePoint.y),
    }));
    const result = calculateSpeedMeasurement(samples, tilted)!;
    expect(result.method).toBe("ground-plane-geometric-median-v3");
    expect(result.velocityMps.x).toBeCloseTo(3, 10);
    expect(result.velocityMps.y).toBeCloseTo(4, 10);
    expect(result.speedKmh).toBeCloseTo(18, 10);
    expect(
      calculateSpeedMeasurement(
        JSON.parse(JSON.stringify(result.samples)),
        JSON.parse(JSON.stringify(tilted)),
      ),
    ).toEqual(result);
  });
  it("retains signed direction while reporting nonnegative speed", () => {
    const samples = straight().map(({ timeSeconds, imagePoint }) => ({
      timeSeconds,
      imagePoint: { x: 1 - imagePoint.x, y: 1 - imagePoint.y },
    }));
    const result = calculateSpeedMeasurement(samples, calibration)!;
    expect(result.velocityMps.x).toBeCloseTo(-3, 10);
    expect(result.velocityMps.y).toBeCloseTo(-4, 10);
    expect(result.speedKmh).toBeCloseTo(18, 10);
  });
  it("counts only pairs at least 0.2 seconds apart", () => {
    const result = calculateSpeedMeasurement(
      [0, 0.25, 0.375, 0.5].map((timeSeconds) => ({
        timeSeconds,
        imagePoint: { x: 0.5, y: 0.5 + timeSeconds * 0.05 },
      })),
      calibration,
    )!;
    expect(result.pairCount).toBe(4);
    expect(result.speedKmh).toBeCloseTo(36);
  });
  it("resists one displaced sample in a stationary sequence", () => {
    const samples = Array.from({ length: 13 }, (_, i) => ({
      timeSeconds: i / 10,
      imagePoint: { x: i === 8 ? 0.54 : 0.5, y: i === 8 ? 0.53 : 0.5 },
    }));
    expect(calculateSpeedMeasurement(samples, calibration)!.speedKmh).toBe(0);
  });
  it("does not retain references to mutable input samples", () => {
    const samples = straight();
    const expected = structuredClone(samples);
    const result = calculateSpeedMeasurement(samples, calibration)!;
    samples[0].imagePoint.x = 0.99;
    samples[1].timeSeconds = 50;
    expect(result.samples).toEqual(expected);
    result.samples[2].imagePoint.y = 0.99;
    expect(samples[2].imagePoint.y).toBe(expected[2].imagePoint.y);
  });
  it.each([
    ["short window", () => straight().slice(0, 4)],
    [
      "long window",
      () => straight().map((s) => ({ ...s, timeSeconds: s.timeSeconds * 2 })),
    ],
    ["too few points", () => straight().slice(0, 3)],
    [
      "duplicate timestamp",
      () => straight().map((s, i) => (i === 1 ? { ...s, timeSeconds: 0 } : s)),
    ],
    ["backward timestamp", () => straight().reverse()],
    [
      "oversampled points",
      () =>
        straight().map((s, i) => (i === 1 ? { ...s, timeSeconds: 0.001 } : s)),
    ],
    [
      "nonfinite point",
      () =>
        straight().map((s, i) =>
          i === 2 ? { ...s, imagePoint: { x: NaN, y: 0.5 } } : s,
        ),
    ],
    [
      "nonfinite clock",
      () =>
        straight().map((s, i) =>
          i === 2 ? { ...s, timeSeconds: Infinity } : s,
        ),
    ],
    [
      "negative clock",
      () => straight().map((s) => ({ ...s, timeSeconds: s.timeSeconds - 1 })),
    ],
    [
      "outside image",
      () =>
        straight().map((s, i) =>
          i === 2 ? { ...s, imagePoint: { x: 1.1, y: 0.5 } } : s,
        ),
    ],
    [
      "too many samples",
      () =>
        Array.from({ length: 49 }, (_, i) => ({
          timeSeconds: i / 30,
          imagePoint: { x: 0.5, y: 0.5 },
        })),
    ],
  ] as const)("rejects %s", (_name, makeSamples) => {
    expect(calculateSpeedMeasurement(makeSamples(), calibration)).toBeNull();
  });
  it("rejects points outside a valid calibration polygon", () => {
    expect(
      calculateSpeedMeasurement(straight(), {
        ...calibration,
        points: [
          { x: 0.3, y: 0.3 },
          { x: 0.7, y: 0.3 },
          { x: 0.7, y: 0.7 },
          { x: 0.3, y: 0.7 },
        ],
      }),
    ).toBeNull();
  });
  it("rejects degenerate calibration", () => {
    expect(
      calculateSpeedMeasurement(straight(), { ...calibration, widthMeters: 0 }),
    ).toBeNull();
  });
});
const transform = (
  p: Point,
  angle: number,
  reflect = false,
  scale = 1,
): Point => {
  const y = reflect ? -p.y : p.y;
  return {
    x: scale * (p.x * Math.cos(angle) - y * Math.sin(angle)),
    y: scale * (p.x * Math.sin(angle) + y * Math.cos(angle)),
  };
};
describe("geometric median of velocity vectors", () => {
  it("recovers the independent Fermat point of a right isosceles triangle", () => {
    const result = geometricMedianVelocity([
      { x: 0, y: 0 },
      { x: 2, y: 0 },
      { x: 0, y: 2 },
    ])!;
    expect(result.x).toBeCloseTo(1 - 1 / Math.sqrt(3), 7);
    expect(result.y).toBeCloseTo(1 - 1 / Math.sqrt(3), 7);
  });
  it("leaves a coincident but non-optimal starting datum", () => {
    const result = geometricMedianVelocity([
      { x: 0, y: 0 },
      { x: -6, y: 0 },
      { x: 2, y: 1 },
      { x: 2, y: -1 },
      { x: 2, y: 0 },
    ])!;
    expect(result.x).toBeCloseTo(2 - 1 / Math.sqrt(3), 7);
    expect(result.y).toBe(0);
  });
  it("recognizes an optimal datum at the 120-degree singular boundary", () => {
    expect(
      geometricMedianVelocity([
        { x: 0, y: 0 },
        { x: -1, y: 0 },
        { x: 0.5, y: Math.sqrt(3) / 2 },
      ]),
    ).toEqual({ x: 0, y: 0 });
  });
  it("retains a strict coincident majority despite widely displaced minority vectors", () => {
    const majority = Array.from({ length: 4 }, () => ({ x: 3, y: 4 }));
    const outliers = [
      { x: 100, y: -300 },
      { x: -40, y: 800 },
      { x: 90, y: 100 },
    ];
    expect(geometricMedianVelocity([...majority, ...outliers])).toEqual({
      x: 3,
      y: 4,
    });
    expect(
      geometricMedianVelocity([
        ...Array.from({ length: 4 }, () => outliers[0]),
        ...majority.slice(0, 3),
      ]),
    ).toEqual(outliers[0]);
  });
  it("handles an entirely coincident cloud without aliasing", () => {
    const vectors = [
      { x: 3, y: 4 },
      { x: 3, y: 4 },
      { x: 3, y: 4 },
    ];
    const result = geometricMedianVelocity(vectors)!;
    expect(result).toEqual({ x: 3, y: 4 });
    result.x = 99;
    expect(vectors[0].x).toBe(3);
  });
  it("does not replace a tiny cloud's median with its mean", () => {
    for (const scale of [1e-13, 1, 1e13]) {
      expect(
        geometricMedianVelocity([
          { x: 0, y: 0 },
          { x: 0, y: 0 },
          { x: scale, y: 0 },
        ]),
      ).toEqual({ x: 0, y: 0 });
    }
  });
  it("uses the midpoint of a nonunique collinear median interval under rotations and reflections", () => {
    const vectors = [0, 2, 4, 100].map((x) => ({ x, y: x }));
    for (const reflect of [false, true]) {
      for (const angle of [0, 0.137, Math.PI / 4, Math.PI / 2, 2.3]) {
        const expected = transform({ x: 3, y: 3 }, angle, reflect);
        const actual = geometricMedianVelocity(
          vectors.map((p) => transform(p, angle, reflect)),
        )!;
        expect(actual.x).toBeCloseTo(expected.x, 10);
        expect(actual.y).toBeCloseTo(expected.y, 10);
      }
    }
  });
  it("is equivariant for a noncollinear cloud under rotation, reflection, translation and scale", () => {
    const vectors = [
      { x: 0, y: 0 },
      { x: 2, y: 0 },
      { x: 0, y: 2 },
    ];
    const known = { x: 1 - 1 / Math.sqrt(3), y: 1 - 1 / Math.sqrt(3) };
    for (const reflect of [false, true]) {
      for (const angle of [0.137, Math.PI / 4, Math.PI / 2, 2.3]) {
        for (const scale of [0.01, 1, 100]) {
          const move = (p: Point) => {
            const r = transform(p, angle, reflect, scale);
            return { x: r.x + 30, y: r.y - 21 };
          };
          const expected = move(known);
          const actual = geometricMedianVelocity(vectors.map(move))!;
          expect(
            Math.hypot(actual.x - expected.x, actual.y - expected.y),
          ).toBeLessThan(1e-7 * scale);
        }
      }
    }
  });
  it("abstains when a difficult near-singular cloud exceeds the bounded iteration budget", () => {
    const angle = Math.PI / 3 + 0.001;
    expect(
      geometricMedianVelocity([
        { x: 0, y: 0 },
        { x: -1, y: 0 },
        { x: Math.cos(angle), y: Math.sin(angle) },
      ]),
    ).toBeNull();
  });
  it("rejects nonfinite or unbounded inputs", () => {
    expect(geometricMedianVelocity([])).toBeNull();
    expect(geometricMedianVelocity([{ x: Infinity, y: 0 }])).toBeNull();
    expect(
      geometricMedianVelocity(
        Array.from({ length: 1129 }, () => ({ x: 0, y: 0 })),
      ),
    ).toBeNull();
  });
});
describe("versioned speed replay and orientation independence", () => {
  const square: Calibration = {
    ...calibration,
    widthMeters: 100,
    lengthMeters: 100,
  };
  it("preserves the original v2 adversarial vector and exact floating-point output", () => {
    const samples = [
      [0, 10, 20],
      [0.2, 11, 21],
      [0.4, 14, 19],
      [0.6, 16, 23],
    ].map(([timeSeconds, x, y]) => ({
      timeSeconds,
      imagePoint: { x: x / 40, y: y / 200 },
    }));
    expect(
      calculateSpeedMeasurement(samples, calibration, "ground-plane-median-v2"),
    ).toEqual({
      method: "ground-plane-median-v2",
      samples,
      velocityMps: { x: 10, y: 5 },
      speedKmh: 40.24922359499622,
      pairCount: 6,
    });
  });
  it("converges for an ordinary five-sample noisy window near a non-optimal datum", () => {
    const xs = [0.2, 0.22, 0.24, 0.255, 0.29];
    const ys = [0.2, 0.25, 0.29, 0.365, 0.39];
    const samples = [0, 0.25, 0.5, 0.75, 1].map((timeSeconds, i) => ({
      timeSeconds,
      imagePoint: { x: xs[i], y: ys[i] },
    }));
    const result = calculateSpeedMeasurement(samples, {
      ...square,
      widthMeters: 20,
    })!;
    expect(result).not.toBeNull();
    expect(result.pairCount).toBe(10);
    let gradientX = 0,
      gradientY = 0;
    for (let i = 0; i < samples.length; i++) {
      for (let j = i + 1; j < samples.length; j++) {
        const elapsed = samples[j].timeSeconds - samples[i].timeSeconds;
        const dx = result.velocityMps.x - (xs[j] * 20 - xs[i] * 20) / elapsed;
        const dy = result.velocityMps.y - (ys[j] * 100 - ys[i] * 100) / elapsed;
        const distance = Math.hypot(dx, dy);
        expect(distance).toBeGreaterThan(0);
        gradientX += dx / distance;
        gradientY += dy / distance;
      }
    }
    expect(Math.hypot(gradientX, gradientY)).toBeLessThanOrEqual(1e-8);
    expect(result.velocityMps.x).toBeCloseTo(1.7885851093, 6);
    expect(result.velocityMps.y).toBeCloseTo(19.0657660735, 6);
  });
  it("fixes the coordinate-median rotation defect while retaining legacy replay", () => {
    const curve = (angle: number) =>
      Array.from({ length: 17 }, (_, i) => {
        const timeSeconds = i / 10;
        return {
          timeSeconds,
          imagePoint: {
            x: (50 + 10 * Math.cos(timeSeconds + angle)) / 100,
            y: (50 + 10 * Math.sin(timeSeconds + angle)) / 100,
          },
        };
      });
    const old = calculateSpeedMeasurement(
      curve(0),
      square,
      "ground-plane-median-v2",
    )!;
    const oldRotated = calculateSpeedMeasurement(
      curve(Math.PI / 4),
      square,
      "ground-plane-median-v2",
    )!;
    expect(old.speedKmh).toBeCloseTo(34.41549, 4);
    expect(oldRotated.speedKmh).toBeCloseTo(33.72819, 4);
    expect(Math.abs(old.speedKmh - oldRotated.speedKmh)).toBeGreaterThan(0.68);
    const current = calculateSpeedMeasurement(curve(0), square)!;
    const rotated = calculateSpeedMeasurement(curve(Math.PI / 4), square)!;
    const expected = transform(current.velocityMps, Math.PI / 4);
    expect(rotated.velocityMps.x).toBeCloseTo(expected.x, 7);
    expect(rotated.velocityMps.y).toBeCloseTo(expected.y, 7);
    expect(rotated.speedKmh).toBeCloseTo(current.speedKmh, 7);
  });
  it("preserves vector transformations for a noisy curved trajectory through an independent perspective camera", () => {
    const image = (u: number, v: number) => ({
      x: (0.12 + 0.7 * u + 0.1 * v) / (1 + 0.35 * v),
      y: (0.1 + 0.03 * u + 0.75 * v) / (1 + 0.35 * v),
    });
    const perspective: Calibration = {
      ...square,
      points: [image(0, 0), image(1, 0), image(1, 1), image(0, 1)],
    };
    const make = (
      angle: number,
      reflect: boolean,
      scale: number,
      mapped: boolean,
    ) =>
      Array.from({ length: 13 }, (_, i) => {
        const timeSeconds = i / 10;
        const p = transform(
          {
            x: 4 * timeSeconds + 2 * timeSeconds ** 2 + (i === 5 ? 0.7 : 0),
            y:
              6 * timeSeconds -
              3 * timeSeconds ** 2 +
              0.15 * Math.sin(7 * timeSeconds),
          },
          angle,
          reflect,
          scale,
        );
        const u = (50 + p.x) / 100,
          v = (50 + p.y) / 100;
        return {
          timeSeconds,
          imagePoint: mapped ? image(u, v) : { x: u, y: v },
        };
      });
    const reference = calculateSpeedMeasurement(
      make(0, false, 1, false),
      square,
    )!;
    for (const reflect of [false, true]) {
      for (const angle of [0, 0.137, Math.PI / 4, Math.PI / 2, 2.3]) {
        for (const scale of [0.3, 1, 3]) {
          const expected = transform(
            reference.velocityMps,
            angle,
            reflect,
            scale,
          );
          const result = calculateSpeedMeasurement(
            make(angle, reflect, scale, true),
            perspective,
          )!;
          expect(result).not.toBeNull();
          expect(result.pairCount).toBe(reference.pairCount);
          expect(result.velocityMps.x).toBeCloseTo(expected.x, 7);
          expect(result.velocityMps.y).toBeCloseTo(expected.y, 7);
          expect(result.speedKmh).toBeCloseTo(reference.speedKmh * scale, 7);
          expect(
            calculateSpeedMeasurement(
              JSON.parse(JSON.stringify(result.samples)),
              JSON.parse(JSON.stringify(perspective)),
              result.method,
            ),
          ).toEqual(result);
        }
      }
    }
  });
  it("rejects unsupported methods rather than interpreting them as the current algorithm", () => {
    expect(
      calculateSpeedMeasurement(
        straight(),
        calibration,
        "unknown" as SpeedMeasurementMethod,
      ),
    ).toBeNull();
  });
});
