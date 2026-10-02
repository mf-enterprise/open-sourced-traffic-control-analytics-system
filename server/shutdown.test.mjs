import test from "node:test";
import assert from "node:assert/strict";
import { closeServiceResources } from "./shutdown.mjs";
test("a gateway failure still waits for evidence drain before closing every store", async () => {
  const events = [];
  let release;
  const drain = new Promise((resolve) => {
    release = resolve;
  });
  const operation = closeServiceResources({
    initialRecovery: Promise.resolve(),
    monitor: {
      async close() {
        events.push("monitor-start");
        await drain;
        events.push("evidence-drained");
      },
    },
    cameras: {
      async close() {
        events.push("gateway-start");
        throw new Error("gateway");
      },
    },
    storage: [
      {
        close() {
          events.push("outbox-close");
          throw new Error("outbox");
        },
      },
      {
        close() {
          events.push("journal-close");
        },
      },
      {
        close() {
          events.push("store-close");
        },
      },
    ],
  });
  const checked = assert.rejects(
    operation,
    (error) => error instanceof AggregateError && error.errors.length === 2,
  );
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(events.sort(), ["gateway-start", "monitor-start"]);
  release();
  await checked;
  assert.deepEqual(events.slice(2), [
    "evidence-drained",
    "outbox-close",
    "journal-close",
    "store-close",
  ]);
});
test("recovery and synchronous owner failures do not skip remaining cleanup", async () => {
  const events = [];
  await assert.rejects(
    closeServiceResources({
      initialRecovery: Promise.reject(new Error("recovery")),
      monitor: {
        close() {
          events.push("monitor");
          throw new Error("monitor");
        },
      },
      cameras: {
        close() {
          events.push("camera");
        },
      },
      storage: [
        {
          close() {
            events.push("storage");
          },
        },
      ],
    }),
    (error) => error instanceof AggregateError && error.errors.length === 2,
  );
  assert.deepEqual(events, ["monitor", "camera", "storage"]);
});
test("successful cleanup resolves only after both camera owners finish", async () => {
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  let saved = false;
  const operation = closeServiceResources({
    initialRecovery: Promise.resolve(),
    monitor: { close() {} },
    cameras: {
      close() {
        return gate;
      },
    },
    storage: [
      {
        close() {
          saved = true;
        },
      },
    ],
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(saved, false);
  release();
  await operation;
  assert.equal(saved, true);
});
