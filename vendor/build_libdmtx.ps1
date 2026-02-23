# PowerShell build script for libdmtx (Emscripten)
param()

$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$src = Join-Path $root 'libdmtx-src'
$build = Join-Path $root 'libdmtx-build'

if (-not (Test-Path $src)) {
    Write-Host "Cloning libdmtx into $src"
    git clone https://github.com/dmtx/libdmtx $src
}

if (-not (Test-Path $build)) { New-Item -ItemType Directory -Path $build | Out-Null }
Push-Location $build

Write-Host "Configuring with emcmake..."
emcmake cmake $src -DBUILD_SHARED_LIBS=OFF -DCMAKE_BUILD_TYPE=Release

Write-Host "Building..."
emmake make -j 4

Write-Host "Build complete. Compile the JS/WASM module using libdmtx-wrapper.c, for example:"
Write-Host "emcc libdmtx-wrapper.c -I <src>\\include -L <build> -ldmtx -s MODULARIZE=1 -s EXPORT_NAME=createLibDmtxModule -s EXPORTED_FUNCTIONS=['_scanImageBuffer','_malloc','_free'] -s ALLOW_MEMORY_GROWTH=1 -o libdmtx.js"

Pop-Location

# Try to automatically invoke emcc if available
$emcc = Get-Command emcc -ErrorAction SilentlyContinue
if ($emcc) {
    Push-Location $root
    Write-Host "Invoking emcc to build vendor/libdmtx.js and vendor/libdmtx.wasm..."
    $out = Join-Path $root 'libdmtx.js'
    # Build argument array to avoid PowerShell quoting/escaping issues
    $args = @(
        'libdmtx-wrapper.c',
        '-I', (Join-Path $src 'include'),
        '-L', $build,
        '-ldmtx',
        '-s', 'MODULARIZE=1',
        '-s', 'EXPORT_NAME=createLibDmtxModule',
        '-s', 'EXPORTED_FUNCTIONS=["_scanImageBuffer","_malloc","_free"]',
        '-s', 'ALLOW_MEMORY_GROWTH=1',
        '-o', $out
    )
    Write-Host "emcc" ( $args -join ' ' )
    & emcc @args
    Pop-Location
    Write-Host "If the previous command succeeded you should now have libdmtx.js and libdmtx.wasm in the vendor folder."
} else {
    Write-Host "emcc not found on PATH — please run the example emcc command above after installing Emscripten (emsdk)."
}
