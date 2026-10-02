import { readFile, writeFile, mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { spawn } from "node:child_process";
import * as ort from "onnxruntime-web";
import ffmpeg from "ffmpeg-static";
import {
  decodeYoloxOutput,
  LargeVehicleVerifier,
  needsLargeVehicleVerification,
} from "../src/vision/yolox.ts";
const truthPath = resolve(
  process.argv[2] || "artifacts/vision-ground-truth.json",
);
const truth = JSON.parse(await readFile(truthPath, "utf8"));
ort.env.wasm.numThreads = 1;
const session = await ort.InferenceSession.create(
  await readFile("public/models/yolox_s.onnx"),
  { executionProviders: ["wasm"] },
);
async function inputTensor(path, crop) {
  const filter = [
    crop
      ? `crop=${Math.floor(crop[2])}:${Math.floor(crop[3])}:${Math.floor(crop[0])}:${Math.floor(crop[1])}`
      : null,
    "scale=640:640:force_original_aspect_ratio=decrease:flags=bilinear",
    "pad=640:640:0:0:color=0x727272",
    "format=bgr24",
  ]
    .filter(Boolean)
    .join(",");
  const pixels = await new Promise((done, fail) => {
    const child = spawn(
      ffmpeg,
      [
        "-v",
        "error",
        "-i",
        path,
        "-vf",
        filter,
        "-frames:v",
        "1",
        "-f",
        "rawvideo",
        "-",
      ],
      { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] },
    );
    const chunks = [],
      errors = [];
    child.stdout.on("data", (b) => chunks.push(b));
    child.stderr.on("data", (b) => errors.push(b));
    child.on("error", fail);
    child.on("close", (code) =>
      code === 0
        ? done(Buffer.concat(chunks))
        : fail(new Error(Buffer.concat(errors).toString())),
    );
  });
  if (pixels.length !== 640 * 640 * 3)
    throw new Error("Unexpected validation image dimensions");
  const data = new Float32Array(pixels.length),
    plane = 640 * 640;
  for (let i = 0; i < plane; i++) {
    data[i] = pixels[i * 3];
    data[plane + i] = pixels[i * 3 + 1];
    data[2 * plane + i] = pixels[i * 3 + 2];
  }
  return new ort.Tensor("float32", data, [1, 3, 640, 640]);
}
async function infer(path, width, height, crop) {
  const input = await inputTensor(path, crop);
  let outputs;
  try {
    outputs = await session.run({ [session.inputNames[0]]: input });
    const output = outputs[session.outputNames[0]];
    return decodeYoloxOutput(output.data, output.dims, width, height, 0.35);
  } finally {
    input.dispose();
    if (outputs) Object.values(outputs).forEach((output) => output.dispose());
  }
}
function iou(a, b) {
  const left = Math.max(a[0], b[0]),
    top = Math.max(a[1], b[1]),
    right = Math.min(a[0] + a[2], b[0] + b[2]),
    bottom = Math.min(a[1] + a[3], b[1] + b[3]);
  const overlap = Math.max(0, right - left) * Math.max(0, bottom - top);
  return overlap / (a[2] * a[3] + b[2] * b[3] - overlap);
}
function containedFraction(a, b) {
  const area =
    Math.max(0, Math.min(a[0] + a[2], b[0] + b[2]) - Math.max(a[0], b[0])) *
    Math.max(0, Math.min(a[1] + a[3], b[1] + b[3]) - Math.max(a[1], b[1]));
  return area / (a[2] * a[3]);
}
const vehicleClasses = new Set([
  "car",
  "truck",
  "bus",
  "motorcycle",
  "bicycle",
]);
function evaluate(predictions, annotations, ignore = []) {
  const candidates = predictions.filter((p) => vehicleClasses.has(p.className));
  const targets = annotations.filter(
    (a) =>
      a.counted !== false &&
      !a.ignore &&
      (a.class === "vehicle" || vehicleClasses.has(a.className)),
  );
  const used = new Set(),
    matches = [],
    falsePositives = [];
  for (const prediction of candidates) {
    let best = -1,
      bestIou = 0.5;
    targets.forEach((target, i) => {
      const overlap = iou(prediction.bbox, target.bbox);
      if (!used.has(i) && overlap >= bestIou) {
        best = i;
        bestIou = overlap;
      }
    });
    if (best >= 0) {
      used.add(best);
      matches.push({
        predicted: prediction.className,
        actual: targets[best].visibleSubtype || targets[best].className,
        iou: bestIou,
        score: prediction.score,
      });
    } else if (
      !ignore.some(
        (region) =>
          containedFraction(prediction.bbox, region.bbox || region) >= 0.5,
      )
    )
      falsePositives.push(prediction);
  }
  return {
    groundTruth: targets.length,
    truePositives: matches.length,
    falsePositives,
    falseNegatives: targets.filter((_, i) => !used.has(i)),
    matches,
    vehiclePrecision:
      matches.length + falsePositives.length
        ? matches.length / (matches.length + falsePositives.length)
        : null,
    vehicleRecall: targets.length ? matches.length / targets.length : null,
  };
}
const results = [];
try {
  for (const frame of truth.images) {
    const path = resolve(frame.path),
      raw = await infer(path, frame.width, frame.height);
    const verifier = new LargeVehicleVerifier();
    let verified = [];
    const candidateCount = raw.filter((detection) =>
      needsLargeVehicleVerification(detection, frame.width, frame.height),
    ).length;
    for (let pass = 0; pass < Math.max(2, candidateCount * 2); pass++) {
      verified = await verifier.verify(
        raw,
        frame.width,
        frame.height,
        pass * 120,
        async (crop) => infer(path, crop[2], crop[3], crop),
      );
    }
    results.push({
      image: frame.path,
      raw,
      verified,
      before: evaluate(raw, frame.annotations, frame.ignoreRegions),
      after: evaluate(verified, frame.annotations, frame.ignoreRegions),
    });
  }
} finally {
  await session.release();
}
const report = {
  createdAt: new Date().toISOString(),
  model: "YOLOX-S 0.1.1rc0",
  engine: "ONNX Runtime / CPU WASM",
  confidenceFloor: 0.35,
  matchIoU: 0.5,
  scope:
    "Two manually annotated still images; coarse vehicle localization only. Repeated presentations of each still at synthetic 120ms intervals exercise context confirmation mechanics, not independent temporal evidence. Not a representative accuracy study, tracking/counting benchmark, speed validation, or browser performance measurement. FFmpeg bilinear preprocessing may differ slightly from browser canvas sampling.",
  results,
};
await mkdir("artifacts", { recursive: true });
await writeFile(
  "artifacts/vision-validation-report.json",
  JSON.stringify(report, null, 2) + "\n",
);
for (const result of results)
  console.log(
    JSON.stringify({
      image: result.image,
      before: {
        tp: result.before.truePositives,
        fp: result.before.falsePositives.length,
        fn: result.before.falseNegatives.length,
      },
      after: {
        tp: result.after.truePositives,
        fp: result.after.falsePositives.length,
        fn: result.after.falseNegatives.length,
      },
    }),
  );
