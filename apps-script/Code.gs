/**
 * Suivi Hydrique Pro — serveur Google Apps Script (version 7 : agenda médical)
 * =============================================================================
 *
 * MISE À JOUR DEPUIS LA VERSION PRÉCÉDENTE
 * 1. Remplacez TOUT le code par celui-ci.
 * 2. Collez votre identifiant de connexion Google dans GOOGLE_CLIENT_ID (voir le guide).
 * 3. Enregistrez (Ctrl + S).
 * 4. Exécutez une fois « installerRappels » (liste des fonctions en haut > Exécuter).
 *    Google demande de nouvelles autorisations (e-mail, déclencheurs, accès externe) : acceptez.
 * 5. Exécutez « testerAlerte » : vous devez recevoir un e-mail de test sur votre téléphone.
 * 6. Déployer > Gérer les déploiements > ✏️ > Version : « Nouvelle version » > Déployer.
 *
 * SÉCURITÉ
 * - Accès aux données uniquement avec une session ouverte par VOTRE compte Google
 *   (le propriétaire de ce script), vérifiée ici auprès de Google.
 * - Une session dure SESSION_DAYS jours sur un appareil, puis il faut se reconnecter.
 * - Le code secret de la version précédente reste utilisable en secours.
 *   Pour le supprimer définitivement : exécutez « desactiverCodeSecret ».
 * - Appareil perdu ? Exécutez « deconnecterTousLesAppareils ».
 * - Après 20 tentatives refusées en 15 minutes, tout accès est bloqué 15 minutes.
 *
 * DOSSIER MÉDICAL CHIFFRÉ (version 5)
 * - Les documents sont chiffrés SUR LE TÉLÉPHONE (AES-256) avant d'être envoyés : ce script et
 *   Google Drive ne reçoivent que des fichiers illisibles (noms anonymes « doc-AAAAMMJJ-HHMMSS-xxxx.hsp »).
 *   Titres, catégories et remarques sont chiffrés eux aussi.
 * - La clé est protégée par la phrase secrète du patient : elle n'est jamais envoyée ici.
 *   Ce script ne garde que la clé « emballée » (illisible sans la phrase secrète).
 * - Chaque import est horodaté par le serveur.
 * - Après avoir collé ce code : exécutez une fois « autoriserDossierMedical » (accès Drive), puis redéployez.
 * - L'appli ne peut lire ou supprimer QUE les fichiers de ce dossier.
 *   Une suppression envoie le fichier dans la corbeille de Drive (récupérable 30 jours).
 *
 * AGENDA MÉDICAL (version 7)
 * - Les rendez-vous sont rangés dans un agenda Google séparé « 🩺 RDV médicaux » (créé automatiquement),
 *   visible dans Google Agenda / Gmail à côté de vos autres agendas.
 * - Un RDV ajouté dans l'appli apparaît dans Google Agenda ; un RDV ajouté dans cet agenda depuis Google
 *   apparaît dans l'appli. Vos autres agendas ne sont jamais lus.
 * - Après avoir collé ce code : exécutez une fois « installerAgenda » (accès à Google Agenda), puis redéployez.
 *
 * RAPPELS DE COMPLÉMENTS
 * - Toutes les 5 minutes, le script regarde le plan de compléments enregistré dans l'appli.
 *   À l'heure prévue, puis 30 et 90 minutes après, il envoie un rappel tant que la prise
 *   n'est pas cochée dans l'appli.
 * - Version 6 : le rappel est une NOTIFICATION sur le téléphone (avec un bouton « C'est pris »).
 *   L'e-mail n'est envoyé qu'en secours (aucun téléphone joignable) ou si vous le choisissez dans l'appli.
 * - Pour vérifier : activez les notifications dans l'appli (carte « Compléments »), puis exécutez
 *   « testerNotification » ici, ou utilisez le bouton de test de l'appli.
 */

const SPREADSHEET_ID = '';            // Laisser vide si le script est lié à la feuille
const SHEET_NAME = 'Sync';
const GOOGLE_CLIENT_ID = '473355473317-ag0su1sgdfj8jpn0d7j54914co1m1h8q.apps.googleusercontent.com';          // Ex : 1234567890-abcdef.apps.googleusercontent.com
const EXTRA_ALLOWED_EMAILS = [];      // Le propriétaire du script est toujours autorisé
const SESSION_DAYS = 30;
const APP_URL = 'https://maxencedevos83.github.io/Suivi-Hydratation/';
const TIMEZONE = 'Europe/Paris';
const REMINDER_OFFSETS_MIN = [0, 30, 90];   // rappels : à l'heure, +30 min, +90 min

const HEADERS = ['id', 'date', 'heure', 'type', 'libelle', 'volume_ml', 'nombre', 'poids_kg',
                 'supprime', 'modifie_le', 'srv', 'json'];
const COL = { ID: 0, UPDATED: 9, SRV: 10, JSON: 11 };
const MAX_FAILS = 20;
const FAIL_WINDOW_S = 900;
const MAX_RECORDS_PER_REQUEST = 5000;
const MOMENT_LABELS = { matin: 'du matin', midi: 'du midi', soir: 'du soir' };
const DOCS_FOLDER_NAME = 'Suivi Hydrique Pro — Dossier médical';
const MAX_DOC_BYTES = 20 * 1024 * 1024;   // 20 Mo par document
const DOC_CATEGORIES = { ordonnance: 'Ordonnance', analyses: 'Analyses', compte_rendu: 'Compte rendu',
                         imagerie: 'Imagerie', courrier: 'Courrier', autre: 'Autre' };

