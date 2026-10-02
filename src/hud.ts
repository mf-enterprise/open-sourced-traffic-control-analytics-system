export const OBJECT_HUD = [
  { className: "car", label: "Cars", color: "#d1f79b" },
  { className: "truck", label: "Trucks", color: "#71cfff" },
  { className: "bus", label: "Buses", color: "#bdabff" },
  { className: "motorcycle", label: "Motorcycles", color: "#ffd078" },
  { className: "bicycle", label: "Bicycles", color: "#5ce4cb" },
  { className: "person", label: "People", color: "#ff9ed2" },
] as const;
const objectColors = new Map<string, string>(
  OBJECT_HUD.map(({ className, color }) => [className, color]),
);
export const HUD_WARNING_COLOR = "#ff9c78";
export const objectHudColor = (className: string): string =>
  objectColors.get(className) ?? "#d5e0e6";
