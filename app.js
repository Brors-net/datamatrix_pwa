const video = document.getElementById('video');
const canvas = document.getElementById('canvas');
const ctx = canvas.getContext('2d');
let scanning = false;

// when a barcode is decoded we may receive an array of corner points
// keep the last set so we can draw a frame on the next animation frame
let lastCorners = null;
// hidden processing canvas so OpenCV doesn't overwrite the visible overlay
const procCanvas = document.createElement('canvas');
const pctx = procCanvas.getContext('2d', { willReadFrequently: true });
let cvReady = false;

function ensureCvReady() {
  if (cvReady) return;
  if (typeof cv === 'undefined') return;

  // Some OpenCV.js builds expose a `cv` object before the WASM runtime is
  // fully initialised. A lightweight "smoke test" is the most reliable
  // indicator: try to construct a small `cv.Mat` and delete it. If that
  // succeeds, the runtime is ready.
  try {
    const t = new cv.Mat();
    if (t && typeof t.delete === 'function') {
      t.delete();
      cvReady = true;
      console.info('OpenCV: runtime ready (smoke test)');
      return;
    }
  } catch (e) {
    // Not ready yet — fall through to attach hooks
  }

  // Attach robust onRuntimeInitialized hooks to `cv` and global `Module` (if
  // available). Preserve any existing handlers.
  const attachHook = (obj, name) => {
    try {
      const prev = obj[name];
      obj[name] = function() {
        try { if (typeof prev === 'function') prev(); } catch (e) {}
        try {
          const t2 = new cv.Mat();
          if (t2 && typeof t2.delete === 'function') t2.delete();
        } catch (_) {}
        cvReady = true;
        console.info('OpenCV: runtime initialised (' + name + ')');
      };
    } catch (e) {
      // ignore
    }
  };

  if (typeof cv !== 'undefined') attachHook(cv, 'onRuntimeInitialized');
  if (typeof Module !== 'undefined') attachHook(Module, 'onRuntimeInitialized');
}

// ZXing pure-JS decoder wrapper (DataMatrix)
function decodeWithZXing(imgData) {
  if (typeof window.ZXingLib === 'undefined') return null;
  try {
    const ZX = window.ZXingLib;
    const RGB = ZX.RGBLuminanceSource;
    const Hybrid = ZX.HybridBinarizer;
    const BinaryBitmap = ZX.BinaryBitmap;
    const DataMatrixReader = ZX.DataMatrixReader;
    if (!RGB || !Hybrid || !BinaryBitmap || !DataMatrixReader) return null;
    const src = new RGB(imgData.data, imgData.width, imgData.height);
    const bitmap = new BinaryBitmap(new Hybrid(src));
    const reader = new DataMatrixReader();
    const res = reader.decode(bitmap);
    if (!res) return null;
    const text = (typeof res.getText === 'function') ? res.getText() : (res.text || res.getResult ? res.getResult() : null);
    let pts = null;
    if (typeof res.getResultPoints === 'function') {
      const rp = res.getResultPoints();
      if (rp && rp.length) pts = Array.from(rp).map(p => ({ x: (p.getX ? p.getX() : p.x), y: (p.getY ? p.getY() : p.y) }));
    }
    return { text, points: pts, raw: res };
  } catch (e) {
    // decode throws when nothing found; ignore
    return null;
  }
}

// libdmtx (C library) wrapper — loader exposes window.LibDmtx.scanImageData(imgData)
// Server-side scan: POST frame to server endpoint /api/scan
async function decodeWithServer(imgData) {
  try {
    // convert ImageData to Blob (PNG) for upload
    const off = document.createElement('canvas');
    off.width = imgData.width;
    off.height = imgData.height;
    const octx = off.getContext('2d');
    octx.putImageData(imgData, 0, 0);
    const blob = await new Promise(resolve => off.toBlob(resolve, 'image/png'));
    const fd = new FormData();
    fd.append('image', blob, 'frame.png');

    const resp = await fetch('/api/scan', { method: 'POST', body: fd });
    if (!resp.ok) {
      const j = await resp.json().catch(() => ({}));
      console.warn('server scan failed', resp.status, j);
      return null;
    }
    const j = await resp.json();
    // Expect { ok: true, results: [ { text, points } ] }
    return j.results || null;
  } catch (e) {
    console.warn('decodeWithServer error', e);
    return null;
  }
}