// ---------------------------------------------------------------------------
// Fonctions à lancer depuis l'éditeur
// ---------------------------------------------------------------------------

/** Installe la vérification automatique des prises (toutes les 5 minutes). */
function installerRappels() {
  ScriptApp.getProjectTriggers().forEach(t => {
    if (t.getHandlerFunction() === 'verifierPrises') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('verifierPrises').timeBased().everyMinutes(5).create();
  Logger.log('Rappels installés : vérification toutes les 5 minutes. E-mails envoyés à ' + ownerEmail_());
}

/** Envoie un e-mail de test pour vérifier que les notifications arrivent sur le téléphone. */
function testerAlerte() {
  sendAlert_('🧪 Test des rappels — Suivi Hydrique Pro',
    'Si tu vois ce message (et une notification sur ton téléphone), les rappels de compléments fonctionnent.\n\n' + APP_URL);
  Logger.log('E-mail de test envoyé à ' + ownerEmail_());
}

/** À exécuter une fois : autorise l'accès à Google Drive et crée le dossier médical. */
function autoriserDossierMedical() {
  const folder = docsFolder_();
  Logger.log('Dossier médical prêt : ' + folder.getUrl());
}

/** Déconnecte tous les appareils (ils devront se reconnecter avec Google). */
function deconnecterTousLesAppareils() {
  PropertiesService.getScriptProperties().setProperty('SESSIONS', '{}');
  Logger.log('Tous les appareils sont déconnectés.');
}

/** Supprime le code secret de secours : seule la connexion Google reste possible. */
function desactiverCodeSecret() {
  PropertiesService.getScriptProperties().deleteProperty('SYNC_TOKEN');
  Logger.log('Code secret supprimé.');
}

/** (Ré)génère un code secret de secours. */
function genererCodeSecret() {
  const alphabet = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  const chars = [];
  while (chars.length < 20) {
    const hex = Utilities.getUuid().replace(/-/g, '');
    for (let i = 0; i < hex.length && chars.length < 20; i += 2) {
      if (i === 12 || i === 16) continue;
      const b = parseInt(hex.substr(i, 2), 16);
      if (b < 248) chars.push(alphabet[b % 31]);
    }
  }
  const code = chars.join('').match(/.{4}/g).join('-');
  PropertiesService.getScriptProperties().setProperty('SYNC_TOKEN', code);
  CacheService.getScriptCache().remove('fails');
  Logger.log('Votre code secret : ' + code);
  return code;
}

// ---------------------------------------------------------------------------
// Points d'entrée web
// ---------------------------------------------------------------------------

function doGet() {
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
    if (!body || typeof body !== 'object') return json_({ ok: false, error: 'bad_request' });

    const fails = Number(CacheService.getScriptCache().get('fails') || 0);
    if (fails >= MAX_FAILS) return json_({ ok: false, error: 'locked' });

    if (body.action === 'login_google') return json_(loginGoogle_(body));
    if (body.action === 'login_code') return json_(loginCode_(body));

    const who = authenticate_(body);
    if (!who) {
      recordFail_();
      return json_({ ok: false, error: 'unauthorized' });
    }

    if (body.action === 'ping') return json_({ ok: true, email: who, serverTime: Date.now() });
    if (body.action === 'logout') {
      revokeSession_(body.session);
      return json_({ ok: true });
    }
    if (body.action === 'sync') return json_(sync_(body));
    if (body.action === 'push_key') {
      return json_({ ok: true, publicKey: vapidKeys_().pub, devices: loadPushSubs_().length,
                     channel: PropertiesService.getScriptProperties().getProperty('REMINDER_CHANNEL') || 'push' });
    }
    if (body.action === 'push_subscribe') return json_(pushSubscribe_(body));
    if (body.action === 'push_unsubscribe') return json_(pushUnsubscribe_(body));
    if (body.action === 'push_test') return json_(Object.assign({ ok: true }, sendPushAll_()));
    if (body.action === 'reminder_prefs') {
      const channel = ['push', 'email', 'both'].indexOf(body.channel) >= 0 ? body.channel : 'push';
      PropertiesService.getScriptProperties().setProperty('REMINDER_CHANNEL', channel);
      return json_({ ok: true, channel: channel });
    }
    if (body.action === 'agenda_list') return json_(agendaCall_(agendaList_));
    if (body.action === 'agenda_save') return json_(agendaCall_(() => agendaSave_(body)));
    if (body.action === 'agenda_delete') return json_(agendaCall_(() => agendaDelete_(body)));
    if (body.action === 'vault_get') return json_({ ok: true, vault: loadVault_() });
    if (body.action === 'vault_set') return json_(vaultSet_(body));
    if (body.action === 'docs_list') return json_(docsList_());
    if (body.action === 'docs_upload') return json_(docsUpload_(body));
    if (body.action === 'docs_get') return json_(docsAction_(body, f => ({ ok: true, doc: docMeta_(f), content: Utilities.base64Encode(f.getBlob().getBytes()) })));
    if (body.action === 'docs_update') return json_(docsAction_(body, f => docsUpdate_(f, body)));
    if (body.action === 'docs_delete') return json_(docsAction_(body, f => { f.setTrashed(true); return { ok: true }; }));
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
// Authentification
// ---------------------------------------------------------------------------

function ownerEmail_() {
  return String(Session.getEffectiveUser().getEmail() || '').toLowerCase();
}

function allowedEmails_() {
  return [ownerEmail_()].concat(EXTRA_ALLOWED_EMAILS)
    .map(e => String(e || '').trim().toLowerCase())
    .filter(Boolean);
}

function recordFail_() {
  const cache = CacheService.getScriptCache();
  const fails = Number(cache.get('fails') || 0);
  cache.put('fails', String(fails + 1), FAIL_WINDOW_S);
}

/** Vérifie le jeton de connexion Google auprès de Google, puis ouvre une session. */
function loginGoogle_(body) {
  if (!GOOGLE_CLIENT_ID) return { ok: false, error: 'google_not_configured' };
  const idToken = String(body.idToken || '');
  if (idToken.length < 100 || idToken.length > 5000) {
    recordFail_();
    return { ok: false, error: 'bad_token' };
  }
  const res = UrlFetchApp.fetch('https://oauth2.googleapis.com/tokeninfo?id_token=' + encodeURIComponent(idToken),
    { muteHttpExceptions: true });
  if (res.getResponseCode() !== 200) {
    recordFail_();
    return { ok: false, error: 'bad_token' };
  }
  const info = JSON.parse(res.getContentText());
  const issOk = info.iss === 'accounts.google.com' || info.iss === 'https://accounts.google.com';
  if (!issOk || info.aud !== GOOGLE_CLIENT_ID || String(info.email_verified) !== 'true' ||
      Number(info.exp) * 1000 < Date.now()) {
    recordFail_();
    return { ok: false, error: 'bad_token' };
  }
  const email = String(info.email || '').toLowerCase();
  if (allowedEmails_().indexOf(email) < 0) {
    recordFail_();
    return { ok: false, error: 'forbidden_email', email: email };
  }
  return createSession_(email);
}

/** Connexion de secours avec le code secret. */
function loginCode_(body) {
  const expected = PropertiesService.getScriptProperties().getProperty('SYNC_TOKEN');
  if (!expected || !safeEqual_(normalizeToken_(body.token), normalizeToken_(expected))) {
    recordFail_();
    return { ok: false, error: 'unauthorized' };
  }
  return createSession_(ownerEmail_() || 'code');
}

function authenticate_(body) {
  if (body.session) {
    const s = loadSessions_()[hash_(String(body.session))];
    return (s && s.exp > Date.now()) ? s.email : null;
  }
  if (body.token) {
    // Compatibilité avec l'ancienne version de l'appli (code secret)
    const expected = PropertiesService.getScriptProperties().getProperty('SYNC_TOKEN');
    if (expected && safeEqual_(normalizeToken_(body.token), normalizeToken_(expected))) return 'code';
  }
  return null;
}

function createSession_(email) {
  const token = (Utilities.getUuid() + Utilities.getUuid()).replace(/-/g, '');
  const exp = Date.now() + SESSION_DAYS * 86400000;
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    const sessions = loadSessions_();
    sessions[hash_(token)] = { email: email, exp: exp };
    saveSessions_(sessions);
  } finally {
    lock.releaseLock();
  }
  CacheService.getScriptCache().remove('fails');
  return { ok: true, session: token, email: email, expires: exp };
}

function revokeSession_(token) {
  if (!token) return;
  const sessions = loadSessions_();
  delete sessions[hash_(String(token))];
  saveSessions_(sessions);
}

function loadSessions_() {
  try {
    return JSON.parse(PropertiesService.getScriptProperties().getProperty('SESSIONS') || '{}');
  } catch (err) {
    return {};
  }
}

function saveSessions_(sessions) {
  const now = Date.now();
  Object.keys(sessions).forEach(k => { if (!sessions[k] || sessions[k].exp < now) delete sessions[k]; });
  PropertiesService.getScriptProperties().setProperty('SESSIONS', JSON.stringify(sessions));
}

function hash_(text) {
  return Utilities.base64EncodeWebSafe(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, text));
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
// Synchronisation
// ---------------------------------------------------------------------------

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
        if (rec.updatedAt <= (Number(data[i][COL.UPDATED]) || 0)) return;
        data[i] = toRow_(rec, now);
      } else {
        data.push(toRow_(rec, now));
        index[key] = data.length - 1;
      }
      dirty = true;
    });

    if (dirty) {
      sh.getRange(2, 1, data.length, 1).setNumberFormat('@');
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
  if (r.detail !== undefined && r.detail !== null) rec.detail = String(r.detail).slice(0, 80);
  if (r.data !== undefined && r.data !== null) rec.data = String(r.data).slice(0, 20000);   // repas, plats (ingrédients)
  if (type === 'med_plan' && r.plan !== undefined) rec.plan = String(r.plan).slice(0, 20000);
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

// ---------------------------------------------------------------------------
// Rappels de compléments (déclencheur toutes les 5 minutes)
// ---------------------------------------------------------------------------

function verifierPrises() {
  const sh = getSheet_();
  const lastRow = sh.getLastRow();
  if (lastRow < 2) return;
  const jsonCol = sh.getRange(2, COL.JSON + 1, lastRow - 1, 1).getValues();

  const now = new Date();
  const today = Utilities.formatDate(now, TIMEZONE, 'yyyy-MM-dd');
  const nowMin = Number(Utilities.formatDate(now, TIMEZONE, 'H')) * 60 + Number(Utilities.formatDate(now, TIMEZONE, 'm'));

  let planText = null, planVersion = -1;
  const taken = {};
  jsonCol.forEach(row => {
    let rec;
    try { rec = JSON.parse(row[0]); } catch (err) { return; }
    if (!rec || rec.deleted) return;
    if (rec.type === 'med_plan' && Number(rec.updatedAt) > planVersion) {
      planVersion = Number(rec.updatedAt);
      planText = rec.plan;
    }
    if (rec.type === 'med_prise' && rec.isoDate === today && rec.detail) taken[rec.detail] = true;
  });
  if (!planText) return;

  let plan;
  try { plan = JSON.parse(planText); } catch (err) { return; }
  const meds = (plan.meds || []).filter(m => m && m.id && m.name);
  const times = plan.times || {};
  const props = PropertiesService.getScriptProperties();

  Object.keys(MOMENT_LABELS).forEach(moment => {
    const due = meds.filter(m => (m.moments || []).indexOf(moment) >= 0);
    if (!due.length) return;
    const missing = due.filter(m => !taken[m.id + '|' + moment]);
    if (!missing.length) return;
    const t = parseHHMM_(times[moment]);
    if (t === null) return;
    const late = nowMin - t;
    if (late < 0) return;

    const key = 'REM_' + today + '_' + moment;
    const sent = Number(props.getProperty(key) || 0);
    if (sent >= REMINDER_OFFSETS_MIN.length || late < REMINDER_OFFSETS_MIN[sent]) return;
    let stage = sent;
    while (stage + 1 < REMINDER_OFFSETS_MIN.length && late >= REMINDER_OFFSETS_MIN[stage + 1]) stage++;

    const list = missing.map(m => '  • ' + m.name + (m.dose ? ' — ' + m.dose : '')).join('\n');
    const label = MOMENT_LABELS[moment];
    const subject = stage === 0
      ? '💊 Compléments ' + label + ' à prendre (' + times[moment] + ')'
      : '⚠️ Rappel ' + (stage + 1) + ' : compléments ' + label + ' pas encore cochés';
    const bodyText = (stage === 0
        ? 'C\'est l\'heure de tes compléments ' + label + ' :\n\n'
        : 'Ces compléments ' + label + ' (prévus à ' + times[moment] + ') ne sont pas encore cochés :\n\n') +
      list + '\n\nCoche-les dans l\'appli pour arrêter les rappels :\n' + APP_URL;
    remind_(subject, bodyText);
    props.setProperty(key, String(stage + 1));
  });

  // Nettoyage des marqueurs des jours précédents
  Object.keys(props.getProperties()).forEach(k => {
    if (k.indexOf('REM_') === 0 && k.indexOf('REM_' + today) !== 0) props.deleteProperty(k);
  });
}

function parseHHMM_(s) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(s || ''));
  if (!m) return null;
  const h = Number(m[1]), min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
}

