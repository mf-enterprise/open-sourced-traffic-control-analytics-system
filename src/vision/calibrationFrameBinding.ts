import { createCameraReference, type CameraReference } from "./cameraStability";
import type { Detection } from "./types";
type FrameContext = {
  epoch: number;
  revision: number;
  at: number;
};
type ResolveContext = FrameContext & {
  width: number;
  height: number;
};
const MAX_FRAME_AGE_MS = 3000;
const MAX_EDITOR_AGE_MS = 120000;
function validContext(context: FrameContext): boolean {
  return (
    Number.isSafeInteger(context.epoch) &&
    context.epoch >= 0 &&
    Number.isSafeInteger(context.revision) &&
    context.revision >= 0 &&
    Number.isFinite(context.at) &&
    context.at >= 0
  );
}
function validSize(width: number, height: number): boolean {
  return (
    Number.isSafeInteger(width) &&
    Number.isSafeInteger(height) &&
    width > 0 &&
    height > 0 &&
    Number.isSafeInteger(width * height * 4)
  );
}
export class CalibrationFrameBinding {
  private latest: {
    canvas: HTMLCanvasElement;
    detections: Detection[];
    width: number;
    height: number;
    context: FrameContext;
  } | null = null;
  private pending: {
    reference: CameraReference;
    canvas: HTMLCanvasElement;
    token: string;
    width: number;
    height: number;
    context: FrameContext;
  } | null = null;
  retain(
    canvas: HTMLCanvasElement,
    detections: readonly Detection[],
    context: FrameContext,
  ): void {
    this.latest = {
      canvas,
      detections: detections.map((detection) => ({
        ...detection,
        bbox: [...detection.bbox],
      })),
      width: canvas.width,
      height: canvas.height,
      context: { ...context },
    };
  }
  prepare(context: FrameContext): {
    canvas: HTMLCanvasElement;
    token: string;
  } {
    this.pending = null;
    const latest = this.latest;
    if (
      !latest ||
      !validContext(context) ||
      !validContext(latest.context) ||
      latest.context.epoch !== context.epoch ||
      latest.context.revision !== context.revision ||
      context.at < latest.context.at ||
      context.at - latest.context.at > MAX_FRAME_AGE_MS
    )
      throw new Error(
        "Wait for a freshly analyzed camera frame, then reopen calibration.",
      );
    const { canvas, width, height } = latest;
    if (
      !validSize(width, height) ||
      canvas.width !== width ||
      canvas.height !== height
    )
      throw new Error(
        "The calibration frame dimensions changed. Reopen calibration on a fresh frame.",
      );
    let reference: CameraReference | null;
    try {
      const pixels = canvas.getContext("2d")?.getImageData(0, 0, width, height);
      if (!pixels || pixels.width !== width || pixels.height !== height)
        throw new Error("Frame pixels unavailable.");
      reference = createCameraReference(
        { data: pixels.data, width, height, channels: 4 },
        latest.detections,
      );
    } catch {
      throw new Error(
        "The frozen camera frame could not be read. Wait for a new frame and reopen calibration.",
      );
    }
    if (!reference)
      throw new Error(
        "This frame has insufficient visible static detail. Wait for a clearer view and reopen calibration.",
      );
    const token = crypto.randomUUID();
    this.pending = {
      reference,
      canvas,
      token,
      width,
      height,
      context: { ...context },
    };
    return { canvas, token };
  }
  resolve(token: string, context: ResolveContext): CameraReference {
    const pending = this.pending;
    if (
      !pending ||
      token !== pending.token ||
      !validContext(context) ||
      context.epoch !== pending.context.epoch ||
      context.revision !== pending.context.revision ||
      context.at < pending.context.at ||
      context.at - pending.context.at > MAX_EDITOR_AGE_MS ||
      !validSize(context.width, context.height) ||
      context.width !== pending.width ||
      context.height !== pending.height ||
      pending.canvas.width !== pending.width ||
      pending.canvas.height !== pending.height
    )
      throw new Error(
        "This calibration frame is no longer current. Reopen calibration for the current source.",
      );
    this.pending = null;
    return pending.reference;
  }
  invalidateLatest(): void {
    this.latest = null;
  }
  clear(): void {
    this.latest = null;
    this.pending = null;
  }
}