// Backwards-compatible alias used in places where libdmtx was previously tried
function decodeWithLibDmtx(imgData) { return decodeWithServer(imgData); }

// ─── OpenCV helpers (added for robust DataMatrix detection) ────────────────

/**
 * Sort 4 arbitrary corner points into [TL, TR, BR, BL] order.
 * Uses coordinate sums / differences (robust for axis-aligned and rotated quads).
 */
function sortCorners(pts) {
  // TL = min(x+y), BR = max(x+y)
  const bySum = pts.slice().sort((a, b) => (a.x + a.y) - (b.x + b.y));
  const tl = bySum[0];
  const br = bySum[3];
  // among the two middle points: TR has greater x, BL has lesser x
  const mid = [bySum[1], bySum[2]].sort((a, b) => a.x - b.x);
  const bl = mid[0];
  const tr = mid[1];
  return [tl, tr, br, bl];
}

/** Lazy CLAHE instance — created once after cv runtime is initialised. */
let _clahe = null;
function getCLAHE() {
  if (_clahe) return _clahe;
  try {
    // clipLimit 2.0, tileSize 4×4 — better for small ECC 200 module grids
    _clahe = new cv.CLAHE(2.0, new cv.Size(4, 4));
  } catch (_) {
    try { _clahe = cv.createCLAHE(2.0, new cv.Size(4, 4)); } catch (_) { /* not available */ }
  }
  return _clahe;
}

/**
 * Full preprocessing pipeline optimised for ECC 200 DataMatrix codes.
 * Input : RGBA cv.Mat (from cv.imread / procCanvas).
 * Output: single-channel binary cv.Mat — caller MUST .delete() it.
 * Pipeline: grayscale → CLAHE(2.0,4×4) → UnsharpMask → AdaptiveThreshold(21) → Morph-Close(3×3)
 */
function opencvPreprocess(src) {
  const gray = new cv.Mat();
  cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);

  // CLAHE: boosts local contrast on small module grids
  const enhanced = new cv.Mat();
  const clahe = getCLAHE();
  if (clahe) {
    clahe.apply(gray, enhanced);
  } else {
    gray.copyTo(enhanced); // graceful degradation
  }
  gray.delete();

  // Unsharp mask: sharpen ECC 200 module edges before thresholding
  // result = 1.5 * src - 0.5 * blur(src, sigma=3)
  const blurTemp = new cv.Mat();
  cv.GaussianBlur(enhanced, blurTemp, new cv.Size(0, 0), 3);
  const sharpened = new cv.Mat();
  cv.addWeighted(enhanced, 1.5, blurTemp, -0.5, 0, sharpened);
  blurTemp.delete();
  enhanced.delete();

  // Adaptive threshold: robust to non-uniform illumination across the frame.
  // blockSize=21 covers module sizes of 3–15 px (typical camera distances).
  const binary = new cv.Mat();
  cv.adaptiveThreshold(sharpened, binary, 255,
    cv.ADAPTIVE_THRESH_GAUSSIAN_C, cv.THRESH_BINARY, 21, 4);
  sharpened.delete();

  // Morphological closing: fill tiny holes/gaps in ECC 200 modules
  const kernel = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(3, 3));
  const closed = new cv.Mat();
  cv.morphologyEx(binary, closed, cv.MORPH_CLOSE, kernel);
  kernel.delete();
  binary.delete();

  return closed; // single-channel binary
}

/**
 * Warp a detected quadrilateral to a 400×400 RGBA square.
 * corners = [TL, TR, BR, BL] from sortCorners().
 * Returns warped RGBA cv.Mat — caller MUST .delete() it.
 */
function warpToSquare(srcMat, corners, size = 400) {
  const [tl, tr, br, bl] = corners;
  const srcPts = cv.matFromArray(4, 1, cv.CV_32FC2, [
    tl.x, tl.y,
    tr.x, tr.y,
    br.x, br.y,
    bl.x, bl.y,
  ]);
  const dstPts = cv.matFromArray(4, 1, cv.CV_32FC2, [
    0,    0,
    size, 0,
    size, size,
    0,    size,
  ]);
  const M = cv.getPerspectiveTransform(srcPts, dstPts);
  const warped = new cv.Mat();
  cv.warpPerspective(srcMat, warped, M, new cv.Size(size, size));
  srcPts.delete(); dstPts.delete(); M.delete();
  return warped; // RGBA, size × size
}

