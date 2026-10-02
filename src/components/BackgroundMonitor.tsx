import { useCallback, useEffect, useRef, useState } from "react";
import {
  Activity,
  ArrowDownUp,
  ArrowUpRight,
  Camera,
  CarFront,
  Clock3,
  Crosshair,
  FileCheck2,
  Gauge,
  MoveHorizontal,
  Radio,
  Server,
  ShieldCheck,
  Square,
  TriangleAlert,
} from "lucide-react";
import type { Calibration } from "../vision/types";
import type { CountingLine } from "../vision/counting";
import { formatSpeed, type SpeedUnit } from "../units";
import { HUD_WARNING_COLOR, OBJECT_HUD, objectHudColor } from "../hud";
import BackgroundCameraConnector from "./BackgroundCameraConnector";
import {
  applyCameraRequest,
  monitorIsActive,
  type MonitorCameraRequest,
} from "./backgroundCameraRequest";
import CalibrationModal from "./CalibrationModal";
import CountingLineEditor from "./CountingLineEditor";
import Modal from "./Modal";
import SpeedLimitInput from "./SpeedLimitInput";
import MonitorHistory from "./MonitorHistory";
import VehicleInspector from "./VehicleInspector";
import AutomaticPlates from "./AutomaticPlates";
import {
  createVehicleInspection,
  type VehicleInspection,
} from "../vision/vehicleInspection";
import {
  decodeMonitorImage,
  MonitorApiError,
  MonitorFrameSequence,
  monitorRequest,
  type BackgroundCameraConfig,
  type DecodedMonitorFrame,
  type MonitorFrame,
  type MonitorStatus,
} from "./backgroundMonitorClient";
import "./background-monitor.css";
type Preview = DecodedMonitorFrame<HTMLImageElement>;
type GeometryEditor = {
  kind: "calibration" | "counting";
  canvas: HTMLCanvasElement;
  frame: MonitorFrame;
  revision: number;
};
const isActive = monitorIsActive;
const elapsed = (seconds: number) => {
  const value = Math.max(0, Math.floor(seconds));
  return `${String(Math.floor(value / 3600)).padStart(2, "0")}:${String(Math.floor(value / 60) % 60).padStart(2, "0")}:${String(value % 60).padStart(2, "0")}`;
};
const messageOf = (error: unknown) =>
  error instanceof Error
    ? error.message
    : "The local monitoring service could not be reached.";
const wasAborted = (error: unknown) =>
  error instanceof Error && error.name === "AbortError";
