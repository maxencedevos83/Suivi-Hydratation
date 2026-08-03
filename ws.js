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

// Gestion des actions déclenchées depuis l'application (ex: Bouton de synchronisation)
self.addEventListener('message', (e) => {
  if (e.data && e.data.type === 'FORCE_SYNC') {
    e.waitUntil(
      caches.open(CACHE_NAME).then((cache) => {
        // Rafraîchissement forcé des assets principaux depuis le réseau
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
          // Informe tous les onglets/clients que la synchronisation est terminée
          return self.clients.matchAll();
        }).then((clients) => {
          clients.forEach((client) => {
            client.postMessage({ type: 'SYNC_COMPLETE' });
          });
        });
      })
    );
  }
});

// 1. Lorsque l'utilisateur clique sur le bouton de synchronisation
document.getElementById('btn-sync').addEventListener('click', () => {
  if ('serviceWorker' in navigator && navigator.serviceWorker.controller) {
    console.log('Déclenchement de la synchronisation...');
    // Envoi du message au Service Worker
    navigator.serviceWorker.controller.postMessage({ type: 'FORCE_SYNC' });
    
    // Feedback visuel optionnel (ex: afficher un état de chargement)
    const btn = document.getElementById('btn-sync');
    btn.textContent = 'Synchronisation...';
    btn.disabled = true;
  }
});

// 2. Écouter la réponse du Service Worker lorsque la synchronisation est finie
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.addEventListener('message', (event) => {
    if (event.data && event.data.type === 'SYNC_COMPLETE') {
      console.log('Synchronisation terminée avec succès !');
      
      // Restaurer le bouton et notifier l'utilisateur
      const btn = document.getElementById('btn-sync');
      if (btn) {
        btn.textContent = 'Synchronisé ✓';
        btn.disabled = false;
        setTimeout(() => { btn.textContent = 'Synchroniser'; }, 3000);
      }
    }
  });
}

// Interception des requêtes réseau
self.addEventListener('fetch', (e) => {
  // On ne touche pas aux requêtes vers Google Sheets (laisser passer en direct)
  if (e.request.url.includes('script.google.com')) {
    return;
  }

  e.respondWith(
    caches.match(e.request).then((cachedResponse) => {
      // Récupération de la version la plus récente sur le réseau en arrière-plan
      const fetchPromise = fetch(e.request).then((networkResponse) => {
        caches.open(CACHE_NAME).then((cache) => {
          cache.put(e.request, networkResponse.clone());
        });
        return networkResponse;
      }).catch(() => {
        // En cas de panne de réseau, on bascule sur le cache s'il existe
        return cachedResponse;
      });

      // Retourne le cache immédiatement si disponible, sinon attend le réseau
      return cachedResponse || fetchPromise;
    })
  );
});
