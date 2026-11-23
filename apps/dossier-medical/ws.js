// Service worker de l'appli « Dossier médical » (agenda + dossier médical chiffré)
const CACHE_PREFIX = 'dossier-medical-';
const CACHE_NAME = CACHE_PREFIX + 'v1';
const ASSETS = [
  './index.html',
  './manifest.json',
  './logo-512x512.png'
];

// Installation : mise en cache des fichiers de base
self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(ASSETS)));
  self.skipWaiting();
});

// Activation : suppression des anciens caches de CETTE appli seulement
// (Suivi Hydrique Pro est publié sur le même site et garde ses propres caches)
self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(
      keys.filter((key) => key.startsWith(CACHE_PREFIX) && key !== CACHE_NAME).map((key) => caches.delete(key))
    ))
  );
  self.clients.claim();
});

// Interception des requêtes réseau
self.addEventListener('fetch', (e) => {
  // Jamais de cache pour les échanges avec Google, les bibliothèques externes ni les requêtes autres que GET
  if (e.request.method !== 'GET' ||
      e.request.url.includes('script.google.com') ||
      e.request.url.includes('script.googleusercontent.com') ||
      e.request.url.includes('accounts.google.com')) {
    return;
  }

  // Pages de l'appli : RÉSEAU D'ABORD, pour afficher tout de suite la dernière version publiée.
  // La copie en cache ne sert que hors ligne.
  const url = new URL(e.request.url);
  const isAppPage = e.request.mode === 'navigate' || url.pathname.endsWith('.html') ||
                    url.pathname.endsWith('/') || url.pathname.endsWith('manifest.json');
  if (isAppPage) {
    e.respondWith(
      fetch(e.request, { cache: 'no-store' }).then((networkResponse) => {
        if (networkResponse.ok) {
          const copy = networkResponse.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(e.request, copy));
        }
        return networkResponse;
      }).catch(() => caches.match(e.request).then((r) => r || caches.match('./index.html')))
    );
    return;
  }

  // Autres fichiers (images, visionneuse PDF) : cache d'abord, mise à jour en arrière-plan
  e.respondWith(
    caches.match(e.request).then((cachedResponse) => {
      const fetchPromise = fetch(e.request).then((networkResponse) => {
        caches.open(CACHE_NAME).then((cache) => {
          cache.put(e.request, networkResponse.clone());
        });
        return networkResponse;
      }).catch(() => cachedResponse);

      return cachedResponse || fetchPromise;
    })
  );
});
