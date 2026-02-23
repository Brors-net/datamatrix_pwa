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
  if (typeof cv !== 'undefined' && typeof cv.imread === 'function') {
    cvReady = true;
    return;
  }
  if (typeof cv !== 'undefined' && typeof cv.onRuntimeInitialized === 'function') {
    cv.onRuntimeInitialized = () => { cvReady = true; };
  }
}

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

  // fallback OpenCV contour detection
  if (cvReady && !lastCorners) {
    const src = cv.imread(procCanvas);
    const gray = new cv.Mat();
    const thresh = new cv.Mat();
    cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);
    cv.threshold(gray, thresh, 0, 255, cv.THRESH_BINARY + cv.THRESH_OTSU);

    const contours = new cv.MatVector();
    const hierarchy = new cv.Mat();
    cv.findContours(thresh, contours, hierarchy, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);
    for (let i = 0; i < contours.size(); i++) {
      const cnt = contours.get(i);
      const approx = new cv.Mat();
      cv.approxPolyDP(cnt, approx, 0.02 * cv.arcLength(cnt, true), true);
      if (approx.rows === 4) {
        lastCorners = [];
        for (let j = 0; j < 4; j++) {
          const pt = approx.intPtr(j);
          lastCorners.push({ x: pt[0], y: pt[1] });
        }
        approx.delete();
        cnt.delete();
        break;
      }
      approx.delete();
      cnt.delete();
    }
    hierarchy.delete();
    contours.delete();
    src.delete();
    gray.delete();
    thresh.delete();
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
  selection.x = Math.min(selectStart.x, p.x);
  selection.y = Math.min(selectStart.y, p.y);
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

  // fallback OpenCV detection on the selection
  if (cvReady) {
    // draw selection to a temporary canvas to use cv.imread
    const tmp = document.createElement('canvas');
    tmp.width = imgData.width;
    tmp.height = imgData.height;
    const tctx = tmp.getContext('2d');
    tctx.putImageData(imgData, 0, 0);
    const src = cv.imread(tmp);
    const gray = new cv.Mat();
    const thresh = new cv.Mat();
    cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);
    cv.threshold(gray, thresh, 0, 255, cv.THRESH_BINARY + cv.THRESH_OTSU);

    const contours = new cv.MatVector();
    const hierarchy = new cv.Mat();
    cv.findContours(thresh, contours, hierarchy, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);
    for (let i = 0; i < contours.size(); i++) {
      const cnt = contours.get(i);
      const approx = new cv.Mat();
      cv.approxPolyDP(cnt, approx, 0.02 * cv.arcLength(cnt, true), true);
      if (approx.rows === 4) {
        lastCorners = [];
        for (let j = 0; j < 4; j++) {
          const pt = approx.intPtr(j);
          lastCorners.push({ x: pt[0] + offsetX, y: pt[1] + offsetY });
        }
        approx.delete();
        cnt.delete();
        break;
      }
      approx.delete();
      cnt.delete();
    }
    hierarchy.delete();
    contours.delete();
    src.delete();
    gray.delete();
    thresh.delete();
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

function processFrame() {
  if (!scanning || video.readyState !== 4) {
    return requestAnimationFrame(processFrame);
  }

  // make sure OpenCV runtime is ready (if it's loaded async)
  ensureCvReady();

  // set processing canvas size to video dimensions
  procCanvas.width = video.videoWidth;
  procCanvas.height = video.videoHeight;
  pctx.drawImage(video, 0, 0, procCanvas.width, procCanvas.height);

  // visible overlay canvas matches processing size (CSS scales separately)
  canvas.width = procCanvas.width;
  canvas.height = procCanvas.height;

  // clear previous overlay drawings (we don't draw the video here)
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  // if user is selecting, draw the selection rectangle
  if (selection) {
    ctx.save();
    ctx.fillStyle = 'rgba(0, 150, 136, 0.15)';
    ctx.strokeStyle = '#009688';
    ctx.lineWidth = 2;
    ctx.fillRect(selection.x, selection.y, selection.w, selection.h);
    ctx.strokeRect(selection.x, selection.y, selection.w, selection.h);
    ctx.restore();
  }

  // get image data from the processing canvas for zbar and/or OpenCV
  const imgData = pctx.getImageData(0, 0, procCanvas.width, procCanvas.height);

  // scan with ZBar if available
  if (typeof ZBar !== 'undefined' && typeof ZBar.scanImageData === 'function') {
    ZBar.scanImageData(imgData)
      .then(result => {
        const output = document.getElementById('result');
        if (result?.length) {
          const sym = result[0];
          const text = decodeSymbolText(sym) || sym.typeName || 'Gefunden';
          output.textContent = 'Gefunden: ' + text;
          const pts = extractCorners(sym);
          if (pts && pts.length) {
            lastCorners = pts;
          }
        } else {
          output.textContent = 'Scan läuft...';
        }
      })
      .catch(err => console.error('Scan-Fehler', err));
  }

  // if OpenCV is ready, run preprocessing and contour fallback
  if (cvReady) {
    const src = cv.imread(procCanvas);
    const gray = new cv.Mat();
    const thresh = new cv.Mat();

    cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);
    cv.threshold(gray, thresh, 0, 255, cv.THRESH_BINARY + cv.THRESH_OTSU);

    if (!lastCorners) {
      const contours = new cv.MatVector();
      const hierarchy = new cv.Mat();
      cv.findContours(thresh, contours, hierarchy, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);
      for (let i = 0; i < contours.size(); i++) {
        const cnt = contours.get(i);
        const approx = new cv.Mat();
        cv.approxPolyDP(cnt, approx, 0.02 * cv.arcLength(cnt, true), true);
        if (approx.rows === 4) {
          lastCorners = [];
          for (let j = 0; j < 4; j++) {
            const pt = approx.intPtr(j);
            lastCorners.push({ x: pt[0], y: pt[1] });
          }
          approx.delete();
          cnt.delete();
          break;
        }
        approx.delete();
        cnt.delete();
      }
      hierarchy.delete();
      contours.delete();
    }

    src.delete();
    gray.delete();
    thresh.delete();
  }

  // draw a border if we have corner data (either from ZBar or our own fallback)
  if (lastCorners) {
    ctx.strokeStyle = '#FF5722';
    ctx.lineWidth = 4;
    ctx.beginPath();
    ctx.moveTo(lastCorners[0].x, lastCorners[0].y);
    for (let i = 1; i < lastCorners.length; i++) {
      ctx.lineTo(lastCorners[i].x, lastCorners[i].y);
    }
    ctx.closePath();
    ctx.stroke();
  }

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
