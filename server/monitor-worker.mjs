import { parentPort } from "node:worker_threads";
import { createVisionEngine } from "./vision-engine.mjs";
let engine;
let queue = Promise.resolve();
parentPort.on("message", ({ id, method, frame }) => {
  queue = queue.then(async () => {
    try {
      let result;
      if (method === "init") {
        engine = await createVisionEngine({ provider: "auto" });
        result = engine.info;
      } else if (method === "frame") {
        result = await engine.processFrame(frame);
      } else if (method === "reset") {
        engine?.resetContext();
      } else if (method === "close") {
        await engine?.close();
      } else throw new Error("Unsupported operation.");
      parentPort.postMessage({ id, result });
    } catch {
      parentPort.postMessage({
        id,
        error: "The native detector could not process this operation.",
      });
    }
  });
});
