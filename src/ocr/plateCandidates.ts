import type { NormalizedCrop } from "./readPlate";
export type PixelBox = readonly [number, number, number, number];
export interface PlateSuggestion {
  crop: NormalizedCrop;
  score: number;
  sourceWidth: number;
  sourceHeight: number;
}
export function clipVehicleBox(
  bounds: PixelBox | null | undefined,
  imageWidth: number,
  imageHeight: number,
): [number, number, number, number] | null {
  if (
    !bounds ||
    bounds.length !== 4 ||
    !bounds.every(Number.isFinite) ||
    !Number.isFinite(imageWidth) ||
    !Number.isFinite(imageHeight) ||
    imageWidth < 1 ||
    imageHeight < 1 ||
    bounds[2] <= 0 ||
    bounds[3] <= 0
  )
    return null;
  const left = Math.max(0, Math.ceil(bounds[0]));
  const top = Math.max(0, Math.ceil(bounds[1]));
  const right = Math.min(imageWidth, Math.floor(bounds[0] + bounds[2]));
  const bottom = Math.min(imageHeight, Math.floor(bounds[1] + bounds[3]));
  return right - left >= 2 && bottom - top >= 2
    ? [left, top, right - left, bottom - top]
    : null;
}
export function mapPlateSuggestions(
  candidates: readonly {
    bbox: PixelBox;
    score: number;
  }[],
  vehicle: PixelBox,
  imageWidth: number,
  imageHeight: number,
): PlateSuggestion[] {
  const search = clipVehicleBox(vehicle, imageWidth, imageHeight);
  if (!search) return [];
  return candidates
    .flatMap(({ bbox, score }) => {
      const plate = clipVehicleBox(bbox, search[2], search[3]);
      if (!plate || !Number.isFinite(score) || score < 0 || score > 1)
        return [];
      const padX = plate[2] * 0.04,
        padY = plate[3] * 0.08;
      const left = Math.max(0, plate[0] - padX),
        top = Math.max(0, plate[1] - padY);
      const right = Math.min(search[2], plate[0] + plate[2] + padX);
      const bottom = Math.min(search[3], plate[1] + plate[3] + padY);
      return [
        {
          crop: {
            x: (search[0] + left) / imageWidth,
            y: (search[1] + top) / imageHeight,
            width: (right - left) / imageWidth,
            height: (bottom - top) / imageHeight,
          },
          score,
          sourceWidth: plate[2],
          sourceHeight: plate[3],
        },
      ];
    })
    .slice(0, 5);
}
export function hasAutomaticReadDetail(suggestion: PlateSuggestion): boolean {
  return suggestion.sourceWidth >= 80 && suggestion.sourceHeight >= 18;
}
