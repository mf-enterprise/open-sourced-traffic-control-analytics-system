import type { Point } from "./types";
export type Vector3 = readonly [number, number, number];
export type Homography3 = readonly [
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
];
export interface CameraIntrinsicsPx {
  readonly fx: number;
  readonly fy: number;
  readonly cx: number;
  readonly cy: number;
}
interface InferredRoadPlaneData {
  depth: Float32Array;
  width: number;
  height: number;
  roi: readonly Point[];
  excludedBoxes?: readonly (readonly [number, number, number, number])[];
}
export type InferredRoadPlaneInput = InferredRoadPlaneData &
  (
    | {
        focalLengthPx: number;
        intrinsics?: CameraIntrinsicsPx;
      }
    | {
        intrinsics: CameraIntrinsicsPx;
        focalLengthPx?: number;
      }
  );
export type RoadPlaneAssumption =
  | "zero-skew-pinhole"
  | "square-pixels"
  | "centred-principal-point"
  | "uncorrected-lens-distortion";
export interface RoadPlaneFitOptions {
  seed?: number;
  maxSamples?: number;
  ransacIterations?: number;
  relativeDistanceThreshold?: number;
  minimumInlierFraction?: number;
  minimumValidFraction?: number;
  minimumSpatialCoverage?: number;
  minimumRayCosine?: number;
  maximumPlanarityRatio?: number;
}
export interface InferredRoadPlane {
  readonly kind: "model-inferred";
  readonly method: "depth-plane-ransac-pca-v1" | "depth-plane-ransac-pca-v2";
  readonly depthConvention: "camera-z";
  readonly assumptions: readonly RoadPlaneAssumption[];
  readonly width: number;
  readonly height: number;
  readonly focalLengthPx: number | null;
  readonly intrinsics: Readonly<CameraIntrinsicsPx>;
  readonly intrinsicsConvention: "image-edge-pixels";
  readonly roi: readonly Readonly<Point>[];
  readonly normal: Vector3;
  readonly offsetMeters: number;
  readonly origin: Vector3;
  readonly basisX: Vector3;
  readonly basisY: Vector3;
  readonly homography: Homography3;
  readonly minimumRayCosine: number;
}
export interface RoadPlaneFitDiagnostics {
  sampledRoiPoints: number;
  unmaskedPoints: number;
  validDepthPoints: number;
  validDepthFraction: number;
  inlierCount: number;
  inlierFraction: number;
  spatialCoverage: number;
  medianPredictedDepthMeters: number;
  fitThresholdMeters: number;
  residualRmsMeters: number;
  residualMadMeters: number;
  residualP95Meters: number;
  planarityRatio: number;
  supportRatio: number;
}
export type RoadPlaneFitFailure =
  | "invalid-input"
  | "insufficient-support"
  | "invalid-depth"
  | "non-planar"
  | "ill-conditioned"
  | "unsafe-projection";
export type InferredRoadPlaneResult =
  | {
      ok: true;
      plane: InferredRoadPlane;
      diagnostics: RoadPlaneFitDiagnostics;
      project: (point: Point) => Point | null;
      intersect: (point: Point) => Vector3 | null;
    }
  | {
      ok: false;
      reason: RoadPlaneFitFailure;
      message: string;
      diagnostics: Partial<RoadPlaneFitDiagnostics>;
    };