function sendAlert_(subject, body) {
  MailApp.sendEmail({ to: ownerEmail_(), subject: subject, body: body, name: 'Suivi Hydrique Pro' });
}

// ---------------------------------------------------------------------------
// Dossier médical chiffré (Google Drive)
// ---------------------------------------------------------------------------

const ENC_MIME = 'application/x-hsp-encrypted';
const ENC_MAGIC = [0x48, 0x53, 0x50, 0x45, 0x4E, 0x43, 0x31, 0x00];   // « HSPENC1 » + 0

function docsFolder_() {
  const props = PropertiesService.getScriptProperties();
  const id = props.getProperty('DOCS_FOLDER_ID');
  if (id) {
    try {
      const existing = DriveApp.getFolderById(id);
      if (!existing.isTrashed()) return existing;
    } catch (err) { /* dossier supprimé : on en recrée un */ }
  }
  const folder = DriveApp.createFolder(DOCS_FOLDER_NAME);
  props.setProperty('DOCS_FOLDER_ID', folder.getId());
  return folder;
}

function isB64_(s, max) {
  return typeof s === 'string' && s.length > 0 && s.length <= max && /^[A-Za-z0-9+/=]+$/.test(s);
}

// ----- Coffre : clé du dossier « emballée » par la phrase secrète (illisible ici) -----
function loadVault_() {
  try { return JSON.parse(PropertiesService.getScriptProperties().getProperty('DOCS_VAULT') || 'null'); } catch (err) { return null; }
}

