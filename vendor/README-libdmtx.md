# Building libdmtx for the PWA (WASM)

This document shows how to produce a libdmtx JavaScript/WASM build that can be loaded by `vendor/libdmtx-loader.js`.

Goal
- Produce `vendor/libdmtx.js` and `vendor/libdmtx.wasm` (or an ESM variant) that expose a JS-friendly API such as `scanImageData(imgData)`.

Prerequisites
- Emscripten SDK installed and active (https://emscripten.org/docs/getting_started/downloads.html)
- `emcmake`, `emmake`, `emcc` on PATH
- `git`, `cmake`, `make` or `ninja`

High-level steps (recommended)
1. Clone libdmtx

```bash
git clone https://github.com/dmtx/libdmtx vendor/libdmtx-src
mkdir -p vendor/libdmtx-build
cd vendor/libdmtx-build
emcmake cmake ../libdmtx-src -DBUILD_SHARED_LIBS=OFF -DCMAKE_BUILD_TYPE=Release
emmake make -j$(nproc)
```

2. Create a small C wrapper that exposes a simple API `scanImageBuffer(uint8_t *rgba, int w, int h)` which uses libdmtx to detect/ decode DataMatrix and returns a pointer to a JSON string (allocated with `malloc`) describing results. Put this wrapper in `vendor/libdmtx-wrapper.c`.

3. Compile the wrapper to JS/WASM and export the wrapper function (example flags):

```bash
# from vendor/ directory
emcc libdmtx-wrapper.c \
  -I libdmtx-src/include -L ../libdmtx-build -ldmtx \
  -s MODULARIZE=1 -s EXPORT_NAME="createLibDmtxModule" \
  -s EXPORTED_FUNCTIONS='["_scanImageBuffer","_malloc","_free"]' \
  -s ALLOW_MEMORY_GROWTH=1 \
  -o libdmtx.js
```

This will produce `libdmtx.js` and `libdmtx.wasm` which the loader expects in `vendor/`.

Loader expectations
- `vendor/libdmtx-loader.js` (already added) tries to dynamically import `vendor/libdmtx.js` or load it via a script tag. The produced module should expose a function the loader can call (adapt loader if your build uses a different export name).
- The simplest pattern is that `libdmtx.js` provides a function to instantiate the module and returns an object with a `scanImageData(imgData)` helper implemented in the JS glue that calls `_scanImageBuffer` and converts returned JSON into JS objects.

Docker alternative (no local emsdk)
- Use `emscripten/emsdk` Docker image and run the same steps inside the container.

Notes and next steps
- I can provide a `libdmtx-wrapper.c` template, and a minimal JS glue that exposes `scanImageData(imgData)` (allocates memory with `_malloc`, copies pixels, calls `_scanImageBuffer`, reads the returned char*), then frees memory.
- If you want, I can prepare `libdmtx-wrapper.c` and the glue and a PowerShell script to run the build on Windows.


Windows notes
- The repository includes `build_libdmtx.ps1` — a PowerShell helper that clones libdmtx, configures and builds it with `emcmake`/`emmake`, and will attempt to invoke `emcc` to compile `libdmtx-wrapper.c` into `libdmtx.js` if `emcc` is available on PATH.
- On Windows install the Emscripten SDK and follow the usual activation steps (run `emsdk activate latest` and `emsdk_env.bat` in your shell) so `emcc`, `emcmake`, and `emmake` are on PATH before running the PS1 script.

Next actions I can take:
- Draft a complete `libdmtx-wrapper.c` implementation (already added) and `libdmtx-glue.js` (already added) so you can run the PowerShell script on Windows to produce `vendor/libdmtx.js` and `vendor/libdmtx.wasm`.
- Or, if you prefer, provide a Docker command to build inside a container instead of local Windows emsdk.
If you want me to continue, tell me whether you prefer a native `emcc` local build or a Docker-based build, and I will add the wrapper and glue files and the platform scripts. Alternatively, provide an already-built `libdmtx.js`/`libdmtx.wasm` and I will integrate it into the app.
