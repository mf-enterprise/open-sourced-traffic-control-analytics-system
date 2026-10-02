import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname, basename } from "node:path";
import { ensureVideoEngine } from "./runtime.mjs";

const bytes = Buffer.from("verified test binary");
const asset = {
  version: "test",
  bytes: bytes.length,
  sha256: createHash("sha256").update(bytes).digest("hex"),
  url: "https://example.invalid/engine",
};
async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), "traffic-desktop-runtime-"));
  t.after(async () => {
    if (
      dirname(directory) !== tmpdir() ||
      !basename(directory).startsWith("traffic-desktop-runtime-")
    )
      throw new Error("Cleanup boundary failed.");
    await rm(directory, { recursive: true, force: true });
  });
  return directory;
}
const response = (data = bytes, headers = {}) =>
  new Response(data, { status: 200, headers });

test("video runtime downloads, verifies and reuses the exact cached bytes", async (t) => {
  const directory = await fixture(t);
  let downloads = 0;
  const progress = [];
  const fetchImpl = async (url, options) => {
    downloads++;
    assert.equal(url, asset.url);
    assert.ok(options.signal);
    return response();
  };
  const first = await ensureVideoEngine(directory, {
    fetchImpl,
    asset,
    onProgress: (value) => progress.push(value),
  });
  assert.deepEqual(await readFile(first), bytes);
  assert.equal(await ensureVideoEngine(directory, { fetchImpl, asset }), first);
  assert.equal(downloads, 1);
  assert.equal(progress.at(-1).phase, "verified");
  assert.deepEqual(await readdir(directory), ["ffmpeg-test-win32-x64.exe"]);
});

test("corrupt cache is replaced only by an independently verified download", async (t) => {
  const directory = await fixture(t);
  const target = join(directory, "ffmpeg-test-win32-x64.exe");
  await writeFile(target, "bad cache");
  await ensureVideoEngine(directory, {
    asset,
    fetchImpl: async () => response(),
  });
  assert.deepEqual(await readFile(target), bytes);
});

test("wrong size, incomplete and altered downloads never become executable cache", async (t) => {
  const directory = await fixture(t);
  for (const download of [
    response(bytes, { "content-length": "200" }),
    response(bytes.subarray(1)),
    response(Buffer.alloc(bytes.length)),
    response(Buffer.alloc(bytes.length + 1)),
    new Response("denied", { status: 403 }),
  ]) {
    await assert.rejects(
      ensureVideoEngine(directory, { asset, fetchImpl: async () => download }),
    );
    assert.deepEqual(await readdir(directory), []);
  }
});

test("aborting during a streaming download closes and removes its partial file", async (t) => {
  const directory = await fixture(t);
  const controller = new AbortController();
  let chunks = 0;
  const fetchImpl = async () =>
    new Response(
      new ReadableStream({
        pull(stream) {
          if (chunks++ === 0) stream.enqueue(bytes.subarray(0, 3));
          else {
            controller.abort();
            stream.enqueue(bytes.subarray(3));
            stream.close();
          }
        },
      }),
    );
  await assert.rejects(
    ensureVideoEngine(directory, {
      asset,
      signal: controller.signal,
      fetchImpl,
    }),
    { name: "AbortError" },
  );
  assert.deepEqual(await readdir(directory), []);
});

test("network and progress callback failures cannot leave a partial runtime", async (t) => {
  const directory = await fixture(t);
  await assert.rejects(
    ensureVideoEngine(directory, {
      asset,
      fetchImpl: async () => {
        throw new Error("offline");
      },
    }),
    /offline/,
  );
  await assert.rejects(
    ensureVideoEngine(directory, {
      asset,
      fetchImpl: async () => response(),
      onProgress: ({ received }) => {
        if (received > 0) throw new Error("window closed");
      },
    }),
    /window closed/,
  );
  assert.deepEqual(await readdir(directory), []);
});
