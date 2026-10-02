import { describe, expect, it } from "vitest";
import {
  decodeYoloxOutput,
  rgbaToBgrTensor,
  largeVehicleCrop,
  confirmsLargeVehicle,
  needsLargeVehicleVerification,
  LargeVehicleVerifier,
} from "./yolox";
import type { Detection } from "./types";
const dims = [1, 8400, 85];
function predictions() {
  return new Float32Array(8400 * 85);
}
function box(
  data: Float32Array,
  row: number,
  classId: number,
  cx: number,
  cy: number,
  width: number,
  height: number,
  objectness = 0.9,
  classScore = 0.9,
) {
  const offset = row * 85;
  data[offset] = cx / 8 - (row % 80);
  data[offset + 1] = cy / 8 - Math.floor(row / 80);
  data[offset + 2] = Math.log(width / 8);
  data[offset + 3] = Math.log(height / 8);
  data[offset + 4] = objectness;
  data[offset + 5 + classId] = classScore;
}
describe("YOLOX official export preprocessing and decoding", () => {
  it("preserves 0..255 BGR and transposes pixels into NCHW channels", () => {
    expect([
      ...rgbaToBgrTensor(
        new Uint8ClampedArray([10, 20, 30, 255, 40, 50, 60, 255]),
        2,
        1,
      ),
    ]).toEqual([30, 60, 20, 50, 10, 40]);
  });
  it("decodes raw grid offsets, exponentiated sizes and top-left letterbox scaling", () => {
    const data = predictions();
    box(data, 87, 2, 160, 120, 80, 40);
    const result = decodeYoloxOutput(data, dims, 1280, 720);
    expect(result).toHaveLength(1);
    expect(result[0].className).toBe("car");
    expect(result[0].score).toBeCloseTo(0.81);
    [240, 200, 160, 80].forEach((value, index) =>
      expect(result[0].bbox[index]).toBeCloseTo(value),
    );
  });
  it("uses objectness times class confidence and preserves low association detections", () => {
    const data = predictions();
    box(data, 1, 2, 160, 120, 80, 40, 0.7, 0.6);
    expect(decodeYoloxOutput(data, dims, 640, 640)).toHaveLength(1);
    expect(decodeYoloxOutput(data, dims, 640, 640, 0.55)).toHaveLength(0);
  });
  it("does not relabel a stronger non-road class as a vehicle", () => {
    const data = predictions();
    box(data, 1, 5, 160, 120, 80, 40, 0.9, 0.8);
    data[85 + 5 + 56] = 0.95;
    expect(decodeYoloxOutput(data, dims, 640, 640)).toEqual([]);
  });
  it("suppresses duplicate car/truck predictions but preserves spatially separate objects", () => {
    const data = predictions();
    box(data, 1, 2, 160, 120, 80, 40, 0.95, 0.95);
    box(data, 2, 7, 162, 122, 80, 40);
    box(data, 3, 0, 400, 120, 20, 80);
    const result = decodeYoloxOutput(data, dims, 640, 640);
    expect(result.map((item) => item.className)).toEqual(["car", "person"]);
  });
  it("rejects padding-center and nonfinite predictions and clips valid edge boxes", () => {
    const data = predictions();
    box(data, 1, 2, 160, 500, 80, 40);
    box(data, 2, 2, 160, 120, Infinity, 40);
    box(data, 3, 2, 10, 20, 40, 60);
    const result = decodeYoloxOutput(data, dims, 1280, 720);
    expect(result).toHaveLength(1);
    expect(result[0].bbox[0]).toBe(0);
    expect(result[0].bbox[1]).toBe(0);
    expect(result[0].bbox[2]).toBeCloseTo(60);
    expect(result[0].bbox[3]).toBeCloseTo(100);
  });
  it("checks the raw export shape instead of silently decoding an incompatible model", () => {
    expect(() =>
      decodeYoloxOutput(predictions(), [1, 3549, 85], 640, 640),
    ).toThrow("shape");
    expect(decodeYoloxOutput(predictions(), dims, 0, 640)).toEqual([]);
  });
});
describe("large vehicle contextual verification", () => {
  const bus = (x = 100, score = 0.65): Detection => ({
    className: "bus",
    score,
    bbox: [x, 100, 100, 200],
  });
  const cropView = (
    original: Detection,
    crop: Detection["bbox"],
    score = 0.8,
  ): Detection => ({
    ...original,
    score,
    bbox: [
      original.bbox[0] - crop[0],
      original.bbox[1] - crop[1],
      original.bbox[2],
      original.bbox[3],
    ],
  });
  it("leaves cars and other classes unchanged at all confidences and sizes", async () => {
    const original = ["car", "motorcycle", "bicycle", "person"].map(
      (className): Detection => ({
        className,
        score: 0.36,
        bbox: [0, 0, 640, 640],
      }),
    );
    const verifier = new LargeVehicleVerifier();
    const result = await verifier.verify(original, 640, 640, 0, async () => {
      throw new Error(
        "Ordinary road users must not enter the verification queue",
      );
    });
    expect(result).toEqual(original);
    original.forEach((item, index) => expect(result[index]).toBe(item));
  });
  it("requires uncertainty or large area, without rejecting confident ordinary-size trucks", () => {
    expect(needsLargeVehicleVerification(bus(), 1280, 720)).toBe(true);
    expect(
      needsLargeVehicleVerification(
        { ...bus(), className: "truck", score: 0.95 },
        1280,
        720,
      ),
    ).toBe(false);
    expect(
      needsLargeVehicleVerification(
        { ...bus(), score: 0.99, bbox: [0, 0, 800, 400] },
        1280,
        720,
      ),
    ).toBe(true);
  });
  it("maps a padded higher-scale crop back into original frame pixels", () => {
    const original = bus();
    const crop = largeVehicleCrop(original, 1280, 720);
    expect(crop).toEqual([80, 60, 140, 280]);
    expect(
      confirmsLargeVehicle(original, crop, [cropView(original, crop)]),
    ).toBe(true);
    expect(confirmsLargeVehicle(original, crop, [original])).toBe(false);
  });
  it("accepts a partially visible bus at the image boundary with consistent cropped evidence", () => {
    const original: Detection = { ...bus(), bbox: [0, 0, 80, 160] };
    const crop = largeVehicleCrop(original, 1280, 720);
    expect(crop).toEqual([0, 0, 96, 192]);
    expect(
      confirmsLargeVehicle(original, crop, [cropView(original, crop, 0.6)]),
    ).toBe(true);
  });
  it("requires a spatially consistent large vehicle and sufficient independent score", () => {
    const original = bus();
    const crop = largeVehicleCrop(original, 1280, 720);
    const matching = cropView(original, crop);
    expect(
      confirmsLargeVehicle(original, crop, [{ ...matching, className: "car" }]),
    ).toBe(false);
    expect(
      confirmsLargeVehicle(original, crop, [{ ...matching, score: 0.59 }]),
    ).toBe(false);
    expect(
      confirmsLargeVehicle(original, crop, [
        { ...matching, bbox: [110, 240, 20, 20] },
      ]),
    ).toBe(false);
    expect(
      confirmsLargeVehicle(original, crop, [
        { ...matching, className: "truck" },
      ]),
    ).toBe(true);
  });
  it("keeps original full-frame confidence and briefly caches both pass and failure", async () => {
    const verifier = new LargeVehicleVerifier();
    const original = bus();
    let calls = 0;
    const infer = async (crop: Detection["bbox"]) => {
      calls++;
      return [cropView(original, crop, 0.99)];
    };
    expect(await verifier.verify([original], 1280, 720, 0, infer)).toEqual([]);
    expect(await verifier.verify([original], 1280, 720, 100, infer)).toEqual(
      [],
    );
    expect(calls).toBe(1);
    const confirmed = await verifier.verify([original], 1280, 720, 120, infer);
    expect(confirmed[0]).toBe(original);
    expect(confirmed[0].score).toBe(0.65);
    await verifier.verify([original], 1280, 720, 500, infer);
    expect(calls).toBe(2);
    expect(
      await verifier.verify([original], 1280, 720, 870, async () => {
        calls++;
        return [];
      }),
    ).toEqual([]);
    expect(await verifier.verify([original], 1280, 720, 1000, infer)).toEqual(
      [],
    );
    expect(calls).toBe(3);
  });
  it("does not let a full-frame confidence rise bypass a prior contextual rejection", async () => {
    const verifier = new LargeVehicleVerifier();
    const original = bus();
    let calls = 0;
    expect(
      await verifier.verify([original], 1280, 720, 0, async () => {
        calls++;
        return [];
      }),
    ).toEqual([]);
    const stronger = { ...original, score: 0.95 };
    const infer = async (crop: Detection["bbox"]) => {
      calls++;
      return [cropView(stronger, crop)];
    };
    expect(await verifier.verify([stronger], 1280, 720, 100, infer)).toEqual(
      [],
    );
    expect(calls).toBe(1);
    expect(await verifier.verify([stronger], 1280, 720, 750, infer)).toEqual(
      [],
    );
    expect(await verifier.verify([stronger], 1280, 720, 870, infer)).toEqual([
      stronger,
    ]);
    expect(calls).toBe(3);
  });
  it("does not amplify one transient positive crop into repeated bus observations", async () => {
    const verifier = new LargeVehicleVerifier();
    const original = bus();
    let calls = 0;
    const infer = async (crop: Detection["bbox"]) => {
      calls++;
      return calls === 1 ? [cropView(original, crop)] : [];
    };
    for (const timestamp of [0, 100, 120, 220, 500]) {
      expect(
        await verifier.verify([original], 1280, 720, timestamp, infer),
      ).toEqual([]);
    }
    expect(calls).toBe(2);
  });
  it("requires a later frame rather than accepting two calls with the same timestamp", async () => {
    const verifier = new LargeVehicleVerifier();
    const original = bus();
    let calls = 0;
    const infer = async (crop: Detection["bbox"]) => {
      calls++;
      return [cropView(original, crop)];
    };
    for (const timestamp of [0, 0, 0, 119]) {
      expect(
        await verifier.verify([original], 1280, 720, timestamp, infer),
      ).toEqual([]);
    }
    expect(calls).toBe(1);
    expect(await verifier.verify([original], 1280, 720, 120, infer)).toEqual([
      original,
    ]);
  });
  it("bounds extra inference while giving a third queued truck its turn next frame", async () => {
    const verifier = new LargeVehicleVerifier();
    const originals = [bus(100), bus(400), bus(700)];
    let calls = 0;
    const infer = async (crop: Detection["bbox"]) => {
      calls++;
      const original = originals.find(
        (item) => largeVehicleCrop(item, 1280, 720)[0] === crop[0],
      )!;
      return [cropView(original, crop)];
    };
    expect(await verifier.verify(originals, 1280, 720, 0, infer)).toHaveLength(
      0,
    );
    expect(calls).toBe(2);
    expect(
      await verifier.verify(originals, 1280, 720, 100, infer),
    ).toHaveLength(0);
    expect(calls).toBe(3);
    expect(
      await verifier.verify(originals, 1280, 720, 120, infer),
    ).toHaveLength(2);
    expect(calls).toBe(5);
    expect(
      await verifier.verify(originals, 1280, 720, 220, infer),
    ).toHaveLength(3);
    expect(calls).toBe(6);
  });
  it("discards a crop finishing after reset and requires two fresh confirmations", async () => {
    const verifier = new LargeVehicleVerifier();
    const original = bus();
    let finish!: (detections: Detection[]) => void;
    let cropUsed!: Detection["bbox"];
    const pending = verifier.verify([original], 1280, 720, 0, (crop) => {
      cropUsed = crop;
      return new Promise<Detection[]>((resolve) => {
        finish = resolve;
      });
    });
    verifier.reset();
    finish([cropView(original, cropUsed)]);
    expect(await pending).toEqual([]);
    const infer = async (crop: Detection["bbox"]) => [cropView(original, crop)];
    expect(await verifier.verify([original], 1280, 720, 200, infer)).toEqual(
      [],
    );
    expect(await verifier.verify([original], 1280, 720, 320, infer)).toEqual([
      original,
    ]);
  });
  it("rechecks after source reset, resolution changes and clock rollback", async () => {
    const verifier = new LargeVehicleVerifier();
    const original = bus();
    let calls = 0;
    const infer = async (crop: Detection["bbox"]) => {
      calls++;
      return [cropView(original, crop)];
    };
    await verifier.verify([original], 1280, 720, 100, infer);
    await verifier.verify([original], 1920, 1080, 200, infer);
    await verifier.verify([original], 1920, 1080, 0, infer);
    verifier.reset();
    await verifier.verify([original], 1920, 1080, 100, infer);
    expect(calls).toBe(4);
  });
});