/**
 * Convert an RGBA cv.Mat to an ImageData object.
 *
 * NOTE: We must copy the pixel bytes into a fresh Uint8ClampedArray whose
 * .buffer owns exactly width×height×4 bytes.  Passing a shared-buffer view
 * (new Uint8ClampedArray(wasm.memory.buffer, offset, len)) causes ImageData
 * to validate against the full 128 MB WebAssembly heap and throw
 * "data length does not match width and height".
 */
function matToImageData(rgbaMat) {
  // new Uint8ClampedArray(typedArray) copies elements into a new, self-owned buffer
  const pixels = new Uint8ClampedArray(rgbaMat.data);
  return new ImageData(pixels, rgbaMat.cols, rgbaMat.rows);
}

/**
 * Draw a closed polygon border on the overlay canvas.
 * @param {Array<{x,y}>} corners
 * @param {string} color  CSS colour string
 */
function drawDetectionBorder(corners, color = '#FF5722') {
  if (!corners || corners.length < 2) return;
  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth = Math.max(3, Math.round(canvas.width * 0.004));
  ctx.lineJoin = 'round';
  ctx.beginPath();
  ctx.moveTo(corners[0].x, corners[0].y);
  for (let i = 1; i < corners.length; i++) ctx.lineTo(corners[i].x, corners[i].y);
  ctx.closePath();
  ctx.stroke();
  ctx.restore();
}

/**
 * Throttle flag: prevents queuing multiple concurrent ZBar async calls
 * when OpenCV processing finishes faster than ZBar resolves.
 */
let _frameScanning = false;

// ─── End OpenCV helpers ──────────────────────────────────────────────────────

function decodeSymbolText(sym) {
  try {
    if (!sym) return null;
    if (typeof sym.decode === 'function') {
      return sym.decode();
    }
    if (sym.data) {
      if (sym.data instanceof Uint8Array) return new TextDecoder().decode(sym.data);
      return String(sym.data);
    }
    if (sym.rawData) {
      if (sym.rawData instanceof Uint8Array) return new TextDecoder().decode(sym.rawData);
      return String(sym.rawData);
    }
    if (sym.dataString) return String(sym.dataString);
    if (sym.raw) return String(sym.raw);
  } catch (e) {
    console.warn('Could not decode symbol text', e);
  }
  return null;
}

function extractCorners(sym) {
  if (!sym) return null;
  // common property names
  if (Array.isArray(sym.points) && sym.points.length) return sym.points.map(p => ({ x: p.x, y: p.y }));
  if (Array.isArray(sym.location) && sym.location.length) return sym.location.map(p => ({ x: p.x ?? p[0], y: p.y ?? p[1] }));
  if (Array.isArray(sym.corners) && sym.corners.length) return sym.corners.map(p => ({ x: p.x, y: p.y }));
  return null;
}
// file/media handling
const fileInput = document.getElementById('file-input');
const stopButton = document.getElementById('stop-button');
let currentFileURL = null;

function stopPlayback() {
  // revoke file URL if one was used and pause video playback
  if (currentFileURL) {
    try { URL.revokeObjectURL(currentFileURL); } catch (e) {}
    currentFileURL = null;
  }
  if (!video.paused) {
    video.pause();
  }
  // if video was playing a file, clear src
  if (video.src && !video.srcObject) {
    video.removeAttribute('src');
  }
  scanning = false;
}

