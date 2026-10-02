import test from "node:test";
import assert from "node:assert/strict";
import { allowedDownload, trustedUrl } from "./policies.mjs";

const origin = "http://127.0.0.1:31415";
test("desktop exports accept local, same-origin blob and raster base64 images", () => {
  for (const url of [
    `${origin}/api/export`,
    `blob:${origin}/952c8bf3-d55b-4762-91c9-ed05ed281e70`,
    "data:image/jpeg;base64,/9j/aabb==",
    "data:image/png;base64,iVBORw0K",
    "data:image/webp;base64,UklGRg==",
  ])
    assert.equal(allowedDownload(url, origin), true, url);
});
test("desktop exports reject active data content, foreign blobs and remote URLs", () => {
  for (const url of [
    "data:text/html;base64,PHNjcmlwdD4=",
    "data:image/svg+xml;base64,PHN2Zz4=",
    "data:image/png,<script>alert(1)</script>",
    "data:image/png;base64,aabb==#payload",
    "data:image/png;base64,",
    "blob:https://example.com/file",
    "blob:http://127.0.0.1:314159/file",
    "http://127.0.0.1:314159/api/export",
    "https://example.com/export",
    "file:///C:/private.txt",
  ])
    assert.equal(allowedDownload(url, origin), false, url);
});
test("desktop navigation trust requires a complete exact origin", () => {
  assert.equal(trustedUrl(`${origin}/#live-traffic`, origin), true);
  for (const url of [
    "not a URL",
    "file:///C:/private",
    "http://127.0.0.1:314159",
    "http://127.0.0.1:31415@evil.example",
    "https://127.0.0.1:31415",
  ])
    assert.equal(trustedUrl(url, origin), false, url);
  assert.equal(trustedUrl(origin, null), false);
});