function paintPreview(
  canvas: HTMLCanvasElement,
  preview: Preview,
  unit: SpeedUnit,
  showPlateReadings: boolean,
) {
  const { bundle: frame, image } = preview;
  canvas.width = frame.width;
  canvas.height = frame.height;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  ctx.drawImage(image, 0, 0, frame.width, frame.height);
  const scale = Math.max(1, frame.width / 1000);
  ctx.lineWidth = 1.7 * scale;
  ctx.font = `500 ${11 * scale}px "IBM Plex Mono", monospace`;
  if (frame.calibration) {
    ctx.beginPath();
    frame.calibration.points.forEach((point, index) => {
      if (index === 0)
        ctx.moveTo(point.x * frame.width, point.y * frame.height);
      else ctx.lineTo(point.x * frame.width, point.y * frame.height);
    });
    ctx.closePath();
    ctx.fillStyle = "#d4f2960b";
    ctx.fill();
    ctx.strokeStyle = "#d4f29680";
    ctx.setLineDash([6 * scale, 5 * scale]);
    ctx.stroke();
    ctx.setLineDash([]);
  }
  for (const track of frame.tracks) {
    const color = objectHudColor(track.className);
    const [x, y, width, height] = track.bbox;
    ctx.strokeStyle = color;
    ctx.globalAlpha = 0.55;
    ctx.beginPath();
    track.trail.forEach((point, index) => {
      if (index === 0)
        ctx.moveTo(point.x * frame.width, point.y * frame.height);
      else ctx.lineTo(point.x * frame.width, point.y * frame.height);
    });
    ctx.stroke();
    ctx.globalAlpha = 1;
    ctx.strokeRect(x, y, width, height);
    const speed =
      frame.calibration &&
      track.className !== "person" &&
      track.speedKmh !== null
        ? track.speedKmh
        : null;
    const overLimit = speed !== null && speed > frame.speedLimitKmh;
    const label = `${track.className.toUpperCase()} #${track.id}${speed !== null ? ` · ${formatSpeed(speed, unit)}` : ""}`;
    const labelWidth = ctx.measureText(label).width + 12 * scale;
    const labelX = Math.min(
      Math.max(0, x),
      Math.max(0, frame.width - labelWidth),
    );
    const labelY = Math.max(0, y - 21 * scale);
    ctx.fillStyle = "#0d171ee8";
    ctx.fillRect(labelX, labelY, labelWidth, 20 * scale);
    ctx.fillStyle = overLimit ? HUD_WARNING_COLOR : color;
    ctx.fillText(label, labelX + 6 * scale, labelY + 14 * scale);
    const plate =
      showPlateReadings &&
      frame.plateReadings?.find(
        (reading) =>
          reading.trackId === track.id &&
          reading.state === "candidate" &&
          reading.samples >= 2 &&
          reading.plate &&
          Number.isFinite(reading.sourceTimestamp) &&
          reading.sourceTimestamp <= frame.sourceTimestamp,
      );
    if (plate) {
      const plateLabel = `${plate.plate} ? · ${(frame.sourceTimestamp - plate.sourceTimestamp).toFixed(1)}s ago`;
      const plateWidth = ctx.measureText(plateLabel).width + 12 * scale;
      const plateX = Math.min(
        Math.max(0, x),
        Math.max(0, frame.width - plateWidth),
      );
      const plateY = Math.min(
        frame.height - 20 * scale,
        y + height + 2 * scale,
      );
      ctx.fillStyle = "#0d171ee8";
      ctx.fillRect(plateX, plateY, plateWidth, 20 * scale);
      ctx.fillStyle = "#e9c795";
      ctx.fillText(plateLabel, plateX + 6 * scale, plateY + 14 * scale);
    }
  }
  if (frame.countingLine) {
    const { a, b } = frame.countingLine;
    ctx.strokeStyle = "#d4f296";
    ctx.lineWidth = 2.5 * scale;
    ctx.setLineDash([8 * scale, 5 * scale]);
    ctx.beginPath();
    ctx.moveTo(a.x * frame.width, a.y * frame.height);
    ctx.lineTo(b.x * frame.width, b.y * frame.height);
    ctx.stroke();
    ctx.setLineDash([]);
    for (const [point, letter] of [
      [a, "A"],
      [b, "B"],
    ] as const) {
      ctx.fillStyle = "#d4f296";
      ctx.beginPath();
      ctx.arc(
        point.x * frame.width,
        point.y * frame.height,
        10 * scale,
        0,
        Math.PI * 2,
      );
      ctx.fill();
      ctx.fillStyle = "#14211a";
      ctx.textAlign = "center";
      ctx.fillText(
        letter,
        point.x * frame.width,
        point.y * frame.height + 4 * scale,
      );
      ctx.textAlign = "left";
    }
  }
}
export default function BackgroundMonitor({
  speedUnit,
  onCases,
  requestedCamera = null,
  onRequestedCameraConsumed,
  onStatus,
}: {
  speedUnit: SpeedUnit;
  onCases: () => void;
  requestedCamera?: MonitorCameraRequest | null;
  onRequestedCameraConsumed?: (request: MonitorCameraRequest) => void;
  onStatus?: (status: MonitorStatus | null) => void;
}) {
  const [status, setStatus] = useState<MonitorStatus | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [loading, setLoading] = useState(true);
  const [connectionError, setConnectionError] = useState("");
  const [previewError, setPreviewError] = useState("");
  const [actionError, setActionError] = useState("");
  const [pending, setPending] = useState<
    "start" | "stop" | "config" | "retry" | "recover" | null
  >(null);
  const [initialLimit, setInitialLimit] = useState(60);
  const [initialLimitValid, setInitialLimitValid] = useState(true);
  const [initialPlateReadingEnabled, setInitialPlateReadingEnabled] =
    useState(true);
  const [editor, setEditor] = useState<GeometryEditor | null>(null);
  const [editorError, setEditorError] = useState("");
  const [inspectionChoices, setInspectionChoices] = useState<
    VehicleInspection[] | null
  >(null);
  const [inspection, setInspection] = useState<VehicleInspection | null>(null);
  const [now, setNow] = useState(Date.now());
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const statusRef = useRef<MonitorStatus | null>(null);
  const sequence = useRef(new MonitorFrameSequence<HTMLImageElement>());
  const alive = useRef(false);
  const requests = useRef(new Set<AbortController>());
  const mutationVersion = useRef(0);
  const commandPending = useRef(false);
  const inactivePreviewKey = useRef<string | null>(null);
  const handledCameraRequest = useRef<MonitorCameraRequest | null>(null);
  const applyStatus = useCallback((next: MonitorStatus) => {
    if (sequence.current.setSession(next.sessionId)) {
      setPreview(null);
      setPreviewError("");
      setEditor(null);
      setEditorError("");
      setInspectionChoices(null);
      setInspection(null);
      inactivePreviewKey.current = null;
    }
    statusRef.current = next;
    setStatus(next);
  }, []);
  useEffect(() => {
    alive.current = true;
    let disposed = false;
    let statusTimer: ReturnType<typeof setTimeout>;
    let frameTimer: ReturnType<typeof setTimeout>;
    const clockTimer = setInterval(() => setNow(Date.now()), 1000);
    async function pollStatus() {
      const controller = new AbortController();
      requests.current.add(controller);
      const version = mutationVersion.current;
      try {
        const result = await monitorRequest<{
          monitor: MonitorStatus;
        }>("", controller.signal);
        if (!disposed && version === mutationVersion.current) {
          applyStatus(result.monitor);
          setConnectionError("");
        }
      } catch (error) {
        if (
          !disposed &&
          version === mutationVersion.current &&
          !wasAborted(error)
        )
          setConnectionError(
            "The local monitoring service is unavailable. Last received values are shown; current monitoring status is unknown.",
          );
      } finally {
        requests.current.delete(controller);
        if (!disposed) {
          setLoading(false);
          setNow(Date.now());
          statusTimer = setTimeout(() => void pollStatus(), 1000);
        }
      }
    }
    async function pollFrame() {
      const current = statusRef.current;
      const finalPreviewKey =
        current?.sessionId && current.lastFrameAt
          ? `${current.sessionId}:${current.lastFrameAt}`
          : null;
      if (
        current?.sessionId &&
        (isActive(current) ||
          (finalPreviewKey && finalPreviewKey !== inactivePreviewKey.current))
      ) {
        const controller = new AbortController();
        requests.current.add(controller);
        try {
          const result = await monitorRequest<{
            frame: MonitorFrame | null;
          }>(
            `/frame?after=${Math.max(0, sequence.current.after)}&sessionId=${encodeURIComponent(current.sessionId)}`,
            controller.signal,
          );
          if (result.frame && !disposed) {
            const decoded = await sequence.current.decode(
              result.frame,
              (frame) => decodeMonitorImage(frame, controller.signal),
            );
            if (decoded && !disposed) {
              setPreview(decoded);
              setPreviewError("");
            }
          }
          if (
            !isActive(current) &&
            !disposed &&
            statusRef.current?.sessionId === current.sessionId
          )
            inactivePreviewKey.current = finalPreviewKey;
        } catch (error) {
          if (
            !disposed &&
            statusRef.current?.sessionId === current.sessionId &&
            !wasAborted(error)
          )
            setPreviewError(messageOf(error));
        } finally {
          requests.current.delete(controller);
        }
      }
      if (!disposed) frameTimer = setTimeout(() => void pollFrame(), 250);
    }
    void pollStatus();
    void pollFrame();
    return () => {
      disposed = true;
      alive.current = false;
      sequence.current.dispose();
      clearTimeout(statusTimer);
      clearTimeout(frameTimer);
      clearInterval(clockTimer);
      for (const controller of requests.current) controller.abort();
      requests.current.clear();
    };
  }, [applyStatus]);
  useEffect(() => {
    if (canvasRef.current && preview)
      paintPreview(
        canvasRef.current,
        preview,
        speedUnit,
        !!status?.automaticPlates?.enabled &&
          preview.bundle.sessionId === status.sessionId &&
          preview.bundle.configRevision === status.config.revision,
      );
  }, [
    preview,
    speedUnit,
    status?.automaticPlates?.enabled,
    status?.sessionId,
    status?.config.revision,
  ]);
  async function command(
    kind: "start" | "stop" | "config" | "retry" | "recover",
    path: string,
    body: unknown,
  ) {
    if (commandPending.current) return false;
    commandPending.current = true;
    mutationVersion.current++;
    setPending(kind);
    setActionError("");
    setEditorError("");
    const controller = new AbortController();
    requests.current.add(controller);
    try {
      const result = await monitorRequest<{
        monitor: MonitorStatus;
      }>(path, controller.signal, kind === "config" ? "PATCH" : "POST", body);
      if (!alive.current) return false;
      mutationVersion.current++;
      applyStatus(result.monitor);
      setConnectionError("");
      return true;
    } catch (error) {
      if (!alive.current || wasAborted(error)) return false;
      const conflict = error instanceof MonitorApiError && error.status === 409;
      const message = conflict
        ? "The monitoring session or configuration changed. Close this editor and reopen it on the latest analyzed frame before saving."
        : messageOf(error);
      if (kind === "config" && editor) setEditorError(message);
      else setActionError(message);
      return false;
    } finally {
      mutationVersion.current++;
      commandPending.current = false;
      requests.current.delete(controller);
      if (alive.current) setPending(null);
    }
  }
  const start = (camera: BackgroundCameraConfig) => {
    return command("start", "/start", {
      camera,
      speedLimitKmh: initialLimit,
      calibration: null,
      countingLine: null,
      plateReadingEnabled: initialPlateReadingEnabled,
    });
  };
  useEffect(() => {
    onStatus?.(connectionError || loading ? null : status);
  }, [status, connectionError, loading, onStatus]);
  useEffect(() => {
    if (
      !requestedCamera ||
      handledCameraRequest.current === requestedCamera ||
      loading ||
      connectionError ||
      pending ||
      !status
    )
      return;
    handledCameraRequest.current = requestedCamera;
    void applyCameraRequest(requestedCamera, {
      current: () => statusRef.current,
      stop: (sessionId) => command("stop", "/stop", { sessionId }),
      start,
      isMounted: () => alive.current,
    })
      .catch((error: unknown) => {
        if (alive.current) setActionError(messageOf(error));
      })
      .finally(() => {
        if (alive.current) onRequestedCameraConsumed?.(requestedCamera);
      });
  }, [requestedCamera, loading, connectionError, pending, status]);
  const changeLimit = (speedLimitKmh: number) => {
    const current = statusRef.current;
    if (!current?.sessionId) return;
    void command("config", "/config", {
      sessionId: current.sessionId,
      expectedRevision: current.config.revision,
      speedLimitKmh,
    });
  };
  const changePlateReading = (plateReadingEnabled: boolean) => {
    const current = statusRef.current;
    if (!isActive(current)) {
      setInitialPlateReadingEnabled(plateReadingEnabled);
      return;
    }
    if (!current?.sessionId) return;
    void command("config", "/config", {
      sessionId: current.sessionId,
      expectedRevision: current.config.revision,
      plateReadingEnabled,
    });
  };
  const openEditor = (kind: GeometryEditor["kind"]) => {
    const current = statusRef.current;
    if (
      !preview ||
      !current ||
      preview.bundle.sessionId !== current.sessionId ||
      preview.bundle.configRevision !== current.config.revision
    )
      return;
    const canvas = document.createElement("canvas");
    canvas.width = preview.bundle.width;
    canvas.height = preview.bundle.height;
    canvas.getContext("2d")?.drawImage(preview.image, 0, 0);
    setEditorError("");
    setInspectionChoices(null);
    setInspection(null);
    setEditor({
      kind,
      canvas,
      frame: preview.bundle,
      revision: current.config.revision,
    });
  };
  const freezeVehicles = () => {
    const current = statusRef.current;
    if (!preview || !current || preview.bundle.sessionId !== current.sessionId)
      return;
    const frozen = preview.bundle;
    try {
      const choices = frozen.tracks
        .filter((track) => track.className !== "person")
        .map((track) =>
          createVehicleInspection({
            sourceName: current.sourceName || "Network camera",
            sourceKind: "camera",
            sourceId: frozen.sessionId,
            frameId: frozen.frameId,
            frameWidth: frozen.width,
            frameHeight: frozen.height,
            sourceTimestamp: frozen.sourceTimestamp,
            captureTime: frozen.captureTime,
            imageUrl: frozen.jpeg,
            track,
          }),
        );
      if (!choices.length) return;
      setActionError("");
      setEditor(null);
      setInspection(null);
      setInspectionChoices(choices);
    } catch (error) {
      setActionError(messageOf(error));
    }
  };
  const selectVehicle = (selected: VehicleInspection) => {
    if (selected.sourceId !== statusRef.current?.sessionId) return;
    setInspectionChoices(null);
    setInspection(selected);
  };
  const saveGeometry = async (
    patch:
      | {
          calibration: Calibration | null;
        }
      | {
          countingLine: CountingLine | null;
        },
  ) => {
    if (!editor) return;
    const saved = await command("config", "/config", {
      sessionId: editor.frame.sessionId,
      expectedRevision: editor.revision,
      referenceFrame: {
        frameId: editor.frame.frameId,
        width: editor.frame.width,
        height: editor.frame.height,
      },
      ...patch,
    });
    if (saved && alive.current) setEditor(null);
  };
  const active = isActive(status);
  const frame = preview?.bundle;
  const frameAge = frame
    ? Math.max(0, (now - Date.parse(frame.captureTime)) / 1000)
    : null;
  const stale =
    !!connectionError ||
    !!previewError ||
    (frameAge !== null && frameAge > 5) ||
    status?.state !== "running";
  const canConfigure =
    !!preview &&
    !!status?.sessionId &&
    active &&
    status.state !== "stopping" &&
    !pending &&
    !connectionError &&
    preview.bundle.sessionId === status.sessionId &&
    preview.bundle.configRevision === status.config.revision;
  const editorWaiting =
    !!preview &&
    !!status &&
    preview.bundle.configRevision !== status.config.revision;
  const stateLabel = connectionError
    ? "SERVICE UNAVAILABLE"
    : status?.state.toUpperCase() || "CONNECTING";
  const counts = status?.stats.crossings;
  const recovery = status?.evidenceRecovery;
  return (
    <section
      className="background-monitor"
      aria-label="Background camera monitoring"
    >
      <div className="background-service-note">
        <div className="background-service-icon">
          <Server size={19} />
        </div>
        <div>
          <strong>Background camera analysis</strong>
          <span>
            Analysis continues as you change views. Keep the application and
            computer running, or select Stop to end the session.
          </span>
        </div>
        <span className="background-service-tag">
          LOCAL SERVER · ONE CAMERA
        </span>
      </div>
      {connectionError && (
        <div className="error-banner" role="status">
          <TriangleAlert size={16} />
          <span>{connectionError}</span>
        </div>
      )}
      {actionError && (
        <div className="error-banner" role="alert">
          <TriangleAlert size={16} />
          <span>{actionError}</span>
        </div>
      )}
      {recovery &&
        (recovery.pending > 0 || recovery.error) &&
        !status?.stats.pendingCases && (
          <div className="error-banner" role="alert">
            <FileCheck2 size={16} />
            <span>
              {recovery.pending > 0
                ? `${recovery.pending} saved ${recovery.pending === 1 ? "capture still needs" : "captures still need"} recovery. `
                : "Saved-capture recovery needs attention. "}
              {recovery.error ||
                "Recover these captures before starting another camera."}
            </span>
            <button
              disabled={!!pending || !!connectionError || active}
              onClick={() => void command("recover", "/recovery/retry", {})}
            >
              {pending === "recover" ? "Recovering…" : "Retry recovery"}
              <ArrowUpRight size={14} />
            </button>
          </div>
        )}
      {recovery && recovery.recovered > 0 && (
        <div className="background-recovery-note" role="status">
          <FileCheck2 size={17} />
          <span>
            <strong>
              {recovery.recovered} saved{" "}
              {recovery.recovered === 1
                ? "capture recovered"
                : "captures recovered"}
            </strong>
            Checked against stored evidence during this service run. Historical
            session totals remain as originally saved.
          </span>
          <button className="button secondary" onClick={onCases}>
            View cases <ArrowUpRight size={14} />
          </button>
        </div>
      )}
      {!!(status?.stats.pendingCases || status?.stats.pendingHistory) && (
        <div className="error-banner" role="alert">
          <FileCheck2 size={16} />
          <span>
            {!!status?.stats.pendingCases && (
              <>
                {status.stats.pendingCases} evidence{" "}
                {status.stats.pendingCases === 1 ? "draft is" : "drafts are"}{" "}
                waiting to save. Analysis has stopped to preserve the original
                captures. Retry saving before starting another session.{" "}
              </>
            )}
            {status?.stats.pendingHistory &&
              "Session history has not been saved. Keep the service running and retry."}
          </span>
          <button
            disabled={!!pending || !!connectionError}
            onClick={() =>
              void command("retry", "/retry", { sessionId: status?.sessionId })
            }
          >
            {pending === "retry" ? "Retrying save…" : "Retry saving"}
            <ArrowUpRight size={14} />
          </button>
        </div>
      )}

      <div className="background-metrics">
        <div>
          <span>
            <CarFront size={15} /> Vehicles crossed
          </span>
          <strong>
            {status?.config.countingLine ? counts?.total.toLocaleString() : "—"}
          </strong>
          <small>
            {status?.config.countingLine
              ? "Across the configured line"
              : "Set a counting line to begin"}
          </small>
        </div>
        <div>
          <span>
            <ArrowDownUp size={15} /> Directional counts
          </span>
          <strong>
            {status?.config.countingLine ? (
              <>
                {counts?.forward.toLocaleString()}
                <i>/</i>
                {counts?.reverse.toLocaleString()}
              </>
            ) : (
              "—"
            )}
          </strong>
          <small>Forward / reverse · A → B</small>
        </div>
        <button className="background-case-metric" onClick={onCases}>
          <span>
            <FileCheck2 size={15} /> Cases created <ArrowUpRight size={14} />
          </span>
          <strong>
            {status ? status.stats.casesCreated.toLocaleString() : "—"}
          </strong>
          <small>Server evidence drafts · review cases</small>
        </button>
        <div>
          <span>
            <Clock3 size={15} /> Session elapsed
          </span>
          <strong className="background-elapsed">
            {status ? elapsed(status.stats.elapsedSeconds) : "—"}
          </strong>
          <small>
            {status
              ? `${status.stats.framesProcessed.toLocaleString()} analyzed frames`
              : "Waiting for local service"}
          </small>
        </div>
      </div>

      <div className="background-main-grid">
        <div className="background-preview-column">
          <section className="background-panel background-feed">
            <header>
              <div>
                <span className="eyebrow">SERVER ANALYSIS</span>
                <h2>{status?.sourceName || "Camera preview"}</h2>
              </div>
              <span
                className={`background-state ${status?.state === "running" && !stale ? "is-live" : ""}`}
              >
                <i />
                {stateLabel}
              </span>
            </header>
            <div
              className={`background-preview-stage ${frame && stale ? "is-stale" : ""}`}
              style={{
                aspectRatio: frame ? `${frame.width}/${frame.height}` : "16/9",
              }}
            >
              {preview ? (
                <>
                  <canvas
                    ref={canvasRef}
                    role="img"
                    aria-label="Latest server-analyzed camera frame with synchronized object detections"
                  />
                  <div className="background-frame-stamp">
                    <span>
                      {stale ? "LAST ANALYZED FRAME" : "ANALYZED FRAME"}
                    </span>
                    <span>
                      #{frame!.frameId} ·{" "}
                      {new Date(frame!.captureTime).toLocaleTimeString()}
                    </span>
                  </div>
                  {stale && (
                    <div className="background-stale-banner">
                      <Clock3 size={13} />
                      {status?.state === "stopped"
                        ? "Monitoring stopped · saved preview"
                        : connectionError
                          ? "Service connection lost · preview paused"
                          : status?.state === "reconnecting"
                            ? "Camera reconnecting · last frame retained"
                            : status?.state === "error"
                              ? "Analysis stopped · last frame retained"
                              : "Waiting for a fresh analyzed frame"}
                    </div>
                  )}
                </>
              ) : (
                <div className="background-preview-empty">
                  <div>
                    <Camera size={32} />
                  </div>
                  <span className="eyebrow">ANALYZED CAMERA PREVIEW</span>
                  <h3>
                    {active ? "Preparing the first frame" : "Connect a camera"}
                  </h3>
                  <p>
                    {active
                      ? status?.message ||
                        "Connecting and loading the local vision engine…"
                      : "Connect a camera to count traffic and capture calibrated speeding events on the local server."}
                  </p>
                  <span className="background-empty-grid" aria-hidden="true" />
                </div>
              )}
            </div>
            <div className="background-preview-meta">
              <span>
                <Activity size={13} />
                {status
                  ? `${status.stats.analysisFps.toFixed(1)} analysis fps`
                  : "No analyzed frames"}
              </span>
              <span>
                {frame
                  ? `${frame.width} × ${frame.height}`
                  : "Synchronized JPEG + detections"}
              </span>
              <span>
                {frameAge !== null
                  ? `${Math.floor(frameAge)}s since capture`
                  : "Camera not connected"}
              </span>
            </div>
            <div className="background-inspect-action">
              <div>
                <strong>Inspect a vehicle</strong>
                <span>
                  Freeze an analyzed frame to view details and attempt a plate
                  read.
                </span>
              </div>
              <button
                className="button secondary"
                disabled={
                  !frame ||
                  frame.sessionId !== status?.sessionId ||
                  !frame.tracks.some((track) => track.className !== "person")
                }
                onClick={freezeVehicles}
              >
                <Crosshair size={15} /> Inspect vehicles
              </button>
            </div>
            {(status?.message || status?.error || previewError) && (
              <div
                className={`background-analysis-message ${status?.error || previewError ? "has-error" : ""}`}
                role="status"
              >
                <Radio size={15} />
                <span>{previewError || status?.error || status?.message}</span>
              </div>
            )}
            <div className="background-legend">
              {OBJECT_HUD.map((item) => (
                <span key={item.className}>
                  <i style={{ background: item.color }} />
                  {item.label}
                </span>
              ))}
            </div>
          </section>
          <AutomaticPlates
            frame={
              active &&
              frame &&
              frame.sessionId === status?.sessionId &&
              frame.configRevision === status.config.revision
                ? frame
                : null
            }
            status={active ? status?.automaticPlates : undefined}
            enabled={
              active
                ? (status?.automaticPlates?.enabled ?? false)
                : initialPlateReadingEnabled
            }
            disabled={
              !!pending ||
              loading ||
              !!connectionError ||
              status?.state === "stopping"
            }
            stale={stale}
            onToggle={changePlateReading}
          />
          <section className="background-panel background-health">
            <header>
              <div>
                <span className="eyebrow">ANALYSIS HEALTH</span>
                <h2>Analysis health</h2>
              </div>
              <ShieldCheck size={20} />
            </header>
            <div className="background-health-grid">
              <div>
                <span>Observed vehicles</span>
                <strong>
                  {status?.stats.observed.toLocaleString() ?? "—"}
                </strong>
              </div>
              <div>
                <span>Active vehicles</span>
                <strong>{status?.stats.active.toLocaleString() ?? "—"}</strong>
              </div>
              <div>
                <span>Dropped frames</span>
                <strong>
                  {status?.stats.framesDropped.toLocaleString() ?? "—"}
                </strong>
              </div>
              <div>
                <span>Analysis gaps</span>
                <strong>
                  {status?.stats.gapCount.toLocaleString() ?? "—"}
                </strong>
              </div>
            </div>
            <p>
              Boxes, trails and estimates belong to the displayed analyzed
              image. Counts cover observed frames; gaps may miss crossings or
              split vehicle identities.
            </p>
            {!!status?.engine?.warnings?.length && (
              <p className="orange">{status.engine.warnings.join(" ")}</p>
            )}
            <footer>
              <span>
                {status?.engine
                  ? `${status.engine.name} · ${status.engine.provider}`
                  : "Vision engine starts with the camera"}
              </span>
              <span>
                {frame
                  ? `Frame configuration r${frame.configRevision}`
                  : "No preview metadata"}
              </span>
            </footer>
          </section>
        </div>

        <aside className="background-controls">
          <section className="background-panel background-camera-control">
            <header>
              <div>
                <span className="eyebrow">
                  {active ? "CONNECTED SOURCE" : "CAMERA CONNECTION"}
                </span>
                <h2>
                  {active
                    ? "Server-owned session"
                    : "Start background monitoring"}
                </h2>
              </div>
              <Server size={20} />
            </header>
            {active ? (
              <>
                <div className="background-source-details">
                  <strong>{status?.sourceName || "Connecting camera…"}</strong>
                  <span>
                    {status?.sourceType?.toUpperCase() || "NETWORK"} · local
                    processing
                  </span>
                </div>
                <p className="background-control-copy">
                  You can leave this view while the application stays open. The
                  camera remains active until you stop monitoring or the service
                  shuts down.
                </p>
                <button
                  className="button secondary full-width background-stop"
                  disabled={
                    !!pending ||
                    status?.state === "stopping" ||
                    !!connectionError
                  }
                  onClick={() =>
                    void command("stop", "/stop", {
                      sessionId: status?.sessionId,
                    })
                  }
                >
                  <Square size={14} />
                  {pending === "stop" || status?.state === "stopping"
                    ? "Stopping monitoring…"
                    : "Stop monitoring"}
                </button>
              </>
            ) : (
              <>
                <div className="background-start-limit">
                  <label htmlFor="background-start-limit">Speed limit</label>
                  <SpeedLimitInput
                    id="background-start-limit"
                    valueKmh={initialLimit}
                    unit={speedUnit}
                    onCommit={setInitialLimit}
                    onValidityChange={setInitialLimitValid}
                    disabled={!!pending}
                  />
                  <p>
                    Speed estimates begin only after you calibrate the road.
                  </p>
                </div>
                <BackgroundCameraConnector
                  onConnect={start}
                  busy={pending === "start"}
                  disabled={
                    !!pending ||
                    loading ||
                    !!connectionError ||
                    !!status?.stats.pendingCases ||
                    !!status?.stats.pendingHistory ||
                    !!status?.evidenceRecovery?.pending ||
                    !!status?.evidenceRecovery?.error ||
                    !initialLimitValid
                  }
                />
              </>
            )}
            <div className="background-network-note">
              <Camera size={15} />
              <span>
                Nest, web streams, RTSP, ONVIF and local USB cameras. Background
                USB capture requires Windows and a compatible camera driver.
              </span>
            </div>
          </section>

          <section className="background-panel background-policy">
            <header>
              <div>
                <span className="eyebrow">MEASUREMENT SETUP</span>
                <h2>Road calibration</h2>
              </div>
              <Gauge size={20} />
            </header>
            {active && status && (
              <div className="background-policy-limit">
                <label htmlFor="background-speed-limit">Speed limit</label>
                <SpeedLimitInput
                  key={`${status.sessionId}:${status.config.revision}:${pending || "ready"}`}
                  id="background-speed-limit"
                  valueKmh={status.config.speedLimitKmh}
                  unit={speedUnit}
                  onCommit={changeLimit}
                  disabled={
                    !!pending ||
                    !!connectionError ||
                    status.state === "stopping"
                  }
                />
              </div>
            )}
            <div className="background-setup-item">
              <div>
                <Crosshair size={17} />
                <span>
                  <strong>
                    {status?.config.calibration
                      ? status.cameraStability?.state === "stable"
                        ? "Camera reference matched"
                        : "Speed estimates suspended"
                      : "Needs road calibration"}
                  </strong>
                  <small>
                    {status?.config.calibration
                      ? status.cameraStability?.reason ||
                        "Waiting for camera reference verification."
                      : "The image alone cannot provide metres or speed."}
                  </small>
                </span>
              </div>
              <button
                className="button secondary full-width"
                disabled={!canConfigure}
                onClick={() => openEditor("calibration")}
              >
                {status?.config.calibration
                  ? "Edit road calibration"
                  : "Set road scale"}
                <ArrowUpRight size={14} />
              </button>
            </div>
            <div className="background-setup-item">
              <div>
                <MoveHorizontal size={17} />
                <span>
                  <strong>
                    {status?.config.countingLine
                      ? status.countingStability?.state === "stable"
                        ? "Directional line enabled"
                        : "Directional counts suspended"
                      : "Counting line not set"}
                  </strong>
                  <small>
                    {status?.config.countingLine
                      ? status.countingStability?.reason ||
                        "Waiting for counting-line reference verification."
                      : "Draw a line across the lane or roadway."}
                  </small>
                </span>
              </div>
              <button
                className="button secondary full-width"
                disabled={!canConfigure}
                onClick={() => openEditor("counting")}
              >
                {status?.config.countingLine
                  ? "Edit counting line"
                  : "Set counting line"}
                <ArrowUpRight size={14} />
              </button>
            </div>
            <p className="background-control-copy">
              {editorWaiting
                ? "Waiting for a frame with the updated configuration…"
                : !preview
                  ? "Connect a camera and wait for its first analyzed frame to place geometry."
                  : "Geometry uses a frozen analyzed frame. Saving a line resets crossing counts; calibration restarts speed trajectories and preserves counts."}
            </p>
            <div className="background-estimate-note">
              Estimates require measured distances, a fixed camera and enough
              track samples inside the road plane. Evidence drafts require human
              review.
            </div>
          </section>
        </aside>
      </div>

      <MonitorHistory speedUnit={speedUnit} />

      {inspectionChoices && inspectionChoices.length > 0 && (
        <Modal
          title="Choose a vehicle."
          subtitle={`Frozen frame #${inspectionChoices[0].frameId} · ${new Date(inspectionChoices[0].captureTime).toLocaleTimeString()} · ${status?.state === "running" ? "live analysis continues" : "retained analyzed image"}`}
          wide
          onClose={() => setInspectionChoices(null)}
        >
          <div className="background-vehicle-picker">
            <img
              src={inspectionChoices[0].imageUrl}
              alt="Frozen analyzed road frame; choose one of its detected vehicles"
            />
            {inspectionChoices.map((choice) => {
              const [x, y, width, height] = choice.track.bbox;
              return (
                <button
                  key={choice.track.id}
                  className="background-vehicle-target"
                  style={{
                    left: `${(x / choice.frameWidth) * 100}%`,
                    top: `${(y / choice.frameHeight) * 100}%`,
                    width: `${(width / choice.frameWidth) * 100}%`,
                    height: `${(height / choice.frameHeight) * 100}%`,
                    borderColor: objectHudColor(choice.track.className),
                  }}
                  aria-label={`Inspect ${choice.track.className} ${choice.track.id}`}
                  onClick={() => selectVehicle(choice)}
                >
                  <span>#{choice.track.id}</span>
                </button>
              );
            })}
          </div>
          <div
            className="background-vehicle-options"
            aria-label="Vehicles in the frozen frame"
          >
            {inspectionChoices.map((choice) => (
              <button
                key={choice.track.id}
                className="button secondary"
                onClick={() => selectVehicle(choice)}
              >
                <CarFront size={15} /> {choice.track.className} #
                {choice.track.id}
                <small>
                  {Math.round(choice.track.score * 100)}% detection score
                </small>
                <ArrowUpRight size={14} />
              </button>
            ))}
          </div>
          <p className="subtle-note">
            Select a box or a vehicle below. Track IDs apply to this camera
            session. Inspection creates no ticket.
          </p>
        </Modal>
      )}
      {inspection && (
        <VehicleInspector
          key={`${inspection.sourceId}:${inspection.frameId}:${inspection.track.id}`}
          inspection={inspection}
          speedUnit={speedUnit}
          onClose={() => setInspection(null)}
        />
      )}
      {editor?.kind === "calibration" && (
        <CalibrationModal
          key={`${editor.frame.sessionId}:${editor.frame.frameId}`}
          canvas={editor.canvas}
          current={editor.frame.calibration}
          demo={false}
          onClose={() => setEditor(null)}
          onSave={(calibration) => void saveGeometry({ calibration })}
          saving={pending === "config"}
          errorMessage={editorError}
          onClear={() => void saveGeometry({ calibration: null })}
        />
      )}
      {editor?.kind === "counting" && (
        <Modal
          title="Count vehicles, by direction."
          subtitle="Place a line on this frozen server-analyzed frame."
          wide
          onClose={() => setEditor(null)}
        >
          <fieldset
            className="background-editor-fieldset"
            disabled={pending === "config"}
          >
            <CountingLineEditor
              canvas={editor.canvas}
              current={editor.frame.countingLine}
              onSave={(countingLine) => void saveGeometry({ countingLine })}
            />
          </fieldset>
          {editorError && (
            <p className="form-error" role="alert">
              {editorError}
            </p>
          )}
          {pending === "config" && (
            <p className="subtle-note" role="status">
              Saving counting line…
            </p>
          )}
        </Modal>
      )}
    </section>
  );
}
