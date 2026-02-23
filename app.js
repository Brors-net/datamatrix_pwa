const video = document.getElementById("video");
const canvas = document.getElementById("canvas");
const ctx = canvas.getContext("2d");

async function startCamera() {
    const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: "environment" } }
    });
    video.srcObject = stream;
}

function processFrame() {
    if (!cv || video.readyState !== 4) return;

    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    ctx.drawImage(video, 0, 0);

    let src = cv.imread(canvas);
    let gray = new cv.Mat();
    let thresh = new cv.Mat();

    cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);
    cv.threshold(gray, thresh, 0, 255, cv.THRESH_BINARY + cv.THRESH_OTSU);
    cv.imshow(canvas, thresh);

    let imgData = ctx.getImageData(0,0,canvas.width,canvas.height);

    ZBar.scanImageData(imgData).then(result => {
        if (result?.length) {
            document.getElementById("result").textContent =
                "Gefunden: " + result[0].data;
        }
    });

    src.delete();
    gray.delete();
    thresh.delete();
}

setInterval(processFrame, 200);
startCamera();
