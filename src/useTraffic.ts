import { useCallback, useEffect, useRef, useState } from "react";
import { drawDemo } from "./demo/trafficScene";
import { HUD_WARNING_COLOR, objectHudColor } from "./hud";
import { isMediaDiscontinuity } from "./vision/mediaClock";
import { AnalysisCoverage, hasAnalysisGap } from "./vision/analysisCoverage";
import { getDetectorInfo, resetDetectorContext } from "./vision/detector";
import { formatSpeed, type SpeedUnit } from "./units";
import type { SpeedMeasurement } from "./vision/types";
import {
  assessCameraStability,
  type CameraReference,
  type CameraStabilityStatus,
} from "./vision/cameraStability";
import { CalibrationFrameBinding } from "./vision/calibrationFrameBinding";
import {
  createVehicleInspection,
  type VehicleInspection,
} from "./vision/vehicleInspection";
import {
  CrossingCounter,
  type CountingLine,
  type CrossingCounts,
} from "./vision/counting";
import {
  VehicleTracker,
  detectFrame,
  loadDetector,
  validateCalibration,
  pointInPolygon,
  type Calibration,
  type Track,
} from "./vision";
export type SourceKind = "demo" | "video" | "camera";
export type NetworkCameraConfig = {
  type: "url" | "rtsp" | "onvif" | "nest";
  url?: string;
  host?: string;
  port?: number;
  username?: string;
  password?: string;
  name?: string;
};
type CameraConnection = {
  id: string;
  name: string;
  type: NetworkCameraConfig["type"];
  playbackUrl: string;
  status: string;
};
type SourceResources = {
  url?: string;
  stream?: MediaStream;
  hls?: {
    destroy(): void;
  };
  cameraId?: string;
  disposeListeners?: () => void;
  cancelWait?: () => void;
};
function releaseNetworkCamera(id: string): void {
  void fetch(`/api/cameras/${encodeURIComponent(id)}`, {
    method: "DELETE",
    keepalive: true,
  }).catch(() => {});
}
export type CaptureSnapshot = Readonly<{
  sourceName: string;
  sourceKind: SourceKind;
  sourceTimestamp: number;
  captureTime: string;
  confidence: number;
  calibration: Calibration | null;
  className: string;
  speedKmh: number;
  speedMeasurement?: SpeedMeasurement | null;
  speedLimit: number;
  trackId: number;
  clientEventId: string;
  evidence: string;
  vehicleBox?: readonly [number, number, number, number] | null;
}>;
export type Observation = {
  id: number;
  eventId: string;
  className: string;
  speed: number | null;
  speedStatus?: string;
  time: number;
  lastSeen: number;
  confidence: number;
  overLimit: boolean;
  evidence?: string;
  capturedAt?: string;
  speedLimit?: number;
  violationSpeed?: number;
  capture?: CaptureSnapshot;
};
export type TrafficStats = {
  total: number;
  average: number;
  peak: number;
  active: number;
  violations: number;
  fps: number;
  elapsed: number;
  classes: Record<string, number>;
  history: Array<number | null>;
  crossings: CrossingCounts;
};
export type AnalysisHealth = {
  state: "live" | "starting" | "paused" | "hidden" | "gap" | "reconnect";
  message: string;
  notice: string;
  gapCount: number;
  totalGapSeconds: number;
  lastGapSeconds: number;
  currentGapSeconds: number;
};
const emptyAnalysis = (): AnalysisHealth => ({
  state: "starting",
  message: "Waiting for a freshly analyzed frame.",
  notice: "",
  gapCount: 0,
  totalGapSeconds: 0,
  lastGapSeconds: 0,
  currentGapSeconds: 0,
});
const uncalibratedCamera = (): CameraStabilityStatus => ({
  state: "uncalibrated",
  reason: "Set a road scale before measuring speed.",
  matched: 0,
  displacementPixels: null,
});
export type CaptureSample = {
  time: number;
  captureTime: string;
  limit: number;
  calibration: Calibration | null;
  source: SourceKind;
  sourceName: string;
  frameWidth?: number;
  frameHeight?: number;
};
type InspectionFrame = Pick<
  HTMLCanvasElement,
  "width" | "height" | "toDataURL"
>;
export class LatestAnalyzedVehicleFrame {
  private sequence = 0;
  private latest: {
    frame: InspectionFrame;
    frameWidth: number;
    frameHeight: number;
    frameId: number;
    sourceId: string;
    sample: CaptureSample;
    tracks: Track[];
  } | null = null;
  retain(
    frame: InspectionFrame,
    tracks: readonly Track[],
    sample: CaptureSample,
    sourceId: string,
  ) {
    this.latest = {
      frame,
      frameWidth: frame.width,
      frameHeight: frame.height,
      frameId: ++this.sequence,
      sourceId,
      sample: structuredClone(sample),
      tracks: structuredClone([...tracks]),
    };
  }
  clear() {
    this.latest = null;
  }
  get eventIds(): readonly string[] {
    const latest = this.latest;
    return latest
      ? latest.tracks
          .filter(
            (track) =>
              MOTOR_VEHICLE_CLASSES.has(track.className) ||
              track.className === "bicycle",
          )
          .map((track) => `${latest.sourceId}:${track.id}`)
      : [];
  }
  inspect(trackId: number, expectedEventId?: string): VehicleInspection | null {
    const latest = this.latest;
    if (
      !latest ||
      (expectedEventId !== undefined &&
        expectedEventId !== `${latest.sourceId}:${trackId}`)
    )
      return null;
    const track = latest.tracks.find(
      (candidate) =>
        candidate.id === trackId &&
        (MOTOR_VEHICLE_CLASSES.has(candidate.className) ||
          candidate.className === "bicycle"),
    );
    if (!track || latest.sample.source === "demo") return null;
    if (
      latest.frame.width !== latest.frameWidth ||
      latest.frame.height !== latest.frameHeight
    ) {
      this.clear();
      return null;
    }
    return createVehicleInspection({
      sourceName: latest.sample.sourceName,
      sourceKind: latest.sample.source,
      sourceId: latest.sourceId,
      frameId: latest.frameId,
      frameWidth: latest.frameWidth,
      frameHeight: latest.frameHeight,
      sourceTimestamp: latest.sample.time,
      captureTime: latest.sample.captureTime,
      imageUrl: latest.frame.toDataURL("image/jpeg", 0.94),
      track,
    });
  }
}
export const MOTOR_VEHICLE_CLASSES = new Set([
  "car",
  "truck",
  "bus",
  "motorcycle",
]);
const emptyStats = (): TrafficStats => ({
  total: 0,
  average: 0,
  peak: 0,
  active: 0,
  violations: 0,
  fps: 0,
  elapsed: 0,
  classes: {},
  history: Array(24).fill(null),
  crossings: {
    total: 0,
    forward: 0,
    reverse: 0,
    classes: { car: 0, truck: 0, bus: 0, motorcycle: 0, bicycle: 0 },
  },
});
const emptyTotals = () => ({
  total: 0,
  measured: 0,
  speedSum: 0,
  peak: 0,
  violations: 0,
  classes: {} as Record<string, number>,
});
const copyCalibration = (value: Calibration | null): Calibration | null =>
  value
    ? {
        points: value.points.map((p) => ({ ...p })) as Calibration["points"],
        widthMeters: value.widthMeters,
        lengthMeters: value.lengthMeters,
      }
    : null;