function vaultSet_(body) {
  const v = body.vault || {};
  if (!isB64_(v.salt, 64) || !isB64_(v.iv, 32) || !isB64_(v.wrapped, 200)) return { ok: false, error: 'bad_vault' };
  const iter = Math.floor(Number(v.iter) || 0);
  if (iter < 100000 || iter > 5000000) return { ok: false, error: 'bad_vault' };
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    const props = PropertiesService.getScriptProperties();
    const current = loadVault_();
    // Remplacement seulement si l'appli prouve qu'elle connaît le coffre actuel (changement de phrase secrète)
    if (current && body.previousSalt !== current.salt) return { ok: false, error: 'vault_exists', vault: current };
    if (current) {
      let history = [];
      try { history = JSON.parse(props.getProperty('DOCS_VAULT_HISTORY') || '[]'); } catch (err) { history = []; }
      history.unshift(current);
      props.setProperty('DOCS_VAULT_HISTORY', JSON.stringify(history.slice(0, 5)));
    }
    const vault = { v: 1, salt: v.salt, iter: iter, iv: v.iv, wrapped: v.wrapped, created: Date.now() };
    props.setProperty('DOCS_VAULT', JSON.stringify(vault));
    return { ok: true, vault: vault };
  } finally {
    lock.releaseLock();
  }
}

