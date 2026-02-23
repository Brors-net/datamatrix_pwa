const video = document.getElementById('video');
const canvas = document.getElementById('canvas');
const ctx = canvas.getContext('2d');
let scanning = false;

async function startCamera() {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: 'environment' } }
    });
    video.srcObject = stream;
    await video.play();
    scanning = true;
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
  if (!scanning || !cv || video.readyState !== 4) {
    return requestAnimationFrame(processFrame);
  }

  canvas.width = video.videoWidth;
  canvas.height = video.videoHeight;
  ctx.drawImage(video, 0, 0);

  const src = cv.imread(canvas);
  const gray = new cv.Mat();
  const thresh = new cv.Mat();

  cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);
  cv.threshold(gray, thresh, 0, 255, cv.THRESH_BINARY + cv.THRESH_OTSU);
  cv.imshow(canvas, thresh);

  const imgData = ctx.getImageData(0, 0, canvas.width, canvas.height);

  ZBar.scanImageData(imgData)
    .then(result => {
      const output = document.getElementById('result');
      if (result?.length) {
        output.textContent = 'Gefunden: ' + result[0].data;
      } else {
        output.textContent = 'Scan läuft...';
      }
    })
    .catch(err => console.error('Scan-Fehler', err));

  src.delete();
  gray.delete();
  thresh.delete();

  requestAnimationFrame(processFrame);
}

document.getElementById('help-toggle').addEventListener('click', () => {
  document.getElementById('help').classList.toggle('hidden');
});

// automatisch starten
startCamera();
