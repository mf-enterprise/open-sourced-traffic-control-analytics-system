import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, dirname, basename } from "node:path";
import { request } from "node:http";
import { setImmediate as turn } from "node:timers/promises";
import { createApiServer } from "./index.mjs";
import { loadVisionShared } from "./vision-shared.mjs";
const shared = await loadVisionShared();
const deviceId = randomUUID();
const camera = { type: "usb", deviceId, name: "USB test camera" };
async function until(check) {
  for (let n = 0; n < 100; n++) {
    if (check()) return;
    await turn();
  }
  assert.fail("Monitor did not reach the expected state.");
}
function api(server, path, method = "GET", body, headers = {}) {
  return new Promise((resolve, reject) => {
    const bytes = body === undefined ? null : JSON.stringify(body);
    const req = request(
      {
        host: "127.0.0.1",
        port: server.address().port,
        path,
        method,
        headers: {
          Host: "127.0.0.1:5174",
          ...headers,
          ...(bytes === null
            ? {}
            : {
                "Content-Type": "application/json",
                "Content-Length": Buffer.byteLength(bytes),
              }),
        },
      },
      (res) => {
        let text = "";
        res.on("data", (b) => {
          text += b;
        });
        res.on("end", () =>
          resolve({ status: res.statusCode, body: JSON.parse(text) }),
        );
      },
    );
    req.on("error", reject);
    req.end(bytes);
  });
}
async function setup(t, { resolveDevice } = {}) {
  const directory = await mkdtemp(join(tmpdir(), "traffic-usb-api-"));
  const trustedSource = Object.freeze({});
  const state = {
    enumerations: 0,
    resolves: [],
    consumers: [],
    sourceStops: 0,
    registryClosed: false,
    engineClosed: false,
  };
  const registry = {
    async list() {
      state.enumerations++;
      return {
        supported: true,
        devices: [{ id: deviceId, name: camera.name }],
        reason: null,
      };
    },
    async resolve(id, options) {
      state.resolves.push({ id, options });
      return resolveDevice
        ? resolveDevice(id, options)
        : { source: trustedSource, name: camera.name, type: "usb" };
    },
    async close() {
      state.registryClosed = true;
    },
  };
  const server = createApiServer({
    dataDirectory: directory,
    localCameras: registry,
    monitorOptions: {
      shared,
      plateReadingEnabled: false,
      createEngine: async () => ({
        info: { provider: "fixture" },
        processFrame: async () => ({ detections: [] }),
        resetContext() {},
        async close() {
          state.engineClosed = true;
        },
      }),
      createSource: async (source, options) => {
        assert.equal(source, trustedSource);
        let end;
        const completion = new Promise((r) => {
          end = r;
        });
        state.consumers.push(options.onFrame);
        return {
          completion,
          async stop() {
            state.sourceStops++;
            end();
          },
        };
      },
    },
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(async () => {
    await new Promise((r) => server.close(r));
    await server.monitorClosed;
    const target = resolve(directory);
    assert.equal(dirname(target), resolve(tmpdir()));
    assert.ok(basename(target).startsWith("traffic-usb-api-"));
    await rm(target, { recursive: true, force: true });
  });
  return { server, state };
}
test("USB inventory is read-only, origin-protected and does not start a camera", async (t) => {
  const { server, state } = await setup(t);
  const denied = await api(server, "/api/local-cameras", "GET", undefined, {
    Origin: "https://untrusted.invalid",
  });
  assert.equal(denied.status, 403);
  assert.equal(state.enumerations, 0);
  const listed = await api(server, "/api/local-cameras");
  assert.deepEqual(listed.body, {
    supported: true,
    devices: [{ id: deviceId, name: camera.name }],
    reason: null,
  });
  assert.equal(state.enumerations, 1);
  assert.equal(state.consumers.length, 0);
  assert.equal((await api(server, "/api/monitor")).body.monitor.state, "idle");
});
test("USB monitoring receives only the trusted source and persists no device identifier", async (t) => {
  const { server, state } = await setup(t);
  const started = await api(server, "/api/monitor/start", "POST", {
    camera,
    speedLimitKmh: 50,
  });
  assert.equal(started.status, 202);
  const id = started.body.monitor.sessionId;
  await until(() => state.consumers.length === 1);
  assert.equal(state.resolves[0].id, deviceId);
  assert.equal(state.resolves[0].options.signal.aborted, false);
  await state.consumers[0]({
    rgb: Buffer.alloc(120 * 80 * 3),
    width: 120,
    height: 80,
    index: 0,
    mediaSeconds: 172000,
    receivedAt: Date.now(),
  });
  const current = (await api(server, "/api/monitor")).body.monitor;
  assert.equal(current.state, "running");
  assert.equal(current.sourceType, "usb");
  assert.equal(current.stats.framesProcessed, 1);
  assert.equal(current.config.calibration, null);
  const stopped = await api(server, "/api/monitor/stop", "POST", {
    sessionId: id,
  });
  assert.equal(stopped.body.monitor.state, "stopped");
  assert.equal(state.sourceStops, 1);
  assert.equal(state.engineClosed, true);
  const history = await api(server, `/api/monitor/history/${id}`);
  assert.equal(history.body.session.sourceType, "usb");
  assert.equal(history.body.session.sourceName, camera.name);
  assert.equal(JSON.stringify(history.body).includes(deviceId), false);
  assert.equal(JSON.stringify(current).includes(deviceId), false);
});
test("raw device paths, URLs, extra fields and malformed USB identifiers are rejected", async (t) => {
  const { server, state } = await setup(t);
  for (const value of [
    { ...camera, deviceId: "video=Webcam:audio=Microphone" },
    { ...camera, deviceId: "@device_pnp_private" },
    { ...camera, url: "https://untrusted.invalid" },
    { ...camera, source: { deviceName: "Webcam" } },
    { ...camera, name: "http://private.invalid" },
    { ...camera, name: "x".repeat(81) },
  ]) {
    assert.equal(
      (
        await api(server, "/api/monitor/start", "POST", {
          camera: value,
          speedLimitKmh: 50,
        })
      ).status,
      400,
    );
  }
  assert.equal(state.resolves.length, 0);
  assert.equal(state.consumers.length, 0);
});
test("Stop aborts USB discovery and never opens a camera from a late resolution", async (t) => {
  let entered = false,
    aborted = false;
  const { server, state } = await setup(t, {
    resolveDevice: async (_, { signal }) => {
      entered = true;
      await new Promise((r) =>
        signal.addEventListener(
          "abort",
          () => {
            aborted = true;
            r();
          },
          { once: true },
        ),
      );
      return { source: Object.freeze({}) };
    },
  });
  const started = await api(server, "/api/monitor/start", "POST", {
    camera,
    speedLimitKmh: 50,
  });
  await until(() => entered);
  const stopped = await api(server, "/api/monitor/stop", "POST", {
    sessionId: started.body.monitor.sessionId,
  });
  assert.equal(stopped.body.monitor.state, "stopped");
  assert.equal(aborted, true);
  assert.equal(state.consumers.length, 0);
  assert.equal(state.engineClosed, true);
});
