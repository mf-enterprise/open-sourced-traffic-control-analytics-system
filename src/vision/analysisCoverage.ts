export const MAX_ANALYSIS_GAP_SECONDS = 3;
export function hasAnalysisGap(elapsedSeconds: number): boolean {
  return (
    !Number.isFinite(elapsedSeconds) ||
    elapsedSeconds < 0 ||
    elapsedSeconds > MAX_ANALYSIS_GAP_SECONDS
  );
}
export function segmentedTrendPath(
  values: ReadonlyArray<number | null>,
): string {
  const observed = values.filter(
    (value): value is number => value !== null && Number.isFinite(value),
  );
  if (!observed.length) return "";
  const low = Math.min(...observed),
    high = Math.max(...observed);
  return values
    .map((value, index) => {
      if (value === null || !Number.isFinite(value)) return "";
      const previous = values[index - 1];
      const command =
        index === 0 || previous === null || !Number.isFinite(previous)
          ? "M"
          : "L";
      return `${command}${1 + (index * 88) / Math.max(1, values.length - 1)} ${32 - ((value - low) / Math.max(1, high - low)) * 28}`;
    })
    .filter(Boolean)
    .join(" ");
}
export class AnalysisCoverage {
  private values: Array<number | null>;
  private bucket: number | null = null;
  private unknownThrough = -1;
  constructor(
    private readonly length = 24,
    private readonly seconds = 3,
  ) {
    this.values = Array(length).fill(null);
  }
  reset(): void {
    this.values.fill(null);
    this.bucket = null;
    this.unknownThrough = -1;
  }
  private advance(time: number): number | null {
    if (!Number.isFinite(time) || time < 0) return null;
    const next = Math.floor(time / this.seconds);
    if (this.bucket !== null && next < this.bucket) this.reset();
    const steps =
      this.bucket === null ? 0 : Math.min(this.length, next - this.bucket);
    for (let index = 0; index < steps; index++) {
      this.values.shift();
      this.values.push(null);
    }
    this.bucket = next;
    return next;
  }
  record(time: number, count: number): void {
    const bucket = this.advance(time);
    if (bucket === null || !Number.isFinite(count) || count < 0) return;
    if (bucket > this.unknownThrough) this.values[this.length - 1] = count;
  }
  gap(from: number, to: number): void {
    if (!Number.isFinite(from) || !Number.isFinite(to) || from < 0 || to < from)
      return;
    const end = this.advance(to);
    if (end === null) return;
    const start = Math.floor(from / this.seconds);
    for (let index = 0; index < this.length; index++) {
      if (end - (this.length - 1 - index) >= start) this.values[index] = null;
    }
    this.unknownThrough = Math.max(this.unknownThrough, end);
  }
  get snapshot(): Array<number | null> {
    return [...this.values];
  }
}
