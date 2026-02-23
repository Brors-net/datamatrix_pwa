// JS glue for libdmtx Emscripten module
// Exposes window._libdmtx.scanImageData(imgData) -> Promise<array-of-detections>

window._libdmtx = window._libdmtx || (function () {
  let _modPromise = null;
  let Module = null;

  function init() {
    if (_modPromise) return _modPromise;
    _modPromise = new Promise((resolve, reject) => {
      // The generated module should export a factory named createLibDmtxModule
      if (typeof createLibDmtxModule === 'function') {
        createLibDmtxModule().then(m => { Module = m; resolve(m); }).catch(reject);
        return;
      }
      // Otherwise, try to use global Module (non-modularized build)
      if (typeof Module !== 'undefined' && Module) {
        resolve(Module);
        return;
      }
      reject(new Error('libdmtx module factory not found'));
    });
    return _modPromise;
  }

  async function scanImageData(imgData) {
    await init();
    if (!Module) return null;
    try {
      const w = imgData.width;
      const h = imgData.height;
      const pixelCount = w * h * 4; // RGBA
      const ptr = Module._malloc(pixelCount);
      if (!ptr) throw new Error('malloc failed');
      // copy pixels into WASM heap
      Module.HEAPU8.set(imgData.data, ptr);
      // call the C wrapper: _scanImageBuffer(ptr, w, h) -> returns char* (malloced)
      const resPtr = Module._scanImageBuffer(ptr, w, h);
      Module._free(ptr);
      if (!resPtr) return null;
      const json = Module.UTF8ToString(resPtr);
      // free returned C string
      Module._free(resPtr);
      let parsed = null;
      try { parsed = JSON.parse(json); } catch (e) { parsed = null; }
      return parsed;
    } catch (e) {
      console.warn('libdmtx glue error', e);
      return null;
    }
  }

  return {
    init,
    scanImageData
  };
})();