function freezeCalibration(value: Calibration | null): Calibration | null {
  const copy = copyCalibration(value);
  if (copy) {
    copy.points.forEach(Object.freeze);
    Object.freeze(copy.points);
    Object.freeze(copy);
  }
  return copy;
}
function freezeSpeedMeasurement(
  value: SpeedMeasurement | null | undefined,
): SpeedMeasurement | null {
  if (!value) return null;
  const copy: SpeedMeasurement = {
    method: value.method,
    samples: value.samples.map((sample) => ({
      timeSeconds: sample.timeSeconds,
      imagePoint: { ...sample.imagePoint },
    })),
    velocityMps: { ...value.velocityMps },
    speedKmh: value.speedKmh,
    pairCount: value.pairCount,
  };
  for (const sample of copy.samples) {
    Object.freeze(sample.imagePoint);
    Object.freeze(sample);
  }
  Object.freeze(copy.samples);
  Object.freeze(copy.velocityMps);
  return Object.freeze(copy);
}
function evidenceDimensions(frameWidth: number, frameHeight: number) {
  if (
    !Number.isFinite(frameWidth) ||
    !Number.isFinite(frameHeight) ||
    frameWidth <= 0 ||
    frameHeight <= 0
  )
    throw new Error("Evidence requires valid frame dimensions.");
  const scale = Math.min(1, 1920 / Math.max(frameWidth, frameHeight));
  return {
    width: Math.max(1, Math.round(frameWidth * scale)),
    height: Math.max(1, Math.round(frameHeight * scale)),
    scale,
  };
}
function evidenceVehicleBox(
  bbox: readonly [number, number, number, number],
  frameWidth: number,
  frameHeight: number,
): readonly [number, number, number, number] {
  const { width, height } = evidenceDimensions(frameWidth, frameHeight);
  if (
    bbox.length !== 4 ||
    !Array.from(bbox).every(Number.isFinite) ||
    bbox[2] <= 0 ||
    bbox[3] <= 0
  )
    throw new Error("Evidence requires valid vehicle bounds.");
  const left = Math.max(0, Math.min(frameWidth, bbox[0]));
  const top = Math.max(0, Math.min(frameHeight, bbox[1]));
  const right = Math.max(0, Math.min(frameWidth, bbox[0] + bbox[2]));
  const bottom = Math.max(0, Math.min(frameHeight, bbox[1] + bbox[3]));
  if (right <= left || bottom <= top)
    throw new Error("The captured vehicle must intersect the evidence frame.");
  return Object.freeze([
    (left / frameWidth) * width,
    (top / frameHeight) * height,
    ((right - left) / frameWidth) * width,
    ((bottom - top) / frameHeight) * height,
  ]);
}
export function createCaptureSnapshot(
  track: Track,
  sample: CaptureSample,
  clientEventId: string,
  evidence: string,
): CaptureSnapshot {
  if (track.speedKmh === null || !Number.isFinite(track.speedKmh))
    throw new Error("A capture requires a measured speed.");
  const vehicleBox =
    sample.frameWidth === undefined && sample.frameHeight === undefined
      ? null
      : evidenceVehicleBox(track.bbox, sample.frameWidth!, sample.frameHeight!);
  return Object.freeze({
    sourceName: sample.sourceName,
    sourceKind: sample.source,
    sourceTimestamp: sample.time,
    captureTime: sample.captureTime,
    confidence: track.score,
    calibration: freezeCalibration(sample.calibration),
    className: track.className,
    speedKmh: track.speedKmh,
    speedMeasurement:
      sample.source === "demo"
        ? null
        : freezeSpeedMeasurement(track.speedMeasurement),
    speedLimit: sample.limit,
    trackId: track.id,
    clientEventId,
    evidence,
    vehicleBox,
  });
}
function captureEvidence(
  frame: HTMLCanvasElement,
  track: Track,
  limit: number,
  capturedAt: string,
): string {
  const { width, height, scale } = evidenceDimensions(
    frame.width,
    frame.height,
  );
  const vehicleBox = evidenceVehicleBox(track.bbox, frame.width, frame.height);
  const footer = Math.max(32, Math.round(width / 50)),
    evidence = document.createElement("canvas");
  evidence.width = width;
  evidence.height = height + footer;
  const ctx = evidence.getContext("2d");
  if (!ctx) throw new Error("The browser could not create an evidence image.");
  ctx.drawImage(frame, 0, 0, width, height);
  ctx.strokeStyle = "#ff9c78";
  ctx.lineWidth = Math.max(2, scale * 2);
  ctx.strokeRect(...vehicleBox);
  ctx.fillStyle = "#101719";
  ctx.fillRect(0, height, width, footer);
  ctx.fillStyle = "#fff";
  ctx.font = `${Math.max(10, Math.min(17, width / 70))}px monospace`;
  ctx.textBaseline = "middle";
  ctx.fillText(
    `#${track.id} | EST. ${track.speedKmh!.toFixed(1)} km/h | LIMIT ${limit} | ${capturedAt}`,
    10,
    height + footer / 2,
    width - 20,
  );
  let quality = 0.86,
    encoded = evidence.toDataURL("image/jpeg", quality);
  while (encoded.length * 0.75 > 1950000 && quality > 0.14) {
    quality -= 0.08;
    encoded = evidence.toDataURL("image/jpeg", quality);
  }
  if (encoded.length * 0.75 > 1950000)
    throw new Error(
      "This evidence frame is too large to save. Choose a lower camera resolution.",
    );
  return encoded;
}
function speedStatus(
  track: Track,
  calibration: Calibration | null,
  simulated: boolean,
  width: number,
  height: number,
): string {
  if (track.className === "person") return "Not measured";
  if (!calibration && !simulated) return "Needs calibration";
  if (
    calibration &&
    !pointInPolygon(
      {
        x: (track.bbox[0] + track.bbox[2] / 2) / width,
        y: (track.bbox[1] + track.bbox[3]) / height,
      },
      calibration.points,
    )
  )
    return "Outside road scale";
  return "Measuring…";
}
function drawTracks(
  ctx: CanvasRenderingContext2D,
  tracks: Track[],
  limit: number,
  trails: boolean,
  unit: SpeedUnit,
  calibration: Calibration | null,
  simulated: boolean,
) {
  const w = ctx.canvas.width,
    h = ctx.canvas.height,
    scale = w / 1280;
  ctx.save();
  for (const track of tracks) {
    const [x, y, bw, bh] = track.bbox;
    const color = objectHudColor(track.className);
    const overLimit =
      MOTOR_VEHICLE_CLASSES.has(track.className) &&
      track.speedKmh !== null &&
      track.speedKmh > limit;
    if (trails && track.trail.length > 1) {
      ctx.beginPath();
      ctx.strokeStyle = color + "78";
      ctx.lineWidth = 1.5 * scale;
      track.trail.forEach((p, i) =>
        i ? ctx.lineTo(p.x * w, p.y * h) : ctx.moveTo(p.x * w, p.y * h),
      );
      ctx.stroke();
    }
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.5 * scale;
    ctx.fillStyle = color + "09";
    ctx.fillRect(x, y, bw, bh);
    ctx.strokeRect(x, y, bw, bh);
    const l = Math.min(10 * scale, bw / 3);
    ctx.strokeStyle = overLimit ? HUD_WARNING_COLOR : color;
    ctx.lineWidth = 3 * scale;
    [
      [x, y, 1, 1],
      [x + bw, y, -1, 1],
      [x, y + bh, 1, -1],
      [x + bw, y + bh, -1, -1],
    ].forEach(([a, b, sx, sy]) => {
      ctx.beginPath();
      ctx.moveTo(a + sx * l, b);
      ctx.lineTo(a, b);
      ctx.lineTo(a, b + sy * l);
      ctx.stroke();
    });
    ctx.font = `600 ${15 * scale}px "Consolas", monospace`;
    const label = `${track.className.toUpperCase()} ${String(track.id).padStart(3, "0")}  ${track.speedKmh === null ? speedStatus(track, calibration, simulated, w, h).toUpperCase() : formatSpeed(track.speedKmh, unit)}${overLimit ? " · OVER LIMIT" : ""}`;
    const textWidth = Math.min(w, ctx.measureText(label).width + 13 * scale),
      tx = Math.max(0, Math.min(x, w - textWidth));
    const ty = Math.max(
      0,
      Math.min(
        h - 25 * scale,
        y > 28 * scale ? y - 26 * scale : y + bh + 3 * scale,
      ),
    );
    ctx.fillStyle = "#101918eb";
    ctx.fillRect(tx, ty, textWidth, 25 * scale);
    if (overLimit) {
      ctx.fillStyle = HUD_WARNING_COLOR;
      ctx.fillRect(tx, ty, 3 * scale, 25 * scale);
    }
    ctx.fillStyle = color;
    ctx.fillText(
      label,
      tx + 6 * scale,
      ty + 18 * scale,
      Math.max(1, textWidth - 12 * scale),
    );
  }
  ctx.restore();
}
export function useTraffic() {
  const canvasRef = useRef<HTMLCanvasElement>(null),
    videoRef = useRef<HTMLVideoElement>(null);
  const [source, setSource] = useState<SourceKind>("demo"),
    [sourceName, setSourceName] = useState("Northbound · Parkway");
  const [playing, setPlayingState] = useState(true),
    [limit, setLimit] = useState(60),
    [overlay, setOverlay] = useState(true),
    [trails, setTrails] = useState(true);
  const [speedUnit, setSpeedUnit] = useState<SpeedUnit>(() => {
    try {
      return localStorage.getItem("velocity.speedUnit") === "mph"
        ? "mph"
        : "kmh";
    } catch {
      return "kmh";
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem("velocity.speedUnit", speedUnit);
    } catch {}
  }, [speedUnit]);
  const [calibration, setCalibrationState] = useState<Calibration | null>(null),
    [stats, setStats] = useState<TrafficStats>(emptyStats),
    [records, setRecords] = useState<Observation[]>([]);
  const [countingLine, setCountingLineState] = useState<CountingLine | null>(
    null,
  );
  const counter = useRef(new CrossingCounter());
  const countingLineRef = useRef<CountingLine | null>(null);
  const crossingTotals = useRef<CrossingCounts>({
    total: 0,
    forward: 0,
    reverse: 0,
    classes: { car: 0, truck: 0, bus: 0, motorcycle: 0, bicycle: 0 },
  });
  const [status, setStatus] = useState("Demo ready"),
    [error, setError] = useState(""),
    [ready, setReady] = useState(true),
    [generation, setGeneration] = useState(0),
    [duration, setDuration] = useState(0);
  const resources = useRef<SourceResources>({}),
    recordsRef = useRef(new Map<number, Observation>()),
    totalsRef = useRef(emptyTotals());
  const currentTracks = useRef<Track[]>([]),
    simulationTime = useRef(8),
    elapsedRef = useRef(0),
    tracker = useRef(new VehicleTracker(null));
  const sourceEpoch = useRef(0),
    sessionVersion = useRef(0),
    lastInference = useRef(-1),
    sessionId = useRef(crypto.randomUUID());
  const latestInspectionFrame = useRef(new LatestAnalyzedVehicleFrame());
  const calibrationFrames = useRef(new CalibrationFrameBinding());
  const countingFrames = useRef(new CalibrationFrameBinding());
  const calibrationReference = useRef<CameraReference | null>(null);
  const countingReference = useRef<CameraReference | null>(null);
  const demoCalibrationToken = useRef<string | null>(null);
  const demoCountingToken = useRef<string | null>(null);
  const [cameraStability, setCameraStability] =
    useState<CameraStabilityStatus>(uncalibratedCamera);
  const cameraStabilityRef = useRef(cameraStability);
  const [countingStability, setCountingStability] =
    useState<CameraStabilityStatus>(uncalibratedCamera);
  const countingStabilityRef = useRef(countingStability);
  const updateCountingStability = useCallback((next: CameraStabilityStatus) => {
    countingStabilityRef.current = next;
    setCountingStability(next);
  }, []);
  const updateCameraStability = useCallback((next: CameraStabilityStatus) => {
    cameraStabilityRef.current = next;
    setCameraStability(next);
  }, []);
  const [inspectableEventIds, setInspectableEventIds] = useState<
    readonly string[]
  >([]);
  const [inspectionResetVersion, setInspectionResetVersion] = useState(0);
  const clearInspection = useCallback(() => {
    latestInspectionFrame.current.clear();
    calibrationFrames.current.invalidateLatest();
    countingFrames.current.invalidateLatest();
    setInspectableEventIds((previous) => (previous.length ? [] : previous));
    setInspectionResetVersion((previous) => previous + 1);
  }, []);
  const cameraClock = useRef({ raw: 0, elapsed: 0 });
  const sourceDimensions = useRef<{
    width: number;
    height: number;
  } | null>(null);
  const coverage = useRef(new AnalysisCoverage());
  const [analysis, setAnalysis] = useState<AnalysisHealth>(emptyAnalysis);
  const analysisRef = useRef(analysis);
  const analysisGap = useRef<{
    wall: number;
    media: number;
  } | null>(null);
  const lastAnalyzedWall = useRef<number | null>(null);
  const lastQueuedMedia = useRef<number | null>(null);
  const waitingSince = useRef(performance.now());
  const stateRef = useRef({
    playing,
    limit,
    speedUnit,
    overlay,
    trails,
    calibration,
    source,
    sourceName,
    ready,
  });
  stateRef.current = {
    playing,
    limit,
    speedUnit,
    overlay,
    trails,
    calibration,
    source,
    sourceName,
    ready,
  };
  const setPlaying = useCallback(
    (value: boolean) => {
      if (!value) clearInspection();
      stateRef.current.playing = value;
      setPlayingState(value);
    },
    [clearInspection],
  );
  const updateAnalysis = useCallback((next: AnalysisHealth) => {
    analysisRef.current = next;
    setAnalysis(next);
  }, []);
  const interruptAnalysis = useCallback(
    (
      message: string,
      state: AnalysisHealth["state"] = "gap",
      now = performance.now(),
    ) => {
      if (stateRef.current.source === "demo") return;
      clearInspection();
      const newGap = !analysisGap.current;
      const gapMediaStart =
        lastInference.current >= 0 ? lastInference.current : elapsedRef.current;
      sessionVersion.current++;
      currentTracks.current = [];
      tracker.current.breakContinuity();
      counter.current.breakContinuity();
      resetDetectorContext();
      lastInference.current = -1;
      lastAnalyzedWall.current = null;
      waitingSince.current = now;
      if (newGap) analysisGap.current = { wall: now, media: gapMediaStart };
      coverage.current.gap(analysisGap.current!.media, elapsedRef.current);
      updateAnalysis({
        ...analysisRef.current,
        state,
        message,
        gapCount: analysisRef.current.gapCount + (newGap ? 1 : 0),
        currentGapSeconds: Math.max(
          0,
          (performance.now() - analysisGap.current!.wall) / 1000,
        ),
      });
      setStats((previous) => ({
        ...previous,
        active: 0,
        fps: 0,
        history: coverage.current.snapshot,
      }));
    },
    [updateAnalysis, clearInspection],
  );
  const clearRecords = useCallback(() => {
    clearInspection();
    sessionVersion.current++;
    recordsRef.current.clear();
    totalsRef.current = emptyTotals();
    currentTracks.current = [];
    tracker.current.reset();
    resetDetectorContext();
    counter.current.reset();
    crossingTotals.current = {
      total: 0,
      forward: 0,
      reverse: 0,
      classes: { car: 0, truck: 0, bus: 0, motorcycle: 0, bicycle: 0 },
    };
    lastInference.current = -1;
    sessionId.current = crypto.randomUUID();
    elapsedRef.current = 0;
    cameraClock.current = {
      raw: videoRef.current?.currentTime ?? 0,
      elapsed: 0,
    };
    coverage.current.reset();
    analysisGap.current = null;
    lastAnalyzedWall.current = null;
    waitingSince.current = performance.now();
    lastQueuedMedia.current = null;
    updateAnalysis(emptyAnalysis());
    setRecords([]);
    setStats(emptyStats());
  }, [updateAnalysis, clearInspection]);
  const freezeCalibrationFrame = useCallback(
    (kind: "calibration" | "counting" = "calibration") => {
      try {
        const context = {
          epoch: sourceEpoch.current,
          revision: sessionVersion.current,
          at: performance.now(),
        };
        if (stateRef.current.source === "demo") {
          const sourceCanvas = canvasRef.current;
          if (!sourceCanvas)
            throw new Error(
              "Wait for the demo frame before opening calibration.",
            );
          const canvas = document.createElement("canvas");
          canvas.width = sourceCanvas.width;
          canvas.height = sourceCanvas.height;
          const ctx = canvas.getContext("2d");
          if (!ctx) throw new Error("The browser could not freeze this frame.");
          ctx.drawImage(sourceCanvas, 0, 0);
          const token = `${context.epoch}:${context.revision}:${crypto.randomUUID()}`;
          if (kind === "calibration") demoCalibrationToken.current = token;
          else demoCountingToken.current = token;
          setError("");
          return { canvas, token };
        }
        const prepared = (
          kind === "calibration" ? calibrationFrames : countingFrames
        ).current.prepare(context);
        setError("");
        return prepared;
      } catch (error) {
        setError(
          error instanceof Error
            ? error.message
            : "The calibration frame could not be read.",
        );
        return null;
      }
    },
    [],
  );
  const setCalibration = useCallback(
    (value: Calibration | null, token?: string): boolean => {
      if (value) {
        const message = validateCalibration(value);
        if (message) {
          setError(message);
          return false;
        }
      }
      let reference: CameraReference | null = null;
      try {
        if (value && stateRef.current.source !== "demo") {
          const video = videoRef.current;
          reference = calibrationFrames.current.resolve(token ?? "", {
            epoch: sourceEpoch.current,
            revision: sessionVersion.current,
            at: performance.now(),
            width: video?.videoWidth ?? 0,
            height: video?.videoHeight ?? 0,
          });
        } else if (
          value &&
          (!token ||
            token !== demoCalibrationToken.current ||
            !token.startsWith(
              `${sourceEpoch.current}:${sessionVersion.current}:`,
            ))
        ) {
          throw new Error(
            "This calibration frame is no longer current. Reopen the editor.",
          );
        }
      } catch (error) {
        setError(
          error instanceof Error
            ? error.message
            : "The calibration reference is no longer available.",
        );
        return false;
      }
      const copy = copyCalibration(value);
      clearRecords();
      calibrationReference.current = reference;
      demoCalibrationToken.current = null;
      tracker.current.setCalibration(null);
      updateCameraStability(
        value
          ? {
              state: "unverifiable",
              reason:
                "Waiting to check a fresh frame against the calibration reference.",
              matched: 0,
              displacementPixels: null,
            }
          : uncalibratedCamera(),
      );
      stateRef.current.calibration = copy;
      setCalibrationState(copy);
      setError("");
      return true;
    },
    [clearRecords, updateCameraStability],
  );
  const setCountingLine = useCallback(
    (line: CountingLine | null, token?: string): boolean => {
      const copy = line ? { a: { ...line.a }, b: { ...line.b } } : null;
      let reference: CameraReference | null = null;
      try {
        new CrossingCounter(copy);
        if (copy && stateRef.current.source !== "demo") {
          reference = countingFrames.current.resolve(token ?? "", {
            epoch: sourceEpoch.current,
            revision: sessionVersion.current,
            at: performance.now(),
            width: videoRef.current?.videoWidth ?? 0,
            height: videoRef.current?.videoHeight ?? 0,
          });
        } else if (
          copy &&
          (!token ||
            token !== demoCountingToken.current ||
            !token.startsWith(
              `${sourceEpoch.current}:${sessionVersion.current}:`,
            ))
        ) {
          throw new Error(
            "This counting frame is no longer current. Reopen the editor.",
          );
        }
      } catch (error) {
        setError(
          error instanceof Error
            ? error.message
            : "The counting reference is unavailable.",
        );
        return false;
      }
      countingReference.current = reference;
      demoCountingToken.current = null;
      updateCountingStability(
        copy
          ? {
              state: "unverifiable",
              reason:
                "Waiting to check a fresh frame against the counting-line reference.",
              matched: 0,
              displacementPixels: null,
            }
          : uncalibratedCamera(),
      );
      counter.current.setLine(copy);
      counter.current.reset();
      crossingTotals.current = {
        total: 0,
        forward: 0,
        reverse: 0,
        classes: { car: 0, truck: 0, bus: 0, motorcycle: 0, bicycle: 0 },
      };
      countingLineRef.current = copy;
      setCountingLineState(copy);
      if (copy && analysisRef.current.notice)
        updateAnalysis({ ...analysisRef.current, notice: "" });
      setStats((previous) => ({
        ...previous,
        crossings: {
          total: 0,
          forward: 0,
          reverse: 0,
          classes: { car: 0, truck: 0, bus: 0, motorcycle: 0, bicycle: 0 },
        },
      }));
      setError("");
      return true;
    },
    [updateAnalysis, updateCountingStability],
  );
  const cleanupSource = useCallback(() => {
    clearInspection();
    calibrationFrames.current.clear();
    countingFrames.current.clear();
    calibrationReference.current = null;
    countingReference.current = null;
    demoCalibrationToken.current = null;
    demoCountingToken.current = null;
    updateCameraStability(uncalibratedCamera());
    updateCountingStability(uncalibratedCamera());
    const previous = resources.current;
    resources.current = {};
    previous.disposeListeners?.();
    previous.cancelWait?.();
    previous.hls?.destroy();
    previous.stream?.getTracks().forEach((t) => t.stop());
    if (previous.url) URL.revokeObjectURL(previous.url);
    if (previous.cameraId) releaseNetworkCamera(previous.cameraId);
    const video = videoRef.current;
    if (video) {
      video.pause();
      video.srcObject = null;
      video.removeAttribute("src");
      video.removeAttribute("crossorigin");
      video.load();
    }
  }, [clearInspection, updateCameraStability, updateCountingStability]);
  useEffect(
    () => () => {
      sourceEpoch.current++;
      sessionVersion.current++;
      cleanupSource();
    },
    [cleanupSource],
  );
  useEffect(() => {
    const leaving = () => {
      if (resources.current.cameraId) {
        interruptAnalysis(
          "The camera connection was released when this page closed. Reconnect the source.",
          "reconnect",
        );
        sourceEpoch.current++;
        stateRef.current.ready = false;
        setReady(false);
        setPlaying(false);
        setStatus("Camera reconnection required");
        cleanupSource();
      } else if (stateRef.current.ready && stateRef.current.playing) {
        interruptAnalysis(
          "Analysis paused while this page is inactive.",
          "hidden",
        );
      }
    };
    const visible = () => {
      const state = stateRef.current;
      if (!state.ready || !state.playing || state.source === "demo") return;
      interruptAnalysis(
        document.hidden
          ? "Analysis is paused while this page is hidden. Keep this page visible to analyze traffic."
          : "Analysis is resuming. Waiting for a fresh frame; traffic during the gap was not analyzed.",
        document.hidden ? "hidden" : "gap",
      );
    };
    const restored = (event: PageTransitionEvent) => {
      if (event.persisted && analysisRef.current.state !== "reconnect")
        visible();
    };
    window.addEventListener("pagehide", leaving);
    window.addEventListener("pageshow", restored);
    document.addEventListener("visibilitychange", visible);
    return () => {
      window.removeEventListener("pagehide", leaving);
      window.removeEventListener("pageshow", restored);
      document.removeEventListener("visibilitychange", visible);
    };
  }, [cleanupSource, interruptAnalysis, setPlaying]);
  useEffect(() => {
    if (!ready || source === "demo") return;
    if (!playing)
      interruptAnalysis(
        "Monitoring is paused. New frames are not being analyzed.",
        "paused",
      );
    else {
      waitingSince.current = performance.now();
      if (document.hidden)
        interruptAnalysis(
          "Analysis is paused while this page is hidden. Keep this page visible to analyze traffic.",
          "hidden",
        );
      else if (analysisGap.current)
        updateAnalysis({
          ...analysisRef.current,
          state: "gap",
          message: "Analysis is resuming. Waiting for a fresh frame.",
        });
    }
  }, [playing, ready, source, interruptAnalysis, updateAnalysis]);
  useEffect(() => {
    const video = videoRef.current;
    if (!video || source === "demo") return;
    const seeking = () =>
      interruptAnalysis(
        "The video is seeking. Waiting for a freshly analyzed frame.",
      );
    video.addEventListener("seeking", seeking);
    return () => video.removeEventListener("seeking", seeking);
  }, [source, generation, interruptAnalysis]);
  useEffect(() => {
    const timer = window.setInterval(() => {
      const state = stateRef.current,
        now = performance.now();
      if (state.source === "demo") return;
      if (analysisGap.current) {
        updateAnalysis({
          ...analysisRef.current,
          currentGapSeconds: Math.max(
            0,
            (now - analysisGap.current.wall) / 1000,
          ),
        });
      } else if (
        state.ready &&
        state.playing &&
        !document.hidden &&
        hasAnalysisGap(
          (now - (lastAnalyzedWall.current ?? waitingSince.current)) / 1000,
        )
      ) {
        interruptAnalysis(
          "Analysis has stopped producing fresh frames. Waiting to recover; this interval is unobserved.",
          "gap",
          lastAnalyzedWall.current ?? waitingSince.current,
        );
      }
    }, 1000);
    return () => window.clearInterval(timer);
  }, [interruptAnalysis, updateAnalysis]);
  const prepareSource = useCallback(
    async (kind: SourceKind, file?: File, deviceId?: string) => {
      const epoch = ++sourceEpoch.current;
      cleanupSource();
      sourceDimensions.current = null;
      setCountingLine(null);
      clearRecords();
      setError("");
      setPlaying(false);
      setReady(false);
      tracker.current.setCalibration(null);
      setCalibrationState(null);
      setDuration(0);
      const name =
        kind === "demo"
          ? "Northbound · Parkway"
          : kind === "camera"
            ? "Connected camera"
            : file?.name || "Local video";
      stateRef.current = {
        ...stateRef.current,
        source: kind,
        sourceName: name,
        ready: false,
        calibration: null,
        playing: false,
      };
      setSource(kind);
      setSourceName(name);
      setGeneration((g) => g + 1);
      simulationTime.current = 8;
      if (kind === "demo") {
        setReady(true);
        setPlaying(true);
        setStatus("Demo ready");
        return;
      }
      try {
        if (kind === "camera" && !navigator.mediaDevices?.getUserMedia)
          throw new Error(
            "Camera access is unavailable. Open this app on localhost or HTTPS in a browser that supports cameras, or choose a local video.",
          );
        setStatus("Loading object detection model…");
        await loadDetector((message) => {
          if (epoch === sourceEpoch.current) setStatus(message);
        });
        if (epoch !== sourceEpoch.current) return;
        const video = videoRef.current;
        if (!video)
          throw new Error("Video surface is not available. Please try again.");
        if (kind === "video" && file) {
          const url = URL.createObjectURL(file);
          resources.current.url = url;
          video.src = url;
        } else if (kind === "camera") {
          const stream = await navigator.mediaDevices.getUserMedia({
            video: {
              width: { ideal: 1920 },
              height: { ideal: 1080 },
              ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
            },
            audio: false,
          });
          if (epoch !== sourceEpoch.current) {
            stream.getTracks().forEach((t) => t.stop());
            return;
          }
          resources.current.stream = stream;
          video.srcObject = stream;
        } else throw new Error("Choose a video file first.");
        await new Promise<void>((resolve, reject) => {
          const timeout = window.setTimeout(() => {
            clean();
            reject(
              new Error(
                "The video could not be opened. Try an MP4 (H.264) or WebM file.",
              ),
            );
          }, 20000);
          const clean = () => {
            clearTimeout(timeout);
            video.removeEventListener("loadeddata", loaded);
            video.removeEventListener("error", failed);
          };
          const loaded = () => {
              clean();
              resolve();
            },
            failed = () => {
              clean();
              reject(
                new Error(
                  "Unsupported or damaged video. Try MP4 (H.264) or WebM.",
                ),
              );
            };
          video.addEventListener("loadeddata", loaded);
          video.addEventListener("error", failed);
          if (video.readyState >= 2) loaded();
        });
        if (epoch !== sourceEpoch.current) return;
        setDuration(Number.isFinite(video.duration) ? video.duration : 0);
        cameraClock.current = { raw: video.currentTime, elapsed: 0 };
        await video.play();
        if (epoch !== sourceEpoch.current) return;
        setReady(true);
        setPlaying(true);
        setStatus("Detector running");
      } catch (e) {
        if (epoch !== sourceEpoch.current) return;
        cleanupSource();
        const message =
          e instanceof DOMException && e.name === "NotAllowedError"
            ? "Camera permission was denied. Allow camera access in your browser, then connect again."
            : e instanceof DOMException && e.name === "NotFoundError"
              ? "No camera was found. Connect a USB camera or choose a local video."
              : e instanceof Error
                ? e.message
                : "Unable to open source.";
        setError(message);
        setStatus("Source unavailable");
        setReady(false);
      }
    },
    [cleanupSource, clearRecords, setPlaying, setCountingLine],
  );
  const prepareNetworkCamera = useCallback(
    async (config: NetworkCameraConfig): Promise<void> => {
      const epoch = ++sourceEpoch.current;
      cleanupSource();
      sourceDimensions.current = null;
      setCountingLine(null);
      clearRecords();
      setError("");
      setPlaying(false);
      setReady(false);
      tracker.current.setCalibration(null);
      setCalibrationState(null);
      setDuration(0);
      const fallbackNames = {
        url: "Network camera",
        rtsp: "RTSP camera",
        onvif: "ONVIF camera",
        nest: "Nest public camera",
      };
      const name = config.name?.trim() || fallbackNames[config.type];
      stateRef.current = {
        ...stateRef.current,
        source: "camera",
        sourceName: name,
        ready: false,
        calibration: null,
        playing: false,
      };
      setSource("camera");
      setSourceName(name);
      setGeneration((g) => g + 1);
      setStatus("Connecting network camera…");
      let cancelled = false;
      let failed = false;
      const controller = new AbortController();
      const timeout = window.setTimeout(() => controller.abort(), 45000);
      const stopWithError = (message: string) => {
        if (failed || cancelled || epoch !== sourceEpoch.current) return;
        failed = true;
        sessionVersion.current++;
        currentTracks.current = [];
        lastInference.current = -1;
        stateRef.current.ready = false;
        setPlaying(false);
        setReady(false);
        setStats((previous) => ({ ...previous, active: 0, fps: 0 }));
        setError(message);
        setStatus("Network camera unavailable");
        updateAnalysis({ ...analysisRef.current, state: "reconnect", message });
        cleanupSource();
      };
      const connect = (async (): Promise<CameraConnection> => {
        try {
          const response = await fetch("/api/cameras/connect", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(config),
            signal: controller.signal,
          });
          const payload = await response.json().catch(() => null);
          if (!response.ok) {
            throw new Error(
              typeof payload?.error === "string"
                ? payload.error
                : "The local camera service could not connect. Check the address, credentials, and camera availability.",
            );
          }
          const camera = payload?.camera as CameraConnection | undefined;
          if (!camera || typeof camera.id !== "string" || !camera.id) {
            throw new Error(
              "The camera service returned an invalid connection. Reconnect the source.",
            );
          }
          if (cancelled || epoch !== sourceEpoch.current) {
            releaseNetworkCamera(camera.id);
            throw new DOMException(
              "Camera connection superseded",
              "AbortError",
            );
          }
          resources.current.cameraId = camera.id;
          if (typeof camera.playbackUrl !== "string" || !camera.playbackUrl) {
            throw new Error(
              "The camera connected without a playable stream address. Reconnect the source.",
            );
          }
          const playback = new URL(camera.playbackUrl, window.location.href);
          if (
            !["http:", "https:"].includes(playback.protocol) ||
            playback.username ||
            playback.password
          ) {
            throw new Error(
              "The camera service returned an unsupported playback address.",
            );
          }
          return { ...camera, playbackUrl: playback.href };
        } finally {
          clearTimeout(timeout);
        }
      })();
      try {
        const [camera, , hlsModule] = await Promise.all([
          connect,
          loadDetector((message) => {
            if (!cancelled && !failed && epoch === sourceEpoch.current) {
              setStatus(`Connecting camera · ${message}`);
            }
          }),
          import("hls.js"),
        ]);
        if (cancelled || epoch !== sourceEpoch.current) return;
        const video = videoRef.current;
        if (!video)
          throw new Error(
            "Video surface is unavailable. Reconnect the camera.",
          );
        const displayName = config.name?.trim() || camera.name || name;
        stateRef.current.sourceName = displayName;
        setSourceName(displayName);
        setStatus("Camera connected · waiting for live video…");
        video.crossOrigin = "anonymous";
        video.muted = true;
        video.playsInline = true;
        const mediaError = () =>
          stopWithError(
            "The browser could not decode this camera stream. Use H.264 video or reconnect through the RTSP/ONVIF gateway.",
          );
        const ended = () =>
          stopWithError(
            "The network camera stream ended. Check that the camera is online, then reconnect the source.",
          );
        video.addEventListener("error", mediaError);
        video.addEventListener("ended", ended);
        let lastMediaTime = video.currentTime;
        let lastProgress = performance.now();
        const watchdog = window.setInterval(() => {
          if (epoch !== sourceEpoch.current || failed) return;
          if (!stateRef.current.playing || !stateRef.current.ready) {
            lastProgress = performance.now();
            lastMediaTime = video.currentTime;
            return;
          }
          if (Math.abs(video.currentTime - lastMediaTime) > 0.01) {
            lastProgress = performance.now();
            lastMediaTime = video.currentTime;
          } else if (performance.now() - lastProgress > 30000) {
            stopWithError(
              "No camera frames arrived for 30 seconds. Check the connection and reconnect the source.",
            );
          }
        }, 5000);
        resources.current.disposeListeners = () => {
          clearInterval(watchdog);
          video.removeEventListener("error", mediaError);
          video.removeEventListener("ended", ended);
        };
        const Hls = hlsModule.default;
        if (Hls.isSupported()) {
          const hls = new Hls({
            enableWorker: true,
            lowLatencyMode: true,
            backBufferLength: 15,
            maxBufferLength: 15,
            maxMaxBufferLength: 30,
            liveSyncDurationCount: 3,
            liveMaxLatencyDurationCount: 8,
            maxLiveSyncPlaybackRate: 1,
          });
          resources.current.hls = hls;
          hls.on(Hls.Events.ERROR, (_event, data) => {
            if (!data.fatal || cancelled || epoch !== sourceEpoch.current)
              return;
            stopWithError(
              data.type === Hls.ErrorTypes.NETWORK_ERROR
                ? "Network camera playback stopped. Check that the camera and local gateway are reachable, then reconnect the source."
                : "The camera stream could not be played reliably. Use H.264 video or reconnect the source.",
            );
          });
          hls.attachMedia(video);
          hls.loadSource(camera.playbackUrl);
        } else if (video.canPlayType("application/vnd.apple.mpegurl")) {
          video.src = camera.playbackUrl;
        } else {
          throw new Error(
            "This browser does not support HLS camera playback. Open the app in a current version of Chrome, Edge, Firefox, or Safari.",
          );
        }
        await new Promise<void>((resolve, reject) => {
          const frameTimeout = window.setTimeout(
            () =>
              finish(
                new Error(
                  "The camera connected but no playable frames arrived. Check the live stream and camera codec, then reconnect.",
                ),
              ),
            30000,
          );
          const clean = () => {
            clearTimeout(frameTimeout);
            video.removeEventListener("loadeddata", loaded);
            if (resources.current.cancelWait === cancel)
              delete resources.current.cancelWait;
          };
          const finish = (error?: Error) => {
            clean();
            if (error) reject(error);
            else resolve();
          };
          const loaded = () => finish();
          const cancel = () =>
            finish(new DOMException("Camera playback cancelled", "AbortError"));
          resources.current.cancelWait = cancel;
          video.addEventListener("loadeddata", loaded);
          if (failed || epoch !== sourceEpoch.current) cancel();
          else if (video.readyState >= 2) loaded();
        });
        if (failed || cancelled || epoch !== sourceEpoch.current) return;
        cameraClock.current = { raw: video.currentTime, elapsed: 0 };
        await video.play();
        if (failed || cancelled || epoch !== sourceEpoch.current) return;
        stateRef.current.ready = true;
        setReady(true);
        setPlaying(true);
        setStatus("Network camera live · local processing timestamps");
      } catch (error) {
        if (epoch !== sourceEpoch.current) {
          cancelled = true;
          return;
        }
        if (!failed) {
          stopWithError(
            controller.signal.aborted
              ? "The camera connection timed out after 45 seconds. Check its address, credentials, and network connection, then retry."
              : error instanceof Error
                ? error.message
                : "Unable to connect to the network camera.",
          );
        }
        cancelled = true;
      } finally {
        if (failed) cancelled = true;
      }
    },
    [cleanupSource, clearRecords, setPlaying, setCountingLine, updateAnalysis],
  );
  const togglePlayback = useCallback(async () => {
    if (!stateRef.current.ready) return;
    const wasPlaying = stateRef.current.playing,
      video = videoRef.current;
    if (stateRef.current.source !== "demo" && video) {
      if (wasPlaying) video.pause();
      else {
        if (video.ended) {
          video.currentTime = 0;
          clearRecords();
        }
        const epoch = sourceEpoch.current;
        try {
          await video.play();
        } catch {
          setError("Playback was blocked. Select the source again.");
          return;
        }
        if (epoch !== sourceEpoch.current) return;
      }
    }
    setPlaying(!wasPlaying);
  }, [clearRecords, setPlaying]);
  useEffect(() => {
    let raf = 0,
      previousFrame = performance.now(),
      lastUi = 0,
      lastDetect = 0,
      lastCompletion = 0,
      busy = false,
      disposed = false,
      fps = 0,
      observedVersion = sessionVersion.current;
    const epoch = sourceEpoch.current;
    const observe = (
      tracks: Track[],
      frame: HTMLCanvasElement,
      sample: CaptureSample,
    ) => {
      if (
        sample.source === "demo" ||
        !countingLineRef.current ||
        countingStabilityRef.current.state === "stable"
      ) {
        crossingTotals.current = counter.current.update(
          tracks,
          frame.width,
          frame.height,
          sample.time,
        );
      } else counter.current.breakContinuity();
      coverage.current.record(sample.time, tracks.length);
      const totals = totalsRef.current,
        activeIds = new Set(tracks.map((t) => t.id));
      let capturedNew = false;
      for (const track of tracks) {
        let record = recordsRef.current.get(track.id);
        if (!record) {
          record = {
            id: track.id,
            eventId: `${sessionId.current}:${track.id}`,
            className: track.className,
            speed: null,
            time: sample.time,
            lastSeen: sample.time,
            confidence: track.score,
            overLimit: false,
          };
          recordsRef.current.set(track.id, record);
          if (track.className !== "person") {
            totals.total++;
            totals.classes[track.className] =
              (totals.classes[track.className] || 0) + 1;
          }
        } else if (record.className !== track.className) {
          if (record.className !== "person")
            totals.classes[record.className] = Math.max(
              0,
              (totals.classes[record.className] || 0) - 1,
            );
          if (track.className !== "person")
            totals.classes[track.className] =
              (totals.classes[track.className] || 0) + 1;
          record.className = track.className;
        }
        record.lastSeen = sample.time;
        record.confidence = track.score;
        record.speedStatus = speedStatus(
          track,
          sample.calibration,
          sample.source === "demo",
          frame.width,
          frame.height,
        );
        if (
          track.speedKmh !== null &&
          Number.isFinite(track.speedKmh) &&
          (record.speed === null || track.speedKmh > record.speed)
        ) {
          if (track.className !== "person") {
            if (record.speed === null) totals.measured++;
            totals.speedSum += track.speedKmh - (record.speed ?? 0);
            totals.peak = Math.max(totals.peak, track.speedKmh);
          }
          record.speed = track.speedKmh;
        }
        if (
          MOTOR_VEHICLE_CLASSES.has(track.className) &&
          (sample.source === "demo" || sample.calibration) &&
          track.speedKmh !== null &&
          track.speedKmh > sample.limit &&
          !record.overLimit
        ) {
          try {
            const evidence = captureEvidence(
              frame,
              track,
              sample.limit,
              sample.captureTime,
            );
            const capture = createCaptureSnapshot(
              track,
              { ...sample, frameWidth: frame.width, frameHeight: frame.height },
              record.eventId,
              evidence,
            );
            record.capture = capture;
            record.evidence = evidence;
            record.overLimit = true;
            record.capturedAt = capture.captureTime;
            record.speedLimit = capture.speedLimit;
            record.violationSpeed = capture.speedKmh;
            totals.violations++;
            capturedNew = true;
          } catch (captureError) {
            setError(
              captureError instanceof Error
                ? captureError.message
                : "Evidence capture failed.",
            );
            setPlaying(false);
            videoRef.current?.pause();
          }
        }
      }
      if (recordsRef.current.size > 1500)
        for (const [id, record] of recordsRef.current) {
          if (recordsRef.current.size <= 1500) break;
          if (!activeIds.has(id) && sample.time - record.lastSeen > 1.5)
            recordsRef.current.delete(id);
        }
      const evidenceRecords = [...recordsRef.current.values()].filter(
        (r) => r.evidence,
      );
      for (const record of evidenceRecords.slice(
        0,
        Math.max(0, evidenceRecords.length - 80),
      )) {
        delete record.evidence;
        delete record.capture;
      }
      if (capturedNew)
        setRecords(
          [...recordsRef.current.values()].reverse().map((r) => ({ ...r })),
        );
    };
    const tick = (now: number) => {
      if (disposed) return;
      const s = stateRef.current,
        canvas = canvasRef.current,
        video = videoRef.current;
      const wallDelta = Math.max(0, (now - previousFrame) / 1000);
      const dt = Math.min(wallDelta, 0.1);
      previousFrame = now;
      if (
        s.source !== "demo" &&
        s.ready &&
        s.playing &&
        !document.hidden &&
        hasAnalysisGap(wallDelta) &&
        !analysisGap.current
      ) {
        interruptAnalysis(
          "Analysis was interrupted while the page was inactive. Waiting for fresh frames.",
          "gap",
          now - wallDelta * 1000,
        );
      }
      const ctx = canvas?.getContext("2d");
      if (!ctx || !canvas) {
        raf = requestAnimationFrame(tick);
        return;
      }
      if (observedVersion !== sessionVersion.current) {
        observedVersion = sessionVersion.current;
        fps = 0;
        lastCompletion = 0;
      }
      if (s.source === "demo") {
        if (canvas.width !== 1600) {
          canvas.width = 1600;
          canvas.height = 900;
        }
        if (s.playing && s.ready) {
          simulationTime.current += dt;
          elapsedRef.current += dt;
        }
        currentTracks.current = drawDemo(
          ctx,
          simulationTime.current,
          canvas.width,
          canvas.height,
        ).map((v) => ({ ...v, age: 2 }));
        if (s.playing && s.ready)
          observe(currentTracks.current, canvas, {
            time: elapsedRef.current,
            captureTime: new Date().toISOString(),
            limit: s.limit,
            calibration: s.calibration,
            source: s.source,
            sourceName: s.sourceName,
          });
      } else if (video && video.readyState >= 2) {
        const previousSize = sourceDimensions.current;
        if (
          previousSize &&
          (previousSize.width !== video.videoWidth ||
            previousSize.height !== video.videoHeight)
        ) {
          const wasCalibrated = !!s.calibration;
          const hadCountingLine = !!countingLineRef.current;
          interruptAnalysis(
            "The video dimensions changed. Check the counting line and recalibrate before speed measurement.",
          );
          counter.current.setLine(null, true);
          countingLineRef.current = null;
          setCountingLineState(null);
          if (hadCountingLine)
            updateAnalysis({
              ...analysisRef.current,
              notice:
                "The video dimensions changed and the count line was removed. Redraw the count line to resume directional counts.",
            });
          tracker.current.setCalibration(null);
          calibrationReference.current = null;
          calibrationFrames.current.clear();
          countingFrames.current.clear();
          countingReference.current = null;
          updateCameraStability(uncalibratedCamera());
          updateCountingStability(uncalibratedCamera());
          s.calibration = null;
          setCalibrationState(null);
          if (wasCalibrated)
            setError(
              "The camera frame dimensions changed. Recalibrate the road before recording more speed measurements.",
            );
        }
        sourceDimensions.current = {
          width: video.videoWidth,
          height: video.videoHeight,
        };
        if (
          canvas.width !== video.videoWidth ||
          canvas.height !== video.videoHeight
        ) {
          canvas.width = video.videoWidth;
          canvas.height = video.videoHeight;
        }
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
        if (
          s.playing &&
          s.ready &&
          !video.seeking &&
          !document.hidden &&
          analysisRef.current.state !== "reconnect"
        ) {
          if (s.source === "camera") {
            const raw = video.currentTime;
            const rawDelta = raw - cameraClock.current.raw;
            if (
              isMediaDiscontinuity(rawDelta, wallDelta) &&
              !analysisGap.current
            ) {
              interruptAnalysis(
                "The camera timeline changed. Fresh trajectories are required; the skipped interval is unobserved.",
              );
              setStatus(
                "Camera timeline changed · fresh trajectories started; totals retained",
              );
            }
            cameraClock.current.elapsed += Math.max(0, rawDelta);
            cameraClock.current.raw = raw;
            elapsedRef.current = cameraClock.current.elapsed;
          } else elapsedRef.current = video.currentTime;
          if (
            !busy &&
            now - lastDetect > 45 &&
            elapsedRef.current - lastInference.current > 0.04 &&
            (lastQueuedMedia.current === null ||
              Math.abs(video.currentTime - lastQueuedMedia.current) > 0.04)
          ) {
            busy = true;
            lastDetect = now;
            lastQueuedMedia.current = video.currentTime;
            const version = sessionVersion.current,
              frame = document.createElement("canvas");
            frame.width = video.videoWidth;
            frame.height = video.videoHeight;
            const fc = frame.getContext("2d");
            if (!fc) {
              busy = false;
              setError("The browser could not read the video frame.");
              setPlaying(false);
              video.pause();
            } else {
              fc.drawImage(video, 0, 0);
              const sample = {
                time: elapsedRef.current,
                captureTime: new Date().toISOString(),
                limit: s.limit,
                calibration: copyCalibration(s.calibration),
                source: s.source,
                sourceName: s.sourceName,
              };
              detectFrame(frame)
                .then((detections) => {
                  if (
                    disposed ||
                    epoch !== sourceEpoch.current ||
                    version !== sessionVersion.current ||
                    !stateRef.current.playing ||
                    video.seeking ||
                    video.videoWidth !== frame.width ||
                    video.videoHeight !== frame.height ||
                    document.hidden ||
                    analysisRef.current.state === "reconnect"
                  )
                    return;
                  const completed = performance.now();
                  if (hasAnalysisGap((completed - now) / 1000)) {
                    if (!analysisGap.current)
                      interruptAnalysis(
                        "Analysis returned an old frame. Waiting for fresh frames; this interval is unobserved.",
                        "gap",
                        lastAnalyzedWall.current ?? now,
                      );
                    return;
                  }
                  const gap = analysisGap.current;
                  if (gap) coverage.current.gap(gap.media, sample.time);
                  calibrationFrames.current.retain(frame, detections, {
                    epoch,
                    revision: version,
                    at: now,
                  });
                  countingFrames.current.retain(frame, detections, {
                    epoch,
                    revision: version,
                    at: now,
                  });
                  if (countingLineRef.current) {
                    const previous = countingStabilityRef.current;
                    let stability: CameraStabilityStatus = previous;
                    if (previous.state !== "moved") {
                      try {
                        stability = countingReference.current
                          ? assessCameraStability(
                              countingReference.current,
                              {
                                data: fc.getImageData(
                                  0,
                                  0,
                                  frame.width,
                                  frame.height,
                                ).data,
                                width: frame.width,
                                height: frame.height,
                                channels: 4,
                              },
                              detections,
                            )
                          : {
                              state: "unverifiable",
                              reason:
                                "The counting reference is missing. Redraw the counting line.",
                              matched: 0,
                              displacementPixels: null,
                            };
                      } catch {
                        stability = {
                          state: "unverifiable",
                          reason:
                            "The camera image could not be checked. Directional counts are suspended.",
                          matched: 0,
                          displacementPixels: null,
                        };
                      }
                      if (stability.state === "moved")
                        stability = {
                          ...stability,
                          reason:
                            "Camera movement detected. Redraw the counting line to resume directional counts.",
                        };
                    }
                    if (
                      previous.state !== "stable" ||
                      stability.state !== "stable"
                    )
                      counter.current.breakContinuity();
                    updateCountingStability(stability);
                  }
                  if (sample.calibration) {
                    const previous = cameraStabilityRef.current;
                    let stability: CameraStabilityStatus = previous;
                    if (previous.state !== "moved") {
                      try {
                        stability = calibrationReference.current
                          ? assessCameraStability(
                              calibrationReference.current,
                              {
                                data: fc.getImageData(
                                  0,
                                  0,
                                  frame.width,
                                  frame.height,
                                ).data,
                                width: frame.width,
                                height: frame.height,
                                channels: 4,
                              },
                              detections,
                            )
                          : {
                              state: "unverifiable",
                              reason:
                                "The calibration reference is missing. Recalibrate this view.",
                              matched: 0,
                              displacementPixels: null,
                            };
                      } catch {
                        stability = {
                          state: "unverifiable",
                          reason:
                            "The camera image could not be checked. Speed estimates are suspended.",
                          matched: 0,
                          displacementPixels: null,
                        };
                      }
                    }
                    if (stability.state !== "stable")
                      tracker.current.setCalibration(null);
                    else if (previous.state !== "stable")
                      tracker.current.setCalibration(sample.calibration);
                    updateCameraStability(stability);
                  }
                  const tracks = tracker.current.update(
                    detections,
                    sample.time,
                    frame.width,
                    frame.height,
                  );
                  currentTracks.current = tracks;
                  latestInspectionFrame.current.retain(
                    frame,
                    tracks,
                    sample,
                    sessionId.current,
                  );
                  const ids = latestInspectionFrame.current.eventIds;
                  setInspectableEventIds((previous) =>
                    previous.length === ids.length &&
                    previous.every((id, i) => id === ids[i])
                      ? previous
                      : ids,
                  );
                  lastInference.current = sample.time;
                  lastAnalyzedWall.current = now;
                  const gapSeconds = gap
                    ? Math.max(0, (completed - gap.wall) / 1000)
                    : 0;
                  analysisGap.current = null;
                  updateAnalysis({
                    ...analysisRef.current,
                    state: "live",
                    message:
                      "Fresh frames are being analyzed. Keep this page visible; background analysis is not continuous.",
                    currentGapSeconds: 0,
                    lastGapSeconds: gap
                      ? gapSeconds
                      : analysisRef.current.lastGapSeconds,
                    totalGapSeconds:
                      analysisRef.current.totalGapSeconds + gapSeconds,
                  });
                  observe(tracks, frame, sample);
                  if (lastCompletion) {
                    const rate = 1000 / Math.max(1, completed - lastCompletion);
                    fps = fps ? fps * 0.65 + rate * 0.35 : rate;
                  }
                  lastCompletion = completed;
                })
                .catch((e) => {
                  if (
                    !disposed &&
                    epoch === sourceEpoch.current &&
                    version === sessionVersion.current
                  ) {
                    setError(
                      `Detection stopped: ${e instanceof Error ? e.message : "try reopening the source"}`,
                    );
                    setPlaying(false);
                    video.pause();
                  }
                })
                .finally(() => {
                  busy = false;
                });
            }
          }
        }
      } else {
        ctx.fillStyle = "#10171a";
        ctx.fillRect(0, 0, canvas.width, canvas.height);
      }
      if (s.ready) {
        const freshTracks =
          s.source === "demo" ||
          (s.playing &&
            !document.hidden &&
            analysisRef.current.state === "live" &&
            elapsedRef.current - lastInference.current < 0.9)
            ? currentTracks.current
            : [];
        if (s.overlay)
          drawTracks(
            ctx,
            freshTracks,
            s.limit,
            s.trails,
            s.speedUnit,
            s.calibration,
            s.source === "demo",
          );
        const line = countingLineRef.current;
        if (line && s.overlay) {
          ctx.save();
          ctx.strokeStyle = "#d1f79b";
          ctx.lineWidth = 3;
          ctx.setLineDash([12, 7]);
          ctx.beginPath();
          ctx.moveTo(line.a.x * canvas.width, line.a.y * canvas.height);
          ctx.lineTo(line.b.x * canvas.width, line.b.y * canvas.height);
          ctx.stroke();
          ctx.setLineDash([]);
          ctx.font = "bold 16px monospace";
          for (const [label, point] of [
            ["A", line.a],
            ["B", line.b],
          ] as const) {
            const x = point.x * canvas.width,
              y = point.y * canvas.height;
            ctx.fillStyle = "#d1f79b";
            ctx.beginPath();
            ctx.arc(x, y, 12, 0, Math.PI * 2);
            ctx.fill();
            ctx.fillStyle = "#101719";
            ctx.textAlign = "center";
            ctx.textBaseline = "middle";
            ctx.fillText(label, x, y);
          }
          ctx.restore();
        }
        if (s.calibration && s.overlay) {
          ctx.save();
          ctx.setLineDash([8, 6]);
          ctx.strokeStyle = "#91b7cf66";
          ctx.lineWidth = 1.5;
          ctx.beginPath();
          s.calibration.points.forEach((p, i) =>
            i
              ? ctx.lineTo(p.x * canvas.width, p.y * canvas.height)
              : ctx.moveTo(p.x * canvas.width, p.y * canvas.height),
          );
          ctx.closePath();
          ctx.stroke();
          ctx.restore();
        }
        if (now - lastUi > 300) {
          lastUi = now;
          const time = elapsedRef.current;
          if (analysisGap.current)
            coverage.current.gap(analysisGap.current.media, time);
          const totals = totalsRef.current;
          setStats({
            total: totals.total,
            average: totals.measured ? totals.speedSum / totals.measured : 0,
            peak: totals.peak,
            active: freshTracks.length,
            violations: totals.violations,
            fps:
              s.playing &&
              (s.source === "demo" || analysisRef.current.state === "live")
                ? fps
                : 0,
            elapsed: time,
            classes: { ...totals.classes },
            history: coverage.current.snapshot,
            crossings: crossingTotals.current,
          });
          setRecords(
            [...recordsRef.current.values()].reverse().map((r) => ({ ...r })),
          );
        }
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => {
      disposed = true;
      cancelAnimationFrame(raf);
    };
  }, [
    generation,
    setPlaying,
    clearRecords,
    setCountingLine,
    interruptAnalysis,
    updateAnalysis,
  ]);
  const seek = useCallback(
    (seconds: number) => {
      const video = videoRef.current;
      if (source === "video" && video && Number.isFinite(seconds)) {
        clearRecords();
        video.currentTime = Math.max(
          0,
          Math.min(
            Number.isFinite(video.duration) ? video.duration : seconds,
            seconds,
          ),
        );
        elapsedRef.current = video.currentTime;
        setStats((previous) => ({ ...previous, elapsed: video.currentTime }));
      }
    },
    [source, clearRecords],
  );
  const inspectVehicle = useCallback(
    (trackId: number, expectedEventId?: string): VehicleInspection | null => {
      const state = stateRef.current;
      const video = videoRef.current,
        dimensions = sourceDimensions.current;
      if (
        state.source === "demo" ||
        !state.ready ||
        !state.playing ||
        document.hidden ||
        analysisRef.current.state !== "live" ||
        videoRef.current?.seeking ||
        !video ||
        !dimensions ||
        video.videoWidth !== dimensions.width ||
        video.videoHeight !== dimensions.height ||
        lastAnalyzedWall.current === null ||
        hasAnalysisGap((performance.now() - lastAnalyzedWall.current) / 1000)
      )
        return null;
      return latestInspectionFrame.current.inspect(trackId, expectedEventId);
    },
    [],
  );
  return {
    canvasRef,
    detectorInfo: getDetectorInfo(),
    videoRef,
    source,
    sourceName,
    playing,
    ready,
    limit,
    setLimit,
    speedUnit,
    setSpeedUnit,
    overlay,
    setOverlay,
    trails,
    setTrails,
    calibration,
    countingLine,
    setCountingLine,
    setCalibration,
    freezeCalibrationFrame,
    freezeCountingFrame: () => freezeCalibrationFrame("counting"),
    cameraStability,
    countingStability,
    stats,
    analysis,
    records,
    status,
    error,
    setError,
    prepareSource,
    prepareNetworkCamera,
    togglePlayback,
    clearRecords,
    seek,
    duration,
    setPlaying,
    inspectVehicle,
    inspectableEventIds,
    inspectionResetVersion,
  };
}
