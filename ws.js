const CACHE_NAME = 'hydra-pwa-v2';
const ASSETS = [
  './suivi.html',
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
  // On ne touche pas aux requêtes vers Google Sheets (laisser passer en direct)
  if (e.request.url.includes('script.google.com')) {
    return;
  }

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
