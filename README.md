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

## Deployment

For deployment, push the files to any static hosting service that supports HTTPS (GitHub Pages, Netlify, Vercel, etc.). The service worker will cache assets and enable the app to run offline after the first visit.

## License

This project is provided under the [MIT License](LICENSE).

## Author

Joerg@brors.net

---

*This README was automatically generated.*
