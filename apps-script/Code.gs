/**
 * Suivi Hydrique Pro — serveur de synchronisation sécurisé (Google Apps Script)
 * =============================================================================
 *
 * INSTALLATION (une seule fois)
 * 1. Ouvrez votre projet Apps Script actuel, remplacez TOUT le code par celui-ci, enregistrez.
 *    - Si le script n'est pas ouvert depuis la feuille (menu Extensions > Apps Script),
 *      collez l'identifiant de la feuille dans SPREADSHEET_ID ci-dessous.
 * 2. Dans la liste des fonctions en haut, choisissez « genererCodeSecret » puis « Exécuter ».
 *    Autorisez l'accès si Google le demande. Le code secret s'affiche dans le journal d'exécution
 *    (format XXXX-XXXX-XXXX-XXXX-XXXX). Notez-le : il sera demandé une fois par appareil.
 * 3. Déployer > Gérer les déploiements > ✏️ (modifier) > Version : « Nouvelle version » > Déployer.
 *    Gardez « Exécuter en tant que : Moi » et « Accès : Tout le monde ».
 *    (En modifiant le déploiement existant, l'adresse /exec reste la même.)
 *
 * SÉCURITÉ
 * - Toute requête sans le bon code secret est refusée : l'adresse du script seule ne donne accès à rien.
 * - Le code est stocké dans les propriétés du script (jamais dans le code ni sur GitHub).
 * - Après 20 codes faux en 15 minutes, la synchro est bloquée 15 minutes.
 * - Pour changer de code : relancez genererCodeSecret(), puis saisissez le nouveau code sur chaque appareil.
 *
 * DONNÉES
 * - Onglet « Sync » : une ligne par saisie (lisible : date, heure, type, libellé, volume, nombre, poids).
 * - Les saisies remplacées ou supprimées restent marquées « oui » dans la colonne « supprime »
 *   (c'est ce qui permet de propager les suppressions à tous les appareils).
 */

const SPREADSHEET_ID = '';        // Laisser vide si le script est lié à la feuille
const SHEET_NAME = 'Sync';
const HEADERS = ['id', 'date', 'heure', 'type', 'libelle', 'volume_ml', 'nombre', 'poids_kg',
                 'supprime', 'modifie_le', 'srv', 'json'];
const COL = { ID: 0, UPDATED: 9, SRV: 10, JSON: 11 };
const MAX_FAILS = 20;
const FAIL_WINDOW_S = 900;
const MAX_RECORDS_PER_REQUEST = 5000;

// ---------------------------------------------------------------------------
// Code secret
// ---------------------------------------------------------------------------

/** À exécuter une fois depuis l'éditeur : crée (ou remplace) le code secret. */
function genererCodeSecret() {
  const alphabet = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // sans I, L, O, 0, 1 (évite les confusions)
  const chars = [];
  while (chars.length < 20) {
    const hex = Utilities.getUuid().replace(/-/g, '');
    for (let i = 0; i < hex.length && chars.length < 20; i += 2) {
      if (i === 12 || i === 16) continue;          // octets non aléatoires d'un UUID v4
      const b = parseInt(hex.substr(i, 2), 16);
      if (b < 248) chars.push(alphabet[b % 31]);   // 248 = 31 × 8 : pas de biais
    }
  }
  const code = chars.join('').match(/.{4}/g).join('-');
  PropertiesService.getScriptProperties().setProperty('SYNC_TOKEN', code);
  CacheService.getScriptCache().remove('fails');
  Logger.log('Votre code secret : ' + code);
  return code;
}

