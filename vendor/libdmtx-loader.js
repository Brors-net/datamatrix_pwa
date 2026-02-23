// libdmtx loader scaffold
// Place a compiled Emscripten build into `vendor/` (e.g. libdmtx.js + libdmtx.wasm)
// This file exposes `window.LibDmtx.scanImageData(imgData)` when available.

window.LibDmtx = window.LibDmtx || {
  ready: false,
  _impl: null,
  async init() {
    if (this.ready) return;
    // Prefer an ESM-style module at vendor/libdmtx.js if present
    try {
      if (typeof import === 'function') {
        // dynamic import may fail on plain script files; try script fallback below
        const mod = await import('./libdmtx.js');
        if (mod && (mod.default || mod.LibDmtx)) {
          this._impl = mod.default || mod.LibDmtx;
          this.ready = true;
          return;
        }
      }
    } catch (e) {
      // ignore, try script tag loader next
    }

    // Script tag loader: vendor/libdmtx.js should register `window._libdmtx` or similar
    try {
      await new Promise((resolve, reject) => {
        const s = document.createElement('script');
        s.src = 'vendor/libdmtx.js';
        s.onload = () => setTimeout(resolve, 0);
        s.onerror = () => reject(new Error('libdmtx script failed to load'));
        document.head.appendChild(s);
      });
      // Expected global set by compiled glue (adapt if your build differs)
      if (window._libdmtx && typeof window._libdmtx.scanImageData === 'function') {
        this._impl = window._libdmtx;
        this.ready = true;
        return;
      }
    } catch (e) {
      console.warn('libdmtx loader: no vendor build found', e);
    }

    // no implementation available
    this.ready = false;
  },

  async scanImageData(imgData) {
    if (!this.ready) await this.init();
    if (!this._impl) return null;
    try {
      // expected to return an array of detection objects similar to ZBar
      return await this._impl.scanImageData(imgData);
    } catch (e) {
      console.warn('libdmtx scan failed', e);
      return null;
    }
  }
};
