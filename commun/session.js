// EspaceLigue · ce que l'Espace gérant et l'inscription partagent : parler à
// Supabase, la session, Apple, le thème.
//
// La sécurité ne repose pas sur ces pages : la base (RLS, fonctions) vérifie
// chaque geste. Ici :
// - aucune donnée écrite en HTML (textContent seulement) ;
// - le jeton d'accès reste en mémoire ; le jeton de rafraîchissement vit dans
//   sessionStorage, propre à l'onglet : recharger garde la session, fermer
//   l'onglet la perd ;
// - la page refuse de s'afficher dans un cadre.
'use strict';

// Comme l'administration : servie depuis le Mac, la base du M1 ; en ligne, la production.
const LOCAL = ['localhost', '127.0.0.1'].includes(location.hostname);
const SUPABASE = LOCAL ? 'https://supabase.lautmandam.mywire.org' : 'https://wkjyeyswlvdkaalhslvw.supabase.co';
// Publique par construction : la même que dans les apps.
const CLE = LOCAL ? 'sb_publishable_sHSVbbwMhsDTqjYb93S1md_P0EIsxy4' : 'sb_publishable_aDtOKUHIXbnSLWX6qPBpuQ_bixLx_ft';

if (window.top !== window.self) {
  document.documentElement.textContent = '';
  throw new Error('cadre refusé');
}

const $ = (id) => document.getElementById(id);

function el(balise, attrs, ...enfants) {
  const n = document.createElement(balise);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
    else if (k === 'classe') n.className = v;
    else if (k === 'valeur') n.value = v;
    else n.setAttribute(k, v === true ? '' : v);
  }
  for (const e of enfants.flat()) {
    if (e === null || e === undefined || e === false) continue;
    n.append(e instanceof Node ? e : document.createTextNode(String(e)));
  }
  return n;
}

// --- Session ---------------------------------------------------------------
const session = { jeton: null, rafraichir: null, expire: 0, utilisateur: null };
const CLE_RAFRAICHIR = 'espaceligue-rafraichir';

function memoriser(cle, valeur) {
  try { valeur ? sessionStorage.setItem(cle, valeur) : sessionStorage.removeItem(cle); } catch (e) { /* bloqué */ }
}
function relire(cle) {
  try { return sessionStorage.getItem(cle); } catch (e) { return null; }
}

// Les messages de GoTrue, en français quand on les connaît.
const ERREURS_AUTH = {
  invalid_credentials: 'Courriel ou mot de passe incorrect.',
  email_not_confirmed: 'Confirme d\'abord ton courriel.',
  user_already_exists: 'Un compte existe déjà avec ce courriel.',
  weak_password: 'Mot de passe trop faible (8 caractères au moins).',
  signup_disabled: 'Les inscriptions sont fermées pour le moment.',
  otp_expired: 'Code expiré ou incorrect.',
  over_email_send_rate_limit: 'Trop d\'envois. Réessaie dans quelques minutes.',
};