function normalizeToken_(t) {
  return String(t || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

function safeEqual_(a, b) {
  if (!a || !b || a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

// ---------------------------------------------------------------------------
// Points d'entrée web
// ---------------------------------------------------------------------------

function doGet() {
  // Plus aucune donnée n'est servie en GET (l'ancienne URL ?action=get ne renvoie plus rien).
  return json_({ ok: false, error: 'use_post' });
}

function doPost(e) {
  try {
    let body;
    try {
      body = JSON.parse(e.postData.contents);
    } catch (err) {
      return json_({ ok: false, error: 'bad_request' });
    }

    const cache = CacheService.getScriptCache();
    const fails = Number(cache.get('fails') || 0);
    if (fails >= MAX_FAILS) return json_({ ok: false, error: 'locked' });

    const expected = PropertiesService.getScriptProperties().getProperty('SYNC_TOKEN');
    if (!expected) return json_({ ok: false, error: 'not_configured' });

    if (!safeEqual_(normalizeToken_(body && body.token), normalizeToken_(expected))) {
      cache.put('fails', String(fails + 1), FAIL_WINDOW_S);
      return json_({ ok: false, error: 'unauthorized' });
    }

    if (body.action === 'ping') return json_({ ok: true, serverTime: Date.now() });
    if (body.action === 'sync') return json_(sync_(body));
    return json_({ ok: false, error: 'unknown_action' });
  } catch (err) {
    console.error(err);
    return json_({ ok: false, error: 'server' });
  }
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

// ---------------------------------------------------------------------------
// Synchronisation
// ---------------------------------------------------------------------------

/**
 * Reçoit les saisies modifiées d'un appareil, garde pour chaque id la version la plus récente
 * (updatedAt), puis renvoie tout ce qui a changé sur le serveur depuis la dernière synchro de cet appareil.
 */
function sync_(body) {
  const incoming = Array.isArray(body.records) ? body.records : [];
  if (incoming.length > MAX_RECORDS_PER_REQUEST) return { ok: false, error: 'too_many' };
  const since = Number(body.since) || 0;

  const lock = LockService.getScriptLock();
  lock.waitLock(25000);
  try {
    const sh = getSheet_();
    const lastRow = sh.getLastRow();
    const data = lastRow > 1 ? sh.getRange(2, 1, lastRow - 1, HEADERS.length).getValues() : [];
    const index = {};
    data.forEach((row, i) => { index[String(row[COL.ID])] = i; });

    const now = Date.now();
    let dirty = false;

    incoming.forEach(raw => {
      const rec = clean_(raw);
      if (!rec) return;
      const key = String(rec.id);
      const i = index[key];
      if (i !== undefined) {
        if (rec.updatedAt <= (Number(data[i][COL.UPDATED]) || 0)) return; // version serveur plus récente ou identique
        data[i] = toRow_(rec, now);
      } else {
        data.push(toRow_(rec, now));
        index[key] = data.length - 1;
      }
      dirty = true;
    });

    if (dirty) {
      sh.getRange(2, 1, data.length, 1).setNumberFormat('@'); // ids en texte (grands nombres exacts)
      sh.getRange(2, 1, data.length, HEADERS.length).setValues(data);
    }

    const out = [];
    data.forEach(row => {
      if ((Number(row[COL.SRV]) || 0) > since - 5000) {
        try { out.push(JSON.parse(row[COL.JSON])); } catch (err) { /* ligne illisible ignorée */ }
      }
    });

    return { ok: true, serverTime: now, records: out };
  } finally {
    lock.releaseLock();
  }
}

/** Ne garde que les champs connus, avec des types et tailles contrôlés. */
function clean_(r) {
  if (!r || typeof r !== 'object') return null;
  const id = Number(r.id);
  if (!isFinite(id) || id <= 0 || id > Number.MAX_SAFE_INTEGER) return null;
  const type = String(r.type || '');
  if (!/^[a-z_]{1,30}$/.test(type)) return null;
  const isoDate = String(r.isoDate || '');
  if (!/^\d{4}-\d{2}-\d{2}/.test(isoDate)) return null;

  const rec = {
    id: id,
    type: type,
    volume: Number(r.volume) || 0,
    label: String(r.label || '').slice(0, 200),
    isoDate: isoDate.slice(0, 30),
    dateStr: String(r.dateStr || '').slice(0, 20),
    timeStr: String(r.timeStr || '').slice(0, 10),
    updatedAt: Number(r.updatedAt) || id
  };
  if (r.count !== undefined && r.count !== null && r.count !== '' && isFinite(Number(r.count))) rec.count = Number(r.count);
  if (r.weight !== undefined && r.weight !== null && r.weight !== '' && isFinite(Number(r.weight))) rec.weight = Number(r.weight);
  if (r.deleted) rec.deleted = true;
  return rec;
}

function toRow_(rec, srv) {
  return [
    String(rec.id),
    rec.isoDate.slice(0, 10),
    rec.timeStr,
    rec.type,
    rec.label,
    rec.volume || '',
    rec.count !== undefined ? rec.count : '',
    rec.weight !== undefined ? rec.weight : '',
    rec.deleted ? 'oui' : '',
    rec.updatedAt,
    srv,
    JSON.stringify(rec)
  ];
}

function getSheet_() {
  const ss = SPREADSHEET_ID ? SpreadsheetApp.openById(SPREADSHEET_ID) : SpreadsheetApp.getActiveSpreadsheet();
  if (!ss) throw new Error('Feuille introuvable : renseignez SPREADSHEET_ID en haut du script.');
  let sh = ss.getSheetByName(SHEET_NAME);
  if (!sh) {
    sh = ss.insertSheet(SHEET_NAME);
    sh.getRange(1, 1, 1, HEADERS.length).setValues([HEADERS]).setFontWeight('bold');
    sh.setFrozenRows(1);
  }
  return sh;
}
