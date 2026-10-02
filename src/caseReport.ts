import type { StoredCase } from "./storage/useCaseStore";
import type { SpeedMeasurement } from "./vision/types";
import { dualSpeed } from "./units";
const escape = (value: unknown) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ]!,
  );
export const SPEED_CALCULATION_NOTE =
  "Recent-window vector estimate from tracked ground-plane positions. Times refer to the source media timeline. Full samples are retained in the JSON record.";
export function speedCalculationFields(
  measurement: SpeedMeasurement | null | undefined,
): [string, string][] | null {
  if (!measurement?.samples?.length) return null;
  const start = measurement.samples[0].timeSeconds;
  const end = measurement.samples.at(-1)!.timeSeconds;
  return [
    [
      "Method",
      measurement.method === "ground-plane-median-v2"
        ? "Ground-plane median · v2"
        : measurement.method === "ground-plane-geometric-median-v3"
          ? "Ground-plane vector median · v3"
          : String(measurement.method),
    ],
    [
      "Media interval",
      `${start.toFixed(3)}–${end.toFixed(3)} s (${(end - start).toFixed(3)} s)`,
    ],
    ["Observed samples", String(measurement.samples.length)],
    ["Velocity pairs", String(measurement.pairCount)],
  ];
}
export function renderSpeedCalculation(
  measurement: SpeedMeasurement | null | undefined,
): string {
  const fields = speedCalculationFields(measurement);
  return `<section class="speed-calculation"><h2>Speed calculation</h2>${
    fields
      ? `<p class="caption">${escape(SPEED_CALCULATION_NOTE)}</p><div class="fields">${fields.map(([label, value]) => `<div class="field"><span>${escape(label)}</span><strong>${escape(value)}</strong></div>`).join("")}</div>`
      : '<p class="caption">Calculation trace unavailable</p>'
  }</section>`;
}
export async function downloadTicketDraft(record: StoredCase) {
  const response = await fetch(record.evidenceUrl);
  if (!response.ok)
    throw new Error(
      "Evidence could not be retrieved. Check the local storage service.",
    );
  const blob = await response.blob();
  const evidence = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error("Evidence could not be read"));
    reader.readAsDataURL(blob);
  });
  const fields = [
    ["Case reference", record.id],
    [
      "Evidence mode",
      record.simulation ? "Simulated test record" : "Camera / video capture",
    ],
    ["Record status", record.state === "approved" ? "Reviewed" : record.state],
    ["Processing time (UTC)", record.captureTime],
    ["Time basis", "Local processing clock; stream delivery may be delayed"],
    ["Source", record.sourceName],
    ["Vehicle class", record.className],
    ["Track identifier", String(record.trackId)],
    ["Estimated speed (both units)", dualSpeed(record.speedKmh)],
    ["Recorded limit (both units)", dualSpeed(record.speedLimit)],
    ["Excess (both units)", dualSpeed(record.speedKmh - record.speedLimit)],
    ["Registration", record.plate || "Not verified"],
    ["Detection confidence", `${(record.confidence * 100).toFixed(1)}%`],
    [
      "Calibration",
      record.calibration
        ? `${record.calibration.widthMeters} × ${record.calibration.lengthMeters} metres`
        : "Uncalibrated",
    ],
    ["Source timestamp", `${record.sourceTimestamp.toFixed(3)} seconds`],
    ["Reviewer", record.reviewer || "Pending"],
    [
      "Review date (UTC)",
      record.state === "draft" ? "Pending" : record.updatedAt,
    ],
  ];
  const content = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escape(record.id)} · Ticket draft</title><style>*{box-sizing:border-box}body{margin:0;background:#e9eeeb;color:#1c2a25;font:14px/1.6 Arial,sans-serif}.sheet{background:white;max-width:850px;margin:30px auto;padding:45px 55px}.top{display:flex;justify-content:space-between;border-bottom:2px solid #22372d;padding-bottom:18px}.brand{font-size:18px;letter-spacing:3px;font-weight:700}.tag{font-size:10px;letter-spacing:2px;color:#596b5f}.status{font-size:11px;padding:6px 10px;background:#eef2df;border:1px solid #dbe1c5}h1{font-size:30px;line-height:1.2;margin:28px 0 5px}.sub{font-size:12px;color:#697a71}.metrics{display:flex;gap:14px;margin:25px 0}.metric{flex:1;border:1px solid #dbe4dd;padding:15px}.metric span{display:block;font-size:10px;text-transform:uppercase;letter-spacing:1px;color:#78857c}.metric strong{font-size:28px;font-weight:500}.metric small{font-size:12px}.fields{display:grid;grid-template-columns:1fr 1fr;gap:0 28px}.field{display:flex;justify-content:space-between;border-bottom:1px solid #edf0ed;gap:18px;padding:10px 0;font-size:11px}.field span{color:#758179}.field strong{text-align:right;font-weight:500;overflow-wrap:anywhere}.evidence{width:100%;margin-top:25px;border:1px solid #d1dbd3}.caption{font-size:10px;color:#7a877e}.notes{font-size:12px;margin:22px 0;white-space:pre-wrap}.hash{font-size:9px;overflow-wrap:anywhere;border-top:1px solid #d6dfd7;padding-top:15px;color:#738076}.notice{background:#f2f4ef;border-left:3px solid #98aa86;padding:13px;font-size:10px;line-height:1.8;margin-top:20px}.speed-calculation{margin-top:22px;padding-top:14px;border-top:1px solid #d6dfd7;break-inside:avoid}.speed-calculation h2{font-size:16px;margin:0 0 8px}.actions{text-align:center;margin:20px}button{padding:12px 20px;background:#233b2c;color:white;border:0;border-radius:5px;cursor:pointer}@media print{body{background:white}.sheet{margin:0;padding:15px;max-width:none}.actions{display:none}.field,.metrics,.notice{break-inside:avoid}.evidence{max-height:340px;object-fit:contain}h1{font-size:24px}@page{size:A4;margin:13mm}}</style></head><body><div class="actions"><button onclick="window.print()">Print / Save as PDF</button></div><main class="sheet"><div class="top"><div><div class="brand">Traffic Control</div><div class="tag">TRAFFIC INTELLIGENCE</div></div><span class="status">${record.simulation ? "SIMULATED TEST RECORD" : "INTERNAL TICKET DRAFT"}</span></div><h1>Speeding observation</h1><div class="sub">${escape(record.id)} · Evidence record for authorized review</div><div class="metrics"><div class="metric"><span>Estimated speed</span><strong>${record.speedKmh.toFixed(1)}</strong> <small>km/h</small></div><div class="metric"><span>Recorded speed limit</span><strong>${record.speedLimit}</strong> <small>km/h</small></div><div class="metric"><span>Above configured limit</span><strong>+${(record.speedKmh - record.speedLimit).toFixed(1)}</strong> <small>km/h</small></div></div><div class="fields">${fields.map(([label, value]) => `<div class="field"><span>${escape(label)}</span><strong>${escape(value)}</strong></div>`).join("")}</div>${renderSpeedCalculation(record.speedMeasurement)}<img class="evidence" src="${evidence}" alt="Original captured evidence frame"><p class="caption">Captured frame associated with the original measurement.</p><div class="notes"><strong>Review notes</strong><br>${escape(record.notes || "No review notes recorded.")}</div><div class="hash"><strong>Original evidence SHA-256</strong><br>${escape(record.evidenceSha256)}</div><div class="notice">This is an internal draft, not a legally issued penalty. Speed is estimated from calibrated video and requires validated accuracy. Vehicle identity, jurisdiction, issuing authority, applicable law, and penalty must be verified by an authorized operator before legal issuance. No payment is requested.</div></main></body></html>`;
  const url = URL.createObjectURL(
    new Blob([content], { type: "text/html;charset=utf-8" }),
  );
  const a = document.createElement("a");
  a.href = url;
  a.download = `${record.id}-ticket-draft.html`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
