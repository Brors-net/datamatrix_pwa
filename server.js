const express = require('express');
const path = require('path');
const multer = require('multer');
const sharp = require('sharp');

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
    // Preprocess once; reuse buffer for both decoders
    const preprocessed = await preprocessImage(req.file.buffer);

    // ── 1. ZXing WASM on preprocessed PNG ─────────────────────────────────────────
    try {
      // Wrap PNG buffer in a Blob — Blob is available natively in Node ≥18
      const blob = new Blob([preprocessed], { type: 'image/png' });

      const zxResults = await readBarcodes(blob, {
        formats: ['DataMatrix'],
        tryHarder: true,    // optimize for accuracy over speed
        tryRotate: true,    // handle rotated codes (common in industrial settings)
        tryInvert: true,    // handle inverted (white-on-black) codes
        tryDenoise: true,   // morphological closing filter for 2-D codes (experimental)
      });

      const valid = zxResults.filter(r => r.isValid);
      if (valid.length > 0) {
        return res.json({
          ok: true,
          results: valid.map(r => ({
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
          })),
        });
      }
    } catch (zxErr) {
      console.warn('[scan] ZXing WASM error:', zxErr.message ?? zxErr);
    }

    // ── 2. libdmtx native binding (optional) ─────────────────────────────────
    if (nodeLibDmtx && typeof nodeLibDmtx.decode === 'function') {
      try {
        // Convert preprocessed PNG to raw RGBA for native bindings
        const { data, info } = await sharp(preprocessed)
          .ensureAlpha()
          .raw()
          .toBuffer({ resolveWithObject: true });

        let dmtxResults = null;
        try {
          dmtxResults = nodeLibDmtx.decode(data, info.width, info.height);
        } catch (_) {
          dmtxResults = nodeLibDmtx.decode(info.width, info.height, data);
        }

        if (dmtxResults && dmtxResults.length > 0) {
          return res.json({
            ok: true,
            results: dmtxResults.map(r => ({
              text: r.text ?? String(r),
              format: 'DataMatrix',
              points: r.points,
            })),
          });
        }
      } catch (dmtxErr) {
        console.warn('[scan] libdmtx error:', dmtxErr.message ?? dmtxErr);
      }
    }

    // ── Nothing decoded ───────────────────────────────────────────────────────
    return res.json({ ok: true, results: [] });
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
