const CACHE_NAME = 'hydra-pwa-v14';
const ASSETS = [
  './index.html',
  './manifest.json',
  'https://cdn.jsdelivr.net/npm/chart.js'
];

// Installation du Service Worker et mise en cache des fichiers de base
self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      // La table des aliments est gardée pour le hors-ligne, sans bloquer la mise à jour si elle manque
      return cache.addAll(ASSETS).then(() => cache.add('./aliments.json').catch(() => {}));
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

// ================== NOTIFICATIONS DE RAPPEL (compléments) ==================
// Le script Google envoie un signal « push » sans contenu au moment du rappel.
// Le téléphone réveille ce service worker, qui affiche la notification à partir du plan
// enregistré par l'appli (IndexedDB « hydra-sw »), même quand l'appli est fermée.

const SW_MOMENTS = [
  { key: 'matin', name: 'Matin', label: 'du matin' },
  { key: 'midi', name: 'Midi', label: 'du midi' },
  { key: 'soir', name: 'Soir', label: 'du soir' }
];

function swDb() {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open('hydra-sw', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('kv');
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}
async function swGet(key) {
  try {
    const db = await swDb();
    return await new Promise(resolve => {
      const req = db.transaction('kv', 'readonly').objectStore('kv').get(key);
      req.onsuccess = () => { resolve(req.result || null); db.close(); };
      req.onerror = () => { resolve(null); db.close(); };
    });
  } catch (e) {
    return null;
  }
}
async function swSet(key, value) {
  const db = await swDb();
  await new Promise(resolve => {
    const tx = db.transaction('kv', 'readwrite');
    tx.objectStore('kv').put(value, key);
    tx.oncomplete = tx.onerror = () => { resolve(); db.close(); };
  });
}

function swIsoDate(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function swMinutes(hhmm) {
  const m = /^(\d{1,2}):(\d{2})/.exec(String(hhmm || ''));
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

// Le rappel concerne le dernier moment dont l'heure est passée et qui a des compléments
function swDueMoment(state, now) {
  if (!state || !state.plan || !Array.isArray(state.plan.meds)) return null;
  const nowMin = now.getHours() * 60 + now.getMinutes();
  const today = swIsoDate(now);
  const taken = (state.taken && state.taken.iso === today) ? state.taken.details || [] : [];
  const due = [];
  SW_MOMENTS.forEach(m => {
    const t = swMinutes(state.plan.times && state.plan.times[m.key]);
    const meds = state.plan.meds.filter(med => (med.moments || []).includes(m.key));
    if (t === null || t > nowMin || !meds.length) return;
    const missing = meds.filter(med => !taken.includes(`${med.id}|${m.key}`));
    due.push({ moment: m, time: state.plan.times[m.key], minutes: t, missingCount: missing.length, missing: missing.length ? missing : meds });
  });
  if (!due.length) return null;
  const withMissing = due.filter(c => c.missingCount > 0);
  return (withMissing.length ? withMissing : due).sort((a, b) => b.minutes - a.minutes)[0];
}

async function showReminder() {
  const state = await swGet('reminder');
  const now = new Date();
  // Notification de test demandée depuis l'appli il y a moins de 2 minutes
  const test = await swGet('reminder-test');
  if (test && Date.now() - test < 120000) {
    await swSet('reminder-test', 0);
    return self.registration.showNotification('🔔 Notification de test', {
      body: 'Les rappels de compléments fonctionnent sur ce téléphone.',
      icon: './logo-512x512.png',
      badge: './logo-512x512.png',
      tag: 'med-test',
      vibrate: [200, 100, 200]
    });
  }
  const due = swDueMoment(state, now);
  const base = {
    icon: './logo-512x512.png',
    badge: './logo-512x512.png',
    vibrate: [200, 100, 200],
    requireInteraction: true,
    renotify: true
  };
  if (!due) {
    return self.registration.showNotification('💊 Rappel de compléments', Object.assign(base, {
      body: 'Pense à prendre tes compléments, puis coche-les dans l\'appli.',
      tag: 'med-rappel',
      data: { iso: swIsoDate(now) }
    }));
  }
  if (!due.missingCount) {
    // Tout est déjà coché sur ce téléphone (prise pas encore synchronisée ?) : rappel discret
    return self.registration.showNotification(`💊 Compléments ${due.moment.label}`, {
      body: 'Tout est coché sur ce téléphone. Ouvre l\'appli pour finir la synchronisation.',
      icon: base.icon,
      badge: base.badge,
      tag: `med-${swIsoDate(now)}-${due.moment.key}`,
      silent: true
    });
  }
  const list = due.missing.map(med => med.name + (med.dose ? ` (${med.dose})` : '')).join(', ');
  return self.registration.showNotification(`💊 Compléments ${due.moment.label} · ${due.time}`, Object.assign(base, {
    body: list,
    tag: `med-${swIsoDate(now)}-${due.moment.key}`,
    data: { iso: swIsoDate(now), moment: due.moment.key },
    actions: [
      { action: 'taken', title: '✅ C\'est pris' },
      { action: 'open', title: 'Ouvrir l\'appli' }
    ]
  }));
}

// « C'est pris » depuis la notification : enregistre les prises sans ouvrir l'appli
async function markTakenFromNotification(data) {
  const state = await swGet('reminder');
  if (!state || !state.session || !state.url || !state.plan || !data || !data.moment) throw new Error('state');
  const moment = SW_MOMENTS.find(m => m.key === data.moment);
  const meds = (state.plan.meds || []).filter(med => (med.moments || []).includes(moment.key));
  const already = (state.taken && state.taken.iso === data.iso) ? state.taken.details || [] : [];
  const now = new Date();
  const timeStr = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
  const [y, m, d] = data.iso.split('-');
  const records = meds.filter(med => !already.includes(`${med.id}|${moment.key}`)).map((med, i) => ({
    id: Date.now() * 1000 + i * 37 + Math.floor(Math.random() * 30),
    type: 'med_prise',
    volume: 0,
    label: `${med.name}${med.dose ? ' (' + med.dose + ')' : ''} — ${moment.name.toLowerCase()}`,
    detail: `${med.id}|${moment.key}`,
    isoDate: data.iso,
    dateStr: `${d}/${m}/${y}`,
    timeStr: timeStr,
    updatedAt: Date.now()
  }));
  if (records.length) {
    const res = await fetch(state.url, {
      method: 'POST',
      cache: 'no-store',
      body: JSON.stringify({ action: 'sync', session: state.session, since: Date.now() + 3600000, records: records })
    });
    const out = await res.json();
    if (!out || !out.ok) throw new Error((out && out.error) || 'server');
    state.taken = { iso: data.iso, details: already.concat(records.map(r => r.detail)) };
    await swSet('reminder', state);
  }
  return self.registration.showNotification('✅ Prise enregistrée', {
    body: `Compléments ${moment.label} cochés à ${timeStr}.`,
    icon: './logo-512x512.png',
    badge: './logo-512x512.png',
    tag: `med-${data.iso}-${moment.key}`,
    silent: true
  });
}

async function openApp() {
  const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  for (const w of wins) {
    if (w.url.includes(self.registration.scope) && 'focus' in w) return w.focus();
  }
  return self.clients.openWindow('./index.html');
}

self.addEventListener('push', (e) => {
  e.waitUntil(showReminder());
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  if (e.action === 'taken') {
    e.waitUntil(markTakenFromNotification(e.notification.data).catch(() => openApp()));
  } else {
    e.waitUntil(openApp());
  }
});