type Sample = {
  position: Vector3;
  cell: number;
};
type PlaneEquation = {
  normal: Vector3;
  offset: number;
};
type Options = Required<RoadPlaneFitOptions>;
const DEFAULTS: Options = {
  seed: 0x1a2b3c4d,
  maxSamples: 4096,
  ransacIterations: 256,
  relativeDistanceThreshold: 0.015,
  minimumInlierFraction: 0.7,
  minimumValidFraction: 0.6,
  minimumSpatialCoverage: 0.75,
  minimumRayCosine: 0.035,
  maximumPlanarityRatio: 0.04,
};
const MIN_SAMPLES = 48;
const EPSILON = 1e-12;
const dot = (a: Vector3, b: Vector3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const minus = (a: Vector3, b: Vector3): Vector3 => [
  a[0] - b[0],
  a[1] - b[1],
  a[2] - b[2],
];
const times = (v: Vector3, value: number): Vector3 => [
  v[0] * value,
  v[1] * value,
  v[2] * value,
];
const cross3 = (a: Vector3, b: Vector3): Vector3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const length = (v: Vector3) => Math.hypot(...v);
function normalized(v: Vector3): Vector3 | null {
  const size = length(v);
  return Number.isFinite(size) && size > EPSILON ? times(v, 1 / size) : null;
}
function median(values: number[]): number {
  values.sort((a, b) => a - b);
  const middle = Math.floor(values.length / 2);
  return values.length % 2
    ? values[middle]
    : (values[middle - 1] + values[middle]) / 2;
}
function signedArea(a: Point, b: Point, c: Point) {
  return (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
}
function onSegment(p: Point, a: Point, b: Point) {
  return (
    Math.abs(signedArea(a, b, p)) <= EPSILON &&
    p.x >= Math.min(a.x, b.x) - EPSILON &&
    p.x <= Math.max(a.x, b.x) + EPSILON &&
    p.y >= Math.min(a.y, b.y) - EPSILON &&
    p.y <= Math.max(a.y, b.y) + EPSILON
  );
}
function segmentsIntersect(a: Point, b: Point, c: Point, d: Point) {
  const abC = signedArea(a, b, c),
    abD = signedArea(a, b, d),
    cdA = signedArea(c, d, a),
    cdB = signedArea(c, d, b);
  return (
    (abC * abD < 0 && cdA * cdB < 0) ||
    onSegment(c, a, b) ||
    onSegment(d, a, b) ||
    onSegment(a, c, d) ||
    onSegment(b, c, d)
  );
}
function validPolygon(roi: readonly Point[]) {
  if (
    !Array.isArray(roi) ||
    roi.length < 3 ||
    roi.length > 32 ||
    roi.some(
      (p) =>
        !p ||
        !Number.isFinite(p.x) ||
        !Number.isFinite(p.y) ||
        p.x < 0 ||
        p.x > 1 ||
        p.y < 0 ||
        p.y > 1,
    )
  )
    return false;
  let area = 0;
  for (let i = 0; i < roi.length; i++) {
    const a = roi[i],
      b = roi[(i + 1) % roi.length];
    if (Math.hypot(a.x - b.x, a.y - b.y) < 1e-6) return false;
    area += a.x * b.y - a.y * b.x;
    for (let j = i + 1; j < roi.length; j++) {
      if (j === i + 1 || (i === 0 && j === roi.length - 1)) continue;
      if (segmentsIntersect(a, b, roi[j], roi[(j + 1) % roi.length]))
        return false;
    }
  }
  return Math.abs(area) >= 0.0002;
}
function inside(point: Point, roi: readonly Point[]) {
  if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) return false;
  let result = false;
  for (let i = 0, j = roi.length - 1; i < roi.length; j = i++) {
    const a = roi[j],
      b = roi[i];
    if (onSegment(point, a, b)) return true;
    if (
      a.y > point.y !== b.y > point.y &&
      point.x < ((b.x - a.x) * (point.y - a.y)) / (b.y - a.y) + a.x
    )
      result = !result;
  }
  return result;
}
function cameraRay(
  point: Point,
  width: number,
  height: number,
  intrinsics: CameraIntrinsicsPx,
): Vector3 {
  return [
    (point.x * width - intrinsics.cx) / intrinsics.fx,
    (point.y * height - intrinsics.cy) / intrinsics.fy,
    1,
  ];
}
function resolveIntrinsics(
  input: InferredRoadPlaneInput,
): CameraIntrinsicsPx | null {
  const { focalLengthPx: focal, intrinsics, width, height } = input;
  if (focal !== undefined && (!Number.isFinite(focal) || focal <= 0))
    return null;
  if (intrinsics !== undefined) {
    if (
      !intrinsics ||
      typeof intrinsics !== "object" ||
      Array.isArray(intrinsics) ||
      Object.keys(intrinsics).some(
        (key) => !["fx", "fy", "cx", "cy"].includes(key),
      ) ||
      ![intrinsics.fx, intrinsics.fy, intrinsics.cx, intrinsics.cy].every(
        Number.isFinite,
      ) ||
      intrinsics.fx <= 0 ||
      intrinsics.fy <= 0
    )
      return null;
    if (
      focal !== undefined &&
      (intrinsics.fx !== focal ||
        intrinsics.fy !== focal ||
        intrinsics.cx !== width / 2 ||
        intrinsics.cy !== height / 2)
    )
      return null;
    return {
      fx: intrinsics.fx,
      fy: intrinsics.fy,
      cx: intrinsics.cx,
      cy: intrinsics.cy,
    };
  }
  return focal === undefined
    ? null
    : { fx: focal, fy: focal, cx: width / 2, cy: height / 2 };
}
function orient(normal: Vector3, point: Vector3): PlaneEquation {
  const offset = -dot(normal, point);
  return offset < 0
    ? { normal: times(normal, -1), offset: -offset }
    : { normal, offset };
}
function threePointPlane(
  a: Vector3,
  b: Vector3,
  c: Vector3,
): PlaneEquation | null {
  const ab = minus(b, a),
    ac = minus(c, a),
    normal = cross3(ab, ac);
  if (length(normal) <= length(ab) * length(ac) * 0.001) return null;
  const unit = normalized(normal);
  return unit ? orient(unit, a) : null;
}
function residual(plane: PlaneEquation, sample: Sample) {
  return dot(plane.normal, sample.position) + plane.offset;
}
function eigenSymmetric(matrix: number[][]) {
  const a = matrix.map((row) => [...row]);
  const vectors = [
    [1, 0, 0],
    [0, 1, 0],
    [0, 0, 1],
  ];
  for (let iteration = 0; iteration < 40; iteration++) {
    let p = 0,
      q = 1;
    for (const [i, j] of [
      [0, 2],
      [1, 2],
    ])
      if (Math.abs(a[i][j]) > Math.abs(a[p][q])) {
        p = i;
        q = j;
      }
    if (
      Math.abs(a[p][q]) <=
      Math.max(
        1e-30,
        Math.abs(a[0][0]) + Math.abs(a[1][1]) + Math.abs(a[2][2]),
      ) *
        1e-13
    )
      break;
    const tau = (a[q][q] - a[p][p]) / (2 * a[p][q]);
    const t = (tau >= 0 ? 1 : -1) / (Math.abs(tau) + Math.hypot(1, tau));
    const c = 1 / Math.hypot(1, t),
      s = t * c,
      offDiagonal = a[p][q];
    a[p][p] -= t * offDiagonal;
    a[q][q] += t * offDiagonal;
    a[p][q] = a[q][p] = 0;
    for (let i = 0; i < 3; i++) {
      if (i !== p && i !== q) {
        const ip = a[i][p],
          iq = a[i][q];
        a[i][p] = a[p][i] = c * ip - s * iq;
        a[i][q] = a[q][i] = s * ip + c * iq;
      }
      const vp = vectors[i][p],
        vq = vectors[i][q];
      vectors[i][p] = c * vp - s * vq;
      vectors[i][q] = s * vp + c * vq;
    }
  }
  return [0, 1, 2]
    .map((index) => ({
      value: Math.max(0, a[index][index]),
      vector: [
        vectors[0][index],
        vectors[1][index],
        vectors[2][index],
      ] as Vector3,
    }))
    .sort((a, b) => a.value - b.value);
}
function refine(samples: Sample[], indexes: number[], scale: number) {
  const centre = [0, 0, 0];
  for (const index of indexes)
    for (let axis = 0; axis < 3; axis++)
      centre[axis] += samples[index].position[axis] / indexes.length;
  const covariance = [
    [0, 0, 0],
    [0, 0, 0],
    [0, 0, 0],
  ];
  for (const index of indexes) {
    const point = samples[index].position.map(
      (value, axis) => (value - centre[axis]) / scale,
    );
    for (let row = 0; row < 3; row++)
      for (let column = row; column < 3; column++)
        covariance[row][column] +=
          (point[row] * point[column]) / indexes.length;
  }
  for (let row = 0; row < 3; row++)
    for (let column = row + 1; column < 3; column++)
      covariance[column][row] = covariance[row][column];
  const eigen = eigenSymmetric(covariance);
  const normal = normalized(eigen[0].vector);
  if (!normal || eigen.some((entry) => !Number.isFinite(entry.value)))
    return null;
  return {
    ...orient(normal, centre as unknown as Vector3),
    centre: centre as unknown as Vector3,
    eigenvalues: eigen.map((entry) => entry.value),
  };
}
function randomGenerator(seed: number) {
  let state = seed >>> 0 || 0x1a2b3c4d;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 0x100000000;
  };
}
export function intersectInferredRoadPlane(
  plane: InferredRoadPlane,
  point: Point,
): Vector3 | null {
  if (!inside(point, plane.roi)) return null;
  const intrinsics =
    plane.intrinsics ??
    (plane.method === "depth-plane-ransac-pca-v1" &&
    plane.focalLengthPx !== null &&
    Number.isFinite(plane.focalLengthPx) &&
    plane.focalLengthPx > 0
      ? {
          fx: plane.focalLengthPx,
          fy: plane.focalLengthPx,
          cx: plane.width / 2,
          cy: plane.height / 2,
        }
      : null);
  if (!intrinsics) return null;
  const ray = cameraRay(point, plane.width, plane.height, intrinsics);
  const denominator = dot(plane.normal, ray);
  if (
    !Number.isFinite(denominator) ||
    Math.abs(denominator) / length(ray) < plane.minimumRayCosine
  )
    return null;
  const z = -plane.offsetMeters / denominator;
  if (!Number.isFinite(z) || z <= 0) return null;
  const result = times(ray, z);
  return result.every(Number.isFinite) ? result : null;
}
export function projectInferredRoadPoint(
  plane: InferredRoadPlane,
  point: Point,
): Point | null {
  const intersection = intersectInferredRoadPlane(plane, point);
  if (!intersection) return null;
  const relative = minus(intersection, plane.origin);
  return { x: dot(plane.basisX, relative), y: dot(plane.basisY, relative) };
}
export function fitInferredRoadPlane(
  input: InferredRoadPlaneInput,
  options: RoadPlaneFitOptions = {},
): InferredRoadPlaneResult {
  const diagnostics: Partial<RoadPlaneFitDiagnostics> = {};
  const fail = (
    reason: RoadPlaneFitFailure,
    message: string,
  ): InferredRoadPlaneResult => ({
    ok: false,
    reason,
    message,
    diagnostics: { ...diagnostics },
  });
  const settings: Options = { ...DEFAULTS, ...options };
  const { depth, width, height, roi } = input;
  const intrinsics = resolveIntrinsics(input);
  if (
    !(depth instanceof Float32Array) ||
    !Number.isSafeInteger(width) ||
    !Number.isSafeInteger(height) ||
    width < 8 ||
    height < 8 ||
    width > 16384 ||
    height > 16384 ||
    depth.length !== width * height ||
    !intrinsics ||
    !validPolygon(roi)
  )
    return fail(
      "invalid-input",
      "Provide an aligned metric Z-depth raster, valid zero-skew camera intrinsics (or a consistent positive focal length) and a simple normalized road polygon.",
    );
  if (
    !Number.isInteger(settings.seed) ||
    !Number.isInteger(settings.maxSamples) ||
    settings.maxSamples < MIN_SAMPLES ||
    settings.maxSamples > 16384 ||
    !Number.isInteger(settings.ransacIterations) ||
    settings.ransacIterations < 16 ||
    settings.ransacIterations > 2048 ||
    !Number.isFinite(settings.relativeDistanceThreshold) ||
    settings.relativeDistanceThreshold <= 0 ||
    settings.relativeDistanceThreshold > 0.1 ||
    [
      settings.minimumInlierFraction,
      settings.minimumValidFraction,
      settings.minimumSpatialCoverage,
      settings.minimumRayCosine,
      settings.maximumPlanarityRatio,
    ].some((value) => !Number.isFinite(value) || value <= 0 || value > 1)
  )
    return fail(
      "invalid-input",
      "Plane-fitting options are outside their supported ranges.",
    );
  const boxes = input.excludedBoxes ?? [];
  if (
    !Array.isArray(boxes) ||
    boxes.some(
      (box) =>
        !Array.isArray(box) ||
        box.length !== 4 ||
        !box.every(Number.isFinite) ||
        box[2] <= 0 ||
        box[3] <= 0,
    )
  )
    return fail(
      "invalid-input",
      "Excluded boxes must be finite positive pixel rectangles.",
    );
  const minX = Math.min(...roi.map((p) => p.x)),
    maxX = Math.max(...roi.map((p) => p.x));
  const minY = Math.min(...roi.map((p) => p.y)),
    maxY = Math.max(...roi.map((p) => p.y));
  const left = Math.max(0, Math.floor(minX * width)),
    right = Math.min(width, Math.ceil(maxX * width));
  const top = Math.max(0, Math.floor(minY * height)),
    bottom = Math.min(height, Math.ceil(maxY * height));
  const rows = Math.min(
    bottom - top,
    settings.maxSamples,
    Math.max(
      4,
      Math.floor(
        Math.sqrt((settings.maxSamples * (bottom - top)) / (right - left)),
      ),
    ),
  );
  const columns = Math.min(
    right - left,
    Math.max(1, Math.floor(settings.maxSamples / rows)),
  );
  const samples: Sample[] = [],
    cellPopulation = Array<number>(16).fill(0);
  let roiCount = 0,
    unmasked = 0;
  for (let row = 0; row < rows; row++)
    for (let column = 0; column < columns; column++) {
      const x = left + Math.floor(((column + 0.5) * (right - left)) / columns);
      const y = top + Math.floor(((row + 0.5) * (bottom - top)) / rows);
      const point = { x: (x + 0.5) / width, y: (y + 0.5) / height };
      if (!inside(point, roi)) continue;
      roiCount++;
      const cell =
        Math.min(3, Math.floor(((point.x - minX) / (maxX - minX)) * 4)) +
        4 * Math.min(3, Math.floor(((point.y - minY) / (maxY - minY)) * 4));
      cellPopulation[cell]++;
      if (
        boxes.some(
          ([bx, by, bw, bh]) =>
            x + 0.5 >= bx &&
            x + 0.5 <= bx + bw &&
            y + 0.5 >= by &&
            y + 0.5 <= by + bh,
        )
      )
        continue;
      unmasked++;
      const z = depth[y * width + x];
      if (!Number.isFinite(z) || z <= 0) continue;
      const position = times(cameraRay(point, width, height, intrinsics), z);
      if (position.every(Number.isFinite)) samples.push({ position, cell });
    }
  Object.assign(diagnostics, {
    sampledRoiPoints: roiCount,
    unmaskedPoints: unmasked,
    validDepthPoints: samples.length,
    validDepthFraction: unmasked ? samples.length / unmasked : 0,
  });
  if (
    roiCount < MIN_SAMPLES ||
    unmasked < MIN_SAMPLES ||
    unmasked / roiCount < 0.35
  )
    return fail(
      "insufficient-support",
      "Too little unoccluded road is available for a two-dimensional plane fit.",
    );
  if (
    samples.length < MIN_SAMPLES ||
    samples.length / unmasked < settings.minimumValidFraction
  )
    return fail(
      "invalid-depth",
      "Too few road pixels have finite positive predicted depth.",
    );
  const scale = median(samples.map((sample) => sample.position[2]));
  const threshold = scale * settings.relativeDistanceThreshold;
  Object.assign(diagnostics, {
    medianPredictedDepthMeters: scale,
    fitThresholdMeters: threshold,
  });
  if (!Number.isFinite(threshold) || threshold <= 1e-12)
    return fail("invalid-depth", "Predicted depths are numerically unusable.");
  const random = randomGenerator(settings.seed);
  let best: PlaneEquation | null = null,
    bestCount = 0,
    bestCost = Infinity;
  for (let iteration = 0; iteration < settings.ransacIterations; iteration++) {
    const a = Math.floor(random() * samples.length),
      b = Math.floor(random() * samples.length),
      c = Math.floor(random() * samples.length);
    if (a === b || a === c || b === c) continue;
    const plane = threePointPlane(
      samples[a].position,
      samples[b].position,
      samples[c].position,
    );
    if (!plane) continue;
    let count = 0,
      cost = 0;
    for (const sample of samples) {
      const distance = Math.abs(residual(plane, sample));
      if (distance <= threshold) {
        count++;
        cost += (distance / threshold) ** 2;
      }
    }
    if (count > bestCount || (count === bestCount && cost < bestCost)) {
      best = plane;
      bestCount = count;
      bestCost = cost;
    }
  }
  if (!best || bestCount < MIN_SAMPLES)
    return fail(
      "ill-conditioned",
      "The available depth points do not determine a stable plane.",
    );
  let indexes = samples
    .map((_, i) => i)
    .filter((i) => Math.abs(residual(best!, samples[i])) <= threshold);
  let fit = refine(samples, indexes, scale);
  let converged = false;
  for (let iteration = 0; iteration < 32 && fit; iteration++) {
    const next = samples
      .map((_, i) => i)
      .filter((i) => Math.abs(residual(fit!, samples[i])) <= threshold);
    if (next.length < MIN_SAMPLES)
      return fail(
        "non-planar",
        "The road prediction has too little consistent plane support.",
      );
    if (
      next.length === indexes.length &&
      next.every((value, i) => value === indexes[i])
    ) {
      converged = true;
      break;
    }
    indexes = next;
    fit = refine(samples, indexes, scale);
  }
  if (!fit)
    return fail("ill-conditioned", "Plane refinement is numerically unstable.");
  if (!converged)
    return fail(
      "ill-conditioned",
      "Plane support did not stabilize within the refinement limit.",
    );
  const [small, middle, large] = fit.eigenvalues;
  const planarityRatio = middle > 0 ? small / middle : Infinity,
    supportRatio = large > 0 ? middle / large : 0;
  const cellInliers = Array<number>(16).fill(0);
  const signedResiduals = indexes.map((index) => {
    cellInliers[samples[index].cell]++;
    return residual(fit!, samples[index]);
  });
  const absResiduals = signedResiduals.map(Math.abs).sort((a, b) => a - b);
  const residualMedian = median([...signedResiduals]);
  const populatedCells = cellPopulation.filter((count) => count >= 3).length;
  const coveredCells = cellInliers.filter(
    (count, cell) =>
      cellPopulation[cell] >= 3 &&
      count >= Math.max(3, Math.ceil(cellPopulation[cell] * 0.25)),
  ).length;
  Object.assign(diagnostics, {
    inlierCount: indexes.length,
    inlierFraction: indexes.length / samples.length,
    spatialCoverage: populatedCells ? coveredCells / populatedCells : 0,
    residualRmsMeters: Math.sqrt(
      signedResiduals.reduce((sum, value) => sum + value * value, 0) /
        indexes.length,
    ),
    residualMadMeters: median(
      signedResiduals.map((value) => Math.abs(value - residualMedian)),
    ),
    residualP95Meters:
      absResiduals[
        Math.min(
          absResiduals.length - 1,
          Math.floor(absResiduals.length * 0.95),
        )
      ],
    planarityRatio,
    supportRatio,
  });
  if (middle < 1e-8 || supportRatio < 1e-4)
    return fail(
      "ill-conditioned",
      "Plane support is too small or nearly collinear to infer stable distances.",
    );
  if (
    indexes.length / samples.length < settings.minimumInlierFraction ||
    planarityRatio > settings.maximumPlanarityRatio
  )
    return fail(
      "non-planar",
      "The selected road region does not have a sufficiently consistent predicted plane.",
    );
  if (diagnostics.spatialCoverage! < settings.minimumSpatialCoverage)
    return fail(
      "insufficient-support",
      "Consistent depth points do not cover enough of the selected road region.",
    );
  if (
    fit.offset <= scale * 1e-5 ||
    roi.some((point) => {
      const ray = cameraRay(point, width, height, intrinsics),
        denominator = dot(fit!.normal, ray);
      return (
        denominator >= 0 ||
        Math.abs(denominator) / length(ray) < settings.minimumRayCosine
      );
    })
  )
    return fail(
      "unsafe-projection",
      "The selected region approaches the plane horizon or projects behind the camera.",
    );
  const projectedRight = minus([1, 0, 0], times(fit.normal, fit.normal[0]));
  const basisX =
    normalized(projectedRight) ??
    normalized(minus([0, 1, 0], times(fit.normal, fit.normal[1])))!;
  const basisY = normalized(cross3(fit.normal, basisX))!;
  const origin = minus(
    fit.centre,
    times(fit.normal, dot(fit.normal, fit.centre) + fit.offset),
  );
  const rayCoefficients = (axis: Vector3): Vector3 => [
    (axis[0] * width) / intrinsics.fx,
    (axis[1] * height) / intrinsics.fy,
    axis[2] -
      (axis[0] * intrinsics.cx) / intrinsics.fx -
      (axis[1] * intrinsics.cy) / intrinsics.fy,
  ];
  const denominator = rayCoefficients(fit.normal);
  const row = (axis: Vector3): Vector3 => {
    const coefficients = rayCoefficients(axis),
      translation = dot(axis, origin);
    return coefficients.map(
      (value, i) => -fit!.offset * value - translation * denominator[i],
    ) as unknown as Vector3;
  };
  const homography = [
    ...row(basisX),
    ...row(basisY),
    ...denominator,
  ] as unknown as Homography3;
  if (!homography.every(Number.isFinite))
    return fail(
      "ill-conditioned",
      "The inferred image-to-plane transform is not finite.",
    );
  const plane: InferredRoadPlane = Object.freeze({
    kind: "model-inferred",
    method:
      input.intrinsics === undefined
        ? "depth-plane-ransac-pca-v1"
        : "depth-plane-ransac-pca-v2",
    depthConvention: "camera-z",
    assumptions: Object.freeze(
      input.intrinsics === undefined
        ? ([
            "zero-skew-pinhole",
            "square-pixels",
            "centred-principal-point",
            "uncorrected-lens-distortion",
          ] as const)
        : (["zero-skew-pinhole", "uncorrected-lens-distortion"] as const),
    ),
    width,
    height,
    focalLengthPx: intrinsics.fx === intrinsics.fy ? intrinsics.fx : null,
    intrinsics: Object.freeze({ ...intrinsics }),
    intrinsicsConvention: "image-edge-pixels",
    roi: Object.freeze(roi.map((point) => Object.freeze({ ...point }))),
    normal: Object.freeze([...fit.normal]) as Vector3,
    offsetMeters: fit.offset,
    origin: Object.freeze([...origin]) as Vector3,
    basisX: Object.freeze([...basisX]) as Vector3,
    basisY: Object.freeze([...basisY]) as Vector3,
    homography: Object.freeze([...homography]) as Homography3,
    minimumRayCosine: settings.minimumRayCosine,
  });
  return {
    ok: true,
    plane,
    diagnostics: diagnostics as RoadPlaneFitDiagnostics,
    project: (point) => projectInferredRoadPoint(plane, point),
    intersect: (point) => intersectInferredRoadPlane(plane, point),
  };
}
