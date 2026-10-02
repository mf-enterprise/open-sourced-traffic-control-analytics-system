import type { Worker } from "tesseract.js";
import { normalizeConfidence, normalizePlateText } from "./plateText";
export interface OcrProgress {
  status: string;
  progress: number;
}
export interface PlateReading {
  plate: string;
  confidence: number;
}
type ReadJob = {
  resolve: (result: PlateReading) => void;
  reject: (error: Error) => void;
  onProgress?: (progress: OcrProgress) => void;
  timer?: ReturnType<typeof setTimeout>;
  settled: boolean;
};
type ReaderSession = {
  generation: number;
  closed: boolean;
  worker: Worker | null;
  creating: Promise<Worker> | null;
  queue: Promise<void>;
  jobs: Set<ReadJob>;
  activeJob: ReadJob | null;
  idleTimer?: ReturnType<typeof setTimeout>;
};
const READ_TIMEOUT_MS = 120000;
const IDLE_TIMEOUT_MS = 120000;
const MAX_PENDING_READS = 2;
let generation = 0;
let currentSession: ReaderSession | null = null;
const terminatedWorkers = new WeakSet<Worker>();
function abortError(): Error {
  const error = new Error("Registration reading was cancelled.");
  error.name = "AbortError";
  return error;
}
function isCurrent(session: ReaderSession): boolean {
  return (
    !session.closed &&
    currentSession === session &&
    session.generation === generation
  );
}
function terminate(worker: Worker): void {
  if (terminatedWorkers.has(worker)) return;
  terminatedWorkers.add(worker);
  try {
    void Promise.resolve(worker.terminate()).catch(() => undefined);
  } catch {}
}
function stopSession(session: ReaderSession, error: Error): void {
  if (session.closed) return;
  session.closed = true;
  clearTimeout(session.idleTimer);
  if (currentSession === session) {
    currentSession = null;
    generation++;
  }
  if (session.worker) terminate(session.worker);
  session.worker = null;
  session.activeJob = null;
  for (const job of session.jobs) {
    clearTimeout(job.timer);
    if (!job.settled) {
      job.settled = true;
      job.reject(error);
    }
  }
  session.jobs.clear();
}
export function releasePlateReader(): void {
  if (currentSession) stopSession(currentSession, abortError());
}
function report(
  session: ReaderSession,
  job: ReadJob,
  progress: OcrProgress,
): void {
  if (!isCurrent(session) || job.settled) return;
  try {
    job.onProgress?.(progress);
  } catch {}
}
async function getWorker(session: ReaderSession): Promise<Worker> {
  if (!isCurrent(session)) throw abortError();
  if (!session.creating) {
    session.creating = (async () => {
      const { createWorker, OEM, PSM } = await import("tesseract.js");
      if (!isCurrent(session)) throw abortError();
      const worker = await createWorker(
        "eng",
        OEM.LSTM_ONLY,
        {
          logger: (message) => {
            const job = session.activeJob;
            if (job)
              report(session, job, {
                status: message.status,
                progress: Number.isFinite(message.progress)
                  ? message.progress
                  : 0,
              });
          },
          errorHandler: (error: unknown) => {
            if (isCurrent(session))
              stopSession(
                session,
                error instanceof Error ? error : new Error(String(error)),
              );
          },
        },
        {
          load_system_dawg: "0",
          load_freq_dawg: "0",
        },
      );
      if (!isCurrent(session)) {
        terminate(worker);
        throw abortError();
      }
      session.worker = worker;
      try {
        await worker.setParameters({
          tessedit_pageseg_mode: PSM.SINGLE_LINE,
          tessedit_char_whitelist: "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789",
          preserve_interword_spaces: "1",
          user_defined_dpi: "300",
        });
        if (!isCurrent(session)) throw abortError();
      } catch (error) {
        terminate(worker);
        throw error;
      }
      return worker;
    })();
  }
  return session.creating;
}
export function readPlate(
  canvas: HTMLCanvasElement,
  onProgress?: (progress: OcrProgress) => void,
): Promise<PlateReading> {
  const session =
    currentSession ??
    (currentSession = {
      generation: ++generation,
      closed: false,
      worker: null,
      creating: null,
      queue: Promise.resolve(),
      jobs: new Set<ReadJob>(),
      activeJob: null,
    });
  if (session.jobs.size >= MAX_PENDING_READS)
    return Promise.reject(
      new Error(
        "Compatibility OCR is busy. Wait for a read to finish or cancel it.",
      ),
    );
  clearTimeout(session.idleTimer);
  return new Promise<PlateReading>((resolve, reject) => {
    const job: ReadJob = { resolve, reject, onProgress, settled: false };
    session.jobs.add(job);
    report(session, job, {
      status:
        session.jobs.size > 1
          ? "Waiting for compatibility OCR"
          : "Preparing recognition",
      progress: 0,
    });
    session.queue = session.queue.then(async () => {
      if (!isCurrent(session) || job.settled) return;
      session.activeJob = job;
      job.timer = setTimeout(() => {
        if (isCurrent(session) && !job.settled)
          stopSession(
            session,
            new Error(
              "Compatibility OCR timed out. Retry the read or use a clearer crop.",
            ),
          );
      }, READ_TIMEOUT_MS);
      try {
        const worker = await getWorker(session);
        if (!isCurrent(session) || job.settled) return;
        const result = await worker.recognize(
          canvas,
          { rotateAuto: false },
          { text: true },
        );
        if (!isCurrent(session) || job.settled) return;
        job.settled = true;
        job.resolve({
          plate: normalizePlateText(result.data.text),
          confidence: normalizeConfidence(result.data.confidence),
        });
      } catch (error) {
        if (isCurrent(session))
          stopSession(
            session,
            error instanceof Error ? error : new Error(String(error)),
          );
      } finally {
        clearTimeout(job.timer);
        session.jobs.delete(job);
        if (session.activeJob === job) session.activeJob = null;
        if (isCurrent(session) && !session.jobs.size) {
          session.idleTimer = setTimeout(() => {
            if (isCurrent(session) && !session.jobs.size)
              stopSession(session, abortError());
          }, IDLE_TIMEOUT_MS);
        }
      }
    });
  });
}
export interface NormalizedCrop {
  x: number;
  y: number;
  width: number;
  height: number;
}
export function nativePlateCrop(
  image: HTMLImageElement,
  crop: NormalizedCrop,
): HTMLCanvasElement {
  const left = Math.max(0, Math.ceil(crop.x * image.naturalWidth - 1e-8));
  const top = Math.max(0, Math.ceil(crop.y * image.naturalHeight - 1e-8));
  const right = Math.min(
    image.naturalWidth,
    Math.floor((crop.x + crop.width) * image.naturalWidth + 1e-8),
  );
  const bottom = Math.min(
    image.naturalHeight,
    Math.floor((crop.y + crop.height) * image.naturalHeight + 1e-8),
  );
  if (
    ![left, top, right, bottom].every(Number.isFinite) ||
    right <= left ||
    bottom <= top
  )
    throw new Error("Select a visible plate inside the evidence image.");
  const canvas = document.createElement("canvas");
  canvas.width = right - left;
  canvas.height = bottom - top;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("This browser cannot read the selected plate.");
  context.drawImage(
    image,
    left,
    top,
    canvas.width,
    canvas.height,
    0,
    0,
    canvas.width,
    canvas.height,
  );
  return canvas;
}
export function preparePlateCrop(
  image: HTMLImageElement,
  crop: NormalizedCrop,
): HTMLCanvasElement {
  const left = Math.max(0, Math.floor(crop.x * image.naturalWidth));
  const top = Math.max(0, Math.floor(crop.y * image.naturalHeight));
  const width = Math.max(
    1,
    Math.min(
      image.naturalWidth - left,
      Math.ceil(crop.width * image.naturalWidth),
    ),
  );
  const height = Math.max(
    1,
    Math.min(
      image.naturalHeight - top,
      Math.ceil(crop.height * image.naturalHeight),
    ),
  );
  const scale = Math.min(5, 1600 / width, 600 / height);
  const padding = 18;
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(width * scale)) + padding * 2;
  canvas.height = Math.max(1, Math.round(height * scale)) + padding * 2;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context)
    throw new Error("This browser cannot prepare the selected crop.");
  context.fillStyle = "#fff";
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = "high";
  context.drawImage(
    image,
    left,
    top,
    width,
    height,
    padding,
    padding,
    canvas.width - padding * 2,
    canvas.height - padding * 2,
  );
  const pixels = context.getImageData(
    padding,
    padding,
    canvas.width - padding * 2,
    canvas.height - padding * 2,
  );
  const histogram = new Uint32Array(256);
  for (let i = 0; i < pixels.data.length; i += 4) {
    const gray = Math.round(
      pixels.data[i]! * 0.2126 +
        pixels.data[i + 1]! * 0.7152 +
        pixels.data[i + 2]! * 0.0722,
    );
    histogram[gray]++;
    pixels.data[i] = pixels.data[i + 1] = pixels.data[i + 2] = gray;
  }
  const trim = (pixels.data.length / 4) * 0.015;
  let low = 0,
    high = 255,
    accumulated = 0;
  while (low < 254 && accumulated + histogram[low]! < trim)
    accumulated += histogram[low++]!;
  accumulated = 0;
  while (high > low + 1 && accumulated + histogram[high]! < trim)
    accumulated += histogram[high--]!;
  const range = Math.max(30, high - low);
  for (let i = 0; i < pixels.data.length; i += 4) {
    const gray = Math.max(
      0,
      Math.min(255, Math.round(((pixels.data[i]! - low) * 255) / range)),
    );
    pixels.data[i] = pixels.data[i + 1] = pixels.data[i + 2] = gray;
  }
  context.putImageData(pixels, padding, padding);
  return canvas;
}
