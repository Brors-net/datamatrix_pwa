const video = document.getElementById('video');
const canvas = document.getElementById('canvas');
const ctx = canvas.getContext('2d');
let scanning = false;

// when a barcode is decoded we may receive an array of corner points
// keep the last set so we can draw a frame on the next animation frame
let lastCorners = null;
// hidden processing canvas so OpenCV doesn't overwrite the visible overlay
const procCanvas = document.createElement('canvas');
const pctx = procCanvas.getContext('2d');
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
  ctx.clearRect(0,0,canvas.width,canvas.height);

  const imgData = pctx.getImageData(0, 0, procCanvas.width, procCanvas.height);

  // try zbar first
  if (typeof ZBar !== 'undefined' && typeof ZBar.scanImageData === 'function') {
    try {
      const result = await ZBar.scanImageData(imgData);
      const output = document.getElementById('result');
      if (result?.length) {
        output.textContent = 'Gefunden: ' + result[0].data;
        if (result[0].location && result[0].location.length >= 4) {
          lastCorners = result[0].location;
        }
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
      await processImageOnce(img);
      URL.revokeObjectURL(currentFileURL);
      currentFileURL = null;
    };
    img.src = currentFileURL;
  } else if (file.type.startsWith('video/')) {
    currentFileURL = URL.createObjectURL(file);
    video.src = currentFileURL;
    video.onloadedmetadata = async () => {
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

  // get image data from the processing canvas for zbar and/or OpenCV
  const imgData = pctx.getImageData(0, 0, procCanvas.width, procCanvas.height);

  // scan with ZBar if available
  if (typeof ZBar !== 'undefined' && typeof ZBar.scanImageData === 'function') {
    ZBar.scanImageData(imgData)
      .then(result => {
        const output = document.getElementById('result');
        if (result?.length) {
          output.textContent = 'Gefunden: ' + result[0].data;
          if (result[0].location && result[0].location.length >= 4) {
            lastCorners = result[0].location;
          } else {
            // keep previous corners — OpenCV fallback may update below
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
