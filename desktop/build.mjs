import {
  cp,
  mkdir,
  readFile,
  writeFile,
  readdir,
  stat,
  rm,
} from "node:fs/promises";
import { createHash } from "node:crypto";
import { dirname, join, relative, resolve, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "electron-builder";

const root = resolve(fileURLToPath(new URL("../", import.meta.url)));
const work = join(root, ".desktop-build");
const stage = join(work, "app");
const output = join(root, "release");
const pkg = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
const shipped = new Map();
const notices = [];
const noticed = new Set();
const supplemental = JSON.parse(
  await readFile(join(root, "desktop", "license-manifest.json"), "utf8"),
).entries;

async function packageDirectory(name, parent) {
  let directory = parent;
  while (true) {
    const candidate = join(directory, "node_modules", name);
    try {
      const manifest = JSON.parse(
        await readFile(join(candidate, "package.json"), "utf8"),
      );
      if (manifest.name === name) return { directory: candidate, manifest };
    } catch {}
    const next = dirname(directory);
    if (next === directory)
      throw new Error(`Missing desktop dependency: ${name}`);
    directory = next;
  }
}
function supports(values, selected) {
  return (
    !values ||
    (!values.includes(`!${selected}`) &&
      (!values.some((value) => !value.startsWith("!")) ||
        values.includes(selected)))
  );
}
async function copyPackage(name, parent, ancestors = new Set()) {
  const found = await packageDirectory(name, parent);
  if (
    !supports(found.manifest.os, "win32") ||
    !supports(found.manifest.cpu, "x64")
  )
    return;
  const key = `${name}@${found.manifest.version}`;
  if (shipped.has(name)) {
    if (shipped.get(name) !== key)
      throw new Error(`Conflicting desktop runtime dependency: ${name}`);
    return;
  }
  if (ancestors.has(key)) return;
  shipped.set(name, key);
  const target = join(stage, "node_modules", name);
  await cp(found.directory, target, {
    recursive: true,
    filter: (path) => {
      const part = relative(found.directory, path).replaceAll("\\", "/");
      if (!part) return true;
      if (
        part.split("/").includes("node_modules") ||
        /(?:^|\/)(?:test|tests|__tests__|\.git|script|scripts)(?:\/|$)/.test(
          part,
        ) ||
        /\.(?:map|ts|md)$/i.test(part)
      )
        return false;
      if (
        name === "onnxruntime-node" &&
        part.startsWith("bin/napi-v6/") &&
        !part.startsWith("bin/napi-v6/win32") &&
        part !== "bin/napi-v6"
      )
        return false;
      if (
        name === "onnxruntime-node" &&
        part.startsWith("bin/napi-v6/win32/") &&
        !part.startsWith("bin/napi-v6/win32/x64")
      )
        return false;
      return true;
    },
  });
  await collectNotices(name, parent);
  const nextAncestors = new Set([...ancestors, key]);
  for (const dep of Object.keys(found.manifest.dependencies ?? {}))
    await copyPackage(dep, found.directory, nextAncestors);
  for (const dep of Object.keys(found.manifest.optionalDependencies ?? {})) {
    try {
      await copyPackage(dep, found.directory, nextAncestors);
    } catch (error) {
      if (!error.message.startsWith("Missing desktop dependency:")) throw error;
    }
  }
}
async function collectNotices(name, parent) {
  const found = await packageDirectory(name, parent);
  if (
    !supports(found.manifest.os, "win32") ||
    !supports(found.manifest.cpu, "x64")
  )
    return;
  const key = `${name}@${found.manifest.version}`;
  if (noticed.has(key)) return;
  noticed.add(key);
  const licenses = [];
  for (const entry of supplemental.filter((entry) =>
    entry.packages.includes(name),
  )) {
    const content = await readFile(
      join(root, "desktop", "licenses", entry.file),
    );
    if (createHash("sha256").update(content).digest("hex") !== entry.sha256)
      throw new Error(`Supplemental license changed: ${entry.file}`);
    await writeFile(join(stage, "licenses", entry.file), content);
    licenses.push(`licenses/${entry.file}`);
  }
  for (const file of await readdir(found.directory)) {
    if (
      /^(?:licen[cs]e|copying|notice|copyright)(?:[.\-_].*)?$/i.test(file) &&
      (await stat(join(found.directory, file))).isFile()
    ) {
      const content = await readFile(join(found.directory, file), "utf8");
      const licenseName = `${key.replaceAll("/", "_")}--${file}`;
      await writeFile(join(stage, "licenses", licenseName), content);
      licenses.push(`licenses/${licenseName}`);
    }
  }
  const manifestName = `${key.replaceAll("/", "_")}--package.json`;
  await cp(
    join(found.directory, "package.json"),
    join(stage, "licenses", manifestName),
  );
  licenses.push(`licenses/${manifestName}`);
  notices.push({
    package: name,
    version: found.manifest.version,
    license: found.manifest.license ?? "See package notice",
    repository: found.manifest.repository ?? null,
    files: licenses,
  });
  for (const dep of Object.keys(found.manifest.dependencies ?? {}))
    await collectNotices(dep, found.directory);
  for (const dep of Object.keys(found.manifest.optionalDependencies ?? {})) {
    try {
      await collectNotices(dep, found.directory);
    } catch (error) {
      if (!error.message.startsWith("Missing desktop dependency:")) throw error;
    }
  }
}

if (process.platform !== "win32" || process.arch !== "x64")
  throw new Error("Build the Windows x64 desktop release on Windows x64.");
if (
  dirname(stage) !== work ||
  dirname(work) !== root ||
  basename(work) !== ".desktop-build"
)
  throw new Error("Invalid desktop staging boundary.");
await rm(stage, { recursive: true, force: true });
await mkdir(join(stage, "licenses"), { recursive: true });
await cp(join(root, "dist"), join(stage, "dist"), {
  recursive: true,
  filter: (path) => !path.endsWith(".map"),
});
await cp(join(root, "server"), join(stage, "server"), {
  recursive: true,
  filter: (path) =>
    !path.endsWith(".test.mjs") && basename(path) !== "tests.mjs",
});
await cp(join(root, "public", "models"), join(stage, "public", "models"), {
  recursive: true,
});
await cp(join(root, "desktop"), join(stage, "desktop"), {
  recursive: true,
  filter: (path) =>
    ![
      "build.mjs",
      "smoke.mjs",
      "collect-notices.mjs",
      "fetch-native-sources.mjs",
    ].includes(basename(path)) && !path.endsWith(".test.mjs"),
});
for (const name of ["onnxruntime-node", "sharp", "onvif"])
  await copyPackage(name, root);
for (const name of Object.keys(pkg.dependencies).filter(
  (name) => name !== "ffmpeg-static",
))
  await collectNotices(name, root);
for (const name of ["LICENSE", "README.md", "THIRD_PARTY_NOTICES.txt"]) {
  try {
    await cp(join(root, name), join(stage, name));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}
await cp(join(root, "public", "brand"), join(stage, "public", "brand"), {
  recursive: true,
});
await cp(join(root, "docs"), join(stage, "docs"), { recursive: true });
await writeFile(
  join(stage, "package.json"),
  JSON.stringify(
    {
      name: "traffic-control",
      productName: "Traffic Control",
      version: pkg.version,
      private: true,
      type: "module",
      main: "desktop/main.mjs",
      description: "Local traffic intelligence and evidence review",
      author: "Traffic Control",
      license: "MIT",
      dependencies: Object.fromEntries(
        [...shipped.keys()].map((name) => [
          name,
          shipped.get(name).slice(name.length + 1),
        ]),
      ),
    },
    null,
    2,
  ) + "\n",
);
await writeFile(
  join(stage, "THIRD-PARTY-NOTICES.json"),
  JSON.stringify(
    {
      generatedAt: new Date().toISOString(),
      packages: notices,
      models:
        "Model licenses, notices and source references are included in public/models and dist/models.",
      videoEngine:
        "FFmpeg is downloaded directly from the upstream release on first launch; its binary is not included in this ZIP. Source and license: https://github.com/eugeneware/ffmpeg-static/releases/tag/b6.1.1",
      nativeReplacement:
        "Runtime native libraries are unpacked and can be replaced with compatible builds. See each package license and upstream repository for sources and build instructions.",
      nativeSources: {
        artifact: "Native-Sources-1.0.0-Windows-x64.zip",
        sha256:
          "cc367678880cc95b0ea2981e3733387ad8f62a87509c865b16f7a4adcf894ee5",
        manifest: "desktop/native-source-manifest.json",
        instructions: "desktop/NATIVE-SOURCES.md",
        distribution:
          "Keep the native source companion alongside the application ZIP. It contains source archives, build recipes and verification instructions for the bundled sharp native libraries and ONNX Runtime Eigen dependency.",
      },
    },
    null,
    2,
  ) + "\n",
);
const files = [];
async function inventory(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) await inventory(path);
    else if (entry.isFile())
      files.push({
        path: relative(stage, path).replaceAll("\\", "/"),
        bytes: (await stat(path)).size,
      });
    else throw new Error("Desktop stage contains an unsupported file type.");
  }
}
await inventory(stage);
for (const file of files) {
  if (
    /(?:^|\/)(?:data|artifacts|\.git|ffmpeg-static)(?:\/|$)|\.sqlite(?:-|$)|\.db$|\.env(?:\.|$)|ffmpeg\.exe$/.test(
      file.path,
    )
  )
    throw new Error(
      `Unexpected private or excluded desktop file: ${file.path}`,
    );
}
await mkdir(output, { recursive: true });
await writeFile(
  join(work, "stage-manifest.json"),
  JSON.stringify({ createdAt: new Date().toISOString(), files }, null, 2) +
    "\n",
);
const artifacts = await build({
  config: {
    appId: "com.trafficcontrol.desktop",
    productName: "Traffic Control",
    electronVersion: pkg.devDependencies.electron,
    electronDist: join(root, "node_modules", "electron", "dist"),
    directories: { app: stage, output, buildResources: join(root, "desktop") },
    asar: false,
    npmRebuild: false,
    nodeGypRebuild: false,
    files: ["**/*"],
    artifactName: "Traffic-Control-${version}-Windows-x64.${ext}",
    compression: "normal",
    win: {
      target: [{ target: "zip", arch: ["x64"] }],
      icon: join(root, "desktop", "icon.ico"),
      signAndEditExecutable: true,
      requestedExecutionLevel: "asInvoker",
    },
    publish: null,
  },
});
const hashes = [];
const sourceArchive = join(output, "Native-Sources-1.0.0-Windows-x64.zip");
try {
  await stat(sourceArchive);
  artifacts.push(sourceArchive);
} catch (error) {
  if (error.code !== "ENOENT") throw error;
}
for (const artifact of artifacts) {
  const bytes = await readFile(artifact);
  hashes.push({
    file: basename(artifact),
    bytes: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  });
}
await writeFile(
  join(output, "SHA256SUMS.txt"),
  hashes.map((item) => `${item.sha256}  ${item.file}`).join("\n") + "\n",
);
console.log(
  JSON.stringify(
    {
      artifacts: hashes,
      stageFiles: files.length,
      stageBytes: files.reduce((sum, file) => sum + file.bytes, 0),
    },
    null,
    2,
  ),
);