async function processImageOnce(img) {
  // draw image to processing canvas at natural size
  procCanvas.width = img.naturalWidth || img.width;
  procCanvas.height = img.naturalHeight || img.height;
  pctx.clearRect(0,0,procCanvas.width,procCanvas.height);
  pctx.drawImage(img, 0, 0, procCanvas.width, procCanvas.height);

  // prepare overlay canvas
  canvas.width = procCanvas.width;
  canvas.height = procCanvas.height;
  // draw the loaded image to the visible canvas so the user sees it
  ctx.clearRect(0,0,canvas.width,canvas.height);
  ctx.drawImage(procCanvas, 0, 0);

  const imgData = pctx.getImageData(0, 0, procCanvas.width, procCanvas.height);

  // try zbar first
  if (typeof ZBar !== 'undefined' && typeof ZBar.scanImageData === 'function') {
    try {
      const result = await ZBar.scanImageData(imgData);
      const output = document.getElementById('result');
      if (result?.length) {
        const sym = result[0];
        const text = decodeSymbolText(sym) || sym.typeName || 'Gefunden';
        output.textContent = 'Gefunden: ' + text;
        const pts = extractCorners(sym);
        if (pts && pts.length) lastCorners = pts;
      } else {
        output.textContent = 'Keine Codes gefunden';
      }
    } catch (e) {
      console.error('ZBar Fehler', e);
    }
  }

  // try ZXing (pure JS DataMatrix) as a fallback if ZBar didn't return corners
  if (!lastCorners) {
    // try libdmtx (if available) first, then ZXing
    const ld = decodeWithLibDmtx(imgData);
    if (ld && ld.then) {
      try {
        const res = await ld;
        if (res?.length) {
          const sym = res[0];
          const output = document.getElementById('result');
          output.textContent = 'Gefunden: ' + (decodeSymbolText(sym) || sym.typeName || 'DataMatrix');
          const pts = extractCorners(sym);
          if (pts && pts.length) lastCorners = pts;
        }
      } catch (e) { /* ignore */ }
    } else if (ld && ld.length) {
      const sym = ld[0];
      const output = document.getElementById('result');
      output.textContent = 'Gefunden: ' + (decodeSymbolText(sym) || sym.typeName || 'DataMatrix');
      const pts = extractCorners(sym);
      if (pts && pts.length) lastCorners = pts;
    } else {
      const zx = decodeWithZXing(imgData);
      if (zx) {
        const output = document.getElementById('result');
        output.textContent = 'Gefunden: ' + (zx.text || 'DataMatrix');
        if (zx.points && zx.points.length) lastCorners = zx.points;
      }
    }
  }

  // fallback OpenCV contour detection — uses full ECC 200 preprocessing pipeline
  if (cvReady && !lastCorners) {
    const src = cv.imread(procCanvas);
    const binary = opencvPreprocess(src);
    const contours = new cv.MatVector();
    const hierarchy = new cv.Mat();
    cv.findContours(binary, contours, hierarchy, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);
    let bestArea = 0;
    for (let i = 0; i < contours.size(); i++) {
      const cnt = contours.get(i);
      const area = cv.contourArea(cnt);
      if (area < 200) { cnt.delete(); continue; }
      const approx = new cv.Mat();
      cv.approxPolyDP(cnt, approx, 0.04 * cv.arcLength(cnt, true), true);
      if (approx.rows === 4 && area > bestArea && cv.isContourConvex(approx)) {
        const rect = cv.boundingRect(approx);
        const ratio = rect.width / Math.max(rect.height, 1);
        if (ratio >= 0.35 && ratio <= 3.0) {
          bestArea = area;
          const d = approx.data32S;
          lastCorners = [
            { x: d[0], y: d[1] }, { x: d[2], y: d[3] },
            { x: d[4], y: d[5] }, { x: d[6], y: d[7] },
          ];
        }
      }
      approx.delete();
      cnt.delete();
    }
    if (lastCorners) lastCorners = sortCorners(lastCorners);
    hierarchy.delete();
    contours.delete();
    binary.delete();
    src.delete();
  }

  // draw border if corners available
  if (lastCorners) {
    ctx.strokeStyle = '#FF5722';
    ctx.lineWidth = Math.max(3, Math.round(canvas.width * 0.004));
    ctx.beginPath();
    ctx.moveTo(lastCorners[0].x, lastCorners[0].y);
    for (let i = 1; i < lastCorners.length; i++) ctx.lineTo(lastCorners[i].x, lastCorners[i].y);
    ctx.closePath();
    ctx.stroke();
  }
}


// selection support (user-drag to select region)
let isSelecting = false;
let selection = null; // {x,y,w,h}
let selectStart = null;
let imageMode = false; // true when a static image is loaded and displayed on canvas


// enable or disable pointer events on the overlay canvas
function setCanvasInteractive(active) {
  if (active) {
    canvas.style.pointerEvents = 'auto';
  } else {
    canvas.style.pointerEvents = 'none';
  }
}

// convert pointer event to canvas coordinates
function getCanvasPoint(e) {
  const rect = canvas.getBoundingClientRect();
  const scaleX = canvas.width / rect.width;
  const scaleY = canvas.height / rect.height;
  return {
    x: Math.round((e.clientX - rect.left) * scaleX),
    y: Math.round((e.clientY - rect.top) * scaleY)
  };
}