// ----- Documents -----
function readDesc_(file) {
  try { return JSON.parse(file.getDescription() || '{}') || {}; } catch (err) { return {}; }
}

function docMeta_(file) {
  const d = readDesc_(file);
  const base = { id: file.getId(), size: file.getSize(), created: file.getDateCreated().getTime() };
  if (d.enc) {
    return Object.assign(base, { enc: true, metaIv: d.iv, metaData: d.data, importedAt: d.importedAt || base.created });
  }
  // Ancien document non chiffré (avant la version 5) : à chiffrer depuis l'appli
  return Object.assign(base, {
    enc: false,
    title: d.title || file.getName().replace(/\.[a-z0-9]+$/i, ''),
    category: DOC_CATEGORIES[d.category] ? d.category : 'autre',
    docDate: d.docDate || Utilities.formatDate(file.getDateCreated(), TIMEZONE, 'yyyy-MM-dd'),
    note: d.note || '',
    pages: d.pages || 0,
    mime: file.getMimeType(),
    importedAt: base.created
  });
}

function docsList_() {
  const folder = docsFolder_();
  const docs = [];
  const it = folder.getFiles();
  while (it.hasNext()) {
    const f = it.next();
    if (!f.isTrashed()) docs.push(docMeta_(f));
  }
  docs.sort((a, b) => b.importedAt - a.importedAt);
  return { ok: true, docs: docs };
}

function docsUpload_(body) {
  if (body.mime !== ENC_MIME) return { ok: false, error: 'not_encrypted' };
  const m = body.meta || {};
  if (!isB64_(m.iv, 32) || !isB64_(m.data, 20000)) return { ok: false, error: 'bad_meta' };
  const b64 = String(body.content || '');
  if (!b64 || b64.length > MAX_DOC_BYTES * 1.4) return { ok: false, error: 'too_big' };
  let bytes;
  try { bytes = Utilities.base64Decode(b64); } catch (err) { return { ok: false, error: 'bad_file' }; }
  if (bytes.length < 40 || bytes.length > MAX_DOC_BYTES) return { ok: false, error: 'too_big' };
  // Le fichier doit être chiffré par l'appli (signature HSPENC1) : aucun document lisible n'est accepté
  for (let i = 0; i < ENC_MAGIC.length; i++) {
    if (((bytes[i] + 256) % 256) !== ENC_MAGIC[i]) return { ok: false, error: 'not_encrypted' };
  }
  const now = new Date();
  const name = 'doc-' + Utilities.formatDate(now, TIMEZONE, 'yyyyMMdd-HHmmss') + '-' +
               Utilities.getUuid().replace(/-/g, '').slice(0, 6) + '.hsp';
  const file = docsFolder_().createFile(Utilities.newBlob(bytes, ENC_MIME, name));
  file.setDescription(JSON.stringify({ enc: 1, v: 1, iv: m.iv, data: m.data, importedAt: now.getTime() }));
  return { ok: true, doc: docMeta_(file) };
}

/** N'autorise l'accès qu'aux fichiers rangés dans le dossier médical. */
function docsAction_(body, fn) {
  let file;
  try {
    file = DriveApp.getFileById(String(body.id || ''));
  } catch (err) {
    return { ok: false, error: 'not_found' };
  }
  const folderId = docsFolder_().getId();
  let inside = false;
  const parents = file.getParents();
  while (parents.hasNext()) if (parents.next().getId() === folderId) inside = true;
  if (!inside || file.isTrashed()) return { ok: false, error: 'not_found' };
  if (file.getSize() > MAX_DOC_BYTES) return { ok: false, error: 'too_big' };
  return fn(file);
}

/** Remplace les informations chiffrées d'un document (titre, catégorie, date, remarque). */
function docsUpdate_(file, body) {
  const d = readDesc_(file);
  if (!d.enc) return { ok: false, error: 'not_encrypted' };
  const m = body.meta || {};
  if (!isB64_(m.iv, 32) || !isB64_(m.data, 20000)) return { ok: false, error: 'bad_meta' };
  file.setDescription(JSON.stringify({ enc: 1, v: 1, iv: m.iv, data: m.data, importedAt: d.importedAt || file.getDateCreated().getTime() }));
  return { ok: true, doc: docMeta_(file) };
}

