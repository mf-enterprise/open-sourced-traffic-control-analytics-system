import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  downloadTicketDraft,
  renderSpeedCalculation,
  speedCalculationFields,
} from "./caseReport";
import type { StoredCase } from "./storage/useCaseStore";
import type { SpeedMeasurement } from "./vision/types";
const imageBytes = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 2, 0xff, 0xd9]);
const originalImageUrl = `data:image/jpeg;base64,${Buffer.from(imageBytes).toString("base64")}`;
const imageHash = createHash("sha256").update(imageBytes).digest("hex");
function sampleMeasurement(): SpeedMeasurement {
  return {
    method: "ground-plane-median-v2",
    samples: [
      { timeSeconds: 22.256, imagePoint: { x: 0.4, y: 0.3 } },
      { timeSeconds: 22.656, imagePoint: { x: 0.4, y: 0.4 } },
      { timeSeconds: 23.056, imagePoint: { x: 0.4, y: 0.5 } },
      { timeSeconds: 23.456, imagePoint: { x: 0.4, y: 0.6 } },
    ],
    velocityMps: { x: 0, y: 67.4 / 3.6 },
    speedKmh: 67.4,
    pairCount: 6,
  };
}
function sampleCase(): StoredCase {
  return {
    id: "VEL-2026-000042",
    clientEventId: "session-123:7",
    trackId: 7,
    sourceName: "<img src=x onerror=\"alert('source')\"> & <west>",
    sourceKind: "camera",
    className: "car",
    speedKmh: 67.4,
    speedMeasurement: sampleMeasurement(),
    speedLimit: 50,
    confidence: 0.937,
    captureTime: "2026-10-02T13:14:15.123Z",
    sourceTimestamp: 23.456,
    calibration: {
      points: [
        { x: 0.2, y: 0.2 },
        { x: 0.8, y: 0.2 },
        { x: 0.9, y: 0.9 },
        { x: 0.1, y: 0.9 },
      ],
      widthMeters: 8,
      lengthMeters: 30,
    },
    evidenceUrl: "/api/cases/VEL-2026-000042/evidence",
    evidenceSha256: imageHash,
    evidenceBytes: imageBytes.length,
    simulation: false,
    state: "draft",
    plate: "",
    reviewer: "",
    notes: "</div><script>alert(\"notes\")</script> & 'quoted'",
    createdAt: "2026-10-02T13:14:16.000Z",
    updatedAt: "2026-10-02T13:14:16.000Z",
  };
}
class BlobReader {
  result: string | null = null;
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  readAsDataURL(blob: Blob) {
    void blob
      .arrayBuffer()
      .then((bytes) => {
        this.result = `data:${blob.type};base64,${Buffer.from(bytes).toString("base64")}`;
        this.onload?.();
      })
      .catch(() => this.onerror?.());
  }
}
describe("standalone ticket draft export", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal("FileReader", BlobReader);
  });
  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });
  it("embeds exact evidence and measurements, escapes untrusted text, and labels the portable download as a draft", async () => {
    const record = sampleCase();
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        new Response(imageBytes, { headers: { "Content-Type": "image/jpeg" } }),
      );
    vi.stubGlobal("fetch", fetchMock);
    const anchor = { href: "", download: "", click: vi.fn() };
    const createElement = vi.fn().mockReturnValue(anchor);
    vi.stubGlobal("document", { createElement });
    let output: Blob | undefined;
    const createUrl = vi
      .spyOn(URL, "createObjectURL")
      .mockImplementation((blob) => {
        output = blob as Blob;
        return "blob:velocity-test-report";
      });
    const revokeUrl = vi
      .spyOn(URL, "revokeObjectURL")
      .mockImplementation(() => {});
    await downloadTicketDraft(record);
    expect(fetchMock).toHaveBeenCalledExactlyOnceWith(record.evidenceUrl);
    expect(createUrl).toHaveBeenCalledTimes(1);
    expect(output?.type).toBe("text/html;charset=utf-8");
    const html = await output!.text();
    expect(html).toMatch(/^<!doctype html>/i);
    expect(html).toContain(`src="${originalImageUrl}"`);
    expect(html).not.toContain(`src="${record.evidenceUrl}"`);
    expect(html).toContain("<span>Estimated speed</span><strong>67.4</strong>");
    expect(html).toContain(
      "<span>Recorded speed limit</span><strong>50</strong>",
    );
    expect(html).toContain(
      "<span>Above configured limit</span><strong>+17.4</strong>",
    );
    expect(html).toContain(imageHash);
    expect(html).toContain("23.456 seconds");
    expect(html).toContain("<h2>Speed calculation</h2>");
    expect(html).toContain("Recent-window vector estimate");
    expect(html).toContain("source media timeline");
    expect(html).toContain("Ground-plane median · v2");
    expect(html).toContain("22.256–23.456 s (1.200 s)");
    expect(html).toContain("<span>Observed samples</span><strong>4</strong>");
    expect(html).toContain("<span>Velocity pairs</span><strong>6</strong>");
    expect(html).not.toContain("imagePoint");
    expect(html).toContain("2026-10-02T13:14:15.123Z");
    expect(html).toContain("INTERNAL TICKET DRAFT");
    expect(html).toContain("<span>Record status</span><strong>draft</strong>");
    expect(html).toContain("not a legally issued penalty");
    expect(html).toContain("Print / Save as PDF");
    expect(html).toContain(
      "&lt;img src=x onerror=&quot;alert(&#39;source&#39;)&quot;&gt; &amp; &lt;west&gt;",
    );
    expect(html).toContain(
      "&lt;/div&gt;&lt;script&gt;alert(&quot;notes&quot;)&lt;/script&gt; &amp; &#39;quoted&#39;",
    );
    expect(html).not.toContain(record.sourceName);
    expect(html).not.toContain(record.notes);
    expect(html).not.toContain("<script>");
    expect(createElement).toHaveBeenCalledExactlyOnceWith("a");
    expect(anchor.href).toBe("blob:velocity-test-report");
    expect(anchor.download).toBe("VEL-2026-000042-ticket-draft.html");
    expect(anchor.click).toHaveBeenCalledTimes(1);
    expect(revokeUrl).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1000);
    expect(revokeUrl).toHaveBeenCalledExactlyOnceWith(
      "blob:velocity-test-report",
    );
  });
  it("distinguishes current vector-median evidence from unchanged legacy evidence", () => {
    const legacy = sampleMeasurement();
    const current: SpeedMeasurement = {
      ...sampleMeasurement(),
      method: "ground-plane-geometric-median-v3",
    };
    expect(speedCalculationFields(legacy)?.[0]).toEqual([
      "Method",
      "Ground-plane median · v2",
    ]);
    expect(speedCalculationFields(current)?.[0]).toEqual([
      "Method",
      "Ground-plane vector median · v3",
    ]);
    expect(renderSpeedCalculation(current)).toContain(
      "Ground-plane vector median · v3",
    );
    expect(renderSpeedCalculation(legacy)).not.toContain("vector median · v3");
  });
  it("labels missing legacy traces without inventing a calculation", () => {
    for (const missing of [undefined, null]) {
      expect(speedCalculationFields(missing)).toBeNull();
      const html = renderSpeedCalculation(missing);
      expect(html).toContain("<h2>Speed calculation</h2>");
      expect(html).toContain("Calculation trace unavailable");
      expect(html).not.toContain("Ground-plane median");
      expect(html).not.toContain("Observed samples");
    }
  });
  it("escapes calculation metadata rather than trusting a runtime method label", () => {
    const measurement = sampleMeasurement();
    measurement.method =
      '</strong><script>alert("trace")</script> & test' as SpeedMeasurement["method"];
    const html = renderSpeedCalculation(measurement);
    expect(html).toContain(
      "&lt;/strong&gt;&lt;script&gt;alert(&quot;trace&quot;)&lt;/script&gt; &amp; test",
    );
    expect(html).not.toContain("<script>");
    expect(html).not.toContain(measurement.method);
  });
  it("rejects unavailable evidence without creating or downloading an incomplete report", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          new Response("Evidence unavailable", { status: 503 }),
        ),
    );
    const createElement = vi.fn();
    vi.stubGlobal("document", { createElement });
    const createUrl = vi.spyOn(URL, "createObjectURL");
    await expect(downloadTicketDraft(sampleCase())).rejects.toThrow(
      "Evidence could not be retrieved",
    );
    expect(createElement).not.toHaveBeenCalled();
    expect(createUrl).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
});
