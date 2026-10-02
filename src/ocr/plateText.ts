export function normalizePlateText(text: string): string {
  return text
    .normalize("NFKC")
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");
}
export function isPlateCandidate(text: string): boolean {
  return /^[A-Z0-9]{2,12}$/.test(text);
}
export function normalizeConfidence(confidence: number): number {
  return Number.isFinite(confidence)
    ? Math.max(0, Math.min(100, confidence))
    : 0;
}
