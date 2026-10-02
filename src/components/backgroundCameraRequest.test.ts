import { describe, expect, it, vi } from "vitest";
import {
  applyCameraRequest,
  type MonitorCameraRequest,
} from "./backgroundCameraRequest";
import type { MonitorStatus } from "./backgroundMonitorClient";
function status(
  state: MonitorStatus["state"],
  sessionId: string | null,
  trafficCameraId: string | null = null,
) {
  return { state, sessionId, trafficCameraId } as MonitorStatus;
}
const request: MonitorCameraRequest = {
  id: "selected",
  config: {
    type: "url",
    url: "https://example.test/selected.m3u8",
    name: "Selected camera",
  },
  expectedSessionId: "old-session",
};
describe("public camera selection", () => {
  it("waits for the previous camera to finish stopping before starting the selected camera", async () => {
    let current = status("running", "old-session", "previous");
    let release!: () => void;
    const stopped = new Promise<void>((resolve) => {
      release = resolve;
    });
    const stop = vi.fn(async () => {
      await stopped;
      current = status("stopped", "old-session", "previous");
      return true;
    });
    const start = vi.fn(async () => true);
    const result = applyCameraRequest(request, {
      current: () => current,
      stop,
      start,
      isMounted: () => true,
    });
    expect(stop).toHaveBeenCalledWith("old-session");
    expect(start).not.toHaveBeenCalled();
    release();
    expect(await result).toBe(true);
    expect(start).toHaveBeenCalledOnce();
    expect(start).toHaveBeenCalledWith(request.config);
  });
  it("does not stop or restart the selected camera when it is already active", async () => {
    const stop = vi.fn(async () => true),
      start = vi.fn(async () => true);
    expect(
      await applyCameraRequest(request, {
        current: () => status("running", "existing-session", "selected"),
        stop,
        start,
        isMounted: () => true,
      }),
    ).toBe(true);
    expect(stop).not.toHaveBeenCalled();
    expect(start).not.toHaveBeenCalled();
  });
  it("rejects a stale selection when another session started before the click was handled", async () => {
    const stop = vi.fn(async () => true),
      start = vi.fn(async () => true);
    await expect(
      applyCameraRequest(request, {
        current: () => status("running", "another-session", "another-camera"),
        stop,
        start,
        isMounted: () => true,
      }),
    ).rejects.toThrow("Monitoring changed");
    expect(stop).not.toHaveBeenCalled();
    expect(start).not.toHaveBeenCalled();
  });
  it("does not start after a failed stop", async () => {
    const start = vi.fn(async () => true);
    expect(
      await applyCameraRequest(request, {
        current: () => status("running", "old-session"),
        stop: async () => false,
        start,
        isMounted: () => true,
      }),
    ).toBe(false);
    expect(start).not.toHaveBeenCalled();
  });
  it("does not start a camera after the operator leaves the view while stop is pending", async () => {
    let mounted = true;
    const start = vi.fn(async () => true);
    expect(
      await applyCameraRequest(request, {
        current: () => status("running", "old-session"),
        stop: async () => {
          mounted = false;
          return true;
        },
        start,
        isMounted: () => mounted,
      }),
    ).toBe(false);
    expect(start).not.toHaveBeenCalled();
  });
  it.each([
    status("stopping", "old-session"),
    status("running", "replacement"),
    status("stopped", "replacement"),
  ])(
    "does not trust a stop response that leaves another session or active source",
    async (after) => {
      let current = status("running", "old-session");
      const start = vi.fn(async () => true);
      await expect(
        applyCameraRequest(request, {
          current: () => current,
          stop: async () => {
            current = after;
            return true;
          },
          start,
          isMounted: () => true,
        }),
      ).rejects.toThrow("has not stopped");
      expect(start).not.toHaveBeenCalled();
    },
  );
  it("starts from idle without a stop and returns a start failure", async () => {
    const stop = vi.fn(async () => true),
      start = vi.fn(async () => false);
    expect(
      await applyCameraRequest(
        { ...request, expectedSessionId: null },
        {
          current: () => status("idle", null),
          stop,
          start,
          isMounted: () => true,
        },
      ),
    ).toBe(false);
    expect(stop).not.toHaveBeenCalled();
    expect(start).toHaveBeenCalledOnce();
  });
  it("does not replace a camera that started after an idle selection", async () => {
    const stop = vi.fn(async () => true),
      start = vi.fn(async () => true);
    await expect(
      applyCameraRequest(
        { ...request, expectedSessionId: null },
        {
          current: () => status("running", "new-session"),
          stop,
          start,
          isMounted: () => true,
        },
      ),
    ).rejects.toThrow("Monitoring changed");
    expect(stop).not.toHaveBeenCalled();
    expect(start).not.toHaveBeenCalled();
  });
});
