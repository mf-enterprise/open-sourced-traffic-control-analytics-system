import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const manifestPath = join(root, "desktop/native-source-manifest.json");
const output = join(root, "release/Native-Sources-sharp-0.35.5");
const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
await mkdir(join(output, "archives"), { recursive: true });
async function hash(path) {
  const digest = createHash("sha256");
  for await (const part of createReadStream(path)) digest.update(part);
  return digest.digest("hex");
}
async function obtain(entry) {
  if (
    !/^[a-zA-Z0-9_.+-]+$/.test(entry.file) ||
    !/^[a-f0-9]{64}$/.test(entry.sha256)
  )
    throw new Error("Invalid source manifest entry");
  const path = join(output, "archives", entry.file);
  try {
    if ((await hash(path)) === entry.sha256)
      return {
        component: entry.component,
        file: entry.file,
        sha256: entry.sha256,
        bytes: (await stat(path)).size,
        cached: true,
      };
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const errors = [];
  for (const url of [entry.url, ...(entry.alternateUrls ?? [])]) {
    const pending = `${path}.part`;
    try {
      const response = await fetch(url, {
        signal: AbortSignal.timeout(120_000),
      });
      if (!response.ok || !response.body)
        throw new Error(`HTTP ${response.status}`);
      await pipeline(
        Readable.fromWeb(response.body),
        createWriteStream(pending),
      );
      const digest = await hash(pending);
      if (digest !== entry.sha256)
        throw new Error(`SHA256 mismatch: ${digest}`);
      await rename(pending, path);
      return {
        component: entry.component,
        file: entry.file,
        sha256: digest,
        bytes: (await stat(path)).size,
        url,
      };
    } catch (error) {
      await rm(pending, { force: true });
      errors.push(`${url}: ${error.message}`);
    }
  }
  throw new Error(errors.join("; "));
}
const entries = [...manifest.sources];
const results = [];
await Promise.all(
  Array.from({ length: 4 }, async () => {
    while (entries.length) {
      const entry = entries.shift();
      try {
        const result = await obtain(entry);
        results.push(result);
        console.log(`verified ${entry.component} (${result.bytes} bytes)`);
      } catch (error) {
        results.push({ component: entry.component, error: error.message });
        console.error(`FAILED ${entry.component}: ${error.message}`);
      }
    }
  }),
);
results.sort((a, b) => a.component.localeCompare(b.component));
await writeFile(
  join(output, "download-verification.json"),
  JSON.stringify({ checkedAt: new Date().toISOString(), results }, null, 2) +
    "\n",
);
await writeFile(
  join(output, "native-source-manifest.json"),
  await readFile(manifestPath),
);
if (results.some((result) => result.error)) process.exitCode = 1;
