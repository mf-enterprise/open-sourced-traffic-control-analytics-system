import test from "node:test";
import assert from "node:assert/strict";
import { resolveNestCamera } from "./nest.mjs";
const page = "https://video.nest.com/live/2VNgNDSgKs";
const camera = (overrides = {}) => ({
  where: "Triangle",
  name: "Fallback name",
  is_public: true,
  is_online: true,
  is_connected: true,
  is_streaming: true,
  is_streaming_enabled: true,
  live_stream_host: "stream-eu1-delta.dropcam.com:443",
  uuid: "c3e0b27a569a4ffe940fe54ef06da3b4",
  ...overrides,
});
const fetchCamera =
  (overrides = {}) =>
  async () =>
    Response.json({ status: 0, items: [camera(overrides)] });
test("public Nest resolution constructs a stable public HLS master from verified metadata", async () => {
  const calls = [];
  const fetchImpl = async (...args) => {
    calls.push(args);
    return Response.json({ status: 0, items: [camera()] });
  };
  const result = await resolveNestCamera(`${page}#player`, { fetchImpl });
  assert.deepEqual(result, {
    id: "nest-2VNgNDSgKs",
    name: "Triangle · Nest Cam",
    type: "nest",
    status: "live",
    sourcePage: page,
    playbackUrl:
      "https://stream-eu1-delta.dropcam.com/nexus_aac/c3e0b27a569a4ffe940fe54ef06da3b4/playlist.m3u8?public=2VNgNDSgKs",
  });
  assert.equal(calls.length, 1);
  assert.equal(
    calls[0][0],
    "https://video.nest.com/api/dropcam/cameras.get_by_public_token?token=2VNgNDSgKs",
  );
  assert.equal(calls[0][1].redirect, "error");
  assert.equal(calls[0][1].headers.Accept, "application/json");
  assert.equal(
    (await resolveNestCamera(`${page}/`, { fetchImpl: fetchCamera() }))
      .sourcePage,
    page,
  );
  assert.ok(calls[0][1].signal instanceof AbortSignal);
  assert.equal(calls[0][1].signal.aborted, false);
  assert.deepEqual(await resolveNestCamera(page, { fetchImpl }), result);
});
test("invalid Nest URLs are rejected before any network request", async () => {
  let requests = 0;
  const fetchImpl = async () => {
    requests++;
    throw new Error("Should not fetch");
  };
  for (const input of [
    null,
    42,
    "",
    "http://video.nest.com/live/2VNgNDSgKs",
    "https://video.nest.com.evil.example/live/2VNgNDSgKs",
    "https://user:password@video.nest.com/live/2VNgNDSgKs",
    "https://video.nest.com:444/live/2VNgNDSgKs",
    `${page}?password=test`,
    `${page}//`,
    "https://video.nest.com/embedded/live/2VNgNDSgKs",
    "https://video.nest.com/live/short",
    "https://video.nest.com/live/a%2fb12345",
    "https://video.nest.com/other/../live/2VNgNDSgKs",
    "https://video.nest.com\\live\\2VNgNDSgKs",
    `https://video.nest.com/live/${"a".repeat(65)}`,
  ])
    await assert.rejects(
      resolveNestCamera(input, { fetchImpl }),
      (error) => error.status === 400,
    );
  assert.equal(requests, 0);
});
test("non-public, offline, and disabled cameras never yield a playback URL", async () => {
  await assert.rejects(
    resolveNestCamera(page, { fetchImpl: fetchCamera({ is_public: false }) }),
    (error) => error.status === 403,
  );
  for (const flag of [
    "is_online",
    "is_connected",
    "is_streaming",
    "is_streaming_enabled",
  ]) {
    await assert.rejects(
      resolveNestCamera(page, { fetchImpl: fetchCamera({ [flag]: false }) }),
      (error) => error.status === 409,
    );
  }
});
test("metadata cannot redirect playback to an arbitrary host or inject a path", async () => {
  for (const host of [
    "127.0.0.1:443",
    "dropcam.com.evil.example",
    "dropcam.com",
    "stream.dropcam.com:80",
    "stream.dropcam.com/evil",
    "user@stream.dropcam.com",
    "stream.dropcam.com?foo=bar",
    "stream..dropcam.com",
    "stream.dropcam.com:443\\outside",
    "-bad.dropcam.com",
    "stream.dropcam.com#fragment",
  ])
    await assert.rejects(
      resolveNestCamera(page, {
        fetchImpl: fetchCamera({ live_stream_host: host }),
      }),
      (error) => error.status === 502,
    );
  for (const uuid of [
    "../private",
    "not-a-camera",
    "c3e0b27a569a4ffe940fe54ef06da3b4?x=y",
    "a".repeat(33),
  ]) {
    await assert.rejects(
      resolveNestCamera(page, { fetchImpl: fetchCamera({ uuid }) }),
      (error) => error.status === 502,
    );
  }
  const hyphenated = await resolveNestCamera(page, {
    fetchImpl: fetchCamera({
      uuid: "C3E0B27A-569A-4FFE-940F-E54EF06DA3B4",
      where: "  ",
    }),
  });
  assert.match(
    hyphenated.playbackUrl,
    /\/c3e0b27a-569a-4ffe-940f-e54ef06da3b4\/playlist\.m3u8/,
  );
  assert.equal(hyphenated.name, "Fallback name · Nest Cam");
});
test("upstream errors are actionable and raw transport details are not leaked", async () => {
  for (const [status, expected] of [
    [201, 502],
    [401, 403],
    [403, 403],
    [404, 404],
    [500, 502],
  ]) {
    await assert.rejects(
      resolveNestCamera(page, {
        fetchImpl: async () => new Response("failure", { status }),
      }),
      (error) => error.status === expected,
    );
  }
  for (const data of [
    { status: 1, items: [camera()] },
    { status: 0, items: null },
    null,
  ]) {
    await assert.rejects(
      resolveNestCamera(page, { fetchImpl: async () => Response.json(data) }),
      (error) => error.status === 502,
    );
  }
  await assert.rejects(
    resolveNestCamera(page, {
      fetchImpl: async () => Response.json({ status: 0, items: [] }),
    }),
    (error) => error.status === 404,
  );
  await assert.rejects(
    resolveNestCamera(page, {
      fetchImpl: async () => new Response("not JSON"),
    }),
    (error) => error.status === 502,
  );
  await assert.rejects(
    resolveNestCamera(page, {
      fetchImpl: async () => {
        throw new Error("private transport data");
      },
    }),
    (error) =>
      error.status === 502 && !error.message.includes("private transport data"),
  );
  await assert.rejects(
    resolveNestCamera(page, {
      fetchImpl: async () => {
        throw new DOMException("Timed out", "TimeoutError");
      },
    }),
    (error) => error.status === 504,
  );
});

