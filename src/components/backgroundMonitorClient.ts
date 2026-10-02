import type { Calibration, Track } from "../vision/types";
import type { CountingLine, CrossingCounts } from "../vision/counting";
import type { CameraStabilityStatus } from "../vision/cameraStability";
import type { NetworkCameraConfig } from "../useTraffic";
export type BackgroundCameraConfig =
  | NetworkCameraConfig
  | {
      type: "usb";
      deviceId: string;
      name?: string;
    };
export interface LocalCameraInventory {
  supported: boolean;
  devices: {
    id: string;
    name: string;
  }[];
  reason: string | null;
}
export interface AutomaticPlateReading {
  trackId: number;
  state: "pending" | "unreadable" | "candidate" | "conflict";
  plate: string | null;
  confidence: number | null;
  samples: number;
  sourceTimestamp: number;
  observedAt: string;
  reason: string;
  method: "rtdetr-ppocrv6-consensus-v1";
}
export interface AutomaticPlateStatus {
  enabled: boolean;
  state: "idle" | "loading" | "running" | "unavailable" | "disabled";
  pending: number;
  reads: number;
  reason: string;
}
export interface MonitorStatus {
  trafficCameraId?: string | null;
  automaticPlates?: AutomaticPlateStatus;
  cameraStability?: CameraStabilityStatus;
  countingStability?: CameraStabilityStatus;
  sessionId: string | null;
  state:
    | "idle"
    | "starting"
    | "running"
    | "stalled"
    | "reconnecting"
    | "stopping"
    | "stopped"
    | "error";
  message: string;
  sourceName: string | null;
  sourceType: string | null;
  startedAt: string | null;
  lastFrameAt: string | null;
  engine: {
    name: string;
    provider: string;
    warnings?: string[];
  } | null;
  config: {
    revision: number;
    speedLimitKmh: number;
    calibration: Calibration | null;
    countingLine: CountingLine | null;
    referenceFrame: {
      width: number;
      height: number;
    } | null;
  };
  stats: {
    observed: number;
    active: number;
    framesProcessed: number;
    framesDropped: number;
    analysisFps: number;
    crossings: CrossingCounts;
    casesCreated: number;
    pendingCases: number;
    pendingHistory?: boolean;
    elapsedSeconds: number;
    gapCount: number;
  };
  error: string | null;
  evidenceRecovery?: {
    pending: number;
    recovered: number;
    error: string | null;
  };
}
export interface MonitorFrame {
  plateReadings?: AutomaticPlateReading[];
  cameraStability?: CameraStabilityStatus;
  countingStability?: CameraStabilityStatus;
  sessionId: string;
  frameId: number;
  width: number;
  height: number;
  sourceTimestamp: number;
  captureTime: string;
  processedAt: string;
  jpeg: string;
  tracks: Track[];
  configRevision: number;
  speedLimitKmh: number;
  calibration: Calibration | null;
  countingLine: CountingLine | null;
}
export interface DecodedMonitorFrame<T> {
  bundle: MonitorFrame;
  image: T;
}
export class MonitorFrameSequence<T> {
  private session: string | null = null;
  private generation = 0;
  private lastId = -1;
  get after() {
    return this.lastId;
  }
  setSession(session: string | null) {
    if (this.session === session) return false;
    this.session = session;
    this.generation++;
    this.lastId = -1;
    return true;
  }
  async decode(
    bundle: MonitorFrame,
    decodeImage: (bundle: MonitorFrame) => Promise<T>,
  ): Promise<DecodedMonitorFrame<T> | null> {
    const generation = this.generation;
    if (
      !this.session ||
      bundle.sessionId !== this.session ||
      bundle.frameId <= this.lastId
    )
      return null;
    const image = await decodeImage(bundle);
    if (
      generation !== this.generation ||
      bundle.sessionId !== this.session ||
      bundle.frameId <= this.lastId
    )
      return null;
    this.lastId = bundle.frameId;
    return { bundle, image };
  }
  dispose() {
    this.generation++;
    this.session = null;
    this.lastId = -1;
  }
}
export class MonitorApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}
export async function monitorRequest<T>(
  path: string,
  signal: AbortSignal,
  method = "GET",
  body?: unknown,
): Promise<T> {
  return localRequest<T>(`/api/monitor${path}`, signal, method, body);
}
export function listLocalCameras(
  signal: AbortSignal,
): Promise<LocalCameraInventory> {
  return localRequest<LocalCameraInventory>("/api/local-cameras", signal);
}
async function localRequest<T>(
  path: string,
  signal: AbortSignal,
  method = "GET",
  body?: unknown,
): Promise<T> {
  const timeout = new AbortController();
  const timer = setTimeout(() => timeout.abort(), 12000);
  const cancel = () => timeout.abort();
  signal.addEventListener("abort", cancel, { once: true });
  if (signal.aborted) timeout.abort();
  try {
    const response = await fetch(path, {
      method,
      signal: timeout.signal,
      cache: "no-store",
      headers:
        body === undefined ? undefined : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const result = await response.json().catch(() => null);
    if (!response.ok)
      throw new MonitorApiError(
        result?.error ||
          "The monitoring service could not complete this request.",
        response.status,
      );
    if (!result)
      throw new MonitorApiError(
        "The monitoring service returned an unreadable response.",
        response.status,
      );
    return result as T;
  } catch (error) {
    if (timeout.signal.aborted && !signal.aborted)
      throw new MonitorApiError(
        "The monitoring service took too long to respond. Reconnecting…",
        408,
      );
    throw error;
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", cancel);
  }
}
export function decodeMonitorImage(
  bundle: MonitorFrame,
  signal: AbortSignal,
): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    const cleanup = () => {
      image.onload = null;
      image.onerror = null;
      signal.removeEventListener("abort", abort);
    };
    const abort = () => {
      cleanup();
      image.src = "";
      reject(new DOMException("Preview cancelled", "AbortError"));
    };
    if (signal.aborted) {
      abort();
      return;
    }
    signal.addEventListener("abort", abort, { once: true });
    image.onload = () => {
      cleanup();
      if (
        image.naturalWidth !== bundle.width ||
        image.naturalHeight !== bundle.height
      ) {
        reject(
          new Error("The analyzed image dimensions do not match its metadata."),
        );
      } else resolve(image);
    };
    image.onerror = () => {
      cleanup();
      reject(new Error("The analyzed preview could not be decoded."));
    };
    image.src = bundle.jpeg;
  });
}
