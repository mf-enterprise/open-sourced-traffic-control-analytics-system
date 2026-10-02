import { readFile, writeFile } from "node:fs/promises";
import sharp from "sharp";
import { createVisionEngine } from "../server/vision-engine.mjs";
const truth = JSON.parse(
  await readFile("artifacts/vision-ground-truth.json", "utf8"),
);
const engine = await createVisionEngine();
const report = {
  createdAt: new Date().toISOString(),
  info: engine.info,
  scope:
    "Production API smoke only. Sharp decodes JPEG; six repeated stills exercise context confirmation, not independent temporal accuracy or sustained stream throughput.",
  images: [],
};
try {
  for (const image of truth.images) {
    engine.resetContext();
    const { data: rgb, info } = await sharp(image.path)
      .removeAlpha()
      .toColourspace("srgb")
      .raw()
      .toBuffer({ resolveWithObject: true });
    if (
      info.channels !== 3 ||
      info.width !== image.width ||
      info.height !== image.height
    )
      throw new Error("Unexpected fixture RGB geometry");
    let result;
    const timings = [];
    for (let pass = 0; pass < 6; pass++) {
      result = await engine.processFrame({
        rgb,
        width: info.width,
        height: info.height,
        mediaSeconds: pass * 0.12,
      });
      timings.push(result.timings);
    }
    report.images.push({
      image: image.path,
      raw: result.rawDetections,
      detections: result.detections,
      timings,
    });
    console.log(
      JSON.stringify({
        provider: engine.info.provider,
        runtimeVersion: engine.info.runtimeVersion,
        image: image.path,
        classes: result.detections.map((d) => d.className),
        meanMs: timings.reduce((sum, t) => sum + t.totalMs, 0) / timings.length,
      }),
    );
  }
} finally {
  await engine.close();
}
await writeFile(
  process.argv[2] || "artifacts/native-engine-smoke.json",
  JSON.stringify(report, null, 2) + "\n",
);
