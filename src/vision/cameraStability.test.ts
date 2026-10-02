import { describe, expect, it } from "vitest";
import { existsSync } from "node:fs";
import sharp from "sharp";
import {
  assessCameraStability,
  createCameraReference,
  fitCameraCorrespondences,
  type CameraFrame,
  type CameraReference,
} from "./cameraStability";
import type { Detection } from "./types";
function texture(width = 240, height = 180, seed = 7): CameraFrame {
  const noise = new Uint8Array(width * height),
    data = new Uint8Array(width * height);
  for (let i = 0; i < noise.length; i++) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    noise[i] = seed >>> 24;
  }
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      let total = 0;
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++) {
          total +=
            noise[
              Math.max(0, Math.min(height - 1, y + dy)) * width +
                Math.max(0, Math.min(width - 1, x + dx))
            ];
        }
      data[y * width + x] = Math.round(total / 9);
    }
  return { width, height, channels: 1, data };
}
function transform(
  frame: CameraFrame,
  dx = 0,
  dy = 0,
  angle = 0,
  zoom = 1,
): CameraFrame {
  const { width, height } = frame;
  const data = new Uint8Array(width * height);
  const cx = (width - 1) / 2,
    cy = (height - 1) / 2;
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const u = (x - cx - dx) / zoom,
        v = (y - cy - dy) / zoom;
      const sx = u * Math.cos(angle) + v * Math.sin(angle) + cx;
      const sy = -u * Math.sin(angle) + v * Math.cos(angle) + cy;
      const x0 = Math.floor(sx),
        y0 = Math.floor(sy),
        fx = sx - x0,
        fy = sy - y0;
      if (x0 < 0 || y0 < 0 || x0 + 1 >= width || y0 + 1 >= height) {
        data[y * width + x] = 128;
        continue;
      }
      data[y * width + x] =
        (frame.data[y0 * width + x0] * (1 - fx) +
          frame.data[y0 * width + x0 + 1] * fx) *
          (1 - fy) +
        (frame.data[(y0 + 1) * width + x0] * (1 - fx) +
          frame.data[(y0 + 1) * width + x0 + 1] * fx) *
          fy;
    }
  return { width, height, channels: 1, data };
}
function detection(box: [number, number, number, number]): Detection {
  return { bbox: box, className: "car", score: 0.4 };
}
function painted(
  frame: CameraFrame,
  box: [number, number, number, number],
): CameraFrame {
  const data = new Uint8Array(frame.data);
  for (let y = box[1]; y < box[1] + box[3]; y++)
    for (let x = box[0]; x < box[0] + box[2]; x++)
      data[y * frame.width + x] = (x + y) % 2 ? 255 : 0;
  return { ...frame, data };
}
describe("fixed camera reference registration", () => {
  const original = texture();
  const reference = createCameraReference(original, [])!;
  it("creates bounded distributed features and recognizes an identical frame", () => {
    expect(reference).not.toBeNull();
    expect(reference.featureCount).toBeGreaterThanOrEqual(12);
    expect(reference.featureCount).toBeLessThanOrEqual(48);
    const result = assessCameraStability(reference, original, []);
    expect(result.state).toBe("stable");
    expect(result.matched).toBeGreaterThanOrEqual(12);
    expect(result.displacementPixels).toBeLessThan(0.1);
  });
  it.each([
    [4, 0],
    [0, -5],
    [4, -3],
    [1.8, 0.3],
  ])("detects pan/tilt including subpixel displacement (%s,%s)", (dx, dy) => {
    const result = assessCameraStability(
      reference,
      transform(original, dx, dy),
      [],
    );
    expect(result.state).toBe("moved");
    expect(result.displacementPixels).toBeGreaterThan(1.5);
  });
  it("fails closed when subpixel resampling makes too many patch matches uncertain", () => {
    const result = assessCameraStability(
      reference,
      transform(original, -2.4, 1.6),
      [],
    );
    expect(result.state).not.toBe("stable");
  });
  it.each([
    [0.025, 1],
    [-0.035, 1],
    [0, 1.035],
    [0, 0.965],
  ])(
    "detects rotation/zoom even when signed displacements cancel (%s,%s)",
    (angle, zoom) => {
      const result = assessCameraStability(
        reference,
        transform(original, 0, 0, angle, zoom),
        [],
      );
      expect(result.state).toBe("moved");
    },
  );
  it("does not automatically re-anchor after small successive movements", () => {
    expect(
      assessCameraStability(reference, transform(original, 0.25), []).state,
    ).toBe("stable");
    expect(
      assessCameraStability(reference, transform(original, 0.5), []).state,
    ).toBe("stable");
    expect(
      assessCameraStability(reference, transform(original, 1), []).state,
    ).not.toBe("stable");
    expect(
      assessCameraStability(reference, transform(original, 2), []).state,
    ).toBe("moved");
    expect(assessCameraStability(reference, original, []).state).toBe("stable");
  });
  it("tolerates linear brightness and contrast changes without altering reference pixels", () => {
    const changed = {
      ...original,
      data: Uint8Array.from(original.data, (x) => Math.round(x * 0.75 + 30)),
    };
    expect(assessCameraStability(reference, changed, []).state).toBe("stable");
  });
  it("excludes expanded object regions in both original and current frames", () => {
    const oldBox: [number, number, number, number] = [60, 75, 30, 25];
    const newBox: [number, number, number, number] = [145, 75, 30, 25];
    const masked = createCameraReference(painted(original, oldBox), [
      detection(oldBox),
    ])!;
    expect(masked).not.toBeNull();
    expect(
      assessCameraStability(masked, painted(original, newBox), [
        detection(newBox),
      ]).state,
    ).toBe("stable");
  });
  it("abstains for full occlusion, a scene cut, and movement outside the search range", () => {
    const whole = detection([0, 0, original.width, original.height]);
    expect(assessCameraStability(reference, original, [whole]).state).toBe(
      "unverifiable",
    );
    expect(
      assessCameraStability(reference, texture(240, 180, 123), []).state,
    ).toBe("unverifiable");
    expect(
      assessCameraStability(reference, transform(original, 45, 40), []).state,
    ).toBe("unverifiable");
    expect(createCameraReference(original, [whole])).toBeNull();
  });
  it("cannot establish stability from flat, one-dimensional, periodic or spatially concentrated texture", () => {
    const flat = {
      ...original,
      data: new Uint8Array(original.data.length).fill(128),
    };
    const stripes = {
      ...flat,
      data: Uint8Array.from(flat.data, (_, i) =>
        (i % original.width) % 8 < 4 ? 30 : 220,
      ),
    };
    const periodic = {
      ...flat,
      data: Uint8Array.from(flat.data, (_, i) =>
        (i % original.width) % 8 < 4 !== Math.floor(i / original.width) % 8 < 4
          ? 30
          : 220,
      ),
    };
    const local = { ...flat, data: new Uint8Array(flat.data) };
    for (let y = 0; y < 70; y++)
      for (let x = 0; x < 90; x++)
        local.data[y * local.width + x] = original.data[y * original.width + x];
    for (const frame of [flat, stripes, periodic, local])
      expect(createCameraReference(frame, [])).toBeNull();
    expect(assessCameraStability(reference, flat, []).state).toBe(
      "unverifiable",
    );
  });
  it("copies caller pixels and hides immutable baseline data", () => {
    const frame = texture();
    const saved = createCameraReference(frame, [])!;
    const copy = { ...frame, data: new Uint8Array(frame.data) };
    frame.data.fill(0);
    expect(Object.isFrozen(saved)).toBe(true);
    expect(Object.keys(saved).sort()).toEqual([
      "featureCount",
      "height",
      "sampledHeight",
      "sampledWidth",
      "width",
    ]);
    expect(assessCameraStability(saved, copy, []).state).toBe("stable");
    expect(
      assessCameraStability({ ...saved } as CameraReference, copy, []).state,
    ).toBe("unverifiable");
  });
  it("handles RGB/RGBA and offscreen masks without corrupting exclusions", () => {
    for (const channels of [3, 4] as const) {
      const data = new Uint8ClampedArray(original.data.length * channels);
      for (let i = 0; i < original.data.length; i++) {
        data[i * channels] =
          data[i * channels + 1] =
          data[i * channels + 2] =
            original.data[i];
        if (channels === 4) data[i * channels + 3] = 255;
      }
      const frame = { ...original, channels, data };
      expect(
        assessCameraStability(reference, frame, [
          detection([-100, 20, 2, 2]),
          detection([10000, 20, 20, 20]),
        ]).state,
      ).toBe("stable");
    }
  });
  it("rejects malformed frames/detections and treats resolution changes as moved", () => {
    expect(createCameraReference({ ...original, width: 2.5 }, [])).toBeNull();
    expect(
      createCameraReference({ ...original, data: new Uint8Array(1) }, []),
    ).toBeNull();
    expect(
      createCameraReference(original, [
        { ...detection([1, 1, 1, 1]), bbox: [NaN, 1, 1, 1] },
      ]),
    ).toBeNull();
    expect(assessCameraStability(reference, texture(241, 180), []).state).toBe(
      "moved",
    );
  });
});
describe("final numerical registration support", () => {
  it("rejects a seeded fit whose final residual support drops below80% after refitting", () => {
    let seed = 71;
    const random = () => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed / 2 ** 32;
    };
    let matches: {
      x: number;
      y: number;
      u: number;
      v: number;
    }[] = [];
    for (let batch = 0; batch < 10; batch++) {
      matches = [];
      for (let row = 0; row < 4; row++)
        for (let column = 0; column < 6; column++)
          for (let j = 0; j < 2; j++) {
            const x = 20 + 62 * column + 10 * j,
              y = 20 + 58 * row + 10 * j;
            matches.push({
              x,
              y,
              u: x + 3 * (random() - 0.5),
              v: y + 1.5 * (random() - 0.5),
            });
          }
    }
    const result = fitCameraCorrespondences(
      matches,
      { width: 384, height: 256 },
      { width: 384, height: 256, featureCount: 48 },
    );
    expect(result.state).toBe("unverifiable");
    expect(result.matched).toBe(38);
    expect(result.displacementPixels).toBeNull();
    expect(result.reason).toContain("final registration fit");
  });
});
describe("available real Nest frame smoke", () => {
  const path = "artifacts/nest-validation-frame.jpg";
  it.skipIf(!existsSync(path))(
    "uses bounded sampling and rejects a known native-resolution subpixel shift",
    async () => {
      const { data, info } = await sharp(path)
        .greyscale()
        .raw()
        .toBuffer({ resolveWithObject: true });
      const frame: CameraFrame = {
        data,
        width: info.width,
        height: info.height,
        channels: 1,
      };
      const reference = createCameraReference(frame, [])!;
      expect(reference).not.toBeNull();
      expect(reference.sampledWidth).toBeLessThanOrEqual(384);
      expect(reference.sampledHeight).toBeLessThanOrEqual(256);
      expect(assessCameraStability(reference, frame, []).state).toBe("stable");
      const moved = assessCameraStability(
        reference,
        transform(frame, 8.4, 3.7),
        [],
      );
      expect(moved.state).not.toBe("stable");
      if (moved.displacementPixels !== null)
        expect(moved.displacementPixels).toBeGreaterThan(7);
    },
  );
});
