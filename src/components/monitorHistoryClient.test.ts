import { describe, expect, it, vi } from "vitest";
import {
  emptyMonitorHistory,
  historyPageOverlaps,
  historyStateLabel,
  mergeMonitorHistory,
  requestHistoryPage,
  type SavedMonitorSession,
} from "./monitorHistoryClient";
function session(
  sequence: number,
  savedAt = "2026-10-02T12:00:00.000Z",
  total = 4,
): SavedMonitorSession {
  return {
    sequence,
    sessionId: `session-${sequence}`,
    savedAt,
    endedAt: null,
    interrupted: false,
    reason: "checkpoint",
    state: "running",
    message: "",
    sourceName: "Road camera",
    sourceType: "nest",
    startedAt: savedAt,
    lastFrameAt: savedAt,
    engine: null,
    error: null,
    config: {
      revision: 1,
      speedLimitKmh: 60,
      calibration: null,
      countingLine: null,
      referenceFrame: null,
    },
    stats: {
      observed: 10,
      active: 1,
      framesProcessed: 100,
      framesDropped: 0,
      analysisFps: 10,
      crossings: {
        total,
        forward: 3,
        reverse: total - 3,
        classes: { car: total, truck: 0, bus: 0, motorcycle: 0, bicycle: 0 },
      },
      casesCreated: 0,
      pendingCases: 0,
      elapsedSeconds: 10,
      gapCount: 0,
    },
  };
}
describe("saved monitoring history pagination", () => {
  it("keeps server sequence order and loaded older rows when the head refreshes", () => {
    let state = mergeMonitorHistory(
      emptyMonitorHistory(),
      { sessions: [session(5), session(4)], total: 5, nextCursor: 4 },
      "refresh",
    );
    state = mergeMonitorHistory(
      state,
      { sessions: [session(3), session(2)], total: 5, nextCursor: 2 },
      "older",
    );
    state = mergeMonitorHistory(
      state,
      { sessions: [session(6), session(5)], total: 6, nextCursor: 5 },
      "refresh",
    );
    expect(state.sessions.map((entry) => entry.sequence)).toEqual([
      6, 5, 4, 3, 2,
    ]);
    expect(state.nextCursor).toBe(2);
    expect(state.total).toBe(6);
  });
  it("accepts authoritative higher counts after a UTC clock rollback and deduplicates overlapping pages", () => {
    const beforeRollback = session(3, "2026-10-02T12:01:00.000Z", 4);
    const afterRollback = session(3, "2026-10-02T12:00:00.000Z", 9);
    let state = mergeMonitorHistory(
      emptyMonitorHistory(),
      { sessions: [beforeRollback, session(2)], total: 3, nextCursor: 2 },
      "refresh",
    );
    state = mergeMonitorHistory(
      state,
      {
        sessions: [afterRollback, session(2), session(1)],
        total: 3,
        nextCursor: null,
      },
      "older",
    );
    expect(state.sessions.map((entry) => entry.sequence)).toEqual([3, 2, 1]);
    expect(state.sessions[0]).toEqual(afterRollback);
    expect(state.sessions[0].stats.crossings.total).toBe(9);
    expect(state.nextCursor).toBeNull();
  });
  it("applies a terminal-save retry without changing stable session order", () => {
    const original = session(2);
    const ended = {
      ...original,
      savedAt: "2026-10-02T12:03:00.000Z",
      endedAt: "2026-10-02T12:02:00.000Z",
      state: "stopped" as const,
    };
    const state = mergeMonitorHistory(
      mergeMonitorHistory(
        emptyMonitorHistory(),
        { sessions: [original, session(1)], total: 2, nextCursor: null },
        "refresh",
      ),
      { sessions: [ended], total: 2, nextCursor: 2 },
      "refresh",
    );
    expect(state.sessions[0]).toEqual(ended);
    expect(state.nextCursor).toBeNull();
  });
  it("bridges a refreshed head with no overlap before joining older loaded sessions", () => {
    const known = [session(4), session(3)];
    let state = mergeMonitorHistory(
      emptyMonitorHistory(),
      { sessions: known, total: 4, nextCursor: 3 },
      "refresh",
    );
    const head = {
      sessions: [session(8), session(7)],
      total: 8,
      nextCursor: 7,
    };
    const bridge = {
      sessions: [session(6), session(5)],
      total: 8,
      nextCursor: 5,
    };
    const joined = {
      sessions: [session(4), session(3)],
      total: 8,
      nextCursor: 3,
    };
    expect(historyPageOverlaps(known, head)).toBe(false);
    expect(historyPageOverlaps(known, bridge)).toBe(false);
    expect(historyPageOverlaps(known, joined)).toBe(true);
    for (const page of [head, bridge, joined])
      state = mergeMonitorHistory(state, page, "refresh");
    expect(state.sessions.map((entry) => entry.sequence)).toEqual([
      8, 7, 6, 5, 4, 3,
    ]);
    expect(state.nextCursor).toBe(3);
  });
  it("restores pagination when a previously empty archive gains sessions", () => {
    const empty = mergeMonitorHistory(
      emptyMonitorHistory(),
      { sessions: [], total: 0, nextCursor: null },
      "refresh",
    );
    const state = mergeMonitorHistory(
      empty,
      { sessions: [session(2)], total: 2, nextCursor: 2 },
      "refresh",
    );
    expect(state.nextCursor).toBe(2);
  });
  it("labels interrupted and ended snapshots without suggesting they are live", () => {
    expect(historyStateLabel({ ...session(1), interrupted: true })).toBe(
      "Interrupted",
    );
    expect(
      historyStateLabel({ ...session(1), endedAt: "2026-10-02T13:00:00Z" }),
    ).toBe("Ended");
    expect(historyStateLabel(session(1))).toBe("Saved · running");
  });
  it("rejects a non-advancing cursor rather than repeatedly fetching the same page", async () => {
    const fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ sessions: [session(4)], total: 8, nextCursor: 5 }),
    });
    vi.stubGlobal("fetch", fetch);
    try {
      await expect(
        requestHistoryPage(new AbortController().signal, 5),
      ).rejects.toThrow("invalid page");
      expect(fetch.mock.calls[0][0]).toBe(
        "/api/monitor/history?limit=20&before=5",
      );
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
