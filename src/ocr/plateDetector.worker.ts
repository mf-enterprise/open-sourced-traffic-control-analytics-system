import type { InferenceSession, Tensor } from "onnxruntime-web";
import * as workerRuntime from "onnxruntime-web/webgpu";
import {
  plateRecognitionTensor,
  decodePlateCtc,
  plateRgbaToTensor,
  decodePlateOutputs,
} from "./plateModel";
import type { PlateCandidate, PlateRecognition } from "./plateModel";
export {
  plateRecognitionTensor,
  decodePlateCtc,
  plateRgbaToTensor,
  decodePlateOutputs,
} from "./plateModel";
export type { PlateCandidate, PlateRecognition } from "./plateModel";
export type PlateWorkerRequest =
  | {
      type: "initialize";
    }
  | {
      type: "recognize";
      id: number;
      pixels: ArrayBuffer;
      width: number;
      contentWidth: number;
    }
  | {
      type: "detect";
      id: number;
      pixels: ArrayBuffer;
      width: number;
      height: number;
    };
export type PlateWorkerResponse =
  | {
      type: "status";
      message: string;
    }
  | {
      type: "ready";
    }
  | {
      type: "result";
      id: number;
      candidates: PlateCandidate[];
    }
  | {
      type: "recognized";
      id: number;
      recognition: PlateRecognition;
    }
  | {
      type: "error";
      id?: number;
      message: string;
    };
