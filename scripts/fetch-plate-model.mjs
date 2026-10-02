import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const directory = join(root, "public", "models");
const revision = "aecb24a78e31cea03f59b83156d55dde84f20d94";
const repository =
  "https://huggingface.co/Topurrra/rtdetr-license-plate-detection-onnx";
const source = `${repository}/resolve/${revision}/plate_rtdetr.onnx`;
const modelCardSource = `${repository}/raw/${revision}/README.md`;
const licenseSource = "https://www.apache.org/licenses/LICENSE-2.0.txt";
const expectedBytes = 80671879;
const expectedSha256 =
  "50f9bf9d7eaa97ade59063ba608107203d0575a84c0fb27e0ebf3bab6f594366";
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
async function fetchBytes(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(120000) });
  if (!response.ok)
    throw new Error(
      `Plate model asset request failed: HTTP ${response.status}`,
    );
  return Buffer.from(await response.arrayBuffer());
}
await mkdir(directory, { recursive: true });
const modelPath = join(directory, "plate-rtdetr.onnx");
let model = await readFile(modelPath).catch(() => null);
if (
  !model ||
  model.length !== expectedBytes ||
  digest(model) !== expectedSha256
) {
  console.log("Downloading optional RT-DETR plate detector (80.7 MB)…");
  model = await fetchBytes(source);
  if (model.length !== expectedBytes || digest(model) !== expectedSha256)
    throw new Error(
      "Plate model integrity check failed; received bytes do not match the pinned official LFS object.",
    );
  await writeFile(modelPath, model);
}
const licensePath = join(directory, "PLATE-RTDETR-LICENSE.txt");
let license = await readFile(licensePath, "utf8").catch(() => "");
if (!license.includes("Apache License") || !license.includes("Version 2.0")) {
  license = (await fetchBytes(licenseSource)).toString("utf8");
  if (!license.includes("Apache License") || !license.includes("Version 2.0"))
    throw new Error("Unexpected upstream Apache license response.");
  await writeFile(licensePath, license);
}
const cardPath = join(directory, "PLATE-RTDETR-MODEL-CARD.txt");
let card = await readFile(cardPath, "utf8").catch(() => "");
if (!card.includes("license: apache-2.0") || !card.includes("RT-DETRv2")) {
  card = (await fetchBytes(modelCardSource)).toString("utf8");
  if (!card.includes("license: apache-2.0") || !card.includes("RT-DETRv2"))
    throw new Error("Unexpected upstream plate model card response.");
  await writeFile(cardPath, card);
}
await writeFile(
  join(directory, "PLATE-RTDETR-NOTICE.txt"),
  [
    "Optional RT-DETRv2-R18 license-plate candidate detector",
    "",
    "Model publisher: Topurrra. Model card declares Apache License 2.0.",
    "Base model: PekingU/rtdetr_v2_r18vd (Apache-2.0).",
    "Model card describes fine-tuning on Open Images V7 vehicle registration plates.",
    "Training-image and annotation attribution are described in the preserved model card.",
    "",
    `Repository: ${repository}`,
    `Pinned revision: ${revision}`,
    `Original asset: ${source}`,
    `SHA-256: ${expectedSha256}`,
    "The ONNX model is redistributed without weight changes.",
    "See PLATE-RTDETR-LICENSE.txt and PLATE-RTDETR-MODEL-CARD.txt.",
    "",
    "Traffic Control adapts preprocessing and output decoding for optional local inference.",
    "Outputs are unverified plate-region candidates, not verified text or vehicle identity.",
    "The model does not identify an owner or access a registration database.",
    "The source model was intended for human-confirmed privacy-redaction suggestions.",
    "No endorsement or deployment accuracy is implied.",
    "",
  ].join("\n"),
);
await writeFile(
  join(directory, "plate-rtdetr.manifest.json"),
  JSON.stringify(
    {
      name: "RT-DETRv2-R18 plate candidates",
      publisher: "Topurrra",
      repository,
      revision,
      source,
      modelCardSource,
      license: "Apache-2.0",
      licenseSource,
      bytes: expectedBytes,
      sha256: expectedSha256,
      hashSource: "Official Hugging Face LFS metadata at the pinned revision",
      input: {
        name: "pixel_values",
        shape: [1, 3, 640, 640],
        type: "float32",
        channels: "RGB",
        range: [0, 1],
        resize: "stretch to 640x640; no mean/std normalization",
      },
      outputs: {
        logits: { shape: [1, 300, 1], activation: "sigmoid" },
        pred_boxes: {
          shape: [1, 300, 4],
          format: "normalized center-x, center-y, width, height",
        },
      },
      inference: {
        provider: "CPU/WASM",
        candidateThreshold: 0.05,
        maxCandidates: 5,
        nmsIou: 0.5,
      },
      limitations:
        "Plate-region suggestions only. Low model scores are not calibrated correctness probabilities. Human verification and separate scene validation are required.",
    },
    null,
    2,
  ) + "\n",
);
console.log(
  `Verified optional plate model: ${expectedBytes} bytes, SHA256 ${expectedSha256}`,
);
const recognitionRepository =
  "https://huggingface.co/PaddlePaddle/PP-OCRv6_small_rec_onnx";
const recognitionRevision = "b8f84f0b80c529de40b4fbb3544b84fa7233a513";
const recognitionBase = `${recognitionRepository}/resolve/${recognitionRevision}/`;
const recognitionSha256 =
  "5435fd747c9e0efe15a96d0b378d5bd157e9492ed8fd80edf08f30d02fa24634";
