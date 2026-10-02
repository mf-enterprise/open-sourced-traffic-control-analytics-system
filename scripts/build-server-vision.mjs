import { build } from "esbuild";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
const root = fileURLToPath(new URL("../", import.meta.url));
const files = [
  "yolox.ts",
  "tracker.ts",
  "counting.ts",
  "geometry.ts",
  "types.ts",
  "speedMeasurement.ts",
  "cameraStability.ts",
];
const sourceHashes = {};
for (const file of files) {
  sourceHashes[`src/vision/${file}`] = createHash("sha256")
    .update(await readFile(new URL(`../src/vision/${file}`, import.meta.url)))
    .digest("hex");
}
for (const file of ["plateModel.ts", "plateText.ts"]) {
  sourceHashes[`src/ocr/${file}`] = createHash("sha256")
    .update(await readFile(new URL(`../src/ocr/${file}`, import.meta.url)))
    .digest("hex");
}
const bundle = await build({
  stdin: {
    contents:
      "export {decodeYoloxOutput,LargeVehicleVerifier} from './src/vision/yolox'; export {VehicleTracker} from './src/vision/tracker'; export {CrossingCounter} from './src/vision/counting'; export {validateCalibration,pointInPolygon} from './src/vision/geometry'; export {calculateSpeedMeasurement} from './src/vision/speedMeasurement'; export {createCameraReference,assessCameraStability} from './src/vision/cameraStability'; export {plateRgbaToTensor,plateRecognitionTensor,decodePlateOutputs,decodePlateCtc,plateRecognitionSize,normalizeRecognizedPlate} from './src/ocr/plateModel'; export {isPlateCandidate} from './src/ocr/plateText';",
    sourcefile: "server-vision-shared.ts",
    resolveDir: root,
  },
  bundle: true,
  write: false,
  platform: "node",
  format: "esm",
  external: ["onnxruntime-web", "onnxruntime-web/*"],
});
const code = bundle.outputFiles[0].text;
const manifest = {
  generatedAt: new Date().toISOString(),
  sourceHashes,
  bundleSha256: createHash("sha256").update(code).digest("hex"),
};
const directory = new URL("../server/generated/", import.meta.url);
await mkdir(directory, { recursive: true });
await writeFile(new URL("vision-shared.mjs", directory), code);
await writeFile(
  new URL("vision-shared.manifest.json", directory),
  JSON.stringify(manifest, null, 2) + "\n",
);
console.log(
  `Built shared server vision (${Buffer.byteLength(code)} bytes; ${manifest.bundleSha256.slice(0, 12)}).`,
);
