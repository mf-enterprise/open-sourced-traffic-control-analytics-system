import { createNativePlateReader } from "./plate-engine.mjs";
let reader,
  busy = false;
process.on("message", async (message) => {
  if (busy || message?.method !== "read" || !Number.isSafeInteger(message.id)) {
    process.send?.({ id: message?.id, error: { code: "PLATE_PROTOCOL" } });
    return;
  }
  busy = true;
  try {
    reader ??= await createNativePlateReader();
    const result = await reader.read(message.frame);
    process.send?.({ id: message.id, result, info: reader.info });
  } catch (cause) {
    process.send?.({
      id: message.id,
      error: {
        code: cause?.code === "PLATE_ASSET" ? "PLATE_ASSET" : "PLATE_WORKER",
      },
    });
  } finally {
    busy = false;
  }
});
process.on("disconnect", () => process.exit(0));
