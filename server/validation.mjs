import { createHash } from "node:crypto";
import { loadVisionShared } from "./vision-shared.mjs";
const { calculateSpeedMeasurement } = await loadVisionShared();
export const MAX_BODY_BYTES = 5 * 1024 * 1024;
export const MAX_EVIDENCE_BYTES = 2 * 1024 * 1024;
export const CASE_ID = /^VEL-\d{4}-\d{6,}$/;
export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
const fail = (message) => {
  throw new HttpError(400, message);
};
const object = (value, name) => {
  if (!value || typeof value !== "object" || Array.isArray(value))
    fail(`${name} must be an object.`);
};
const keys = (value, allowed) => {
  for (const key of Object.keys(value))
    if (!allowed.includes(key)) fail(`Unexpected field: ${key}.`);
};
const string = (value, name, max, required = true) => {
  if (
    typeof value !== "string" ||
    value.length > max ||
    /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value)
  )
    fail(`${name} must be valid text of at most ${max} characters.`);
  const result = value.trim();
  if (required && !result) fail(`${name} is required.`);
  return result;
};
const number = (value, name, min, max) => {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < min ||
    value > max
  )
    fail(`${name} must be a number between ${min} and ${max}.`);
  return value;
};
function calibration(value, simulated) {
  if (value === null && simulated) return null;
  object(value, "calibration");
  keys(value, ["points", "widthMeters", "lengthMeters"]);
  if (!Array.isArray(value.points) || value.points.length !== 4)
    fail("Calibration needs four road-plane corners.");
  const points = value.points.map((point) => {
    object(point, "Calibration point");
    keys(point, ["x", "y"]);
    return {
      x: number(point.x, "Point x", 0, 1),
      y: number(point.y, "Point y", 0, 1),
    };
  });
  const crosses = points.map((a, i) => {
    const b = points[(i + 1) % 4],
      c = points[(i + 2) % 4];
    return (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x);
  });
  if (
    crosses.some((cross) => Math.abs(cross) < 0.000001) ||
    !crosses.every((cross) => Math.sign(cross) === Math.sign(crosses[0]))
  )
    fail("Calibration corners must form a non-degenerate convex perimeter.");
  return {
    points,
    widthMeters: number(value.widthMeters, "Road width", 0.1, 10000),
    lengthMeters: number(value.lengthMeters, "Road length", 0.1, 10000),
  };
}
function jpegDimensions(bytes) {
  const startOfFrame = new Set([
    0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce,
    0xcf,
  ]);
  let offset = 2;
  while (offset < bytes.length) {
    if (bytes[offset++] !== 0xff) break;
    while (offset < bytes.length && bytes[offset] === 0xff) offset++;
    const marker = bytes[offset++];
    if (marker === 0xda || marker === 0xd9) break;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) continue;
    if (offset + 2 > bytes.length) break;
    const length = bytes.readUInt16BE(offset);
    if (length < 2 || offset + length > bytes.length) break;
    if (startOfFrame.has(marker)) {
      if (length < 8) break;
      return {
        height: bytes.readUInt16BE(offset + 3),
        width: bytes.readUInt16BE(offset + 5),
      };
    }
    offset += length;
  }
  fail("vehicleBox requires JPEG evidence with readable image dimensions.");
}
function vehicleBounds(value, evidence) {
  if (value === undefined || value === null) return null;
  if (!Array.isArray(value) || value.length !== 4)
    fail("vehicleBox must contain x, y, width and height.");
  const box = Array.from(value, (coordinate) =>
    number(coordinate, "vehicleBox coordinate", 0, 1920),
  );
  const [x, y, width, height] = box;
  if (width <= 0 || height <= 0)
    fail("vehicleBox width and height must be positive.");
  const image = jpegDimensions(evidence);
  const footer = Math.max(32, Math.round(image.width / 50));
  const imageHeight = image.height - footer;
  if (
    image.width < 1 ||
    image.width > 1920 ||
    imageHeight < 1 ||
    imageHeight > 1920 ||
    x + width > image.width + 1e-6 ||
    y + height > imageHeight + 1e-6
  )
    fail("vehicleBox must lie inside the evidence image, above its footer.");
  return box;
}
function measurementTrace(
  value,
  frozenCalibration,
  sourceKind,
  sourceTimestamp,
  caseSpeed,
) {
  if (value === undefined || value === null) return null;
  if (sourceKind === "demo" || !frozenCalibration)
    fail(
      "speedMeasurement requires a real source and its frozen measured calibration.",
    );
  object(value, "speedMeasurement");
  keys(value, ["method", "samples", "velocityMps", "speedKmh", "pairCount"]);
  if (
    value.method !== "ground-plane-median-v2" &&
    value.method !== "ground-plane-geometric-median-v3"
  )
    fail("speedMeasurement method is unsupported.");
  if (
    !Array.isArray(value.samples) ||
    value.samples.length < 4 ||
    value.samples.length > 48
  )
    fail("speedMeasurement needs between 4 and 48 image observations.");
  const samples = Array.from(value.samples, (sample) => {
    object(sample, "speedMeasurement sample");
    keys(sample, ["timeSeconds", "imagePoint"]);
    object(sample.imagePoint, "speedMeasurement imagePoint");
    keys(sample.imagePoint, ["x", "y"]);
    return {
      timeSeconds: number(
        sample.timeSeconds,
        "speedMeasurement timeSeconds",
        0,
        Number.MAX_SAFE_INTEGER,
      ),
      imagePoint: {
        x: number(sample.imagePoint.x, "speedMeasurement imagePoint x", 0, 1),
        y: number(sample.imagePoint.y, "speedMeasurement imagePoint y", 0, 1),
      },
    };
  });
  object(value.velocityMps, "speedMeasurement velocityMps");
  keys(value.velocityMps, ["x", "y"]);
  const vx = number(
    value.velocityMps.x,
    "speedMeasurement velocity x",
    -Number.MAX_SAFE_INTEGER,
    Number.MAX_SAFE_INTEGER,
  );
  const vy = number(
    value.velocityMps.y,
    "speedMeasurement velocity y",
    -Number.MAX_SAFE_INTEGER,
    Number.MAX_SAFE_INTEGER,
  );
  const reportedSpeed = number(
    value.speedKmh,
    "speedMeasurement speedKmh",
    0,
    1000,
  );
  const pairCount = number(
    value.pairCount,
    "speedMeasurement pairCount",
    1,
    1128,
  );
  if (!Number.isInteger(pairCount))
    fail("speedMeasurement pairCount must be an integer.");
  const lastTime = samples.at(-1).timeSeconds;
  if (lastTime > sourceTimestamp || sourceTimestamp - lastTime > 1 / 30 + 1e-6)
    fail(
      "speedMeasurement must end at the captured frame without future or stale samples.",
    );
  const calculated = calculateSpeedMeasurement(
    samples,
    frozenCalibration,
    value.method,
  );
  if (!calculated)
    fail(
      "speedMeasurement observations do not form a valid calibrated speed measurement.",
    );
  const matches = (actual, expected) =>
    Math.abs(actual - expected) <= 1e-8 * Math.max(1, Math.abs(expected));
  if (
    pairCount !== calculated.pairCount ||
    !matches(vx, calculated.velocityMps.x) ||
    !matches(vy, calculated.velocityMps.y) ||
    !matches(reportedSpeed, calculated.speedKmh) ||
    !matches(caseSpeed, calculated.speedKmh)
  )
    fail(
      "speedMeasurement does not reproduce the recorded speed from its frozen calibration.",
    );
  return calculated;
}
export function validateCaseSpeedMeasurement(record) {
  object(record, "Case record");
  if (record.speedMeasurement === undefined || record.speedMeasurement === null)
    return null;
  if (
    !["camera", "video"].includes(record.sourceKind) ||
    record.simulation === true
  )
    fail("speedMeasurement requires a real camera or video case.");
  return measurementTrace(
    record.speedMeasurement,
    calibration(record.calibration, false),
    record.sourceKind,
    number(
      record.sourceTimestamp,
      "sourceTimestamp",
      0,
      Number.MAX_SAFE_INTEGER,
    ),
    number(record.speedKmh, "speedKmh", 0, 1000),
  );
}
export function validateCase(body) {
  object(body, "Case");
  keys(body, [
    "clientEventId",
    "trackId",
    "sourceName",
    "sourceKind",
    "className",
    "speedKmh",
    "speedLimit",
    "confidence",
    "captureTime",
    "sourceTimestamp",
    "calibration",
    "evidence",
    "vehicleBox",
    "speedMeasurement",
  ]);
  const clientEventId = string(body.clientEventId, "clientEventId", 180);
  if (!/^[A-Za-z0-9_.:-]+$/.test(clientEventId))
    fail("clientEventId contains unsupported characters.");
  const trackId = number(body.trackId, "trackId", 0, Number.MAX_SAFE_INTEGER);
  if (!Number.isInteger(trackId)) fail("trackId must be an integer.");
  if (!["demo", "video", "camera"].includes(body.sourceKind))
    fail("sourceKind must be demo, video, or camera.");
  if (
    !["person", "bicycle", "car", "motorcycle", "bus", "truck"].includes(
      body.className,
    )
  )
    fail("Unsupported road object class.");
  const speedKmh = number(body.speedKmh, "speedKmh", 0, 1000);
  const speedLimit = number(body.speedLimit, "speedLimit", 1, 500);
  if (speedKmh <= speedLimit)
    fail("A violation draft requires a speed above its recorded limit.");
  const captureTime = string(body.captureTime, "captureTime", 40);
  if (
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(
      captureTime,
    ) ||
    !Number.isFinite(Date.parse(captureTime))
  )
    fail("captureTime must be an ISO timestamp including its timezone.");
  if (
    typeof body.evidence !== "string" ||
    !body.evidence.startsWith("data:image/jpeg;base64,")
  )
    fail("Evidence must be a JPEG data URL.");
  const encoded = body.evidence.slice("data:image/jpeg;base64,".length);
  if (encoded.length > Math.ceil(MAX_EVIDENCE_BYTES / 3) * 4)
    throw new HttpError(413, "JPEG evidence must be no larger than 2 MiB.");
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(encoded) || encoded.length % 4 !== 0)
    fail("Evidence contains invalid base64.");
  const evidence = Buffer.from(encoded, "base64");
  if (evidence.length > MAX_EVIDENCE_BYTES)
    throw new HttpError(413, "JPEG evidence must be no larger than 2 MiB.");
  if (
    evidence.length < 4 ||
    evidence[0] !== 0xff ||
    evidence[1] !== 0xd8 ||
    evidence[2] !== 0xff ||
    evidence.at(-2) !== 0xff ||
    evidence.at(-1) !== 0xd9 ||
    evidence.toString("base64") !== encoded
  )
    fail("Evidence is not a valid JPEG payload.");
  const evidenceSha256 = createHash("sha256").update(evidence).digest("hex");
  const vehicleBox = vehicleBounds(body.vehicleBox, evidence);
  const sourceTimestamp = number(
    body.sourceTimestamp,
    "sourceTimestamp",
    0,
    Number.MAX_SAFE_INTEGER,
  );
  const frozenCalibration = calibration(
    body.calibration,
    body.sourceKind === "demo",
  );
  const speedMeasurement = measurementTrace(
    body.speedMeasurement,
    frozenCalibration,
    body.sourceKind,
    sourceTimestamp,
    speedKmh,
  );
  const record = {
    clientEventId,
    trackId,
    sourceName: string(body.sourceName, "sourceName", 250),
    sourceKind: body.sourceKind,
    className: body.className,
    speedKmh,
    speedLimit,
    confidence: number(body.confidence, "confidence", 0, 1),
    captureTime: new Date(captureTime).toISOString(),
    sourceTimestamp,
    calibration: frozenCalibration,
    simulation: body.sourceKind === "demo",
    evidenceSha256,
    evidenceBytes: evidence.length,
    ...(vehicleBox === null ? {} : { vehicleBox }),
    ...(speedMeasurement === null ? {} : { speedMeasurement }),
  };
  return {
    record,
    evidence,
    fingerprint: createHash("sha256")
      .update(JSON.stringify(record))
      .digest("hex"),
  };
}
export function validateReview(body) {
  object(body, "Review");
  keys(body, ["state", "plate", "notes", "reviewer"]);
  if (!["approved", "dismissed"].includes(body.state))
    fail("Review state must be approved or dismissed.");
  return {
    state: body.state,
    reviewer: string(body.reviewer, "reviewer", 100),
    plate: string(
      body.plate ?? "",
      "plate",
      24,
      body.state === "approved",
    ).toUpperCase(),
    notes: string(body.notes ?? "", "notes", 2000, false),
  };
}
export function listLimit(value) {
  if (value === null) return 500;
  if (!/^\d+$/.test(value)) fail("limit must be an integer.");
  return number(Number(value), "limit", 1, 2000);
}
