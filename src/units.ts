export type SpeedUnit = "kmh" | "mph";
export const KM_PER_MILE = 1.609344;
export const speedUnitLabel = (unit: SpeedUnit): string =>
  unit === "mph" ? "mph" : "km/h";
export const speedFromKmh = (kmh: number, unit: SpeedUnit): number =>
  unit === "mph" ? kmh / KM_PER_MILE : kmh;
export const speedToKmh = (value: number, unit: SpeedUnit): number =>
  unit === "mph" ? value * KM_PER_MILE : value;
export const formatSpeed = (
  kmh: number,
  unit: SpeedUnit,
  decimals = 1,
): string =>
  `${speedFromKmh(kmh, unit).toFixed(decimals)} ${speedUnitLabel(unit)}`;
export const dualSpeed = (kmh: number): string =>
  `${formatSpeed(kmh, "kmh")} / ${formatSpeed(kmh, "mph")}`;