// ---------------------------------------------------------------------------
// Notifications push sur le téléphone (Web Push, signature VAPID ES256)
// Apps Script ne sait pas signer en ECDSA P-256 : la signature est calculée ici en JavaScript pur.
// ---------------------------------------------------------------------------

const EC_P = BigInt('0xffffffff00000001000000000000000000000000ffffffffffffffffffffffff');
// Petites constantes BigInt (l'éditeur Apps Script refuse les nombres BigInt écrits avec un « n » final)
const N0_ = BigInt(0), N1_ = BigInt(1), N2_ = BigInt(2), N3_ = BigInt(3), N4_ = BigInt(4), N8_ = BigInt(8), N255_ = BigInt(255);
const EC_N = BigInt('0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551');
const EC_G = [BigInt('0x6b17d1f2e12c4247f8bce6e563a440f277037d812deb33a0f4a13945d898c296'),
              BigInt('0x4fe342e2fe1a7f9b8ee7eb4a7c0f9e162bce33576b315ececbb6406837bf51f5')];
const PUSH_HOSTS = /^https:\/\/(fcm\.googleapis\.com|android\.googleapis\.com|updates\.push\.services\.mozilla\.com|[a-z0-9.-]+\.notify\.windows\.com|web\.push\.apple\.com)\//;
const MAX_PUSH_DEVICES = 10;

function ecMod_(a, m) { const r = a % m; return r >= N0_ ? r : r + m; }

function ecInv_(a, m) {
  let r0 = ecMod_(a, m), r1 = m, s0 = N1_, s1 = N0_;
  while (r1 !== N0_) {
    const q = r0 / r1;
    [r0, r1] = [r1, r0 - q * r1];
    [s0, s1] = [s1, s0 - q * s1];
  }
  return ecMod_(s0, m);
}

// Points en coordonnées jacobiennes [X, Y, Z] ; null = point à l'infini
function ecDouble_(P) {
  if (!P || P[1] === N0_) return null;
  const p = EC_P, X = P[0], Y = P[1], Z = P[2];
  const YY = Y * Y % p, ZZ = Z * Z % p;
  const S = N4_ * X % p * YY % p;
  const M = N3_ * ecMod_(X - ZZ, p) % p * ((X + ZZ) % p) % p;   // a = -3
  const X3 = ecMod_(M * M - N2_ * S, p);
  const Y3 = ecMod_(M * ecMod_(S - X3, p) - N8_ * (YY * YY % p), p);
  const Z3 = N2_ * Y % p * Z % p;
  return [X3, Y3, Z3];
}

function ecAdd_(P, Q) {
  if (!P) return Q;
  if (!Q) return P;
  const p = EC_P;
  const Z1Z1 = P[2] * P[2] % p, Z2Z2 = Q[2] * Q[2] % p;
  const U1 = P[0] * Z2Z2 % p, U2 = Q[0] * Z1Z1 % p;
  const S1 = P[1] * Q[2] % p * Z2Z2 % p, S2 = Q[1] * P[2] % p * Z1Z1 % p;
  const H = ecMod_(U2 - U1, p), R = ecMod_(S2 - S1, p);
  if (H === N0_) return R === N0_ ? ecDouble_(P) : null;
  const HH = H * H % p, HHH = H * HH % p, V = U1 * HH % p;
  const X3 = ecMod_(R * R - HHH - N2_ * V, p);
  const Y3 = ecMod_(R * ecMod_(V - X3, p) - S1 * HHH, p);
  const Z3 = H * P[2] % p * Q[2] % p;
  return [X3, Y3, Z3];
}

function ecMul_(k, P) {
  let R = null, Q = [P[0], P[1], N1_];
  while (k > N0_) {
    if (k & N1_) R = ecAdd_(R, Q);
    Q = ecDouble_(Q);
    k >>= N1_;
  }
  return R;
}

function ecAffine_(P) {
  const zi = ecInv_(P[2], EC_P), zi2 = zi * zi % EC_P;
  return [P[0] * zi2 % EC_P, P[1] * zi2 % EC_P * zi % EC_P];
}

function u8_(signedBytes) { return signedBytes.map(b => (b + 256) % 256); }
function s8_(bytes) { return bytes.map(b => (b > 127 ? b - 256 : b)); }
function bytesToBig_(bytes) { let x = N0_; bytes.forEach(b => { x = (x << N8_) | BigInt(b); }); return x; }
function bigToBytes_(x, len) { const out = []; for (let i = 0; i < len; i++) { out.unshift(Number(x & N255_)); x >>= N8_; } return out; }
function b64uBytes_(bytes) { return Utilities.base64EncodeWebSafe(s8_(bytes)).replace(/=+$/, ''); }
function b64uText_(text) { return Utilities.base64EncodeWebSafe(text, Utilities.Charset.UTF_8).replace(/=+$/, ''); }
function hmac_(key, data) { return u8_(Utilities.computeHmacSha256Signature(s8_(data), s8_(key))); }

