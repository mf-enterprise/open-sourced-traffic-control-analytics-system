import { spawn as spawnChild } from "node:child_process";
import { performance } from "node:perf_hooks";
import { isAbsolute } from "node:path";
import { readLocalCameraSource } from "./local-cameras.mjs";
const MAX_WIDTH = 1280;
const MAX_HEIGHT = 720;
const MAX_PIPE_CHUNK = 1024 * 1024;
const PROTOCOL_WHITELIST = "http,https,tcp,tls,udp,rtp,crypto";
const PROTOCOLS = new Set(["http:", "https:", "rtsp:", "rtsps:"]);
const INVALID_TEXT = /[\u0000-\u0020\u007f]/u;
const invalidFrame = () =>
  new Error("The camera produced invalid or mismatched video frames.");
function validDimensions(width, height) {
  return (
    Number.isSafeInteger(width) &&
    Number.isSafeInteger(height) &&
    width > 0 &&
    height > 0 &&
    width <= MAX_WIDTH &&
    height <= MAX_HEIGHT
  );
}
export class PpmFrameParser {
  constructor(onFrame) {
    this.onFrame = onFrame;
    this.header = "";
    this.lines = 0;
    this.frame = null;
    this.offset = 0;
    this.index = 0;
  }
  push(chunk) {
    if (!(chunk instanceof Uint8Array)) throw invalidFrame();
    let offset = 0;
    while (offset < chunk.length) {
      if (!this.frame) {
        const byte = chunk[offset++];
        if (byte > 127 || this.header.length >= 128) throw invalidFrame();
        this.header += String.fromCharCode(byte);
        if (byte === 10) this.lines++;
        if (this.lines < 3) continue;
        const match = /^P6\r?\n([1-9]\d*)[ \t]+([1-9]\d*)\r?\n255\r?\n$/.exec(
          this.header,
        );
        if (!match) throw invalidFrame();
        const width = Number(match[1]),
          height = Number(match[2]);
        if (!validDimensions(width, height)) throw invalidFrame();
        this.frame = {
          rgb: Buffer.allocUnsafe(width * height * 3),
          width,
          height,
          index: this.index++,
        };
        this.header = "";
        this.lines = 0;
        this.offset = 0;
      }
      const length = Math.min(
        this.frame.rgb.length - this.offset,
        chunk.length - offset,
      );
      this.frame.rgb.set(chunk.subarray(offset, offset + length), this.offset);
      this.offset += length;
      offset += length;
      if (this.offset === this.frame.rgb.length) {
        const frame = this.frame;
        this.frame = null;
        this.offset = 0;
        if (this.onFrame(frame) === false) return offset;
      }
    }
    return offset;
  }
  finish() {
    if (this.frame || this.header) throw invalidFrame();
  }
}
export class FrameMetadataPairer {
  constructor(onFrame, maximumPending = 8) {
    if (
      !Number.isSafeInteger(maximumPending) ||
      maximumPending < 1 ||
      maximumPending > 64
    )
      throw new RangeError("Pending frame limit must be between 1 and 64.");
    this.onFrame = onFrame;
    this.maximumPending = maximumPending;
    this.frames = new Map();
    this.metadata = new Map();
    this.nextFrame = 0;
    this.nextMetadata = 0;
    this.nextPair = 0;
    this.timeBase = null;
  }
  pushFrame(frame) {
    if (
      frame.index !== this.nextFrame++ ||
      !validDimensions(frame.width, frame.height) ||
      !(frame.rgb instanceof Uint8Array) ||
      frame.rgb.length !== frame.width * frame.height * 3
    )
      throw invalidFrame();
    this.frames.set(frame.index, frame);
    this.pair();
    if (this.frames.size > this.maximumPending) throw invalidFrame();
  }
  pushLine(line) {
    if (/\[.*showinfo[^\]]*\].*config in time_base:/.test(line)) {
      const match = /config in time_base:\s*(\d+)\/(\d+)/.exec(line);
      const numerator = Number(match?.[1]),
        denominator = Number(match?.[2]);
      if (
        !Number.isSafeInteger(numerator) ||
        !Number.isSafeInteger(denominator) ||
        numerator <= 0 ||
        denominator <= 0
      )
        throw invalidFrame();
      this.timeBase = { numerator, denominator };
      return;
    }
    if (!/\[.*showinfo[^\]]*\].*\bn\s*:/.test(line)) return;
    const match =
      /\bn:\s*(\d+)\s+pts:\s*(-?\d+)\s+pts_time:\s*([^\s]+).*\bs:(\d+)x(\d+)\b/.exec(
        line,
      );
    if (!match || !this.timeBase) throw invalidFrame();
    const index = Number(match[1]),
      pts = Number(match[2]);
    const mediaSeconds =
      (pts * this.timeBase.numerator) / this.timeBase.denominator;
    const width = Number(match[4]),
      height = Number(match[5]);
    if (
      !Number.isSafeInteger(index) ||
      index !== this.nextMetadata++ ||
      !Number.isSafeInteger(pts) ||
      !Number.isFinite(Number(match[3])) ||
      !Number.isFinite(mediaSeconds) ||
      !validDimensions(width, height)
    )
      throw invalidFrame();
    this.metadata.set(index, { index, mediaSeconds, width, height });
    this.pair();
    if (this.metadata.size > this.maximumPending) throw invalidFrame();
  }
  pair() {
    while (this.frames.has(this.nextPair) && this.metadata.has(this.nextPair)) {
      const frame = this.frames.get(this.nextPair),
        metadata = this.metadata.get(this.nextPair);
      if (frame.width !== metadata.width || frame.height !== metadata.height)
        throw invalidFrame();
      this.frames.delete(this.nextPair);
      this.metadata.delete(this.nextPair++);
      this.onFrame({
        ...frame,
        mediaSeconds: metadata.mediaSeconds,
        receivedAt: Date.now(),
        receivedMonotonic: performance.now(),
      });
    }
  }
  finish() {
    if (this.frames.size || this.metadata.size) throw invalidFrame();
  }
}
function sourceInput(input, localFile) {
  const localCamera = readLocalCameraSource(input);
  if (localCamera) {
    if (localFile)
      throw new TypeError("Local cameras cannot use file capture options.");
    return localCamera;
  }
  if (
    typeof input !== "string" ||
    !input ||
    input.length > 4096 ||
    /[\u0000-\u001f\u007f]/u.test(input)
  )
    throw new TypeError("A valid camera source is required.");
  if (localFile) {
    if (!isAbsolute(input))
      throw new TypeError("Internal video files require an absolute path.");
    return { value: input, protocol: "file:" };
  }
  let url;
  try {
    if (
      INVALID_TEXT.test(input) ||
      /[\u0000-\u001f\u007f]/u.test(decodeURIComponent(input))
    )
      throw new Error();
    url = new URL(input);
  } catch {
    throw new TypeError("Enter a valid network camera URL.");
  }
  if (!PROTOCOLS.has(url.protocol) || !url.hostname || url.hash)
    throw new TypeError(
      "Camera sources require HTTP, HTTPS, RTSP, or RTSPS without a URL fragment.",
    );
  return { value: url.href, protocol: url.protocol };
}
function positiveOption(value, fallback, name, maximum) {
  const result = value ?? fallback;
  if (!Number.isFinite(result) || result <= 0 || result > maximum)
    throw new RangeError(`${name} is outside its supported range.`);
  return result;
}
export function frameSourceArguments(input, options = {}) {
  const source = sourceInput(input, options.localFile === true);
  const fps = positiveOption(options.fps, 10, "Sampling rate", 60);
  const rtsp = source.protocol === "rtsp:" || source.protocol === "rtsps:";
  const tls = source.protocol === "https:" || source.protocol === "rtsps:";
  const localCamera = source.protocol === "dshow:";
  const paceOutput =
    source.protocol === "http:" || source.protocol === "https:";
  return [
    "-hide_banner",
    "-loglevel",
    "info",
    "-nostdin",
    "-copyts",
    "-thread_queue_size",
    localCamera ? "4" : "512",
    ...(localCamera
      ? [
          "-f",
          "dshow",
          "-rtbufsize",
          "67108864",
          "-use_video_device_timestamps",
          "1",
        ]
      : [
          "-protocol_whitelist",
          `${options.localFile ? "file," : ""}${PROTOCOL_WHITELIST}`,
        ]),
    ...(options.localFile || localCamera
      ? []
      : [
          ...(tls ? ["-tls_verify", "1"] : []),
          ...(rtsp
            ? ["-rtsp_transport", "tcp", "-timeout", "10000000"]
            : [
                "-rw_timeout",
                "10000000",
                "-reconnect",
                "1",
                "-reconnect_streamed",
                "1",
                "-reconnect_delay_max",
                "2",
              ]),
        ]),
    "-i",
    source.value,
    "-map",
    "0:v:0",
    "-an",
    "-sn",
    "-dn",
    "-filter_threads",
    "1",
    "-vf",
    `select='isnan(prev_selected_t)+lt(t,prev_selected_t)+gt(floor(t*${fps}+0.000001),floor(prev_selected_t*${fps}+0.000001))',${paceOutput ? "realtime=limit=2:speed=1," : ""}scale=w='min(1280,iw)':h='min(720,ih)':force_original_aspect_ratio=decrease,format=rgb24,showinfo`,
    "-fps_mode",
    "passthrough",
    "-threads",
    "1",
    "-c:v",
    "ppm",
    "-f",
    "image2pipe",
    "pipe:1",
  ];
}
export async function createFrameSource(input, options = {}) {
  if (typeof options.onFrame !== "function")
    throw new TypeError("A frame consumer is required.");
  const args = frameSourceArguments(input, options);
  if (
    options.maximumPending !== undefined &&
    (!Number.isSafeInteger(options.maximumPending) ||
      options.maximumPending < 1 ||
      options.maximumPending > 64)
  )
    throw new RangeError("Pending frame limit must be between 1 and 64.");
  const startupTimeout = positiveOption(
    options.startupTimeoutMs,
    30000,
    "Startup timeout",
    300000,
  );
  const frameTimeout = positiveOption(
    options.frameTimeoutMs,
    15000,
    "Frame timeout",
    300000,
  );
  const killTimeout = positiveOption(
    options.killTimeoutMs,
    2000,
    "Stop timeout",
    30000,
  );
  const executable =
    options.ffmpegPath ?? (await import("ffmpeg-static")).default;
  if (typeof executable !== "string" || !executable)
    throw new Error("The camera decoder is unavailable.");
  if (input && typeof input === "object") readLocalCameraSource(input);
  let child;
  try {
    child = (options.spawn ?? spawnChild)(executable, args, {
      windowsHide: true,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch {
    throw new Error("The camera decoder could not start.");
  }
  let resolveCompletion, rejectCompletion;
  const completion = new Promise((resolve, reject) => {
    resolveCompletion = resolve;
    rejectCompletion = reject;
  });
  void completion.catch(() => {});
  let closed = false,
    stopping = false,
    failure = null,
    consuming = false,
    latest = null;
  let receivedFrames = 0;
  let stderrPartial = "",
    frameTimer,
    killTimer,
    settled = false;
  let stdoutPending = null,
    stderrPending = "",
    draining = false;
  const settle = () => {
    if (!closed || consuming || latest || settled) return;
    settled = true;
    clearTimeout(frameTimer);
    clearTimeout(killTimer);
    if (failure) rejectCompletion(failure);
    else resolveCompletion();
  };
  const terminate = () => {
    if (stopping) return;
    stopping = true;
    latest = null;
    stdoutPending = null;
    stderrPending = "";
    stderrPartial = "";
    child.stdout.resume();
    child.stderr.resume();
    clearTimeout(frameTimer);
    if (!closed) {
      try {
        child.kill("SIGTERM");
      } catch {}
      killTimer = setTimeout(() => {
        if (!closed) {
          try {
            child.kill("SIGKILL");
          } catch {}
        }
      }, killTimeout);
      killTimer.unref?.();
    }
    settle();
  };
  const fail = (message) => {
    if (!failure && !stopping) {
      failure = new Error(message);
      try {
        options.onError?.(failure);
      } catch {}
    }
    terminate();
  };
  const armWatchdog = (milliseconds, message) => {
    clearTimeout(frameTimer);
    frameTimer = setTimeout(() => fail(message), milliseconds);
    frameTimer.unref?.();
  };
  const pump = async () => {
    if (consuming) return;
    consuming = true;
    try {
      while (latest && !stopping) {
        const frame = latest;
        latest = null;
        await options.onFrame(frame);
      }
    } catch {
      fail("The video frame consumer stopped unexpectedly.");
    } finally {
      consuming = false;
      settle();
    }
  };
  const pairer = new FrameMetadataPairer((frame) => {
    if (stopping) return;
    receivedFrames++;
    armWatchdog(
      frameTimeout,
      "No camera frames arrived within the allowed interval. Reconnect the source.",
    );
    latest = frame;
    void pump();
  }, options.maximumPending ?? 8);
  const parser = new PpmFrameParser((frame) => {
    pairer.pushFrame(frame);
    return !stopping && pairer.frames.size < pairer.maximumPending;
  });
  const drainPipes = () => {
    if (draining || stopping) return;
    draining = true;
    let readingMetadata = false;
    try {
      let progressed;
      do {
        progressed = false;
        if (stdoutPending && pairer.frames.size < pairer.maximumPending) {
          readingMetadata = false;
          const chunk = stdoutPending;
          const consumed = parser.push(chunk);
          stdoutPending =
            consumed < chunk.length ? chunk.subarray(consumed) : null;
          progressed = consumed > 0;
        }
        readingMetadata = true;
        while (
          !stopping &&
          stderrPending &&
          pairer.metadata.size < pairer.maximumPending
        ) {
          const end = stderrPending.indexOf("\n");
          const part = end === -1 ? stderrPending : stderrPending.slice(0, end);
          if (stderrPartial.length + part.length > 8192) throw invalidFrame();
          stderrPartial += part;
          stderrPending = end === -1 ? "" : stderrPending.slice(end + 1);
          progressed = true;
          if (end !== -1) {
            pairer.pushLine(stderrPartial);
            stderrPartial = "";
          }
        }
      } while (!stopping && progressed && (stdoutPending || stderrPending));
    } catch {
      fail(
        readingMetadata
          ? "The camera decoder produced invalid frame metadata."
          : "The camera produced invalid or mismatched video frames.",
      );
    } finally {
      draining = false;
      if (!stopping) {
        if (stdoutPending || pairer.frames.size >= pairer.maximumPending)
          child.stdout.pause();
        else child.stdout.resume();
        if (stderrPending || pairer.metadata.size >= pairer.maximumPending)
          child.stderr.pause();
        else child.stderr.resume();
      }
    }
  };
  child.stdout.on("data", (chunk) => {
    if (stopping) return;
    if (
      !(chunk instanceof Uint8Array) ||
      (stdoutPending?.length ?? 0) + chunk.length > MAX_PIPE_CHUNK
    )
      return fail("The camera produced invalid or mismatched video frames.");
    stdoutPending = stdoutPending
      ? Buffer.concat([stdoutPending, chunk])
      : chunk;
    drainPipes();
  });
  child.stderr.on("data", (chunk) => {
    if (stopping) return;
    if (stderrPending.length + chunk.length > MAX_PIPE_CHUNK)
      return fail("The camera decoder produced invalid frame metadata.");
    stderrPending += chunk.toString("utf8");
    drainPipes();
  });
  child.on("error", () => {
    if (!child.pid) closed = true;
    fail("The camera decoder could not start or continue.");
    settle();
  });
  child.on("close", (code) => {
    closed = true;
    clearTimeout(frameTimer);
    clearTimeout(killTimer);
    if (!stopping) {
      try {
        if (stdoutPending || stderrPending) throw invalidFrame();
        if (stderrPartial) pairer.pushLine(stderrPartial);
        parser.finish();
        pairer.finish();
      } catch {
        fail("The camera stream ended with an incomplete video frame.");
      }
      if (
        !failure &&
        (code !== 0 || !options.localFile || receivedFrames === 0)
      )
        fail("The camera stream stopped. Check the source and reconnect.");
    }
    settle();
  });
  armWatchdog(
    startupTimeout,
    "The camera did not provide a video frame before startup timed out.",
  );
  return {
    completion,
    async stop() {
      terminate();
      await completion.catch(() => {});
    },
  };
}
