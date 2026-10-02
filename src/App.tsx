import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  Activity,
  ArrowUpRight,
  Bell,
  Camera,
  CarFront,
  ChartNoAxesCombined,
  Check,
  CheckCheck,
  ChevronDown,
  ChevronRight,
  CircleHelp,
  Clock3,
  Crosshair,
  Download,
  FileCheck2,
  Focus,
  Gauge,
  Globe2,
  Layers2,
  Maximize2,
  MoreHorizontal,
  MoveHorizontal,
  PersonStanding,
  Pause,
  Play,
  Plus,
  ScanLine,
  Search,
  Server,
  Settings2,
  ShieldCheck,
  SlidersHorizontal,
  TriangleAlert,
  Upload,
  Video,
} from "lucide-react";
import { useTraffic, type Observation } from "./useTraffic";
import { segmentedTrendPath } from "./vision/analysisCoverage";
import { useCaseStore, type StoredCase } from "./storage/useCaseStore";
import PlateReader from "./ocr/PlateReader";
import {
  downloadTicketDraft,
  SPEED_CALCULATION_NOTE,
  speedCalculationFields,
} from "./caseReport";
import type { SpeedMeasurement } from "./vision/types";
import CameraConnector from "./components/CameraConnector";
import Modal from "./components/Modal";
import SpeedLimitInput from "./components/SpeedLimitInput";
import CalibrationModal from "./components/CalibrationModal";
import BackgroundMonitor from "./components/BackgroundMonitor";
import LiveTrafficControl, {
  type TrafficCamera,
} from "./components/LiveTrafficControl";
import VehicleInspector from "./components/VehicleInspector";
import type { VehicleInspection } from "./vision/vehicleInspection";
import CountingLineEditor from "./components/CountingLineEditor";
import { HUD_WARNING_COLOR, OBJECT_HUD, objectHudColor } from "./hud";
import {
  formatSpeed,
  speedFromKmh,
  speedToKmh,
  speedUnitLabel,
  type SpeedUnit,
} from "./units";
type View =
  | "overview"
  | "live-traffic"
  | "background"
  | "vehicles"
  | "cases"
  | "analytics"
  | "settings";
const fmtTime = (seconds: number) =>
  `${String(Math.floor(seconds / 3600)).padStart(2, "0")}:${String(Math.floor(seconds / 60) % 60).padStart(2, "0")}:${String(Math.floor(seconds) % 60).padStart(2, "0")}`;
const titleCase = (value: string) =>
  value.charAt(0).toUpperCase() + value.slice(1);