const INPUT = 640;
const MODEL_BYTES = 80671879;
const MODEL_URL = "/models/plate-rtdetr.onnx";
function inspectOutputs(outputs: Record<string, Tensor>): {
  logits: Tensor;
  boxes: Tensor;
} {
  const logits = outputs.logits,
    boxes = outputs.pred_boxes;
  if (
    !logits ||
    !boxes ||
    logits.type !== "float32" ||
    boxes.type !== "float32" ||
    !(logits.data instanceof Float32Array) ||
    !(boxes.data instanceof Float32Array)
  )
    throw new Error(
      "The plate model did not return the expected float32 tensors.",
    );
  decodePlateOutputs(
    logits.data,
    logits.dims,
    boxes.data,
    boxes.dims,
    INPUT,
    INPUT,
  );
  return { logits, boxes };
}
const workerScope = globalThis as unknown as {
  document?: unknown;
  location: {
    origin: string;
  };
  postMessage?: (message: PlateWorkerResponse) => void;
  onmessage: ((event: MessageEvent<PlateWorkerRequest>) => void) | null;
};
if (
  typeof workerScope.postMessage === "function" &&
  typeof workerScope.document === "undefined"
) {
  const send = (message: PlateWorkerResponse) =>
    workerScope.postMessage!(message);
  const runtime = workerRuntime;
  let session: InferenceSession | null = null;
  let loading: Promise<void> | null = null;
  let queue: Promise<void> = Promise.resolve();
  let outstanding = 0;
  let recognizer: InferenceSession | null = null;
  let characters: string[] = [];
  async function loadRecognizer() {
    if (recognizer) return;
    send({
      type: "status",
      message: "Loading local plate text recognizer · CPU…",
    });
    let candidate: InferenceSession | null = null;
    try {
      const [modelResponse, dictionaryResponse] = await Promise.all([
        fetch("/models/plate-recognizer.onnx", {
          signal: AbortSignal.timeout(90000),
        }),
        fetch("/models/plate-recognizer.dictionary.json", {
          signal: AbortSignal.timeout(90000),
        }),
      ]);
      if (!modelResponse.ok || !dictionaryResponse.ok)
        throw new Error(
          "Plate text model is unavailable. Run npm run setup:plates, rebuild, and retry, or use the explicit Tesseract fallback.",
        );
      const [bytes, dictionary] = await Promise.all([
        modelResponse.arrayBuffer(),
        dictionaryResponse.json(),
      ]);
      if (
        bytes.byteLength !== 21159378 ||
        !Array.isArray(dictionary) ||
        dictionary.length !== 18710 ||
        dictionary[0] !== "" ||
        dictionary[18709] !== " " ||
        !dictionary.every((token) => typeof token === "string")
      )
        throw new Error(
          "Plate text model or dictionary is incomplete. Run npm run setup:plates and rebuild.",
        );
      candidate = await runtime.InferenceSession.create(bytes, {
        executionProviders: ["wasm"],
        graphOptimizationLevel: "all",
      });
      if (
        candidate.inputNames.length !== 1 ||
        candidate.inputNames[0] !== "x" ||
        candidate.outputNames.length !== 1 ||
        candidate.outputNames[0] !== "fetch_name_0"
      )
        throw new Error(
          "Unexpected plate text graph; reinstall the pinned model.",
        );
      const input = new runtime.Tensor(
        "float32",
        new Float32Array(3 * 48 * 320),
        [1, 3, 48, 320],
      );
      let output: Record<string, Tensor> | undefined;
      try {
        output = await candidate.run({ x: input });
        const prediction = output.fetch_name_0;
        if (
          prediction.type !== "float32" ||
          !(prediction.data instanceof Float32Array)
        )
          throw new Error("Unexpected plate text output type.");
        decodePlateCtc(prediction.data, prediction.dims, dictionary);
      } finally {
        input.dispose();
        if (output) Object.values(output).forEach((tensor) => tensor.dispose());
      }
      characters = dictionary;
      recognizer = candidate;
      send({
        type: "status",
        message: "Plate text recognizer ready · human verification required",
      });
    } catch (error) {
      if (candidate) await candidate.release().catch(() => undefined);
      throw error;
    }
  }
  async function recognize(
    message: Extract<
      PlateWorkerRequest,
      {
        type: "recognize";
      }
    >,
  ) {
    await loadRecognizer();
    const input = new runtime.Tensor(
      "float32",
      plateRecognitionTensor(
        new Uint8ClampedArray(message.pixels),
        message.contentWidth,
        message.width,
      ),
      [1, 3, 48, message.width],
    );
    let outputs: Record<string, Tensor> | undefined;
    try {
      outputs = await recognizer!.run({ x: input });
      const prediction = outputs.fetch_name_0;
      if (
        prediction.type !== "float32" ||
        !(prediction.data instanceof Float32Array)
      )
        throw new Error("Unexpected plate text output type.");
      send({
        type: "recognized",
        id: message.id,
        recognition: decodePlateCtc(
          prediction.data,
          prediction.dims,
          characters,
        ),
      });
    } finally {
      input.dispose();
      if (outputs) Object.values(outputs).forEach((tensor) => tensor.dispose());
    }
  }
  async function load(): Promise<void> {
    if (session) return;
    if (loading) return loading;
    loading = (async () => {
      let candidate: InferenceSession | null = null;
      try {
        send({
          type: "status",
          message: "Loading optional plate detector · CPU…",
        });
        runtime.env.wasm.numThreads = 1;
        runtime.env.wasm.wasmPaths = `${workerScope.location.origin}/onnx/`;
        const response = await fetch(MODEL_URL, {
          signal: AbortSignal.timeout(90000),
        });
        if (!response.ok)
          throw new Error(
            `Plate model returned HTTP ${response.status}. Run node scripts/fetch-plate-model.mjs, rebuild, and retry.`,
          );
        const bytes = await response.arrayBuffer();
        if (bytes.byteLength !== MODEL_BYTES)
          throw new Error(
            "Plate model is missing or incomplete. Run node scripts/fetch-plate-model.mjs, rebuild, and retry.",
          );
        candidate = await runtime.InferenceSession.create(bytes, {
          executionProviders: ["wasm"],
          graphOptimizationLevel: "all",
        });
        if (
          candidate.inputNames.length !== 1 ||
          candidate.inputNames[0] !== "pixel_values" ||
          !candidate.outputNames.includes("logits") ||
          !candidate.outputNames.includes("pred_boxes")
        )
          throw new Error(
            "Unexpected plate model graph. Reinstall its verified model asset.",
          );
        const input = new runtime.Tensor(
          "float32",
          new Float32Array(3 * INPUT * INPUT).fill(0.5),
          [1, 3, INPUT, INPUT],
        );
        let outputs: Record<string, Tensor> | undefined;
        try {
          outputs = await candidate.run({ pixel_values: input });
          inspectOutputs(outputs);
        } finally {
          input.dispose();
          if (outputs)
            Object.values(outputs).forEach((output) => output.dispose());
        }
        session = candidate;
        send({
          type: "status",
          message: "Plate detector ready · unverified region suggestions",
        });
      } catch (error) {
        if (candidate) await candidate.release().catch(() => undefined);
        throw error;
      } finally {
        loading = null;
      }
    })();
    return loading;
  }
  async function infer(
    message: Extract<
      PlateWorkerRequest,
      {
        type: "detect";
      }
    >,
  ) {
    await load();
    const input = new runtime!.Tensor(
      "float32",
      plateRgbaToTensor(new Uint8ClampedArray(message.pixels)),
      [1, 3, INPUT, INPUT],
    );
    let outputs: Record<string, Tensor> | undefined;
    try {
      outputs = await session!.run({ pixel_values: input });
      const { logits, boxes } = inspectOutputs(outputs);
      const candidates = decodePlateOutputs(
        logits.data as Float32Array,
        logits.dims,
        boxes.data as Float32Array,
        boxes.dims,
        message.width,
        message.height,
      );
      send({ type: "result", id: message.id, candidates });
    } finally {
      input.dispose();
      if (outputs) Object.values(outputs).forEach((output) => output.dispose());
    }
  }
  workerScope.onmessage = ({ data }) => {
    if (data.type === "initialize") {
      void load()
        .then(() => send({ type: "ready" }))
        .catch((error: unknown) =>
          send({
            type: "error",
            message: error instanceof Error ? error.message : String(error),
          }),
        );
      return;
    }
    if (data.type !== "detect" && data.type !== "recognize") return;
    if (outstanding >= 2) {
      send({
        type: "error",
        id: data.id,
        message: "Plate detector is busy; wait for the current suggestions.",
      });
      return;
    }
    outstanding++;
    queue = queue
      .then(() => (data.type === "detect" ? infer(data) : recognize(data)))
      .catch((error: unknown) =>
        send({
          type: "error",
          id: data.id,
          message: error instanceof Error ? error.message : String(error),
        }),
      )
      .finally(() => {
        outstanding--;
      });
  };
}
