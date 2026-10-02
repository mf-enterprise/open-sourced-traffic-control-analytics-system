import { createHash } from "node:crypto";
import {
  mkdir,
  readFile,
  writeFile,
  copyFile,
  readdir,
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const directory = join(root, "public", "models");
const url =
  "https://github.com/Megvii-BaseDetection/YOLOX/releases/download/0.1.1rc0/yolox_s.onnx";
const expectedBytes = 35858002;
const expectedSha256 =
  "c5c2d13e59ae883e6af3b45daea64af4833a4951c92d116ec270d9ddbe998063";
const sha256 = (data) => createHash("sha256").update(data).digest("hex");
await mkdir(directory, { recursive: true });
const path = join(directory, "yolox_s.onnx");
let bytes = await readFile(path).catch(() => null);
if (
  !bytes ||
  bytes.length !== expectedBytes ||
  sha256(bytes) !== expectedSha256
) {
  console.log("Downloading official YOLOX-S 640 model (35.9 MB)…");
  const response = await fetch(url, { signal: AbortSignal.timeout(120000) });
  if (!response.ok)
    throw new Error(`Model download failed: HTTP ${response.status}`);
  bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length !== expectedBytes || sha256(bytes) !== expectedSha256)
    throw new Error(
      "Model integrity check failed. The downloaded bytes differ from the verified official release.",
    );
  await writeFile(path, bytes);
}
const licenseUrl =
  "https://raw.githubusercontent.com/Megvii-BaseDetection/YOLOX/0.1.1rc0/LICENSE";
const licensePath = join(directory, "YOLOX-LICENSE.txt");
let license = await readFile(licensePath, "utf8").catch(() => "");
if (!license.includes("Apache License") || !license.includes("Version 2.0")) {
  const licenseResponse = await fetch(licenseUrl, {
    signal: AbortSignal.timeout(30000),
  });
  if (!licenseResponse.ok)
    throw new Error(`License download failed: HTTP ${licenseResponse.status}`);
  license = await licenseResponse.text();
  if (!license.includes("Apache License") || !license.includes("Version 2.0"))
    throw new Error("Unexpected upstream license.");
  await writeFile(licensePath, license);
}
await writeFile(
  join(directory, "yolox_s.manifest.json"),
  JSON.stringify(
    {
      name: "YOLOX-S",
      release: "0.1.1rc0",
      source: url,
      sourceRepository: "https://github.com/Megvii-BaseDetection/YOLOX",
      license: "Apache-2.0",
      licenseSource: licenseUrl,
      bytes: expectedBytes,
      sha256: expectedSha256,
      input: {
        name: "images",
        shape: [1, 3, 640, 640],
        type: "float32",
        channels: "BGR",
        range: [0, 255],
        padding: 114,
        alignment: "top-left",
      },
      output: { shape: [1, 8400, 85], decoded: false, strides: [8, 16, 32] },
    },
    null,
    2,
  ) + "\n",
);
const runtimeRoot = join(root, "node_modules", "onnxruntime-web");
const runtimePackage = JSON.parse(
  await readFile(join(runtimeRoot, "package.json"), "utf8"),
);
const runtimeDirectory = join(root, "public", "onnx");
await mkdir(runtimeDirectory, { recursive: true });
const priorRuntimeManifest = await readFile(
  join(runtimeDirectory, "manifest.json"),
  "utf8",
)
  .then(JSON.parse)
  .catch(() => null);
const files = (await readdir(join(runtimeRoot, "dist"))).filter((file) =>
  /^ort-wasm[^/]*\.(mjs|wasm)$/.test(file),
);
if (
  !files.some((file) => file.endsWith(".wasm")) ||
  !files.some((file) => file.endsWith(".mjs"))
)
  throw new Error(
    "Could not find ONNX Runtime WebGPU/WASM assets. Install onnxruntime-web first.",
  );
for (const file of files)
  await copyFile(join(runtimeRoot, "dist", file), join(runtimeDirectory, file));
const runtimeLicenseUrl = `https://raw.githubusercontent.com/microsoft/onnxruntime/v${runtimePackage.version}/LICENSE`;
let runtimeLicense = "";
if (priorRuntimeManifest?.version === runtimePackage.version) {
  for (const cachedPath of [
    join(root, "public", "onnxruntime-LICENSE.txt"),
    join(runtimeDirectory, "LICENSE.txt"),
  ]) {
    const cached = await readFile(cachedPath, "utf8").catch(() => "");
    if (
      cached.includes("MIT License") &&
      cached.includes("Permission is hereby granted")
    ) {
      runtimeLicense = cached;
      break;
    }
  }
}
if (!runtimeLicense) {
  const runtimeLicenseResponse = await fetch(runtimeLicenseUrl, {
    signal: AbortSignal.timeout(30000),
  });
  if (!runtimeLicenseResponse.ok)
    throw new Error(
      `ONNX runtime license download failed: HTTP ${runtimeLicenseResponse.status}`,
    );
  runtimeLicense = await runtimeLicenseResponse.text();
  if (
    !runtimeLicense.includes("MIT License") ||
    !runtimeLicense.includes("Permission is hereby granted")
  )
    throw new Error("Unexpected ONNX runtime license.");
}
await writeFile(join(runtimeDirectory, "LICENSE.txt"), runtimeLicense);
await writeFile(
  join(runtimeDirectory, "manifest.json"),
  JSON.stringify(
    { package: "onnxruntime-web", version: runtimePackage.version, files },
    null,
    2,
  ) + "\n",
);
console.log(
  `Verified YOLOX-S ${expectedBytes} bytes, SHA256 ${expectedSha256}`,
);
console.log(
  `Copied ONNX Runtime ${runtimePackage.version}: ${files.join(", ")}`,
);
