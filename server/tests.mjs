import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { request } from "node:http";
import { DatabaseSync } from "node:sqlite";
import { createApiServer } from "./index.mjs";
import { createStore } from "./store.mjs";
import { validateCase, validateReview } from "./validation.mjs";
const image = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 2, 0xff, 0xd9]);
const sizedJpeg = (width, height) => {
  const bytes = Buffer.from([
    0xff, 0xd8, 0xff, 0xc0, 0, 11, 8, 0, 0, 0, 0, 1, 1, 0x11, 0, 0xff, 0xd9,
  ]);
  bytes.writeUInt16BE(height, 7);
  bytes.writeUInt16BE(width, 9);
  return `data:image/jpeg;base64,${bytes.toString("base64")}`;
};
const fixture = (overrides = {}) => ({
  clientEventId: "session-123:42",
  trackId: 42,
  sourceName: "Front entrance",
  sourceKind: "camera",
  className: "car",
  speedKmh: 64.5,
  speedLimit: 50,
  confidence: 0.92,
  captureTime: "2026-10-02T15:00:00.000Z",
  sourceTimestamp: 15.5,
  calibration: {
    points: [
      { x: 0.3, y: 0.2 },
      { x: 0.7, y: 0.2 },
      { x: 0.9, y: 0.9 },
      { x: 0.1, y: 0.9 },
    ],
    widthMeters: 8,
    lengthMeters: 24,
  },
  evidence: `data:image/jpeg;base64,${image.toString("base64")}`,
  ...overrides,
});
const temporary = () => mkdtempSync(join(tmpdir(), "velocity-test-"));
const remove = (directory) =>
  rmSync(directory, { recursive: true, force: true });
