import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
let shared;
export async function loadVisionShared() {
  return (shared ??= (async () => {
    let code, manifest;
    try {
      [code, manifest] = await Promise.all([
        readFile(
          new URL("./generated/vision-shared.mjs", import.meta.url),
          "utf8",
        ),
        readFile(
          new URL("./generated/vision-shared.manifest.json", import.meta.url),
          "utf8",
        ).then(JSON.parse),
      ]);
    } catch (error) {
      throw new Error(
        "Shared server vision bundle is missing. Run node scripts/build-server-vision.mjs before starting the service.",
        { cause: error },
      );
    }
    if (
      createHash("sha256").update(code).digest("hex") !== manifest.bundleSha256
    )
      throw new Error(
        "Shared server vision bundle checksum mismatch. Rebuild it with node scripts/build-server-vision.mjs.",
      );
    const module = await import(
      "data:text/javascript;base64," + Buffer.from(code).toString("base64")
    );
    return {
      ...module,
      sourceHashes: manifest.sourceHashes,
      bundleSha256: manifest.bundleSha256,
    };
  })());
}
