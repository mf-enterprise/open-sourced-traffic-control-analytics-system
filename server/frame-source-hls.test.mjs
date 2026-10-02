import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, dirname, basename } from "node:path";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import ffmpeg from "ffmpeg-static";
import { createFrameSource } from "./frame-source.mjs";
test(
  "a delayed rolling HLS playlist stays continuous with output pacing; legacy input pacing loses segments",
  { timeout: 35000 },
  async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "velocity-rolling-hls-"));
    t.after(async () => {
      const target = resolve(directory);
      assert.equal(dirname(target), resolve(tmpdir()));
      assert.ok(basename(target).startsWith("velocity-rolling-hls-"));
      await rm(target, { recursive: true, force: true });
    });
    await promisify(execFile)(
      ffmpeg,
      [
        "-hide_banner",
        "-loglevel",
        "error",
        "-y",
        "-f",
        "lavfi",
        "-i",
        "testsrc2=size=160x96:rate=10",
        "-t",
        "22",
        "-c:v",
        "libx264",
        "-preset",
        "ultrafast",
        "-threads",
        "1",
        "-g",
        "10",
        "-keyint_min",
        "10",
        "-sc_threshold",
        "0",
        "-f",
        "hls",
        "-hls_time",
        "1",
        "-hls_list_size",
        "0",
        "-hls_segment_filename",
        join(directory, "part-%03d.ts"),
        join(directory, "archive.m3u8"),
      ],
      { windowsHide: true, timeout: 10000 },
    );
    const assets = new Map();
    for (let n = 0; n < 22; n++)
      assets.set(
        n,
        await readFile(
          join(directory, `part-${String(n).padStart(3, "0")}.ts`),
        ),
      );
    const modes = new Map(
      ["legacy", "current"].map((name) => [
        name,
        {
          name,
          epoch: null,
          requests: 0,
          frames: [],
          warnings: [],
          source: null,
          child: null,
          closed: false,
        },
      ]),
    );
    const server = createServer(async (req, res) => {
      const match = /^\/(legacy|current)\/(source\.m3u8|part-(\d+)\.ts)$/.exec(
        new URL(req.url, "http://localhost").pathname,
      );
      if (!match) {
        res.writeHead(404);
        res.end();
        return;
      }
      const mode = modes.get(match[1]);
      mode.epoch ??= performance.now();
      const elapsed = (performance.now() - mode.epoch) / 1000;
      if (match[2] === "source.m3u8") {
        const end = Math.min(21, 2 + Math.floor(elapsed)),
          start = Math.max(0, end - 2);
        const initial = mode.requests++ === 0;
        const playlist =
          [
            "#EXTM3U",
            "#EXT-X-VERSION:3",
            "#EXT-X-TARGETDURATION:2",
            `#EXT-X-MEDIA-SEQUENCE:${start}`,
            ...Array.from(
              { length: end - start + 1 },
              (_, i) =>
                `#EXTINF:1.000,\npart-${String(start + i).padStart(3, "0")}.ts`,
            ),
          ].join("\n") + "\n";
        if (initial) await delay(2000);
        res.writeHead(200, {
          "Content-Type": "application/vnd.apple.mpegurl",
          "Cache-Control": "no-cache",
        });
        res.end(playlist);
      } else {
        const bytes = assets.get(Number(match[3]));
        if (!bytes) {
          res.writeHead(404);
          res.end();
          return;
        }
        res.writeHead(200, {
          "Content-Type": "video/mp2t",
          "Content-Length": bytes.length,
        });
        res.end(bytes);
      }
    });
    await new Promise((done) => server.listen(0, "127.0.0.1", done));
    t.after(async () => {
      await Promise.all([...modes.values()].map((mode) => mode.source?.stop()));
      await new Promise((done) => server.close(done));
    });
    const started = await Promise.allSettled(
      [...modes.values()].map(async (mode) => {
        mode.source = await createFrameSource(
          `http://127.0.0.1:${server.address().port}/${mode.name}/source.m3u8`,
          {
            onFrame(frame) {
              mode.frames.push({
                index: frame.index,
                mediaSeconds: frame.mediaSeconds,
              });
            },
            spawn(executable, args, options) {
              if (mode.name === "legacy") {
                args = [...args];
                const i = args.indexOf("-vf") + 1;
                args[i] = args[i].replace(",realtime=limit=2:speed=1", "");
                args = args.filter((arg) => arg !== "-re");
                args.splice(args.indexOf("-i"), 0, "-re");
              }
              const child = spawn(executable, args, options);
              mode.child = child;
              let partial = "";
              child.stderr.on("data", (chunk) => {
                partial += chunk;
                const lines = partial.split("\n");
                partial = lines.pop();
                for (const line of lines)
                  if (/expired from playlists/.test(line))
                    mode.warnings.push(line);
              });
              child.once("close", () => {
                mode.closed = true;
              });
              return child;
            },
          },
        );
      }),
    );
    for (const result of started)
      if (result.status === "rejected") throw result.reason;
    await delay(15000);
    await Promise.all([...modes.values()].map((mode) => mode.source.stop()));
    const current = modes.get("current"),
      legacy = modes.get("legacy");
    const deltas = (mode) =>
      mode.frames
        .slice(1)
        .map((frame, i) => frame.mediaSeconds - mode.frames[i].mediaSeconds);
    assert.ok(
      legacy.warnings.length > 0,
      "the rolling fixture must actually reproduce expired segments",
    );
    assert.ok(
      deltas(legacy).some((delta) => delta > 1),
      "legacy decoder must lose at least one source segment",
    );
    assert.ok(
      current.frames.length >= 80,
      "enough actual frames must pass to span multiple playlist reloads",
    );
    assert.equal(
      current.warnings.length,
      0,
      "output pacing must keep its HLS cursor inside the live window",
    );
    assert.ok(
      deltas(current).every((delta) => delta > 0.0999 && delta < 0.1001),
      "every emitted frame retains consecutive original ten-fps source PTS",
    );
    for (const mode of modes.values()) {
      assert.ok(
        mode.frames.every(
          (frame, i) => !i || frame.index === mode.frames[i - 1].index + 1,
        ),
        "the lightweight test consumer must not hide pipe drops",
      );
      assert.equal(mode.closed, true);
      assert.throws(() => process.kill(mode.child.pid, 0), { code: "ESRCH" });
    }
  },
);
