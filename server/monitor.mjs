import { randomUUID } from "node:crypto";
import sharp from "sharp";
import { setTimeout as delay } from "node:timers/promises";
import { HttpError, validateCase } from "./validation.mjs";
import { validateCameraConfig, resolveCameraInput } from "./cameras.mjs";
import { resolveNestCamera } from "./nest.mjs";
import { createFrameSource } from "./frame-source.mjs";
import { createMonitorEngine } from "./monitor-engine.mjs";
import { loadVisionShared } from "./vision-shared.mjs";
import { createAutomaticPlates } from "./automatic-plates.mjs";
import { trafficCameraId } from "./traffic-cameras.mjs";
const MOTOR = new Set(["car", "truck", "bus", "motorcycle"]);
const VEHICLES = new Set([...MOTOR, "bicycle"]);
const CLEANUP_ERROR =
  "Camera or detector cleanup could not be confirmed. Restart the local service before starting another monitoring session.";
const RECOVERY_ERROR =
  "Saved evidence could not be recovered. Check available storage and evidence integrity, then retry recovery before starting another camera.";
const recoveryError = (error) =>
  error instanceof HttpError
    ? `${RECOVERY_ERROR} ${error.message}`
    : RECOVERY_ERROR;
const clone = (value) => structuredClone(value);
const uncalibratedStability = () => ({
  state: "uncalibrated",
  reason: "Set a measured road calibration to enable guarded speed estimates.",
  matched: 0,
  displacementPixels: null,
});
const unconfiguredCountingStability = () => ({
  state: "uncalibrated",
  reason: "Set a count line to enable guarded crossing counts.",
  matched: 0,
  displacementPixels: null,
});
const unverifiableStability = (reason) => ({
  state: "unverifiable",
  reason,
  matched: 0,
  displacementPixels: null,
});
const stabilityFrame = (frame) => ({
  data: frame.rgb,
  width: frame.width,
  height: frame.height,
  channels: 3,
});
function frozenPayload(value) {
  const freeze = (item) => {
    if (item && typeof item === "object") {
      Object.values(item).forEach(freeze);
      Object.freeze(item);
    }
    return item;
  };
  return freeze(clone(value));
}
const iso = (value) => new Date(value).toISOString();
const emptyCrossings = () => ({
  total: 0,
  forward: 0,
  reverse: 0,
  classes: { car: 0, truck: 0, bus: 0, motorcycle: 0, bicycle: 0 },
});
function object(value, keys) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).some((key) => !keys.includes(key))
  )
    throw new HttpError(
      400,
      "The monitor configuration contains invalid or unsupported fields.",
    );
}
function speed(value) {
  if (!Number.isFinite(value) || value < 1 || value > 500)
    throw new HttpError(400, "Set a speed limit between 1 and 500 km/h.");
  return value;
}
function cameraConfig(camera) {
  if (camera?.type === "usb") {
    object(camera, ["type", "deviceId", "name"]);
    if (
      typeof camera.deviceId !== "string" ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
        camera.deviceId,
      )
    )
      throw new HttpError(
        400,
        "Select a USB camera from this computer's camera list.",
      );
    const name = camera.name ?? "USB camera";
    if (
      typeof name !== "string" ||
      name.length > 80 ||
      /[\u0000-\u001f\u007f]|[a-z][a-z\d+.-]*:\/\/|(?:data|blob):|[^\s:]+:[^\s@]+@/iu.test(
        name,
      )
    )
      throw new HttpError(
        400,
        "Use a camera name of at most 80 characters without its connection details.",
      );
    return {
      type: "usb",
      deviceId: camera.deviceId.toLowerCase(),
      name: name.trim() || "USB camera",
    };
  }
  if (camera?.type !== "nest") return validateCameraConfig(camera);
  object(camera, ["type", "url", "name"]);
  if (
    typeof camera.url !== "string" ||
    !/^https:\/\/video\.nest\.com\/live\/[A-Za-z0-9_-]+\/?$/.test(camera.url)
  )
    throw new HttpError(400, "Enter a public Nest live-camera sharing URL.");
  const name = camera.name ?? "Public Nest camera";
  if (
    typeof name !== "string" ||
    name.length > 80 ||
    /[\u0000-\u001f\u007f]|(?:https?|rtsps?):\/\//iu.test(name)
  )
    throw new HttpError(
      400,
      "Use a camera name of at most 80 characters without its URL.",
    );
  return {
    type: "nest",
    url: camera.url,
    name: name.trim() || "Public Nest camera",
  };
}
async function resolveSource(camera, { localCameras, signal } = {}) {
  if (camera.type === "usb") {
    if (!localCameras)
      throw new HttpError(
        503,
        "USB camera access is unavailable in this service.",
      );
    return localCameras.resolve(camera.deviceId, { signal });
  }
  if (camera.type !== "nest") return resolveCameraInput(camera);
  const result = await resolveNestCamera(camera.url);
  return { url: result.playbackUrl, name: camera.name, type: "nest" };
}
function point(value) {
  object(value, ["x", "y"]);
  if (![value.x, value.y].every((n) => Number.isFinite(n) && n >= 0 && n <= 1))
    throw new HttpError(400, "Geometry points must lie inside the frame.");
}
async function evidence(frame, track, limit, captureTime) {
  const footer = Math.max(32, Math.round(frame.width / 50));
  const [x, y, width, height] = track.bbox;
  const label = `DRAFT | #${track.id} | estimated ${track.speedKmh.toFixed(1)} km/h | limit ${limit} km/h | ${captureTime}`;
  const svg = `<svg width="${frame.width}" height="${frame.height + footer}"><rect x="${x}" y="${y}" width="${width}" height="${height}" fill="none" stroke="#ff943d" stroke-width="2"/><text x="12" y="${frame.height + footer * 0.68}" font-family="sans-serif" font-size="${Math.max(10, Math.min(16, frame.width / 72))}" fill="white">${label}</text></svg>`;
  const jpeg = await sharp(frame.rgb, {
    raw: { width: frame.width, height: frame.height, channels: 3 },
  })
    .extend({ bottom: footer, background: "#111820" })
    .composite([{ input: Buffer.from(svg) }])
    .jpeg({ quality: 86 })
    .toBuffer();
  return `data:image/jpeg;base64,${jpeg.toString("base64")}`;
}
export function createMonitor({
  store,
  journal = null,
  outbox = null,
  localCameras = null,
  resolveSource: resolveInput = (camera, options) =>
    resolveSource(camera, { ...options, localCameras }),
  createSource = createFrameSource,
  createEngine = createMonitorEngine,
  createPlateEngine,
  plateReadingEnabled = true,
  shared,
  now = Date.now,
  monotonic = () => performance.now(),
} = {}) {
  let current = null,
    closing = false;
  let recoveryInitialized = !outbox;
  const evidenceRecovery = { pending: 0, recovered: 0, error: null };
  function recoveryStatus() {
    if (outbox) {
      try {
        evidenceRecovery.pending = outbox.summary().pending;
      } catch (error) {
        evidenceRecovery.error = recoveryError(error);
      }
    }
    return { ...evidenceRecovery };
  }
  const blank = () => ({
    sessionId: null,
    state: "idle",
    message: "Connect a camera for continuous analysis.",
    sourceName: "",
    sourceType: null,
    trafficCameraId: null,
    startedAt: null,
    lastFrameAt: null,
    engine: null,
    config: {
      revision: 0,
      speedLimitKmh: 50,
      calibration: null,
      countingLine: null,
      referenceFrame: null,
    },
    stats: {
      observed: 0,
      active: 0,
      framesProcessed: 0,
      framesDropped: 0,
      analysisFps: 0,
      crossings: emptyCrossings(),
      casesCreated: 0,
      elapsedSeconds: 0,
      gapCount: 0,
      pendingCases: 0,
    },
    error: null,
    cameraStability: uncalibratedStability(),
    countingStability: unconfiguredCountingStability(),
    automaticPlates: {
      enabled: plateReadingEnabled,
      state: plateReadingEnabled ? "idle" : "disabled",
      pending: 0,
      reads: 0,
      reason: "Automatic plate candidates remain unverified.",
    },
    evidenceRecovery: recoveryStatus(),
  });
  function snapshot(ctx) {
    if (!ctx) return blank();
    const result = clone(ctx.status);
    result.evidenceRecovery = recoveryStatus();
    result.automaticPlates = ctx.plates.status();
    result.stats.elapsedSeconds = Math.max(
      0,
      ((ctx.endedMono ?? monotonic()) - ctx.startedMono) / 1000,
    );
    result.stats.pendingCases = ctx.pending.length;
    result.stats.pendingHistory = ctx.historyPending;
    if (
      result.state === "running" &&
      ctx.lastCompletedMono !== null &&
      monotonic() - ctx.lastCompletedMono > 3000
    ) {
      result.state = "stalled";
      result.message =
        "Waiting for fresh camera analysis. The displayed frame is stale.";
      result.stats.active = 0;
      result.stats.analysisFps = 0;
    }
    return result;
  }
  const status = () => snapshot(current);
  function checkpoint(ctx, reason) {
    if (!journal) return;
    const wasPending = ctx.historyPending;
    try {
      journal.checkpoint(snapshot(ctx), {
        reason,
        endedAt: ctx.endedAt === null ? null : iso(ctx.endedAt),
      });
      ctx.historyPending = false;
      ctx.lastCheckpointMono = monotonic();
      if (wasPending && ctx.endedAt !== null && ctx.pending.length === 0) {
        ctx.fatal = ctx.cleanupFailed ? CLEANUP_ERROR : null;
        ctx.status.error = ctx.fatal;
        ctx.status.message =
          ctx.fatal ||
          "Session history saved. Start a new monitoring session to resume.";
      }
    } catch {
      ctx.historyPending = true;
      ctx.fatal =
        "Session history could not be saved. Analysis stopped; keep the service running and retry saving before starting another camera.";
      throw new HttpError(503, ctx.fatal);
    }
  }
  function haltAfterSaveFailure(ctx) {
    ctx.abort.abort();
    void stopSource(ctx);
  }
  function cleanupFailed(ctx) {
    ctx.cleanupFailed = true;
    ctx.fatal ||= CLEANUP_ERROR;
  }
  function stopSource(ctx) {
    const source = ctx.source;
    if (!source) return Promise.resolve(true);
    const existing = ctx.sourceStops.get(source);
    if (existing) return existing;
    const stopping = Promise.resolve()
      .then(() => source.stop())
      .then(
        () => true,
        () => {
          cleanupFailed(ctx);
          return false;
        },
      );
    ctx.sourceStops.set(source, stopping);
    return stopping;
  }
  function waitForSource(ctx) {
    return new Promise((resolve, reject) => {
      const finish = (callback, value) => {
        ctx.abort.signal.removeEventListener("abort", aborted);
        callback(value);
      };
      const aborted = () => finish(resolve);
      Promise.resolve(ctx.source.completion).then(
        () => finish(resolve),
        (error) => finish(reject, error),
      );
      ctx.abort.signal.addEventListener("abort", aborted, { once: true });
      if (ctx.abort.signal.aborted) aborted();
    });
  }
  function live(ctx) {
    return current === ctx && !ctx.cancelled && !ctx.finalizing;
  }
  function consumeFrame(ctx, frame, segment) {
    const work = Promise.resolve().then(() => consume(ctx, frame, segment));
    ctx.frameJobs.add(work);
    work.then(
      () => ctx.frameJobs.delete(work),
      () => ctx.frameJobs.delete(work),
    );
    return work;
  }
  async function breakContinuity(ctx, countGap = true) {
    ctx.plates.reset(`${ctx.id}:${++ctx.plateEpoch}`);
    if (ctx.latest) ctx.latest.plateReadings = [];
    ctx.tracker.breakContinuity();
    ctx.counter.breakContinuity();
    if (ctx.status.config.calibration) {
      ctx.tracker.setCalibration(null);
      ctx.speedAuthorized = false;
      ctx.status.cameraStability = ctx.movedAssessment
        ? clone(ctx.movedAssessment)
        : unverifiableStability(
            "Waiting for fresh camera analysis to verify the calibrated view after an interruption.",
          );
    }
    if (ctx.status.config.countingLine) {
      ctx.countingAuthorized = false;
      ctx.status.countingStability = ctx.countingMovedAssessment
        ? clone(ctx.countingMovedAssessment)
        : unverifiableStability(
            "Waiting for fresh camera analysis to verify the counting view after an interruption.",
          );
    }
    ctx.status.stats.active = 0;
    if (countGap) ctx.status.stats.gapCount++;
    await ctx.engine.resetContext();
  }
  async function flush(ctx) {
    while (ctx.pending.length) {
      const item = ctx.pending[0];
      if (!item.enqueued) {
        item.value = outbox
          ? outbox.enqueue(ctx.id, item.payload)
          : validateCase(item.payload);
        item.enqueued = true;
      }
      const result = store.create(item.value);
      const eventId = item.value.record.clientEventId;
      verifyStoredEvidence(result);
      if (!ctx.storedEvents.has(eventId)) {
        ctx.status.stats.casesCreated++;
        ctx.storedEvents.add(eventId);
      }
      if (outbox) outbox.acknowledge(eventId, item.value.fingerprint);
      ctx.pending.shift();
    }
  }
  function verifyStoredEvidence(result) {
    if (typeof store.evidence === "function") store.evidence(result.case.id);
  }
  async function recoverEvidence() {
    if (current?.endedAt === null)
      throw new HttpError(
        409,
        "Stop the current monitor before recovering saved evidence.",
      );
    if (current?.pending.length)
      throw new HttpError(
        409,
        "Retry the current session's pending evidence before recovering other saved events.",
      );
    try {
      const seen = new Set();
      if (outbox) {
        for (let item; (item = outbox.peek());) {
          if (seen.has(item.eventId))
            throw new Error("Evidence acknowledgement did not advance.");
          seen.add(item.eventId);
          const result = store.create(item.value);
          verifyStoredEvidence(result);
          outbox.acknowledge(item.eventId, item.value.fingerprint);
          evidenceRecovery.recovered++;
        }
      }
      evidenceRecovery.error = null;
      recoveryInitialized = true;
    } catch (error) {
      evidenceRecovery.error = recoveryError(error);
    }
    return status();
  }
  async function retryRecovery(body = {}) {
    object(body, []);
    if (closing) throw new HttpError(409, "The service is shutting down.");
    const result = await recoverEvidence();
    if (result.evidenceRecovery.pending || result.evidenceRecovery.error)
      throw new HttpError(503, result.evidenceRecovery.error || RECOVERY_ERROR);
    return result;
  }
  function cameraReference(ctx, frame, detections) {
    try {
      return ctx.shared.createCameraReference(
        stabilityFrame(frame),
        detections,
      );
    } catch {
      return null;
    }
  }
  function referenceAssessment(ctx, reference, frame, detections, cache) {
    if (cache.has(reference)) return cache.get(reference);
    let assessment;
    try {
      assessment = reference
        ? ctx.shared.assessCameraStability(
            reference,
            stabilityFrame(frame),
            detections,
          )
        : null;
      if (
        !assessment ||
        !["stable", "moved", "unverifiable"].includes(assessment.state) ||
        typeof assessment.reason !== "string" ||
        !Number.isSafeInteger(assessment.matched) ||
        assessment.matched < 0 ||
        (assessment.displacementPixels !== null &&
          (!Number.isFinite(assessment.displacementPixels) ||
            assessment.displacementPixels < 0))
      )
        throw new Error("Invalid camera assessment");
      assessment = {
        state: assessment.state,
        reason: assessment.reason,
        matched: assessment.matched,
        displacementPixels: assessment.displacementPixels,
      };
    } catch {
      assessment = unverifiableStability(
        "The camera view could not be verified. Measurements are paused; choose a clear frozen reference if visibility does not recover.",
      );
    }
    cache.set(reference, assessment);
    return assessment;
  }
  function assessCamera(ctx, frame, detections, cache) {
    let assessment;
    if (!ctx.status.config.calibration) {
      assessment = uncalibratedStability();
    } else if (ctx.movedAssessment) {
      assessment = ctx.movedAssessment;
    } else {
      assessment = referenceAssessment(
        ctx,
        ctx.cameraAnchor,
        frame,
        detections,
        cache,
      );
      if (assessment.state === "moved") {
        ctx.movedAssessment = {
          ...assessment,
          reason:
            "Camera movement was detected. Recalibrate on a new frozen frame before speed estimates resume.",
        };
        assessment = ctx.movedAssessment;
      }
    }
    const allowed = assessment.state === "stable";
    if (allowed !== ctx.speedAuthorized) {
      ctx.tracker.setCalibration(
        allowed ? ctx.status.config.calibration : null,
      );
      ctx.speedAuthorized = allowed;
    }
    ctx.status.cameraStability = clone(assessment);
    return assessment;
  }
  function assessCounting(ctx, frame, detections, cache) {
    let assessment;
    if (!ctx.status.config.countingLine) {
      assessment = unconfiguredCountingStability();
    } else if (ctx.countingMovedAssessment) {
      assessment = ctx.countingMovedAssessment;
    } else if (!ctx.countingAnchor) {
      assessment = unverifiableStability(
        "This count line has no usable static reference. Redraw it on a clearer frozen frame to resume counting.",
      );
    } else {
      assessment = referenceAssessment(
        ctx,
        ctx.countingAnchor,
        frame,
        detections,
        cache,
      );
      if (assessment.state === "moved") {
        ctx.countingMovedAssessment = {
          ...assessment,
          reason:
            "Camera movement was detected. Redraw the count line on a new frozen frame before crossing counts resume.",
        };
        assessment = ctx.countingMovedAssessment;
      }
    }
    const allowed = assessment.state === "stable";
    if (!allowed || allowed !== ctx.countingAuthorized)
      ctx.counter.breakContinuity();
    ctx.countingAuthorized = allowed;
    ctx.status.countingStability = clone(assessment);
    return assessment;
  }
  async function consume(ctx, frame, segment) {
    if (!live(ctx) || ctx.fatal) return;
    const timestamp = frame.mediaSeconds;
    const received = frame.receivedAt ?? now();
    const previous = segment.previous;
    if (
      previous !== null &&
      (timestamp <= previous || timestamp - previous > 3)
    ) {
      await breakContinuity(ctx);
      if (timestamp <= previous) {
        segment.base = timestamp;
        segment.offset = (ctx.lastTimestamp ?? 0) + 0.1;
      }
    }
    if (!live(ctx) || ctx.fatal) return;
    if (segment.base === null) segment.base = timestamp;
    segment.previous = timestamp;
    const mediaSeconds = segment.offset + timestamp - segment.base;
    const previousDimensions = ctx.status.config.referenceFrame;
    if (!previousDimensions) {
      checkpoint(ctx, "dimensions");
      ctx.status.config.revision++;
    }
    if (
      previousDimensions &&
      (previousDimensions.width !== frame.width ||
        previousDimensions.height !== frame.height)
    ) {
      checkpoint(ctx, "dimensions");
      ctx.status.config.calibration = null;
      ctx.cameraAnchor = null;
      ctx.movedAssessment = null;
      ctx.speedAuthorized = false;
      ctx.status.cameraStability = uncalibratedStability();
      ctx.countingAnchor = null;
      ctx.countingMovedAssessment = null;
      ctx.countingAuthorized = false;
      ctx.status.countingStability = unconfiguredCountingStability();
      ctx.status.config.countingLine = null;
      ctx.status.config.revision++;
      ctx.references.clear();
      ctx.tracker.setCalibration(null);
      ctx.counter.setLine(null, true);
      await breakContinuity(ctx);
      if (!live(ctx) || ctx.fatal) return;
      ctx.geometryNotice =
        "Frame size changed. Redraw the count line and measured road area.";
    }
    ctx.status.config.referenceFrame = {
      width: frame.width,
      height: frame.height,
    };
    const revision = ctx.status.config.revision;
    const config = clone(ctx.status.config);
    const prediction = await ctx.engine.processFrame({
      rgb: frame.rgb,
      width: frame.width,
      height: frame.height,
      mediaSeconds,
    });
    if (!live(ctx) || ctx.fatal || revision !== ctx.status.config.revision)
      return;
    const wasCameraMoved = Boolean(ctx.movedAssessment);
    const wasCountingMoved = Boolean(ctx.countingMovedAssessment);
    const assessments = new Map();
    const cameraStability = assessCamera(
      ctx,
      frame,
      prediction.detections,
      assessments,
    );
    const countingStability = assessCounting(
      ctx,
      frame,
      prediction.detections,
      assessments,
    );
    if (
      (!wasCameraMoved && ctx.movedAssessment) ||
      (!wasCountingMoved && ctx.countingMovedAssessment)
    ) {
      ctx.plates.reset(`${ctx.id}:${++ctx.plateEpoch}`);
      if (ctx.latest) ctx.latest.plateReadings = [];
      ctx.tracker.breakContinuity();
      ctx.counter.breakContinuity();
      await ctx.engine.resetContext();
      if (!live(ctx) || ctx.fatal || revision !== ctx.status.config.revision)
        return;
    }
    const tracks = ctx.tracker.update(
      prediction.detections,
      mediaSeconds,
      frame.width,
      frame.height,
    );
    ctx.lastTimestamp = mediaSeconds;
    const stats = ctx.status.stats;
    const previousCrossings = stats.crossings.total;
    stats.framesDropped += Math.max(0, frame.index - segment.lastIndex - 1);
    segment.lastIndex = frame.index;
    stats.framesProcessed++;
    stats.active = tracks.filter((track) =>
      VEHICLES.has(track.className),
    ).length;
    for (const track of tracks) {
      if (VEHICLES.has(track.className) && !ctx.observed.has(track.id)) {
        ctx.observed.add(track.id);
        stats.observed++;
      }
    }
    stats.crossings =
      countingStability.state === "stable"
        ? ctx.counter.update(tracks, frame.width, frame.height, mediaSeconds)
        : ctx.counter.snapshot;
    ctx.lastCompletedMono = monotonic();
    ctx.rates.push(monotonic());
    ctx.rates = ctx.rates.filter((t) => monotonic() - t <= 5000);
    stats.analysisFps =
      ctx.rates.length > 1
        ? ((ctx.rates.length - 1) * 1000) /
          Math.max(1, monotonic() - ctx.rates[0])
        : 0;
    ctx.status.lastFrameAt = iso(received);
    ctx.status.state = "running";
    ctx.status.error = null;
    ctx.status.message =
      ctx.geometryNotice ||
      "Continuous analysis is running in the local service.";
    if (
      stats.crossings.total !== previousCrossings ||
      monotonic() - ctx.lastCheckpointMono >= 5000 ||
      !previousDimensions ||
      previousDimensions.width !== frame.width ||
      previousDimensions.height !== frame.height
    )
      checkpoint(
        ctx,
        stats.crossings.total !== previousCrossings ? "crossing" : "periodic",
      );
    const captureTime = iso(received);
    ctx.plates.observe({
      epoch: `${ctx.id}:${ctx.plateEpoch}`,
      frame,
      tracks,
      detections: prediction.detections,
      sourceTimestamp: mediaSeconds,
      observedAt: captureTime,
    });
    const candidates = tracks.filter(
      (t) =>
        !ctx.captured.has(t.id) &&
        MOTOR.has(t.className) &&
        config.calibration &&
        cameraStability.state === "stable" &&
        t.speedMeasurement != null &&
        Number.isFinite(t.speedKmh) &&
        t.speedKmh > config.speedLimitKmh &&
        ctx.shared.pointInPolygon(
          {
            x: (t.bbox[0] + t.bbox[2] / 2) / frame.width,
            y: (t.bbox[1] + t.bbox[3]) / frame.height,
          },
          config.calibration.points,
        ),
    );
    for (const track of candidates) {
      const payload = {
        clientEventId: `${ctx.id}:${track.id}`,
        trackId: track.id,
        sourceName: ctx.status.sourceName,
        sourceKind: "camera",
        className: track.className,
        speedKmh: track.speedKmh,
        speedLimit: config.speedLimitKmh,
        confidence: track.score,
        captureTime,
        sourceTimestamp: mediaSeconds,
        calibration: config.calibration,
        vehicleBox: track.bbox,
        speedMeasurement: clone(track.speedMeasurement),
        evidence: await evidence(
          frame,
          track,
          config.speedLimitKmh,
          captureTime,
        ),
      };
      ctx.pending.push({
        payload: frozenPayload(payload),
        value: null,
        enqueued: false,
      });
      ctx.captured.add(track.id);
      try {
        await flush(ctx);
        checkpoint(ctx, "periodic");
      } catch {
        ctx.fatal ||=
          "Evidence could not be saved. Analysis stopped; retry the pending evidence before starting another camera.";
        throw new Error(ctx.fatal);
      }
    }
    if (!live(ctx) || ctx.fatal || revision !== ctx.status.config.revision)
      return;
    if (monotonic() - ctx.lastPreview >= 240 || !ctx.latest) {
      const reference = cameraReference(ctx, frame, prediction.detections);
      const jpeg = await sharp(frame.rgb, {
        raw: { width: frame.width, height: frame.height, channels: 3 },
      })
        .jpeg({ quality: 78 })
        .toBuffer();
      if (!live(ctx) || ctx.fatal || revision !== ctx.status.config.revision)
        return;
      const frameId = ++ctx.frameId;
      ctx.latest = {
        sessionId: ctx.id,
        frameId,
        width: frame.width,
        height: frame.height,
        sourceTimestamp: mediaSeconds,
        sourceMediaSeconds: timestamp,
        captureTime,
        processedAt: iso(now()),
        jpeg: `data:image/jpeg;base64,${jpeg.toString("base64")}`,
        tracks: clone(tracks),
        configRevision: revision,
        speedLimitKmh: config.speedLimitKmh,
        calibration: config.calibration,
        countingLine: config.countingLine,
        cameraStability: clone(cameraStability),
        countingStability: clone(countingStability),
        plateReadings: ctx.plates.readings(tracks.map((track) => track.id)),
      };
      ctx.lastPreview = monotonic();
      ctx.references.set(frameId, {
        revision,
        width: frame.width,
        height: frame.height,
        time: monotonic(),
        cameraReference: reference,
      });
      for (const [id, ref] of ctx.references)
        if (monotonic() - ref.time > 120000) ctx.references.delete(id);
      while (ctx.references.size > 400)
        ctx.references.delete(ctx.references.keys().next().value);
    }
  }
  async function run(ctx) {
    try {
      ctx.shared = shared ?? (await loadVisionShared());
      ctx.tracker = new ctx.shared.VehicleTracker(null);
      ctx.counter = new ctx.shared.CrossingCounter(null);
      ctx.engine = await createEngine();
      if (!live(ctx)) return;
      if (ctx.fatal) throw new Error(ctx.fatal);
      ctx.status.engine = {
        name: "YOLOX-S",
        provider: ctx.engine.info.provider,
        warnings: ctx.engine.info.initializationWarnings ?? [],
      };
      let attempts = 0;
      while (live(ctx)) {
        if (ctx.fatal) throw new Error(ctx.fatal);
        const before = ctx.status.stats.framesProcessed;
        try {
          const input = await resolveInput(ctx.camera, {
            signal: ctx.abort.signal,
          });
          if (!live(ctx)) break;
          if (ctx.fatal) throw new Error(ctx.fatal);
          const segment = {
            base: null,
            offset: (ctx.lastTimestamp ?? -0.1) + 0.1,
            previous: null,
            lastIndex: -1,
          };
          ctx.source = await createSource(input.source ?? input.url, {
            fps: 10,
            onFrame: (frame) => consumeFrame(ctx, frame, segment),
          });
          if (!live(ctx)) {
            await stopSource(ctx);
            break;
          }
          if (ctx.fatal) throw new Error(ctx.fatal);
          await waitForSource(ctx);
          if (!live(ctx)) break;
          throw new Error("Camera stream ended.");
        } catch {
          if (!(await stopSource(ctx))) throw new Error(CLEANUP_ERROR);
          ctx.source = null;
          if (!live(ctx)) break;
          if (ctx.fatal) throw new Error(ctx.fatal);
          if (ctx.status.stats.framesProcessed - before >= 30) attempts = 0;
          if (++attempts > 5)
            throw new Error("Camera reconnect attempts were exhausted.");
          await breakContinuity(ctx);
          ctx.status.state = "reconnecting";
          ctx.status.message = `Camera connection interrupted. Reconnecting (attempt ${attempts} of 5).`;
          checkpoint(ctx, "reconnecting");
          await delay(Math.min(15000, 1000 * 2 ** (attempts - 1)), undefined, {
            signal: ctx.abort.signal,
          });
        }
      }
    } catch {
      if (!ctx.cancelled) {
        ctx.status.state = "error";
        ctx.status.error =
          ctx.fatal ||
          "Continuous analysis stopped. Check the camera connection and local detector, then start again.";
        ctx.status.message = ctx.status.error;
      }
    } finally {
      ctx.finalizing = true;
      await stopSource(ctx);
      try {
        await ctx.engine?.close();
      } catch {
        cleanupFailed(ctx);
      }
      await Promise.allSettled([...ctx.frameJobs]);
      try {
        await ctx.plates.close();
      } catch {
        ctx.plateCleanupFailed = true;
        ctx.cleanupFailed = true;
        ctx.fatal ||=
          "Plate reader cleanup could not be confirmed. Restart the local service before starting another monitor.";
      }
      ctx.references.clear();
      ctx.cameraAnchor = null;
      ctx.countingAnchor = null;
      ctx.endedAt = now();
      ctx.endedMono = monotonic();
      ctx.status.stats.active = 0;
      ctx.status.stats.analysisFps = 0;
      if (ctx.cleanupFailed) {
        ctx.status.state = "error";
        ctx.status.error = ctx.fatal;
        ctx.status.message = ctx.fatal;
      } else if (ctx.cancelled) {
        ctx.status.state = "stopped";
        ctx.status.message = "Continuous analysis stopped.";
      }
      try {
        checkpoint(ctx, "ended");
      } catch {
        ctx.status.state = "error";
        ctx.status.error = ctx.fatal;
        ctx.status.message = ctx.fatal;
      }
    }
  }
  async function start(body) {
    object(body, [
      "camera",
      "speedLimitKmh",
      "calibration",
      "countingLine",
      "plateReadingEnabled",
    ]);
    if (
      body.plateReadingEnabled !== undefined &&
      typeof body.plateReadingEnabled !== "boolean"
    )
      throw new HttpError(400, "plateReadingEnabled must be a boolean.");
    const camera = cameraConfig(body.camera),
      limit = speed(body.speedLimitKmh);
    if (body.calibration != null || body.countingLine != null)
      throw new HttpError(
        400,
        "Start the camera, then configure geometry on its frozen preview.",
      );
    if (closing) throw new HttpError(409, "The service is shutting down.");
    const recovery = recoveryStatus();
    if (!recoveryInitialized || recovery.pending || recovery.error)
      throw new HttpError(
        409,
        "Recover the pending saved evidence before starting another camera.",
      );
    if (current?.pending.length)
      throw new HttpError(
        409,
        "Retry the pending evidence before starting another camera.",
      );
    if (current?.historyPending)
      throw new HttpError(
        409,
        "Retry saving the pending session history before starting another camera.",
      );
    if (current?.cleanupFailed) throw new HttpError(503, CLEANUP_ERROR);
    if (current && !current.endedAt)
      throw new HttpError(
        409,
        "Stop the current monitor before starting another camera.",
      );
    const ctx = {
      id: randomUUID(),
      camera,
      started: now(),
      startedMono: monotonic(),
      endedAt: null,
      endedMono: null,
      cancelled: false,
      finalizing: false,
      abort: new AbortController(),
      status: blank(),
      tracker: null,
      counter: null,
      engine: null,
      plates: createAutomaticPlates({
        createEngine: createPlateEngine,
        enabled: body.plateReadingEnabled ?? plateReadingEnabled,
        monotonic,
      }),
      plateEpoch: 0,
      source: null,
      sourceStops: new WeakMap(),
      frameJobs: new Set(),
      cleanupFailed: false,
      shared: null,
      latest: null,
      references: new Map(),
      cameraAnchor: null,
      movedAssessment: null,
      speedAuthorized: false,
      countingAnchor: null,
      countingMovedAssessment: null,
      countingAuthorized: false,
      frameId: 0,
      lastPreview: 0,
      lastCompletedMono: null,
      lastTimestamp: null,
      rates: [],
      observed: new Set(),
      captured: new Set(),
      storedEvents: new Set(),
      pending: [],
      fatal: null,
      historyPending: false,
      lastCheckpointMono: -Infinity,
    };
    ctx.status = {
      ...ctx.status,
      sessionId: ctx.id,
      state: "starting",
      message: "Loading the native detector and connecting to the camera…",
      sourceName: camera.name,
      sourceType: camera.type,
      trafficCameraId: trafficCameraId(camera),
      startedAt: iso(ctx.started),
      config: { ...ctx.status.config, revision: 1, speedLimitKmh: limit },
    };
    current = ctx;
    try {
      checkpoint(ctx, "started");
    } catch (error) {
      ctx.endedAt = now();
      ctx.endedMono = monotonic();
      ctx.status.state = "error";
      ctx.status.error = ctx.fatal;
      ctx.status.message = ctx.fatal;
      throw error;
    }
    ctx.run = run(ctx);
    return status();
  }
  function session(id) {
    if (!current || id !== current.id)
      throw new HttpError(
        409,
        "This monitor session has changed. Refresh its status.",
      );
    return current;
  }
  function configure(body) {
    object(body, [
      "sessionId",
      "expectedRevision",
      "speedLimitKmh",
      "calibration",
      "countingLine",
      "referenceFrame",
      "plateReadingEnabled",
    ]);
    const ctx = session(body.sessionId),
      config = ctx.status.config;
    if (ctx.cancelled || ctx.endedAt || ctx.fatal || !ctx.tracker)
      throw new HttpError(
        409,
        "The monitor must be running before changing its configuration.",
      );
    if (body.expectedRevision !== config.revision)
      throw new HttpError(
        409,
        "The monitor configuration changed. Reload the preview and try again.",
      );
    const next = clone(config);
    if (
      body.plateReadingEnabled !== undefined &&
      typeof body.plateReadingEnabled !== "boolean"
    )
      throw new HttpError(400, "plateReadingEnabled must be a boolean.");
    if (body.speedLimitKmh !== undefined)
      next.speedLimitKmh = speed(body.speedLimitKmh);
    const geometry = "calibration" in body || "countingLine" in body;
    let nextAnchor = ctx.cameraAnchor;
    let nextCountingAnchor = ctx.countingAnchor;
    if (geometry) {
      object(body.referenceFrame, ["frameId", "width", "height"]);
      const ref = ctx.references.get(body.referenceFrame.frameId);
      if (
        !ref ||
        ref.revision !== config.revision ||
        monotonic() - ref.time > 120000 ||
        ref.width !== body.referenceFrame.width ||
        ref.height !== body.referenceFrame.height
      )
        throw new HttpError(
          409,
          "This frozen frame is no longer current. Reopen the geometry editor.",
        );
      if ("calibration" in body) {
        const value = body.calibration;
        if (value !== null) {
          object(value, ["points", "widthMeters", "lengthMeters"]);
          if (!Array.isArray(value.points) || value.points.length !== 4)
            throw new HttpError(400, "Place four measured road corners.");
          value.points.forEach(point);
          if (
            ![value.widthMeters, value.lengthMeters].every(
              (n) => Number.isFinite(n) && n >= 0.1 && n <= 10000,
            )
          )
            throw new HttpError(
              400,
              "Measured dimensions must be between 0.1 and 10000 metres.",
            );
          const error = ctx.shared.validateCalibration(value);
          if (error) throw new HttpError(400, error);
          if (!ref.cameraReference)
            throw new HttpError(
              409,
              "This frozen frame has insufficient static detail to guard the calibration. Choose a clearer, unobstructed frame.",
            );
        }
        next.calibration = clone(value);
        nextAnchor = value === null ? null : ref.cameraReference;
      }
      if ("countingLine" in body) {
        if (body.countingLine !== null) {
          object(body.countingLine, ["a", "b"]);
          point(body.countingLine.a);
          point(body.countingLine.b);
          try {
            new ctx.shared.CrossingCounter(body.countingLine);
          } catch {
            throw new HttpError(
              400,
              "Use a counting line at least 5% of the frame in length.",
            );
          }
        }
        next.countingLine = clone(body.countingLine);
        nextCountingAnchor =
          body.countingLine === null ? null : ref.cameraReference;
      }
    }
    try {
      checkpoint(ctx, "configuration");
    } catch (error) {
      haltAfterSaveFailure(ctx);
      throw error;
    }
    next.revision++;
    ctx.status.config = next;
    if (body.plateReadingEnabled !== undefined) {
      ctx.plates.setEnabled(body.plateReadingEnabled);
      if (!body.plateReadingEnabled && ctx.latest)
        ctx.latest.plateReadings = [];
    }
    if ("calibration" in body) {
      ctx.cameraAnchor = nextAnchor;
      ctx.movedAssessment = null;
      ctx.speedAuthorized = false;
      ctx.status.cameraStability = next.calibration
        ? unverifiableStability(
            "Waiting for a fresh frame to verify the calibrated camera view.",
          )
        : uncalibratedStability();
    }
    if ("countingLine" in body) {
      ctx.countingAnchor = nextCountingAnchor;
      ctx.countingMovedAssessment = null;
      ctx.countingAuthorized = false;
      ctx.status.countingStability = next.countingLine
        ? unverifiableStability(
            nextCountingAnchor
              ? "Waiting for a fresh frame to verify the counting view."
              : "This count line has no usable static reference. Redraw it on a clearer frozen frame to resume counting.",
          )
        : unconfiguredCountingStability();
    }
    if (geometry) {
      ctx.plates.reset(`${ctx.id}:${++ctx.plateEpoch}`);
      if (ctx.latest) ctx.latest.plateReadings = [];
      ctx.tracker.setCalibration(ctx.speedAuthorized ? next.calibration : null);
      ctx.tracker.breakContinuity();
      ctx.counter.setLine(next.countingLine);
      ctx.counter.breakContinuity();
      ctx.status.stats.crossings = ctx.counter.snapshot;
      ctx.geometryNotice = null;
      ctx.status.stats.active = 0;
    }
    try {
      checkpoint(ctx, "configuration");
    } catch (error) {
      haltAfterSaveFailure(ctx);
      throw error;
    }
    return status();
  }
  async function stop(body) {
    object(body, ["sessionId"]);
    const ctx = session(body.sessionId);
    if (ctx.endedAt !== null) return status();
    ctx.cancelled = true;
    ctx.plates.reset(`${ctx.id}:${++ctx.plateEpoch}`);
    if (ctx.latest) ctx.latest.plateReadings = [];
    ctx.abort.abort();
    ctx.status.state = "stopping";
    await stopSource(ctx);
    await ctx.run;
    return status();
  }
  function frame({ sessionId, after = 0 }) {
    const ctx = session(sessionId);
    if (!Number.isSafeInteger(after) || after < 0)
      throw new HttpError(400, "Invalid frame sequence.");
    return ctx.latest && ctx.latest.frameId > after ? clone(ctx.latest) : null;
  }
  async function retry(body) {
    object(body, ["sessionId"]);
    const ctx = session(body.sessionId);
    if (ctx.endedAt === null)
      throw new HttpError(
        409,
        "Wait for analysis to stop before retrying pending saves.",
      );
    try {
      await flush(ctx);
      checkpoint(ctx, "retry");
      ctx.fatal = ctx.cleanupFailed ? CLEANUP_ERROR : null;
      ctx.status.error = ctx.fatal;
      ctx.status.message =
        ctx.fatal ||
        "Pending saves completed. Start a new monitoring session to resume.";
    } catch {
      throw new HttpError(
        503,
        "Saving is still pending. Check available storage and retry.",
      );
    }
    return status();
  }
  async function close() {
    closing = true;
    if (current) await stop({ sessionId: current.id });
    if (current?.plateCleanupFailed)
      throw new HttpError(
        503,
        "Plate reader cleanup could not be confirmed. Restart the local service.",
      );
  }
  return {
    start,
    stop,
    status,
    configure,
    frame,
    retry,
    recoverEvidence,
    retryRecovery,
    close,
  };
}
