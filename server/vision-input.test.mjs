import assert from "node:assert/strict";
import test from "node:test";
import { prepareRgbTensor } from "./vision-input.mjs";
const PLANE = 640 * 640;
const pixel = (tensor, x, y) => [
  tensor[y * 640 + x],
  tensor[PLANE + y * 640 + x],
  tensor[2 * PLANE + y * 640 + x],
];
test("RGB bytes become raw BGR NCHW floats without normalization or input mutation", () => {
  const rgb = Buffer.from([231, 117, 19]);
  const before = Buffer.from(rgb);
  const tensor = prepareRgbTensor(rgb, 1, 1);
  assert.ok(tensor instanceof Float32Array);
  assert.equal(tensor.length, PLANE * 3);
  assert.deepEqual(pixel(tensor, 0, 0), [19, 117, 231]);
  assert.deepEqual(pixel(tensor, 639, 639), [19, 117, 231]);
  assert.deepEqual(rgb, before);
  tensor[0] = 0;
  assert.deepEqual(rgb, before);
});
test("landscape and portrait resize against the top-left edge with gray114 padding", () => {
  const rgb = Uint8Array.from([40, 50, 60, 40, 50, 60]);
  const landscape = prepareRgbTensor(rgb, 2, 1);
  assert.deepEqual(pixel(landscape, 0, 0), [60, 50, 40]);
  assert.deepEqual(pixel(landscape, 639, 319), [60, 50, 40]);
  assert.deepEqual(pixel(landscape, 0, 320), [114, 114, 114]);
  const portrait = prepareRgbTensor(rgb, 1, 2);
  assert.deepEqual(pixel(portrait, 319, 639), [60, 50, 40]);
  assert.deepEqual(pixel(portrait, 320, 0), [114, 114, 114]);
});
test("the shorter resize dimension is floored exactly as in the temporal evaluator", () => {
  const rgb = new Uint8Array(3 * 2 * 3).fill(27);
  const tensor = prepareRgbTensor(rgb, 3, 2);
  assert.deepEqual(pixel(tensor, 639, 425), [27, 27, 27]);
  assert.deepEqual(pixel(tensor, 0, 426), [114, 114, 114]);
});
test("crop coordinates index the original RGB stride without sampling outside the crop", () => {
  const rgb = Uint8Array.from([
    255, 0, 0, 255, 0, 0, 255, 0, 0, 255, 0, 0, 10, 20, 30, 70, 80, 90,
  ]);
  const crop = [1, 1, 2, 1];
  const before = rgb.slice();
  const tensor = prepareRgbTensor(rgb, 3, 2, crop);
  assert.deepEqual(pixel(tensor, 0, 0), [30, 20, 10]);
  assert.deepEqual(pixel(tensor, 639, 319), [90, 80, 70]);
  assert.deepEqual(pixel(tensor, 0, 320), [114, 114, 114]);
  assert.deepEqual(rgb, before);
  assert.deepEqual(crop, [1, 1, 2, 1]);
});
test("half-pixel bilinear interpolation rounds to byte values before storing floats", () => {
  const rgb = Uint8Array.from([
    0, 0, 0, 100, 20, 60, 200, 40, 120, 100, 60, 240,
  ]);
  const tensor = prepareRgbTensor(rgb, 2, 2);
  assert.deepEqual(pixel(tensor, 319, 319), [105, 30, 100]);
  assert.deepEqual(pixel(tensor, 0, 0), [0, 0, 0]);
  assert.deepEqual(pixel(tensor, 639, 639), [240, 60, 100]);
});
test("rejects invalid frame dimensions before allocating or reading pixel data", () => {
  for (const [width, height] of [
    [0, 1],
    [-1, 1],
    [1, 0],
    [1.5, 1],
    [1, NaN],
    [Infinity, 1],
    [8193, 1],
    [1, 8193],
    [8192, 2049],
    [4097, 4096],
    [Number.MAX_SAFE_INTEGER, 1],
  ]) {
    assert.throws(
      () => prepareRgbTensor(new Uint8Array(), width, height),
      RangeError,
    );
  }
});
test("rejects non-byte inputs and byte lengths that do not exactly match the frame", () => {
  for (const rgb of [
    [1, 2, 3],
    new Uint8ClampedArray(3),
    new Float32Array(3),
    new ArrayBuffer(3),
    null,
  ]) {
    assert.throws(() => prepareRgbTensor(rgb, 1, 1), TypeError);
  }
  for (const length of [0, 2, 4]) {
    assert.throws(
      () => prepareRgbTensor(new Uint8Array(length), 1, 1),
      RangeError,
    );
  }
});
test("rejects malformed, fractional, empty, and out-of-frame crops", () => {
  const rgb = new Uint8Array(12);
  for (const crop of [
    null,
    {},
    [],
    [0, 0, 1],
    [0, 0, 1, 1, 1],
    [0, 0, 1.5, 1],
    [0, NaN, 1, 1],
    new Array(4),
  ]) {
    assert.throws(() => prepareRgbTensor(rgb, 2, 2, crop), TypeError);
  }
  for (const crop of [
    [-1, 0, 1, 1],
    [0, -1, 1, 1],
    [0, 0, 0, 1],
    [0, 0, 1, -1],
    [1, 0, 2, 1],
    [0, 1, 1, 2],
    [2, 0, 1, 1],
  ]) {
    assert.throws(() => prepareRgbTensor(rgb, 2, 2, crop), RangeError);
  }
});
test("accepts byte subarrays without using unrelated bytes from their backing buffer", () => {
  const backing = Uint8Array.from([255, 255, 255, 10, 20, 30, 255, 255, 255]);
  const tensor = prepareRgbTensor(backing.subarray(3, 6), 1, 1);
  assert.deepEqual(pixel(tensor, 320, 320), [30, 20, 10]);
});
