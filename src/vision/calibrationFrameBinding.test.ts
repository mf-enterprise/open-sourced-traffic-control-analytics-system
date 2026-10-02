import { describe, expect, it, vi } from "vitest";
import { CalibrationFrameBinding } from "./calibrationFrameBinding";
import { assessCameraStability } from "./cameraStability";
import type { Detection } from "./types";
const width = 192;
const height = 128;
const context = { epoch: 2, revision: 7, at: 1000 };
const resolveContext = { ...context, width, height };
function textured(seed = 1) {
  const data = new Uint8ClampedArray(width * height * 4);
  let state = seed;
  for (let i = 0; i < data.length; i += 4) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    data[i] = data[i + 1] = data[i + 2] = state >>> 24;
    data[i + 3] = 255;
  }
  return { data, width, height, channels: 4 as const };
}
function canvasFor(frame = textured()) {
  const getImageData = vi.fn(() => ({
    data: new Uint8ClampedArray(frame.data),
    width: frame.width,
    height: frame.height,
  }));
  const canvas = {
    width: frame.width,
    height: frame.height,
    getContext: vi.fn(() => ({ getImageData })),
  } as unknown as HTMLCanvasElement;
  return { canvas, getImageData, frame };
}
function prepared() {
  const binding = new CalibrationFrameBinding();
  const raw = canvasFor();
  binding.retain(raw.canvas, [], context);
  const editor = binding.prepare(context);
  return { binding, raw, editor };
}
describe("frozen foreground calibration binding", () => {
  it("binds the preview and reference to the old raw frame while live analysis advances", () => {
    const { binding, raw, editor } = prepared();
    expect(editor.canvas).toBe(raw.canvas);
    expect(raw.getImageData).toHaveBeenCalledExactlyOnceWith(
      0,
      0,
      width,
      height,
    );
    const next = canvasFor(textured(2));
    binding.retain(next.canvas, [], { ...context, at: 1100 });
    const reference = binding.resolve(editor.token, {
      ...resolveContext,
      at: 1200,
    });
    expect(next.getImageData).not.toHaveBeenCalled();
    expect(assessCameraStability(reference, raw.frame, []).state).toBe(
      "stable",
    );
    expect(assessCameraStability(reference, next.frame, []).state).not.toBe(
      "stable",
    );
    expect(() => binding.resolve(editor.token, resolveContext)).toThrow(
      /reopen/i,
    );
  });
  it("requires a matching recent analyzed frame, including exact freshness boundary", () => {
    const binding = new CalibrationFrameBinding();
    expect(() => binding.prepare(context)).toThrow(/freshly analyzed/i);
    const raw = canvasFor();
    binding.retain(raw.canvas, [], context);
    expect(() => binding.prepare({ ...context, epoch: 3 })).toThrow();
    expect(() => binding.prepare({ ...context, revision: 8 })).toThrow();
    expect(() => binding.prepare({ ...context, at: 999 })).toThrow();
    expect(() => binding.prepare({ ...context, at: 4001 })).toThrow();
    expect(binding.prepare({ ...context, at: 4000 }).canvas).toBe(raw.canvas);
  });
  it("rejects source changes, geometry changes, invalid time and editor expiry", () => {
    for (const patch of [
      { epoch: 3 },
      { revision: 8 },
      { at: 999 },
      { at: Number.NaN },
      { at: 121001 },
      { width: 1280 },
      { height: 0 },
    ]) {
      const { binding, editor } = prepared();
      expect(() =>
        binding.resolve(editor.token, { ...resolveContext, ...patch }),
      ).toThrow(/no longer current/i);
    }
    const { binding, editor } = prepared();
    expect(
      binding.resolve(editor.token, { ...resolveContext, at: 121000 }),
    ).toBeTruthy();
  });
  it("supersedes previous editors and consumes only the successfully resolved token", () => {
    const { binding, editor } = prepared();
    const second = binding.prepare({ ...context, at: 1100 });
    expect(second.token).not.toBe(editor.token);
    expect(() => binding.resolve(editor.token, resolveContext)).toThrow();
    expect(() => binding.resolve("unknown", resolveContext)).toThrow();
    expect(
      binding.resolve(second.token, { ...resolveContext, at: 1200 }),
    ).toBeTruthy();
  });
  it("rejects resized owned canvases both before preparation and before saving", () => {
    const first = prepared();
    first.raw.canvas.width = width + 1;
    expect(() =>
      first.binding.resolve(first.editor.token, resolveContext),
    ).toThrow();
    const second = prepared();
    second.raw.canvas.height = height + 1;
    expect(() => second.binding.prepare(context)).toThrow(/dimensions/i);
  });
  it("keeps pending reference through latest-frame invalidation but respects revision changes", () => {
    const { binding, editor } = prepared();
    binding.invalidateLatest();
    expect(() => binding.prepare(context)).toThrow(/freshly analyzed/i);
    expect(() => binding.resolve(editor.token, resolveContext)).toThrow();
    const second = prepared();
    second.binding.invalidateLatest();
    expect(() =>
      second.binding.resolve(second.editor.token, {
        ...resolveContext,
        revision: 8,
      }),
    ).toThrow();
    expect(
      second.binding.resolve(second.editor.token, resolveContext),
    ).toBeTruthy();
  });
  it("clear removes both retained frames and outstanding editor tokens", () => {
    const { binding, editor } = prepared();
    binding.clear();
    expect(() => binding.resolve(editor.token, resolveContext)).toThrow();
    expect(() => binding.prepare(context)).toThrow();
  });
  it("copies detection masks and source metadata instead of retaining mutable caller records", () => {
    const binding = new CalibrationFrameBinding();
    const raw = canvasFor();
    const capturedContext = { ...context };
    const detection: Detection = {
      bbox: [0, 0, width, height],
      className: "bus",
      score: 0.99,
    };
    binding.retain(raw.canvas, [detection], capturedContext);
    detection.bbox[2] = 0;
    capturedContext.epoch = 20;
    expect(() => binding.prepare(context)).toThrow(/static detail/i);
  });
  it("fails closed when pixels are inaccessible or static reference creation fails", () => {
    const { binding, raw } = prepared();
    raw.getImageData.mockImplementation(() => {
      throw new Error("tainted canvas");
    });
    expect(() => binding.prepare(context)).toThrow(/could not be read/i);
    const blank = textured();
    blank.data.fill(0);
    const flat = canvasFor(blank);
    binding.retain(flat.canvas, [], context);
    expect(() => binding.prepare(context)).toThrow(/static detail/i);
  });
});
