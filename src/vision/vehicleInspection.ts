import { ROAD_CLASSES, type Point, type Track } from "./types";
export interface VehicleInspectionInput {
  sourceName: string;
  sourceKind: "camera" | "video" | "demo";
  sourceId: string;
  frameId: number;
  frameWidth: number;
  frameHeight: number;
  sourceTimestamp: number;
  captureTime: string;
  imageUrl: string;
  track: Track;
}
export type VehicleInspection = Readonly<VehicleInspectionInput>;
export type InspectionCropBounds = readonly [number, number, number, number];
const finite = (value: number) => Number.isFinite(value);
const nonnegative = (value: number) => finite(value) && value >= 0;
const normalizedPoint = (point: Point | undefined) =>
  !!point &&
  finite(point.x) &&
  finite(point.y) &&
  point.x >= 0 &&
  point.x <= 1 &&
  point.y >= 0 &&
  point.y <= 1;
function freezeDeep<T>(value: T): T {
  if (value && typeof value === "object") {
    Object.values(value).forEach(freezeDeep);
    Object.freeze(value);
  }
  return value;
}
export function createVehicleInspection(
  input: VehicleInspectionInput,
): VehicleInspection {
  if (
    !input ||
    !Number.isSafeInteger(input.frameWidth) ||
    !Number.isSafeInteger(input.frameHeight) ||
    input.frameWidth < 1 ||
    input.frameHeight < 1
  )
    throw new Error(
      "Vehicle inspection requires the frame's intrinsic dimensions.",
    );
  if (
    !["camera", "video", "demo"].includes(input.sourceKind) ||
    typeof input.sourceName !== "string" ||
    !input.sourceName.trim() ||
    typeof input.sourceId !== "string" ||
    !input.sourceId.trim() ||
    !Number.isSafeInteger(input.frameId) ||
    input.frameId < 0 ||
    !nonnegative(input.sourceTimestamp) ||
    typeof input.captureTime !== "string" ||
    !Number.isFinite(Date.parse(input.captureTime))
  )
    throw new Error(
      "Vehicle inspection requires valid source and frame timestamps.",
    );
  if (
    typeof input.imageUrl !== "string" ||
    !/^(?:data:image\/(?:jpeg|png|webp);base64,\S+|blob:\S+)$/.test(
      input.imageUrl,
    )
  )
    throw new Error(
      "Vehicle inspection requires a frozen frame image, not a live image URL.",
    );
  const track = input.track;
  if (
    !track ||
    !Number.isSafeInteger(track.id) ||
    track.id < 0 ||
    !(ROAD_CLASSES as readonly string[]).includes(track.className) ||
    !finite(track.score) ||
    track.score < 0 ||
    track.score > 1 ||
    !nonnegative(track.age) ||
    (track.speedKmh !== null && !nonnegative(track.speedKmh)) ||
    !Array.isArray(track.bbox) ||
    track.bbox.length !== 4 ||
    !track.bbox.every(finite) ||
    track.bbox[2] <= 0 ||
    track.bbox[3] <= 0 ||
    !Array.isArray(track.trail) ||
    !track.trail.every(normalizedPoint) ||
    (track.speedSampleCount !== undefined &&
      (!Number.isSafeInteger(track.speedSampleCount) ||
        track.speedSampleCount < 0)) ||
    (track.speedSpanSeconds !== undefined &&
      !nonnegative(track.speedSpanSeconds))
  )
    throw new Error(
      "The selected track contains invalid bounds or observation metadata.",
    );
  const [x, y, width, height] = track.bbox;
  const left = Math.max(0, x),
    top = Math.max(0, y);
  const right = Math.min(input.frameWidth, x + width);
  const bottom = Math.min(input.frameHeight, y + height);
  if (!finite(right) || !finite(bottom) || right <= left || bottom <= top)
    throw new Error("The selected vehicle does not intersect this frame.");
  const measurement =
    input.sourceKind === "demo" ? null : track.speedMeasurement;
  if (
    measurement &&
    ((measurement.method !== "ground-plane-median-v2" &&
      measurement.method !== "ground-plane-geometric-median-v3") ||
      !Array.isArray(measurement.samples) ||
      measurement.samples.length < 4 ||
      measurement.samples.length > 48 ||
      measurement.samples.some(
        (sample, index) =>
          !sample ||
          !nonnegative(sample.timeSeconds) ||
          sample.timeSeconds > input.sourceTimestamp + 1e-6 ||
          !normalizedPoint(sample.imagePoint) ||
          (index > 0 &&
            sample.timeSeconds <= measurement.samples[index - 1].timeSeconds),
      ) ||
      !measurement.velocityMps ||
      !finite(measurement.velocityMps.x) ||
      !finite(measurement.velocityMps.y) ||
      !nonnegative(measurement.speedKmh) ||
      measurement.speedKmh !== track.speedKmh ||
      !Number.isSafeInteger(measurement.pairCount) ||
      measurement.pairCount < 1)
  )
    throw new Error(
      "The selected track's speed trace does not belong to this frame.",
    );
  const selected: Track = {
    id: track.id,
    className: track.className,
    score: track.score,
    bbox: [left, top, right - left, bottom - top],
    age: track.age,
    speedKmh: track.speedKmh,
    trail: track.trail.map((point) => ({ x: point.x, y: point.y })),
    ...(track.speedSampleCount === undefined
      ? {}
      : { speedSampleCount: track.speedSampleCount }),
    ...(track.speedSpanSeconds === undefined
      ? {}
      : { speedSpanSeconds: track.speedSpanSeconds }),
    speedMeasurement: measurement
      ? {
          method: measurement.method,
          samples: measurement.samples.map((sample) => ({
            timeSeconds: sample.timeSeconds,
            imagePoint: { x: sample.imagePoint.x, y: sample.imagePoint.y },
          })),
          velocityMps: {
            x: measurement.velocityMps.x,
            y: measurement.velocityMps.y,
          },
          speedKmh: measurement.speedKmh,
          pairCount: measurement.pairCount,
        }
      : null,
  };
  return freezeDeep({
    sourceName: input.sourceName,
    sourceKind: input.sourceKind,
    sourceId: input.sourceId,
    frameId: input.frameId,
    frameWidth: input.frameWidth,
    frameHeight: input.frameHeight,
    sourceTimestamp: input.sourceTimestamp,
    captureTime: input.captureTime,
    imageUrl: input.imageUrl,
    track: selected,
  });
}
export function vehicleInspectionCropBounds(
  inspection: VehicleInspection,
  imageWidth: number,
  imageHeight: number,
): InspectionCropBounds {
  if (
    imageWidth !== inspection.frameWidth ||
    imageHeight !== inspection.frameHeight
  )
    throw new Error(
      "Frozen image dimensions do not match this observation. Select a fresh frame.",
    );
  const [x, y, width, height] = inspection.track.bbox;
  const left = Math.max(0, Math.ceil(x)),
    top = Math.max(0, Math.ceil(y));
  const right = Math.min(imageWidth, Math.floor(x + width));
  const bottom = Math.min(imageHeight, Math.floor(y + height));
  if (right <= left || bottom <= top)
    throw new Error(
      "The selected vehicle contains too few original pixels to crop.",
    );
  return Object.freeze([left, top, right - left, bottom - top]);
}
export interface ObservationPlateCandidate {
  text: string;
  originalOcrScore: number;
}
export function serializeVehicleInspection(
  inspection: VehicleInspection,
  candidate: ObservationPlateCandidate | null = null,
): string {
  if (
    candidate &&
    (!/^[A-Z0-9]{2,12}$/.test(candidate.text) ||
      !finite(candidate.originalOcrScore) ||
      candidate.originalOcrScore < 0 ||
      candidate.originalOcrScore > 100)
  )
    throw new Error("Registration candidate is invalid.");
  const { imageUrl: _pixels, ...metadata } = inspection;
  return JSON.stringify(
    {
      kind: "vehicle-observation",
      ticketCreated: false,
      simulation: inspection.sourceKind === "demo",
      ...metadata,
      registration:
        inspection.sourceKind === "demo" || !candidate
          ? null
          : {
              text: candidate.text,
              originalOcrScore: candidate.originalOcrScore,
              textMayBeOperatorEdited: true,
              verification: "unverified",
            },
      note: "Local track IDs and OCR candidates are observations, not proof of vehicle identity or keeper information. Image pixels are downloaded separately.",
    },
    null,
    2,
  );
}
