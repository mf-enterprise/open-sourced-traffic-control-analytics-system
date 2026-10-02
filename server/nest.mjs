import { HttpError } from "./validation.mjs";
const SHARE_URL =
  /^https:\/\/video\.nest\.com(?::443)?\/live\/([A-Za-z0-9]{6,64})\/?(?:#[^\r\n]*)?$/;
const STREAM_HOST =
  /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+dropcam\.com(?::443)?$/i;
const CAMERA_UUID =
  /^(?:[a-f0-9]{32}|[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12})$/i;
export async function resolveNestCamera(
  inputUrl,
  { fetchImpl = fetch, signal } = {},
) {
  if (typeof inputUrl !== "string" || inputUrl.length > 2048) {
    throw new HttpError(
      400,
      "Enter a public Nest camera link in the form https://video.nest.com/live/TOKEN.",
    );
  }
  const match = SHARE_URL.exec(inputUrl.trim());
  if (!match) {
    throw new HttpError(
      400,
      "Use an HTTPS public Nest /live/ link without credentials or query parameters.",
    );
  }
  const token = match[1];
  const sourcePage = `https://video.nest.com/live/${token}`;
  const endpoint = `https://video.nest.com/api/dropcam/cameras.get_by_public_token?token=${encodeURIComponent(token)}`;
  let response;
  let data;
  try {
    response = await fetchImpl(endpoint, {
      headers: { Accept: "application/json" },
      redirect: "error",
      signal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(10000)])
        : AbortSignal.timeout(10000),
    });
    if (response.status !== 200) {
      if (response.status === 401 || response.status === 403) {
        throw new HttpError(
          403,
          "Nest did not make this camera available publicly. Password-protected or account-only streams are not supported by this resolver.",
        );
      }
      if (response.status === 404)
        throw new HttpError(
          404,
          "This public Nest camera link is unavailable or has been revoked.",
        );
      throw new HttpError(
        502,
        `The public Nest service returned HTTP ${response.status}. Try again later.`,
      );
    }
    data = await response.json();
  } catch (error) {
    if (error instanceof HttpError) throw error;
    if (error?.name === "TimeoutError" || error?.name === "AbortError") {
      throw new HttpError(
        504,
        "The public Nest service did not respond within 10 seconds. Try again later.",
      );
    }
    throw new HttpError(
      502,
      "Could not read the public Nest camera metadata. Check the connection or retry later.",
    );
  }
  if (!data || data.status !== 0 || !Array.isArray(data.items)) {
    throw new HttpError(
      502,
      "Nest returned an unsuccessful or unsupported camera response.",
    );
  }
  const camera = data.items[0];
  if (!camera || typeof camera !== "object" || Array.isArray(camera)) {
    throw new HttpError(404, "No public camera was found for this Nest link.");
  }
  if (camera.is_public !== true) {
    throw new HttpError(
      403,
      "This Nest camera is not publicly shared. Use a currently public share link.",
    );
  }
  if (
    camera.is_online !== true ||
    camera.is_connected !== true ||
    camera.is_streaming !== true ||
    camera.is_streaming_enabled !== true
  ) {
    throw new HttpError(
      409,
      "This public Nest camera is offline or its live stream is disabled. Try again when the camera is online.",
    );
  }
  if (
    typeof camera.live_stream_host !== "string" ||
    camera.live_stream_host.length > 257 ||
    !STREAM_HOST.test(camera.live_stream_host)
  ) {
    throw new HttpError(502, "Nest returned an unsupported stream host.");
  }
  if (typeof camera.uuid !== "string" || !CAMERA_UUID.test(camera.uuid)) {
    throw new HttpError(502, "Nest returned an invalid camera identifier.");
  }
  const playback = new URL(
    `https://${camera.live_stream_host}/nexus_aac/${camera.uuid.toLowerCase()}/playlist.m3u8`,
  );
  playback.searchParams.set("public", token);
  let snapshotUrl;
  if (
    typeof camera.nexus_api_nest_domain_host === "string" &&
    /^nexusapi-[a-z0-9-]+\.camera\.home\.nest\.com$/.test(
      camera.nexus_api_nest_domain_host,
    )
  ) {
    const snapshot = new URL(
      `https://${camera.nexus_api_nest_domain_host}/get_image`,
    );
    snapshot.searchParams.set("uuid", camera.uuid.toLowerCase());
    snapshot.searchParams.set("width", "540");
    snapshot.searchParams.set("public", token);
    snapshotUrl = snapshot.href;
  }
  const rawName = [camera.where, camera.name].find(
    (value) => typeof value === "string" && value.trim(),
  );
  const name = rawName
    ? rawName
        .replace(/[\u0000-\u001f\u007f]/g, " ")
        .trim()
        .slice(0, 200)
    : "Shared camera";
  return {
    id: `nest-${token}`,
    name: `${name || "Shared camera"} · Nest Cam`,
    type: "nest",
    playbackUrl: playback.href,
    ...(snapshotUrl ? { snapshotUrl } : {}),
    status: "live",
    sourcePage,
  };
}