canvas.addEventListener('pointerdown', (e) => {
  if (canvas.style.pointerEvents !== 'auto') return;
  isSelecting = true;
  selectStart = getCanvasPoint(e);
  selection = { x: selectStart.x, y: selectStart.y, w: 0, h: 0 };
});

canvas.addEventListener('pointermove', (e) => {
  if (!isSelecting) return;
  const p = getCanvasPoint(e);
  // update selection rectangle while dragging
  selection.w = Math.abs(p.x - selectStart.x);
  selection.h = Math.abs(p.y - selectStart.y);
});

canvas.addEventListener('pointerup', async (e) => {
  if (!isSelecting) return;
  isSelecting = false;
  // require a minimum size
  if (!selection || selection.w < 8 || selection.h < 8) {
    selection = null;
    return;
  }
  // get image data from processing canvas for the selected area
  const imgData = pctx.getImageData(selection.x, selection.y, selection.w, selection.h);
  await processSelection(imgData, selection.x, selection.y);
});

function renderImageOverlay() {
  if (!imageMode) return;
  // redraw image
  ctx.clearRect(0,0,canvas.width,canvas.height);
  ctx.drawImage(procCanvas, 0, 0);

  // draw selection if present
  if (selection) {
    ctx.save();
    ctx.fillStyle = 'rgba(0, 150, 136, 0.15)';
    ctx.strokeStyle = '#009688';
    ctx.lineWidth = 2;
    ctx.fillRect(selection.x, selection.y, selection.w, selection.h);
    ctx.strokeRect(selection.x, selection.y, selection.w, selection.h);
    ctx.restore();
  }

  // draw detection corners
  if (lastCorners) {
    ctx.strokeStyle = '#FF5722';
    ctx.lineWidth = Math.max(3, Math.round(canvas.width * 0.004));
    ctx.beginPath();
    ctx.moveTo(lastCorners[0].x, lastCorners[0].y);
    for (let i = 1; i < lastCorners.length; i++) ctx.lineTo(lastCorners[i].x, lastCorners[i].y);
    ctx.closePath();
    ctx.stroke();
  }

  requestAnimationFrame(renderImageOverlay);
}

