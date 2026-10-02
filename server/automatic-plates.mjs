import { createHash } from "node:crypto";
const MOTOR = new Set(["car", "truck", "bus", "motorcycle"]);
const METHOD = "rtdetr-ppocrv6-consensus-v1";
const MAX_IDENTITIES = 100;
const MAX_CROP_PIXELS = 1024 * 1024;
const STALE_MS = 5000;
const FAILURE =
  "Automatic plate reading is unavailable. Vehicle tracking continues. Disable and re-enable plate reading to retry.";
const CLEANUP_FAILURE =
  "Plate reader cleanup could not be confirmed. Restart the local service before enabling another plate reader.";
const defaultEngine = async () => {
  const { createPlateEngine } = await import("./plate-engine.mjs");
  return createPlateEngine();
};
function normalizedPlate(text) {
  if (typeof text !== "string") return null;
  const normalized = text.normalize("NFKC").toUpperCase();
  if (/[^A-Z0-9\s\p{P}]/u.test(normalized)) return null;
  const plate = normalized.replace(/[^A-Z0-9]/g, "");
  return plate.length >= 2 && plate.length <= 12 ? plate : null;
}
function cropBounds(track, frame) {
  if (
    !MOTOR.has(track.className) ||
    !Number.isSafeInteger(track.id) ||
    track.id < 0 ||
    !Array.isArray(track.bbox) ||
    track.bbox.length !== 4 ||
    !track.bbox.every(Number.isFinite)
  )
    return null;
  const [x, y, width, height] = track.bbox;
  if (width <= 0 || height <= 0) return null;
  const left = Math.max(0, Math.ceil(x)),
    top = Math.max(0, Math.ceil(y));
  const right = Math.min(frame.width, Math.floor(x + width)),
    bottom = Math.min(frame.height, Math.floor(y + height));
  const w = right - left,
    h = bottom - top;
  if (w < 120 || h < 40 || w * h > MAX_CROP_PIXELS) return null;
  return { left, top, width: w, height: h, area: w * h };
}
function copyCrop(frame, box) {
  const rgb = new Uint8Array(box.width * box.height * 3);
  for (let row = 0; row < box.height; row++) {
    const start = ((box.top + row) * frame.width + box.left) * 3;
    rgb.set(
      frame.rgb.subarray(start, start + box.width * 3),
      row * box.width * 3,
    );
  }
  return { rgb, width: box.width, height: box.height };
}
function validFrame(frame) {
  return (
    frame &&
    frame.rgb instanceof Uint8Array &&
    Number.isSafeInteger(frame.width) &&
    Number.isSafeInteger(frame.height) &&
    frame.width > 0 &&
    frame.height > 0 &&
    frame.width <= 8192 &&
    frame.height <= 8192 &&
    frame.width * frame.height <= 33554432 &&
    frame.rgb.length === frame.width * frame.height * 3
  );
}
function overlap(a, b) {
  if (
    !Array.isArray(b) ||
    b.length !== 4 ||
    !b.every(Number.isFinite) ||
    b[2] <= 0 ||
    b[3] <= 0
  )
    return 0;
  return (
    Math.max(0, Math.min(a[0] + a[2], b[0] + b[2]) - Math.max(a[0], b[0])) *
    Math.max(0, Math.min(a[1] + a[3], b[1] + b[3]) - Math.max(a[1], b[1]))
  );
}
function validBox(box) {
  return (
    Array.isArray(box) &&
    box.length === 4 &&
    box.every(Number.isFinite) &&
    box[2] > 0 &&
    box[3] > 0
  );
}
function uncertainOwnership(track, tracks, detections) {
  if (
    tracks.some(
      (other) =>
        other.id !== track.id &&
        MOTOR.has(other.className) &&
        overlap(track.bbox, other.bbox) > 0,
    )
  )
    return true;
  const motor = detections.filter((detection) =>
    MOTOR.has(detection.className),
  );
  let own = -1,
    best = 0.5;
  motor.forEach((detection, index) => {
    const intersection = overlap(track.bbox, detection.bbox);
    const union =
      track.bbox[2] * track.bbox[3] +
      (detection.bbox?.[2] ?? 0) * (detection.bbox?.[3] ?? 0) -
      intersection;
    const iou = intersection / union;
    if (iou >= best) {
      best = iou;
      own = index;
    }
  });
  return motor.some(
    (detection, index) =>
      index !== own && overlap(track.bbox, detection.bbox) > 0,
  );
}
export function createAutomaticPlates({
  createEngine = defaultEngine,
  enabled = true,
  monotonic = () => performance.now(),
  schedule = (callback, ms) => setTimeout(callback, ms),
  cancel = clearTimeout,
} = {}) {
  let epoch = null,
    generation = 0,
    closed = false,
    failure = null,
    cleanupFailed = false,
    closePromise = null;
  let engine = null,
    enginePromise = null,
    releaseBarrier = Promise.resolve();
  let active = null,
    waiting = null,
    activePromise = null,
    timer = null;
  let nextStart = -Infinity,
    reads = 0,
    lastSourceTime = null;
  const identities = new Map();
  function stopTimer() {
    if (timer !== null) cancel(timer);
    timer = null;
  }
  function releaseEngine() {
    const pending = enginePromise;
    enginePromise = null;
    engine = null;
    if (!pending) return releaseBarrier;
    const released = Promise.resolve(pending)
      .then(
        (reader) => reader.close(),
        () => null,
      )
      .catch(() => {
        cleanupFailed = true;
        failure = CLEANUP_FAILURE;
      });
    releaseBarrier = Promise.allSettled([releaseBarrier, released]).then(
      () => {},
    );
    return releaseBarrier;
  }
  async function getEngine() {
    if (!enginePromise) {
      enginePromise = releaseBarrier.then(() => {
        if (cleanupFailed) throw new Error(CLEANUP_FAILURE);
        return createEngine();
      });
      void enginePromise.catch(() => {});
    }
    const pending = enginePromise;
    const value = await pending;
    if (
      !value ||
      typeof value.read !== "function" ||
      typeof value.close !== "function"
    )
      throw new Error("Invalid plate engine");
    if (enginePromise === pending) engine = value;
    return value;
  }
  function prune() {
    const time = monotonic();
    for (const [id, record] of identities) {
      if (time - record.lastSeen > STALE_MS) identities.delete(id);
    }
    if (waiting && identities.get(waiting.trackId) !== waiting.record)
      waiting = null;
  }
  function current(job) {
    return (
      !closed &&
      enabled &&
      job.generation === generation &&
      job.epoch === epoch &&
      identities.get(job.trackId) === job.record &&
      monotonic() - job.record.lastSeen <= STALE_MS &&
      job.identityVersion === job.record.identityVersion &&
      monotonic() - job.capturedMono <= STALE_MS &&
      job.record.latestSourceTime - job.sourceTimestamp <= 5 + 1e-6
    );
  }
  function reading(
    record,
    job,
    state,
    reason,
    plate = null,
    confidence = null,
    samples = 0,
  ) {
    record.reading = {
      trackId: job.trackId,
      state,
      plate,
      confidence,
      samples,
      sourceTimestamp: job.sourceTimestamp,
      observedAt: job.observedAt,
      reason,
      method: METHOD,
    };
  }
  function expire(job) {
    if (
      !closed &&
      enabled &&
      job.epoch === epoch &&
      job.generation === generation &&
      identities.get(job.trackId) === job.record &&
      job.identityVersion === job.record.identityVersion &&
      job.record.reading?.state === "pending"
    ) {
      reading(
        job.record,
        job,
        "unreadable",
        "The plate read expired. Awaiting fresh native vehicle detail.",
        null,
        null,
        job.record.votes.length,
      );
    }
  }
  function applyResult(job, result) {
    if (!result || !["read", "unreadable", "ambiguous"].includes(result.state))
      throw new Error("Invalid plate result");
    const record = job.record;
    if (result.state === "ambiguous") {
      record.votes = [];
      record.lastPlate = null;
      reading(
        record,
        job,
        "conflict",
        "Multiple plate proposals are ambiguous. No registration is displayed.",
      );
      return;
    }
    const plate =
      result.state === "read" ? normalizedPlate(result.plate) : null;
    if (
      !plate ||
      !Number.isFinite(result.confidence) ||
      result.confidence < 75 ||
      result.confidence > 100
    ) {
      if (record.reading?.state !== "candidate")
        reading(
          record,
          job,
          "unreadable",
          "This native vehicle crop did not provide a readable plate. No registration is inferred.",
          null,
          null,
          record.votes.length,
        );
      return;
    }
    const changed = record.lastPlate !== null && record.lastPlate !== plate;
    const priorCandidate =
      record.reading?.state === "candidate" && record.reading.plate === plate;
    if (changed) record.votes = [];
    record.lastPlate = plate;
    record.votes = record.votes.filter(
      (vote) =>
        job.sourceTimestamp - vote.sourceTimestamp <= 5 + 1e-6 &&
        job.sourceTimestamp >= vote.sourceTimestamp,
    );
    if (
      !record.votes.some(
        (vote) =>
          Math.abs(vote.sourceTimestamp - job.sourceTimestamp) < 0.2 - 1e-6,
      )
    )
      record.votes.push({
        sourceTimestamp: job.sourceTimestamp,
        confidence: result.confidence,
      });
    record.votes = record.votes.slice(-3);
    if (changed) {
      reading(
        record,
        job,
        "conflict",
        "Plate readings disagree. The registration remains unverified and is hidden.",
        null,
        null,
        record.votes.length,
      );
    } else if (record.votes.length >= 2 || priorCandidate) {
      const priorConfidence = priorCandidate
        ? record.reading.confidence
        : result.confidence;
      reading(
        record,
        job,
        "candidate",
        "Unverified plate candidate repeated in separate source frames. Confirm it against the vehicle image.",
        plate,
        Math.min(
          priorConfidence,
          ...record.votes.map((vote) => vote.confidence),
        ),
        Math.max(
          priorCandidate ? record.reading.samples : 0,
          record.votes.length,
        ),
      );
    } else {
      reading(
        record,
        job,
        "pending",
        "One unverified read is awaiting agreement from another source frame.",
        null,
        null,
        record.votes.length,
      );
    }
  }
  function pump() {
    stopTimer();
    prune();
    if (closed || !enabled || failure || active || !waiting) return;
    const remaining = nextStart - monotonic();
    if (remaining > 0) {
      timer = schedule(() => {
        timer = null;
        pump();
      }, remaining);
      timer?.unref?.();
      return;
    }
    const job = waiting;
    waiting = null;
    if (!current(job)) {
      expire(job);
      return;
    }
    active = job;
    job.record.attempts++;
    job.record.submittedTime = job.sourceTimestamp;
    job.record.sourceDigests.add(job.sourceDigest);
    while (job.record.sourceDigests.size > 48)
      job.record.sourceDigests.delete(
        job.record.sourceDigests.values().next().value,
      );
    nextStart = monotonic() + 1000;
    activePromise = (async () => {
      const reader = await getEngine();
      if (!current(job)) return;
      const result = await reader.read(job.crop);
      reads++;
      if (current(job)) applyResult(job, result);
    })()
      .catch(() => {
        if (!closed && enabled && job.generation === generation) {
          failure = cleanupFailed ? CLEANUP_FAILURE : FAILURE;
          waiting = null;
          identities.clear();
          void releaseEngine();
        }
      })
      .finally(() => {
        if (!current(job)) expire(job);
        job.crop = null;
        if (active === job) active = null;
        activePromise = null;
        pump();
      });
  }
  function reset(nextEpoch) {
    epoch = nextEpoch;
    generation++;
    waiting = null;
    identities.clear();
    lastSourceTime = null;
    stopTimer();
  }
  function observe({
    epoch: observedEpoch,
    frame,
    tracks,
    detections = [],
    sourceTimestamp,
    observedAt,
  }) {
    if (
      closed ||
      !enabled ||
      failure ||
      !validFrame(frame) ||
      !Array.isArray(tracks) ||
      !Array.isArray(detections) ||
      !Number.isFinite(sourceTimestamp) ||
      sourceTimestamp < 0 ||
      typeof observedAt !== "string" ||
      !Number.isFinite(Date.parse(observedAt))
    )
      return;
    if (observedEpoch !== epoch) reset(observedEpoch);
    if (lastSourceTime !== null && sourceTimestamp < lastSourceTime)
      reset(observedEpoch);
    if (lastSourceTime === sourceTimestamp) return;
    lastSourceTime = sourceTimestamp;
    prune();
    const visible = new Set();
    const eligible = [];
    for (const track of tracks) {
      if (
        !MOTOR.has(track.className) ||
        !Number.isSafeInteger(track.id) ||
        track.id < 0
      )
        continue;
      visible.add(track.id);
      const bounds = cropBounds(track, frame);
      let record = identities.get(track.id);
      if (!record && bounds) {
        if (identities.size >= MAX_IDENTITIES) {
          const removable = [...identities]
            .filter(([id]) => id !== active?.trackId && id !== waiting?.trackId)
            .sort((a, b) => a[1].lastSeen - b[1].lastSeen)[0];
          if (!removable) continue;
          identities.delete(removable[0]);
        }
        record = {
          attempts: 0,
          tier: bounds,
          votes: [],
          lastPlate: null,
          reading: null,
          lastSeen: monotonic(),
          latestSourceTime: sourceTimestamp,
          submittedTime: -Infinity,
          sourceDigests: new Set(),
          identityVersion: 0,
        };
        identities.set(track.id, record);
      }
      if (!record) continue;
      record.lastSeen = monotonic();
      record.latestSourceTime = sourceTimestamp;
      if (
        validBox(track.bbox) &&
        uncertainOwnership(track, tracks, detections)
      ) {
        record.identityVersion++;
        record.votes = [];
        record.lastPlate = null;
        reading(
          record,
          { trackId: track.id, sourceTimestamp, observedAt },
          "conflict",
          "Overlapping vehicles make plate ownership uncertain. No registration is displayed.",
        );
        if (waiting?.record === record) waiting = null;
        continue;
      }
      if (!bounds || (track.id === active?.trackId && active.record === record))
        continue;
      if (
        bounds.area >= record.tier.area * 1.5 &&
        bounds.width >= record.tier.width &&
        bounds.height >= record.tier.height
      ) {
        record.attempts = 0;
        record.tier = bounds;
      }
      if (
        record.attempts >= 3 ||
        sourceTimestamp - record.submittedTime < 0.2 - 1e-6
      )
        continue;
      eligible.push({ trackId: track.id, record, bounds });
    }
    if (waiting && !visible.has(waiting.trackId)) waiting = null;
    eligible.sort(
      (a, b) =>
        a.record.attempts - b.record.attempts ||
        b.bounds.area - a.bounds.area ||
        a.trackId - b.trackId,
    );
    const sourceDigest = eligible.length
      ? createHash("sha256")
          .update(`${frame.width}x${frame.height}:`)
          .update(frame.rgb)
          .digest("hex")
      : null;
    const selected = eligible.find(
      (candidate) =>
        identities.get(candidate.trackId) === candidate.record &&
        !candidate.record.sourceDigests.has(sourceDigest) &&
        !(
          waiting?.trackId === candidate.trackId &&
          waiting.sourceDigest === sourceDigest
        ),
    );
    if (selected) {
      waiting = null;
      const job = {
        ...selected,
        epoch,
        generation,
        identityVersion: selected.record.identityVersion,
        sourceTimestamp,
        observedAt,
        capturedMono: monotonic(),
        sourceDigest,
        crop: copyCrop(frame, selected.bounds),
      };
      waiting = job;
      if (!selected.record.reading)
        reading(
          selected.record,
          job,
          "pending",
          "Waiting for local plate reading. Any result will remain unverified.",
        );
    }
    pump();
  }
  function status() {
    prune();
    const state = cleanupFailed
      ? "unavailable"
      : !enabled || closed
        ? "disabled"
        : failure
          ? "unavailable"
          : active && !engine
            ? "loading"
            : active || waiting
              ? "running"
              : "idle";
    return {
      enabled: enabled && !closed,
      state,
      pending: Number(Boolean(active)) + Number(Boolean(waiting)),
      reads,
      reason:
        failure ||
        (state === "disabled"
          ? "Automatic plate reading is disabled."
          : "Plate candidates require agreement in separate frames and remain unverified."),
      method: METHOD,
    };
  }
  function readings(trackIds) {
    prune();
    if (!enabled || closed || failure) return [];
    const selected = trackIds ? new Set(trackIds) : null;
    return [...identities]
      .filter(
        ([id, record]) => record.reading && (!selected || selected.has(id)),
      )
      .map(([, record]) => structuredClone(record.reading));
  }
  function setEnabled(value) {
    if (typeof value !== "boolean")
      throw new TypeError("Plate reading enablement must be boolean.");
    if (closed || value === enabled) return;
    enabled = value;
    reset(epoch);
    if (!value) void releaseEngine();
    else if (!cleanupFailed) failure = null;
  }
  function close() {
    if (closePromise) return closePromise;
    closed = true;
    reset(epoch);
    const running = activePromise;
    closePromise = (async () => {
      await releaseEngine();
      if (cleanupFailed) throw new Error(CLEANUP_FAILURE);
      await running;
      if (cleanupFailed) throw new Error(CLEANUP_FAILURE);
    })();
    return closePromise;
  }
  return { observe, readings, status, reset, setEnabled, close };
}
