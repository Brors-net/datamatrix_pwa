const express = require('express');
const path = require('path');

const app = express();
const port = process.env.PORT || 8080;

// Serve all static files from repo root
app.use(express.static(path.join(__dirname)));

// SPA fallback to index.html
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.listen(port, () => {
  console.log(`Server listening on port ${port}`);
});