// Nonce déterministe (RFC 6979) : aucune dépendance à un générateur aléatoire
function rfc6979K_(d, hash) {
  const x = bigToBytes_(d, 32);
  const h = bigToBytes_(ecMod_(bytesToBig_(hash), EC_N), 32);
  let V = new Array(32).fill(1), K = new Array(32).fill(0);
  K = hmac_(K, V.concat([0], x, h)); V = hmac_(K, V);
  K = hmac_(K, V.concat([1], x, h)); V = hmac_(K, V);
  for (;;) {
    V = hmac_(K, V);
    const k = bytesToBig_(V);
    if (k > N0_ && k < EC_N) return k;
    K = hmac_(K, V.concat([0]));
    V = hmac_(K, V);
  }
}

function ecdsaSign_(message, d) {
  const hash = u8_(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, message, Utilities.Charset.UTF_8));
  const z = bytesToBig_(hash);
  const k = rfc6979K_(d, hash);
  const r = ecMod_(ecAffine_(ecMul_(k, EC_G))[0], EC_N);
  const s = ecMod_(ecInv_(k, EC_N) * ecMod_(z + r * d, EC_N), EC_N);
  return bigToBytes_(r, 32).concat(bigToBytes_(s, 32));
}

/** Clés VAPID du serveur (créées une seule fois, la clé privée reste dans les propriétés du script). */
function vapidKeys_() {
  const props = PropertiesService.getScriptProperties();
  const dHex = props.getProperty('VAPID_D'), pub = props.getProperty('VAPID_PUBLIC');
  if (dHex && pub) return { d: BigInt('0x' + dHex), pub: pub };
  let seed = String(Date.now());
  for (let i = 0; i < 6; i++) seed += Utilities.getUuid();
  const d = ecMod_(bytesToBig_(u8_(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, seed, Utilities.Charset.UTF_8))), EC_N - N1_) + N1_;
  const Q = ecAffine_(ecMul_(d, EC_G));
  const publicKey = b64uBytes_([4].concat(bigToBytes_(Q[0], 32), bigToBytes_(Q[1], 32)));
  props.setProperty('VAPID_D', d.toString(16).padStart(64, '0'));
  props.setProperty('VAPID_PUBLIC', publicKey);
  return { d: d, pub: publicKey };
}

function vapidJwt_(audience, keys) {
  const cache = CacheService.getScriptCache();
  const cacheKey = 'VAPID_JWT_' + audience;
  const cached = cache.get(cacheKey);
  if (cached) return cached;
  const head = b64uText_(JSON.stringify({ typ: 'JWT', alg: 'ES256' }));
  const body = b64uText_(JSON.stringify({ aud: audience, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: 'mailto:' + ownerEmail_() }));
  const jwt = head + '.' + body + '.' + b64uBytes_(ecdsaSign_(head + '.' + body, keys.d));
  cache.put(cacheKey, jwt, 6 * 3600);
  return jwt;
}

function loadPushSubs_() {
  try { return JSON.parse(PropertiesService.getScriptProperties().getProperty('PUSH_SUBS') || '[]'); } catch (err) { return []; }
}
function savePushSubs_(subs) {
  PropertiesService.getScriptProperties().setProperty('PUSH_SUBS', JSON.stringify(subs.slice(0, MAX_PUSH_DEVICES)));
}

function pushSubscribe_(body) {
  const sub = body.subscription || {};
  const endpoint = String(sub.endpoint || '');
  if (!PUSH_HOSTS.test(endpoint) || endpoint.length > 1000) return { ok: false, error: 'bad_subscription' };
  const label = String(body.label || 'Appareil').slice(0, 60);
  const subs = loadPushSubs_().filter(s => s.endpoint !== endpoint);
  subs.unshift({ endpoint: endpoint, label: label, created: Date.now() });
  savePushSubs_(subs);
  return { ok: true, devices: Math.min(subs.length, MAX_PUSH_DEVICES) };
}

function pushUnsubscribe_(body) {
  const endpoint = String(body.endpoint || '');
  const subs = loadPushSubs_().filter(s => s.endpoint !== endpoint);
  savePushSubs_(subs);
  return { ok: true, devices: subs.length };
}

/** Envoie un signal push (sans contenu) à chaque téléphone abonné : il affiche alors la notification. */
function sendPushAll_() {
  const subs = loadPushSubs_();
  if (!subs.length) return { sent: 0, failed: 0, devices: 0 };
  const keys = vapidKeys_();
  let sent = 0, failed = 0;
  const keep = [];
  subs.forEach(sub => {
    let code = 0;
    try {
      const audience = sub.endpoint.match(/^https:\/\/[^/]+/)[0];
      code = UrlFetchApp.fetch(sub.endpoint, {
        method: 'post',
        contentType: 'application/octet-stream',
        payload: '',
        headers: { TTL: '3600', Urgency: 'high', Authorization: 'vapid t=' + vapidJwt_(audience, keys) + ', k=' + keys.pub },
        muteHttpExceptions: true
      }).getResponseCode();
    } catch (err) {
      code = 0;
    }
    if (code >= 200 && code < 300) { sent++; keep.push(sub); }
    else if (code === 404 || code === 410) { /* abonnement expiré : retiré */ }
    else { failed++; keep.push(sub); }
  });
  savePushSubs_(keep);
  return { sent: sent, failed: failed, devices: keep.length };
}

