export function isMediaDiscontinuity(
  rawDelta: number,
  wallDeltaSeconds: number,
): boolean {
  if (
    !Number.isFinite(rawDelta) ||
    !Number.isFinite(wallDeltaSeconds) ||
    wallDeltaSeconds < 0
  ) {
    return true;
  }
  return rawDelta < -0.05 || rawDelta > Math.max(1, 2 * wallDeltaSeconds);
}
