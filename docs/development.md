# Development

Use Node.js 22.13 or newer. The local API uses built-in SQLite.

```sh
npm ci
npm run dev
```

The frontend runs on port 5173 and proxies requests to the local API on port 5174. Development and production builds download three pinned models and verify their SHA-256 hashes. Setup also copies matching browser ONNX Runtime assets.

```sh
npm test
npm run build
npm start
```

Tests use temporary storage. The optional native/model integration tests are identified as skipped unless their required environment is enabled. Camera timing and accuracy still need validation with representative hardware and ground truth.

## Windows desktop

```sh
npm run desktop:build
```

The desktop package contains the compiled interface, local API, detection models, native ONNX Runtime, and their notices. A private loopback service runs in a child process. The renderer has no Node.js access. Persistent data lives under the application's user-data directory, outside the extracted application.

FFmpeg is downloaded from a pinned upstream release on first launch and checked against an expected SHA-256. It is not redistributed inside the ZIP. Building the web application from source installs FFmpeg through `ffmpeg-static`.

## Project layout

| Directory | Contents |
| --- | --- |
| `src/vision` | Detection, tracking, geometry, speed, counting |
| `src/components` | Camera setup, live directory, background monitor |
| `server` | Capture, native inference, evidence, session history |
| `desktop` | Windows application and packaging |
| `scripts` | Model setup, shared runtime build, validation |
| `public/models` | Model manifests, licenses, and downloaded weights |

The repository excludes runtime databases, local research artifacts, generated builds, and model binaries. Do not commit camera credentials, evidence images, registration numbers, or recordings.

## Contributing

Keep changes focused and describe the observable behavior. Include a minimal reproduction for bugs. Add a regression test when it protects a meaningful boundary, such as timestamp handling, stream cleanup, evidence integrity, or camera switching. Run `npm test` and `npm run build` before submitting changes.