test("persisted cases are sequential, idempotent, immutable, and retain exact evidence hashes", () => {
  const directory = temporary();
  let store = createStore(directory);
  try {
    const first = store.create(validateCase(fixture()));
    assert.match(first.case.id, /^VEL-\d{4}-000001$/);
    assert.equal(first.case.state, "draft");
    assert.equal(first.case.simulation, false);
    assert.equal(first.case.vehicleBox, null);
    assert.equal(
      first.case.evidenceSha256,
      createHash("sha256").update(image).digest("hex"),
    );
    assert.deepEqual(store.evidence(first.case.id), image);
    assert.equal(store.create(validateCase(fixture())).duplicate, true);
    assert.equal(store.list().total, 1);
    assert.equal(store.audit().length, 1);
    assert.throws(
      () => store.create(validateCase(fixture({ speedKmh: 70 }))),
      /already used/,
    );
    const second = store.create(
      validateCase(fixture({ clientEventId: "session-123:43", trackId: 43 })),
    );
    assert.match(second.case.id, /000002$/);
    store.close();
    store = createStore(directory);
    assert.equal(store.get(first.case.id).speedKmh, 64.5);
    assert.equal(store.list().total, 2);
    const reviewed = store.review(
      first.case.id,
      validateReview({
        state: "approved",
        reviewer: "Alex",
        plate: "ab12 cde",
        notes: "Checked source image.",
      }),
    );
    assert.equal(reviewed.state, "approved");
    assert.equal(reviewed.plate, "AB12 CDE");
    assert.equal(reviewed.speedKmh, 64.5);
    assert.equal(store.audit(500, first.case.id).length, 2);
    assert.throws(
      () =>
        store.review(first.case.id, {
          state: "dismissed",
          reviewer: "Alex",
          plate: "",
          notes: "",
        }),
      /already been reviewed/,
    );
    const database = new DatabaseSync(join(directory, "velocity.sqlite"));
    try {
      assert.throws(
        () => database.exec("UPDATE cases SET record_json = '{}'"),
        /immutable|review is final/,
      );
      assert.throws(() => database.exec("DELETE FROM audit"), /append-only/);
      assert.throws(
        () => database.exec("UPDATE audit SET actor = 'changed'"),
        /append-only/,
      );
    } finally {
      database.close();
    }
    writeFileSync(
      join(directory, "evidence", `${first.case.id}.jpg`),
      Buffer.from("tampered"),
    );
    assert.throws(() => store.evidence(first.case.id), /integrity check/);
  } finally {
    store.close();
    remove(directory);
  }
});
test("vehicle bounds survive persistence, affect idempotency, and cannot be edited by review", () => {
  const directory = temporary();
  let store = createStore(directory);
  const vehicleBox = [100, 200, 300, 150];
  const payload = fixture({ evidence: sizedJpeg(1280, 752), vehicleBox });
  try {
    const checked = validateCase(payload);
    vehicleBox[0] = 999;
    assert.deepEqual(checked.record.vehicleBox, [100, 200, 300, 150]);
    const first = store.create(checked).case;
    const retry = { ...payload, vehicleBox: [100, 200, 300, 150] };
    assert.deepEqual(first.vehicleBox, retry.vehicleBox);
    assert.equal(store.create(validateCase(retry)).duplicate, true);
    for (const changed of [[101, 200, 300, 150], null, undefined])
      assert.throws(
        () => store.create(validateCase({ ...retry, vehicleBox: changed })),
        /already used/,
      );
    assert.throws(
      () =>
        validateReview({
          state: "dismissed",
          reviewer: "Alex",
          vehicleBox: [0, 0, 10, 10],
        }),
      /Unexpected field/,
    );
    store.close();
    store = createStore(directory);
    assert.deepEqual(store.get(first.id).vehicleBox, retry.vehicleBox);
    const reviewed = store.review(
      first.id,
      validateReview({ state: "dismissed", reviewer: "Alex" }),
    );
    assert.deepEqual(reviewed.vehicleBox, retry.vehicleBox);
    assert.equal(store.audit(500, first.id).length, 2);
    const database = new DatabaseSync(join(directory, "velocity.sqlite"));
    try {
      assert.throws(
        () =>
          database.exec(
            "UPDATE cases SET record_json = json_set(record_json, '$.vehicleBox', json('[0,0,10,10]'))",
          ),
        /immutable|review is final/,
      );
    } finally {
      database.close();
    }
  } finally {
    store.close();
    remove(directory);
  }
});
test("legacy JSON rows and queued retries keep historical fingerprints while responses expose null bounds", () => {
  const directory = temporary();
  let store = createStore(directory);
  try {
    const old = validateCase(fixture());
    assert.equal(Object.hasOwn(old.record, "vehicleBox"), false);
    const originalJson = JSON.stringify(old.record);
    const originalFingerprint = createHash("sha256")
      .update(originalJson)
      .digest("hex");
    assert.equal(old.fingerprint, originalFingerprint);
    const first = store.create(old).case;
    store.close();
    store = createStore(directory);
    assert.equal(store.get(first.id).vehicleBox, null);
    assert.equal(store.create(validateCase(fixture())).duplicate, true);
    assert.equal(
      store.create(validateCase(fixture({ vehicleBox: null }))).duplicate,
      true,
    );
    assert.equal(store.audit().length, 1);
    const database = new DatabaseSync(join(directory, "velocity.sqlite"));
    try {
      const row = database
        .prepare("SELECT record_json, fingerprint FROM cases WHERE id = ?")
        .get(first.id);
      assert.equal(row.record_json, originalJson);
      assert.equal(row.fingerprint, originalFingerprint);
    } finally {
      database.close();
    }
  } finally {
    store.close();
    remove(directory);
  }
});
test("vehicle bounds reject malformed coordinates, out-of-image regions and footer overlap", () => {
  const evidence = sizedJpeg(1280, 752);
  for (const vehicleBox of [
    {},
    [],
    Array(4),
    [0, 0, 5],
    [0, 0, 5, 5, 5],
    [NaN, 0, 5, 5],
    [0, Infinity, 5, 5],
    ["0", 0, 5, 5],
    [-1, 0, 5, 5],
    [0, -1, 5, 5],
    [0, 0, 0, 5],
    [0, 0, 5, -1],
    [0, 0, 2000, 5],
    [1279, 0, 2, 5],
    [0, 719, 5, 2],
    [0, 720, 5, 5],
  ])
    assert.throws(
      () => validateCase(fixture({ evidence, vehicleBox })),
      /vehicleBox/,
    );
  assert.deepEqual(
    validateCase(fixture({ evidence, vehicleBox: [0, 0, 1280, 720] })).record
      .vehicleBox,
    [0, 0, 1280, 720],
  );
  assert.throws(
    () => validateCase(fixture({ vehicleBox: [0, 0, 5, 5] })),
    /readable image dimensions/,
  );
});
test("input validation rejects missing calibration, bad measurements, malformed evidence, and unauthorized edits", () => {
  for (const override of [
    { speedKmh: 50 },
    { speedKmh: NaN },
    { speedLimit: 0 },
    { confidence: 1.1 },
    { calibration: null },
    { captureTime: "not a date" },
    { sourceTimestamp: -1 },
    { sourceKind: "rtsp" },
    { clientEventId: "../a" },
    { evidence: "data:image/png;base64,AA==" },
    { evidence: "data:image/jpeg;base64,@@@@" },
    { trackId: 1.2 },
    { state: "approved" },
  ])
    assert.throws(() => validateCase(fixture(override)));
  assert.throws(
    () =>
      validateCase(
        fixture({
          calibration: {
            points: [
              { x: 0, y: 0 },
              { x: 1, y: 1 },
              { x: 0, y: 1 },
              { x: 1, y: 0 },
            ],
            widthMeters: 8,
            lengthMeters: 20,
          },
        }),
      ),
    /convex/,
  );
  assert.throws(
    () => validateReview({ state: "approved", reviewer: "Alex" }),
    /plate is required/,
  );
  assert.throws(
    () =>
      validateReview({ state: "approved", plate: "AB12 CDE", reviewer: "" }),
    /reviewer is required/,
  );
  assert.throws(
    () =>
      validateReview({
        state: "approved",
        plate: "AB12 CDE",
        reviewer: "Alex",
        speedKmh: 80,
      }),
    /Unexpected field/,
  );
  assert.equal(
    validateCase(fixture({ sourceKind: "demo", calibration: null })).record
      .simulation,
    true,
  );
});
function call(port, method, path, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const payload =
      body === undefined
        ? undefined
        : typeof body === "string"
          ? body
          : JSON.stringify(body);
    const req = request(
      {
        hostname: "127.0.0.1",
        port,
        method,
        path,
        headers: {
          Host: "127.0.0.1:5174",
          ...(payload
            ? {
                "Content-Type": "application/json",
                "Content-Length": Buffer.byteLength(payload),
              }
            : {}),
          ...headers,
        },
      },
      (response) => {
        const chunks = [];
        response.on("data", (chunk) => chunks.push(chunk));
        response.on("end", () => {
          const bytes = Buffer.concat(chunks);
          resolve({
            status: response.statusCode,
            headers: response.headers,
            bytes,
            body:
              bytes.length &&
              response.headers["content-type"]?.includes("application/json")
                ? JSON.parse(bytes.toString())
                : undefined,
          });
        });
      },
    );
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}
test("HTTP API creates and reviews cases, rejects remote origins, and never exposes storage paths", async () => {
  const directory = temporary(),
    server = createApiServer({ dataDirectory: directory });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  try {
    assert.equal((await call(port, "GET", "/api/health")).body.status, "ok");
    for (const config of [
      null,
      [],
      { type: "unknown" },
      { type: "url", url: "file:///private.mp4" },
      {
        type: "nest",
        url: "https://user:secret@video.nest.com/live/2VNgNDSgKs",
      },
      {
        type: "nest",
        url: "https://video.nest.com/live/2VNgNDSgKs",
        password: "secret",
      },
      {
        type: "nest",
        url: "https://video.nest.com/live/2VNgNDSgKs",
        name: "x".repeat(81),
      },
    ]) {
      assert.equal(
        (await call(port, "POST", "/api/cameras/connect", config)).status,
        400,
      );
    }
    assert.equal(
      (await call(port, "DELETE", "/api/cameras/nest-2VNgNDSgKs")).body.stopped,
      true,
    );
    assert.equal(
      (await call(port, "GET", "/api/cameras/missing/index.m3u8")).status,
      404,
    );
    assert.equal(
      (
        await call(port, "GET", "/api/health", undefined, {
          Host: "attacker.example:5174",
        })
      ).status,
      403,
    );
    assert.equal(
      (
        await call(port, "POST", "/api/cases", fixture(), {
          Origin: "https://attacker.example",
        })
      ).status,
      403,
    );
    assert.equal(
      (
        await call(port, "GET", "/api/cases", undefined, {
          "Sec-Fetch-Site": "cross-site",
        })
      ).status,
      403,
    );
    assert.equal(
      (await call(port, "GET", "/data/velocity.sqlite")).status,
      404,
    );
    assert.equal((await call(port, "POST", "/api/cases", "{")).status, 400);
    assert.equal(
      (
        await call(port, "POST", "/api/cases", "x", {
          "Content-Type": "text/plain",
        })
      ).status,
      415,
    );
    const created = await call(port, "POST", "/api/cases", fixture(), {
      Origin: "http://localhost:5173",
    });
    assert.equal(created.status, 201);
    assert.equal(
      created.headers["access-control-allow-origin"],
      "http://localhost:5173",
    );
    const id = created.body.case.id;
    assert.equal(created.body.case.evidence, undefined);
    assert.equal(created.body.case.vehicleBox, null);
    assert.equal(
      (await call(port, "POST", "/api/cases", fixture())).status,
      200,
    );
    assert.equal(
      (await call(port, "POST", "/api/cases", fixture({ speedKmh: 72 })))
        .status,
      409,
    );
    assert.deepEqual(
      (await call(port, "GET", `/api/cases/${id}/evidence`)).bytes,
      image,
    );
    assert.equal(
      (await call(port, "GET", `/api/cases/${id}`)).body.case.id,
      id,
    );
    const review = await call(port, "PATCH", `/api/cases/${id}`, {
      state: "dismissed",
      reviewer: "Morgan",
      notes: "Occlusion during measurement.",
    });
    assert.equal(review.status, 200);
    assert.equal(review.body.case.state, "dismissed");
    assert.equal(
      (
        await call(port, "PATCH", `/api/cases/${id}`, {
          state: "approved",
          reviewer: "Morgan",
          plate: "AB12 CDE",
        })
      ).status,
      409,
    );
    assert.equal(
      (await call(port, "GET", `/api/audit?caseId=${id}`)).body.events.length,
      2,
    );
    assert.equal((await call(port, "GET", "/api/cases")).body.cases.length, 1);
    assert.equal((await call(port, "GET", "/api/cases?limit=0")).status, 400);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await server.monitorClosed;
    remove(directory);
  }
});
test("optional production serving handles GET/HEAD assets and rejects traversal, storage, and source paths", async () => {
  const directory = temporary(),
    build = join(directory, "dist"),
    data = join(directory, "private-data");
  mkdirSync(join(build, "assets"), { recursive: true });
  mkdirSync(join(build, "src"));
  mkdirSync(join(build, "data"));
  writeFileSync(
    join(build, "index.html"),
    '<!doctype html><div id="root">Velocity</div>',
  );
  writeFileSync(join(build, "assets", "app.js"), "export const app = true;");
  writeFileSync(join(build, "assets", "style.css"), "body{color:green}");
  writeFileSync(
    join(build, "favicon.svg"),
    '<svg xmlns="http://www.w3.org/2000/svg"/>',
  );
  writeFileSync(join(build, "src", "private.js"), "private source");
  writeFileSync(join(build, "data", "private.json"), '{"private":true}');
  writeFileSync(join(directory, "outside.js"), "outside secret");
  const outside = join(directory, "outside");
  mkdirSync(outside);
  writeFileSync(join(outside, "private.js"), "symlink secret");
  symlinkSync(
    outside,
    join(build, "linked"),
    process.platform === "win32" ? "junction" : "dir",
  );
  assert.throws(
    () =>
      createApiServer({
        dataDirectory: data,
        staticDirectory: join(directory, "missing"),
      }),
    /npm run build/,
  );
  const server = createApiServer({
    dataDirectory: data,
    staticDirectory: build,
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  try {
    const index = await call(port, "GET", "/");
    assert.equal(index.status, 200);
    assert.match(index.headers["content-type"], /^text\/html/);
    assert.match(index.bytes.toString(), /Velocity/);
    assert.match(index.headers["content-security-policy"], /worker-src/);
    assert.match(
      index.headers["content-security-policy"],
      /media-src 'self' https: blob:/,
    );
    const script = await call(port, "GET", "/assets/app.js?version=1");
    assert.equal(script.status, 200);
    assert.match(script.headers["content-type"], /^text\/javascript/);
    assert.equal(script.bytes.toString(), "export const app = true;");
    const head = await call(port, "HEAD", "/assets/style.css");
    assert.equal(head.status, 200);
    assert.equal(head.bytes.length, 0);
    assert.equal(
      Number(head.headers["content-length"]),
      Buffer.byteLength("body{color:green}"),
    );
    assert.equal(
      (await call(port, "GET", "/favicon.svg")).headers["content-type"],
      "image/svg+xml",
    );
    for (const path of [
      "/../outside.js",
      "/%2e%2e/outside.js",
      "/assets/%2e%2e/%2e%2e/outside.js",
      "/%2e%2e%5coutside.js",
      "/linked/private.js",
      "/data/private.json",
      "/src/private.js",
      "/server/index.mjs",
      "/.git/config",
      "/unknown-route",
      "/assets/app.js.map",
    ]) {
      assert.equal((await call(port, "GET", path)).status, 404, path);
    }
    assert.equal((await call(port, "GET", "/%E0%A4%A")).status, 400);
    const health = await call(port, "GET", "/api/health");
    assert.equal(health.body.status, "ok");
    assert.equal(
      health.headers["content-security-policy"],
      "default-src 'none'; frame-ancestors 'none'",
    );
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await server.monitorClosed;
    remove(directory);
  }
});
