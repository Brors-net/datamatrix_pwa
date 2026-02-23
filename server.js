const express = require('express');
const path = require('path');
const multer = require('multer');
const sharp = require('sharp');

const app = express();
const port = process.env.PORT || 8080;

// API: /api/scan - accept an image file and attempt DataMatrix (ECC200) decoding
const upload = multer({ storage: multer.memoryStorage() });

// Try to load an optional native libdmtx binding for Node (if installed)
let nodeLibDmtx = null;
try {
  // try common package names; keep optional
  nodeLibDmtx = require('node-libdmtx');
} catch (e1) {
  try { nodeLibDmtx = require('libdmtx'); } catch (e2) { nodeLibDmtx = null; }
}

app.post('/api/scan', upload.single('image'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'no image uploaded' });
  try {
    // Normalize image to RGBA raw buffer for decoder bindings that expect raw pixels
    const img = sharp(req.file.buffer).ensureAlpha().raw();
    const { data, info } = await img.toBuffer({ resolveWithObject: true });

    // If a native libdmtx binding is available, use it
    if (nodeLibDmtx && typeof nodeLibDmtx.decode === 'function') {
      try {
        // Many bindings expose decode(width, height, buffer) or decode(buffer, w, h)
        let results = null;
        try { results = nodeLibDmtx.decode(data, info.width, info.height); } catch (_) {
          results = nodeLibDmtx.decode(info.width, info.height, data);
        }
        // Expect results as array of { text, points }
        return res.json({ ok: true, results });
      } catch (e) {
        console.warn('node libdmtx decode error', e);
      }
    }

    // No native binding present — return 501 with helpful message
    return res.status(501).json({
      ok: false,
      error: 'No server-side libdmtx binding available. Install a Node libdmtx package or use client-side decoders.',
      info: { width: info.width, height: info.height }
    });
  } catch (err) {
    console.error('scan error', err);
    res.status(500).json({ error: err.message });
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