async function auth(chemin, corps) {
  const r = await fetch(SUPABASE + '/auth/v1/' + chemin, {
    method: 'POST', credentials: 'omit', cache: 'no-store',
    headers: { apikey: CLE, 'Content-Type': 'application/json' },
    body: JSON.stringify(corps),
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(ERREURS_AUTH[d.error_code] || d.error_description || d.msg || 'Connexion refusée.');
  return d;
}

function poserJetons(d) {
  session.jeton = d.access_token;
  session.rafraichir = d.refresh_token;
  session.expire = Date.now() + (d.expires_in - 60) * 1000;
  session.utilisateur = d.user || session.utilisateur;
  memoriser(CLE_RAFRAICHIR, d.refresh_token);
}

function oublierSession() {
  if (session.jeton) {
    fetch(SUPABASE + '/auth/v1/logout', { method: 'POST', credentials: 'omit',
      headers: { apikey: CLE, Authorization: 'Bearer ' + session.jeton } }).catch(() => {});
  }
  Object.assign(session, { jeton: null, rafraichir: null, expire: 0, utilisateur: null });
  memoriser(CLE_RAFRAICHIR, null);
}

/** Reprend la session de l'onglet, s'il y en a une. Rend vrai si c'est fait. */
async function reprendreSession() {
  const r = relire(CLE_RAFRAICHIR);
  if (!r) return false;
  try { poserJetons(await auth('token?grant_type=refresh_token', { refresh_token: r })); return true; }
  catch (e) { memoriser(CLE_RAFRAICHIR, null); return false; }
}

async function jetonFrais() {
  if (Date.now() > session.expire) {
    poserJetons(await auth('token?grant_type=refresh_token', { refresh_token: session.rafraichir }));
  }
  return session.jeton;
}

// Appelée quand la base refuse la session (401) ; chaque page la remplace.
let sessionPerdue = () => {};

/** PostgREST : `chemin` est relatif à /rest/v1/. */
async function rest(methode, chemin, corps, entetes) {
  const r = await fetch(SUPABASE + '/rest/v1/' + chemin, {
    method: methode, credentials: 'omit', cache: 'no-store',
    headers: Object.assign({ apikey: CLE, Authorization: 'Bearer ' + await jetonFrais(),
                             'Content-Type': 'application/json' }, entetes || {}),
    body: corps === undefined ? undefined : JSON.stringify(corps),
  });
  const texte = await r.text();
  const d = texte ? JSON.parse(texte) : null;
  if (r.status === 401) { sessionPerdue(); throw new Error('Session expirée.'); }
  if (!r.ok) throw new Error((d && d.message) || 'Erreur ' + r.status);
  return d;
}

const rpc = (nom, params) => rest('POST', 'rpc/' + nom, params || {});
const lire = (table, requete) => rest('GET', table + '?' + new URLSearchParams(requete));

// --- Apple (redirection, PKCE) ----------------------------------------------
// Apple rend la main en rechargeant la page : le vérificateur PKCE attend dans
// sessionStorage, lu une fois puis effacé.
const B64URL = (octets) => btoa(String.fromCharCode(...new Uint8Array(octets)))
  .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const RETOUR = location.origin + location.pathname;

async function continuerAvecApple() {
  const verif = B64URL(crypto.getRandomValues(new Uint8Array(48)));
  const defi = B64URL(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verif)));
  memoriser('espaceligue-pkce', verif);
  if (relire('espaceligue-pkce') !== verif) throw new Error('Le navigateur bloque le stockage de session.');
  location.assign(SUPABASE + '/auth/v1/authorize?' + new URLSearchParams({
    provider: 'apple', redirect_to: RETOUR, code_challenge: defi, code_challenge_method: 's256',
  }));
}

/** Au chargement : rend vrai si Apple vient de rendre une session. */
async function retourApple() {
  const p = new URLSearchParams(location.search);
  if (!p.has('code') && !p.has('error')) return false;
  history.replaceState(null, '', RETOUR);
  const verif = relire('espaceligue-pkce');
  memoriser('espaceligue-pkce', null);
  if (p.has('error')) throw new Error(p.get('error_description') || 'Apple a refusé la connexion.');
  if (!verif) throw new Error('Connexion Apple expirée. Réessaie.');
  poserJetons(await auth('token?grant_type=pkce', { auth_code: p.get('code'), code_verifier: verif }));
  return true;
}

// --- Thème ------------------------------------------------------------------
// Une préférence d'affichage gardée dans ce navigateur ; sans choix, le système.
function themeChoisi() {
  try { const t = localStorage.getItem('theme'); if (t === 'light' || t === 'dark') return t; } catch (e) { /* bloqué */ }
  return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
}
function poserTheme(t) {
  document.documentElement.setAttribute('data-theme', t);
  for (const b of document.querySelectorAll('button.theme')) {
    b.textContent = t === 'light' ? '☾ Foncé' : '☀︎ Clair';
    b.setAttribute('aria-label', t === 'light' ? 'Passer au thème foncé' : 'Passer au thème clair');
  }
}
function basculerTheme() {
  const t = document.documentElement.getAttribute('data-theme') === 'light' ? 'dark' : 'light';
  try { localStorage.setItem('theme', t); } catch (e) { /* bloqué */ }
  poserTheme(t);
}
document.addEventListener('DOMContentLoaded', () => {
  poserTheme(themeChoisi());
  for (const b of document.querySelectorAll('button.theme')) b.addEventListener('click', basculerTheme);
});
