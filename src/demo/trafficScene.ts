export interface DemoVehicle {
  id: number;
  bbox: [number, number, number, number];
  className: string;
  score: number;
  speedKmh: number;
  trail: {
    x: number;
    y: number;
  }[];
}
export const DEMO_CALIBRATION = {
  points: [
    { x: 0.16, y: 0.35192 },
    { x: 0.8266666667, y: 0.2418644444 },
    { x: 0.8266666667, y: 0.5840022222 },
    { x: 0.16, y: 0.72728 },
  ],
  widthMeters: 23,
  lengthMeters: 110,
} as const;
type Point = {
  x: number;
  y: number;
};
type VehicleKind = "car" | "truck" | "bus" | "motorcycle";
type VehicleStyle = {
  kind: VehicleKind;
  color: string;
  length: number;
  width: number;
};
const WORLD_LENGTH = 165;
const ROAD_HALF = 11.55;
const LANE_CENTERS = [-9.75, -6.2, -2.65, 2.65, 6.2, 9.75];
const LANE_SPEEDS = [43, 57, 69, 73, 61, 48];
const LANE_SPACING = [48, 53, 59, 58, 49, 55];
const CAR_COLORS = [
  "#e5e7e3",
  "#b7bec0",
  "#c4c9c4",
  "#273a48",
  "#646c71",
  "#ddd9c8",
  "#a54436",
  "#344d4b",
  "#677782",
  "#18252d",
  "#d2d5d2",
  "#a8afb5",
];
let staticCanvas: HTMLCanvasElement | null = null;
let staticWidth = 0;
let staticHeight = 0;
function random(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a += 0x6d2b79f5;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function point(u: number, v: number, w: number, h: number): Point {
  return { x: u * w, y: (0.57 - 0.19 * u + (v / 60) * (1 - 0.13 * u)) * h };
}
function polygon(
  ctx: CanvasRenderingContext2D,
  points: Point[],
  color: string | CanvasGradient,
): void {
  ctx.beginPath();
  points.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
  ctx.closePath();
  ctx.fillStyle = color;
  ctx.fill();
}
function strip(
  ctx: CanvasRenderingContext2D,
  u1: number,
  u2: number,
  v1: number,
  v2: number,
  w: number,
  h: number,
  fill: string,
): void {
  polygon(
    ctx,
    [
      point(u1, v1, w, h),
      point(u2, v1, w, h),
      point(u2, v2, w, h),
      point(u1, v2, w, h),
    ],
    fill,
  );
}
function line(
  ctx: CanvasRenderingContext2D,
  a: Point,
  b: Point,
  color: string,
  width: number,
): void {
  ctx.beginPath();
  ctx.moveTo(a.x, a.y);
  ctx.lineTo(b.x, b.y);
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.stroke();
}
function rounded(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  radius: number,
  fill: string | CanvasGradient,
): void {
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, Math.max(0.1, Math.min(radius, w / 2, h / 2)));
  ctx.fillStyle = fill;
  ctx.fill();
}
function tree(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  radius: number,
  seed: number,
): void {
  const rnd = random(seed);
  ctx.save();
  ctx.fillStyle = "#12221c42";
  ctx.beginPath();
  ctx.ellipse(
    x + radius * 0.42,
    y + radius * 0.65,
    radius * 1.1,
    radius * 0.72,
    0.38,
    0,
    Math.PI * 2,
  );
  ctx.fill();
  ctx.fillStyle = "#233b29";
  ctx.beginPath();
  ctx.arc(x, y, radius * 0.86, 0, Math.PI * 2);
  ctx.fill();
  const tones = [
    "#3e5637",
    "#52623e",
    "#485e3b",
    "#5d6e44",
    "#344b31",
    "#68744b",
  ];
  for (let i = 0; i < 27; i++) {
    const a = rnd() * Math.PI * 2;
    const r = Math.sqrt(rnd()) * radius * 0.73;
    const leafRadius = radius * (0.16 + rnd() * 0.28);
    ctx.fillStyle = tones[Math.floor(rnd() * tones.length)]!;
    ctx.beginPath();
    ctx.arc(
      x + Math.cos(a) * r,
      y + Math.sin(a) * r,
      leafRadius,
      0,
      Math.PI * 2,
    );
    ctx.fill();
  }
  for (let i = 0; i < 32; i++) {
    ctx.fillStyle = rnd() > 0.5 ? "#b0b68d20" : "#172d2319";
    const a = rnd() * Math.PI * 2;
    const r = Math.sqrt(rnd()) * radius * 0.8;
    ctx.beginPath();
    ctx.arc(
      x + Math.cos(a) * r,
      y + Math.sin(a) * r,
      radius * 0.035 + rnd() * radius * 0.055,
      0,
      Math.PI * 2,
    );
    ctx.fill();
  }
  ctx.restore();
}
function building(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  bw: number,
  bh: number,
  angle: number,
  seed: number,
): void {
  const rnd = random(seed);
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(angle);
  polygon(
    ctx,
    [
      { x: -bw / 2 + 7, y: -bh / 2 + 9 },
      { x: bw / 2 + 10, y: -bh / 2 + 12 },
      { x: bw / 2 + 13, y: bh / 2 + 17 },
      { x: -bw / 2 + 12, y: bh / 2 + 16 },
    ],
    "#16212042",
  );
  rounded(ctx, -bw / 2, -bh / 2, bw, bh, 1.5, "#717a76");
  rounded(ctx, -bw / 2 + 3, -bh / 2 + 3, bw - 6, bh - 6, 1, "#a8aaa0");
  rounded(ctx, -bw / 2 + 7, -bh / 2 + 7, bw - 14, bh - 14, 1, "#969e96");
  line(
    ctx,
    { x: -bw / 2 + 4, y: -bh / 2 + 4 },
    { x: bw / 2 - 3, y: -bh / 2 + 4 },
    "#d9dbce9c",
    2,
  );
  for (let j = 0; j < 8; j++) {
    const px = -bw * 0.4 + j * bw * 0.11;
    line(
      ctx,
      { x: px, y: -bh * 0.39 },
      { x: px, y: bh * 0.39 },
      "#75847f42",
      0.7,
    );
  }
  for (let i = 0; i < 3; i++) {
    const px = -bw * 0.26 + i * bw * 0.28;
    const py = (rnd() - 0.5) * bh * 0.4;
    rounded(ctx, px + 3, py + 3, bw * 0.13, bh * 0.2, 1, "#57656070");
    rounded(ctx, px, py, bw * 0.13, bh * 0.2, 1, "#c1c3b7");
    ctx.fillStyle = "#727e77";
    ctx.beginPath();
    ctx.arc(
      px + bw * 0.065,
      py + bh * 0.1,
      Math.min(bw * 0.04, bh * 0.075),
      0,
      Math.PI * 2,
    );
    ctx.fill();
  }
  ctx.restore();
}
function parkingLot(ctx: CanvasRenderingContext2D, w: number, h: number): void {
  strip(ctx, 0.025, 0.36, -18.8, -33.5, w, h, "#737b7266");
  strip(ctx, 0.033, 0.35, -19.2, -32.4, w, h, "#747c72");
  const rnd = random(681);
  for (let i = 0; i < 21; i++) {
    const u = 0.041 + i * 0.0145;
    line(
      ctx,
      point(u, -19.7, w, h),
      point(u, -23.5, w, h),
      "#c4c3ad8a",
      w / 1600,
    );
    if (rnd() > 0.29) {
      const p = point(u + 0.007, -21.6, w, h);
      drawVehicle(
        ctx,
        p.x,
        p.y,
        Math.PI / 2 - 0.106,
        (w / WORLD_LENGTH) * 0.77,
        {
          kind: "car",
          color: CAR_COLORS[Math.floor(rnd() * CAR_COLORS.length)]!,
          length: 4.1,
          width: 1.8,
        },
      );
    }
  }
  for (let i = 0; i < 3; i++) {
    const p = point(0.079 + i * 0.106, -28.1, w, h);
    building(ctx, p.x, p.y, w * 0.085, h * 0.1, -0.105, 10 + i);
  }
}
function lamp(
  ctx: CanvasRenderingContext2D,
  p: Point,
  scale: number,
  upper: boolean,
): void {
  const arm = (upper ? 1 : -1) * 13 * scale;
  line(
    ctx,
    { x: p.x + 4 * scale, y: p.y + 4 * scale },
    { x: p.x + 20 * scale, y: p.y + 24 * scale },
    "#1e2d273a",
    2.2 * scale,
  );
  line(ctx, p, { x: p.x + 2.5 * scale, y: p.y + arm }, "#4c5750", 1.35 * scale);
  ctx.fillStyle = "#d4d4ba";
  ctx.beginPath();
  ctx.ellipse(
    p.x + 2.5 * scale,
    p.y + arm,
    3 * scale,
    1.4 * scale,
    0.15,
    0,
    Math.PI * 2,
  );
  ctx.fill();
  ctx.fillStyle = "#657064";
  ctx.beginPath();
  ctx.arc(p.x, p.y, 2 * scale, 0, Math.PI * 2);
  ctx.fill();
}
function buildStatic(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
): void {
  const rnd = random(24710);
  const scale = w / 1600;
  ctx.fillStyle = "#78826a";
  ctx.fillRect(0, 0, w, h);
  for (let i = 0; i < 560; i++) {
    const x = rnd() * w;
    const y = rnd() * h;
    const radius = (8 + rnd() * 75) * scale;
    const gradient = ctx.createRadialGradient(x, y, 0, x, y, radius);
    gradient.addColorStop(0, rnd() > 0.5 ? "#97a0771b" : "#3f584420");
    gradient.addColorStop(1, "#53664a00");
    ctx.fillStyle = gradient;
    ctx.fillRect(x - radius, y - radius, radius * 2, radius * 2);
  }
  strip(ctx, -0.1, 1.1, -16.15, -18.75, w, h, "#6d785d");
  strip(ctx, -0.1, 1.1, 16.2, 18.7, w, h, "#68775c");
  parkingLot(ctx, w, h);
  strip(ctx, 0.57, 1.1, 24.3, 26.1, w, h, "#adae948f");
  strip(ctx, 0.745, 0.885, 28.1, 38.2, w, h, "#b6b69b");
  strip(ctx, 0.749, 0.881, 28.5, 37.8, w, h, "#6b8a79");
  strip(ctx, 0.762, 0.868, 29.4, 36.8, w, h, "#799388");
  [29.4, 33.1, 36.8].forEach((v) =>
    line(
      ctx,
      point(0.762, v, w, h),
      point(0.868, v, w, h),
      "#ced8c0bb",
      1 * scale,
    ),
  );
  [0.762, 0.815, 0.868].forEach((u) =>
    line(
      ctx,
      point(u, 29.4, w, h),
      point(u, 36.8, w, h),
      "#ced8c0bb",
      1 * scale,
    ),
  );
  line(
    ctx,
    point(0.755, 33.1, w, h),
    point(0.876, 33.1, w, h),
    "#2e4a3b9c",
    1.3 * scale,
  );
  for (let i = 0; i < 11; i++) {
    const u = 0.04 + i * 0.087;
    const p = point(u, -18.1, w, h);
    tree(ctx, p.x, p.y, (12 + rnd() * 9) * scale, 300 + i);
  }
  for (let i = 0; i < 33; i++) {
    const u = rnd() * 1.05;
    const v = 19.6 + rnd() * 12;
    if (u > 0.735 && u < 0.9 && v > 26.5) continue;
    const p = point(u, v, w, h);
    tree(ctx, p.x, p.y, (13 + rnd() * 16) * scale, 460 + i);
  }
  for (let i = 0; i < 19; i++) {
    const p = point(0.41 + rnd() * 0.68, -22 - rnd() * 12, w, h);
    tree(ctx, p.x, p.y, (16 + rnd() * 15) * scale, 640 + i);
  }
  for (const sign of [-1, 1]) {
    strip(ctx, -0.03, 1.03, sign * 12.0, sign * 16.0, w, h, "#a5aaa0");
    strip(ctx, -0.03, 1.03, sign * 12.7, sign * 14.3, w, h, "#9b9f91");
    strip(ctx, -0.03, 1.03, sign * 15.7, sign * 16.0, w, h, "#c2c3af");
    for (let u = -0.02; u < 1.04; u += 0.014) {
      line(
        ctx,
        point(u, sign * 12.1, w, h),
        point(u, sign * 15.75, w, h),
        "#6e78682f",
        0.65 * scale,
      );
    }
    strip(ctx, -0.03, 1.03, sign * 11.75, sign * 12.15, w, h, "#e1dec5");
    strip(ctx, -0.03, 1.03, sign * 11.55, sign * 11.75, w, h, "#465148");
  }
  strip(ctx, -0.05, 1.05, -ROAD_HALF, ROAD_HALF, w, h, "#555f60");
  strip(ctx, -0.05, 1.05, -ROAD_HALF, -0.8, w, h, "#566063");
  strip(ctx, -0.05, 1.05, 0.8, ROAD_HALF, w, h, "#535d60");
  for (const v of LANE_CENTERS) {
    strip(ctx, -0.05, 1.05, v - 1.18, v - 0.62, w, h, "#2f3f4520");
    strip(ctx, -0.05, 1.05, v + 0.62, v + 1.18, w, h, "#2f3f4520");
  }
  ctx.save();
  ctx.beginPath();
  [
    point(-0.05, -ROAD_HALF, w, h),
    point(1.05, -ROAD_HALF, w, h),
    point(1.05, ROAD_HALF, w, h),
    point(-0.05, ROAD_HALF, w, h),
  ].forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
  ctx.closePath();
  ctx.clip();
  for (let i = 0; i < 14000; i++) {
    const p = point(rnd(), (rnd() * 2 - 1) * ROAD_HALF, w, h);
    ctx.fillStyle = rnd() > 0.5 ? "#cbd2c016" : "#0b252119";
    ctx.fillRect(
      p.x,
      p.y,
      (0.4 + rnd() * 1.5) * scale,
      (0.3 + rnd() * 0.6) * scale,
    );
  }
  for (let i = 0; i < 13; i++) {
    const u = rnd();
    const v = (rnd() * 2 - 1) * 10.8;
    strip(
      ctx,
      u,
      u + 0.01 + rnd() * 0.035,
      v,
      v + 0.9 + rnd() * 1.5,
      w,
      h,
      rnd() > 0.5 ? "#66717325" : "#33434929",
    );
  }
  ctx.restore();
  for (const v of [-7.975, -4.425, 4.425, 7.975]) {
    for (let u = -0.04; u < 1.04; u += 12 / WORLD_LENGTH) {
      line(
        ctx,
        point(u, v, w, h),
        point(u + 3.0 / WORLD_LENGTH, v, w, h),
        "#d7d8c9be",
        1.65 * scale,
      );
    }
  }
  for (const v of [-11.14, -1.01, 1.01, 11.14]) {
    line(
      ctx,
      point(-0.04, v, w, h),
      point(1.04, v, w, h),
      "#deded0b8",
      1.7 * scale,
    );
  }
  strip(ctx, -0.05, 1.05, -0.78, 0.78, w, h, "#b7b8a3");
  strip(ctx, -0.05, 1.05, -0.54, 0.5, w, h, "#7b8668");
  strip(ctx, -0.05, 1.05, 0.5, 0.78, w, h, "#777f70");
  for (let u = 0.025; u < 1; u += 0.056) {
    const p = point(u, 0, w, h);
    ctx.fillStyle = "#526348";
    ctx.beginPath();
    ctx.ellipse(p.x, p.y, 5.5 * scale, 2.6 * scale, -0.1, 0, Math.PI * 2);
    ctx.fill();
    line(
      ctx,
      point(u - 0.007, -0.7, w, h),
      point(u - 0.007, 0.7, w, h),
      "#767f683e",
      0.65 * scale,
    );
  }
  for (let u = 0.07; u < 1.01; u += 0.162) {
    for (const sign of [-1, 1]) {
      const p = point(u, sign * 12.3, w, h);
      strip(
        ctx,
        u - 0.003,
        u + 0.003,
        sign * 11.57,
        sign * 11.82,
        w,
        h,
        "#2e3e3d",
      );
      lamp(ctx, p, scale, sign === -1);
    }
  }
  for (const v of LANE_CENTERS) {
    const u = v < 0 ? 0.86 : 0.16;
    const p = point(u, v, w, h);
    const direction = v < 0 ? -1 : 1;
    const dx = 13 * scale * direction;
    const dy = ((-0.19 * h) / w) * dx;
    line(
      ctx,
      { x: p.x - dx, y: p.y - dy },
      { x: p.x + dx, y: p.y + dy },
      "#d8dac48a",
      2.1 * scale,
    );
    polygon(
      ctx,
      [
        { x: p.x + dx + 5 * scale * direction, y: p.y + dy },
        { x: p.x + dx - 4 * scale * direction, y: p.y + dy - 3.5 * scale },
        { x: p.x + dx - 4 * scale * direction, y: p.y + dy + 3.5 * scale },
      ],
      "#d8dac48a",
    );
  }
  ctx.fillStyle = "#c7c8a008";
  ctx.fillRect(0, 0, w, h);
  const vignette = ctx.createRadialGradient(
    w * 0.52,
    h * 0.47,
    w * 0.2,
    w * 0.52,
    h * 0.47,
    w * 0.74,
  );
  vignette.addColorStop(0, "#071e1900");
  vignette.addColorStop(1, "#071e1935");
  ctx.fillStyle = vignette;
  ctx.fillRect(0, 0, w, h);
}
function drawVehicle(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  angle: number,
  scale: number,
  style: VehicleStyle,
): void {
  const l = style.length * scale;
  const w = style.width * scale;
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(angle);
  ctx.save();
  ctx.translate(scale * 0.25, scale * 0.32);
  rounded(ctx, -l * 0.49, -w * 0.48, l, w, w * 0.19, "#10242772");
  ctx.restore();
  if (style.kind === "motorcycle") {
    rounded(ctx, -l * 0.49, -w * 0.2, l * 0.99, w * 0.4, w * 0.14, "#1b2629");
    rounded(ctx, -l * 0.3, -w * 0.35, l * 0.6, w * 0.7, w * 0.22, style.color);
    line(
      ctx,
      { x: l * 0.22, y: -w * 0.5 },
      { x: l * 0.22, y: w * 0.5 },
      "#2f3534",
      scale * 0.08,
    );
    ctx.fillStyle = "#3a4140";
    ctx.beginPath();
    ctx.ellipse(-l * 0.02, 0, l * 0.19, w * 0.36, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "#d5d8c8";
    ctx.beginPath();
    ctx.arc(l * 0.09, 0, w * 0.24, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
    return;
  }
  for (const tx of [-0.31, 0.3]) {
    for (const sy of [-1, 1]) {
      rounded(
        ctx,
        l * tx - l * 0.065,
        sy * w * 0.45 - w * 0.065,
        l * 0.13,
        w * 0.13,
        w * 0.035,
        "#17252a",
      );
    }
  }
  const bodyGradient = ctx.createLinearGradient(0, -w / 2, 0, w / 2);
  bodyGradient.addColorStop(0, "#2d3c43");
  bodyGradient.addColorStop(0.065, style.color);
  bodyGradient.addColorStop(0.8, style.color);
  bodyGradient.addColorStop(1, "#344148");
  rounded(ctx, -l * 0.5, -w * 0.5, l, w, w * 0.19, bodyGradient);
  if (style.kind === "truck") {
    rounded(
      ctx,
      -l * 0.49,
      -w * 0.48,
      l * 0.75,
      w * 0.96,
      w * 0.035,
      "#c6c7bb",
    );
    rounded(
      ctx,
      -l * 0.475,
      -w * 0.425,
      l * 0.72,
      w * 0.82,
      w * 0.025,
      "#d4d4c8",
    );
    for (let i = 0; i < 15; i++) {
      const px = -l * 0.46 + i * l * 0.046;
      line(
        ctx,
        { x: px, y: -w * 0.4 },
        { x: px, y: w * 0.38 },
        "#9aa6a043",
        scale * 0.055,
      );
    }
    rounded(
      ctx,
      l * 0.3,
      -w * 0.42,
      l * 0.175,
      w * 0.84,
      w * 0.09,
      style.color,
    );
    rounded(
      ctx,
      l * 0.409,
      -w * 0.35,
      l * 0.055,
      w * 0.7,
      w * 0.035,
      "#233c47",
    );
    line(
      ctx,
      { x: l * 0.43, y: -w * 0.32 },
      { x: l * 0.455, y: w * 0.26 },
      "#768c8a77",
      scale * 0.055,
    );
  } else if (style.kind === "bus") {
    rounded(ctx, -l * 0.4, -w * 0.42, l * 0.77, w * 0.84, w * 0.1, "#b7c2b9");
    rounded(ctx, l * 0.37, -w * 0.37, l * 0.087, w * 0.74, w * 0.04, "#223c47");
    for (let i = 0; i < 7; i++) {
      rounded(
        ctx,
        -l * 0.39 + i * l * 0.104,
        -w * 0.485,
        l * 0.08,
        w * 0.09,
        0.2,
        "#243d48",
      );
      rounded(
        ctx,
        -l * 0.39 + i * l * 0.104,
        w * 0.4,
        l * 0.08,
        w * 0.09,
        0.2,
        "#243d48",
      );
    }
    for (const px of [-0.21, 0.08]) {
      rounded(
        ctx,
        l * px,
        -w * 0.19,
        l * 0.13,
        w * 0.38,
        scale * 0.08,
        "#d5d8c9",
      );
      line(
        ctx,
        { x: l * px + l * 0.025, y: -w * 0.13 },
        { x: l * px + l * 0.1, y: -w * 0.13 },
        "#879890",
        scale * 0.045,
      );
    }
  } else {
    polygon(
      ctx,
      [
        { x: -l * 0.34, y: -w * 0.32 },
        { x: -l * 0.22, y: -w * 0.39 },
        { x: -l * 0.22, y: w * 0.39 },
        { x: -l * 0.34, y: w * 0.32 },
      ],
      "#233944",
    );
    const glass = ctx.createLinearGradient(
      l * 0.09,
      -w * 0.4,
      l * 0.29,
      w * 0.4,
    );
    glass.addColorStop(0, "#213b47");
    glass.addColorStop(0.55, "#55717b");
    glass.addColorStop(1, "#253e49");
    polygon(
      ctx,
      [
        { x: l * 0.1, y: -w * 0.4 },
        { x: l * 0.29, y: -w * 0.33 },
        { x: l * 0.29, y: w * 0.33 },
        { x: l * 0.1, y: w * 0.4 },
      ],
      glass,
    );
    rounded(
      ctx,
      -l * 0.215,
      -w * 0.36,
      l * 0.315,
      w * 0.72,
      w * 0.08,
      style.color,
    );
    line(
      ctx,
      { x: -l * 0.19, y: -w * 0.31 },
      { x: l * 0.073, y: -w * 0.31 },
      "#ffffff52",
      scale * 0.06,
    );
    polygon(
      ctx,
      [
        { x: -l * 0.24, y: -w * 0.405 },
        { x: l * 0.12, y: -w * 0.435 },
        { x: l * 0.19, y: -w * 0.48 },
        { x: -l * 0.3, y: -w * 0.455 },
      ],
      "#21343e",
    );
    polygon(
      ctx,
      [
        { x: -l * 0.24, y: w * 0.405 },
        { x: l * 0.12, y: w * 0.435 },
        { x: l * 0.19, y: w * 0.48 },
        { x: -l * 0.3, y: w * 0.455 },
      ],
      "#1d313a",
    );
    line(
      ctx,
      { x: l * 0.33, y: -w * 0.33 },
      { x: l * 0.4, y: -w * 0.29 },
      "#ffffff48",
      scale * 0.075,
    );
    line(
      ctx,
      { x: -l * 0.43, y: -w * 0.25 },
      { x: -l * 0.38, y: -w * 0.3 },
      "#ffffff30",
      scale * 0.065,
    );
    for (const sy of [-1, 1])
      rounded(
        ctx,
        l * 0.09,
        sy * w * 0.51 - w * 0.035,
        l * 0.065,
        w * 0.07,
        w * 0.025,
        style.color,
      );
  }
  for (const sy of [-1, 1]) {
    rounded(
      ctx,
      l * 0.451,
      sy * w * 0.32 - w * 0.085,
      l * 0.024,
      w * 0.17,
      w * 0.025,
      "#eee9c9",
    );
    rounded(
      ctx,
      -l * 0.48,
      sy * w * 0.32 - w * 0.085,
      l * 0.025,
      w * 0.17,
      w * 0.02,
      "#b34335",
    );
  }
  line(
    ctx,
    { x: l * 0.482, y: -w * 0.17 },
    { x: l * 0.482, y: w * 0.17 },
    "#26363a",
    scale * 0.09,
  );
  line(
    ctx,
    { x: -l * 0.492, y: -w * 0.18 },
    { x: -l * 0.492, y: w * 0.18 },
    "#6b7b7880",
    scale * 0.055,
  );
  ctx.restore();
}
function styleFor(lane: number, sequence: number): VehicleStyle {
  const rnd = random((lane + 1) * 11737 + sequence * 871);
  const r = rnd();
  if ((lane === 0 || lane === 5) && r < 0.2)
    return {
      kind: "truck",
      color: r < 0.1 ? "#d2d5c8" : "#567285",
      length: 10.5,
      width: 2.5,
    };
  if ((lane === 0 || lane === 5) && r < 0.31)
    return { kind: "bus", color: "#a7c6bb", length: 11.4, width: 2.45 };
  if ((lane === 1 || lane === 4) && r < 0.15)
    return { kind: "motorcycle", color: "#567169", length: 2.15, width: 0.82 };
  return {
    kind: "car",
    color: CAR_COLORS[Math.floor(rnd() * CAR_COLORS.length)]!,
    length: 4.1 + rnd() * 0.9,
    width: 1.77 + rnd() * 0.17,
  };
}
function positionAt(
  lane: number,
  sequence: number,
  t: number,
  w: number,
  h: number,
): {
  p: Point;
  u: number;
  speed: number;
} {
  const baseSpeed = LANE_SPEEDS[lane]!;
  const phase = lane * 19.7 + 10;
  const wave = sequence * 1.13 + lane * 0.63;
  const distance =
    (baseSpeed / 3.6) * t +
    phase -
    sequence * LANE_SPACING[lane]! +
    (((baseSpeed / 3.6) * 0.018) / 0.3) *
      (Math.cos(wave) - Math.cos(0.3 * t + wave));
  const u = lane < 3 ? 1 - distance / WORLD_LENGTH : distance / WORLD_LENGTH;
  const v = LANE_CENTERS[lane]! + Math.sin(t * 0.45 + wave) * 0.035;
  return {
    p: point(u, v, w, h),
    u,
    speed: baseSpeed * (1 + 0.018 * Math.sin(0.3 * t + wave)),
  };
}
export function drawDemo(
  ctx: CanvasRenderingContext2D,
  timeSeconds: number,
  width: number,
  height: number,
): DemoVehicle[] {
  if (width <= 0 || height <= 0) return [];
  if (!staticCanvas || staticWidth !== width || staticHeight !== height) {
    staticCanvas = document.createElement("canvas");
    staticCanvas.width = width;
    staticCanvas.height = height;
    staticWidth = width;
    staticHeight = height;
    const staticContext = staticCanvas.getContext("2d");
    if (staticContext) buildStatic(staticContext, width, height);
  }
  ctx.drawImage(staticCanvas, 0, 0, width, height);
  const vehicles: DemoVehicle[] = [];
  const t = Math.max(0, Number.isFinite(timeSeconds) ? timeSeconds : 0);
  for (let lane = 0; lane < LANE_CENTERS.length; lane++) {
    const travel = (LANE_SPEEDS[lane]! / 3.6) * t + lane * 19.7 + 10;
    const first = Math.floor(
      (travel - WORLD_LENGTH - 20) / LANE_SPACING[lane]!,
    );
    const last = Math.ceil((travel + 20) / LANE_SPACING[lane]!);
    for (let sequence = first; sequence <= last; sequence++) {
      const { p, u, speed } = positionAt(lane, sequence, t, width, height);
      if (u < -0.07 || u > 1.07) continue;
      const style = styleFor(lane, sequence);
      const perspective = 1 - 0.09 * u;
      const vehicleScale = (width / WORLD_LENGTH) * perspective;
      const v = LANE_CENTERS[lane]!;
      const angle =
        Math.atan2(height * (-0.19 - (v / 60) * 0.13), width) +
        (lane < 3 ? Math.PI : 0);
      drawVehicle(ctx, p.x, p.y, angle, vehicleScale, style);
      const length = style.length * vehicleScale;
      const breadth = style.width * vehicleScale;
      const bx =
        Math.abs(Math.cos(angle)) * length +
        Math.abs(Math.sin(angle)) * breadth;
      const by =
        Math.abs(Math.sin(angle)) * length +
        Math.abs(Math.cos(angle)) * breadth;
      const margin = (2.5 * width) / 1600;
      if (
        p.x + bx / 2 < 0 ||
        p.x - bx / 2 > width ||
        p.y + by / 2 < 0 ||
        p.y - by / 2 > height
      )
        continue;
      const trail: Point[] = [];
      for (let i = 11; i >= 0; i--) {
        const previous = positionAt(
          lane,
          sequence,
          t - i * 0.11,
          width,
          height,
        ).p;
        trail.push({ x: previous.x / width, y: previous.y / height });
      }
      vehicles.push({
        id: (sequence + 50) * LANE_CENTERS.length + lane + 1,
        bbox: [
          p.x - bx / 2 - margin,
          p.y - by / 2 - margin,
          bx + margin * 2,
          by + margin * 2,
        ],
        className: style.kind,
        score: 0.91 + random((lane + 3) * 193 + sequence * 17)() * 0.083,
        speedKmh: speed,
        trail,
      });
    }
  }
  return vehicles;
}
