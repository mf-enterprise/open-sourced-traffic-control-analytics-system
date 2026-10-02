import { normalizePlateText } from "./plateText";
export interface PlateCandidate {
  bbox: [number, number, number, number];
  score: number;
}
export interface PlateRecognition {
  plate: string;
  confidence: number;
  rawText?: string;
  unsupportedScript?: boolean;
}
const INPUT = 640;
const ROWS = 300;
export function plateRecognitionTensor(
  pixels: Uint8ClampedArray,
  contentWidth: number,
  width: number,
): Float32Array {
  if (
    !Number.isInteger(width) ||
    !Number.isInteger(contentWidth) ||
    width < 320 ||
    width > 3200 ||
    contentWidth < 1 ||
    contentWidth > width ||
    pixels.length !== contentWidth * 48 * 4
  )
    throw new Error("Invalid resized plate recognition pixels.");
  const plane = width * 48;
  const result = new Float32Array(plane * 3);
  for (let y = 0; y < 48; y++)
    for (let x = 0; x < contentWidth; x++) {
      const input = (y * contentWidth + x) * 4;
      for (let channel = 0; channel < 3; channel++)
        result[channel * plane + y * width + x] =
          pixels[input + 2 - channel] / 127.5 - 1;
    }
  return result;
}
export function decodePlateCtc(
  probabilities: Float32Array,
  dims: readonly number[],
  characters: readonly string[],
): PlateRecognition {
  if (
    dims.length !== 3 ||
    dims[0] !== 1 ||
    !Number.isInteger(dims[1]) ||
    dims[1] < 1 ||
    dims[2] !== characters.length ||
    characters[0] !== "" ||
    probabilities.length !== dims[1] * dims[2]
  )
    throw new Error("Unexpected plate recognition output or dictionary.");
  let previous = -1,
    plate = "",
    scoreSum = 0,
    retained = 0;
  for (let time = 0; time < dims[1]; time++) {
    let best = 0,
      score = -Infinity;
    for (let character = 0; character < dims[2]; character++) {
      const probability = probabilities[time * dims[2] + character];
      if (!Number.isFinite(probability) || probability < 0 || probability > 1)
        throw new Error(
          "Plate recognition returned invalid character probabilities.",
        );
      if (probability > score) {
        best = character;
        score = probability;
      }
    }
    if (best !== 0 && best !== previous) {
      plate += characters[best];
      scoreSum += score;
      retained++;
    }
    previous = best;
  }
  return { plate, confidence: retained ? (scoreSum / retained) * 100 : 0 };
}
export function plateRgbaToTensor(pixels: Uint8ClampedArray): Float32Array {
  if (pixels.length !== INPUT * INPUT * 4)
    throw new Error("Plate input must contain exactly 640 × 640 RGBA pixels.");
  const plane = INPUT * INPUT;
  const output = new Float32Array(3 * plane);
  for (let i = 0; i < plane; i++) {
    output[i] = pixels[i * 4] / 255;
    output[plane + i] = pixels[i * 4 + 1] / 255;
    output[2 * plane + i] = pixels[i * 4 + 2] / 255;
  }
  return output;
}
function overlap(a: PlateCandidate, b: PlateCandidate): number {
  const [ax, ay, aw, ah] = a.bbox;
  const [bx, by, bw, bh] = b.bbox;
  const area =
    Math.max(0, Math.min(ax + aw, bx + bw) - Math.max(ax, bx)) *
    Math.max(0, Math.min(ay + ah, by + bh) - Math.max(ay, by));
  return area / Math.max(1e-8, aw * ah + bw * bh - area);
}
export function decodePlateOutputs(
  logits: Float32Array,
  logitDims: readonly number[],
  boxes: Float32Array,
  boxDims: readonly number[],
  width: number,
  height: number,
): PlateCandidate[] {
  if (
    logitDims.length !== 3 ||
    logitDims[0] !== 1 ||
    logitDims[1] !== ROWS ||
    logitDims[2] !== 1 ||
    boxDims.length !== 3 ||
    boxDims[0] !== 1 ||
    boxDims[1] !== ROWS ||
    boxDims[2] !== 4 ||
    logits.length !== ROWS ||
    boxes.length !== ROWS * 4
  )
    throw new Error(
      "Unexpected plate model outputs; expected logits [1,300,1] and pred_boxes [1,300,4].",
    );
  if (
    !Number.isFinite(width) ||
    !Number.isFinite(height) ||
    width <= 0 ||
    height <= 0
  )
    throw new Error("Plate source dimensions must be positive and finite.");
  const candidates: PlateCandidate[] = [];
  for (let row = 0; row < ROWS; row++) {
    const logit = logits[row];
    if (!Number.isFinite(logit)) continue;
    const score = 1 / (1 + Math.exp(-logit));
    if (score < 0.05) continue;
    const offset = row * 4;
    const cx = boxes[offset],
      cy = boxes[offset + 1],
      w = boxes[offset + 2],
      h = boxes[offset + 3];
    if (
      ![cx, cy, w, h].every(Number.isFinite) ||
      w <= 0 ||
      h <= 0 ||
      cx < 0 ||
      cy < 0 ||
      cx > 1 ||
      cy > 1
    )
      continue;
    const x0 = Math.max(0, (cx - w / 2) * width);
    const y0 = Math.max(0, (cy - h / 2) * height);
    const x1 = Math.min(width, (cx + w / 2) * width);
    const y1 = Math.min(height, (cy + h / 2) * height);
    if (x1 <= x0 || y1 <= y0) continue;
    candidates.push({ bbox: [x0, y0, x1 - x0, y1 - y0], score });
  }
  candidates.sort((a, b) => b.score - a.score);
  const distinct: PlateCandidate[] = [];
  for (const candidate of candidates) {
    if (distinct.every((other) => overlap(candidate, other) < 0.5))
      distinct.push(candidate);
    if (distinct.length === 5) break;
  }
  return distinct;
}
export function plateRecognitionSize(
  width: number,
  height: number,
): {
  width: number;
  contentWidth: number;
} {
  if (
    !Number.isInteger(width) ||
    !Number.isInteger(height) ||
    width < 1 ||
    height < 1
  )
    throw new Error("The plate crop must have valid pixel dimensions.");
  const tensorWidth = Math.min(
    3200,
    Math.floor(48 * Math.max(320 / 48, width / height)),
  );
  return {
    width: tensorWidth,
    contentWidth: Math.min(tensorWidth, Math.ceil((48 * width) / height)),
  };
}
export function normalizeRecognizedPlate(
  recognition: PlateRecognition,
): PlateRecognition {
  const rawText = recognition.plate;
  const normalized = rawText.normalize("NFKC").toUpperCase();
  const unsupportedScript = /[^A-Z0-9\s\p{P}]/u.test(normalized);
  return {
    plate: unsupportedScript ? "" : normalizePlateText(normalized),
    confidence: recognition.confidence,
    rawText,
    unsupportedScript,
  };
}
