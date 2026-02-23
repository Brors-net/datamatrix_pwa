const express = require('express');
const path = require('path');
const multer = require('multer');
const sharp = require('sharp');
const fs = require('fs/promises');
const os = require('os');
const { execFile } = require('child_process');
const { promisify } = require('util');
const execFileAsync = promisify(execFile);
const crypto = require('crypto');

const app = express();
const port = process.env.PORT || 8080;

// ── Multer: keep uploaded images in memory; limit to 20 MB ───────────────────
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });

// ── Optional native libdmtx binding ─────────────────────────────────────────
let nodeLibDmtx = null;
try {
  nodeLibDmtx = require('node-libdmtx');
} catch (e1) {
  try { nodeLibDmtx = require('libdmtx'); } catch (e2) { nodeLibDmtx = null; }
}

// ── ZXing WASM initialisation ───────────────────────────────────────────────────
// zxing-wasm ships a CJS build; require once and reuse.
// prepareZXingModule warms up the WASM binary at startup (non-blocking).
const { readBarcodes, prepareZXingModule } = require('zxing-wasm/reader');
prepareZXingModule(); // fire-and-forget warm-up; decode calls await internally

// ── Preprocessing pipeline tuned for small industrial ECC 200 codes ──────────
/**
 * Accepts raw image buffer (any format Sharp understands).
 * Returns a PNG buffer ready for ZXing WASM or libdmtx.
 *
 * Steps:
 *  1. Convert to grayscale          — removes chromatic noise irrelevant to 2-D codes
 *  2. Upscale 2× if width < 1200px  — adds sub-pixel detail for tiny module grids
 *  3. Normalize contrast            — equalises histogram; helps dark/light backgrounds
 *  4. Mild Gaussian blur (σ=0.4)    — smooths JPEG/camera artefacts around module edges
 */
async function preprocessImage(inputBuffer) {
  const meta = await sharp(inputBuffer).metadata();

  let pipeline = sharp(inputBuffer)
    // Step 1: grayscale
    .grayscale();

  // Step 2: upscale if needed (Lanczos preserves edge sharpness better than nearest-neighbour)
  if (meta.width && meta.width < 1200) {
    pipeline = pipeline.resize(meta.width * 2, null, {
      kernel: sharp.kernel.lanczos3,
      withoutEnlargement: false,
    });
  }

  // Step 3: stretch contrast to full 0-255 range
  pipeline = pipeline.normalize();

  // Step 4: gentle blur to reduce digitisation noise (does not destroy module edges at σ=0.4)
  pipeline = pipeline.blur(0.4);

  // Output PNG — lossless, avoids JPEG re-compression artefacts for downstream decoders
  return pipeline.png().toBuffer();
}

// ── /api/scan ────────────────────────────────────────────────────────────────
/**
 * POST /api/scan
 * Body: multipart/form-data with field "image" (any image format).
 * Response: { ok: boolean, results: Array<{ text, format, points? }> }
 *
 * Decode order:
 *   1. ZXing WASM (preprocessed PNG) — best tolerance for ECC 200
 *   2. libdmtx native binding        — if installed; raw RGBA fallback
 */
