import { describe, expect, it } from "vitest";
import {
  fitInferredRoadPlane,
  intersectInferredRoadPlane,
  projectInferredRoadPoint,
  type CameraIntrinsicsPx,
  type InferredRoadPlaneInput,
  type InferredRoadPlaneResult,
  type Vector3,
} from "./inferredRoadPlane";
import type { Point } from "./types";
const fullRoi: Point[] = [
  { x: 0, y: 0 },
  { x: 1, y: 0 },
  { x: 1, y: 1 },
  { x: 0, y: 1 },
];
const safeRoi: Point[] = [
  { x: 0.15, y: 0.35 },
  { x: 0.85, y: 0.35 },
  { x: 0.85, y: 0.9 },
  { x: 0.15, y: 0.9 },
];
function inputPlane(
  normal: Vector3 = [0, 0, -1],
  offset = 10,
  width = 160,
  height = 120,
  focal = 140,
  roi = fullRoi,
): InferredRoadPlaneInput & {
  focalLengthPx: number;
} {
  const depth = new Float32Array(width * height);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const rx = (x + 0.5 - width / 2) / focal,
        ry = (y + 0.5 - height / 2) / focal;
      const z = -offset / (normal[0] * rx + normal[1] * ry + normal[2]);
      depth[y * width + x] = z > 0 ? z : NaN;
    }
  return {
    depth,
    width,
    height,
    focalLengthPx: focal,
    roi: roi.map((point) => ({ ...point })),
  };
}
function success(result: InferredRoadPlaneResult) {
  if (!result.ok)
    throw new Error(
      `${result.reason}: ${result.message} ${JSON.stringify(result.diagnostics)}`,
    );
  return result;
}
function truthIntersection(
  input: InferredRoadPlaneInput,
  normal: Vector3,
  offset: number,
  point: Point,
): Vector3 {
  const intrinsics = input.intrinsics ?? {
    fx: input.focalLengthPx!,
    fy: input.focalLengthPx!,
    cx: input.width / 2,
    cy: input.height / 2,
  };
  const ray = [
    (point.x * input.width - intrinsics.cx) / intrinsics.fx,
    (point.y * input.height - intrinsics.cy) / intrinsics.fy,
    1,
  ];
  const z =
    -offset / ray.reduce((sum, value, index) => sum + value * normal[index], 0);
  return ray.map((value) => value * z) as unknown as Vector3;
}
function inputPlaneWithIntrinsics(
  normal: Vector3,
  offset: number,
  width: number,
  height: number,
  intrinsics: CameraIntrinsicsPx,
): InferredRoadPlaneInput {
  const depth = new Float32Array(width * height);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const xOverZ = (x + 0.5 - intrinsics.cx) / intrinsics.fx;
      const yOverZ = (y + 0.5 - intrinsics.cy) / intrinsics.fy;
      const z = -offset / (normal[0] * xOverZ + normal[1] * yOverZ + normal[2]);
      depth[y * width + x] = z > 0 ? z : NaN;
    }
  return { depth, width, height, intrinsics, roi: fullRoi };
}
const distance3 = (a: Vector3, b: Vector3) =>
  Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
