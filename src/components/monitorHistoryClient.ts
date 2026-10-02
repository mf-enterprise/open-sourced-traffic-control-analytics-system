import { monitorRequest, type MonitorStatus } from "./backgroundMonitorClient";
export interface SavedMonitorSession extends Omit<MonitorStatus, "sessionId"> {
  sessionId: string;
  savedAt: string;
  endedAt: string | null;
  interrupted: boolean;
  sequence: number;
  reason: string;
}
export interface MonitorHistoryPage {
  sessions: SavedMonitorSession[];
  total: number;
  nextCursor: number | null;
}
export interface MonitorHistoryDetail {
  session: SavedMonitorSession;
  revisions: SavedMonitorSession[];
}
export interface MonitorHistoryState extends MonitorHistoryPage {
  loaded: boolean;
}
export const emptyMonitorHistory = (): MonitorHistoryState => ({
  sessions: [],
  total: 0,
  nextCursor: null,
  loaded: false,
});
export function mergeMonitorHistory(
  current: MonitorHistoryState,
  page: MonitorHistoryPage,
  mode: "refresh" | "older",
): MonitorHistoryState {
  const entries = new Map(
    current.sessions.map((entry) => [entry.sessionId, entry]),
  );
  for (const entry of page.sessions) {
    entries.set(entry.sessionId, entry);
  }
  return {
    sessions: [...entries.values()].sort((a, b) => b.sequence - a.sequence),
    total: page.total,
    nextCursor:
      mode === "older" || !current.sessions.length
        ? page.nextCursor
        : current.nextCursor,
    loaded: true,
  };
}
export function historyPageOverlaps(
  known: SavedMonitorSession[],
  page: MonitorHistoryPage,
): boolean {
  const ids = new Set(known.map((entry) => entry.sessionId));
  return page.sessions.some((entry) => ids.has(entry.sessionId));
}
export async function requestHistoryPage(
  signal: AbortSignal,
  before?: number,
): Promise<MonitorHistoryPage> {
  const page = await monitorRequest<MonitorHistoryPage>(
    `/history?limit=20${before === undefined ? "" : `&before=${before}`}`,
    signal,
  );
  if (
    !Array.isArray(page.sessions) ||
    !Number.isSafeInteger(page.total) ||
    page.total < 0 ||
    page.sessions.some(
      (entry) =>
        !entry.sessionId ||
        !Number.isSafeInteger(entry.sequence) ||
        entry.sequence < 1 ||
        !Number.isFinite(Date.parse(entry.savedAt)) ||
        (before !== undefined && entry.sequence >= before),
    ) ||
    (page.nextCursor !== null &&
      (!Number.isSafeInteger(page.nextCursor) ||
        page.nextCursor < 1 ||
        !page.sessions.length ||
        (before !== undefined && page.nextCursor >= before)))
  )
    throw new Error(
      "Saved session history returned an invalid page. Please retry.",
    );
  return page;
}
export function historyStateLabel(session: SavedMonitorSession) {
  if (session.interrupted) return "Interrupted";
  if (session.endedAt || session.state === "stopped")
    return session.state === "error" ? "Ended with error" : "Ended";
  return `Saved · ${session.state}`;
}