app.post('/api/scan', upload.single('image'), async (req, res) => {
  if (!req.file) return res.status(400).json({ ok: false, error: 'no image uploaded' });

  try {
    const debugEnabled = req.query.debug === '1' || req.headers['x-debug'] === '1';
    const debug = [];
    const tick = () => Date.now();
    const start = tick();
    // Preprocess once; reuse buffer for both decoders
    const t0 = tick();
    const preprocessed = await preprocessImage(req.file.buffer);
    debug.push({ step: 'preprocess', ms: tick() - t0, size: preprocessed.length });

    // ── 1. ZXing WASM on preprocessed PNG ─────────────────────────────────────────
    try {
      // Wrap PNG buffer in a Blob — Blob is available natively in Node ≥18
      const blob = new Blob([preprocessed], { type: 'image/png' });
      const t1 = tick();

      const zxResults = await readBarcodes(blob, {
        formats: ['DataMatrix'],
        tryHarder: true,    // optimize for accuracy over speed
        tryRotate: true,    // handle rotated codes (common in industrial settings)
        tryInvert: true,    // handle inverted (white-on-black) codes
        tryDenoise: true,   // morphological closing filter for 2-D codes (experimental)
      });

      const zxTime = tick() - t1;
      debug.push({ step: 'zxing', ms: zxTime, count: zxResults.length });

      const valid = zxResults.filter(r => r.isValid);
      if (valid.length > 0) {
        const results = valid.map(r => ({
          text: r.text,
          format: 'DataMatrix',
          points: r.position
            ? [
                { x: r.position.topLeft.x,     y: r.position.topLeft.y },
                { x: r.position.topRight.x,    y: r.position.topRight.y },
                { x: r.position.bottomRight.x, y: r.position.bottomRight.y },
                { x: r.position.bottomLeft.x,  y: r.position.bottomLeft.y },
              ]
            : undefined,
        }));
        return res.json(debugEnabled ? { ok: true, results, debug } : { ok: true, results });
      }
    } catch (zxErr) {
      console.warn('[scan] ZXing WASM error:', zxErr.message ?? zxErr);
      if (debugEnabled) debug.push({ step: 'zxing-error', error: String(zxErr) });
    }

    // ── 2. zbar CLI fallback (optional) ───────────────────────────────────────
    // If zbarimg is installed on the host, try it as an additional open-source decoder.
    // This spawns a short-lived child process and uses a temp file for input.
    try {
      const zbarPath = 'zbarimg'; // assume available in PATH
      const tmpName = crypto.randomUUID() + '.png';
      const tmpPath = path.join(os.tmpdir(), tmpName);
      const t2 = tick();
      await fs.writeFile(tmpPath, preprocessed);
      try {
        const { stdout } = await execFileAsync(zbarPath, ['--raw', tmpPath], { timeout: 4000 });
        const zbarTime = tick() - t2;
        debug.push({ step: 'zbar', ms: zbarTime, output: stdout ? stdout.length : 0 });
        const text = stdout?.toString().trim();
        if (text) {
          const results = [{ text, format: 'DataMatrix' }];
          await fs.unlink(tmpPath).catch(() => {});
          return res.json(debugEnabled ? { ok: true, results, debug } : { ok: true, results });
        }
      } catch (zpErr) {
        // zbar not available or failed; log and continue to libdmtx
        debug.push({ step: 'zbar-error', error: String(zpErr) });
      } finally {
        await fs.unlink(tmpPath).catch(() => {});
      }
    } catch (zbErr) {
      if (debugEnabled) debug.push({ step: 'zbar-fallback-error', error: String(zbErr) });
    }

    if (nodeLibDmtx && typeof nodeLibDmtx.decode === 'function') {
      try {
        // Convert preprocessed PNG to raw RGBA for native bindings
        const t3 = tick();
        const { data, info } = await sharp(preprocessed)
          .ensureAlpha()
          .raw()
          .toBuffer({ resolveWithObject: true });
        debug.push({ step: 'dmtx-prepare', ms: tick() - t3, width: info.width, height: info.height });

        let dmtxResults = null;
        try {
          dmtxResults = nodeLibDmtx.decode(data, info.width, info.height);
        } catch (_) {
          dmtxResults = nodeLibDmtx.decode(info.width, info.height, data);
        }

        if (dmtxResults && dmtxResults.length > 0) {
          const results = dmtxResults.map(r => ({ text: r.text ?? String(r), format: 'DataMatrix', points: r.points }));
          return res.json(debugEnabled ? { ok: true, results, debug } : { ok: true, results });
        }
      } catch (dmtxErr) {
        console.warn('[scan] libdmtx error:', dmtxErr.message ?? dmtxErr);
        if (debugEnabled) debug.push({ step: 'dmtx-error', error: String(dmtxErr) });
      }
    }

    // ── Nothing decoded ───────────────────────────────────────────────────────
    return res.json(debugEnabled ? { ok: true, results: [], debug } : { ok: true, results: [] });
  } catch (err) {
    console.error('[scan] Unexpected error:', err);
    return res.status(500).json({ ok: false, error: err.message });
  }
});

// Serve all static files from repo root
app.use(express.static(path.join(__dirname)));

// SPA fallback to index.html
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.listen(port, () => {
  console.log(`Server listening on port ${port}`);
});
