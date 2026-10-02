import type { Detection } from "./types";
export interface CameraFrame {
  data: Uint8Array | Uint8ClampedArray;
  width: number;
  height: number;
  channels: 1 | 3 | 4;
}
declare const referenceBrand: unique symbol;
export interface CameraReference {
  readonly [referenceBrand]: true;
  readonly width: number;
  readonly height: number;
  readonly sampledWidth: number;
  readonly sampledHeight: number;
  readonly featureCount: number;
}
export interface CameraStabilityAssessment {
  state: "stable" | "moved" | "unverifiable";
  reason: string;
  matched: number;
  displacementPixels: number | null;
}
export type CameraStabilityStatus = Omit<CameraStabilityAssessment, "state"> & {
  state: CameraStabilityAssessment["state"] | "uncalibrated";
};
const MAX_WIDTH = 384,
  MAX_HEIGHT = 256;
const RADIUS = 5,
  PATCH_SIDE = 11,
  PATCH_PIXELS = 121,
  SEARCH = 18;
const GRID_X = 6,
  GRID_Y = 4,
  MAX_FEATURES = 48,
  MIN_MATCHES = 12;
const MIN_CORRELATION = 0.9,
  UNIQUENESS = 0.08;
interface Image {
  pixels: Float32Array;
  width: number;
  height: number;
  maskIntegral: Uint32Array;
}
interface Feature {
  x: number;
  y: number;
  patch: Float32Array;
  norm: number;
}
interface Match {
  x: number;
  y: number;
  u: number;
  v: number;
}
interface ReferenceData {
  features: Feature[];
}
const references = new WeakMap<CameraReference, ReferenceData>();
function prepare(
  frame: CameraFrame,
  detections: readonly Detection[],
): Image | null {
  if (
    !frame ||
    !(
      frame.data instanceof Uint8Array ||
      frame.data instanceof Uint8ClampedArray
    ) ||
    !Number.isInteger(frame.width) ||
    !Number.isInteger(frame.height) ||
    frame.width < 64 ||
    frame.height < 64 ||
    frame.width > 8192 ||
    frame.height > 8192 ||
    frame.width * frame.height > 33554432 ||
    ![1, 3, 4].includes(frame.channels) ||
    frame.data.length !== frame.width * frame.height * frame.channels ||
    !Array.isArray(detections) ||
    detections.length > 1000
  )
    return null;
  const scale = Math.min(1, MAX_WIDTH / frame.width, MAX_HEIGHT / frame.height);
  const width = Math.floor(frame.width * scale),
    height = Math.floor(frame.height * scale);
  if (width < 64 || height < 64) return null;
  const pixels = new Float32Array(width * height);
  const sx = frame.width / width,
    sy = frame.height / height;
  const intensity = (x: number, y: number) => {
    const i = (y * frame.width + x) * frame.channels;
    return frame.channels === 1
      ? frame.data[i]
      : 0.299 * frame.data[i] +
          0.587 * frame.data[i + 1] +
          0.114 * frame.data[i + 2];
  };
  const bilinear = (x: number, y: number) => {
    const cx = Math.max(0, Math.min(frame.width - 1, x)),
      cy = Math.max(0, Math.min(frame.height - 1, y));
    const x0 = Math.floor(cx),
      y0 = Math.floor(cy),
      x1 = Math.min(frame.width - 1, x0 + 1),
      y1 = Math.min(frame.height - 1, y0 + 1);
    const fx = cx - x0,
      fy = cy - y0;
    return (
      (intensity(x0, y0) * (1 - fx) + intensity(x1, y0) * fx) * (1 - fy) +
      (intensity(x0, y1) * (1 - fx) + intensity(x1, y1) * fx) * fy
    );
  };
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      if (scale === 1) {
        pixels[y * width + x] = intensity(x, y);
        continue;
      }
      const x0 = (x + 0.25) * sx - 0.5,
        x1 = (x + 0.75) * sx - 0.5;
      const y0 = (y + 0.25) * sy - 0.5,
        y1 = (y + 0.75) * sy - 0.5;
      pixels[y * width + x] =
        (bilinear(x0, y0) +
          bilinear(x1, y0) +
          bilinear(x0, y1) +
          bilinear(x1, y1)) /
        4;
    }
  const mask = new Uint8Array(width * height);
  for (const detection of detections) {
    const box = detection?.bbox;
    if (
      !Array.isArray(box) ||
      box.length !== 4 ||
      !box.every(Number.isFinite) ||
      box[2] <= 0 ||
      box[3] <= 0
    )
      return null;
    const mx = Math.max(3, (box[2] / sx) * 0.15),
      my = Math.max(3, (box[3] / sy) * 0.15);
    const x0 = Math.min(width, Math.max(0, Math.floor(box[0] / sx - mx)));
    const x1 = Math.max(
      0,
      Math.min(width, Math.ceil((box[0] + box[2]) / sx + mx)),
    );
    const y0 = Math.min(height, Math.max(0, Math.floor(box[1] / sy - my)));
    const y1 = Math.max(
      0,
      Math.min(height, Math.ceil((box[1] + box[3]) / sy + my)),
    );
    if (x1 <= x0 || y1 <= y0) continue;
    for (let y = y0; y < y1; y++) mask.fill(1, y * width + x0, y * width + x1);
  }
  const maskIntegral = new Uint32Array((width + 1) * (height + 1));
  for (let y = 0; y < height; y++) {
    let row = 0;
    for (let x = 0; x < width; x++) {
      row += mask[y * width + x];
      maskIntegral[(y + 1) * (width + 1) + x + 1] =
        maskIntegral[y * (width + 1) + x + 1] + row;
    }
  }
  return { pixels, width, height, maskIntegral };
}
function clearPatch(image: Image, x: number, y: number): boolean {
  if (
    x < RADIUS ||
    y < RADIUS ||
    x >= image.width - RADIUS ||
    y >= image.height - RADIUS
  )
    return false;
  const w = image.width + 1,
    p = image.maskIntegral;
  const x0 = x - RADIUS,
    y0 = y - RADIUS,
    x1 = x + RADIUS + 1,
    y1 = y + RADIUS + 1;
  return (
    p[y1 * w + x1] - p[y0 * w + x1] - p[y1 * w + x0] + p[y0 * w + x0] === 0
  );
}
function featureAt(image: Image, x: number, y: number): Feature | null {
  if (!clearPatch(image, x, y)) return null;
  const patch = new Float32Array(PATCH_PIXELS);
  let sum = 0,
    k = 0;
  for (let dy = -RADIUS; dy <= RADIUS; dy++)
    for (let dx = -RADIUS; dx <= RADIUS; dx++) {
      const value = image.pixels[(y + dy) * image.width + x + dx];
      patch[k++] = value;
      sum += value;
    }
  const mean = sum / PATCH_PIXELS;
  let norm = 0;
  for (let i = 0; i < patch.length; i++) {
    patch[i] -= mean;
    norm += patch[i] ** 2;
  }
  if (norm < PATCH_PIXELS * 8 ** 2) return null;
  return { x, y, patch, norm: Math.sqrt(norm) };
}
function correlation(
  feature: Feature,
  image: Image,
  x: number,
  y: number,
): number {
  if (!clearPatch(image, x, y)) return -1;
  let sum = 0,
    squares = 0,
    product = 0,
    k = 0;
  for (let dy = -RADIUS; dy <= RADIUS; dy++) {
    let index = (y + dy) * image.width + x - RADIUS;
    for (let dx = 0; dx < PATCH_SIDE; dx++) {
      const value = image.pixels[index++];
      sum += value;
      squares += value * value;
      product += feature.patch[k++] * value;
    }
  }
  const variance = squares - (sum * sum) / PATCH_PIXELS;
  return variance >= PATCH_PIXELS * 6 ** 2
    ? product / (feature.norm * Math.sqrt(variance))
    : -1;
}
function match(feature: Feature, image: Image): Match | null {
  const values = new Float32Array((2 * SEARCH + 1) ** 2);
  let best = -1,
    bx = 0,
    by = 0,
    k = 0;
  for (let dy = -SEARCH; dy <= SEARCH; dy++)
    for (let dx = -SEARCH; dx <= SEARCH; dx++) {
      const score = correlation(feature, image, feature.x + dx, feature.y + dy);
      values[k++] = score;
      if (score > best) {
        best = score;
        bx = dx;
        by = dy;
      }
    }
  if (
    best < MIN_CORRELATION ||
    Math.abs(bx) === SEARCH ||
    Math.abs(by) === SEARCH
  )
    return null;
  let second = -1;
  k = 0;
  for (let dy = -SEARCH; dy <= SEARCH; dy++)
    for (let dx = -SEARCH; dx <= SEARCH; dx++) {
      if (Math.max(Math.abs(dx - bx), Math.abs(dy - by)) > 2)
        second = Math.max(second, values[k]);
      k++;
    }
  if (best - second < UNIQUENESS) return null;
  const peak = (minus: number, plus: number) => {
    const denominator = minus - 2 * best + plus;
    return denominator < -1e-6
      ? Math.max(-0.5, Math.min(0.5, (0.5 * (minus - plus)) / denominator))
      : 0;
  };
  const x = feature.x + bx,
    y = feature.y + by;
  const ox = peak(
    correlation(feature, image, x - 1, y),
    correlation(feature, image, x + 1, y),
  );
  const oy = peak(
    correlation(feature, image, x, y - 1),
    correlation(feature, image, x, y + 1),
  );
  return { x: feature.x, y: feature.y, u: x + ox, v: y + oy };
}
function distributed(
  points: readonly {
    x: number;
    y: number;
  }[],
  image: Pick<Image, "width" | "height">,
): boolean {
  if (points.length < MIN_MATCHES) return false;
  const cells = new Set(
    points.map(
      (p) =>
        Math.min(GRID_X - 1, Math.floor((p.x / image.width) * GRID_X)) +
        GRID_X *
          Math.min(GRID_Y - 1, Math.floor((p.y / image.height) * GRID_Y)),
    ),
  );
  return (
    cells.size >= 8 &&
    Math.max(...points.map((p) => p.x)) - Math.min(...points.map((p) => p.x)) >=
      image.width * 0.55 &&
    Math.max(...points.map((p) => p.y)) - Math.min(...points.map((p) => p.y)) >=
      image.height * 0.45
  );
}
export function createCameraReference(
  frame: CameraFrame,
  detections: readonly Detection[],
): CameraReference | null {
  const image = prepare(frame, detections);
  if (!image) return null;
  const candidates: {
    x: number;
    y: number;
    score: number;
  }[][] = Array.from({ length: GRID_X * GRID_Y }, () => []);
  for (let y = RADIUS + 2; y < image.height - RADIUS - 2; y += 3)
    for (let x = RADIUS + 2; x < image.width - RADIUS - 2; x += 3) {
      if (!clearPatch(image, x, y)) continue;
      let xx = 0,
        xy = 0,
        yy = 0;
      for (let dy = -2; dy <= 2; dy++)
        for (let dx = -2; dx <= 2; dx++) {
          const at = (y + dy) * image.width + x + dx;
          const gx = (image.pixels[at + 1] - image.pixels[at - 1]) / 2;
          const gy =
            (image.pixels[at + image.width] - image.pixels[at - image.width]) /
            2;
          xx += gx * gx;
          xy += gx * gy;
          yy += gy * gy;
        }
      const score = (xx + yy - Math.hypot(xx - yy, 2 * xy)) / 50;
      if (score < 30) continue;
      const cell =
        Math.floor((x / image.width) * GRID_X) +
        GRID_X * Math.floor((y / image.height) * GRID_Y);
      candidates[cell].push({ x, y, score });
    }
  const features: Feature[] = [];
  for (const cell of candidates) {
    cell.sort((a, b) => b.score - a.score);
    let selected = 0,
      tested = 0;
    for (const candidate of cell) {
      if (selected === 2 || tested >= 6) break;
      if (
        features.some(
          (p) => Math.hypot(p.x - candidate.x, p.y - candidate.y) < 14,
        )
      )
        continue;
      tested++;
      const feature = featureAt(image, candidate.x, candidate.y);
      if (!feature || !match(feature, image)) continue;
      features.push(feature);
      selected++;
    }
  }
  if (!distributed(features, image)) return null;
  const reference = Object.freeze({
    width: frame.width,
    height: frame.height,
    sampledWidth: image.width,
    sampledHeight: image.height,
    featureCount: features.length,
  }) as CameraReference;
  references.set(reference, { features });
  return reference;
}
function median(values: number[]): number {
  values.sort((a, b) => a - b);
  const mid = Math.floor(values.length / 2);
  return values.length % 2 ? values[mid] : (values[mid - 1] + values[mid]) / 2;
}
export function assessCameraStability(
  reference: CameraReference,
  frame: CameraFrame,
  detections: readonly Detection[],
): CameraStabilityAssessment {
  const fail = (reason: string, matched = 0): CameraStabilityAssessment => ({
    state: "unverifiable",
    reason,
    matched,
    displacementPixels: null,
  });
  const saved = references.get(reference);
  if (!saved)
    return fail(
      "The original camera reference is unavailable. Capture a new calibration reference.",
    );
  if (
    !frame ||
    frame.width !== reference.width ||
    frame.height !== reference.height
  )
    return {
      state: "moved",
      reason: "Camera frame dimensions changed. Recalibration is required.",
      matched: 0,
      displacementPixels: null,
    };
  const image = prepare(frame, detections);
  if (!image) return fail("The current frame or object masks are unusable.");
  const matches = saved.features
    .map((feature) => match(feature, image))
    .filter((p): p is Match => !!p);
  return fitCameraCorrespondences(matches, image, reference);
}
export function fitCameraCorrespondences(
  matches: readonly Match[],
  image: Pick<Image, "width" | "height">,
  reference: Pick<CameraReference, "width" | "height" | "featureCount">,
): CameraStabilityAssessment {
  const fail = (reason: string, matched = 0): CameraStabilityAssessment => ({
    state: "unverifiable",
    reason,
    matched,
    displacementPixels: null,
  });
  if (
    !Array.isArray(matches) ||
    matches.length > MAX_FEATURES ||
    matches.some((p) => !p || ![p.x, p.y, p.u, p.v].every(Number.isFinite)) ||
    !image ||
    !reference ||
    ![
      image.width,
      image.height,
      reference.width,
      reference.height,
      reference.featureCount,
    ].every((value) => Number.isFinite(value) && value > 0)
  )
    return fail("The registration inputs are invalid.");
  if (
    matches.length <
      Math.max(MIN_MATCHES, Math.ceil(reference.featureCount * 0.6)) ||
    !distributed(matches, image)
  )
    return fail(
      "Too few distributed background features remain visible and unambiguous.",
      matches.length,
    );
  const as: number[] = [],
    bs: number[] = [];
  for (let i = 0; i < matches.length; i++)
    for (let j = i + 1; j < matches.length; j++) {
      const x = matches[j].x - matches[i].x,
        y = matches[j].y - matches[i].y;
      const u = matches[j].u - matches[i].u,
        v = matches[j].v - matches[i].v;
      const squared = x * x + y * y;
      if (squared < 30 ** 2) continue;
      as.push((x * u + y * v) / squared);
      bs.push((x * v - y * u) / squared);
    }
  if (!as.length)
    return fail("Background matches lack spatial separation.", matches.length);
  let a = median(as),
    b = median(bs);
  let tx = median(matches.map((p) => p.u - a * p.x + b * p.y));
  let ty = median(matches.map((p) => p.v - b * p.x - a * p.y));
  const inliers = matches.filter(
    (p) =>
      Math.hypot(a * p.x - b * p.y + tx - p.u, b * p.x + a * p.y + ty - p.v) <=
      1.25,
  );
  if (inliers.length < matches.length * 0.8 || !distributed(inliers, image))
    return fail(
      "Background matches disagree; camera registration cannot be verified.",
      inliers.length,
    );
  const mean = inliers.reduce(
    (s, p) => ({
      x: s.x + p.x / inliers.length,
      y: s.y + p.y / inliers.length,
      u: s.u + p.u / inliers.length,
      v: s.v + p.v / inliers.length,
    }),
    { x: 0, y: 0, u: 0, v: 0 },
  );
  let denominator = 0,
    numeratorA = 0,
    numeratorB = 0;
  for (const p of inliers) {
    const x = p.x - mean.x,
      y = p.y - mean.y,
      u = p.u - mean.u,
      v = p.v - mean.v;
    denominator += x * x + y * y;
    numeratorA += x * u + y * v;
    numeratorB += x * v - y * u;
  }
  a = numeratorA / denominator;
  b = numeratorB / denominator;
  tx = mean.u - a * mean.x + b * mean.y;
  ty = mean.v - b * mean.x - a * mean.y;
  const finalInliers = matches.filter(
    (p) =>
      Math.hypot(a * p.x - b * p.y + tx - p.u, b * p.x + a * p.y + ty - p.v) <=
      1.25,
  );
  if (
    finalInliers.length < matches.length * 0.8 ||
    !distributed(finalInliers, image)
  )
    return fail(
      "The final registration fit lacks distributed background support.",
      finalInliers.length,
    );
  let displacement = 0,
    nativeDisplacement = 0;
  for (const x of [0, image.width - 1])
    for (const y of [0, image.height - 1]) {
      const dx = a * x - b * y + tx - x,
        dy = b * x + a * y + ty - y;
      displacement = Math.max(displacement, Math.hypot(dx, dy));
      nativeDisplacement = Math.max(
        nativeDisplacement,
        Math.hypot(
          (dx * reference.width) / image.width,
          (dy * reference.height) / image.height,
        ),
      );
    }
  if (!Number.isFinite(displacement))
    return fail("The registration fit is invalid.", finalInliers.length);
  const state =
    displacement <= 0.75
      ? "stable"
      : displacement > 1.5
        ? "moved"
        : "unverifiable";
  return {
    state,
    matched: finalInliers.length,
    displacementPixels: nativeDisplacement,
    reason:
      state === "stable"
        ? "Distributed background features match the original camera reference."
        : state === "moved"
          ? "Camera framing changed relative to the original reference. Recalibration is required."
          : "Possible camera movement is too close to the registration tolerance to verify.",
  };
}
