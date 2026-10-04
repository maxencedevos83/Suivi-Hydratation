const CACHE_NAME = 'hydra-pwa-v10';
const ASSETS = [
  './index.html',
  './manifest.json',
  'https://cdn.jsdelivr.net/npm/chart.js'
];

// Installation du Service Worker et mise en cache des fichiers de base
self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(ASSETS);
    })
  );
  self.skipWaiting();
});

// Activation : suppression des anciens caches obsolètes
self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(
        keys.map((key) => {
          if (key !== CACHE_NAME) {
            console.log('Suppression de l’ancien cache :', key);
            return caches.delete(key);
          }
        })
      );
    })
  );
  self.clients.claim();
});

// Gestion des actions déclenchées depuis l'application (Envoi / Réception)
self.addEventListener('message', (e) => {
  if (e.data && (e.data.type === 'FORCE_SEND' || e.data.type === 'FORCE_RECEIVE')) {
    e.waitUntil(
      caches.open(CACHE_NAME).then((cache) => {
        return Promise.all(
          ASSETS.map((asset) => 
            fetch(asset, { cache: 'no-store' }).then((response) => {
              if (response.ok) {
                return cache.put(asset, response);
              }
            }).catch((err) => {
              console.warn('Échec de la mise à jour en arrière-plan pour :', asset, err);
            })
          )
        ).then(() => {
          return self.clients.matchAll();
        }).then((clients) => {
          clients.forEach((client) => {
            client.postMessage({ type: 'SYNC_COMPLETE', action: e.data.type });
          });
        });
      })
    );
  }
});

// Interception des requêtes réseau
self.addEventListener('fetch', (e) => {
  // Synchro : jamais de cache pour les échanges avec Google ni pour les requêtes autres que GET
  if (e.request.method !== 'GET' ||
      e.request.url.includes('script.google.com') ||
      e.request.url.includes('script.googleusercontent.com') ||
      e.request.url.includes('accounts.google.com') ||
      e.request.url.includes('openfoodfacts.org')) {
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

  // Autres fichiers (graphiques, images) : cache d'abord, mise à jour en arrière-plan
  e.respondWith(
    caches.match(e.request).then((cachedResponse) => {
      const fetchPromise = fetch(e.request).then((networkResponse) => {
        caches.open(CACHE_NAME).then((cache) => {
          cache.put(e.request, networkResponse.clone());
        });
        return networkResponse;
      }).catch(() => {
        return cachedResponse;
      });

      return cachedResponse || fetchPromise;
    })
  );
});
