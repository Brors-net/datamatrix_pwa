#!/usr/bin/env bash
set -euo pipefail

# Simple build script to produce libdmtx JS/WASM using Emscripten
# Requires: emsdk active (emcmake, emmake, emcc available)

ROOT_DIR=$(cd "$(dirname "$0")" && pwd)
SRC_DIR="$ROOT_DIR/libdmtx-src"
BUILD_DIR="$ROOT_DIR/libdmtx-build"

if [ ! -d "$SRC_DIR" ]; then
  echo "Cloning libdmtx into $SRC_DIR"
  git clone https://github.com/dmtx/libdmtx "$SRC_DIR"
fi

mkdir -p "$BUILD_DIR"
cd "$BUILD_DIR"

echo "Configuring with emcmake..."
emcmake cmake "$SRC_DIR" -DBUILD_SHARED_LIBS=OFF -DCMAKE_BUILD_TYPE=Release

echo "Building..."
emmake make -j$(nproc)

echo "Build complete. Now compile the JS/WASM module using your wrapper (libdmtx-wrapper.c)."

echo "Example:
 emcc $ROOT_DIR/libdmtx-wrapper.c -I $SRC_DIR/include -L $BUILD_DIR -ldmtx -s MODULARIZE=1 -s EXPORT_NAME=\"createLibDmtxModule\" -s EXPORTED_FUNCTIONS='["_scanImageBuffer","_malloc","_free"]' -s ALLOW_MEMORY_GROWTH=1 -o $ROOT_DIR/libdmtx.js"

echo "After running the above emcc command you'll have libdmtx.js and libdmtx.wasm in vendor/."
