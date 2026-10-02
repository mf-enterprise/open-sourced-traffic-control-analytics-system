import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import AdmZip from "adm-zip";

const assets = [
  [
    "GPL-3.0.txt",
    "https://raw.githubusercontent.com/spdx/license-list-data/v3.28.0/text/GPL-3.0-or-later.txt",
    ["@img/sharp-win32-x64"],
  ],
  [
    "LGPL-3.0.txt",
    "https://raw.githubusercontent.com/spdx/license-list-data/v3.28.0/text/LGPL-3.0-or-later.txt",
    ["@img/sharp-win32-x64"],
  ],
  [
    "ONNX-LICENSE.txt",
    "https://raw.githubusercontent.com/microsoft/onnxruntime/v1.30.0/LICENSE",
    ["onnxruntime-node", "onnxruntime-common", "onnxruntime-web"],
  ],
  [
    "ONNX-ThirdPartyNotices.txt",
    "https://raw.githubusercontent.com/microsoft/onnxruntime/v1.30.0/ThirdPartyNotices.txt",
    ["onnxruntime-node", "onnxruntime-common", "onnxruntime-web"],
  ],
  [
    "TFJS-LICENSE.txt",
    "https://raw.githubusercontent.com/tensorflow/tfjs/tfjs-v4.22.0/LICENSE",
    [
      "@tensorflow/tfjs",
      "@tensorflow/tfjs-backend-cpu",
      "@tensorflow/tfjs-backend-webgl",
      "@tensorflow/tfjs-converter",
      "@tensorflow/tfjs-core",
      "@tensorflow/tfjs-data",
      "@tensorflow/tfjs-layers",
    ],
  ],
  [
    "TFJS-LAYERS-LICENSE.txt",
    "https://raw.githubusercontent.com/tensorflow/tfjs/tfjs-v4.22.0/tfjs-layers/LICENSE",
    ["@tensorflow/tfjs-layers"],
  ],
  [
    "COCO-SSD-LICENSE.txt",
    "https://raw.githubusercontent.com/tensorflow/tfjs-models/coco-ssd-v2.2.3/LICENSE",
    ["@tensorflow-models/coco-ssd"],
  ],
  [
    "TR46-LICENSE.txt",
    "https://raw.githubusercontent.com/jsdom/tr46/3a6f29721e7063b9ffd421e461a54beae6170001/LICENSE.md",
    ["tr46"],
  ],
  [
    "ISC.txt",
    "https://raw.githubusercontent.com/spdx/license-list-data/v3.28.0/text/ISC.txt",
    ["guid-typescript"],
  ],
];
const directory = new URL("./licenses/", import.meta.url);
await mkdir(directory, { recursive: true });
const entries = [];
for (const [file, url, packages] of assets) {
  const response = await fetch(url, { signal: AbortSignal.timeout(30000) });
  if (!response.ok)
    throw new Error(`License retrieval failed: ${file} (${response.status})`);
  const bytes = Buffer.from(await response.arrayBuffer());
  await writeFile(new URL(file, directory), bytes);
  entries.push({
    file,
    url,
    packages,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  });
}
const seedrandom = await readFile(
  new URL("../node_modules/seedrandom/seedrandom.js", import.meta.url),
  "utf8",
);
const bytes = Buffer.from(
  seedrandom.slice(2, seedrandom.indexOf("*/")).trim() + "\n",
);
await writeFile(new URL("SEEDRANDOM-LICENSE.txt", directory), bytes);
entries.push({
  file: "SEEDRANDOM-LICENSE.txt",
  source: "seedrandom@3.0.5/seedrandom.js license header",
  packages: ["seedrandom"],
  sha256: createHash("sha256").update(bytes).digest("hex"),
});
const sharpNotice = await readFile(
  new URL("../node_modules/@img/sharp-win32-x64/README.md", import.meta.url),
);
await writeFile(new URL("SHARP-NATIVE-NOTICES.md", directory), sharpNotice);
entries.push({
  file: "SHARP-NATIVE-NOTICES.md",
  source: "@img/sharp-win32-x64@0.35.5/README.md",
  packages: ["@img/sharp-win32-x64"],
  sha256: createHash("sha256").update(sharpNotice).digest("hex"),
});
const directmlUrl =
  "https://api.nuget.org/v3-flatcontainer/microsoft.ai.directml/1.15.4/microsoft.ai.directml.1.15.4.nupkg";
const response = await fetch(directmlUrl, {
  signal: AbortSignal.timeout(60000),
});
if (!response.ok) throw new Error("DirectML license retrieval failed.");
const directmlBytes = Buffer.from(await response.arrayBuffer());
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
if (
  hash(directmlBytes) !==
  "4e7cb7ddce8cf837a7a75dc029209b520ca0101470fcdf275c1f49736a3615b9"
)
  throw new Error("DirectML package changed.");
const directml = new AdmZip(directmlBytes);
function executableContent(bytes) {
  const optionalHeader = bytes.readUInt32LE(0x3c) + 24;
  const securityDirectory = optionalHeader + 112 + 8 * 4;
  const certificateOffset = bytes.readUInt32LE(securityDirectory);
  const content = Buffer.from(bytes.subarray(0, certificateOffset));
  content.fill(0, optionalHeader + 64, optionalHeader + 68);
  content.fill(0, securityDirectory, securityDirectory + 8);
  return content;
}
const installed = await readFile(
  new URL(
    "../node_modules/onnxruntime-node/bin/napi-v6/win32/x64/DirectML.dll",
    import.meta.url,
  ),
);
if (
  !executableContent(installed).equals(
    executableContent(directml.readFile("bin/x64-win/DirectML.dll")),
  )
)
  throw new Error(
    "DirectML executable content does not match the licensed NuGet release.",
  );
for (const member of [
  "LICENSE.txt",
  "LICENSE-CODE.txt",
  "ThirdPartyNotices.txt",
]) {
  const file = `DIRECTML-${member}`;
  const bytes = directml.readFile(member);
  if (!bytes) throw new Error(`DirectML notice missing: ${member}`);
  await writeFile(new URL(file, directory), bytes);
  entries.push({
    file,
    url: directmlUrl,
    member,
    packages: ["onnxruntime-node"],
    sha256: hash(bytes),
    binaryVersion: "1.15.4",
    installedDllSha256: hash(installed),
    executableContentMatches: true,
    binaryComparison:
      "PE executable payload matches; Authenticode certificate and checksum differ.",
  });
}
await writeFile(
  new URL("./license-manifest.json", import.meta.url),
  JSON.stringify({ entries }, null, 2) + "\n",
);
