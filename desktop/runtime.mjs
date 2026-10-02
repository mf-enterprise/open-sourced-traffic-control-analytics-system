import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, open, rename, rm } from "node:fs/promises";
import { join } from "node:path";

export const VIDEO_ENGINE = Object.freeze({
  version: "6.1.1",
  bytes: 82797568,
  sha256: "04e1307997530f9cf2fe35cba2ca7e8875ca91da02f89d6c7243df819c94ad00",
  url: "https://github.com/eugeneware/ffmpeg-static/releases/download/b6.1.1/ffmpeg-win32-x64",
  license: "GPL-3.0-or-later",
  source: "https://github.com/eugeneware/ffmpeg-static/releases/tag/b6.1.1",
});

export async function ensureVideoEngine(
  directory,
  {
    signal,
    onProgress = () => {},
    fetchImpl = fetch,
    asset = VIDEO_ENGINE,
  } = {},
) {
  signal?.throwIfAborted();
  await mkdir(directory, { recursive: true });
  const target = join(directory, `ffmpeg-${asset.version}-win32-x64.exe`);
  const verified = (bytes) =>
    bytes.length === asset.bytes &&
    createHash("sha256").update(bytes).digest("hex") === asset.sha256;
  try {
    if (verified(await readFile(target))) {
      signal?.throwIfAborted();
      onProgress({
        phase: "verified",
        received: asset.bytes,
        total: asset.bytes,
      });
      return target;
    }
  } catch (error) {
    signal?.throwIfAborted();
    if (error.code !== "ENOENT")
      throw new Error(
        "The video engine cache could not be read. Check available storage.",
      );
  }
  const temporary = join(directory, `.ffmpeg-${randomUUID()}.partial`);
  let file;
  try {
    signal?.throwIfAborted();
    onProgress({ phase: "downloading", received: 0, total: asset.bytes });
    const response = await fetchImpl(asset.url, {
      signal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(180000)])
        : AbortSignal.timeout(180000),
      redirect: "follow",
    });
    if (!response.ok || !response.body)
      throw new Error(
        "The video engine download failed. Check your internet connection and try again.",
      );
    const declared = response.headers.get("content-length");
    if (declared && Number(declared) !== asset.bytes)
      throw new Error("The video engine download has an unexpected size.");
    file = await open(temporary, "wx");
    const hash = createHash("sha256");
    let received = 0,
      lastUpdate = 0;
    for await (const chunk of response.body) {
      signal?.throwIfAborted();
      received += chunk.length;
      if (received > asset.bytes)
        throw new Error(
          "The video engine download exceeded its expected size.",
        );
      hash.update(chunk);
      await file.writeFile(chunk);
      if (Date.now() - lastUpdate >= 150) {
        onProgress({ phase: "downloading", received, total: asset.bytes });
        lastUpdate = Date.now();
      }
    }
    if (received !== asset.bytes || hash.digest("hex") !== asset.sha256)
      throw new Error(
        "The video engine failed its integrity check. Try the download again.",
      );
    await file.sync();
    await file.close();
    file = null;
    signal?.throwIfAborted();
    await rename(temporary, target);
    onProgress({ phase: "verified", received, total: asset.bytes });
    return target;
  } finally {
    await file?.close().catch(() => {});
    await rm(temporary, { force: true }).catch(() => {});
  }
}
