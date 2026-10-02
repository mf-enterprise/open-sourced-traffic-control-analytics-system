import { useCallback, useEffect, useRef, useState } from "react";
import Hls from "hls.js";
import {
  ArrowRight,
  ArrowUpRight,
  Camera,
  CirclePause,
  Globe2,
  MapPin,
  Radio,
  RefreshCw,
  ScanLine,
  TriangleAlert,
} from "lucide-react";
import type { NetworkCameraConfig } from "../useTraffic";
import type { SpeedUnit } from "../units";
import type { MonitorStatus } from "./backgroundMonitorClient";
import BackgroundMonitor from "./BackgroundMonitor";
import {
  monitorIsActive,
  type MonitorCameraRequest,
} from "./backgroundCameraRequest";
import "./live-traffic-control.css";
export interface TrafficCamera {
  id: string;
  name: string;
  location: string;
  country: string;
  road: string;
  provider: string;
  sourcePage: string;
  config: NetworkCameraConfig;
  previewUrl?: string;
}
type PreviewState =
  "connecting" | "buffering" | "playing" | "paused" | "unavailable";
function CameraCard({
  camera,
  selected,
  onSelect,
}: {
  camera: TrafficCamera;
  selected: boolean;
  onSelect: () => void;
}) {
  const [imageFailed, setImageFailed] = useState(false);
  const [snapshotVersion, setSnapshotVersion] = useState(0);
  useEffect(() => setImageFailed(false), [camera.previewUrl]);
  useEffect(() => {
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") {
        setImageFailed(false);
        setSnapshotVersion((value) => value + 1);
      }
    }, 60000);
    return () => clearInterval(timer);
  }, []);
  return (
    <button
      type="button"
      className={`traffic-camera-card ${selected ? "is-selected" : ""}`}
      aria-pressed={selected}
      aria-label={`Preview ${camera.name}, ${camera.location}`}
      onClick={onSelect}
    >
      <div className="traffic-card-image">
        {camera.previewUrl && !imageFailed ? (
          <>
            <img
              src={`${camera.previewUrl}${camera.previewUrl.includes("?") ? "&" : "?"}v=${snapshotVersion}`}
              alt={`${camera.name} camera snapshot`}
              loading="lazy"
              onError={() => setImageFailed(true)}
            />
            <span className="traffic-card-image-label">Snapshot</span>
          </>
        ) : (
          <div className="traffic-card-placeholder">
            <Camera size={23} />
            <span>Preview on selection</span>
          </div>
        )}
        <span className="traffic-card-road">{camera.road}</span>
        {selected && (
          <span className="traffic-card-selected">
            <ScanLine size={12} />
            Selected
          </span>
        )}
      </div>
      <div className="traffic-card-info">
        <div>
          <strong>{camera.name}</strong>
          <ArrowUpRight size={14} />
        </div>
        <span>
          {camera.location} · {camera.country}
        </span>
      </div>
    </button>
  );
}
function CameraPreview({ camera }: { camera: TrafficCamera }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<PreviewState>("connecting");
  const [error, setError] = useState("");
  const [checkedAt, setCheckedAt] = useState<string | null>(null);
  useEffect(() => {
    const element = videoRef.current;
    if (!element) return;
    const video: HTMLVideoElement = element;
    const controller = new AbortController();
    let disposed = false;
    let failed = false;
    let hls: Hls | null = null;
    let firstFrameTimer: ReturnType<typeof setTimeout> | undefined;
    const requestTimer = setTimeout(() => controller.abort(), 12000);
    const unavailable = (message: string) => {
      if (disposed || failed) return;
      failed = true;
      clearTimeout(firstFrameTimer);
      setState("unavailable");
      setError(message);
      hls?.destroy();
      hls = null;
      video.pause();
    };
    const playing = () => {
      if (disposed || failed) return;
      clearTimeout(firstFrameTimer);
      setState("playing");
      setError("");
    };
    const buffering = () => {
      if (disposed || failed) return;
      setState("buffering");
      clearTimeout(firstFrameTimer);
      firstFrameTimer = setTimeout(
        () =>
          unavailable(
            "The camera stopped delivering video. Retry the preview.",
          ),
        20000,
      );
    };
    const paused = () => {
      if (disposed || failed) return;
      clearTimeout(firstFrameTimer);
      setState("paused");
    };
    const stalled = () => {
      if (!video.paused && video.readyState < HTMLMediaElement.HAVE_FUTURE_DATA)
        buffering();
    };
    const videoError = () =>
      unavailable(
        "This camera’s video could not be played. Retry the preview or open the source.",
      );
    video.addEventListener("playing", playing);
    video.addEventListener("waiting", buffering);
    video.addEventListener("stalled", stalled);
    video.addEventListener("pause", paused);
    video.addEventListener("ended", paused);
    video.addEventListener("error", videoError);
    setState("connecting");
    setError("");
    setCheckedAt(null);
    const play = () => {
      if (disposed || failed) return;
      void video.play().catch((failure: unknown) => {
        if (disposed || failed) return;
        if (
          failure instanceof DOMException &&
          failure.name === "NotAllowedError"
        ) {
          clearTimeout(firstFrameTimer);
          setState("paused");
        } else if (!(
          failure instanceof DOMException && failure.name === "AbortError"
        )) {
          unavailable(
            "The camera’s video could not be started. Retry the preview.",
          );
        }
      });
    };
    async function open() {
      try {
        const response = await fetch(
          `/api/traffic-cameras/${encodeURIComponent(camera.id)}/playback`,
          {
            signal: controller.signal,
            cache: "no-store",
          },
        );
        const result = await response.json().catch(() => null);
        if (!response.ok || !result?.playbackUrl)
          throw new Error(
            result?.error ||
              "The camera provider is unavailable. Retry the preview shortly.",
          );
        const url = new URL(result.playbackUrl, window.location.origin);
        if (!["http:", "https:"].includes(url.protocol))
          throw new Error("The camera returned an unsupported video address.");
        if (disposed) return;
        clearTimeout(requestTimer);
        setCheckedAt(
          typeof result.checkedAt === "string" ? result.checkedAt : null,
        );
        firstFrameTimer = setTimeout(
          () =>
            unavailable(
              "The camera has not delivered a playable frame. Retry the preview or open the source.",
            ),
          20000,
        );
        if (Hls.isSupported()) {
          hls = new Hls({
            maxBufferLength: 6,
            maxMaxBufferLength: 12,
            backBufferLength: 0,
          });
          hls.on(Hls.Events.ERROR, (_event, data) => {
            if (data.fatal)
              unavailable(
                "The camera stream was interrupted. Retry the preview.",
              );
          });
          hls.on(Hls.Events.MANIFEST_PARSED, play);
          hls.loadSource(url.href);
          hls.attachMedia(video);
        } else if (video.canPlayType("application/vnd.apple.mpegurl")) {
          video.src = url.href;
          play();
        } else {
          throw new Error(
            "This browser cannot play the live camera format. Open the source to view it.",
          );
        }
      } catch (failure) {
        if (!disposed)
          unavailable(
            controller.signal.aborted
              ? "The camera provider did not respond in time. Retry the preview."
              : failure instanceof Error
                ? failure.message
                : "The camera preview is unavailable.",
          );
      } finally {
        clearTimeout(requestTimer);
      }
    }
    void open();
    return () => {
      disposed = true;
      controller.abort();
      clearTimeout(requestTimer);
      clearTimeout(firstFrameTimer);
      hls?.destroy();
      video.removeEventListener("playing", playing);
      video.removeEventListener("waiting", buffering);
      video.removeEventListener("stalled", stalled);
      video.removeEventListener("pause", paused);
      video.removeEventListener("ended", paused);
      video.removeEventListener("error", videoError);
      video.pause();
      video.removeAttribute("src");
      video.load();
    };
  }, [camera.id, attempt]);
  const checked =
    checkedAt && Number.isFinite(Date.parse(checkedAt))
      ? new Date(checkedAt).toLocaleTimeString([], {
          hour: "2-digit",
          minute: "2-digit",
          second: "2-digit",
        })
      : null;
  return (
    <div className="traffic-selected-preview">
      <div className="traffic-video-stage">
        <video
          ref={videoRef}
          controls
          muted
          playsInline
          aria-label={`${camera.name} live camera preview`}
        />
        <div className={`traffic-preview-state is-${state}`} role="status">
          {state === "playing" ? (
            <Radio size={12} />
          ) : state === "unavailable" ? (
            <TriangleAlert size={12} />
          ) : state === "paused" ? (
            <CirclePause size={12} />
          ) : (
            <RefreshCw size={12} />
          )}
          {state === "playing"
            ? "Playing"
            : state === "connecting"
              ? "Connecting"
              : state === "buffering"
                ? "Buffering"
                : state === "paused"
                  ? "Preview paused"
                  : "Preview unavailable"}
        </div>
        {(state === "connecting" || state === "unavailable") && (
          <div className="traffic-video-message">
            {state === "connecting" ? (
              <Camera size={31} />
            ) : (
              <TriangleAlert size={28} />
            )}
            <strong>
              {state === "connecting"
                ? "Opening camera preview"
                : "Preview unavailable"}
            </strong>
            {error && <p>{error}</p>}
            {state === "unavailable" && (
              <button
                type="button"
                className="button secondary"
                onClick={() => setAttempt((value) => value + 1)}
              >
                <RefreshCw size={14} />
                Retry preview
              </button>
            )}
          </div>
        )}
      </div>
      <div className="traffic-preview-footer">
        <span>{camera.provider}</span>
        <span>
          {checked ? `Feed resolved ${checked}` : "Public camera preview"}
        </span>
      </div>
    </div>
  );
}
export default function LiveTrafficControl({
  cameras,
  speedUnit,
  onCases,
  catalogLoading = false,
  catalogError = "",
  onRetry,
}: {
  cameras: TrafficCamera[];
  speedUnit: SpeedUnit;
  onCases: () => void;
  catalogLoading?: boolean;
  catalogError?: string;
  onRetry?: () => void;
}) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [monitor, setMonitor] = useState<MonitorStatus | null>(null);
  const [requested, setRequested] = useState<MonitorCameraRequest | null>(null);
  const monitorRef = useRef<HTMLDivElement>(null);
  const selectionRef = useRef<HTMLElement>(null);
  const selected =
    cameras.find((camera) => camera.id === selectedId) || cameras[0] || null;
  const active = monitorIsActive(monitor);
  const sameCamera = active && monitor?.trafficCameraId === selected?.id;
  const blocked =
    !monitor ||
    monitor.state === "stopping" ||
    !!requested ||
    !!monitor.stats.pendingCases ||
    !!monitor.stats.pendingHistory ||
    !!monitor.evidenceRecovery?.pending ||
    !!monitor.evidenceRecovery?.error;
  const consumed = useCallback((request: MonitorCameraRequest) => {
    setRequested((current) => (current === request ? null : current));
  }, []);
  const scrollBehavior = () =>
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
      ? "auto"
      : "smooth";
  function analyze() {
    if (!selected || blocked) return;
    if (!sameCamera)
      setRequested({
        id: selected.id,
        config: { ...selected.config, name: selected.name },
        expectedSessionId: active ? monitor?.sessionId || null : null,
      });
    monitorRef.current?.scrollIntoView({
      behavior: scrollBehavior(),
      block: "start",
    });
  }
  return (
    <div className="live-traffic-control">
      <section
        className="traffic-camera-directory"
        aria-label="Public traffic cameras"
      >
        <header className="traffic-directory-header">
          <div>
            <span className="eyebrow">CAMERA DIRECTORY</span>
            <h2>Public traffic cameras</h2>
          </div>
          <span className="traffic-directory-count">
            <Globe2 size={14} />
            {cameras.length} public cameras
          </span>
        </header>
        {catalogLoading && (
          <p className="traffic-directory-message" role="status">
            Loading camera directory…
          </p>
        )}
        {catalogError && (
          <div className="traffic-directory-error" role="alert">
            <TriangleAlert size={17} />
            <span>{catalogError}</span>
            {onRetry && (
              <button
                type="button"
                className="button secondary"
                onClick={onRetry}
              >
                Retry
              </button>
            )}
          </div>
        )}
        {!catalogLoading && !catalogError && cameras.length === 0 && (
          <p className="traffic-directory-message">
            No public cameras are available.
          </p>
        )}
        <div className="traffic-camera-grid">
          {cameras.map((camera) => (
            <CameraCard
              key={camera.id}
              camera={camera}
              selected={camera.id === selected?.id}
              onSelect={() => {
                setSelectedId(camera.id);
                selectionRef.current?.scrollIntoView({
                  behavior: scrollBehavior(),
                  block: "start",
                });
              }}
            />
          ))}
        </div>
      </section>
      {selected && (
        <section
          className="traffic-camera-selection"
          aria-label={`Selected camera: ${selected.name}`}
          ref={selectionRef}
        >
          <CameraPreview key={selected.id} camera={selected} />
          <div className="traffic-selection-detail">
            <span className="eyebrow">SELECTED CAMERA</span>
            <h2>{selected.name}</h2>
            <p className="traffic-selection-location">
              <MapPin size={14} />
              {selected.location}, {selected.country}
            </p>
            <dl>
              <div>
                <dt>Road</dt>
                <dd>{selected.road}</dd>
              </div>
              <div>
                <dt>Provider</dt>
                <dd>{selected.provider}</dd>
              </div>
            </dl>
            <a
              href={selected.sourcePage}
              target="_blank"
              rel="noopener noreferrer"
              className="traffic-source-link"
            >
              Open camera source
              <ArrowUpRight size={13} />
            </a>
            <div className="traffic-selection-action">
              <button
                type="button"
                className="button primary full-width"
                disabled={blocked}
                onClick={analyze}
              >
                <ScanLine size={15} />
                {requested
                  ? "Switching camera…"
                  : sameCamera
                    ? "Open monitor"
                    : active
                      ? "Switch camera"
                      : "Analyze camera"}
                <ArrowRight size={15} />
              </button>
              <p>
                {!monitor
                  ? "Connecting to monitoring service…"
                  : sameCamera
                    ? "This camera is already being analyzed."
                    : active
                      ? `This stops ${monitor.sourceName || "the current camera"} and starts a new session. Road geometry must be set for the new view.`
                      : "Starts vehicle tracking and counting. Speed readings require a measured road scale."}
              </p>
            </div>
          </div>
        </section>
      )}
      <div className="traffic-analysis-workspace" ref={monitorRef}>
        <header>
          <span className="eyebrow">ANALYSIS WORKSPACE</span>
          <h2>
            {active
              ? monitor?.sourceName || "Camera monitoring"
              : "Camera monitoring"}
          </h2>
          <p>
            {active
              ? "One camera is being analyzed on this computer."
              : "Choose a public camera above or connect your own camera below."}
          </p>
        </header>
        <BackgroundMonitor
          speedUnit={speedUnit}
          onCases={onCases}
          requestedCamera={requested}
          onRequestedCameraConsumed={consumed}
          onStatus={setMonitor}
        />
      </div>
    </div>
  );
}