const distance2 = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y);
function hash(index: number) {
  let value = (index + 1) | 0;
  value ^= value << 13;
  value ^= value >>> 17;
  value ^= value << 5;
  return (value >>> 0) / 0x100000000;
}
describe("model-inferred road plane geometry", () => {
  it("gates support against the returned plane after iterative refinement", () => {
    const input = inputPlane();
    let state = 3;
    const random = () => {
      state ^= state << 13;
      state ^= state >>> 17;
      state ^= state << 5;
      return (state >>> 0) / 0x100000000;
    };
    for (let i = 0; i < 15; i++) random();
    const a = 0.1 + random() * 0.2,
      b = random(),
      c = random() * 0.8;
    for (let y = 0; y < input.height; y++)
      for (let x = 0; x < input.width; x++)
        input.depth[y * input.width + x] =
          10 +
          (c * x) / input.width +
          a * (random() < b ? 1 : 0) +
          0.1 * (random() - 0.5);
    const result = fitInferredRoadPlane(input, {
      minimumInlierFraction: 0.9507,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("non-planar");
    expect(result.diagnostics.inlierFraction).toBeLessThan(0.9507);
    const accepted = success(fitInferredRoadPlane(input));
    let actualInliers = 0;
    for (let row = 0; row < 55; row++)
      for (let column = 0; column < 74; column++) {
        const x = Math.floor(((column + 0.5) * input.width) / 74);
        const y = Math.floor(((row + 0.5) * input.height) / 55);
        const z = input.depth[y * input.width + x];
        const position = [
          ((x + 0.5 - input.width / 2) * z) / input.focalLengthPx,
          ((y + 0.5 - input.height / 2) * z) / input.focalLengthPx,
          z,
        ];
        const residual = accepted.plane.normal.reduce(
          (sum, value, axis) => sum + value * position[axis],
          accepted.plane.offsetMeters,
        );
        if (Math.abs(residual) <= accepted.diagnostics.fitThresholdMeters)
          actualInliers++;
      }
    expect(accepted.diagnostics.inlierCount).toBe(actualInliers);
  });
  it("recovers metric distances from a known fronto-parallel Z plane", () => {
    const input = inputPlane();
    const result = success(fitInferredRoadPlane(input));
    const a = { x: 0.25, y: 0.4 },
      b = { x: 0.75, y: 0.4 };
    expect(result.plane.normal[2]).toBeCloseTo(-1, 8);
    expect(result.plane.offsetMeters).toBeCloseTo(10, 8);
    expect(distance2(result.project(a)!, result.project(b)!)).toBeCloseTo(
      (80 * 10) / 140,
      7,
    );
    expect(result.diagnostics.inlierFraction).toBe(1);
    expect(result.diagnostics.spatialCoverage).toBe(1);
    expect(result.diagnostics.residualRmsMeters).toBeLessThan(1e-8);
    expect(result.plane.kind).toBe("model-inferred");
  });
  it("recovers tilted-plane intersections and Euclidean distances under perspective", () => {
    const normal: Vector3 = [0.08, -1, -0.3],
      offset = 4;
    const input = inputPlane(normal, offset, 160, 120, 140, safeRoi);
    const result = success(fitInferredRoadPlane(input));
    const a = { x: 0.28, y: 0.44 },
      b = { x: 0.66, y: 0.78 };
    const actualA = truthIntersection(input, normal, offset, a),
      actualB = truthIntersection(input, normal, offset, b);
    expect(distance3(result.intersect(a)!, actualA)).toBeLessThan(2e-6);
    expect(distance3(result.intersect(b)!, actualB)).toBeLessThan(2e-6);
    expect(distance2(result.project(a)!, result.project(b)!)).toBeCloseTo(
      distance3(actualA, actualB),
      5,
    );
    expect(Math.hypot(...result.plane.normal)).toBeCloseTo(1, 10);
  });
  it("serializes a homography consistent with ray-plane projection", () => {
    const result = success(
      fitInferredRoadPlane(
        inputPlane([0.08, -1, -0.3], 4, 160, 120, 140, safeRoi),
      ),
    );
    const restored = JSON.parse(JSON.stringify(result.plane));
    for (const point of [
      { x: 0.25, y: 0.4 },
      { x: 0.65, y: 0.55 },
      { x: 0.55, y: 0.82 },
    ]) {
      const h = restored.homography;
      const denominator = h[6] * point.x + h[7] * point.y + h[8];
      const mapped = {
        x: (h[0] * point.x + h[1] * point.y + h[2]) / denominator,
        y: (h[3] * point.x + h[4] * point.y + h[5]) / denominator,
      };
      expect(distance2(mapped, result.project(point)!)).toBeLessThan(1e-9);
      expect(projectInferredRoadPoint(restored, point)).toEqual(
        result.project(point),
      );
      expect(intersectInferredRoadPlane(restored, point)).toEqual(
        result.intersect(point),
      );
    }
  });
  it("inherits scale from predicted depth without inventing a lane or vehicle size", () => {
    const input = inputPlane([0.08, -1, -0.3], 4, 160, 120, 140, safeRoi);
    const original = success(fitInferredRoadPlane(input));
    const scaled = success(
      fitInferredRoadPlane({
        ...input,
        depth: input.depth.map((value) => value * 2),
      }),
    );
    const a = { x: 0.28, y: 0.44 },
      b = { x: 0.66, y: 0.78 };
    expect(distance2(scaled.project(a)!, scaled.project(b)!)).toBeCloseTo(
      2 * distance2(original.project(a)!, original.project(b)!),
      6,
    );
    expect(scaled.plane.offsetMeters).toBeCloseTo(
      original.plane.offsetMeters * 2,
      6,
    );
  });
  it("preserves distances when raster and focal length are resized together", () => {
    const normal: Vector3 = [0.08, -1, -0.3];
    const a = success(
      fitInferredRoadPlane(inputPlane(normal, 4, 160, 120, 140, safeRoi)),
    );
    const b = success(
      fitInferredRoadPlane(inputPlane(normal, 4, 320, 240, 280, safeRoi)),
    );
    const p = { x: 0.28, y: 0.44 },
      q = { x: 0.66, y: 0.78 };
    expect(distance2(a.project(p)!, a.project(q)!)).toBeCloseTo(
      distance2(b.project(p)!, b.project(q)!),
      5,
    );
  });
  it("rejects extrapolation, invalid points and unsafe ray-plane intersections", () => {
    const result = success(
      fitInferredRoadPlane(
        inputPlane([0.08, -1, -0.3], 4, 160, 120, 140, safeRoi),
      ),
    );
    expect(result.project({ x: 0.05, y: 0.6 })).toBeNull();
    expect(result.project({ x: NaN, y: 0.6 })).toBeNull();
    expect(result.intersect({ x: Infinity, y: 0.6 })).toBeNull();
    const horizon = { ...result.plane, normal: [0, -1, 0] as Vector3 };
    expect(intersectInferredRoadPlane(horizon, { x: 0.5, y: 0.5 })).toBeNull();
    expect(intersectInferredRoadPlane(horizon, { x: 0.5, y: 0.4 })).toBeNull();
  });
});
describe("explicit zero-skew camera intrinsics", () => {
  const intrinsics: CameraIntrinsicsPx = { fx: 110, fy: 195, cx: 51, cy: 82 };
  const normal: Vector3 = [0.12, -0.7, -0.7];
  const offset = 4;
  it("recovers anisotropic, off-centre tilted-plane rays, metric distances and homography", () => {
    const input = inputPlaneWithIntrinsics(
      normal,
      offset,
      160,
      120,
      intrinsics,
    );
    const result = success(fitInferredRoadPlane(input));
    const points = [
      { x: 0.18, y: 0.26 },
      { x: 0.76, y: 0.67 },
      { x: 0.38, y: 0.85 },
    ];
    for (const point of points) {
      const actual = truthIntersection(input, normal, offset, point);
      expect(distance3(result.intersect(point)!, actual)).toBeLessThan(2e-6);
      const h = result.plane.homography;
      const denominator = h[6] * point.x + h[7] * point.y + h[8];
      const mapped = {
        x: (h[0] * point.x + h[1] * point.y + h[2]) / denominator,
        y: (h[3] * point.x + h[4] * point.y + h[5]) / denominator,
      };
      expect(distance2(mapped, result.project(point)!)).toBeLessThan(1e-9);
    }
    expect(
      distance2(result.project(points[0])!, result.project(points[1])!),
    ).toBeCloseTo(
      distance3(
        truthIntersection(input, normal, offset, points[0]),
        truthIntersection(input, normal, offset, points[1]),
      ),
      5,
    );
    expect(result.plane.intrinsics).toEqual(intrinsics);
    expect(result.plane.intrinsicsConvention).toBe("image-edge-pixels");
    expect(result.plane.focalLengthPx).toBeNull();
    expect(result.plane.method).toBe("depth-plane-ransac-pca-v2");
    expect(result.plane.assumptions).toEqual([
      "zero-skew-pinhole",
      "uncorrected-lens-distortion",
    ]);
    const restored = JSON.parse(JSON.stringify(result.plane));
    expect(projectInferredRoadPoint(restored, points[0])).toEqual(
      result.project(points[0]),
    );
  });
  it("uses different horizontal and vertical metric scales, with no mean-focal shortcut", () => {
    const input = inputPlaneWithIntrinsics(
      [0, 0, -1],
      10,
      160,
      120,
      intrinsics,
    );
    const result = success(fitInferredRoadPlane(input));
    const principal = { x: intrinsics.cx / 160, y: intrinsics.cy / 120 };
    expect(distance3(result.intersect(principal)!, [0, 0, 10])).toBeLessThan(
      1e-9,
    );
    const a = { x: 0.3, y: 0.3 },
      horizontal = { x: 0.7, y: 0.3 },
      vertical = { x: 0.3, y: 0.7 };
    expect(
      distance2(result.project(a)!, result.project(horizontal)!),
    ).toBeCloseTo((0.4 * 160 * 10) / intrinsics.fx, 8);
    expect(
      distance2(result.project(a)!, result.project(vertical)!),
    ).toBeCloseTo((0.4 * 120 * 10) / intrinsics.fy, 8);
  });
  it("keeps geometry invariant under independent horizontal/vertical raster resizing", () => {
    const originalInput = inputPlaneWithIntrinsics(
      normal,
      offset,
      160,
      120,
      intrinsics,
    );
    const resizedInput = inputPlaneWithIntrinsics(normal, offset, 320, 180, {
      fx: intrinsics.fx * 2,
      fy: intrinsics.fy * 1.5,
      cx: intrinsics.cx * 2,
      cy: intrinsics.cy * 1.5,
    });
    const original = success(fitInferredRoadPlane(originalInput));
    const resized = success(fitInferredRoadPlane(resizedInput));
    const a = { x: 0.24, y: 0.32 },
      b = { x: 0.76, y: 0.81 };
    expect(
      distance3(original.intersect(a)!, resized.intersect(a)!),
    ).toBeLessThan(2e-6);
    expect(distance2(original.project(a)!, original.project(b)!)).toBeCloseTo(
      distance2(resized.project(a)!, resized.project(b)!),
      5,
    );
    expect(resized.plane.offsetMeters).toBeCloseTo(
      original.plane.offsetMeters,
      6,
    );
  });
  it("inherits only depth scale while preserving explicit intrinsics", () => {
    const input = inputPlaneWithIntrinsics(
      normal,
      offset,
      160,
      120,
      intrinsics,
    );
    const result = success(fitInferredRoadPlane(input));
    const scaled = success(
      fitInferredRoadPlane({ ...input, depth: input.depth.map((z) => z * 3) }),
    );
    const a = { x: 0.24, y: 0.32 },
      b = { x: 0.76, y: 0.81 };
    expect(scaled.plane.intrinsics).toEqual(result.plane.intrinsics);
    expect(scaled.plane.offsetMeters).toBeCloseTo(
      3 * result.plane.offsetMeters,
      5,
    );
    expect(distance2(scaled.project(a)!, scaled.project(b)!)).toBeCloseTo(
      3 * distance2(result.project(a)!, result.project(b)!),
      5,
    );
  });
  it("accepts off-raster principal points for cropped views and detaches the intrinsics", () => {
    const mutable = { fx: 140, fy: 140, cx: -15, cy: 155 };
    const input = inputPlaneWithIntrinsics([0, 0, -1], 10, 160, 120, mutable);
    const result = success(fitInferredRoadPlane(input));
    const point = { x: 0.4, y: 0.6 };
    const before = result.intersect(point);
    expect(
      distance3(before!, [((64 + 15) * 10) / 140, ((72 - 155) * 10) / 140, 10]),
    ).toBeLessThan(1e-9);
    expect(result.plane.focalLengthPx).toBe(140);
    expect(Object.isFrozen(result.plane.intrinsics)).toBe(true);
    mutable.fx = 999;
    mutable.cy = 0;
    expect(result.intersect(point)).toEqual(before);
  });
  it("preserves scalar-input compatibility and permits equivalent dual specification only", () => {
    const input = inputPlane();
    const original = success(fitInferredRoadPlane(input));
    const explicit = success(
      fitInferredRoadPlane({
        ...input,
        intrinsics: { fx: 140, fy: 140, cx: 80, cy: 60 },
      }),
    );
    expect(original.plane.method).toBe("depth-plane-ransac-pca-v1");
    expect(original.plane.focalLengthPx).toBe(140);
    expect(original.plane.intrinsics).toEqual({
      fx: 140,
      fy: 140,
      cx: 80,
      cy: 60,
    });
    expect(explicit.plane.homography).toEqual(original.plane.homography);
    expect(explicit.diagnostics).toEqual(original.diagnostics);
    const serializedV1 = JSON.parse(JSON.stringify(original.plane));
    delete serializedV1.intrinsics;
    delete serializedV1.intrinsicsConvention;
    expect(projectInferredRoadPoint(serializedV1, { x: 0.3, y: 0.7 })).toEqual(
      original.project({ x: 0.3, y: 0.7 }),
    );
    for (const conflicting of [
      { fx: 140, fy: 141, cx: 80, cy: 60 },
      { fx: 141, fy: 141, cx: 80, cy: 60 },
      { fx: 140, fy: 140, cx: 80.5, cy: 60 },
      { fx: 140, fy: 140, cx: 80, cy: 60.5 },
    ]) {
      const result = fitInferredRoadPlane({
        ...input,
        intrinsics: conflicting,
      });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toBe("invalid-input");
    }
  });
  it("rejects incomplete, nonfinite, nonpositive or nonzero-skew intrinsics without fallback", () => {
    const input = inputPlaneWithIntrinsics(
      normal,
      offset,
      160,
      120,
      intrinsics,
    );
    const malformed = [
      undefined,
      null,
      {},
      [],
      { fx: 110, fy: 195, cx: 51 },
      { ...intrinsics, fx: 0 },
      { ...intrinsics, fy: -1 },
      { ...intrinsics, fx: Infinity },
      { ...intrinsics, fy: NaN },
      { ...intrinsics, cx: Infinity },
      { ...intrinsics, cy: NaN },
      { ...intrinsics, skew: 0.5 },
    ];
    for (const value of malformed) {
      const result = fitInferredRoadPlane({
        ...input,
        intrinsics: value,
      } as InferredRoadPlaneInput);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toBe("invalid-input");
    }
  });
});
describe("robust fit and diagnostics", () => {
  it("honours the sample budget while retaining two-dimensional support in a wide raster", () => {
    const result = success(
      fitInferredRoadPlane(inputPlane([0, 0, -1], 10, 1024, 16, 500), {
        maxSamples: 64,
      }),
    );
    expect(result.diagnostics.sampledRoiPoints).toBeLessThanOrEqual(64);
    expect(result.diagnostics.spatialCoverage).toBe(1);
    expect(result.plane.offsetMeters).toBeCloseTo(10, 6);
  });
  it("rejects distributed off-plane objects while retaining a dominant road plane", () => {
    const input = inputPlane();
    for (let i = 0; i < input.depth.length; i++)
      if ((Math.imul(i + 17, 2654435761) >>> 0) % 4 === 0)
        input.depth[i] = 3 + 2 * hash(i);
    const result = success(fitInferredRoadPlane(input));
    expect(result.plane.offsetMeters).toBeCloseTo(10, 6);
    expect(result.diagnostics.inlierFraction).toBeGreaterThan(0.7);
    expect(result.diagnostics.inlierFraction).toBeLessThan(0.8);
    expect(result.diagnostics.residualRmsMeters).toBeLessThan(1e-6);
  });
  it("honours occluder boxes in raster pixels without changing the remaining depth", () => {
    const input = inputPlane();
    for (let y = 30; y < 90; y++)
      for (let x = 40; x < 120; x++) input.depth[y * input.width + x] = 2;
    input.excludedBoxes = [[40, 30, 80, 60]];
    const result = success(fitInferredRoadPlane(input));
    expect(result.diagnostics.unmaskedPoints).toBeLessThan(
      result.diagnostics.sampledRoiPoints,
    );
    expect(result.diagnostics.inlierFraction).toBe(1);
    expect(result.plane.offsetMeters).toBeCloseTo(10, 7);
    expect(result.diagnostics.spatialCoverage).toBeGreaterThanOrEqual(0.75);
  });
  it("reports nonzero plane scatter as a diagnostic, not an accuracy guarantee", () => {
    const input = inputPlane();
    for (let i = 0; i < input.depth.length; i++)
      input.depth[i] += 0.03 * Math.sin(i * 2.399963);
    const result = success(fitInferredRoadPlane(input));
    expect(result.diagnostics.residualRmsMeters).toBeGreaterThan(0.005);
    expect(result.diagnostics.residualRmsMeters).toBeLessThan(0.04);
    expect(result.diagnostics.residualMadMeters).toBeGreaterThan(0);
    expect(result.diagnostics.residualP95Meters).toBeLessThan(
      result.diagnostics.fitThresholdMeters,
    );
    expect(result.plane.offsetMeters).toBeCloseTo(10, 2);
  });
  it("is deterministic and does not retain mutable input configuration", () => {
    const input = inputPlane();
    const previous = new Float32Array(input.depth);
    const result = success(fitInferredRoadPlane(input, { seed: 79 }));
    const again = success(fitInferredRoadPlane(input, { seed: 79 }));
    expect(again.plane).toEqual(result.plane);
    expect(again.diagnostics).toEqual(result.diagnostics);
    expect(input.depth).toEqual(previous);
    const point = result.project({ x: 0.4, y: 0.4 });
    (input.roi[0] as Point).x = 0.9;
    input.depth.fill(99);
    expect(result.project({ x: 0.4, y: 0.4 })).toEqual(point);
    expect(Object.isFrozen(result.plane)).toBe(true);
    expect(Object.isFrozen(result.plane.homography)).toBe(true);
  });
  it("supports simple concave road masks while keeping excluded corners out", () => {
    const roi = [
      { x: 0.05, y: 0.05 },
      { x: 0.95, y: 0.05 },
      { x: 0.95, y: 0.45 },
      { x: 0.45, y: 0.45 },
      { x: 0.45, y: 0.95 },
      { x: 0.05, y: 0.95 },
    ];
    const result = success(
      fitInferredRoadPlane(inputPlane([0, 0, -1], 10, 160, 120, 140, roi)),
    );
    expect(result.project({ x: 0.7, y: 0.7 })).toBeNull();
    expect(result.project({ x: 0.3, y: 0.7 })).not.toBeNull();
  });
});
describe("rejects unsuitable inferred geometry", () => {
  it.each([0, -1, NaN, Infinity])(
    "rejects invalid depth %s without manufacturing a scale",
    (value) => {
      const input = inputPlane();
      input.depth.fill(value);
      const result = fitInferredRoadPlane(input);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toBe("invalid-depth");
    },
  );
  it("rejects insufficient valid depth and excessively masked regions", () => {
    const input = inputPlane();
    for (let y = 0; y < input.height; y++)
      for (let x = 0; x < input.width * 0.6; x++)
        input.depth[y * input.width + x] = 0;
    expect(fitInferredRoadPlane(input).ok).toBe(false);
    const masked = fitInferredRoadPlane({
      ...inputPlane(),
      excludedBoxes: [[0, 0, 150, 120]],
    });
    expect(masked.ok).toBe(false);
    if (!masked.ok) expect(masked.reason).toBe("insufficient-support");
  });
  it("rejects a curved surface rather than flattening it into a confident road scale", () => {
    const input = inputPlane();
    for (let y = 0; y < input.height; y++)
      for (let x = 0; x < input.width; x++)
        input.depth[y * input.width + x] =
          10 +
          3 *
            Math.cos((x / input.width) * Math.PI * 2) *
            Math.cos((y / input.height) * Math.PI * 2);
    const result = fitInferredRoadPlane(input);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("non-planar");
  });
  it("rejects two equally supported depth planes", () => {
    const input = inputPlane();
    for (let y = 0; y < input.height; y++)
      for (let x = 0; x < input.width / 2; x++)
        input.depth[y * input.width + x] = 20;
    const result = fitInferredRoadPlane(input);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("non-planar");
  });
  it("rejects an ROI reaching the plane horizon", () => {
    const roi = [
      { x: 0.1, y: 0.5 },
      { x: 0.9, y: 0.5 },
      { x: 0.9, y: 0.95 },
      { x: 0.1, y: 0.95 },
    ];
    const result = fitInferredRoadPlane(
      inputPlane([0, -1, 0], 2, 160, 120, 140, roi),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("unsafe-projection");
  });
  it("rejects ill-conditioned tiny angular support", () => {
    const result = fitInferredRoadPlane(
      inputPlane([0, 0, -1], 10, 160, 120, 1e8),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("ill-conditioned");
  });
  it("rejects malformed raster, focal length, ROI and fit options", () => {
    const valid = inputPlane();
    for (const input of [
      { ...valid, depth: new Float32Array(12) },
      { ...valid, focalLengthPx: 0 },
      { ...valid, focalLengthPx: Infinity },
      { ...valid, roi: [fullRoi[0], fullRoi[2], fullRoi[1], fullRoi[3]] },
      { ...valid, roi: [{ x: -1, y: 0 }, ...fullRoi.slice(1)] },
      { ...valid, excludedBoxes: [[0, 0, NaN, 5] as const] },
    ]) {
      const result = fitInferredRoadPlane(input);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toBe("invalid-input");
    }
    expect(
      fitInferredRoadPlane(valid, { relativeDistanceThreshold: 0 }).ok,
    ).toBe(false);
    expect(fitInferredRoadPlane(valid, { maxSamples: 0 }).ok).toBe(false);
  });
});
