# Native source companion — sharp 0.35.5 and ONNX Runtime Eigen

These instructions describe the separate release download `Native-Sources-1.0.0-Windows-x64.zip`. The application ZIP includes this document and the source manifest; obtain the companion ZIP for the source archives and verification tools described below.

This archive contains source code and build recipes corresponding to the native image-processing package `@img/sharp-win32-x64@0.35.5` in Traffic Control. Keep this companion alongside the Windows binary ZIP when distributing that ZIP. Each upstream project retains its own copyright and license; its source archive contains the applicable license files. `sharp-package-README.md` records the upstream package's library/license table. The separately identified Eigen source used by ONNX Runtime is also included. This is not a source archive for every other component of Traffic Control.

## Contents and provenance

- All 28 versions in the shipped package's `versions.json` have matching source archives.
- 27 top-level library archives match the SHA256 checksums in the recorded upstream MXE build recipes.
- Fontconfig 2.18.3 is supplied from the project's GitHub mirror at commit `06009a87a8ff2d7978c6032cf55d514d4ee303b1`. Both the official GitLab and GitHub tag refs resolved to that same commit. GitLab's `.tar.bz2` download was unavailable during collection; this GitHub `.tar.gz` is a different archive container with its own recorded SHA256. It is not asserted to match the unavailable archive's checksum.
- All 357 registry packages named in librsvg 2.63.2's `Cargo.lock` are included as `.crate` source archives, checked against that lock file. This intentionally includes optional, platform-specific and development packages, beyond those actually linked in the Windows build.
- The libvips release embeds libnsgif sources. GLib embeds gvdb; its pinned gvdb source is also supplied separately.
- Exact Rust nightly 2026-09-24, LLVM 23.1.2, mingw-w64 runtime and llvm-mingw build sources are included. Rust's source release includes its standard-library vendored dependencies.
- Complete sharp v0.35.5, sharp-libvips v1.3.4, libvips/build-win64-mxe v8.18.7 and the recorded MXE source snapshot include their build scripts and patches.

The shipped `libvips-42.dll` is byte-identical to the DLL in upstream `vips-dev-x64-web-8.18.7-static.zip`, SHA256 `06dab07cc386748513337a31672b1d5269fbc770a14ff403080575665bf0813f`. The full upstream version matrix matches the shipped package. See `native-source-manifest.json` for original URLs, exact revisions, checksums and validation limits. `SHA256SUMS.txt` covers every source archive.

## Verify and inspect

Run `python verify-sources.py` from this directory using Python 3. The verifier checks every manifest-listed source archive and fails on missing or changed bytes. Source archives are left compressed to preserve the exact verified upstream downloads. Use standard tar tools to extract them; `.crate` files are gzip-compressed tar archives. Inspect upstream license files before reusing individual components.

## Rebuilding the library

The Windows libvips DLL uses the upstream cross-build recipe in `build-win64-mxe-v8.18.7.tar.gz`. That repository's README, `build.sh`, `build/settings/release.mk`, `container/base.Dockerfile`, `container/Dockerfile`, and `build/plugins` describe the toolchain, compiler options and patches. The static-web variant builds a shared `libvips-42.dll` containing statically linked dependencies. It is the default web variant, without HEVC or the all-dependencies option.

On a suitable Linux machine with Docker or Podman and the prerequisites documented upstream, the upstream invocation is:

```sh
./build.sh --without-prebuilt --target x86_64-w64-mingw32.static vips-web
```

This command has not been executed as part of this collection. It may access the network for bootstrap tools and source archives. The base recipe names MXE branch `llvm-mingw-20260924`; use the supplied snapshot/recorded commit `c36160b231e66e1cbe032ed54aef7617e8b259da` if preparing a fixed build environment. The original upstream release's precise historical base-container digest was not established. This is not a fully offline build environment or a byte-reproducibility claim.

To build from the supplied alternative Fontconfig archive, adjust the MXE fontconfig recipe's source file, checksum and extraction directory to the values in the manifest (`fontconfig-2.18.3.tar.gz`, its recorded SHA256, and `fontconfig-06009a87a8ff2d7978c6032cf55d514d4ee303b1`). Its source URL is also recorded. Other library archive checksums are unchanged from the upstream recipes. The MXE recipes and source archive names show how to populate an MXE download cache or substitute locally modified sources.

For librsvg's Rust dependencies, the supplied `.crate` archives preserve the exact Cargo lock-file packages. They can populate a Cargo source cache or be unpacked into a Cargo directory source with normal Cargo checksum metadata. Do not silently update the lock file when rebuilding the recorded version.

The sharp-libvips v1.3.4 `build/win.sh` post-processes the static-web libvips output. The sharp v0.35.5 `src/binding.gyp` and `.github/workflows/ci.yml` describe rebuilding the Node addon and the separate MSVC `libvips-cpp-8.18.7.dll`; the C++ binding sources are in the libvips source archive. On Windows this requires the upstream documented Node.js, Python and Visual Studio C++ build prerequisites. Use the upstream sharp build instructions when making ABI-compatible replacements.

These materials have been checked for source version identity and archive integrity. A full cross-build, DLL replacement/relink test, or legal clearance of the entire application has not been established by this archive.

## Separate ONNX Runtime dependency: Eigen

`eigen-1d8b82b0740839c0de7f1242a3585e3390ff5f33.zip` contains the complete Eigen source archive pinned in ONNX Runtime v1.30.0 `cmake/deps.txt`. Its SHA1 exactly matches the upstream recipe (`05b19b49e6fbb91246be711d801160528c135e34`); its SHA256 is recorded in the manifest. Eigen includes its MPL-2.0 license text and per-file notices. This extra archive does not claim to contain all ONNX Runtime sources or to establish a rebuilt ONNX binary.
