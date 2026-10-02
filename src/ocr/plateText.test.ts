import { describe, expect, it } from "vitest";
import {
  isPlateCandidate,
  normalizeConfidence,
  normalizePlateText,
} from "./plateText";
describe("registration candidate normalization", () => {
  it("removes OCR whitespace and separators and normalizes case", () => {
    expect(normalizePlateText("  ab12 cde\n")).toBe("AB12CDE");
    expect(normalizePlateText("AB-12·CD!")).toBe("AB12CD");
  });
  it("does not invent corrections for ambiguous characters", () => {
    expect(normalizePlateText("O0 I1 S5 B8")).toBe("O0I1S5B8");
  });
  it("handles compatibility characters without accepting non-Latin lookalikes", () => {
    expect(normalizePlateText("ＡＢ１２ＣＤＥ")).toBe("AB12CDE");
    expect(normalizePlateText("АВ12")).toBe("12");
    expect(normalizePlateText("... \n")).toBe("");
  });
  it("does not silently truncate an implausibly long OCR result", () => {
    const longResult = normalizePlateText("REGISTRATION AB12CDE");
    expect(longResult).toBe("REGISTRATIONAB12CDE");
    expect(isPlateCandidate(longResult)).toBe(false);
    expect(isPlateCandidate("A")).toBe(false);
    expect(isPlateCandidate("AB12CDE")).toBe(true);
    expect(isPlateCandidate("12345")).toBe(true);
    expect(isPlateCandidate("VANITY")).toBe(true);
  });
  it("clamps confidence and rejects nonfinite values", () => {
    expect(normalizeConfidence(87.6)).toBe(87.6);
    expect(normalizeConfidence(-3)).toBe(0);
    expect(normalizeConfidence(140)).toBe(100);
    expect(normalizeConfidence(Number.NaN)).toBe(0);
  });
});
