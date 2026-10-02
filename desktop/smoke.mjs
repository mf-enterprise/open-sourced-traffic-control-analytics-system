import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
const root = resolve(fileURLToPath(new URL("../", import.meta.url)));
const executable = process.argv[2]
  ? resolve(process.argv[2])
  : join(root, "release", "win-unpacked", "Traffic Control.exe");
await stat(executable);
await mkdir(join(root, "artifacts"), { recursive: true });
const directory = await mkdtemp(join(root, "artifacts", "desktop-smoke-"));
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
delete env.NODE_OPTIONS;
const child = spawn(executable, ["--smoke-test-dir", directory], {
  env,
  windowsHide: true,
  stdio: "ignore",
  shell: false,
});
const exitCode = await new Promise((resolveExit, reject) => {
  const timeout = setTimeout(() => {
    child.kill();
    reject(new Error("Desktop smoke test exceeded five minutes."));
  }, 300000);
  child.once("error", (error) => {
    clearTimeout(timeout);
    reject(error);
  });
  child.once("close", (code) => {
    clearTimeout(timeout);
    resolveExit(code);
  });
});
if (exitCode !== 0) {
  const failure = await readFile(join(directory, "failure.json"), "utf8").catch(
    () => "No failure report was written.",
  );
  throw new Error(`Desktop smoke test failed (${exitCode}): ${failure}`);
}
const report = JSON.parse(
  await readFile(join(directory, "report.json"), "utf8"),
);
console.log(
  JSON.stringify(
    {
      directory,
      packaged: report.packaged,
      hostRejected: report.hostRejected,
      originRejected: report.originRejected,
      nodeExposed: report.renderer.nodeExposed,
      backendClosed: report.backendClosed,
      decodedFrames: report.native.decodedFrames.length,
      engine: report.native.engine,
      plateState: report.native.plateState,
    },
    null,
    2,
  ),
);
