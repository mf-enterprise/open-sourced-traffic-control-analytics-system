import { useCallback, useEffect, useRef, useState } from "react";
import {
  Archive,
  ArrowDownUp,
  ChevronDown,
  Download,
  History,
  LoaderCircle,
  RefreshCw,
  TriangleAlert,
} from "lucide-react";
import { formatSpeed, type SpeedUnit } from "../units";
import { monitorRequest } from "./backgroundMonitorClient";
import {
  emptyMonitorHistory,
  historyPageOverlaps,
  historyStateLabel,
  mergeMonitorHistory,
  requestHistoryPage,
  type MonitorHistoryDetail,
  type SavedMonitorSession,
} from "./monitorHistoryClient";
import "./monitor-history.css";
const messageOf = (error: unknown) =>
  error instanceof Error
    ? error.message
    : "Saved sessions could not be loaded. Please retry.";
const dateLabel = (value: string | null, seconds = false) => {
  if (!value || !Number.isFinite(Date.parse(value))) return "Time unavailable";
  return new Date(value).toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    ...(seconds ? { second: "2-digit" } : {}),
  });
};
const count = (value: number) => value.toLocaleString();
function HistoryDetail({
  entry,
  speedUnit,
  visible,
}: {
  entry: SavedMonitorSession;
  speedUnit: SpeedUnit;
  visible: boolean;
}) {
  const [detail, setDetail] = useState<MonitorHistoryDetail | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    if (!visible) return;
    const controller = new AbortController();
    let disposed = false;
    setLoading(true);
    setError("");
    void monitorRequest<MonitorHistoryDetail>(
      `/history/${encodeURIComponent(entry.sessionId)}`,
      controller.signal,
    )
      .then((result) => {
        if (disposed || controller.signal.aborted) return;
        if (
          result.session?.sessionId !== entry.sessionId ||
          !Array.isArray(result.revisions) ||
          result.revisions.some(
            (revision) => revision.sessionId !== entry.sessionId,
          )
        )
          throw new Error(
            "The saved session details did not match this session. Please retry.",
          );
        setDetail(result);
      })
      .catch((failure) => {
        if (!disposed && !controller.signal.aborted)
          setError(messageOf(failure));
      })
      .finally(() => {
        if (!disposed) setLoading(false);
      });
    return () => {
      disposed = true;
      controller.abort();
    };
  }, [entry.sessionId, entry.savedAt, retry, visible]);
  function download() {
    if (!detail) return;
    const payload = {
      exportedAt: new Date().toISOString(),
      countInterpretation:
        "Each snapshot contains counts for its latest configured line. Counts carry across speed-limit changes. Revision counts overlap and must not be summed. Analysis gaps may miss crossings; these are observed counts, not a validation of full traffic accuracy.",
      ...detail,
    };
    const url = URL.createObjectURL(
      new Blob([JSON.stringify(payload, null, 2)], {
        type: "application/json",
      }),
    );
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `traffic-control-session-${entry.sessionId}.json`;
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  return (
    <div
      className="monitor-history-detail"
      id={`saved-session-${entry.sessionId}`}
    >
      <div className="monitor-history-detail-heading">
        <div>
          <strong>Configuration revisions</strong>
          <span>Session {entry.sessionId}</span>
        </div>
        <button
          className="button secondary"
          disabled={!detail || loading}
          onClick={download}
        >
          <Download size={14} /> Download session JSON
        </button>
      </div>
      <p className="monitor-history-interpretation">
        Each snapshot shows counts for its latest configured line. A new line
        resets counts; a speed-limit change carries them forward. Revision
        counts overlap and must not be added together.
      </p>
      {error && (
        <div className="monitor-history-error" role="alert">
          <TriangleAlert size={15} />
          <span>{error}</span>
          <button onClick={() => setRetry((value) => value + 1)}>
            Retry details
          </button>
        </div>
      )}
      {loading && (
        <p className="monitor-history-loading" role="status">
          <LoaderCircle size={14} className="monitor-history-spinner" />{" "}
          {detail ? "Refreshing saved revisions…" : "Loading saved revisions…"}
        </p>
      )}
      {detail && (
        <>
          <div className="monitor-history-summary">
            <span>
              Last saved{" "}
              <strong>{dateLabel(detail.session.savedAt, true)}</strong>
            </span>
            <span>
              Analyzed frames{" "}
              <strong>{count(detail.session.stats.framesProcessed)}</strong>
            </span>
            <span>
              Analysis gaps{" "}
              <strong>{count(detail.session.stats.gapCount)}</strong>
            </span>
            <span>
              Evidence drafts{" "}
              <strong>{count(detail.session.stats.casesCreated)}</strong>
            </span>
          </div>
          {detail.revisions.length ? (
            <div className="monitor-history-table-wrap">
              <table>
                <thead>
                  <tr>
                    <th scope="col">Revision / saved</th>
                    <th scope="col">Counting line</th>
                    <th scope="col">Crossings</th>
                    <th scope="col">Forward / reverse</th>
                    <th scope="col">Speed limit</th>
                  </tr>
                </thead>
                <tbody>
                  {detail.revisions.map((revision, index) => (
                    <tr
                      key={`${revision.config.revision}:${revision.sequence}:${revision.savedAt}:${index}`}
                    >
                      <td>
                        <strong>r{revision.config.revision}</strong>
                        <span>{dateLabel(revision.savedAt, true)}</span>
                      </td>
                      <td>
                        <span
                          className={`monitor-history-line ${revision.config.countingLine ? "is-configured" : ""}`}
                        >
                          {revision.config.countingLine
                            ? "Configured"
                            : "Not set"}
                        </span>
                      </td>
                      <td>
                        {revision.config.countingLine
                          ? count(revision.stats.crossings.total)
                          : "—"}
                      </td>
                      <td>
                        {revision.config.countingLine
                          ? `${count(revision.stats.crossings.forward)} / ${count(revision.stats.crossings.reverse)}`
                          : "—"}
                      </td>
                      <td>
                        {formatSpeed(revision.config.speedLimitKmh, speedUnit)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="monitor-history-interpretation">
              No configuration revisions were saved for this session.
            </p>
          )}
        </>
      )}
    </div>
  );
}
export default function MonitorHistory({
  speedUnit,
}: {
  speedUnit: SpeedUnit;
}) {
  const [history, setHistory] = useState(emptyMonitorHistory);
  const historyRef = useRef(history);
  const [pending, setPending] = useState<"refresh" | "older" | null>(null);
  const [error, setError] = useState("");
  const [failedAction, setFailedAction] = useState<"refresh" | "older">(
    "refresh",
  );
  const [expanded, setExpanded] = useState<string | null>(null);
  const [visible, setVisible] = useState(
    () => document.visibilityState !== "hidden",
  );
  const mounted = useRef(false);
  const request = useRef<AbortController | null>(null);
  const load = useCallback(async (mode: "refresh" | "older") => {
    if (
      !mounted.current ||
      document.visibilityState === "hidden" ||
      request.current
    )
      return;
    const before = mode === "older" ? historyRef.current.nextCursor : undefined;
    if (before === null) return;
    const controller = new AbortController();
    request.current = controller;
    setPending(mode);
    setError("");
    const current = () =>
      mounted.current &&
      request.current === controller &&
      !controller.signal.aborted;
    try {
      const known = historyRef.current.sessions;
      let page = await requestHistoryPage(controller.signal, before);
      let result = mergeMonitorHistory(historyRef.current, page, mode);
      while (
        mode === "refresh" &&
        known.length &&
        page.nextCursor !== null &&
        !historyPageOverlaps(known, page)
      ) {
        if (!current()) return;
        page = await requestHistoryPage(controller.signal, page.nextCursor);
        result = mergeMonitorHistory(result, page, "refresh");
      }
      if (current()) {
        historyRef.current = result;
        setHistory(result);
      }
    } catch (failure) {
      if (current()) {
        setError(messageOf(failure));
        setFailedAction(mode);
      }
    } finally {
      if (request.current === controller) {
        request.current = null;
        if (mounted.current) setPending(null);
      }
    }
  }, []);
  useEffect(() => {
    mounted.current = true;
    const visibility = () => setVisible(document.visibilityState !== "hidden");
    document.addEventListener("visibilitychange", visibility);
    return () => {
      mounted.current = false;
      document.removeEventListener("visibilitychange", visibility);
      request.current?.abort();
      request.current = null;
    };
  }, []);
  useEffect(() => {
    if (!visible) {
      request.current?.abort();
      request.current = null;
      setPending(null);
      return;
    }
    void load("refresh");
    const timer = setInterval(() => void load("refresh"), 10000);
    return () => clearInterval(timer);
  }, [load, visible]);
  return (
    <section
      className="background-panel monitor-history"
      aria-labelledby="monitor-history-title"
    >
      <header>
        <div className="monitor-history-title">
          <span className="monitor-history-icon">
            <Archive size={19} />
          </span>
          <div>
            <span className="eyebrow">STORED ON THIS COMPUTER</span>
            <h2 id="monitor-history-title">
              Saved sessions{" "}
              <span className="monitor-history-count">
                {history.loaded ? count(history.total) : "—"}
              </span>
            </h2>
          </div>
        </div>
        <button
          className="button secondary"
          onClick={() => void load("refresh")}
          disabled={!!pending || !visible}
        >
          <RefreshCw
            size={14}
            className={pending === "refresh" ? "monitor-history-spinner" : ""}
          />{" "}
          Refresh
        </button>
      </header>
      <p className="monitor-history-intro">
        Saved counts and configuration snapshots survive a service restart. An
        interrupted session does not mean monitoring continued while the service
        was offline.
      </p>
      {error && (
        <div className="monitor-history-error" role="alert">
          <TriangleAlert size={15} />
          <span>
            {error}{" "}
            {history.loaded ? "Previously loaded snapshots remain below." : ""}
          </span>
          <button disabled={!!pending} onClick={() => void load(failedAction)}>
            Retry
          </button>
        </div>
      )}
      {!history.loaded && pending && (
        <div className="monitor-history-empty" role="status">
          <LoaderCircle size={22} className="monitor-history-spinner" />
          <strong>Loading saved sessions…</strong>
        </div>
      )}
      {history.loaded && !history.sessions.length && (
        <div className="monitor-history-empty">
          <History size={24} />
          <strong>No saved sessions yet.</strong>
          <span>
            Start background monitoring to preserve its counts and configuration
            history here.
          </span>
        </div>
      )}
      <div className="monitor-history-list">
        {history.sessions.map((entry) => (
          <article
            className={`monitor-history-entry ${expanded === entry.sessionId ? "is-expanded" : ""}`}
            key={entry.sessionId}
          >
            <button
              className="monitor-history-row"
              aria-expanded={expanded === entry.sessionId}
              aria-controls={`saved-session-${entry.sessionId}`}
              onClick={() =>
                setExpanded((value) =>
                  value === entry.sessionId ? null : entry.sessionId,
                )
              }
            >
              <span className="monitor-history-source">
                <strong>{entry.sourceName || "Network camera"}</strong>
                <span>
                  {entry.sourceType?.toUpperCase() || "NETWORK"} · Started{" "}
                  {dateLabel(entry.startedAt)}
                </span>
              </span>
              <span className="monitor-history-row-count">
                <strong>
                  {entry.config.countingLine
                    ? count(entry.stats.crossings.total)
                    : "—"}
                </strong>
                <span>
                  {entry.config.countingLine
                    ? "crossings · latest line"
                    : "counting line not set"}
                </span>
              </span>
              <span className="monitor-history-directions">
                <ArrowDownUp size={14} />
                <span>
                  <strong>
                    {entry.config.countingLine
                      ? `${count(entry.stats.crossings.forward)} / ${count(entry.stats.crossings.reverse)}`
                      : "—"}
                  </strong>
                  <span>forward / reverse</span>
                </span>
              </span>
              <span className="monitor-history-session-state">
                <span
                  className={`monitor-history-badge ${entry.interrupted || entry.state === "error" ? "is-warning" : ""}`}
                >
                  {historyStateLabel(entry)}
                </span>
                <span>
                  {entry.endedAt
                    ? `${entry.interrupted ? "Interruption found" : "Ended"} ${dateLabel(entry.endedAt)}`
                    : `Saved ${dateLabel(entry.savedAt)}`}
                </span>
              </span>
              <ChevronDown size={16} className="monitor-history-chevron" />
            </button>
            {expanded === entry.sessionId && (
              <HistoryDetail
                entry={entry}
                speedUnit={speedUnit}
                visible={visible}
              />
            )}
          </article>
        ))}
      </div>
      {history.loaded && (
        <footer>
          <span>
            {count(history.sessions.length)} of {count(history.total)} sessions
            · counts cover analyzed frames; gaps can miss crossings.
          </span>
          {history.nextCursor !== null && (
            <button
              className="button secondary"
              disabled={!!pending || !visible}
              onClick={() => void load("older")}
            >
              {pending === "older" && (
                <LoaderCircle size={14} className="monitor-history-spinner" />
              )}
              {pending === "older" ? "Loading older…" : "Load older"}
            </button>
          )}
        </footer>
      )}
    </section>
  );
}
