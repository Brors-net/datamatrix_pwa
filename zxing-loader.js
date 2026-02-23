(async () => {
  // prefer local minified ESM build, then local unminified, then CDN
  const localMin = './vendor/zxing-library/esm/index.min.js';
  const localJs = './vendor/zxing-library/esm/index.js';
  const cdn = 'https://cdn.jsdelivr.net/npm/@zxing/library@0.21.3/esm/index.js';
  const tryImport = async (path) => {
    try {
      const mod = await import(path);
      // some builds export default
      window.ZXingLib = mod.default || mod;
      console.log('ZXing loaded from', path);
      return true;
    } catch (e) {
      return false;
    }
  };

  if (await tryImport(localMin)) return;
  if (await tryImport(localJs)) return;
  if (await tryImport(cdn)) return;
  console.warn('ZXing could not be loaded from local vendor or CDN');
})();