function saveFile(content: string, name: string, type: string) {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
const csvCell = (v: unknown) => `"${String(v ?? "").replaceAll('"', '""')}"`;
function SpeedCalculation({
  measurement,
}: {
  measurement?: SpeedMeasurement | null;
}) {
  const fields = speedCalculationFields(measurement);
  return (
    <section className="speed-calculation" aria-label="Speed calculation">
      <h3>Speed calculation</h3>
      {fields ? (
        <>
          <p>{SPEED_CALCULATION_NOTE}</p>
          <dl>
            {fields.map(([label, value]) => (
              <div key={label}>
                <dt>{label}</dt>
                <dd>{value}</dd>
              </div>
            ))}
          </dl>
        </>
      ) : (
        <p>Calculation trace unavailable</p>
      )}
    </section>
  );
}
function IconButton({
  children,
  label,
  onClick,
  active = false,
}: {
  children: ReactNode;
  label: string;
  onClick: () => void;
  active?: boolean;
}) {
  return (
    <button
      className={`icon-button ${active ? "is-active" : ""}`}
      aria-label={label}
      title={label}
      onClick={onClick}
    >
      {children}
    </button>
  );
}
export default function App() {
  const traffic = useTraffic();
  const { stats, records, source, playing, sourceName, ready } = traffic;
  const flowMaximum = Math.max(
    12,
    ...stats.history.filter((value): value is number => value !== null),
  );
  const monitorLabel = traffic.error
    ? "ERROR"
    : traffic.analysis.state === "reconnect"
      ? "RECONNECT"
      : !ready
        ? "CONNECTING"
        : !playing
          ? "PAUSED"
          : source === "demo"
            ? "LIVE"
            : traffic.analysis.state === "live"
              ? "LIVE"
              : traffic.analysis.state === "hidden"
                ? "PAUSED"
                : traffic.analysis.state === "starting"
                  ? "STARTING"
                  : "ANALYSIS GAP";
  const unitLabel = speedUnitLabel(traffic.speedUnit);
  const displaySpeed = (value: number, digits = 1) =>
    speedFromKmh(value, traffic.speedUnit).toFixed(digits);
  const missingSpeed = (record?: Observation) =>
    record?.speedStatus ||
    (source !== "demo" && !traffic.calibration
      ? "Needs calibration"
      : "Measuring…");
  const [view, setView] = useState<View>(() =>
      window.location.hash === "#background" ? "background" : "live-traffic",
    ),
    [sourceModal, setSourceModal] = useState(false),
    [networkModal, setNetworkModal] = useState(false),
    [countingModal, setCountingModal] =
      useState<ReturnType<typeof traffic.freezeCountingFrame>>(null),
    [calibrate, setCalibrate] =
      useState<ReturnType<typeof traffic.freezeCalibrationFrame>>(null),
    [help, setHelp] = useState(false);
  const [toast, setToast] = useState(""),
    [filter, setFilter] = useState("all"),
    [search, setSearch] = useState("");
  const [selected, setSelected] = useState<Observation | null>(null),
    [storedCase, setStoredCase] = useState<StoredCase | null>(null);
  const [vehicleInspection, setVehicleInspection] =
    useState<VehicleInspection | null>(null);
  useEffect(() => {
    setVehicleInspection(null);
    setSelected(null);
  }, [traffic.inspectionResetVersion]);
  const evidenceStore = useCaseStore();
  const { cases, serverState, pendingCount, queueEvent } = evidenceStore;
  const [reviewer, setReviewer] = useState(""),
    [plate, setPlate] = useState(""),
    [notes, setNotes] = useState(""),
    [saving, setSaving] = useState(false);
  const [audit, setAudit] = useState<
    Array<{
      action: string;
      createdAt?: string;
      timestamp?: string;
      caseId?: string;
    }>
  >([]);
  const processed = useRef(new Set<string>()),
    enqueuing = useRef(new Set<string>()),
    fileInput = useRef<HTMLInputElement>(null),
    monitorRef = useRef<HTMLDivElement>(null);
  const [caseError, setCaseError] = useState("");
  const [clock, setClock] = useState(new Date());
  const [trafficCameras, setTrafficCameras] = useState<TrafficCamera[]>([]);
  const [catalogLoading, setCatalogLoading] = useState(false);
  const [catalogError, setCatalogError] = useState("");
  const [catalogAttempt, setCatalogAttempt] = useState(0);
  const backgroundView = view === "background" || view === "live-traffic";
  useEffect(() => {
    if (view !== "live-traffic") return;
    let disposed = false;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 12000);
    setCatalogLoading(true);
    setCatalogError("");
    void fetch("/api/traffic-cameras", {
      signal: controller.signal,
      cache: "no-store",
    })
      .then(async (response) => {
        if (!response.ok)
          throw new Error("The camera directory could not be loaded.");
        const result = await response.json();
        if (!Array.isArray(result.cameras))
          throw new Error("The camera directory is unavailable.");
        if (!disposed && !controller.signal.aborted)
          setTrafficCameras(result.cameras);
      })
      .catch((error) => {
        if (!disposed)
          setCatalogError(
            error.name === "AbortError"
              ? "The camera directory did not respond. Try again."
              : error.message,
          );
      })
      .finally(() => {
        clearTimeout(timer);
        if (!disposed) setCatalogLoading(false);
      });
    return () => {
      disposed = true;
      clearTimeout(timer);
      controller.abort();
    };
  }, [view, catalogAttempt]);
  const [cameraDevices, setCameraDevices] = useState<MediaDeviceInfo[]>([]),
    [cameraDevice, setCameraDevice] = useState("");
  useEffect(() => {
    window.scrollTo({ top: 0, left: 0, behavior: "instant" });
  }, [view]);
  useEffect(() => {
    if (!sourceModal || !navigator.mediaDevices?.enumerateDevices) return;
    let alive = true;
    void navigator.mediaDevices
      .enumerateDevices()
      .then((devices) => {
        if (alive)
          setCameraDevices(
            devices.filter((device) => device.kind === "videoinput"),
          );
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [sourceModal]);
  useEffect(() => {
    const i = setInterval(() => setClock(new Date()), 1000);
    return () => clearInterval(i);
  }, []);
  useEffect(() => {
    if (!toast) return;
    const i = setTimeout(() => setToast(""), 4500);
    return () => clearTimeout(i);
  }, [toast]);
  useEffect(() => {
    if (caseError) return;
    for (const r of records) {
      if (
        !r.capture ||
        r.capture.sourceKind === "demo" ||
        processed.current.has(r.eventId) ||
        enqueuing.current.has(r.eventId)
      )
        continue;
      enqueuing.current.add(r.eventId);
      queueEvent(r.capture)
        .then(() => {
          processed.current.add(r.eventId);
        })
        .catch((e) => {
          setCaseError(e.message);
          traffic.setPlaying(false);
          traffic.videoRef.current?.pause();
        })
        .finally(() => {
          enqueuing.current.delete(r.eventId);
        });
    }
  }, [records, queueEvent, caseError, traffic.setPlaying]);
  useEffect(() => {
    if (view === "settings" && serverState === "online")
      fetch("/api/audit")
        .then((r) => r.json())
        .then((d) => setAudit(d.events || []))
        .catch(() => {});
  }, [view, serverState, cases]);
  const measured = records.filter(
      (r) => r.speed !== null && r.className !== "person",
    ),
    sortedSpeeds = measured.map((r) => r.speed!).sort((a, b) => a - b);
  const percentile = sortedSpeeds.length
    ? sortedSpeeds[
        Math.min(
          sortedSpeeds.length - 1,
          Math.floor(sortedSpeeds.length * 0.85),
        )
      ]
    : 0;
  const [metricTrends, setMetricTrends] = useState<Array<Array<number | null>>>(
    [[], [], [], []],
  );
  const lastTrend = useRef(-1);
  const lastTrendGap = useRef(0);
  useEffect(() => {
    const bucket = Math.floor(stats.elapsed / 3);
    const interrupted = traffic.analysis.gapCount !== lastTrendGap.current;
    if (bucket === lastTrend.current && !interrupted) return;
    const reset = bucket < lastTrend.current;
    lastTrend.current = bucket;
    lastTrendGap.current = traffic.analysis.gapCount;
    const values = [
      traffic.countingLine ? stats.crossings.total : stats.total,
      stats.average,
      stats.violations,
      percentile,
    ];
    setMetricTrends((previous) =>
      previous.map((series, i) => [
        ...(reset ? [] : series).slice(-15),
        stats.history.at(-1) === null || interrupted ? null : values[i],
      ]),
    );
  }, [
    stats.elapsed,
    stats.total,
    stats.crossings.total,
    traffic.countingLine,
    stats.average,
    stats.violations,
    percentile,
    traffic.analysis.gapCount,
    stats.history,
  ]);
  const toastMsg = (message: string) => setToast(message);
  const exportSession = (format: "csv" | "json" = "csv") => {
    const rows = records.map((r) => ({
      track_id: r.id,
      vehicle: r.className,
      peak_speed_kmh: r.speed?.toFixed(1) ?? "",
      first_seen_seconds: r.time.toFixed(2),
      last_seen_seconds: r.lastSeen.toFixed(2),
      confidence: r.confidence.toFixed(3),
      over_limit: r.overLimit,
      speed_limit: r.speedLimit ?? traffic.limit,
      source: sourceName,
      simulated: source === "demo",
    }));
    if (format === "json")
      saveFile(
        JSON.stringify(
          {
            exportedAt: new Date().toISOString(),
            source: sourceName,
            simulated: source === "demo",
            calibration: traffic.calibration,
            countingLine: traffic.countingLine,
            crossingCounts: stats.crossings,
            analysisCoverage: {
              ...traffic.analysis,
              mode: "foreground page only",
              historyBucketSeconds: 3,
              recentActiveObjects: stats.history,
              unknownBucket: null,
              note: "Counts describe observed frames. Unobserved intervals are not zero traffic; gaps can split identities.",
            },
            records: rows.map((row, index) => {
              const capture = records[index].capture;
              if (!capture) return row;
              const { evidence: _image, ...captureMetadata } = capture;
              return { ...row, capture: captureMetadata };
            }),
          },
          null,
          2,
        ),
        "traffic-control-session.json",
        "application/json",
      );
    else {
      const keys = Object.keys(
        rows[0] || {
          track_id: 0,
          vehicle: "",
          peak_speed_kmh: 0,
          first_seen_seconds: 0,
          last_seen_seconds: 0,
          confidence: 0,
          over_limit: false,
          speed_limit: 0,
          source: "",
          simulated: true,
        },
      );
      saveFile(
        [
          keys.join(","),
          ...rows.map((row) =>
            keys.map((k) => csvCell(row[k as keyof typeof row])).join(","),
          ),
        ].join("\r\n"),
        "traffic-control-session.csv",
        "text/csv",
      );
    }
    toastMsg(`Session exported as ${format.toUpperCase()}`);
  };
  const switchSource = (kind: "demo" | "camera" | "video", file?: File) => {
    setSourceModal(false);
    setView("overview");
    void traffic.prepareSource(
      kind,
      file,
      kind === "camera" ? cameraDevice : undefined,
    );
  };
  const reviewCase = async (state: "approved" | "dismissed") => {
    if (!storedCase) return;
    if (!reviewer.trim()) {
      toastMsg("Enter the reviewer’s name first");
      return;
    }
    if (state === "approved" && !plate.trim()) {
      toastMsg("Verify and enter the vehicle registration first");
      return;
    }
    setSaving(true);
    try {
      const updated = await evidenceStore.reviewCase(storedCase.id, {
        state,
        reviewer,
        plate,
        notes,
      });
      setStoredCase((open) => (open?.id === updated.id ? updated : open));
      toastMsg(
        state === "approved"
          ? "Case reviewed and recorded"
          : "Case dismissed and recorded",
      );
    } catch (e) {
      toastMsg(e instanceof Error ? e.message : "Review failed");
    } finally {
      setSaving(false);
    }
  };
  const nav = [
    { key: "live-traffic", label: "Live Traffic Control", icon: Globe2 },
    { key: "overview", label: "Live overview", icon: ScanLine },
    { key: "background", label: "Background monitoring", icon: Server },
    { key: "vehicles", label: "Vehicle counter", icon: CarFront },
    { key: "cases", label: "Violation cases", icon: FileCheck2 },
    { key: "analytics", label: "Traffic analytics", icon: ChartNoAxesCombined },
    { key: "settings", label: "System settings", icon: Settings2 },
  ] as const;
  const filtered = records.filter(
    (r) =>
      (filter === "all" ||
        (filter === "speeding" ? r.overLimit : r.className === filter)) &&
      `${r.id} ${r.className}`.includes(search.toLowerCase()),
  );
  return (
    <div className="app-shell">
      <aside className="sidebar">
        <a
          href="#"
          className="brand"
          aria-label="Traffic Control home"
          onClick={(e) => {
            e.preventDefault();
            setView("live-traffic");
          }}
        >
          <img src="/brand/icon.svg" width="38" height="38" alt="" />
        </a>
        <div className="nav-group">
          {nav.map(({ key, label, icon: Icon }) => (
            <button
              key={key}
              aria-label={label}
              title={label}
              className={`nav-icon ${view === key ? "active" : ""}`}
              onClick={() => setView(key)}
            >
              <Icon size={21} />
              {key === "cases" && cases.some((c) => c.state === "draft") && (
                <span className="nav-notification" />
              )}
            </button>
          ))}
        </div>
        <div className="sidebar-bottom">
          <button
            className="nav-icon"
            title="How Traffic Control works"
            aria-label="How Traffic Control works"
            onClick={() => setHelp(true)}
          >
            <CircleHelp size={20} />
          </button>
          <div className="avatar" title="Local operator">
            OP
          </div>
        </div>
      </aside>
      <div className="workspace">
        <header className="topbar">
          <div className="wordmark">
            TRAFFIC CONTROL<span>/</span>
            <span className="workspace-name">Local workspace</span>
            <ChevronDown size={13} />
          </div>
          <div className="topbar-right">
            <span className="local-status">
              <span className="status-dot" />
              On-device processing
            </span>
            <span className="top-divider" />
            <IconButton
              label="Show violation cases"
              onClick={() => setView("cases")}
            >
              <Bell size={17} />
              {cases.some((c) => c.state === "draft") && (
                <span className="notification-dot" />
              )}
            </IconButton>
            <div className="operator">
              Local workspace <span>01</span>
            </div>
          </div>
        </header>
        <main>
          <div className="page-heading">
            <div>
              <div className="breadcrumb">
                WORKSPACE <ChevronRight size={11} />{" "}
                {view === "overview"
                  ? "MONITORING"
                  : view === "live-traffic"
                    ? "LIVE CAMERAS"
                    : view === "background"
                      ? "BACKGROUND MONITORING"
                      : view.toUpperCase()}
              </div>
              <h1>
                {view === "overview"
                  ? "Live overview"
                  : view === "live-traffic"
                    ? "Live Traffic Control"
                    : view === "background"
                      ? "Background monitoring"
                      : view === "vehicles"
                        ? "Vehicle counter"
                        : view === "cases"
                          ? "Violation cases"
                          : view === "analytics"
                            ? "Traffic analytics"
                            : "System settings"}
              </h1>
              <p>
                {view === "overview"
                  ? "Detect and track vehicles from a camera or video."
                  : view === "live-traffic"
                    ? "Choose a road camera, preview the feed, and start local traffic analysis."
                    : view === "background"
                      ? "Continuous local camera analysis, with synchronized previews and evidence ready to review."
                      : view === "vehicles"
                        ? "Unique tracks, vehicle classes, and measured speeds in this session."
                        : view === "cases"
                          ? "Automatic speeding captures. Human-reviewed violation records."
                          : view === "analytics"
                            ? "Understand traffic flow and speed distribution across the active session."
                            : "Configure speed policy, measurement quality, and your local workspace."}
              </p>
            </div>
            {!backgroundView && (
              <div className="heading-actions">
                <button
                  className="button secondary"
                  onClick={() => exportSession()}
                >
                  <Download size={15} />
                  Export data
                </button>
                <button
                  className="button primary"
                  onClick={() => setSourceModal(true)}
                >
                  <Plus size={17} />
                  Connect camera
                </button>
              </div>
            )}
          </div>
          {((!backgroundView && traffic.error) ||
            caseError ||
            evidenceStore.error) && (
            <div className="error-banner" role="alert">
              <TriangleAlert size={16} />
              <span>
                {(!backgroundView && traffic.error) ||
                  `Evidence service: ${caseError || evidenceStore.error}`}
              </span>
              {!backgroundView && traffic.error ? (
                <button onClick={() => setSourceModal(true)}>
                  Choose source <ArrowUpRight size={14} />
                </button>
              ) : (
                <button
                  onClick={() => {
                    setCaseError("");
                    evidenceStore.retryFailed();
                  }}
                >
                  Retry saving <ArrowUpRight size={14} />
                </button>
              )}
            </div>
          )}
          {serverState === "offline" && (
            <div className="error-banner">
              <TriangleAlert size={16} />
              <span>
                Evidence service is offline. Captures are queued on this device
                for retry. Restart the application to reconnect. {pendingCount}{" "}
                awaiting save.
              </span>
            </div>
          )}
          {!backgroundView &&
            source !== "demo" &&
            (traffic.analysis.state !== "live" ||
              traffic.analysis.gapCount > 0) && (
              <div className="error-banner" role="status" aria-live="polite">
                <Activity size={16} />
                <span>
                  {traffic.analysis.state === "live"
                    ? `Analysis resumed after ${traffic.analysis.lastGapSeconds.toFixed(1)} seconds without analyzed frames. Counts cover observed frames only; gaps can split identities.`
                    : traffic.analysis.message}
                  {traffic.analysis.currentGapSeconds > 0 &&
                  traffic.analysis.state !== "reconnect"
                    ? ` Unobserved for ${Math.floor(traffic.analysis.currentGapSeconds)} seconds.`
                    : ""}
                  {traffic.analysis.notice ? ` ${traffic.analysis.notice}` : ""}
                </span>
                {traffic.analysis.state === "reconnect" && (
                  <button onClick={() => setSourceModal(true)}>
                    Reconnect source <ArrowUpRight size={14} />
                  </button>
                )}
              </div>
            )}

          {view === "live-traffic" && (
            <LiveTrafficControl
              cameras={trafficCameras}
              speedUnit={traffic.speedUnit}
              catalogLoading={catalogLoading}
              catalogError={catalogError}
              onRetry={() => setCatalogAttempt((value) => value + 1)}
              onCases={() => {
                void evidenceStore.refresh();
                setView("cases");
              }}
            />
          )}
          {view === "background" && (
            <BackgroundMonitor
              speedUnit={traffic.speedUnit}
              onCases={() => {
                void evidenceStore.refresh();
                setView("cases");
              }}
            />
          )}

          {(view === "overview" ||
            view === "analytics" ||
            view === "vehicles") && (
            <div className="metrics-grid">
              <Metric
                label={
                  traffic.countingLine
                    ? "Vehicles crossed"
                    : "Vehicles observed"
                }
                value={(traffic.countingLine
                  ? stats.crossings.total
                  : stats.total
                ).toLocaleString()}
                icon={<CarFront size={17} />}
                note={
                  <>
                    <span className="mini-green-dot" />{" "}
                    {traffic.countingLine
                      ? `${stats.crossings.forward} forward · ${stats.crossings.reverse} reverse`
                      : `${stats.active} confirmed objects in frame`}
                  </>
                }
                graph="count"
                trend={metricTrends[0]}
              />
              <Metric
                label="Average peak speed"
                value={
                  measured.length ? displaySpeed(stats.average) : missingSpeed()
                }
                unit={measured.length ? unitLabel : undefined}
                icon={<Gauge size={17} />}
                note={
                  source === "demo" ? (
                    "Simulated vehicle speeds"
                  ) : traffic.calibration ? (
                    "Calibrated road plane"
                  ) : (
                    <button
                      className="text-button"
                      onClick={() =>
                        setCalibrate(traffic.freezeCalibrationFrame())
                      }
                    >
                      Set road scale
                    </button>
                  )
                }
                graph="speed"
                trend={metricTrends[1]}
              />
              <Metric
                label="Speeding events"
                value={stats.violations.toString().padStart(2, "0")}
                icon={<TriangleAlert size={16} />}
                note={
                  <>
                    <span className="mini-orange-dot" /> Above{" "}
                    {displaySpeed(traffic.limit)} {unitLabel} limit
                  </>
                }
                graph="events"
                trend={metricTrends[2]}
                accent
              />
              <Metric
                label="85th percentile"
                value={
                  measured.length ? displaySpeed(percentile) : missingSpeed()
                }
                unit={measured.length ? unitLabel : undefined}
                icon={<Activity size={17} />}
                note="Based on per-vehicle peak speed"
                graph="percentile"
                trend={metricTrends[3]}
              />
            </div>
          )}

          <div
            className={
              view === "overview" ? "monitor-grid" : "monitor-grid hidden"
            }
          >
            <section className="panel monitor-panel" ref={monitorRef}>
              <div className="panel-header">
                <div className="panel-title">
                  <Video size={17} />
                  <h2>Live monitor</h2>
                  <span
                    className={`pill ${monitorLabel === "LIVE" ? "lime" : "muted"}`}
                  >
                    <span />
                    {monitorLabel}
                  </span>
                </div>
                <div className="monitor-header-right">
                  <span className="mono">CAM 01</span>
                  <IconButton
                    label="Source settings"
                    onClick={() => setSourceModal(true)}
                  >
                    <MoreHorizontal size={18} />
                  </IconButton>
                </div>
              </div>
              <div className="video-surface">
                <canvas
                  ref={traffic.canvasRef}
                  width={1600}
                  height={900}
                  aria-label="Live traffic video with vehicle bounding boxes and speeds"
                />
                <video
                  ref={traffic.videoRef}
                  muted
                  playsInline
                  className="source-video"
                  onEnded={() => traffic.setPlaying(false)}
                />
                <div className="video-top">
                  <div className="camera-info">
                    <span className="camera-square">
                      <Camera size={14} />
                    </span>
                    <div>
                      <strong>{sourceName}</strong>
                      <span>
                        {source === "demo"
                          ? "SIMULATED TRAFFIC · DEMO MODE"
                          : source === "camera"
                            ? "CONNECTED CAMERA · LOCAL PROCESSING"
                            : "LOCAL VIDEO · ON-DEVICE ANALYSIS"}
                      </span>
                    </div>
                  </div>
                  <span className="video-timestamp">
                    {clock.toLocaleDateString("en-GB").replaceAll("/", ".")}
                    <br />
                    {clock.toLocaleTimeString("en-GB")}
                  </span>
                </div>
                <div className="video-bottom">
                  <span className="video-chip">
                    <span className="status-dot" />
                    {stats.active} tracked
                  </span>
                  <span className="video-chip mono">
                    {source === "demo"
                      ? "SIMULATION"
                      : `${Math.round(stats.fps)} INFERENCES/SEC`}
                  </span>
                  <span
                    className="speed-limit-sign"
                    title={`Speed limit: ${formatSpeed(traffic.limit, traffic.speedUnit)}`}
                    aria-label={`Speed limit: ${formatSpeed(traffic.limit, traffic.speedUnit)}`}
                  >
                    <span
                      style={{
                        display: "flex",
                        flexDirection: "column",
                        alignItems: "center",
                        lineHeight: 1,
                      }}
                    >
                      {displaySpeed(traffic.limit, 0)}
                      <small style={{ fontSize: 5, marginTop: 1 }}>
                        {unitLabel}
                      </small>
                    </span>
                  </span>
                </div>
                {!ready && (
                  <div className="loading-layer">
                    <div
                      className={
                        traffic.error || traffic.analysis.state === "reconnect"
                          ? ""
                          : "spinner"
                      }
                    />
                    <strong>
                      {traffic.analysis.state === "reconnect"
                        ? "Reconnect camera"
                        : traffic.error
                          ? "Source unavailable"
                          : traffic.status}
                    </strong>
                    <span>
                      {traffic.error || traffic.analysis.state === "reconnect"
                        ? "Choose another source to continue."
                        : "Loading locally. Your footage stays on your device."}
                    </span>
                  </div>
                )}
                {!playing && ready && (
                  <button
                    className="play-overlay"
                    onClick={() => void traffic.togglePlayback()}
                    aria-label="Resume monitoring"
                  >
                    <Play size={25} fill="currentColor" />
                  </button>
                )}
              </div>
              <div className="monitor-toolbar">
                <div className="toolbar-left">
                  <IconButton
                    label={playing ? "Pause monitoring" : "Resume monitoring"}
                    onClick={() => void traffic.togglePlayback()}
                  >
                    {playing ? <Pause size={17} /> : <Play size={17} />}
                  </IconButton>
                  <span className="session-time mono">
                    {fmtTime(stats.elapsed)}
                  </span>
                  <span className="toolbar-separator" />
                  <button
                    className={`tool-toggle ${traffic.overlay ? "selected" : ""}`}
                    onClick={() => traffic.setOverlay(!traffic.overlay)}
                  >
                    <ScanLine size={15} />
                    <span>Detections</span>
                  </button>
                  <button
                    className={`tool-toggle ${traffic.trails ? "selected" : ""}`}
                    onClick={() => traffic.setTrails(!traffic.trails)}
                  >
                    <Layers2 size={15} />
                    <span>Trails</span>
                  </button>
                </div>
                <div className="toolbar-right">
                  <button
                    className={`tool-toggle ${traffic.countingLine ? "selected" : ""}`}
                    onClick={() =>
                      setCountingModal(traffic.freezeCountingFrame())
                    }
                  >
                    <MoveHorizontal size={15} />
                    <span>Count line</span>
                  </button>
                  <button
                    className="tool-toggle"
                    onClick={() =>
                      setCalibrate(traffic.freezeCalibrationFrame())
                    }
                  >
                    <Crosshair size={15} />
                    <span>Calibrate</span>
                  </button>
                  <IconButton
                    label="Full screen monitor"
                    onClick={() => {
                      if (document.fullscreenElement)
                        void document.exitFullscreen();
                      else
                        void monitorRef.current
                          ?.requestFullscreen()
                          .catch(() =>
                            toastMsg(
                              "Full screen is unavailable in this browser",
                            ),
                          );
                    }}
                  >
                    <Maximize2 size={16} />
                  </IconButton>
                </div>
              </div>
              {source === "video" && traffic.duration > 0 && (
                <input
                  className="video-seek"
                  aria-label="Video position"
                  type="range"
                  min="0"
                  max={traffic.duration}
                  step=".1"
                  value={stats.elapsed}
                  onChange={(e) => traffic.seek(Number(e.target.value))}
                />
              )}
              {traffic.overlay && (
                <div className="hud-legend" aria-label="Object HUD colors">
                  {OBJECT_HUD.map(({ className, label, color }) => (
                    <span key={className}>
                      <i
                        style={{ backgroundColor: color }}
                        aria-hidden="true"
                      />
                      {label}
                    </span>
                  ))}
                  <span className="hud-warning-key">
                    <TriangleAlert size={12} color={HUD_WARNING_COLOR} />
                    Over limit
                  </span>
                </div>
              )}
              <div className="monitor-footer">
                <span>
                  <ShieldCheck size={13} />
                  {source === "demo"
                    ? "Demo measurements are simulated"
                    : traffic.calibration
                      ? traffic.cameraStability.state === "stable"
                        ? "Camera reference matched · Estimated speeds"
                        : "Speed estimates suspended · Check camera reference"
                      : "Calibration required for speed measurement"}
                </span>
                <span className="mono">
                  {source === "demo"
                    ? "PROCEDURAL FEED"
                    : traffic.calibration
                      ? `${traffic.calibration.widthMeters} × ${traffic.calibration.lengthMeters} m`
                      : traffic.detectorInfo.name}
                </span>
              </div>
              {source !== "demo" && traffic.calibration && (
                <p className="subtle-note" role="status">
                  {traffic.cameraStability.reason}
                  {traffic.cameraStability.state === "moved" &&
                    " Recalibrate after fixing the camera position."}
                </p>
              )}
              {source !== "demo" &&
                traffic.countingLine &&
                traffic.countingStability.state !== "stable" && (
                  <p className="subtle-note" role="status">
                    Directional counts suspended.{" "}
                    {traffic.countingStability.reason}
                  </p>
                )}
            </section>
            <section className="panel activity-panel">
              <div className="panel-header">
                <div className="panel-title">
                  <h2>Detection feed</h2>
                  <span className="count-badge">{records.length}</span>
                </div>
                <span className="live-dot" />
              </div>
              <div className="feed-subheader">
                <span>VEHICLE / TRACK ID</span>
                <span>SPEED</span>
              </div>
              <div className="detection-feed">
                {records.slice(0, 7).map((r) => (
                  <button
                    key={r.id}
                    className="detection-row"
                    onClick={() => setSelected(r)}
                  >
                    <span
                      className="vehicle-icon"
                      style={{
                        color: objectHudColor(r.className),
                        backgroundColor: objectHudColor(r.className) + "12",
                        borderColor: objectHudColor(r.className) + "30",
                      }}
                    >
                      {r.className === "person" ? (
                        <PersonStanding size={18} />
                      ) : (
                        <CarFront size={18} />
                      )}
                    </span>
                    <span className="detection-details">
                      <strong>
                        {titleCase(r.className)}
                        <span className="mono">
                          #{String(r.id).padStart(3, "0")}
                        </span>
                      </strong>
                      <span>
                        {r.overLimit ? (
                          <>
                            <i className="orange-dot" />
                            Speed limit exceeded
                          </>
                        ) : (
                          `${Math.round(r.confidence * 100)}% detection confidence`
                        )}
                      </span>
                    </span>
                    <span
                      className={`detection-speed mono ${r.overLimit ? "orange" : ""}`}
                    >
                      {r.speed === null ? (
                        <span style={{ fontSize: 9, fontFamily: "inherit" }}>
                          {missingSpeed(r)}
                        </span>
                      ) : (
                        displaySpeed(r.speed)
                      )}
                      {r.speed !== null && <small>{unitLabel}</small>}
                    </span>
                  </button>
                ))}
                {records.length === 0 && (
                  <div className="feed-empty">
                    <ScanLine size={28} />
                    <p>Waiting for detections</p>
                    <span>Vehicles appear here as they are tracked.</span>
                  </div>
                )}
              </div>
              <button className="feed-all" onClick={() => setView("vehicles")}>
                View all detections <ArrowUpRight size={15} />
              </button>
              <div className="speed-policy">
                <span className="speed-limit-mini" title={unitLabel}>
                  {displaySpeed(traffic.limit, 0)}
                </span>
                <div>
                  <strong>
                    {source === "demo" ||
                    (traffic.calibration &&
                      traffic.cameraStability.state === "stable")
                      ? "Speed policy active"
                      : traffic.calibration
                        ? "Speed capture suspended"
                        : "Set road scale"}
                  </strong>
                  <span>
                    {source === "demo" ||
                    (traffic.calibration &&
                      traffic.cameraStability.state === "stable")
                      ? `Auto-capture above ${displaySpeed(traffic.limit)} ${unitLabel}`
                      : traffic.calibration
                        ? "Camera reference must match before speed capture"
                        : "Calibration needed before speed capture"}
                  </span>
                </div>
                <IconButton
                  label="Edit speed policy"
                  onClick={() => setView("settings")}
                >
                  <SlidersHorizontal size={16} />
                </IconButton>
              </div>
            </section>
          </div>

          {(view === "overview" || view === "analytics") && (
            <div className="analytics-grid">
              <section className="panel flow-panel">
                <div className="panel-header">
                  <div className="panel-title">
                    <h2>Traffic flow</h2>
                    <span className="panel-caption">
                      Objects · hatched = unknown
                    </span>
                  </div>
                  <span className="chart-period">
                    Last 72 seconds <Clock3 size={13} />
                  </span>
                </div>
                <div className="bar-chart">
                  <div className="chart-y">
                    <span>{flowMaximum}</span>
                    <span>{Math.round(flowMaximum / 2)}</span>
                    <span>0</span>
                  </div>
                  <div className="bars">
                    {stats.history.map((n, i) => (
                      <div
                        className="bar-slot"
                        key={i}
                        title={
                          n === null
                            ? "Unobserved interval — traffic is unknown"
                            : `${n} active objects`
                        }
                        aria-label={
                          n === null
                            ? "Unobserved interval"
                            : `${n} active objects`
                        }
                      >
                        <i
                          style={{
                            height:
                              n === null
                                ? "100%"
                                : `${Math.max(2, (n / flowMaximum) * 100)}%`,
                            opacity: n === null ? 0.35 : 0.35 + (i / 24) * 0.65,
                            ...(n === null
                              ? {
                                  background:
                                    "repeating-linear-gradient(135deg, transparent, transparent 5px, #82919666 5px, #82919666 6px)",
                                }
                              : {}),
                          }}
                        />
                      </div>
                    ))}
                  </div>
                </div>
                <div className="chart-x">
                  <span>72s ago</span>
                  <span>54s</span>
                  <span>36s</span>
                  <span>18s</span>
                  <span>Now</span>
                </div>
              </section>
              <section className="panel mix-panel">
                <div className="panel-header">
                  <div className="panel-title">
                    <h2>Vehicle mix</h2>
                  </div>
                  <CarFront size={16} className="dim" />
                </div>
                <div className="mix-content">
                  <div
                    className="donut"
                    style={{ background: donutGradient(stats.classes) }}
                  >
                    <div>
                      <strong>{stats.total}</strong>
                      <span>VEHICLES</span>
                    </div>
                  </div>
                  <div className="mix-legend">
                    {[
                      ["car", "Cars", "#d4f296"],
                      ["truck", "Trucks", "#81958a"],
                      ["bus", "Buses", "#b9cad2"],
                      ["motorcycle", "Motorcycles", "#efb985"],
                      ["bicycle", "Bicycles", "#727ba3"],
                    ].map(([key, label, color]) => (
                      <div key={key}>
                        <i style={{ background: color }} />
                        <span>{label}</span>
                        <strong className="mono">
                          {stats.classes[key] || 0}
                        </strong>
                      </div>
                    ))}
                  </div>
                </div>
              </section>
            </div>
          )}

          {view === "vehicles" && (
            <section className="panel records-panel">
              <div className="panel-header">
                <div className="panel-title">
                  <h2>Vehicle counter</h2>
                  <span className="count-badge">{records.length}</span>
                </div>
                <div className="table-controls">
                  <label className="search-field">
                    <Search size={15} />
                    <input
                      placeholder="Search track or class"
                      value={search}
                      onChange={(e) => setSearch(e.target.value)}
                    />
                  </label>
                  <select
                    aria-label="Filter detections"
                    value={filter}
                    onChange={(e) => setFilter(e.target.value)}
                  >
                    <option value="all">All detections</option>
                    <option value="speeding">Speeding only</option>
                    <option value="car">Cars</option>
                    <option value="truck">Trucks</option>
                    <option value="bus">Buses</option>
                    <option value="motorcycle">Motorcycles</option>
                    <option value="person">Pedestrians</option>
                  </select>
                </div>
              </div>
              <div className="table-scroll">
                <table>
                  <thead>
                    <tr>
                      <th>TRACK</th>
                      <th>CLASSIFICATION</th>
                      <th>PEAK SPEED</th>
                      <th>CONFIDENCE</th>
                      <th>FIRST SEEN</th>
                      <th>STATUS</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {filtered.map((r) => (
                      <tr key={r.id}>
                        <td className="mono">
                          #{String(r.id).padStart(4, "0")}
                        </td>
                        <td>
                          <span className="table-vehicle">
                            <CarFront size={16} />
                            {titleCase(r.className)}
                          </span>
                        </td>
                        <td className={`mono ${r.overLimit ? "orange" : ""}`}>
                          {r.speed === null
                            ? missingSpeed(r)
                            : formatSpeed(r.speed, traffic.speedUnit)}
                        </td>
                        <td className="mono">
                          {Math.round(r.confidence * 100)}%
                        </td>
                        <td className="mono">{fmtTime(r.time)}</td>
                        <td>
                          <span
                            className={`status-tag ${r.overLimit ? "tag-warning" : "tag-neutral"}`}
                          >
                            {r.overLimit ? "Above limit" : "Tracked"}
                          </span>
                        </td>
                        <td>
                          <button
                            className="text-button"
                            onClick={() => setSelected(r)}
                          >
                            Inspect <ArrowUpRight size={13} />
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {filtered.length === 0 && (
                  <EmptyState
                    title="No matching vehicles"
                    text="Connect a camera, select a video, or change your filter."
                  />
                )}
              </div>
              <div className="table-footer">
                <span>
                  Showing {filtered.length} tracks · Session retains up to 1,500
                  observations
                </span>
                <button
                  className="text-button"
                  onClick={() => exportSession("json")}
                >
                  Export JSON <Download size={13} />
                </button>
              </div>
            </section>
          )}

          {view === "cases" && (
            <>
              <div className="case-summary">
                <div>
                  <ShieldCheck size={20} />
                  <span>
                    <strong>Evidence-first workflow</strong>
                    <small>Detected → Captured → Drafted → Human review</small>
                  </span>
                </div>
                <p>
                  Speeding events from calibrated camera/video sources are saved
                  automatically. Approval records an internal review; it does
                  not issue a legal penalty.
                </p>
              </div>
              <section className="panel">
                <div className="panel-header">
                  <div className="panel-title">
                    <h2>Violation cases</h2>
                    <span className="count-badge">{cases.length}</span>
                  </div>
                  <span
                    className={`service-status ${serverState === "online" ? "online" : "orange"}`}
                  >
                    <span className="status-dot" />
                    {serverState === "online"
                      ? "Evidence storage connected"
                      : "Storage unavailable"}
                  </span>
                </div>
                <div className="table-scroll">
                  <table>
                    <thead>
                      <tr>
                        <th>CASE NUMBER</th>
                        <th>VEHICLE</th>
                        <th>MEASURED / LIMIT</th>
                        <th>CAPTURED</th>
                        <th>STATUS</th>
                        <th />
                      </tr>
                    </thead>
                    <tbody>
                      {cases.map((c) => (
                        <tr key={c.id}>
                          <td className="mono">{c.id}</td>
                          <td>
                            {titleCase(c.className)}{" "}
                            <span className="dim">
                              {c.plate || `#${c.trackId}`}
                            </span>
                          </td>
                          <td className="mono">
                            <span className="orange">
                              {displaySpeed(c.speedKmh)}
                            </span>{" "}
                            / {displaySpeed(c.speedLimit)} {unitLabel}
                          </td>
                          <td>
                            {new Date(c.captureTime).toLocaleString("en-GB")}
                          </td>
                          <td>
                            <span
                              className={`status-tag ${c.state === "draft" ? "tag-warning" : "tag-neutral"}`}
                            >
                              {c.state === "approved"
                                ? "Reviewed"
                                : titleCase(c.state)}
                            </span>
                          </td>
                          <td>
                            <button
                              className="text-button"
                              onClick={() => {
                                setStoredCase(c);
                                setReviewer(c.reviewer);
                                setPlate(c.plate);
                                setNotes(c.notes);
                              }}
                            >
                              Review <ArrowUpRight size={14} />
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  {cases.length === 0 && (
                    <EmptyState
                      title="Ready for the first capture"
                      text={
                        source === "demo"
                          ? "The simulated demo does not create enforcement records. Connect a camera and calibrate the road to capture real events."
                          : "Calibrate the road and set a speed limit. Vehicles exceeding it will generate evidence-backed drafts here."
                      }
                    />
                  )}
                </div>
              </section>
            </>
          )}

          {view === "analytics" && (
            <section className="panel distribution-panel">
              <div className="panel-header">
                <div className="panel-title">
                  <h2>Speed distribution</h2>
                  <span className="panel-caption">
                    Per-vehicle peak estimates
                  </span>
                </div>
                <span className="pill muted">
                  {source === "demo" ? "SIMULATED" : "CURRENT SESSION"}
                </span>
              </div>
              <div className="distribution">
                {[0, 20, 40, 60, 80, 100].map((n, i) => {
                  const count = measured.filter(
                    (r) =>
                      speedFromKmh(r.speed!, traffic.speedUnit) >= n &&
                      (i === 5 ||
                        speedFromKmh(r.speed!, traffic.speedUnit) < n + 20),
                  ).length;
                  return (
                    <div key={n}>
                      <strong>{count}</strong>
                      <div>
                        <i
                          style={{
                            height: `${Math.max(2, (count / Math.max(1, measured.length)) * 100)}%`,
                          }}
                        />
                      </div>
                      <span>
                        {n}
                        {i === 5 ? "+" : `–<${n + 20}`} {unitLabel}
                      </span>
                    </div>
                  );
                })}
              </div>
            </section>
          )}

          {view === "settings" && (
            <div className="settings-grid">
              <section className="panel settings-card">
                <div className="settings-title">
                  <MoveHorizontal size={20} />
                  <div>
                    <h2>Vehicle counter</h2>
                    <p>Count traffic passing a line in either direction.</p>
                  </div>
                </div>
                <div className="setting-row">
                  <span>Counting line</span>
                  <strong>
                    {traffic.countingLine
                      ? source === "demo" ||
                        traffic.countingStability.state === "stable"
                        ? "Active"
                        : "Suspended"
                      : "Not configured"}
                  </strong>
                </div>
                <div className="setting-row">
                  <span>Forward / reverse</span>
                  <strong>
                    {stats.crossings.forward} / {stats.crossings.reverse}
                  </strong>
                </div>
                <div className="setting-row">
                  <span>Vehicles observed</span>
                  <strong>{stats.total}</strong>
                </div>
                <button
                  className="button secondary full-width"
                  onClick={() =>
                    setCountingModal(traffic.freezeCountingFrame())
                  }
                >
                  <MoveHorizontal size={16} />
                  Configure counting line
                </button>
                <p className="subtle-note">
                  Observed counts include confirmed parked vehicles. Crossing
                  counts include only vehicles passing the selected line, once
                  per track. Both counters reset when the source changes.
                </p>
                {source !== "demo" && traffic.countingLine && (
                  <p className="subtle-note" role="status">
                    {traffic.countingStability.reason}
                  </p>
                )}
              </section>
              <section className="panel settings-card">
                <div className="settings-title">
                  <Gauge size={20} />
                  <div>
                    <h2>Speed policy</h2>
                    <p>Applied to new captures from the active source.</p>
                  </div>
                </div>
                <label className="field-label" htmlFor="speed-unit">
                  Speed display unit
                </label>
                <select
                  id="speed-unit"
                  value={traffic.speedUnit}
                  onChange={(event) =>
                    traffic.setSpeedUnit(event.target.value as SpeedUnit)
                  }
                  style={{
                    width: "100%",
                    padding: "10px 12px",
                    marginBottom: 16,
                    border: "1px solid var(--line)",
                    borderRadius: 5,
                    background: "var(--bg)",
                    fontSize: 12,
                  }}
                >
                  <option value="kmh">Kilometres per hour (km/h)</option>
                  <option value="mph">Miles per hour (mph)</option>
                </select>
                <label className="field-label" htmlFor="speed-limit">
                  Maximum permitted speed
                </label>
                <SpeedLimitInput
                  valueKmh={traffic.limit}
                  unit={traffic.speedUnit}
                  onCommit={traffic.setLimit}
                />
                <input
                  aria-label={`Adjust speed limit in ${unitLabel}`}
                  aria-valuetext={formatSpeed(traffic.limit, traffic.speedUnit)}
                  type="range"
                  min={speedFromKmh(5, traffic.speedUnit)}
                  max={speedFromKmh(200, traffic.speedUnit)}
                  step="any"
                  value={speedFromKmh(traffic.limit, traffic.speedUnit)}
                  onChange={(e) =>
                    traffic.setLimit(
                      speedToKmh(Number(e.target.value), traffic.speedUnit),
                    )
                  }
                />
                <div className="range-labels">
                  <span>{formatSpeed(5, traffic.speedUnit)}</span>
                  <span>{formatSpeed(200, traffic.speedUnit)}</span>
                </div>
                <div className="info-box">
                  <FileCheck2 size={17} />
                  <span>
                    Each vehicle is captured once per track when its calibrated
                    speed exceeds this limit. Original capture settings are
                    preserved in the case.
                  </span>
                </div>
              </section>
              <section className="panel settings-card">
                <div className="settings-title">
                  <Crosshair size={20} />
                  <div>
                    <h2>Camera calibration</h2>
                    <p>Turn image movement into measured distance.</p>
                  </div>
                </div>
                <div className="setting-row">
                  <span>Active source</span>
                  <strong>{sourceName}</strong>
                </div>
                <div className="setting-row">
                  <span>Road plane</span>
                  <strong>
                    {traffic.calibration
                      ? `${traffic.calibration.widthMeters} × ${traffic.calibration.lengthMeters} m`
                      : "Not calibrated"}
                  </strong>
                </div>
                <div className="setting-row">
                  <span>Measurement method</span>
                  <strong>4-point homography</strong>
                </div>
                <div className="setting-row">
                  <span>Vision engine</span>
                  <strong>{traffic.detectorInfo.name}</strong>
                </div>
                {traffic.detectorInfo.fallbackReason && (
                  <p className="subtle-note">
                    Compatibility detector is active. The primary model could
                    not initialize: {traffic.detectorInfo.fallbackReason}
                  </p>
                )}
                <button
                  className="button secondary full-width"
                  onClick={() => setCalibrate(traffic.freezeCalibrationFrame())}
                >
                  <Focus size={16} />
                  Calibrate camera
                </button>
                <p className="subtle-note">
                  Use a fixed camera and known road dimensions. Estimates need
                  field validation before enforcement use.
                </p>
              </section>
              <section className="panel settings-card">
                <div className="settings-title">
                  <ShieldCheck size={20} />
                  <div>
                    <h2>Local evidence storage</h2>
                    <p>Measurements, captured frames, and review history.</p>
                  </div>
                </div>
                <div className="setting-row">
                  <span>Storage service</span>
                  <strong
                    className={
                      serverState === "online" ? "lime-text" : "orange"
                    }
                  >
                    {titleCase(serverState)}
                  </strong>
                </div>
                <div className="setting-row">
                  <span>Saved cases</span>
                  <strong>{cases.length}</strong>
                </div>
                <div className="setting-row">
                  <span>Evidence integrity</span>
                  <strong>SHA-256</strong>
                </div>
                <div className="setting-row">
                  <span>Video uploads</span>
                  <strong>None · processed on-device</strong>
                </div>
                <p className="subtle-note">
                  SQLite storage is on this computer. This local edition has no
                  multi-user access controls or certified speed measurement.
                </p>
              </section>
              <section className="panel settings-card">
                <div className="settings-title">
                  <Clock3 size={20} />
                  <div>
                    <h2>Audit history</h2>
                    <p>Append-only case activity in this workspace.</p>
                  </div>
                </div>
                {audit.length ? (
                  <div className="audit-list">
                    {audit.slice(0, 6).map((a, i) => (
                      <div key={i}>
                        <i />
                        <span>
                          <strong>{a.action}</strong>
                          <small>
                            {a.caseId} · {a.createdAt || a.timestamp || ""}
                          </small>
                        </span>
                      </div>
                    ))}
                  </div>
                ) : (
                  <p className="subtle-note">
                    Creating or reviewing a real case adds an audit entry here.
                  </p>
                )}
              </section>
            </div>
          )}

          <footer className="workspace-footer">
            <span>
              <span className="status-dot" />
              {view === "live-traffic"
                ? "Live camera directory"
                : view === "background"
                  ? "Background monitoring workspace"
                  : source === "demo"
                    ? "Demo workspace"
                    : monitorLabel === "LIVE"
                      ? "Analysis active · keep this page visible"
                      : monitorLabel === "RECONNECT"
                        ? "Camera reconnection required"
                        : monitorLabel === "ANALYSIS GAP"
                          ? "Analysis interrupted · unobserved interval"
                          : monitorLabel === "STARTING"
                            ? "Waiting for fresh analysis"
                            : "Monitoring paused"}
              <i />
              All processing stays on your device
            </span>
            <span>
              TRAFFIC CONTROL <span className="mono">v1.0</span>
              <span className="footer-logo">↗</span>
            </span>
          </footer>
        </main>
      </div>
      <input
        ref={fileInput}
        type="file"
        accept="video/*"
        className="hidden"
        aria-label="Select traffic video"
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) switchSource("video", file);
          e.target.value = "";
        }}
      />
      {sourceModal && (
        <Modal
          title="Connect your view."
          subtitle="Choose the source for real-time traffic intelligence."
          onClose={() => setSourceModal(false)}
        >
          {cameraDevices.length > 0 && (
            <label className="camera-device-choice">
              USB / webcam input
              <select
                aria-label="USB camera device"
                value={cameraDevice}
                onChange={(e) => setCameraDevice(e.target.value)}
              >
                <option value="">System default camera</option>
                {cameraDevices.map((device, i) => (
                  <option key={device.deviceId || i} value={device.deviceId}>
                    {device.label || `Camera ${i + 1}`}
                  </option>
                ))}
              </select>
            </label>
          )}
          <div className="source-options">
            <button
              className="source-option featured"
              onClick={() => switchSource("camera")}
            >
              <span className="source-option-icon">
                <Camera size={24} />
              </span>
              <div>
                <strong>
                  Live camera <span className="small-pill">RECOMMENDED</span>
                </strong>
                <p>
                  Connect a webcam or USB camera.
                  <br />
                  Detect and track vehicles as they move.
                </p>
              </div>
              <ArrowUpRight size={20} />
            </button>
            <button
              className="source-option"
              onClick={() => {
                setSourceModal(false);
                setNetworkModal(true);
              }}
            >
              <span className="source-option-icon">
                <Video size={24} />
              </span>
              <div>
                <strong>Network & public cameras</strong>
                <p>
                  RTSP · ONVIF · HLS · MJPEG
                  <br />
                  Connect a public Nest feed or your IP camera.
                </p>
              </div>
              <ArrowUpRight size={20} />
            </button>
            <button
              className="source-option"
              onClick={() => fileInput.current?.click()}
            >
              <span className="source-option-icon">
                <Upload size={24} />
              </span>
              <div>
                <strong>Traffic video</strong>
                <p>
                  Analyze an MP4 or WebM from your device.
                  <br />
                  Your video stays on this device.
                </p>
              </div>
              <ArrowUpRight size={20} />
            </button>
            <button
              className="source-option"
              onClick={() => switchSource("demo")}
            >
              <span className="source-option-icon">
                <Play size={24} />
              </span>
              <div>
                <strong>Explore the demo</strong>
                <p>A simulated road to explore the workspace.</p>
              </div>
              <ArrowUpRight size={20} />
            </button>
          </div>
          <div className="modal-note">
            <ShieldCheck size={17} />
            <span>
              Camera analysis runs locally. The detector downloads on first use.
              Network video is handled by the included local camera gateway.
            </span>
          </div>
        </Modal>
      )}
      {networkModal && (
        <Modal
          title="Bring your camera online."
          subtitle="Standard camera protocols, one monitoring workspace."
          onClose={() => setNetworkModal(false)}
        >
          <CameraConnector
            onConnect={(config) => {
              setNetworkModal(false);
              setView("overview");
              void traffic.prepareNetworkCamera(config);
            }}
          />
        </Modal>
      )}
      {countingModal && (
        <Modal
          title="Count vehicles, by direction."
          subtitle="Place a virtual line across the road."
          onClose={() => setCountingModal(null)}
          wide
        >
          <CountingLineEditor
            canvas={countingModal.canvas}
            current={traffic.countingLine}
            onSave={(line) => {
              if (!traffic.setCountingLine(line, countingModal.token)) return;
              setCountingModal(null);
              toastMsg(
                line
                  ? "Counting line saved · crossing counter reset"
                  : "Counting line disabled",
              );
            }}
          />
          {traffic.error && (
            <p className="form-error" role="alert">
              {traffic.error}
            </p>
          )}
        </Modal>
      )}
      {calibrate && (
        <CalibrationModal
          canvas={calibrate.canvas}
          current={traffic.calibration}
          demo={source === "demo"}
          onClose={() => setCalibrate(null)}
          errorMessage={traffic.error}
          onSave={(value) => {
            if (traffic.setCalibration(value, calibrate.token)) {
              setCalibrate(null);
              toastMsg("Road calibration saved for this source");
            }
          }}
          onClear={
            traffic.calibration
              ? () => {
                  traffic.setCalibration(null);
                  setCalibrate(null);
                }
              : undefined
          }
        />
      )}
      {selected && (
        <Modal
          title={`${titleCase(selected.className)} · Track #${String(selected.id).padStart(3, "0")}`}
          subtitle={
            source === "demo"
              ? "Simulated observation · Demo workspace"
              : "Current session observation"
          }
          onClose={() => setSelected(null)}
        >
          {selected.evidence ? (
            <img
              className="evidence-image"
              src={selected.evidence}
              alt={`Evidence capture of vehicle ${selected.id}`}
            />
          ) : (
            <div className="observation-illustration">
              <CarFront size={70} />
              <span>No speeding capture for this track</span>
            </div>
          )}
          <div className="detail-grid">
            <div>
              <span>Peak speed</span>
              <strong>
                {selected.speed === null
                  ? missingSpeed(selected)
                  : formatSpeed(selected.speed, traffic.speedUnit)}
              </strong>
            </div>
            <div>
              <span>Detection confidence</span>
              <strong>{Math.round(selected.confidence * 100)}%</strong>
            </div>
            <div>
              <span>First observed</span>
              <strong className="mono">{fmtTime(selected.time)}</strong>
            </div>
            <div>
              <span>Capture policy</span>
              <strong>
                {formatSpeed(
                  selected.speedLimit ?? traffic.limit,
                  traffic.speedUnit,
                )}
              </strong>
            </div>
          </div>
          <div className="modal-note">
            <ShieldCheck size={17} />
            <span>
              {source === "demo"
                ? "Demo observations and speeds are simulated. Connect a camera to begin actual detection."
                : "Object classification is model-estimated. Vehicle identity and registration require verification."}
            </span>
          </div>
          {source !== "demo" && selected.className !== "person" && (
            <>
              <button
                className="button secondary full-width"
                disabled={
                  !traffic.inspectableEventIds.includes(selected.eventId)
                }
                onClick={() => {
                  try {
                    const inspection = traffic.inspectVehicle(
                      selected.id,
                      selected.eventId,
                    );
                    if (!inspection) {
                      toastMsg(
                        "This vehicle is no longer in the latest analyzed frame. Select a current vehicle to inspect.",
                      );
                      return;
                    }
                    setSelected(null);
                    setVehicleInspection(inspection);
                  } catch (error) {
                    toastMsg(
                      error instanceof Error
                        ? error.message
                        : "The vehicle frame could not be captured.",
                    );
                  }
                }}
              >
                Inspect vehicle <Focus size={16} />
              </button>
              <p className="form-help">
                {traffic.inspectableEventIds.includes(selected.eventId)
                  ? "Freeze the latest analyzed frame to inspect this vehicle while monitoring continues."
                  : "Inspection is available only while this vehicle is present in a freshly analyzed frame."}
              </p>
            </>
          )}
          {selected.evidence && (
            <button
              className="button secondary full-width"
              onClick={() => {
                const a = document.createElement("a");
                a.href = selected.evidence!;
                a.download = `traffic-control-track-${selected.id}.jpg`;
                a.click();
              }}
            >
              Download evidence frame <Download size={15} />
            </button>
          )}
        </Modal>
      )}
      {vehicleInspection && (
        <VehicleInspector
          inspection={vehicleInspection}
          speedUnit={traffic.speedUnit}
          onClose={() => setVehicleInspection(null)}
        />
      )}
      {storedCase && (
        <Modal
          title={storedCase.id}
          subtitle="Violation evidence · Internal case review"
          onClose={() => setStoredCase(null)}
          wide
        >
          <div className="case-review-grid">
            <div>
              <img
                className="evidence-image"
                src={storedCase.evidenceUrl}
                alt="Original violation evidence"
              />
              <div className="detail-grid">
                <div>
                  <span>Estimated speed</span>
                  <strong className="orange">
                    {formatSpeed(storedCase.speedKmh, traffic.speedUnit)}
                  </strong>
                </div>
                <div>
                  <span>Recorded limit</span>
                  <strong>
                    {formatSpeed(storedCase.speedLimit, traffic.speedUnit)}
                  </strong>
                </div>
                <div>
                  <span>Processed at</span>
                  <strong className="small-value">
                    {new Date(storedCase.captureTime).toLocaleString("en-GB")}
                  </strong>
                </div>
                <div>
                  <span>Source</span>
                  <strong className="small-value">
                    {storedCase.sourceName}
                  </strong>
                </div>
              </div>
              <SpeedCalculation measurement={storedCase.speedMeasurement} />
              <div className="evidence-hash">
                <ShieldCheck size={14} />
                <span>
                  SHA-256 <code>{storedCase.evidenceSha256}</code>
                </span>
              </div>
              {storedCase.state === "draft" && (
                <PlateReader
                  key={storedCase.id}
                  imageUrl={storedCase.evidenceUrl}
                  vehicleBox={storedCase.vehicleBox}
                  onRead={(candidate) => {
                    setPlate(candidate);
                    toastMsg(
                      "Registration candidate added — verify before review",
                    );
                  }}
                />
              )}
            </div>
            <div className="review-form">
              <span
                className={`status-tag ${storedCase.state === "draft" ? "tag-warning" : "tag-neutral"}`}
              >
                {storedCase.state === "approved"
                  ? "Reviewed"
                  : titleCase(storedCase.state)}
              </span>
              <label>
                Vehicle registration
                <input
                  value={plate}
                  onChange={(e) => setPlate(e.target.value.toUpperCase())}
                  placeholder="Verify from source evidence"
                  disabled={storedCase.state !== "draft"}
                />
              </label>
              <label>
                Reviewer
                <input
                  value={reviewer}
                  onChange={(e) => setReviewer(e.target.value)}
                  placeholder="Reviewer name"
                  disabled={storedCase.state !== "draft"}
                />
              </label>
              <label>
                Review notes
                <textarea
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                  placeholder="Record verification and context…"
                  rows={4}
                  disabled={storedCase.state !== "draft"}
                />
              </label>
              {storedCase.state === "draft" && (
                <div className="review-actions">
                  <button
                    className="button primary"
                    disabled={saving}
                    onClick={() => void reviewCase("approved")}
                  >
                    <CheckCheck size={16} />
                    Mark reviewed
                  </button>
                  <button
                    className="button secondary"
                    disabled={saving}
                    onClick={() => void reviewCase("dismissed")}
                  >
                    Dismiss
                  </button>
                </div>
              )}
              <button
                className="text-button"
                onClick={() =>
                  saveFile(
                    JSON.stringify(storedCase, null, 2),
                    `${storedCase.id}.json`,
                    "application/json",
                  )
                }
              >
                Export case record <Download size={14} />
              </button>
              <button
                className="button secondary"
                onClick={() =>
                  void downloadTicketDraft(storedCase)
                    .then(() => toastMsg("Printable ticket draft exported"))
                    .catch((e) => toastMsg(e.message))
                }
              >
                <FileCheck2 size={15} />
                Printable ticket draft
              </button>
              <p className="subtle-note">
                An internal evidence record. Legal issuance and owner lookup
                require an authorized integration.
              </p>
            </div>
          </div>
        </Modal>
      )}
      {help && (
        <Modal
          title="A smarter view of traffic."
          subtitle="From camera pixels to inspectable observations."
          onClose={() => setHelp(false)}
        >
          <div className="help-steps">
            {[
              [
                "01",
                "Connect a fixed camera",
                "Choose a webcam/USB camera or local traffic video. Real vehicle detection runs on your device.",
              ],
              [
                "02",
                "Calibrate the road",
                "Place four corners on a measured rectangle on the road. Enter its true width and length in metres.",
              ],
              [
                "03",
                "Set your speed policy",
                "Choose the maximum speed. Tracked vehicles display estimated speed beside their bounding boxes.",
              ],
              [
                "04",
                "Inspect the evidence",
                "Speeding tracks create local case drafts, with a captured frame, original settings, and an audit trail.",
              ],
            ].map(([n, t, p]) => (
              <div key={n}>
                <span>{n}</span>
                <section>
                  <h3>{t}</h3>
                  <p>{p}</p>
                </section>
              </div>
            ))}
          </div>
          <div className="modal-note">
            <TriangleAlert size={18} />
            <span>
              This build estimates speed from video. Government enforcement
              requires independent accuracy validation, certified calibration,
              and jurisdiction-specific ticketing integration. Registration OCR
              assists manual verification; vehicle-owner lookup is not included.
            </span>
          </div>
        </Modal>
      )}
      {toast && (
        <div className="toast" role="status">
          <Check size={16} />
          {toast}
        </div>
      )}
    </div>
  );
}
function Metric({
  label,
  value,
  unit,
  icon,
  note,
  graph,
  trend = [],
  accent = false,
}: {
  label: string;
  value: string;
  unit?: string;
  icon: ReactNode;
  note: ReactNode;
  graph: string;
  trend?: Array<number | null>;
  accent?: boolean;
}) {
  const path = segmentedTrendPath(trend);
  return (
    <section className={`metric-card ${accent ? "accent" : ""}`}>
      <div className="metric-label">
        <span>{label}</span>
        {icon}
      </div>
      <div className="metric-main">
        <strong
          style={
            value.length > 8
              ? { fontSize: 16, letterSpacing: "-.2px", lineHeight: 1.5 }
              : undefined
          }
        >
          {value}
        </strong>
        {unit && <span>{unit}</span>}
        <svg
          viewBox="0 0 90 35"
          className={`sparkline spark-${graph}`}
          aria-hidden="true"
        >
          <path d={path} fill="none" stroke="currentColor" strokeWidth="1.5" />
        </svg>
      </div>
      <div className="metric-note">{note}</div>
    </section>
  );
}
function EmptyState({ title, text }: { title: string; text: string }) {
  return (
    <div className="empty-state">
      <div>
        <ScanLine size={30} />
      </div>
      <h3>{title}</h3>
      <p>{text}</p>
    </div>
  );
}
function donutGradient(classes: Record<string, number>) {
  const colors = ["#d4f296", "#81958a", "#b9cad2", "#efb985", "#727ba3"];
  const entries = ["car", "truck", "bus", "motorcycle", "bicycle"];
  const total = entries.reduce((n, k) => n + (classes[k] || 0), 0);
  if (!total) return "#283235";
  let sum = 0;
  return `conic-gradient(${entries
    .map((k, i) => {
      const start = sum;
      sum += ((classes[k] || 0) / total) * 100;
      return `${colors[i]} ${start}% ${sum}%`;
    })
    .join(",")})`;
}