/** Rappel de compléments : notification sur le téléphone, e-mail en secours (ou selon le choix fait dans l'appli). */
function remind_(subject, body) {
  const channel = PropertiesService.getScriptProperties().getProperty('REMINDER_CHANNEL') || 'push';
  let pushed = 0;
  if (channel !== 'email') pushed = sendPushAll_().sent;
  if (channel === 'email' || channel === 'both' || pushed === 0) {
    sendAlert_(subject, body + (channel !== 'email' && pushed === 0
      ? '\n\n(Aucune notification n\'a pu être envoyée sur ton téléphone : ce rappel arrive donc par e-mail. Active les notifications dans l\'appli, carte « Compléments ».)'
      : ''));
  }
}

/** À lancer depuis l'éditeur : envoie une notification de test aux téléphones abonnés. */
function testerNotification() {
  const r = sendPushAll_();
  Logger.log('Notification envoyée à ' + r.sent + ' appareil(s) sur ' + r.devices + (r.failed ? ' (' + r.failed + ' échec(s))' : '') + '.');
}

// ---------------------------------------------------------------------------
// Agenda médical (Google Agenda, agenda séparé « 🩺 RDV médicaux »)
// ---------------------------------------------------------------------------

const AGENDA_NAME = '🩺 RDV médicaux';
const AGENDA_PAST_DAYS = 400;
const AGENDA_FUTURE_DAYS = 400;

/** À exécuter une fois depuis l'éditeur : autorise l'accès à Google Agenda et crée l'agenda médical. */
function installerAgenda() {
  const cal = agendaCal_();
  Logger.log('Agenda prêt : « ' + cal.getName() + ' ». Il apparaît dans Google Agenda / Gmail. Redéployez maintenant (nouvelle version).');
}

function agendaCal_() {
  const props = PropertiesService.getScriptProperties();
  const id = props.getProperty('AGENDA_ID');
  let cal = id ? CalendarApp.getCalendarById(id) : null;
  if (!cal) {
    const same = CalendarApp.getCalendarsByName(AGENDA_NAME);
    cal = same.length ? same[0] : CalendarApp.createCalendar(AGENDA_NAME, { summary: 'Rendez-vous médicaux — Suivi Hydrique Pro' });
    try { cal.setColor('#0F766E'); } catch (err) { /* couleur facultative */ }
    props.setProperty('AGENDA_ID', cal.getId());
  }
  return cal;
}

function agendaCall_(fn) {
  try {
    return fn();
  } catch (err) {
    console.error(err);
    const msg = String(err && err.message || err);
    if (/permission|autoris|authoriz|scope/i.test(msg)) return { ok: false, error: 'agenda_auth' };
    return { ok: false, error: 'agenda' };
  }
}

function agendaEvent_(e, cal) {
  const allDay = e.isAllDayEvent();
  const tz = cal.getTimeZone() || TIMEZONE;
  return {
    id: e.getId(),
    title: e.getTitle() || '(sans titre)',
    start: e.getStartTime().getTime(),
    end: e.getEndTime().getTime(),
    allDay: allDay,
    day: Utilities.formatDate(e.getStartTime(), allDay ? tz : TIMEZONE, 'yyyy-MM-dd'),
    location: e.getLocation() || '',
    notes: String(e.getDescription() || '').slice(0, 3000),
    recurring: e.isRecurringEvent(),
    updated: e.getLastUpdated().getTime()
  };
}

function agendaList_() {
  const cal = agendaCal_();
  const now = Date.now();
  const events = cal.getEvents(new Date(now - AGENDA_PAST_DAYS * 86400000), new Date(now + AGENDA_FUTURE_DAYS * 86400000));
  return { ok: true, calendar: cal.getName(), serverTime: now, events: events.slice(0, 800).map(e => agendaEvent_(e, cal)) };
}

function agendaSave_(body) {
  const ev = body.event || {};
  const title = String(ev.title || '').trim().slice(0, 200);
  const start = Number(ev.start), end = Number(ev.end);
  if (!title || !isFinite(start) || !isFinite(end) || end <= start || end - start > 2 * 86400000) return { ok: false, error: 'bad_event' };
  const location = String(ev.location || '').slice(0, 300);
  const notes = String(ev.notes || '').slice(0, 3000);
  const cal = agendaCal_();
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    let e;
    if (ev.id) {
      e = cal.getEventById(String(ev.id));
      if (!e) return { ok: false, error: 'not_found' };
      if (e.isRecurringEvent()) return { ok: false, error: 'recurring' };
      e.setTitle(title);
      e.setTime(new Date(start), new Date(end));
      e.setLocation(location);
      e.setDescription(notes);
    } else {
      e = cal.createEvent(title, new Date(start), new Date(end), { location: location, description: notes });
    }
    return { ok: true, event: agendaEvent_(e, cal) };
  } finally {
    lock.releaseLock();
  }
}

function agendaDelete_(body) {
  const cal = agendaCal_();
  const e = cal.getEventById(String(body.id || ''));
  if (!e) return { ok: true };
  if (e.isRecurringEvent()) return { ok: false, error: 'recurring' };
  e.deleteEvent();
  return { ok: true };
}
