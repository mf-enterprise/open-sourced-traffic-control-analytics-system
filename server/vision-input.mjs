const INPUT_SIZE = 640;
const MAX_DIMENSION = 8192;
const MAX_PIXELS = 16777216;
export function prepareRgbTensor(
  rgb,
  width,
  height,
  crop = [0, 0, width, height],
) {
  if (
    !Number.isSafeInteger(width) ||
    !Number.isSafeInteger(height) ||
    width <= 0 ||
    height <= 0 ||
    width > MAX_DIMENSION ||
    height > MAX_DIMENSION ||
    width * height > MAX_PIXELS
  ) {
    throw new RangeError(
      "RGB frame dimensions must be positive integers no greater than 8192, with at most 16777216 pixels.",
    );
  }
  if (!(rgb instanceof Uint8Array)) {
    throw new TypeError("RGB pixels must be a Uint8Array or Buffer.");
  }
  if (rgb.length !== width * height * 3) {
    throw new RangeError(
      "RGB pixels must contain exactly width * height * 3 bytes.",
    );
  }
  if (
    !Array.isArray(crop) ||
    crop.length !== 4 ||
    !Array.from(crop).every(Number.isSafeInteger)
  ) {
    throw new TypeError(
      "Crop must contain four integer values: left, top, width, height.",
    );
  }
  const [left, top, cropWidth, cropHeight] = crop;
  if (
    left < 0 ||
    top < 0 ||
    cropWidth <= 0 ||
    cropHeight <= 0 ||
    left + cropWidth > width ||
    top + cropHeight > height
  ) {
    throw new RangeError(
      "Crop must be positive and entirely inside the RGB frame.",
    );
  }
  const ratio = Math.min(INPUT_SIZE / cropWidth, INPUT_SIZE / cropHeight);
  const targetWidth = Math.floor(cropWidth * ratio);
  const targetHeight = Math.floor(cropHeight * ratio);
  const plane = INPUT_SIZE * INPUT_SIZE;
  const data = new Float32Array(plane * 3).fill(114);
  for (let y = 0; y < targetHeight; y++) {
    const sy = Math.max(
      0,
      Math.min(cropHeight - 1, ((y + 0.5) * cropHeight) / targetHeight - 0.5),
    );
    const y0 = Math.floor(sy);
    const y1 = Math.min(cropHeight - 1, y0 + 1);
    const fy = sy - y0;
    for (let x = 0; x < targetWidth; x++) {
      const sx = Math.max(
        0,
        Math.min(cropWidth - 1, ((x + 0.5) * cropWidth) / targetWidth - 0.5),
      );
      const x0 = Math.floor(sx);
      const x1 = Math.min(cropWidth - 1, x0 + 1);
      const fx = sx - x0;
      const p00 = ((top + y0) * width + left + x0) * 3;
      const p10 = ((top + y0) * width + left + x1) * 3;
      const p01 = ((top + y1) * width + left + x0) * 3;
      const p11 = ((top + y1) * width + left + x1) * 3;
      for (let channel = 0; channel < 3; channel++) {
        const rgbChannel = 2 - channel;
        const upper =
          rgb[p00 + rgbChannel] * (1 - fx) + rgb[p10 + rgbChannel] * fx;
        const lower =
          rgb[p01 + rgbChannel] * (1 - fx) + rgb[p11 + rgbChannel] * fx;
        data[channel * plane + y * INPUT_SIZE + x] = Math.round(
          upper * (1 - fy) + lower * fy,
        );
      }
    }
  }
  return data;
}
