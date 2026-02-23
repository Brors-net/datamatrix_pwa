# Brors.NET DataMatrix Scanner PWA

This repository contains a progressive web application for scanning DataMatrix codes using the device camera. It is built on open-source components and optimized for industrial use.

## Features

- Camera-based DataMatrix scanning
- Uses OpenCV for preprocessing and ZBar (webassembly) for decoding
- Responsive UI with modern design and dark/light mode support
- PWA capabilities (manifest, service worker) for offline usage
- Simple help section and result display

## Files

- `index.html` – main interface with video view and controls
- `style.css` – external stylesheet implementing a clean, responsive layout
- `app.js` – camera handling and frame processing logic
- `manifest.json` – PWA manifest
- `sw.js` – service worker (cache resources for offline use)
- `logo.png` – project logo
- `icons/` – PWA icon set

## Usage

1. Clone or download the repository.
2. Serve the folder with a local HTTP server (PWA features require HTTPS or localhost). Example:
   ```sh
   npx http-server . -c-1
   ```
3. Open the served URL in a mobile or desktop browser that supports camera access.
4. Grant camera permissions when prompted; the scanner will start automatically.
5. Hold a DataMatrix code in front of the camera; recognized content appears on screen.
6. Tap "Hilfe" for information about the app.

## Development

- The UI is simple HTML/CSS/JS; you can edit `style.css` or `index.html` to change appearance.
- `app.js` uses `[160](https://docs.opencv.org/)` and `zbar-wasm` from CDN; you can replace these with local builds if needed.

## Local `zbar-wasm` (recommended if CDN blocked)

If the browser blocks CDN scripts (Tracking Prevention) it's recommended to host `zbar-wasm` locally and point the app to the local files.

Steps to use the undecaf `zbar-wasm` build locally:

1. Download the published `index.js` and `zbar.wasm` from the `@undecaf/zbar-wasm` release (example):

   - `https://cdn.jsdelivr.net/npm/@undecaf/zbar-wasm@0.11.0/dist/index.js`
   - `https://cdn.jsdelivr.net/npm/@undecaf/zbar-wasm@0.11.0/dist/zbar.wasm`

   Or install via npm in a temporary folder and copy the `dist/` files:

   ```powershell
   npm pack @undecaf/zbar-wasm@0.11.0
   tar xzf @undecaf-zbar-wasm-*.tgz
   cp package/dist/* path\to\your\repo\vendor\zbar-wasm\
   ```

2. Place `index.js` (or `index.min.js`) and `zbar.wasm` into `vendor/zbar-wasm/` inside this project. The repository already contains a `vendor/zbar-wasm/` shim and a `fetch` helper.

3. Our `index.html` is configured to prefer the local files. If the WASM file is located in a non-standard place, `zbar-wasm` supports configuring the runtime location:

   ```js
   import { setModuleArgs } from '@undecaf/zbar-wasm';
   setModuleArgs({ locateFile: (filename, directory) => {
     return '/vendor/zbar-wasm/' + filename; // return URL to zbar.wasm
   }});
   // then call scanImageData(...) as usual
   ```

4. Start a local server and open the app (CDN blocking doesn't affect local files):

   ```powershell
   npx http-server . -c-1
   # or
   python -m http.server 8000
   ```

Troubleshooting
- If the console prints `ZBar (zbar-wasm) is not available` the local script didn't export the expected global; check `vendor/zbar-wasm/index.min.js` — our app tries to map common global names to `ZBar` but you can also load the `@undecaf` build directly.
- Ensure the web server serves `zbar.wasm` with `application/wasm` Content‑Type (most static servers do this automatically).
- If you still see tracking prevention messages, the problem was the CDN; using local files avoids that.

If you prefer not to host `zbar-wasm`, alternative JS decoders (e.g., `@zxing/library` or `jsQR`) can be integrated, but they may have different performance and DataMatrix support.

## Deployment

For deployment, push the files to any static hosting service that supports HTTPS (GitHub Pages, Netlify, Vercel, etc.). The service worker will cache assets and enable the app to run offline after the first visit.

## License

This project is provided under the [MIT License](LICENSE).

## Author

Joerg@brors.net

---

*This README was automatically generated.*