async function processSelection(imgData, offsetX = 0, offsetY = 0) {
  // try zbar first
  if (typeof ZBar !== 'undefined' && typeof ZBar.scanImageData === 'function') {
    try {
      const result = await ZBar.scanImageData(imgData);
      const output = document.getElementById('result');
      if (result?.length) {
        output.textContent = 'Gefunden: ' + result[0].data;
        if (result[0].location && result[0].location.length >= 4) {
          // map returned points into canvas coordinates
          lastCorners = result[0].location.map(pt => ({ x: pt.x + offsetX, y: pt.y + offsetY }));
        }
        return;
      } else {
        output.textContent = 'Keine Codes im Auswahlbereich gefunden';
      }
    } catch (e) {
      console.error('ZBar Fehler', e);
    }
  }

  // try ZXing DataMatrix decoder on the selection as a fallback
  if (!lastCorners) {
    // try libdmtx first, then ZXing
    const ld = decodeWithLibDmtx(imgData);
    if (ld && ld.then) {
      try {
        const res = await ld;
        if (res?.length) {
          const output = document.getElementById('result');
          output.textContent = 'Gefunden: ' + (decodeSymbolText(res[0]) || res[0].typeName || 'DataMatrix');
          const pts = extractCorners(res[0]);
          if (pts && pts.length) lastCorners = pts.map(p => ({ x: p.x + offsetX, y: p.y + offsetY }));
          return;
        }
      } catch (e) { /* ignore */ }
    } else if (ld && ld.length) {
      const output = document.getElementById('result');
      output.textContent = 'Gefunden: ' + (decodeSymbolText(ld[0]) || ld[0].typeName || 'DataMatrix');
      const pts = extractCorners(ld[0]);
      if (pts && pts.length) lastCorners = pts.map(p => ({ x: p.x + offsetX, y: p.y + offsetY }));
      return;
    }

    const zx = decodeWithZXing(imgData);
    if (zx) {
      const output = document.getElementById('result');
      output.textContent = 'Gefunden: ' + (zx.text || 'DataMatrix');
      if (zx.points && zx.points.length) lastCorners = zx.points.map(p => ({ x: p.x + offsetX, y: p.y + offsetY }));
      return;
    }
  }

  // fallback OpenCV detection on the selection — uses full ECC 200 pipeline
  if (cvReady) {
    const tmp = document.createElement('canvas');
    tmp.width = imgData.width;
    tmp.height = imgData.height;
    const tctx = tmp.getContext('2d');
    tctx.putImageData(imgData, 0, 0);
    const src = cv.imread(tmp);
    const binary = opencvPreprocess(src);
    const contours = new cv.MatVector();
    const hierarchy = new cv.Mat();
    cv.findContours(binary, contours, hierarchy, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);
    let bestArea = 0;
    for (let i = 0; i < contours.size(); i++) {
      const cnt = contours.get(i);
      const area = cv.contourArea(cnt);
      if (area < 200) { cnt.delete(); continue; }
      const approx = new cv.Mat();
      cv.approxPolyDP(cnt, approx, 0.04 * cv.arcLength(cnt, true), true);
      if (approx.rows === 4 && area > bestArea && cv.isContourConvex(approx)) {
        const rect = cv.boundingRect(approx);
        const ratio = rect.width / Math.max(rect.height, 1);
        if (ratio >= 0.35 && ratio <= 3.0) {
          bestArea = area;
          const d = approx.data32S;
          lastCorners = sortCorners([
            { x: d[0] + offsetX, y: d[1] + offsetY },
            { x: d[2] + offsetX, y: d[3] + offsetY },
            { x: d[4] + offsetX, y: d[5] + offsetY },
            { x: d[6] + offsetX, y: d[7] + offsetY },
          ]);
        }
      }
      approx.delete();
      cnt.delete();
    }
    hierarchy.delete();
    contours.delete();
    binary.delete();
    src.delete();
  }
}
function handleFile(file) {
  if (!file) return;
  lastCorners = null;
  // stop live camera if running
  stopCamera();
  stopPlayback();

  if (file.type.startsWith('image/')) {
    const img = new Image();
    currentFileURL = URL.createObjectURL(file);
    img.onload = async () => {
      // hide the live video and show the canvas with the loaded image
      video.style.display = 'none';
      canvas.style.display = 'block';
      setCanvasInteractive(true);
      imageMode = true;
      await processImageOnce(img);
      requestAnimationFrame(renderImageOverlay);
      URL.revokeObjectURL(currentFileURL);
      currentFileURL = null;
    };
    img.src = currentFileURL;
  } else if (file.type.startsWith('video/')) {
    currentFileURL = URL.createObjectURL(file);
    video.src = currentFileURL;
    video.onloadedmetadata = async () => {
      // show live video playback and disable selection by default
      video.style.display = '';
      canvas.style.display = 'block';
      setCanvasInteractive(false);
      imageMode = false;
      video.play();
      scanning = true;
      // requestFrame loop will handle processing frames
      requestAnimationFrame(processFrame);
    };
  }
}

fileInput?.addEventListener('change', (e) => {
  const f = e.target.files && e.target.files[0];
  if (f) handleFile(f);
});

stopButton?.addEventListener('click', () => {
  stopCamera();
  stopPlayback();
  document.getElementById('result').textContent = 'Gestoppt';
});

async function startCamera() {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: 'environment' } }
    });
    video.srcObject = stream;
    await video.play();
    scanning = true;
    ensureCvReady();
    requestAnimationFrame(processFrame);
  } catch (err) {
    console.error('Kamera kann nicht gestartet werden', err);
    document.getElementById('result').textContent = 'Kamerafehler';
  }
}

function stopCamera() {
  const tracks = video.srcObject?.getTracks() || [];
  tracks.forEach(t => t.stop());
  scanning = false;
}

/**
 * processFrame — refactored for robust small-DataMatrix detection.
 *
 * Architecture:
 *   • Synchronous: capture frame → OpenCV preprocess → contour quad detection
 *     → perspective warp to 400×400.
 *   • Async (fire-and-forget, guarded by _frameScanning flag):
 *       1) ZBar on warped patch
 *       2) ZBar on preprocessed full frame
 *       3) ZXing fallback on raw frame
 *   • Overlay drawn from lastCorners which persists until next successful scan
 *     (or cleared when a complete scan cycle finds nothing).
 */
