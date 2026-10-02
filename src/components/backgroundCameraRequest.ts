import type {
  BackgroundCameraConfig,
  MonitorStatus,
} from "./backgroundMonitorClient";
export interface MonitorCameraRequest {
  id: string;
  config: BackgroundCameraConfig;
  expectedSessionId: string | null;
}
export const monitorIsActive = (status: MonitorStatus | null) =>
  !!status &&
  ["starting", "running", "stalled", "reconnecting", "stopping"].includes(
    status.state,
  );
export async function applyCameraRequest(
  request: MonitorCameraRequest,
  {
    current,
    stop,
    start,
    isMounted,
  }: {
    current: () => MonitorStatus | null;
    stop: (sessionId: string) => Promise<boolean>;
    start: (camera: BackgroundCameraConfig) => Promise<boolean>;
    isMounted: () => boolean;
  },
) {
  const before = current();
  if (!isMounted() || !before) return false;
  if (monitorIsActive(before) && before.trafficCameraId === request.id)
    return true;
  const activeId = monitorIsActive(before) ? before.sessionId : null;
  if (activeId !== request.expectedSessionId || before.state === "stopping")
    throw new Error(
      "Monitoring changed while you selected this camera. Review the current source and try again.",
    );
  if (activeId) {
    if (!(await stop(activeId)) || !isMounted()) return false;
    const after = current();
    if (!after || monitorIsActive(after) || after.sessionId !== activeId)
      throw new Error(
        "The previous camera has not stopped. The selected camera was not started.",
      );
  }
  if (!isMounted()) return false;
  return start(request.config);
}