test("snapshot hosts stay on Nest's image service and cancellation reaches metadata fetch", async () => {
  const trusted = await resolveNestCamera(page, {
    fetchImpl: fetchCamera({
      nexus_api_nest_domain_host: "nexusapi-eu1.camera.home.nest.com",
    }),
  });
  assert.equal(
    new URL(trusted.snapshotUrl).hostname,
    "nexusapi-eu1.camera.home.nest.com",
  );
  for (const host of [
    "127.0.0.1",
    "nexusapi-eu1.camera.home.nest.com.evil.example",
    "nexusapi-eu1.camera.home.nest.com/path",
    "user@nexusapi-eu1.camera.home.nest.com",
  ]) {
    const result = await resolveNestCamera(page, {
      fetchImpl: fetchCamera({ nexus_api_nest_domain_host: host }),
    });
    assert.equal(result.snapshotUrl, undefined);
  }
  const abort = new AbortController();
  let signal;
  const request = resolveNestCamera(page, {
    signal: abort.signal,
    fetchImpl: async (_url, options) => {
      signal = options.signal;
      return new Promise((_resolve, reject) =>
        signal.addEventListener("abort", () => reject(signal.reason), {
          once: true,
        }),
      );
    },
  });
  abort.abort();
  await assert.rejects(request, { status: 504 });
  assert.equal(signal.aborted, true);
});