function processFrame() {
  if (!scanning || video.readyState !== 4) {
    return requestAnimationFrame(processFrame);
  }
  ensureCvReady();

  // ── 1. Capture frame into procCanvas ────────────────────────────────────
  procCanvas.width  = video.videoWidth;
  procCanvas.height = video.videoHeight;
  canvas.width  = procCanvas.width;
  canvas.height = procCanvas.height;
  pctx.drawImage(video, 0, 0, procCanvas.width, procCanvas.height);

  // ── 2. Paint overlay (selection + last known border) ────────────────────
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  if (selection) {
    ctx.save();
    ctx.fillStyle   = 'rgba(0, 150, 136, 0.15)';
    ctx.strokeStyle = '#009688';
    ctx.lineWidth   = 2;
    ctx.fillRect(selection.x, selection.y, selection.w, selection.h);
    ctx.strokeRect(selection.x, selection.y, selection.w, selection.h);
    ctx.restore();
  }
  // Draw persistent border from last completed scan cycle
  if (lastCorners) drawDetectionBorder(lastCorners, '#FF5722');

  // ── 3. Skip new scan if previous async decode still running ─────────────
  if (_frameScanning) {
    return requestAnimationFrame(processFrame);
  }

  // ── 4. Synchronous OpenCV preprocessing ─────────────────────────────────
  if (!cvReady) {
    // CV not ready yet — ZXing-only lightweight pass
    const raw = pctx.getImageData(0, 0, procCanvas.width, procCanvas.height);
    const zx  = decodeWithZXing(raw);
    if (zx) {
      document.getElementById('result').textContent = 'Gefunden: ' + (zx.text || 'DataMatrix');
      lastCorners = zx.points?.length ? zx.points : lastCorners;
    }
    return requestAnimationFrame(processFrame);
  }

  // Read RGBA frame into OpenCV Mat
  const src    = cv.imread(procCanvas);
  // Full ECC 200 pipeline: CLAHE(2.0,4×4) → UnsharpMask → AdaptiveThresh(21) → Morph-Close
  const binary = opencvPreprocess(src);

  // ── 5. Contour detection on binary image ────────────────────────────────
  const contours  = new cv.MatVector();
  const hierarchy = new cv.Mat();
  // Use RETR_EXTERNAL to focus on outer boundaries of the DataMatrix
  cv.findContours(binary, contours, hierarchy, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);

  let warpedCorners = null; // sorted [TL, TR, BR, BL] if a quad is found
  let warpedMat     = null; // perspective-corrected patch (RGBA)

  // Find the largest 4-point approximation (most likely the DataMatrix border)
  let bestArea = 0;
  for (let i = 0; i < contours.size(); i++) {
    const cnt  = contours.get(i);
    const area = cv.contourArea(cnt);
    if (area < 200) { cnt.delete(); continue; } // skip tiny blobs

    const approx = new cv.Mat();
    // epsilon ~4% of arc length gives stable quads for ECC200
    cv.approxPolyDP(cnt, approx, 0.04 * cv.arcLength(cnt, true), true);

    if (approx.rows === 4 && area > bestArea) {
      // ECC 200: outer boundary must be convex
      if (!cv.isContourConvex(approx)) { approx.delete(); cnt.delete(); continue; }
      // ECC 200 aspect ratio: square variants ≈1.0; rectangular 1:2 / 1:3 allowed
      const rect = cv.boundingRect(approx);
      const ratio = rect.width / Math.max(rect.height, 1);
      if (ratio < 0.35 || ratio > 3.0) { approx.delete(); cnt.delete(); continue; }
      bestArea = area;
      const d = approx.data32S; // CV_32SC2 → Int32Array, stride = 2
      const raw = [
        { x: d[0], y: d[1] },
        { x: d[2], y: d[3] },
        { x: d[4], y: d[5] },
        { x: d[6], y: d[7] },
      ];
      warpedCorners = sortCorners(raw); // TL, TR, BR, BL
    }
    approx.delete();
    cnt.delete();
  }
  contours.delete();
  hierarchy.delete();

  // ── 6. Perspective warp of detected quad ────────────────────────────────
  if (warpedCorners) {
    warpedMat = warpToSquare(src, warpedCorners, 400);
    // Show detected quad immediately (cyan) while async decode is in flight
    drawDetectionBorder(warpedCorners, '#00BCD4');
  }

  // Snapshot full binary frame as ImageData for ZBar fallback
  // Convert single-channel binary → RGBA so ZBar can consume it
  const binaryRGBA = new cv.Mat();
  cv.cvtColor(binary, binaryRGBA, cv.COLOR_GRAY2RGBA);
  const fullImgData = matToImageData(binaryRGBA);
  binaryRGBA.delete();
  binary.delete();

  // Raw RGBA ImageData for ZXing (keeps original colour information)
  const rawImgData = pctx.getImageData(0, 0, procCanvas.width, procCanvas.height);

  // Pre-compute warped ImageData (sync, before we delete warpedMat)
  const warpedImgData = warpedMat ? matToImageData(warpedMat) : null;
  // warpedMat can be deleted now — ImageData holds its own buffer copy
  if (warpedMat) { warpedMat.delete(); warpedMat = null; }
  src.delete();

  // ── 7. Async decode pipeline (fire-and-forget) ───────────────────────────
  _frameScanning = true;
  (async () => {
    const output  = document.getElementById('result');
    let decoded   = false;
    let foundText = '';
    let foundPts  = null;

    // ── 7a. ZBar on perspective-warped patch (best quality for small codes)
    if (!decoded && warpedImgData &&
        typeof ZBar !== 'undefined' && typeof ZBar.scanImageData === 'function') {
      try {
        const res = await ZBar.scanImageData(warpedImgData);
        if (res?.length) {
          foundText = decodeSymbolText(res[0]) || res[0].typeName || 'Gefunden';
          // corners come from OCV, not from ZBar (warped coord space)
          foundPts  = warpedCorners;
          decoded   = true;
        }
      } catch (e) { console.warn('ZBar(warped):', e); }
    }

    // try libdmtx on warped patch (if available)
    if (!decoded && warpedImgData && typeof window.LibDmtx !== 'undefined') {
      try {
        const res = await decodeWithLibDmtx(warpedImgData);
        if (res?.length) {
          foundText = decodeSymbolText(res[0]) || res[0].typeName || 'Gefunden';
          foundPts  = warpedCorners;
          decoded   = true;
        }
      } catch (e) { console.warn('libdmtx(warped):', e); }
    }

    // ── 7b. ZBar on full preprocessed (binary→RGBA) frame
    if (!decoded &&
        typeof ZBar !== 'undefined' && typeof ZBar.scanImageData === 'function') {
      try {
        const res = await ZBar.scanImageData(fullImgData);
        if (res?.length) {
          const sym = res[0];
          foundText = decodeSymbolText(sym) || sym.typeName || 'Gefunden';
          const pts = extractCorners(sym);
          foundPts  = pts?.length ? pts : warpedCorners;
          decoded   = true;
        }
      } catch (e) { console.warn('ZBar(full):', e); }
    }

    // try libdmtx on full preprocessed frame
    if (!decoded && typeof window.LibDmtx !== 'undefined') {
      try {
        const res = await decodeWithLibDmtx(fullImgData);
        if (res?.length) {
          const sym = res[0];
          foundText = decodeSymbolText(sym) || sym.typeName || 'Gefunden';
          const pts = extractCorners(sym);
          foundPts  = pts?.length ? pts : warpedCorners;
          decoded   = true;
        }
      } catch (e) { console.warn('libdmtx(full):', e); }
    }

    // ── 7c. ZXing pure-JS DataMatrix fallback on raw frame
    if (!decoded) {
      const zx = decodeWithZXing(rawImgData);
      if (zx) {
        foundText = zx.text || 'DataMatrix';
        foundPts  = zx.points?.length ? zx.points : warpedCorners;
        decoded   = true;
      }
    }

    // ── 7d. Update UI & state
    if (decoded) {
      output.textContent = 'Gefunden: ' + foundText;
      lastCorners = foundPts;                      // persist for next frame overlay
    } else {
      output.textContent = 'Scan läuft...';
      lastCorners = null;                          // clear stale border
    }
  })().finally(() => { _frameScanning = false; });

  requestAnimationFrame(processFrame);
}

document.getElementById('help-toggle').addEventListener('click', () => {
  document.getElementById('help').classList.toggle('hidden');
});

// automatisch starten
startCamera();

// if ZBar failed to load (browser tracking prevention), notify the user
setTimeout(() => {
  if (typeof ZBar === 'undefined') {
    const out = document.getElementById('result');
    if (out) out.textContent = out.textContent + ' (Hinweis: Decoder nicht geladen — Tracking/Blocker?)';
    console.warn('ZBar (zbar-wasm) is not available. The CDN script may have been blocked by tracking prevention.');
  }
}, 1200);
