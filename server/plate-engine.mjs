import { fork } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { loadVisionShared } from "./vision-shared.mjs";
export const PLATE_ASSETS = Object.freeze({
  detector: Object.freeze({
    file: "plate-rtdetr.onnx",
    bytes: 80671879,
    sha256: "50f9bf9d7eaa97ade59063ba608107203d0575a84c0fb27e0ebf3bab6f594366",
  }),
  recognizer: Object.freeze({
    file: "plate-recognizer.onnx",
    bytes: 21159378,
    sha256: "5435fd747c9e0efe15a96d0b378d5bd157e9492ed8fd80edf08f30d02fa24634",
  }),
  dictionary: Object.freeze({
    file: "plate-recognizer.dictionary.json",
    sha256: "a49d51120786924a642c9e8a14b2a2ab73c019699abf5b2b6970ec7355c0415f",
  }),
});
const BASE_INFO = Object.freeze({
  method: "rtdetr-v2-r18-ppocr-v6-small-native-v1",
  detector: "RT-DETRv2-R18",
  recognizer: "PP-OCRv6_small_rec",
  modelSha256: PLATE_ASSETS.detector.sha256,
  recognizerSha256: PLATE_ASSETS.recognizer.sha256,
  dictionarySha256: PLATE_ASSETS.dictionary.sha256,
  provider: "cpu",
  intraOpNumThreads: 1,
  assetsVerified: false,
  minPlateWidth: 80,
  minPlateHeight: 18,
  minOcrScore: 75,
  regionScoreFloor: 0.05,
  confidenceMeaning:
    "Mean retained OCR token model scores ×100; not a probability of correct identity.",
  verification:
    "Unverified candidate; requires repeated observations and review.",
});
function error(message, code, name = "Error") {
  return Object.assign(new Error(message), { code, name });
}
function validateFrame({ rgb, width, height } = {}) {
  if (
    !(rgb instanceof Uint8Array) ||
    !Number.isSafeInteger(width) ||
    !Number.isSafeInteger(height) ||
    width < 1 ||
    height < 1 ||
    width > 4096 ||
    height > 4096 ||
    width * height > 4194304 ||
    rgb.length !== width * height * 3
  )
    throw error(
      "Plate reading requires one native RGB vehicle crop, at most 4 million pixels.",
      "PLATE_INPUT",
    );
  return { rgb, width, height };
}
const abstain = (reason, state = "unreadable", extras = {}) => ({
  state,
  plate: null,
  confidence: null,
  plateBox: null,
  reason,
  detectorScore: null,
  ...extras,
});
export function verifyPlateAsset(bytes, name) {
  const asset = PLATE_ASSETS[name];
  if (
    !asset ||
    !(bytes instanceof Uint8Array) ||
    (asset.bytes && bytes.length !== asset.bytes) ||
    createHash("sha256").update(bytes).digest("hex") !== asset.sha256
  )
    throw error(
      "A local plate model or dictionary failed integrity verification. Run npm run setup:plates and rebuild.",
      "PLATE_ASSET",
    );
}
export async function readVehiclePlate(frame, { detect, recognize, shared }) {
  validateFrame(frame);
  const frozen = { ...frame, rgb: Uint8Array.from(frame.rgb) };
  if (frozen.width < 80 || frozen.height < 18)
    return abstain(
      "The native vehicle crop cannot contain an 80 × 18 pixel plate.",
    );
  const candidates = await detect(frozen);
  if (
    !Array.isArray(candidates) ||
    candidates.some(
      (p) =>
        !p ||
        !Array.isArray(p.bbox) ||
        p.bbox.length !== 4 ||
        !p.bbox.every(Number.isFinite) ||
        p.bbox[2] <= 0 ||
        p.bbox[3] <= 0 ||
        !Number.isFinite(p.score) ||
        p.score < 0.05 ||
        p.score > 1,
    )
  )
    throw error("The plate detector returned invalid regions.", "PLATE_OUTPUT");
  if (!candidates.length)
    return abstain("No sufficiently supported plate region was detected.");
  if (candidates.length !== 1)
    return abstain(
      "Multiple distinct plate regions were proposed in this vehicle crop.",
      "ambiguous",
    );
  const candidate = candidates[0];
  const [x, y, w, h] = candidate.bbox;
  const left = Math.max(0, Math.ceil(x)),
    top = Math.max(0, Math.ceil(y));
  const right = Math.min(frozen.width, Math.floor(x + w)),
    bottom = Math.min(frozen.height, Math.floor(y + h));
  if (right <= left || bottom <= top)
    return abstain(
      "The proposed plate lies outside the selected vehicle crop.",
    );
  const plateBox = [
    left,
    top,
    Math.max(0, right - left),
    Math.max(0, bottom - top),
  ];
  const detail = { plateBox, detectorScore: candidate.score };
  if (plateBox[2] < 80 || plateBox[3] < 18)
    return abstain(
      "The proposed plate has fewer than 80 × 18 native pixels; resizing cannot recover missing detail.",
      "unreadable",
      detail,
    );
  const px = plateBox[2] * 0.04,
    py = plateBox[3] * 0.08;
  const cropLeft = Math.max(0, Math.floor(left - px)),
    cropTop = Math.max(0, Math.floor(top - py));
  const cropRight = Math.min(frozen.width, Math.ceil(right + px)),
    cropBottom = Math.min(frozen.height, Math.ceil(bottom + py));
  const raw = await recognize(frozen, [
    cropLeft,
    cropTop,
    cropRight - cropLeft,
    cropBottom - cropTop,
  ]);
  if (
    !raw ||
    typeof raw.plate !== "string" ||
    !Number.isFinite(raw.confidence) ||
    raw.confidence < 0 ||
    raw.confidence > 100
  )
    throw error(
      "The plate recognizer returned invalid text or scores.",
      "PLATE_OUTPUT",
    );
  const normalized = shared.normalizeRecognizedPlate(raw);
  if (normalized.unsupportedScript)
    return abstain(
      "The text includes unsupported characters; no partial Latin registration is returned.",
      "unreadable",
      detail,
    );
  if (!shared.isPlateCandidate(normalized.plate) || normalized.confidence < 75)
    return abstain(
      "The plate text is incomplete or its OCR model score is below 75/100.",
      "unreadable",
      { ...detail, confidence: normalized.confidence },
    );
  return {
    state: "read",
    plate: normalized.plate,
    confidence: normalized.confidence,
    ...detail,
    reason:
      "Unverified OCR candidate from this frozen vehicle crop; repeat observation and review are required.",
  };
}
export async function createNativePlateReader({
  assetDirectory = new URL("../public/models/", import.meta.url),
  shared: injectedShared,
} = {}) {
  const shared = injectedShared ?? (await loadVisionShared());
  for (const name of [
    "plateRgbaToTensor",
    "plateRecognitionTensor",
    "decodePlateOutputs",
    "decodePlateCtc",
    "plateRecognitionSize",
    "normalizeRecognizedPlate",
    "isPlateCandidate",
  ])
    if (typeof shared[name] !== "function")
      throw error(
        "Shared plate helpers are missing. Rebuild before starting automatic reading.",
        "PLATE_ASSET",
      );
  const buffers = {};
  for (const [name, asset] of Object.entries(PLATE_ASSETS)) {
    try {
      buffers[name] = await readFile(new URL(asset.file, assetDirectory));
    } catch {
      throw error(
        "Local plate assets are unavailable. Run npm run setup:plates and rebuild.",
        "PLATE_ASSET",
      );
    }
    verifyPlateAsset(buffers[name], name);
  }
  const characters = JSON.parse(buffers.dictionary.toString("utf8"));
  if (
    !Array.isArray(characters) ||
    characters.length !== 18710 ||
    characters[0] !== "" ||
    characters[18709] !== " " ||
    characters.some((x) => typeof x !== "string")
  )
    throw error(
      "The verified plate dictionary has an incompatible shape.",
      "PLATE_ASSET",
    );
  const [ort, { default: sharp }] = await Promise.all([
    import("onnxruntime-node"),
    import("sharp"),
  ]);
  sharp.concurrency(1);
  sharp.cache(false);
  let detector, recognizer;
  const options = {
    executionProviders: ["cpu"],
    intraOpNumThreads: 1,
    interOpNumThreads: 1,
    executionMode: "sequential",
    graphOptimizationLevel: "all",
    extra: {
      session: {
        intra_op: { allow_spinning: "0" },
        inter_op: { allow_spinning: "0" },
      },
    },
  };
  try {
    detector = await ort.InferenceSession.create(buffers.detector, options);
    recognizer = await ort.InferenceSession.create(buffers.recognizer, options);
    if (
      detector.inputNames.join() !== "pixel_values" ||
      !detector.outputNames.includes("logits") ||
      !detector.outputNames.includes("pred_boxes") ||
      recognizer.inputNames.join() !== "x" ||
      recognizer.outputNames.join() !== "fetch_name_0"
    )
      throw error("Unexpected pinned plate model graph.", "PLATE_ASSET");
  } catch (cause) {
    await Promise.allSettled([detector?.release(), recognizer?.release()]);
    throw error(
      "The native CPU plate models could not initialize. Check local model setup and available memory.",
      cause?.code === "PLATE_ASSET" ? "PLATE_ASSET" : "PLATE_INITIALIZE",
    );
  }
  let closed = false,
    active = null,
    closing;
  const run = async (session, inputName, data, dims, decode) => {
    const input = new ort.Tensor("float32", data, dims);
    let outputs;
    try {
      outputs = await session.run({ [inputName]: input });
      return decode(outputs);
    } finally {
      input.dispose();
      if (outputs)
        for (const tensor of Object.values(outputs)) tensor.dispose();
    }
  };
  const floatOutput = (tensor) => {
    if (
      !tensor ||
      tensor.type !== "float32" ||
      !(tensor.data instanceof Float32Array)
    )
      throw error("Unexpected plate output tensor.", "PLATE_OUTPUT");
    return tensor;
  };
  const rgba = async (frame, width, height, box) => {
    let pipeline = sharp(frame.rgb, {
      raw: { width: frame.width, height: frame.height, channels: 3 },
    });
    if (box)
      pipeline = pipeline.extract({
        left: box[0],
        top: box[1],
        width: box[2],
        height: box[3],
      });
    const data = await pipeline
      .resize(width, height, {
        fit: "fill",
        kernel: sharp.kernel.linear,
        fastShrinkOnLoad: false,
      })
      .ensureAlpha()
      .raw()
      .toBuffer();
    return new Uint8ClampedArray(data.buffer, data.byteOffset, data.byteLength);
  };
  const info = Object.freeze({
    ...BASE_INFO,
    assetsVerified: true,
    runtime: "onnxruntime-node",
    runtimeVersion: ort.env.versions.node ?? "unknown",
    preprocessing:
      "RT-DETR RGB0..1 stretch640; PP-OCR sharp linear resize height48, BGR[-1,1], normalized-zero right padding; native detail checked before resize.",
    sharedBundleSha256: shared.bundleSha256 ?? null,
  });
  return {
    info,
    read(frame) {
      if (closed)
        return Promise.reject(error("Plate engine is closed.", "PLATE_CLOSED"));
      if (active)
        return Promise.reject(error("Plate engine is busy.", "PLATE_BUSY"));
      const operation = readVehiclePlate(frame, {
        shared,
        detect: async (frozen) =>
          run(
            detector,
            "pixel_values",
            shared.plateRgbaToTensor(await rgba(frozen, 640, 640)),
            [1, 3, 640, 640],
            (outputs) => {
              const logits = floatOutput(outputs.logits),
                boxes = floatOutput(outputs.pred_boxes);
              return shared.decodePlateOutputs(
                logits.data,
                logits.dims,
                boxes.data,
                boxes.dims,
                frozen.width,
                frozen.height,
              );
            },
          ),
        recognize: async (frozen, box) => {
          const size = shared.plateRecognitionSize(box[2], box[3]);
          const pixels = await rgba(frozen, size.contentWidth, 48, box);
          return run(
            recognizer,
            "x",
            shared.plateRecognitionTensor(
              pixels,
              size.contentWidth,
              size.width,
            ),
            [1, 3, 48, size.width],
            (outputs) => {
              const prediction = floatOutput(outputs.fetch_name_0);
              return shared.decodePlateCtc(
                prediction.data,
                prediction.dims,
                characters,
              );
            },
          );
        },
      });
      active = operation;
      return operation
        .then((result) => {
          if (closed)
            throw error(
              "Plate reading was cancelled.",
              "PLATE_CLOSED",
              "AbortError",
            );
          return result;
        })
        .finally(() => {
          if (active === operation) active = null;
        });
    },
    close() {
      if (closing) return closing;
      closed = true;
      return (closing = (async () => {
        try {
          await active;
        } catch {}
        await Promise.allSettled([detector.release(), recognizer.release()]);
      })());
    },
  };
}
export async function createPlateEngine({
  timeoutMs = 45000,
  cleanupTimeoutMs = 2000,
  spawnWorker = () =>
    fork(new URL("./plate-worker.mjs", import.meta.url), [], {
      execArgv: [],
      serialization: "advanced",
      stdio: ["ignore", "ignore", "ignore", "ipc"],
      windowsHide: true,
    }),
} = {}) {
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120000)
    throw new RangeError("Invalid plate worker deadline.");
  if (
    !Number.isInteger(cleanupTimeoutMs) ||
    cleanupTimeoutMs < 1 ||
    cleanupTimeoutMs > 10000
  )
    throw new RangeError("Invalid plate worker cleanup deadline.");
  let worker,
    pending,
    closed = false,
    closing,
    nextId = 0,
    currentInfo = BASE_INFO;
  const stop = (failure) => {
    if (pending) {
      clearTimeout(pending.timer);
      pending.reject(failure);
      pending = null;
    }
    closed = true;
    if (closing) return closing;
    const child = worker;
    worker = null;
    closing = child
      ? new Promise((resolve, reject) => {
          let timer;
          const done = () => {
            clearTimeout(timer);
            resolve();
          };
          child.once("exit", done);
          try {
            child.kill("SIGKILL");
          } catch {}
          if (
            (child.exitCode !== null && child.exitCode !== undefined) ||
            (child.signalCode !== null && child.signalCode !== undefined)
          )
            done();
          else
            timer = setTimeout(() => {
              child.removeListener("exit", done);
              reject(
                error(
                  "Plate worker exit could not be confirmed. Keep automatic reading stopped; do not start a replacement until cleanup is resolved.",
                  "PLATE_CLEANUP",
                ),
              );
            }, cleanupTimeoutMs);
        })
      : Promise.resolve();
    void closing.catch(() => {});
    return closing;
  };
  return {
    get info() {
      return currentInfo;
    },
    read(frame) {
      if (closed)
        return Promise.reject(
          error(
            "Plate engine is closed. Create a new engine to retry.",
            "PLATE_CLOSED",
          ),
        );
      if (pending)
        return Promise.reject(
          error(
            "Plate engine is busy; keep at most one waiting vehicle crop.",
            "PLATE_BUSY",
          ),
        );
      try {
        validateFrame(frame);
      } catch (cause) {
        return Promise.reject(cause);
      }
      if (frame.width < 80 || frame.height < 18)
        return Promise.resolve(
          abstain(
            "The native vehicle crop cannot contain an 80 × 18 pixel plate.",
          ),
        );
      const frozen = {
        rgb: Uint8Array.from(frame.rgb),
        width: frame.width,
        height: frame.height,
      };
      return new Promise((resolve, reject) => {
        const id = ++nextId;
        const timer = setTimeout(
          () =>
            void stop(
              error(
                "The local plate worker timed out. Close the engine and confirm worker cleanup before retrying.",
                "PLATE_TIMEOUT",
              ),
            ),
          timeoutMs,
        );
        pending = {
          id,
          resolve,
          reject,
          timer,
          width: frame.width,
          height: frame.height,
        };
        try {
          if (!worker) {
            const child = spawnWorker();
            worker = child;
            child.on("message", (message) => {
              if (worker !== child || closed) return;
              if (!pending || message?.id !== pending.id) {
                void stop(
                  error(
                    "The plate worker returned an unexpected response.",
                    "PLATE_PROTOCOL",
                  ),
                );
                return;
              }
              if (message.error) {
                void stop(
                  error(
                    message.error.code === "PLATE_ASSET"
                      ? "Local plate assets are unavailable or invalid. Run npm run setup:plates and rebuild."
                      : "The local CPU plate reader failed. Close the engine and confirm worker cleanup before retrying.",
                    message.error.code === "PLATE_ASSET"
                      ? "PLATE_ASSET"
                      : "PLATE_WORKER",
                  ),
                );
                return;
              }
              const result = message.result;
              if (
                !result ||
                !["read", "unreadable", "ambiguous"].includes(result.state) ||
                typeof result.reason !== "string" ||
                (result.confidence !== null &&
                  (!Number.isFinite(result.confidence) ||
                    result.confidence < 0 ||
                    result.confidence > 100)) ||
                (result.detectorScore !== null &&
                  (!Number.isFinite(result.detectorScore) ||
                    result.detectorScore < 0.05 ||
                    result.detectorScore > 1)) ||
                (result.plateBox !== null &&
                  (!Array.isArray(result.plateBox) ||
                    result.plateBox.length !== 4 ||
                    !result.plateBox.every(Number.isSafeInteger) ||
                    result.plateBox[0] < 0 ||
                    result.plateBox[1] < 0 ||
                    result.plateBox[2] < 1 ||
                    result.plateBox[3] < 1 ||
                    result.plateBox[0] + result.plateBox[2] > pending.width ||
                    result.plateBox[1] + result.plateBox[3] >
                      pending.height)) ||
                (result.state === "read" &&
                  (typeof result.plate !== "string" ||
                    !/^[A-Z0-9]{2,12}$/.test(result.plate) ||
                    !Number.isFinite(result.confidence) ||
                    result.confidence < 75 ||
                    result.confidence > 100)) ||
                (result.state === "read" &&
                  (!result.plateBox ||
                    result.plateBox[2] < 80 ||
                    result.plateBox[3] < 18 ||
                    result.detectorScore === null)) ||
                (result.state !== "read" && result.plate !== null)
              ) {
                void stop(
                  error(
                    "The plate worker returned an invalid result.",
                    "PLATE_PROTOCOL",
                  ),
                );
                return;
              }
              const active = pending;
              pending = null;
              clearTimeout(active.timer);
              if (message.info?.assetsVerified === true)
                currentInfo = Object.freeze({ ...BASE_INFO, ...message.info });
              active.resolve(result);
            });
            child.on("error", () => {
              if (worker === child)
                void stop(
                  error(
                    "The local plate worker could not start.",
                    "PLATE_WORKER",
                  ),
                );
            });
            child.on("exit", () => {
              if (worker === child && !closed)
                void stop(
                  error(
                    "The local plate worker exited unexpectedly.",
                    "PLATE_WORKER",
                  ),
                );
            });
          }
          worker.send({ id, method: "read", frame: frozen }, (cause) => {
            if (cause && !closed)
              void stop(
                error(
                  "The plate crop could not be sent to the local worker.",
                  "PLATE_WORKER",
                ),
              );
          });
        } catch {
          void stop(
            error("The local plate worker could not start.", "PLATE_WORKER"),
          );
        }
      });
    },
    close() {
      return stop(
        error("Plate reading was cancelled.", "PLATE_CLOSED", "AbortError"),
      );
    },
  };
}
