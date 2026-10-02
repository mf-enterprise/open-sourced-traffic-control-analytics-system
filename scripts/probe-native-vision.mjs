import { readFile, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { cpus } from "node:os";
import ffmpeg from "ffmpeg-static";
import { loadVisionShared } from "../server/vision-shared.mjs";
import { prepareRgbTensor } from "../server/vision-input.mjs";
const shared = await loadVisionShared();
const truth = JSON.parse(
  await readFile("artifacts/vision-ground-truth.json", "utf8"),
);
const model = await readFile("public/models/yolox_s.onnx");
const modelSha256 = createHash("sha256").update(model).digest("hex");
const outputPath = process.argv[2] || "artifacts/native-vision-probe.json";
const providers = process.argv.includes("--cpu-only")
  ? ["cpu"]
  : ["cpu", "dml", "wasm"];
const fixtures = [];
for (const image of truth.images) {
  const rgb = await new Promise((resolve, reject) => {
    const child = spawn(
      ffmpeg,
      [
        "-v",
        "error",
        "-i",
        image.path,
        "-frames:v",
        "1",
        "-pix_fmt",
        "rgb24",
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
    child.once("error", reject);
    child.once("close", (code) =>
      code === 0
        ? resolve(Buffer.concat(chunks))
        : reject(new Error(Buffer.concat(errors).toString())),
    );
  });
  if (rgb.length !== image.width * image.height * 3)
    throw new Error(`Unexpected RGB size: ${image.path}`);
  fixtures.push({ ...image, rgb });
}
function iou(a, b) {
  const overlap =
    Math.max(0, Math.min(a[0] + a[2], b[0] + b[2]) - Math.max(a[0], b[0])) *
    Math.max(0, Math.min(a[1] + a[3], b[1] + b[3]) - Math.max(a[1], b[1]));
  return overlap / (a[2] * a[3] + b[2] * b[3] - overlap);
}
function evaluate(detections, image) {
  const vehicle = new Set(["car", "truck", "bus", "motorcycle", "bicycle"]);
  const targets = image.annotations.filter(
    (a) =>
      a.counted !== false &&
      !a.ignore &&
      (a.class === "vehicle" || vehicle.has(a.className)),
  );
  const used = new Set(),
    extras = [];
  for (const detection of detections.filter((d) => vehicle.has(d.className))) {
    let best = -1,
      overlap = 0.5;
    targets.forEach((target, index) => {
      const value = iou(detection.bbox, target.bbox);
      if (!used.has(index) && value >= overlap) {
        best = index;
        overlap = value;
      }
    });
    if (best >= 0) {
      used.add(best);
      continue;
    }
    const a = detection.bbox;
    if (
      !(image.ignoreRegions || []).some((region) => {
        const b = region.bbox || region;
        return (
          (Math.max(
            0,
            Math.min(a[0] + a[2], b[0] + b[2]) - Math.max(a[0], b[0]),
          ) *
            Math.max(
              0,
              Math.min(a[1] + a[3], b[1] + b[3]) - Math.max(a[1], b[1]),
            )) /
            (a[2] * a[3]) >=
          0.5
        );
      })
    )
      extras.push(detection);
  }
  return {
    matched: used.size,
    extra: extras.length,
    missed: targets.length - used.size,
  };
}
const report = {
  createdAt: new Date().toISOString(),
  node: process.version,
  platform: `${process.platform}/${process.arch}`,
  cpu: cpus()[0]?.model,
  modelSha256,
  sourceHashes: shared.sourceHashes,
  scope:
    "Same two previously annotated images. Identical RGB preprocessing and shared decoder/verifier across native CPU, DirectML and Node WASM. Six repeated still presentations exercise crop confirmation only. Finite process timings exclude JPEG decoding and initialization; not sustained stream throughput, browser performance, independent temporal evidence, or general accuracy.",
  results: [],
};
for (const provider of providers) {
  let session;
  const started = performance.now();
  try {
    const ort =
      provider === "wasm"
        ? await import("onnxruntime-web")
        : await import("onnxruntime-node");
    if (provider === "wasm") ort.env.wasm.numThreads = 1;
    session = await ort.InferenceSession.create(
      model,
      provider === "wasm"
        ? { executionProviders: ["wasm"] }
        : {
            executionProviders: [provider],
            graphOptimizationLevel: "all",
            intraOpNumThreads: 4,
            executionMode: "sequential",
            ...(provider === "dml" ? { enableMemPattern: false } : {}),
          },
    );
    const initializationMs = performance.now() - started;
    const images = [];
    for (const image of fixtures) {
      let modelRuns = 0,
        cropRuns = 0,
        inferenceMs = 0,
        preprocessingMs = 0;
      async function infer(crop) {
        const startPre = performance.now();
        const input = new ort.Tensor(
          "float32",
          prepareRgbTensor(image.rgb, image.width, image.height, crop),
          [1, 3, 640, 640],
        );
        preprocessingMs += performance.now() - startPre;
        let outputs;
        const startRun = performance.now();
        try {
          outputs = await session.run({ [session.inputNames[0]]: input });
          const output = outputs[session.outputNames[0]];
          return shared.decodeYoloxOutput(
            output.data,
            output.dims,
            crop?.[2] ?? image.width,
            crop?.[3] ?? image.height,
            crop ? 0.6 : 0.35,
          );
        } finally {
          inferenceMs += performance.now() - startRun;
          modelRuns++;
          if (crop) cropRuns++;
          input.dispose();
          if (outputs)
            for (const value of Object.values(outputs)) value.dispose();
        }
      }
      await infer();
      modelRuns = cropRuns = inferenceMs = preprocessingMs = 0;
      const verifier = new shared.LargeVehicleVerifier();
      const frameMs = [];
      let raw, detections;
      for (let index = 0; index < 6; index++) {
        const before = performance.now();
        raw = await infer();
        detections = await verifier.verify(
          raw,
          image.width,
          image.height,
          index * 120,
          infer,
        );
        frameMs.push(performance.now() - before);
      }
      const result = {
        image: image.path,
        modelRuns,
        cropRuns,
        preprocessingMs,
        inferenceMs,
        frameMs,
        meanFrameMs: frameMs.reduce((a, b) => a + b, 0) / frameMs.length,
        raw,
        detections,
        rawScore: evaluate(raw, image),
        verifiedScore: evaluate(detections, image),
      };
      images.push(result);
      console.log(
        JSON.stringify({
          provider,
          image: image.path,
          meanFrameMs: result.meanFrameMs,
          raw: result.rawScore,
          verified: result.verifiedScore,
        }),
      );
    }
    report.results.push({ provider, initializationMs, images });
  } catch (error) {
    report.results.push({
      provider,
      error: error instanceof Error ? error.message : String(error),
    });
    console.error(
      `${provider}: ${error instanceof Error ? error.message : error}`,
    );
  } finally {
    await session?.release();
  }
  await writeFile(outputPath, JSON.stringify(report, null, 2) + "\n");
}
console.log(`Saved ${outputPath}`);
