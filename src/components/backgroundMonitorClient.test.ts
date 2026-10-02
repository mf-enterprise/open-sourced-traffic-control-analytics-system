import { describe, expect, it, vi } from "vitest";
import {
  MonitorFrameSequence,
  type MonitorFrame,
} from "./backgroundMonitorClient";
const frame = (sessionId: string, frameId: number): MonitorFrame => ({
  sessionId,
  frameId,
  width: 1280,
  height: 720,
  sourceTimestamp: frameId / 10,
  captureTime: "2026-10-02T10:00:00.000Z",
  processedAt: "2026-10-02T10:00:00.100Z",
  jpeg: `image-${sessionId}-${frameId}`,
  tracks: [],
  configRevision: 3,
  speedLimitKmh: 60,
  calibration: null,
  countingLine: null,
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
describe("synchronized server frame publication", () => {
  it("publishes image and its original metadata together only after decoding", async () => {
    const sequence = new MonitorFrameSequence<string>();
    sequence.setSession("a");
    const decoded = deferred<string>();
    const bundle = frame("a", 5);
    const pending = sequence.decode(bundle, () => decoded.promise);
    expect(sequence.after).toBe(-1);
    decoded.resolve("decoded-a-5");
    expect(await pending).toEqual({ bundle, image: "decoded-a-5" });
    expect(sequence.after).toBe(5);
  });
  it("drops a previous session's late decode even when the new session reuses frame IDs", async () => {
    const sequence = new MonitorFrameSequence<string>();
    sequence.setSession("a");
    const oldImage = deferred<string>();
    const old = sequence.decode(frame("a", 20), () => oldImage.promise);
    sequence.setSession("b");
    const current = await sequence.decode(frame("b", 1), async () => "new");
    oldImage.resolve("old");
    expect(await old).toBeNull();
    expect(current?.image).toBe("new");
    expect(sequence.after).toBe(1);
  });
  it("never regresses the displayed frame when image decodes finish out of order", async () => {
    const sequence = new MonitorFrameSequence<string>();
    sequence.setSession("a");
    const slow = deferred<string>();
    const previous = sequence.decode(frame("a", 10), () => slow.promise);
    expect(
      (await sequence.decode(frame("a", 11), async () => "latest"))?.bundle
        .frameId,
    ).toBe(11);
    slow.resolve("earlier");
    expect(await previous).toBeNull();
    expect(sequence.after).toBe(11);
  });
  it("does not decode duplicate frames or frames for another camera", async () => {
    const sequence = new MonitorFrameSequence<string>();
    sequence.setSession("a");
    const decode = vi.fn(async () => "image");
    await sequence.decode(frame("a", 2), decode);
    expect(await sequence.decode(frame("a", 2), decode)).toBeNull();
    expect(await sequence.decode(frame("a", 1), decode)).toBeNull();
    expect(await sequence.decode(frame("b", 3), decode)).toBeNull();
    expect(decode).toHaveBeenCalledTimes(1);
  });
  it("invalidates a pending decode on disposal, including reopening the same server session", async () => {
    const sequence = new MonitorFrameSequence<string>();
    sequence.setSession("a");
    const slow = deferred<string>();
    const previous = sequence.decode(frame("a", 5), () => slow.promise);
    sequence.dispose();
    sequence.setSession("a");
    slow.resolve("old-view");
    expect(await previous).toBeNull();
    expect(sequence.after).toBe(-1);
    expect(
      (await sequence.decode(frame("a", 6), async () => "current-view"))?.image,
    ).toBe("current-view");
  });
  it("preserves the last usable frame cursor when decoding fails so the image can be retried", async () => {
    const sequence = new MonitorFrameSequence<string>();
    sequence.setSession("a");
    await sequence.decode(frame("a", 4), async () => "usable");
    await expect(
      sequence.decode(frame("a", 5), async () => {
        throw new Error("decode failed");
      }),
    ).rejects.toThrow("decode failed");
    expect(sequence.after).toBe(4);
    expect(
      (await sequence.decode(frame("a", 5), async () => "recovered"))?.image,
    ).toBe("recovered");
  });
});