const configSha256 =
  "ab078671bb49f06228eadccd34f1bb501e157f7a047095ffb943ba81512c77d1";
async function verifiedRecognitionAsset(remote, local, sha256, bytes) {
  const path = join(directory, local);
  let data = await readFile(path).catch(() => null);
  if (!data || data.length !== bytes || digest(data) !== sha256) {
    console.log(`Downloading pinned plate recognition asset: ${remote}…`);
    data = await fetchBytes(`${recognitionBase}${remote}`);
    if (data.length !== bytes || digest(data) !== sha256)
      throw new Error(
        `Plate recognition asset integrity check failed: ${remote}`,
      );
    await writeFile(path, data);
  }
  return data;
}
await verifiedRecognitionAsset(
  "inference.onnx",
  "plate-recognizer.onnx",
  recognitionSha256,
  21159378,
);
const config = await verifiedRecognitionAsset(
  "inference.yml",
  "PP-OCRV6-CONFIG.txt",
  configSha256,
  150579,
);
await verifiedRecognitionAsset(
  "README.md",
  "PP-OCRV6-MODEL-CARD.txt",
  "7d46dbd183ac09bd5a2e6b4577dcb29240751b1c00eb6813eca308d529f86806",
  16585,
);
const dictionarySection = config
  .toString("utf8")
  .split("  character_dict:\n")[1];
if (!dictionarySection)
  throw new Error("The pinned OCR configuration has no character dictionary.");
const tokens = dictionarySection
  .trimEnd()
  .split("\n")
  .map((line) => {
    if (!line.startsWith("  - "))
      throw new Error("Unexpected character dictionary syntax.");
    const token = line.slice(4);
    if (token.startsWith("'")) {
      if (!token.endsWith("'"))
        throw new Error("Unexpected quoted dictionary token.");
      return token.slice(1, -1).replaceAll("''", "'");
    }
    if ([...token].length !== 1)
      throw new Error("Unexpected plain dictionary token.");
    return token;
  });
if (tokens.length !== 18708 || tokens.includes("") || tokens.includes(" "))
  throw new Error(
    "The OCR dictionary does not match the verified 18,710-class graph.",
  );
const dictionary = JSON.stringify(["", ...tokens, " "]) + "\n";
await writeFile(
  join(directory, "plate-recognizer.dictionary.json"),
  dictionary,
);
await writeFile(join(directory, "PP-OCRV6-LICENSE.txt"), license);
await writeFile(
  join(directory, "PP-OCRV6-NOTICE.txt"),
  [
    "PP-OCRv6_small_rec — official PaddlePaddle ONNX recognition model",
    "Copyright and attribution: PaddlePaddle / PaddleOCR contributors.",
    "The official model card declares Apache License 2.0; see PP-OCRV6-LICENSE.txt.",
    `Repository: ${recognitionRepository}`,
    `Revision: ${recognitionRevision}`,
    `Original model: ${recognitionBase}inference.onnx`,
    `Model SHA-256 (official LFS metadata): ${recognitionSha256}`,
    "Weights are redistributed without changes.",
    "The full original model card and inference configuration are preserved alongside the model.",
    "The JSON vocabulary is derived from the embedded official dictionary, with blank and space tokens added following PaddleX CTCLabelDecode.",
    "Traffic Control implements BGR preprocessing and CTC decoding following these Apache-2.0 sources:",
    "https://github.com/PaddlePaddle/PaddleX/blob/c50f5da858020db473a2285f089bb8c7bbd6afdc/paddlex/inference/models/text_recognition/processors.py",
    "https://github.com/PaddlePaddle/PaddleOCR/blob/dab3fe35379033fdcb2d0e9572fac0b36c9a9ebf/ppocr/modeling/heads/rec_ctc_head.py",
    "Predictions are unverified text suggestions. Model scores are not calibrated identity probabilities.",
    "No owner-registry access, official identification, endorsement, or deployment accuracy is implied.",
    "",
  ].join("\n"),
);
await writeFile(
  join(directory, "plate-recognizer.manifest.json"),
  JSON.stringify(
    {
      name: "PP-OCRv6_small_rec",
      publisher: "PaddlePaddle",
      repository: recognitionRepository,
      revision: recognitionRevision,
      source: `${recognitionBase}inference.onnx`,
      license: "Apache-2.0",
      bytes: 21159378,
      sha256: recognitionSha256,
      hashSource: "Official Hugging Face LFS metadata at the pinned revision",
      config: {
        source: `${recognitionBase}inference.yml`,
        sha256: configSha256,
      },
      dictionary: {
        path: "plate-recognizer.dictionary.json",
        sha256: digest(dictionary),
        classes: 18710,
        blankIndex: 0,
        spaceIndex: 18709,
      },
      input: {
        name: "x",
        shape: [1, 3, 48, "width"],
        channels: "BGR",
        normalization: "pixel / 127.5 - 1",
        resize:
          "PaddleX aspect-preserving height 48; width 320..3200; normalized zero right padding",
      },
      output: {
        name: "fetch_name_0",
        shape: [1, "timesteps", 18710],
        activation: "already softmax",
        decode:
          "greedy CTC; collapse adjacent repeated indices then remove blank; mean retained-token probabilities × 100",
      },
      runtime: "ONNX Runtime Web CPU/WASM in isolated worker",
      limitations:
        "Single-line crop OCR; separate scene validation and human verification required. Preserve O/0 and I/1 as read.",
    },
    null,
    2,
  ) + "\n",
);
console.log(
  `Verified plate text model: 21159378 bytes, SHA256 ${recognitionSha256}`,
);
