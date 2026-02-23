self.addEventListener("install", e => {
  e.waitUntil(
    caches.open("scanner-cache").then(cache => {
      return cache.addAll([
        "/",
        "/index.html",
        "/app.js",
        "/manifest.json",
        "/logo.png"
      ]);
    })
  );
});

self.addEventListener("fetch", event => {
  event.respondWith(
    caches.match(event.request).then(response => {
      return response || fetch(event.request);
    })
  );
});
