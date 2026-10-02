import test from "node:test";
import assert from "node:assert/strict";
import { setImmediate as tick } from "node:timers/promises";
import sharp from "sharp";
import { createTrafficCameras, trafficCameraId } from "./traffic-cameras.mjs";
const frame = { width: 2, height: 2, rgb: Buffer.alloc(12, 80) };
const resolveNest = async () => ({
  playbackUrl: "https://camera.example/live.m3u8",
});

test("provider thumbnails use bounded image responses without starting a decoder", async () => {
  const image = await sharp(frame.rgb, {
    raw: { width: 2, height: 2, channels: 3 },
  })
    .jpeg()
    .toBuffer();
  let starts = 0,
    reads = 0;
  const directory = createTrafficCameras({
    resolveNest: async () => ({
      playbackUrl: "https://camera.example/live.m3u8",
      snapshotUrl: "https://nexusapi-eu1.camera.home.nest.com/get_image",
    }),
    fetchImpl: async (_url, options) => {
      reads++;
      assert.equal(options.redirect, "error");
      return new Response(image, { headers: { "content-type": "image/jpeg" } });
    },
    createSource: async () => {
      starts++;
      throw new Error("unexpected decoder");
    },
  });
  const result = await directory.snapshot(directory.list()[0].id);
  assert.equal((await sharp(result).metadata()).width, 480);
  assert.equal(reads, 1);
  assert.equal(starts, 0);
  await directory.close();
});

test("oversized provider image falls back to a bounded decoder capture", async () => {
  let starts = 0,
    stops = 0;
  const directory = createTrafficCameras({
    resolveNest: async () => ({
      playbackUrl: "https://camera.example/live.m3u8",
      snapshotUrl: "https://nexusapi-eu1.camera.home.nest.com/get_image",
    }),
    fetchImpl: async () =>
      new Response(Buffer.alloc(1048577), {
        headers: { "content-type": "image/jpeg" },
      }),
    createSource: async (_url, options) => {
      starts++;
      queueMicrotask(() => options.onFrame(frame));
      return {
        stop: async () => {
          stops++;
        },
      };
    },
  });
  const result = await directory.snapshot(directory.list()[0].id);
  assert.ok(result.length > 0);
  assert.equal(starts, 1);
  assert.equal(stops, 1);
  await directory.close();
});
test("directory only resolves listed cameras and identifies exact camera configurations", async () => {
  let requests = 0;
  const directory = createTrafficCameras({
    resolveNest: async () => {
      requests++;
      return resolveNest();
    },
  });
  const listed = directory.list();
  assert.equal(trafficCameraId(listed[0].config), listed[0].id);
  assert.equal(
    trafficCameraId({
      ...listed[0].config,
      url: listed[0].config.url + "?extra=1",
    }),
    null,
  );
  await assert.rejects(directory.playback("https://private.example/"), {
    status: 404,
  });
  assert.throws(() => directory.snapshot("unknown"), { status: 404 });
  assert.equal(requests, 0);
  listed[0].config.url = "changed";
  assert.notEqual(directory.list()[0].config.url, "changed");
  await directory.close();
});
test("snapshot requests share work, stop their decoder, and expire after one minute", async () => {
  let time = 100000,
    starts = 0,
    stops = 0;
  const directory = createTrafficCameras({
    resolveNest,
    now: () => time,
    createSource: async (_url, options) => {
      starts++;
      queueMicrotask(() => options.onFrame(frame));
      return {
        stop: async () => {
          stops++;
        },
      };
    },
  });
  const id = directory.list()[0].id;
  const a = directory.snapshot(id),
    b = directory.snapshot(id);
  assert.equal(a, b);
  const jpeg = await a;
  assert.equal(jpeg[0], 255);
  assert.equal(jpeg[1], 216);
  assert.equal(starts, 1);
  assert.equal(stops, 1);
  await directory.snapshot(id);
  assert.equal(starts, 1);
  time += 60001;
  await directory.snapshot(id);
  assert.equal(starts, 2);
  assert.equal(stops, 2);
  await directory.close();
});
test("at most two thumbnail decoders run and shutdown cancels active and queued work", async () => {
  let active = 0,
    peak = 0,
    stopped = 0;
  const directory = createTrafficCameras({
    resolveNest,
    createSource: async () => {
      active++;
      peak = Math.max(peak, active);
      return {
        stop: async () => {
          active--;
          stopped++;
        },
      };
    },
  });
  const pending = directory
    .list()
    .slice(0, 4)
    .map((camera) => directory.snapshot(camera.id));
  const results = Promise.allSettled(pending);
  await tick();
  assert.equal(active, 2);
  await directory.close();
  assert.equal(peak, 2);
  assert.equal(active, 0);
  assert.equal(stopped, 2);
  assert.ok((await results).every((result) => result.status === "rejected"));
});
test("shutdown while metadata is pending never opens a late decoder", async () => {
  let finish,
    starts = 0;
  const directory = createTrafficCameras({
    resolveNest: () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
    createSource: async () => {
      starts++;
    },
  });
  const pending = directory.snapshot(directory.list()[0].id);
  const rejected = assert.rejects(pending, { status: 503 });
  await tick();
  await directory.close();
  finish(await resolveNest());
  await rejected;
  await tick();
  assert.equal(starts, 0);
});
test("failed decoder cleanup prevents another capture and is reported at shutdown", async () => {
  const directory = createTrafficCameras({
    resolveNest,
    createSource: async (_url, options) => {
      queueMicrotask(() => options.onFrame(frame));
      return {
        stop: async () => {
          throw new Error("close failed");
        },
      };
    },
  });
  await assert.rejects(
    directory.snapshot(directory.list()[0].id),
    /close failed/,
  );
  assert.throws(() => directory.snapshot(directory.list()[1].id), {
    status: 503,
  });
  await assert.rejects(directory.close(), /cleanup could not be confirmed/);
});
