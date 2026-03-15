#!/bin/bash
# Build StormLib as a WebAssembly module using Emscripten.
#
# Prerequisites:
#   - Emscripten SDK installed and activated (source emsdk_env.sh)
#   - Git
#
# Usage:
#   ./build-stormlib.sh

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
BUILD_DIR="$SCRIPT_DIR/build"
STORMLIB_DIR="$BUILD_DIR/StormLib"

echo "=== Building StormLib WASM ==="

# Clone StormLib if not present
if [ ! -d "$STORMLIB_DIR" ]; then
    echo "Cloning StormLib..."
    git clone https://github.com/ladislav-zezula/StormLib.git "$STORMLIB_DIR"
fi

cd "$STORMLIB_DIR"

# Collect source files
SOURCES=$(find src -name '*.c' | grep -v 'StormPort' | tr '\n' ' ')

echo "Compiling with Emscripten..."
emcc \
    -O2 \
    -s MODULARIZE=1 \
    -s EXPORT_NAME=CreateStormLib \
    -s EXPORTED_FUNCTIONS='["_SFileOpenArchive","_SFileCloseArchive","_SFileOpenFileEx","_SFileGetFileSize","_SFileReadFile","_SFileCloseFile","_SFileHasFile","_SFileFindFirstFile","_SFileFindNextFile","_SFileFindClose","_SFileCreateFile","_SFileWriteFile","_SFileFinishFile","_malloc","_free"]' \
    -s EXPORTED_RUNTIME_METHODS='["ccall","cwrap","UTF8ToString","stringToUTF8","HEAPU8"]' \
    -s ALLOW_MEMORY_GROWTH=1 \
    -s NODERAWFS=1 \
    -s ENVIRONMENT=node \
    -I src \
    $SOURCES \
    -lz -lbz2 \
    -o "$SCRIPT_DIR/stormlib.js"

echo "=== Build complete ==="
echo "Output: $SCRIPT_DIR/stormlib.js"
echo "Output: $SCRIPT_DIR/stormlib.wasm"
