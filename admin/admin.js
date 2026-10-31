// EspaceLigue · Gestion — la page d'administration du système.
//
// La sécurité ne repose pas sur cette page : chaque fonction `admin_*` de la
// base vérifie elle-même que le compte est administrateur, et le compte du
// propriétaire est protégé par la base. La page, elle :
// - ne charge aucun code d'ailleurs (politique CSP dans index.html) ;
// - n'écrit jamais une donnée en HTML (textContent seulement) ;
// - garde le jeton en mémoire, jamais dans le navigateur : fermer l'onglet
//   ou le recharger déconnecte ;
// - se déconnecte après 15 minutes sans geste ;
// - refuse de s'afficher dans un cadre (détournement de clic).
'use strict';

// Servie depuis le Mac (`lancer-site.sh` du dépôt lineup), la page parle à la
// base de développement du M1 ; en ligne, à la production. Comme les apps :
// Debug au M1, Release à la production (7 octobre 2026).
const LOCAL = ['localhost', '127.0.0.1'].includes(location.hostname);
const SUPABASE = LOCAL ? 'https://supabase.lautmandam.mywire.org' : 'https://wkjyeyswlvdkaalhslvw.supabase.co';
// Publique par construction : c'est la même que dans les apps.
const CLE = LOCAL ? 'sb_publishable_sHSVbbwMhsDTqjYb93S1md_P0EIsxy4' : 'sb_publishable_aDtOKUHIXbnSLWX6qPBpuQ_bixLx_ft';
const INACTIVITE_MS = 15 * 60 * 1000;
// Une session ouverte survit au rafraîchissement de l'onglet une heure au plus
// (Vincent, 31 octobre 2026) : le jeton de renouvellement va dans
// sessionStorage, propre à l'onglet et effacé à sa fermeture.
const SESSION_MS = 60 * 60 * 1000;

if (window.top !== window.self) {
  document.documentElement.textContent = '';
  throw new Error('cadre refusé');
}

const etat = { attente: null, facteur: null, jeton: null, rafraichir: null, expire: 0, courriel: '', proprietaire: false,
               onglet: 'tableau', minuterie: null, regions: [],
               finances: { periode: 'douze', volet: 'apercu' } };

// --- Petits outils -------------------------------------------------------
const $ = (id) => document.getElementById(id);

function el(balise, attrs, ...enfants) {
  const n = document.createElement(balise);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
    else if (k === 'classe') n.className = v;
    else n.setAttribute(k, v === true ? '' : v);
  }
  for (const e of enfants.flat()) {
    if (e === null || e === undefined || e === false) continue;
    n.append(e instanceof Node ? e : document.createTextNode(String(e)));
  }
  return n;
}

function date(iso, heure) {
  if (!iso) return '—';
  const d = new Date(iso);
  return heure ? d.toLocaleString('fr-CA', { dateStyle: 'medium', timeStyle: 'short' })
               : d.toLocaleDateString('fr-CA', { dateStyle: 'medium' });
}

function nomDe(p) {
  return [p.prenom, p.nom].filter(Boolean).join(' ') || '(sans nom)';
}

function dire(texte, erreur) {
  const m = $('message');
  m.textContent = texte;
  m.className = 'message' + (erreur ? ' erreur' : '');
  m.hidden = !texte;
  if (texte) window.scrollTo({ top: 0, behavior: 'smooth' });
}

// --- Parler à Supabase ---------------------------------------------------
async function auth(chemin, corps) {
  const r = await fetch(SUPABASE + '/auth/v1/' + chemin, {
    method: 'POST', credentials: 'omit', cache: 'no-store',
    headers: { apikey: CLE, 'Content-Type': 'application/json' },
    body: JSON.stringify(corps),
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.error_description || d.msg || 'Connexion refusée.');
  return d;
}

function poserJetons(d) {
  etat.jeton = d.access_token;
  etat.rafraichir = d.refresh_token;
  etat.expire = Date.now() + (d.expires_in - 60) * 1000;
  garderSession();
}

function garderSession() {
  if (!etat.limite) return;
  try {
    sessionStorage.setItem('lineup-session', JSON.stringify({ rafraichir: etat.rafraichir, limite: etat.limite }));
  } catch (e) { /* bloqué : on redemandera le mot de passe */ }
}

// Au chargement : la session de moins d'une heure reprend, 2e facteur compris.
async function reprendreSession() {
  let s = null;
  try { s = JSON.parse(sessionStorage.getItem('lineup-session')); } catch (e) {}
  if (!s || !s.rafraichir || !(s.limite > Date.now())) {
    try { sessionStorage.removeItem('lineup-session'); } catch (e) {}
    return;
  }
  etat.limite = s.limite;
  try {
    poserJetons(await auth('token?grant_type=refresh_token', { refresh_token: s.rafraichir }));
    await apresConnexion();
  } catch (e) {
    deconnecter('');
  }
}

async function rpc(nom, params) {
  if (Date.now() > etat.expire) {
    poserJetons(await auth('token?grant_type=refresh_token', { refresh_token: etat.rafraichir }));
  }
  // « pro.admin_… » : une fonction du schéma pro (EspaceLigue Pro).
  const [schema, fonction] = nom.includes('.') ? nom.split('.') : ['public', nom];
  const r = await fetch(SUPABASE + '/rest/v1/rpc/' + fonction, {
    method: 'POST', credentials: 'omit', cache: 'no-store',
    headers: { apikey: CLE, Authorization: 'Bearer ' + etat.jeton,
               'Content-Type': 'application/json', 'Content-Profile': schema },
    body: JSON.stringify(params || {}),
  });
  const texte = await r.text();
  const d = texte ? JSON.parse(texte) : null;
  if (r.status === 401) { deconnecter('Session expirée.'); throw new Error('Session expirée.'); }
  if (!r.ok) throw new Error((d && d.message) || 'Erreur ' + r.status);
  return d;
}

// Un geste qui écrit : le dire, puis recharger la vue.
async function agir(fonction, params, reussite, ensuite) {
  try {
    await rpc(fonction, params);
    dire(reussite);
    await (ensuite || afficher)();
  } catch (e) {
    dire(e.message, true);
  }
}

// --- Connexion -----------------------------------------------------------
async function connecter(ev) {
  ev.preventDefault();
  const bouton = ev.submitter;
  bouton.disabled = true;
  $('erreur-connexion').textContent = '';
  try {
    poserJetons(await auth('token?grant_type=password',
                           { email: $('courriel').value.trim(), password: $('mdp').value }));
    $('mdp').value = '';
    await apresConnexion();
  } catch (e) {
    $('erreur-connexion').textContent = e.message;
  } finally {
    bouton.disabled = false;
  }
}

// Session ouverte (courriel ou Apple) : l'accès, puis le 2e facteur.
async function apresConnexion() {
  const moi = await rpc('admin_moi');
  if (!moi.admin) {
    await fermerSession();
    throw new Error('Ce compte n’a pas accès à la gestion.');
  }
  etat.courriel = (await authJeton('GET', 'user')).email || '';
  etat.proprietaire = moi.proprietaire;
  if (moi.deux_facteurs) ouvrir();
  else if (moi.appareil) await demanderApprobation();
  else await preparerCode();
}

// --- Apple (redirection, PKCE) ---------------------------------------------
// Apple ne rend la main qu'en rechargeant la page : le vérificateur PKCE va dans
// sessionStorage, lu une fois puis effacé. Le jeton d'accès reste en mémoire.
const B64URL = (octets) => btoa(String.fromCharCode(...new Uint8Array(octets)))
  .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const RETOUR = location.origin + location.pathname;

async function continuerAvecApple() {
  const verif = B64URL(crypto.getRandomValues(new Uint8Array(48)));
  const defi = B64URL(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verif)));
  try { sessionStorage.setItem('lineup-pkce', verif); } catch (e) {
    $('erreur-connexion').textContent = 'Le navigateur bloque le stockage de session.';
    return;
  }
  location.assign(SUPABASE + '/auth/v1/authorize?' + new URLSearchParams({
    provider: 'apple', redirect_to: RETOUR, code_challenge: defi, code_challenge_method: 's256',
  }));
}

async function retourApple() {
  const p = new URLSearchParams(location.search);
  if (!p.has('code') && !p.has('error')) return;
  history.replaceState(null, '', RETOUR);
  let verif = null;
  try { verif = sessionStorage.getItem('lineup-pkce'); sessionStorage.removeItem('lineup-pkce'); } catch (e) {}
  try {
    if (p.has('error')) throw new Error(p.get('error_description') || 'Apple a refusé la connexion.');
    if (!verif) throw new Error('Connexion Apple expirée. Réessaie.');
    poserJetons(await auth('token?grant_type=pkce', { auth_code: p.get('code'), code_verifier: verif }));
    await apresConnexion();
  } catch (e) {
    $('erreur-connexion').textContent = e.message;
  }
}

// --- Double authentification (TOTP) --------------------------------------
// La base refuse toute fonction `admin_*` à une session qui n'a pas passé un
// code (`aal2`). Premier passage : on inscrit l'app d'authentification.
async function authJeton(methode, chemin, corps) {
  const r = await fetch(SUPABASE + '/auth/v1/' + chemin, {
    method: methode, credentials: 'omit', cache: 'no-store',
    headers: { apikey: CLE, Authorization: 'Bearer ' + etat.jeton, 'Content-Type': 'application/json' },
    body: corps ? JSON.stringify(corps) : undefined,
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.msg || d.error_description || d.message || 'Erreur ' + r.status);
  return d;
}

// --- Approbation par le téléphone ------------------------------------------
// Le site montre un nombre ; le téléphone enregistré le fait taper. La base
// ouvre alors l'administration à cette session-ci.
function montrer(id) {
  for (const x of ['formulaire-connexion', 'approbation', 'formulaire-code']) $(x).hidden = x !== id;
}

async function demanderApprobation() {
  clearInterval(etat.attente);
  montrer('approbation');
  $('reessayer').hidden = true;
  $('nombre').textContent = '';
  $('etat-approbation').textContent = 'Envoi au téléphone…';
  try {
    const d = await rpc('admin_demander_approbation');
    $('nombre').textContent = d.nombre;
    $('etat-approbation').textContent = 'En attente de ton téléphone…';
    const debut = Date.now();
    etat.attente = setInterval(async () => {
      let statut = 'attente';
      try { statut = await rpc('admin_etat_approbation', { p_id: d.id }); } catch (e) { return; }
      if (statut === 'attente' && Date.now() - debut < 125000) return;
      clearInterval(etat.attente);
      if (statut === 'approuvee') { ouvrir(); return; }
      $('nombre').textContent = '';
      $('etat-approbation').textContent = statut === 'refusee' ? 'Connexion refusée.' : 'Délai écoulé.';
      $('reessayer').hidden = false;
    }, 2000);
  } catch (e) {
    $('etat-approbation').textContent = e.message;
    $('reessayer').hidden = false;
  }
}

async function preparerCode() {
  clearInterval(etat.attente);
  const moi = await authJeton('GET', 'user');
  const facteurs = (moi.factors || []).filter((f) => f.factor_type === 'totp');
  const verifie = facteurs.find((f) => f.status === 'verified');
  if (verifie) {
    etat.facteur = verifie.id;
    $('inscription-totp').hidden = true;
  } else {
    // Une inscription abandonnée laisse un facteur non vérifié : on le retire.
    for (const f of facteurs) await authJeton('DELETE', 'factors/' + f.id).catch(() => {});
    const ins = await authJeton('POST', 'factors', { factor_type: 'totp', friendly_name: 'EspaceLigue Gestion' });
    etat.facteur = ins.id;
    $('qr').src = imageQr(ins.totp.qr_code);
    $('secret').textContent = ins.totp.secret;
    $('inscription-totp').hidden = false;
  }
  montrer('formulaire-code');
  $('erreur-code').textContent = '';
  $('code').value = '';
  $('code').focus();
}

// Supabase rend le QR en SVG brut dans une adresse `data:` non encodée : un
// `#` ou un `%` du SVG la coupe. On le réencode.
function imageQr(brut) {
  const i = brut.indexOf('<svg');
  if (i < 0) return brut;
  return 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(brut.slice(i));
}

async function validerCode(ev) {
  ev.preventDefault();
  const bouton = ev.submitter;
  bouton.disabled = true;
  try {
    const defi = await authJeton('POST', 'factors/' + etat.facteur + '/challenge', {});
    poserJetons(await authJeton('POST', 'factors/' + etat.facteur + '/verify',
                                { challenge_id: defi.id, code: $('code').value.trim() }));
    $('code').value = '';
    $('qr').removeAttribute('src');
    $('secret').textContent = '';
    ouvrir();
  } catch (e) {
    $('erreur-code').textContent = e.message;
  } finally {
    bouton.disabled = false;
  }
}

async function fermerSession() {
  if (etat.jeton) {
    fetch(SUPABASE + '/auth/v1/logout', {
      method: 'POST', credentials: 'omit',
      headers: { apikey: CLE, Authorization: 'Bearer ' + etat.jeton },
    }).catch(() => {});
  }
  etat.jeton = etat.rafraichir = etat.limite = null;
  clearTimeout(etat.finSession);
  try { sessionStorage.removeItem('lineup-session'); } catch (e) {}
}

function deconnecter(raison) {
  fermerSession();
  clearTimeout(etat.minuterie);
  $('app').hidden = true;
  $('contenu').replaceChildren();
  $('connexion').hidden = false;
  clearInterval(etat.attente);
  montrer('formulaire-connexion');
  $('erreur-connexion').textContent = raison || '';
}

function reveiller() {
  clearTimeout(etat.minuterie);
  etat.minuterie = setTimeout(() => deconnecter('Déconnecté après 15 minutes d’inactivité.'),
                              INACTIVITE_MS);
}

// --- L'application --------------------------------------------------------
const ONGLETS = [
  ['tableau', 'Vue d’ensemble', vueTableau],
  ['ligues', 'Ligues', vueLigues],
  ['utilisateurs', 'Utilisateurs', vueUtilisateurs],
  ['admins', 'Administrateurs', vueAdmins],
  ['finances', 'Finances', vueFinances],
  ['commission', 'Commission', vueCommission],
  ['jetons', 'Jetons', vueJetons],
  ['regions', 'Régions', vueRegions],
  ['parametres', 'Paramètres', vueParametres],
  ['journal', 'Journal', vueJournal],
  ['photos', 'Photos', vuePhotos],
  ['pro', 'Pro', vueOrganisationsPro],
];

function ouvrir() {
  $('connexion').hidden = true;
  $('app').hidden = false;
  $('qui').replaceChildren(el('span', { classe: 'courriel', title: etat.courriel }, etat.courriel),
    etat.proprietaire ? el('span', { classe: 'pastille proprio' }, 'Propriétaire') : null);
  if (!etat.limite) {
    etat.limite = Date.now() + SESSION_MS;
    garderSession();
  }
  clearTimeout(etat.finSession);
  etat.finSession = setTimeout(() => deconnecter('Session expirée après une heure.'), etat.limite - Date.now());
  reveiller();
  aller('tableau');
}

function aller(onglet, ...args) {
  etat.onglet = onglet;
  etat.args = args;
  dire('');
  // Les vues sans onglet à elles s'allument sous celui de leur parent.
  const parent = { ligue: 'ligues', utilisateur: 'utilisateurs', pro_org: 'pro', lecteurs: 'pro' }[onglet] || onglet;
  $('onglets').replaceChildren(...ONGLETS.map(([cle, titre]) =>
    el('button', { classe: cle === parent ? 'actif' : '', onclick: () => aller(cle) }, titre)));
  return afficher();
}

async function afficher() {
  const vue = { ligue: vueLigue, utilisateur: vueUtilisateur, pro_org: vueOrganisationPro, lecteurs: vueLecteurs }[etat.onglet]
    || ONGLETS.find(([cle]) => cle === etat.onglet)[2];
  try {
    const contenu = await vue(...(etat.args || []));
    $('contenu').replaceChildren(contenu);
  } catch (e) {
    dire(e.message, true);
  }
}

function tableau(entetes, lignes) {
  return el('div', { classe: 'table' }, el('table', {},
    el('thead', {}, el('tr', {}, entetes.map((t) => el('th', {}, t)))),
    el('tbody', {}, lignes)));
}

function recherche(valeur, rappel) {
  const champ = el('input', { type: 'search', placeholder: 'Rechercher', value: valeur || '' });
  const f = el('form', { classe: 'outils', onsubmit: (ev) => { ev.preventDefault(); rappel(champ.value.trim()); } },
    champ, el('button', { type: 'submit' }, 'Chercher'));
  return f;
}

// Confirmation forte : taper le mot demandé.
function confirmer(message, mot) {
  const r = window.prompt(message + '\n\nTape « ' + mot + ' » pour confirmer.');
  return r !== null && r.trim() === mot;
}

async function vueTableau() {
  const t = await rpc('admin_tableau');
  const tuiles = [
    ['comptes', 'Comptes'], ['comptes_semaine', 'Nouveaux (7 jours)'], ['ligues', 'Ligues'],
    ['saisons_actives', 'Saisons actives'], ['equipes', 'Équipes'],
    ['matchs_a_venir', 'Matchs à venir'], ['remplacants_communs', 'Banque générale'],
    ['demandes_ouvertes', 'Demandes ouvertes'], ['administrateurs', 'Administrateurs'],
    ['photos_en_attente', 'Photos à approuver'],
  ];
  return el('section', {}, el('h2', {}, 'Vue d’ensemble'),
    el('div', { classe: 'tuiles' }, tuiles.map(([k, titre]) =>
      el('div', { classe: 'tuile' }, el('b', {}, t[k] ?? 0), el('span', { classe: 'doux' }, titre)))));
}

async function vueLigues(filtre) {
  await chargerRegions();
  const ligues = await rpc('admin_ligues', { p_recherche: filtre || null });
  return el('section', {}, el('h2', {}, 'Ligues (' + ligues.length + ')'),
    recherche(filtre, (v) => aller('ligues', v)),
    tableau(['Nom', 'Région', 'Gérants', 'Joueurs', 'Saisons', 'Équipes', 'Créée'],
      ligues.map((l) => el('tr', { classe: 'cliquable', onclick: () => aller('ligue', l.id) },
        el('td', {}, l.nom), el('td', {}, nomRegion(l.region)), el('td', {}, l.gerants || '—'),
        el('td', {}, l.joueurs), el('td', {}, l.saisons), el('td', {}, l.equipes),
        el('td', {}, date(l.cree_le))))));
}

function nomRegion(code) {
  if (!code) return '—';
  const r = etat.regions.find((x) => x.code === code);
  return r ? r.nom : code;
}

async function chargerRegions() {
  const r = await fetch(SUPABASE + '/rest/v1/regions?select=code,nom,ordre&order=ordre', {
    credentials: 'omit', cache: 'no-store',
    headers: { apikey: CLE, Authorization: 'Bearer ' + etat.jeton },
  });
  etat.regions = r.ok ? await r.json() : [];
}

async function vueLigue(id) {
  await chargerRegions();
  const l = await rpc('admin_ligue', { p_ligue: id });
  const defaut = await rpc('commission_plateforme');
  const nom = el('input', { value: l.nom, required: true });
  const fuseau = el('input', { value: l.fuseau });
  const region = el('select', {}, el('option', { value: '' }, '— Aucune —'),
    etat.regions.map((r) => el('option', { value: r.code, selected: r.code === l.region }, r.nom)));
  const courrielGerant = el('input', { type: 'email', placeholder: 'Courriel du nouveau gérant' });

  return el('section', {},
    el('button', { classe: 'discret', onclick: () => aller('ligues') }, '← Ligues'),
    el('h2', {}, l.nom),
    el('div', { classe: 'fiche' },
      el('div', { classe: 'grille' },
        el('label', {}, 'Nom', nom), el('label', {}, 'Région', region), el('label', {}, 'Fuseau', fuseau)),
      el('div', { classe: 'actions' },
        el('button', { onclick: () => agir('admin_modifier_ligue',
          { p_ligue: id, p_nom: nom.value, p_region: region.value, p_fuseau: fuseau.value },
          'Ligue enregistrée.') }, 'Enregistrer'),
        el('button', { classe: 'danger', onclick: () => {
          if (confirmer('Supprimer la ligue « ' + l.nom + ' » et tout ce qu’elle contient ? '
                        + 'Saisons, équipes, matchs, joueurs : rien ne revient.', 'SUPPRIMER')) {
            agir('admin_supprimer_ligue', { p_ligue: id }, 'Ligue supprimée.', () => aller('ligues'));
          }
        } }, 'Supprimer la ligue')),
      el('p', { classe: 'doux' }, l.joueurs + ' joueur(s) actif(s) · créée le ' + date(l.cree_le))),

    el('h3', {}, 'Gérants'),
    el('div', { classe: 'fiche' },
      el('ul', { classe: 'simple' }, l.gerants.map((g) => el('li', {},
        g.nom || '(sans nom)', ' ', el('span', { classe: 'doux' }, g.courriel), ' ',
        el('button', { classe: 'discret', onclick: () => agir('admin_retirer_gerant',
          { p_ligue: id, p_profil: g.id }, 'Gérant retiré.') }, 'Retirer')))),
      el('form', { classe: 'outils', onsubmit: (ev) => { ev.preventDefault();
        agir('admin_nommer_gerant', { p_ligue: id, p_courriel: courrielGerant.value }, 'Gérant nommé.'); } },
        courrielGerant, el('button', { type: 'submit' }, 'Nommer gérant'))),

    // La carte par défaut ; le manuel, ligue par ligue (Vincent, 7 octobre 2026).
    el('h3', {}, 'Paiements'),
    el('div', { classe: 'fiche' },
      el('p', {}, 'Carte (Stripe) : ', el('strong', {}, l.stripe && l.stripe.paiements_actifs ? 'active'
        : l.stripe ? 'dossier en cours' : 'inactive')),
      el('label', {}, el('input', { type: 'checkbox', checked: !!l.paiement_manuel,
        onchange: (ev) => agir('admin_permettre_paiement_manuel',
          { p_ligue: id, p_permis: ev.target.checked },
          ev.target.checked ? 'Paiement manuel permis.' : 'Paiement manuel retiré.') }),
        ' Paiement manuel permis'),
      el('p', { classe: 'doux' }, 'Comptant et Interac, notés par le gérant. Sans commission.')),

    // Le défaut, ou un tarif négocié avec la ligue : tout administrateur.
    el('h3', {}, 'Commission EspaceLigue'),
    commissionLigue(l, defaut),

    el('h3', {}, 'Jetons'),
    await jetonsLigue(id),

    el('h3', {}, 'Saisons et équipes'),
    l.saisons.length ? l.saisons.map((s) => el('div', { classe: 'fiche' },
      el('strong', {}, s.nom, ' ', el('span', { classe: 'doux' },
        [s.mode, s.debut && ('du ' + s.debut), s.fin && ('au ' + s.fin)].filter(Boolean).join(' · '))),
      s.equipes.length ? el('ul', { classe: 'simple' }, s.equipes.map((e) => el('li', {}, e.nom, ' ',
        el('button', { classe: 'discret', onclick: () => {
          const n = window.prompt('Nouveau nom de l’équipe', e.nom);
          if (n && n.trim()) agir('admin_renommer_equipe', { p_equipe: e.id, p_nom: n }, 'Équipe renommée.');
        } }, 'Renommer'))))
        : el('p', { classe: 'doux' }, 'Aucune équipe.')))
      : el('p', { classe: 'doux' }, 'Aucune saison.'));
}

async function vueUtilisateurs(filtre) {
  const us = await rpc('admin_utilisateurs', { p_recherche: filtre || null, p_limite: 500 });
  return el('section', {}, el('h2', {}, 'Utilisateurs (' + us.length + ')'),
    recherche(filtre, (v) => aller('utilisateurs', v)),
    tableau(['Nom', 'Courriel', 'Téléphone', 'Ligues', 'Inscrit', 'Dernière connexion', ''],
      us.map((u) => el('tr', { classe: 'cliquable', onclick: () => aller('utilisateur', u.id) },
        el('td', {}, nomDe(u)), el('td', {}, u.courriel), el('td', {}, u.telephone || '—'),
        el('td', {}, u.ligues), el('td', {}, date(u.cree_le)),
        el('td', {}, date(u.derniere_connexion, true)),
        el('td', {}, u.proprietaire ? el('span', { classe: 'pastille proprio' }, 'Propriétaire')
          : u.admin ? el('span', { classe: 'pastille' }, 'Admin')
          : u.remplacant_commun ? el('span', { classe: 'pastille' }, 'Banque générale') : '')))));
}

async function vueUtilisateur(id) {
  const u = await rpc('admin_utilisateur', { p_profil: id });
  // Le propriétaire est intouchable, et un administrateur n'agit que sur
  // les comptes ordinaires (la base le refuserait de toute façon).
  const touchable = !u.proprietaire && (!u.admin || etat.proprietaire);
  const prenom = el('input', { value: u.prenom || '', disabled: !touchable });
  const nom = el('input', { value: u.nom || '', disabled: !touchable });
  const tel = el('input', { value: u.telephone || '', disabled: !touchable });

  return el('section', {},
    el('button', { classe: 'discret', onclick: () => aller('utilisateurs') }, '← Utilisateurs'),
    el('h2', {}, nomDe(u), ' ', u.proprietaire ? el('span', { classe: 'pastille proprio' }, 'Propriétaire')
      : u.admin ? el('span', { classe: 'pastille' }, 'Admin') : ''),
    el('div', { classe: 'fiche' },
      el('p', { classe: 'doux' }, u.courriel, ' · inscrit le ', date(u.cree_le),
        ' · dernière connexion ', date(u.derniere_connexion, true)),
      el('div', { classe: 'grille' },
        el('label', {}, 'Prénom', prenom), el('label', {}, 'Nom', nom), el('label', {}, 'Téléphone', tel)),
      touchable ? el('div', { classe: 'actions' },
        el('button', { onclick: () => agir('admin_modifier_utilisateur',
          { p_profil: id, p_prenom: prenom.value, p_nom: nom.value, p_telephone: tel.value },
          'Compte enregistré.') }, 'Enregistrer'),
        el('button', { classe: 'danger', onclick: () => {
          if (confirmer('Supprimer définitivement le compte ' + u.courriel + ' ?', 'SUPPRIMER')) {
            agir('admin_supprimer_utilisateur', { p_profil: id }, 'Compte supprimé.',
                 () => aller('utilisateurs'));
          }
        } }, 'Supprimer le compte'))
        : el('p', { classe: 'doux' }, 'Ce compte est protégé.')),
    el('h3', {}, 'Ligues'),
    el('div', { classe: 'fiche' }, u.roles.length
      ? el('ul', { classe: 'simple' }, u.roles.map((r) => el('li', {},
          el('a', { href: '#', onclick: (ev) => { ev.preventDefault(); aller('ligue', r.ligue_id); } }, r.ligue),
          ' · ', r.role)))
      : el('p', { classe: 'doux' }, 'Aucune ligue.')),
    u.remplacant ? [el('h3', {}, 'Banque générale'), el('div', { classe: 'fiche' },
      el('p', {}, 'Calibre ', u.remplacant.calibre || '—', ' · positions ',
        (u.remplacant.positions || []).join(', ') || '—', ' · régions ',
        (u.remplacant.regions || []).join(', ') || '—', u.remplacant.en_pause ? ' · en pause' : ''))]
      : null);
}

async function vueAdmins() {
  const admins = await rpc('admin_administrateurs');
  const courriel = el('input', { type: 'email', placeholder: 'Courriel du compte à nommer' });
  return el('section', {}, el('h2', {}, 'Administrateurs'),
    tableau(['Nom', 'Courriel', 'Depuis', ''], admins.map((a) => el('tr', {},
      el('td', {}, nomDe(a)), el('td', {}, a.courriel), el('td', {}, date(a.ajoute_le)),
      el('td', {}, a.proprietaire ? el('span', { classe: 'pastille proprio' }, 'Propriétaire')
        : etat.proprietaire ? el('button', { classe: 'discret', onclick: () => {
            if (confirmer('Retirer l’accès de ' + a.courriel + ' ?', 'RETIRER')) {
              agir('admin_retirer_admin', { p_profil: a.id }, 'Accès retiré.');
            }
          } }, 'Retirer') : '')))),
    etat.proprietaire ? el('form', { classe: 'outils', onsubmit: (ev) => { ev.preventDefault();
      agir('admin_ajouter_admin', { p_courriel: courriel.value }, 'Administrateur nommé.'); } },
      courriel, el('button', { type: 'submit' }, 'Donner l’accès'))
      : el('p', { classe: 'doux' }, 'Seul le propriétaire nomme ou retire un administrateur.'));
}

async function vueRegions() {
  await chargerRegions();
  const code = el('input', { placeholder: 'code (ex. montreal)', pattern: '[a-z0-9-]+', required: true });
  const nom = el('input', { placeholder: 'Nom', required: true });
  const ordre = el('input', { type: 'number', value: etat.regions.length + 1 });
  return el('section', {}, el('h2', {}, 'Régions'),
    tableau(['Ordre', 'Nom', 'Code', ''], etat.regions.map((r) => el('tr', {},
      el('td', {}, r.ordre), el('td', {}, r.nom), el('td', { classe: 'doux' }, r.code),
      el('td', {}, el('button', { classe: 'discret', onclick: () => {
        if (confirmer('Retirer la région « ' + r.nom + ' » ?', 'RETIRER')) {
          agir('admin_supprimer_region', { p_code: r.code }, 'Région retirée.');
        }
      } }, 'Retirer'))))),
    el('h3', {}, 'Ajouter ou modifier (même code = modifier)'),
    el('form', { classe: 'outils', onsubmit: (ev) => { ev.preventDefault();
      agir('admin_enregistrer_region', { p_code: code.value.trim(), p_nom: nom.value,
                                          p_ordre: Number(ordre.value) || 0 }, 'Région enregistrée.'); } },
      code, nom, ordre, el('button', { type: 'submit' }, 'Enregistrer')));
}

async function vueParametres() {
  const ps = await rpc('admin_parametres');
  return el('section', {}, el('h2', {}, 'Paramètres du système'),
    tableau(['Paramètre', 'Valeur', 'Modifié', ''], ps.map((p) => {
      const champ = p.genre === 'booleen'
        ? el('select', {}, el('option', { value: 'true', selected: p.valeur === true }, 'Oui'),
                           el('option', { value: 'false', selected: p.valeur === false }, 'Non'))
        : el('input', { type: p.genre === 'entier' ? 'number' : 'text', value: String(p.valeur) });
      const valeur = () => p.genre === 'entier' ? Number(champ.value)
        : p.genre === 'booleen' ? champ.value === 'true' : champ.value;
      return el('tr', {},
        el('td', {}, el('strong', {}, p.cle), el('br'), el('span', { classe: 'doux' }, p.description)),
        el('td', {}, champ), el('td', {}, date(p.modifie_le, true)),
        el('td', {}, el('button', { onclick: () => agir('admin_changer_parametre',
          { p_cle: p.cle, p_valeur: valeur() }, 'Paramètre enregistré.') }, 'Enregistrer')));
    })));
}

// --- Commission (7 octobre 2026) -------------------------------------------
// Ce qu'EspaceLigue retient sur chaque paiement par carte : un pourcentage
// (en centièmes) et un montant fixe (en cents), pris sur ce que reçoit la
// ligue. Tout administrateur la règle.
function surPaiement(c, cents) {
  return Math.min(cents, Math.max(0, Math.round(cents * c.pourcentage / 10000) + c.fixe));
}

function dollarsVersCents(texte) {
  const n = Number(String(texte).replace(',', '.').replace(/[^0-9.]/g, ''));
  return Number.isFinite(n) ? Math.max(0, Math.round(n * 100)) : 0;
}

function texteCommission(c) {
  const pc = (c.pourcentage / 100).toLocaleString('fr-CA', { maximumFractionDigits: 2 }) + ' %';
  if (!c.pourcentage && !c.fixe) return 'aucune';
  if (!c.pourcentage) return argent(c.fixe);
  return c.fixe ? pc + ' + ' + argent(c.fixe) : pc;
}

function commissionLigue(l, defaut) {
  const negociee = l.commission_pourcentage != null && l.commission_fixe != null
    ? { pourcentage: l.commission_pourcentage, fixe: l.commission_fixe } : null;
  const c = negociee || defaut;
  const versTexte = (n) => (n / 100).toLocaleString('fr-CA', { maximumFractionDigits: 2 });
  const fiche = el('div', { classe: 'fiche' },
    el('p', {}, 'En vigueur : ', el('strong', {}, texteCommission(c)), negociee ? ' (négociée)' : ' (défaut)',
      el('span', { classe: 'doux' }, ' · sur 25,00 $ : ' + argent(surPaiement(c, 2500)))));
  const pourcentage = el('input', { inputmode: 'decimal', value: versTexte(c.pourcentage) });
  const fixe = el('input', { inputmode: 'decimal', value: versTexte(c.fixe) });
  fiche.append(
    el('div', { classe: 'grille' },
      el('label', {}, 'Pourcentage (%)', pourcentage), el('label', {}, 'Montant fixe ($)', fixe)),
    el('div', { classe: 'actions' },
      el('button', { onclick: () => {
        const p = dollarsVersCents(pourcentage.value), f = dollarsVersCents(fixe.value);
        if (p > 10000 || f > 10000) { dire('Au plus 100 % et 100 $.', true); return; }
        agir('admin_commission_ligue', { p_ligue: l.id, p_pourcentage: p, p_fixe: f }, 'Tarif négocié appliqué.');
      } }, 'Appliquer ce tarif à la ligue'),
      negociee ? el('button', { classe: 'danger', onclick: () => agir('admin_commission_ligue',
        { p_ligue: l.id, p_pourcentage: null, p_fixe: null }, 'Retour au défaut.') }, 'Revenir au défaut') : null));
  return fiche;
}

async function vueCommission() {
  const c = await rpc('commission_plateforme');
  const versTexte = (n) => (n / 100).toLocaleString('fr-CA', { maximumFractionDigits: 2 });
  const pourcentage = el('input', { inputmode: 'decimal', value: versTexte(c.pourcentage) });
  const fixe = el('input', { inputmode: 'decimal', value: versTexte(c.fixe) });
  const exemple = el('p', { classe: 'doux' });
  const saisie = () => ({ pourcentage: dollarsVersCents(pourcentage.value), fixe: dollarsVersCents(fixe.value) });
  const majExemple = () => {
    exemple.textContent = 'Sur 25,00 $ : ' + argent(surPaiement(saisie(), 2500))
      + ' pour EspaceLigue, pris sur ce que reçoit la ligue.';
  };
  pourcentage.oninput = majExemple;
  fixe.oninput = majExemple;
  majExemple();
  return el('section', {}, el('h2', {}, 'Commission par défaut'),
    el('div', { classe: 'fiche' },
      el('div', { classe: 'grille' },
        el('label', {}, 'Pourcentage (%)', pourcentage), el('label', {}, 'Montant fixe ($)', fixe)),
      exemple,
      el('div', { classe: 'actions' }, el('button', { onclick: async () => {
            const s = saisie();
            if (s.pourcentage > 10000 || s.fixe > 10000) { dire('Au plus 100 % et 100 $.', true); return; }
            try {
              await rpc('admin_changer_parametre', { p_cle: 'commission_pourcentage', p_valeur: s.pourcentage });
              await rpc('admin_changer_parametre', { p_cle: 'commission_fixe', p_valeur: s.fixe });
              dire('Commission enregistrée.');
              await afficher();
            } catch (e) { dire(e.message, true); }
          } }, 'Enregistrer'))));
}

// --- Jetons (31 octobre 2026) ----------------------------------------------
// Ce qu'une recherche dans la banque générale coûte à la ligue. Le solde est
// à la ligue ; seule une recherche confirmée par quelqu'un venu de la banque
// générale est débitée. Pendant de « Administration ▸ Jetons » dans l'app.
const GENRES_JETONS = { remplacant: 'Remplaçant', gardien: 'Gardien', arbitre: 'Arbitre' };
// Les natures du MASTER Plan (page 4).
const NATURES_JETONS = {
  paquet: 'Paquet acheté', forfait: 'Forfait', correction: 'Correction', ajustement: 'Ajustement',
  debit_confirmation: 'Recherche confirmée', transfert: 'Transfert entre ligues',
};

async function vueJetons() {
  const j = await rpc('admin_jetons');
  const tarifs = j.tarifs.map((t) => ({ t, champ: el('input', { inputmode: 'numeric', value: t.jetons }) }));
  const valeur = el('input', { inputmode: 'decimal', value: (j.valeur_cents / 100).toFixed(2).replace('.', ',') });
  const paquetJetons = el('input', { inputmode: 'numeric', placeholder: '100' });
  const paquetPrix = el('input', { inputmode: 'decimal', placeholder: '20,00' });
  return el('section', {}, el('h2', {}, 'Jetons'),
    el('div', { classe: 'fiche' },
      el('label', { classe: 'case' }, el('input', { type: 'checkbox', checked: j.actifs,
        onchange: (ev) => agir('admin_changer_parametre', { p_cle: 'jetons_actifs', p_valeur: ev.target.checked },
          ev.target.checked ? 'Recherches payantes.' : 'Jetons en veille.') }),
        el('strong', {}, 'Activer les jetons'), el('span', { classe: 'doux' }, ' : les recherches dans la banque générale coûtent des jetons')),
      el('div', { classe: 'actions' }, el('label', {}, 'Valeur d’un jeton ($)', valeur),
        el('button', { onclick: () => agir('admin_changer_parametre',
          { p_cle: 'jeton_valeur_cents', p_valeur: dollarsVersCents(valeur.value) }, 'Valeur enregistrée.') }, 'Enregistrer')),
      el('p', {}, 'Encours : ', el('strong', {}, j.encours + ' jetons (' + argent(j.encours * j.valeur_cents) + ')'),
        el('span', { classe: 'doux' }, ' détenus par les ligues'))),

    el('h3', {}, 'Prix en jetons'),
    el('div', { classe: 'fiche' },
      el('div', { classe: 'grille' }, tarifs.map(({ t, champ }) => el('label', {}, GENRES_JETONS[t.genre] || t.genre, champ))),
      el('div', { classe: 'actions' }, el('button', { onclick: async () => {
        try {
          for (const { t, champ } of tarifs) {
            const n = parseInt(champ.value, 10);
            if (Number.isFinite(n) && n !== t.jetons) await rpc('admin_jetons_tarif', { p_genre: t.genre, p_jetons: n });
          }
          dire('Prix enregistrés.');
          await afficher();
        } catch (e) { dire(e.message, true); }
      } }, 'Enregistrer'))),

    el('h3', {}, 'Paquets'),
    el('div', { classe: 'fiche' },
      j.paquets.length ? tableau(['Jetons', 'Prix', 'En vente', ''], j.paquets.map((p) => el('tr', {},
        el('td', {}, p.jetons), el('td', {}, argent(p.prix_cents)), el('td', {}, p.actif ? 'oui' : 'non'),
        el('td', {},
          el('button', { classe: 'discret', onclick: () => agir('admin_jetons_paquet',
            { p_id: p.id, p_jetons: p.jetons, p_prix_cents: p.prix_cents, p_actif: !p.actif, p_ordre: null },
            p.actif ? 'Paquet retiré de la vente.' : 'Paquet remis en vente.') }, p.actif ? 'Retirer' : 'Remettre'),
          el('button', { classe: 'danger', onclick: () => agir('admin_jetons_paquet',
            { p_id: p.id, p_jetons: null, p_prix_cents: null, p_actif: null, p_ordre: null }, 'Paquet effacé.') },
            'Effacer'))))) : el('p', { classe: 'doux' }, 'Aucun paquet.'),
      el('form', { classe: 'outils', onsubmit: (ev) => { ev.preventDefault();
        agir('admin_jetons_paquet', { p_id: null, p_jetons: parseInt(paquetJetons.value, 10) || 0,
          p_prix_cents: dollarsVersCents(paquetPrix.value), p_actif: true, p_ordre: null }, 'Paquet ajouté.'); } },
        el('label', {}, 'Jetons', paquetJetons), el('label', {}, 'Prix ($)', paquetPrix),
        el('button', { type: 'submit' }, 'Ajouter'))),

    el('h3', {}, 'Forfaits'),
    el('div', { classe: 'fiche' },
      j.forfaits.length ? tableau(['Parties', 'Jetons en prime', 'Offert', ''], j.forfaits.map((f) => el('tr', {},
        el('td', {}, f.parties), el('td', {}, '+' + f.jetons), el('td', {}, f.actif ? 'oui' : 'non'),
        el('td', {},
          el('button', { classe: 'discret', onclick: () => agir('admin_jetons_forfait',
            { p_id: f.id, p_parties: f.parties, p_jetons: f.jetons, p_actif: !f.actif },
            f.actif ? 'Forfait retiré.' : 'Forfait remis.') }, f.actif ? 'Retirer' : 'Remettre'),
          el('button', { classe: 'danger', onclick: () => agir('admin_jetons_forfait',
            { p_id: f.id, p_parties: null, p_jetons: null, p_actif: null }, 'Forfait effacé.') }, 'Effacer'))))) :
        el('p', { classe: 'doux' }, 'Aucun forfait.'),
      (() => {
        const parties = el('input', { inputmode: 'numeric', placeholder: '25' });
        const jetons = el('input', { inputmode: 'numeric', placeholder: '10' });
        return el('form', { classe: 'outils', onsubmit: (ev) => { ev.preventDefault();
          agir('admin_jetons_forfait', { p_id: null, p_parties: parseInt(parties.value, 10) || 0,
            p_jetons: parseInt(jetons.value, 10), p_actif: true }, 'Forfait ajouté.'); } },
          el('label', {}, 'Parties', parties), el('label', {}, 'Jetons en prime', jetons),
          el('button', { type: 'submit' }, 'Ajouter'));
      })()),

    j.mois.length ? el('h3', {}, 'Par mois') : null,
    j.mois.length ? tableau(['Mois', 'Achetés', 'Ventes', 'Dépensés', 'Forfaits', 'Ajustés'],
      j.mois.map((m) => el('tr', {}, el('td', {}, m.mois), el('td', {}, m.achetes), el('td', {}, argent(m.ventes_cents)),
        el('td', {}, m.depenses), el('td', {}, m.forfaits), el('td', {}, m.ajustements)))) : null,

    el('h3', {}, 'Soldes des ligues'),
    j.ligues.length ? tableau(['Ligue', 'Solde', 'De côté'], j.ligues.map((l) =>
      el('tr', { classe: 'cliquable', onclick: () => aller('ligue', l.id) },
        el('td', {}, l.nom), el('td', {}, l.total), el('td', {}, l.reserves || '')))) :
      el('p', { classe: 'doux' }, 'Aucune ligue n’a de jetons.'));
}

// Sur la fiche d'une ligue : son solde, son historique, et les gestes (MASTER
// Plan, page 4) : accorder un forfait, ajuster, corriger. Une correction
// renvoie au mouvement qu'elle corrige : son bouton « Corriger » dans la liste.
async function jetonsLigue(id) {
  const [d, j] = await Promise.all([rpc('admin_jetons_ligue', { p_ligue: id }), rpc('admin_jetons')]);
  const forfait = el('select', {}, j.forfaits.filter((f) => f.actif).map((f) =>
    el('option', { value: f.id }, f.parties + ' parties · +' + f.jetons)));
  const geste = el('select', {}, el('option', { value: 'ajustement' }, 'Ajuster'),
    el('option', { value: 'correction' }, 'Corriger'));
  const quantite = el('input', { inputmode: 'numeric', value: '10' });
  const note = el('input', { placeholder: 'Motif (obligatoire)' });
  const cible = el('span', { classe: 'doux' });
  let corrige = null;
  const choisir = (m) => {
    corrige = m.id;
    geste.value = 'correction';
    cible.textContent = 'Corrige : ' + (NATURES_JETONS[m.nature] || m.nature) + ' ' + m.quantite
      + ' (' + date(m.fait_le, true) + ')';
  };
  return el('div', { classe: 'fiche' },
    el('p', {}, 'Solde : ', el('strong', {}, d.total + ' jetons'),
      d.reserves ? el('span', { classe: 'doux' }, ' (' + d.reserves + ' de côté)') : null),
    d.mouvements.length ? tableau(['Quand', 'Mouvement', 'Jetons', 'Par', 'Motif', ''],
      d.mouvements.slice(0, 50).map((m) => el('tr', {}, el('td', {}, date(m.fait_le, true)),
        el('td', {}, NATURES_JETONS[m.nature] || m.nature), el('td', {}, (m.quantite > 0 ? '+' : '') + m.quantite),
        el('td', {}, m.par || ''), el('td', {}, m.note || ''),
        el('td', {}, el('button', { classe: 'discret', onclick: () => choisir(m) }, 'Corriger'))))) : null,
    j.forfaits.some((f) => f.actif) ? el('form', { classe: 'outils', onsubmit: (ev) => { ev.preventDefault();
      agir('admin_jetons_accorder_forfait', { p_ligue: id, p_forfait: forfait.value }, 'Forfait accordé.'); } },
      forfait, el('button', { type: 'submit' }, 'Accorder le forfait')) : null,
    el('form', { classe: 'outils', onsubmit: (ev) => { ev.preventDefault();
      if (geste.value === 'correction' && !corrige) { dire('Choisis le mouvement à corriger.', true); return; }
      agir('admin_jetons_mouvement', { p_ligue: id, p_quantite: parseInt(quantite.value, 10) || 0,
        p_nature: geste.value, p_note: note.value.trim(),
        p_corrige: geste.value === 'correction' ? corrige : null }, 'Jetons : geste appliqué.'); } },
      geste, quantite, note, el('button', { type: 'submit' }, 'Appliquer')),
    cible,
    el('p', { classe: 'doux' }, 'Jamais pour rendre une annulation ou une absence.'));
}

async function vueJournal() {
  const js = await rpc('admin_journal', { p_limite: 300 });
  return el('section', {}, el('h2', {}, 'Journal'),
    tableau(['Quand', 'Qui', 'Action', 'Détail'], js.map((j) => el('tr', {},
      el('td', {}, date(j.fait_le, true)), el('td', {}, j.auteur), el('td', {}, j.action),
      el('td', {}, el('pre', {}, JSON.stringify(j.detail)))))));
}

// --- EspaceLigue Pro : organisations (11 octobre 2026) -------------------------
// Pro est un service vendu : l'équipe crée les organisations, y nomme les
// membres (comptes EspaceLigue existants, par courriel), leurs établissements,
// plateaux et affichages. Fonctions pro.admin_… (exiger_admin, journal).
const TYPES_ORG = [['municipalite', 'Municipalité'], ['enseignement', 'Enseignement'], ['public', 'Organisme public'],
  ['obnl', 'OBNL'], ['prive', 'Centre privé'], ['entreprise', 'Entreprise'], ['autre', 'Autre']];
const TYPES_PLATEAU = [['glace', 'Glace'], ['gymnase', 'Gymnase'], ['terrain', 'Terrain'], ['piscine', 'Piscine'],
  ['salle', 'Salle'], ['autre', 'Autre']];
const ROLES_PRO = [['admin', 'Administrateur'], ['gestionnaire', 'Gestionnaire'], ['prepose', 'Préposé']];
const LANGUES = [['fr', 'Français'], ['en', 'English']];

function sousNavPro(actif) {
  return el('nav', { classe: 'sous-nav' },
    [['pro', 'Organisations'], ['lecteurs', 'Lecteurs']].map(([cle, titre]) =>
      el('button', { type: 'button', classe: cle === actif ? 'actif' : '', onclick: () => aller(cle) }, titre)));
}

function liste(options, choisi) {
  return options.map(([v, t]) => el('option', { value: v, selected: v === choisi }, t));
}

async function vueOrganisationsPro() {
  const orgs = await rpc('pro.admin_organisations');
  const nom = el('input', { placeholder: 'ex. Ville de Blainville', required: true });
  const type = el('select', {}, liste(TYPES_ORG, 'municipalite'));
  const langue = el('select', {}, liste(LANGUES, 'fr'));
  return el('section', {}, sousNavPro('pro'),
    el('div', { classe: 'entete-vue' }, el('h2', {}, 'Organisations Pro'),
      el('span', { classe: 'doux' }, orgs.length ? orgs.length + ' organisation' + (orgs.length > 1 ? 's' : '') : '')),
    orgs.length
      ? tableau(['Organisation', 'Type', 'Membres', 'Établissements', 'Affichages', 'Lecteurs'], orgs.map((o) =>
          el('tr', { classe: 'cliquable', onclick: () => aller('pro_org', o.id) },
            el('td', {}, el('strong', {}, o.nom)), el('td', { classe: 'doux' }, (TYPES_ORG.find(([v]) => v === o.type) || [, o.type])[1]),
            el('td', {}, o.membres), el('td', {}, o.etablissements), el('td', {}, o.affichages), el('td', {}, o.lecteurs))))
      : el('p', { classe: 'doux vide' }, 'Aucune organisation pour l’instant.'),
    el('form', { classe: 'carte-formulaire', onsubmit: async (ev) => {
        ev.preventDefault();
        try {
          const id = await rpc('pro.admin_creer_organisation', { p_nom: nom.value, p_type: type.value, p_langue: langue.value });
          dire('Organisation créée.');
          await aller('pro_org', id);
        } catch (e) { dire(e.message, true); }
      } },
      el('h3', {}, 'Nouvelle organisation'),
      el('div', { classe: 'champs' }, el('label', { classe: 'large' }, 'Nom', nom),
        el('label', {}, 'Type', type), el('label', {}, 'Langue', langue)),
      el('div', { classe: 'pied-formulaire' }, el('span', { classe: 'doux' },
        'Ajoutez ensuite ses membres, un établissement, ses plateaux et ses affichages.'),
        el('button', { type: 'submit' }, 'Créer'))));
}

async function vueOrganisationPro(id) {
  const o = await rpc('pro.admin_organisation', { p_id: id });
  const recharger = () => aller('pro_org', id);
  const nomEtab = (eid) => (o.etablissements.find((e) => e.id === eid) || {}).nom || '';
  const tousPlateaux = o.etablissements.flatMap((e) => e.plateaux.map((p) => ({ ...p, etablissement_id: e.id })));

  // Fiche
  const nom = el('input', { value: o.nom, required: true });
  const type = el('select', {}, liste(TYPES_ORG, o.type));
  const langue = el('select', {}, liste(LANGUES, o.langue));
  const fiche = el('form', { classe: 'carte-formulaire', onsubmit: (ev) => { ev.preventDefault();
      agir('pro.admin_modifier_organisation', { p_id: id, p_nom: nom.value, p_type: type.value, p_langue: langue.value },
        'Organisation enregistrée.'); } },
    el('div', { classe: 'champs' }, el('label', { classe: 'large' }, 'Nom', nom),
      el('label', {}, 'Type', type), el('label', {}, 'Langue', langue)),
    el('div', { classe: 'actions' }, el('button', { type: 'submit' }, 'Enregistrer'),
      el('button', { type: 'button', classe: 'discret', onclick: async () => {
        if (!confirmer('Supprimer « ' + o.nom + ' » et tout ce qu’elle contient (membres, établissements, '
                       + 'réservations, affichages, lecteurs) ?', 'SUPPRIMER')) return;
        try { await rpc('pro.admin_supprimer_organisation', { p_id: id }); dire('Organisation supprimée.'); await aller('pro'); }
        catch (e) { dire(e.message, true); }
      } }, 'Supprimer l’organisation')));

  // Membres
  const courriel = el('input', { type: 'email', placeholder: 'Courriel du compte EspaceLigue', required: true });
  const role = el('select', {}, liste(ROLES_PRO, 'gestionnaire'));
  const membres = el('div', { classe: 'fiche' }, el('h3', {}, 'Membres'),
    o.membres.length ? tableau(['Personne', 'Rôle', ''], o.membres.map((m) => {
      const r = el('select', { onchange: () => agir('pro.admin_changer_role', { p_membre: m.id, p_role: r.value },
        'Rôle changé.', recharger) }, liste(ROLES_PRO, m.role));
      return el('tr', {}, el('td', {}, nomDe(m), el('br'), el('span', { classe: 'doux' }, m.courriel)), el('td', {}, r),
        el('td', {}, el('button', { classe: 'discret', onclick: () => {
          if (confirmer('Retirer ' + m.courriel + ' de l’organisation ?', 'RETIRER')) {
            agir('pro.admin_retirer_membre', { p_membre: m.id }, 'Membre retiré.', recharger);
          }
        } }, 'Retirer')));
    })) : el('p', { classe: 'doux' }, 'Aucun membre. Sans administrateur ni gestionnaire, personne ne peut gérer cette organisation.'),
    el('form', { classe: 'outils', onsubmit: (ev) => { ev.preventDefault();
        agir('pro.admin_ajouter_membre', { p_organisation: id, p_courriel: courriel.value, p_role: role.value },
          'Membre ajouté.', recharger); } },
      courriel, role, el('button', { type: 'submit' }, 'Ajouter')),
    el('p', { classe: 'doux' }, 'Le compte doit déjà exister dans EspaceLigue (app ou site). L’administrateur gère tout ; '
      + 'le gestionnaire, l’horaire et les lecteurs ; le préposé ne fait que consulter.'));

  // Établissements et plateaux
  const etablissements = el('div', { classe: 'fiche' }, el('h3', {}, 'Établissements et plateaux'),
    o.etablissements.map((e) => {
      const en = el('input', { value: e.nom, required: true });
      const ea = el('input', { value: e.adresse || '', placeholder: 'Adresse' });
      const pn = el('input', { placeholder: 'ex. Glace 2', required: true });
      const pt = el('select', {}, liste(TYPES_PLATEAU, 'glace'));
      return el('div', { classe: 'sous-fiche' },
        el('form', { classe: 'outils', onsubmit: (ev) => { ev.preventDefault();
            agir('pro.admin_enregistrer_etablissement', { p_organisation: id, p_id: e.id, p_nom: en.value, p_adresse: ea.value,
              p_fuseau: e.fuseau }, 'Établissement enregistré.', recharger); } },
          en, ea, el('button', { type: 'submit' }, 'Enregistrer'),
          el('button', { type: 'button', classe: 'discret', onclick: () => {
            if (confirmer('Supprimer « ' + e.nom + ' », ses plateaux et leurs réservations ?', 'SUPPRIMER')) {
              agir('pro.admin_supprimer_element', { p_genre: 'etablissement', p_id: e.id }, 'Établissement supprimé.', recharger);
            }
          } }, 'Supprimer')),
        e.plateaux.length ? tableau(['Plateau', 'Type', 'Actif', ''], e.plateaux.map((p) => {
          const n = el('input', { value: p.nom });
          const t = el('select', {}, liste(TYPES_PLATEAU, p.type));
          const a = el('input', { type: 'checkbox', checked: p.actif });
          return el('tr', {}, el('td', {}, n), el('td', {}, t), el('td', {}, a),
            el('td', { classe: 'boutons' },
              el('button', { onclick: () => agir('pro.admin_enregistrer_plateau', { p_organisation: id, p_etablissement: e.id,
                p_id: p.id, p_nom: n.value, p_type: t.value, p_actif: a.checked }, 'Plateau enregistré.', recharger) }, 'Enregistrer'),
              el('button', { classe: 'discret', onclick: () => {
                if (confirmer('Supprimer le plateau « ' + p.nom + ' » et ses réservations ?', 'SUPPRIMER')) {
                  agir('pro.admin_supprimer_element', { p_genre: 'plateau', p_id: p.id }, 'Plateau supprimé.', recharger);
                }
              } }, 'Supprimer')));
        })) : el('p', { classe: 'doux' }, 'Aucun plateau.'),
        el('form', { classe: 'outils', onsubmit: (ev) => { ev.preventDefault();
            agir('pro.admin_enregistrer_plateau', { p_organisation: id, p_etablissement: e.id, p_id: null, p_nom: pn.value,
              p_type: pt.value, p_actif: true }, 'Plateau ajouté.', recharger); } },
          pn, pt, el('button', { type: 'submit' }, 'Ajouter un plateau')));
    }),
    (() => {
      const n = el('input', { placeholder: 'ex. Aréna Blainville', required: true });
      const a = el('input', { placeholder: 'Adresse (facultatif)' });
      return el('form', { classe: 'outils', onsubmit: (ev) => { ev.preventDefault();
          agir('pro.admin_enregistrer_etablissement', { p_organisation: id, p_id: null, p_nom: n.value, p_adresse: a.value,
            p_fuseau: 'America/Toronto' }, 'Établissement ajouté.', recharger); } },
        n, a, el('button', { type: 'submit' }, 'Ajouter un établissement'));
    })());

  // Affichages : des playlists. Le plateau d'un horaire se choisit dans le
  // panneau (page de gestion) ; l'affichage ne garde que son établissement.
  const portee = (etab) => el('select', {}, o.etablissements.map((e) =>
    el('option', { value: e.id + '|', selected: e.id === etab }, e.nom)));
  const decoupe = (v) => { const [e, p] = v.split('|'); return { p_etablissement: e, p_plateau: p || null }; };
  const affichages = el('div', { classe: 'fiche' }, el('h3', {}, 'Affichages'),
    !o.etablissements.length ? el('p', { classe: 'doux' }, 'Ajoutez d’abord un établissement.') : [
      o.affichages.length ? tableau(['Nom', 'Établissement', 'Langue', ''], o.affichages.map((a) => {
        const n = el('input', { value: a.nom });
        const po = portee(a.etablissement_id);
        const la = el('select', {}, liste(LANGUES, a.langue));
        return el('tr', {}, el('td', {}, n), el('td', {}, po), el('td', {}, la),
          el('td', { classe: 'boutons' },
            el('button', { onclick: () => agir('pro.admin_enregistrer_affichage', Object.assign({ p_organisation: id, p_id: a.id,
              p_nom: n.value, p_langue: la.value }, decoupe(po.value)), 'Affichage enregistré.', recharger) }, 'Enregistrer'),
            el('a', { href: a.url, target: '_blank', rel: 'noopener', classe: 'bouton discret' }, 'Ouvrir ↗'),
            el('button', { classe: 'discret', onclick: () => {
              if (confirmer('Supprimer l’affichage « ' + a.nom + ' » ? Ses lecteurs passeront « sans affichage ».', 'SUPPRIMER')) {
                agir('pro.admin_supprimer_element', { p_genre: 'affichage', p_id: a.id }, 'Affichage supprimé.', recharger);
              }
            } }, 'Supprimer')));
      })) : el('p', { classe: 'doux' }, 'Aucun affichage.'),
      (() => {
        const n = el('input', { placeholder: 'ex. Hall d’entrée', required: true });
        const po = portee(o.etablissements[0].id);
        const la = el('select', {}, liste(LANGUES, o.langue));
        return el('form', { classe: 'outils', onsubmit: (ev) => { ev.preventDefault();
            agir('pro.admin_enregistrer_affichage', Object.assign({ p_organisation: id, p_id: null, p_nom: n.value,
              p_langue: la.value }, decoupe(po.value)), 'Affichage ajouté.', recharger); } },
          n, po, la, el('button', { type: 'submit' }, 'Ajouter un affichage'));
      })()]);

  // Lecteurs
  const nomAff = (aid) => (o.affichages.find((a) => a.id === aid) || {}).nom;
  const lecteurs = el('div', { classe: 'fiche' }, el('h3', {}, 'Lecteurs'),
    o.lecteurs.length ? tableau(['Lecteur', 'Affichage', 'État'], o.lecteurs.map((l) => el('tr', {},
      el('td', {}, l.nom || 'Sans nom', el('br'), el('code', { classe: 'doux' }, l.serie)),
      el('td', {}, nomAff(l.affichage_id) || el('span', { classe: 'doux' }, '—')),
      el('td', {}, l.statut === 'revoque' ? 'Révoqué' : enLigne(l) ? el('span', { classe: 'vert' }, '● En ligne')
        : el('span', { classe: 'doux' }, l.dernier_contact ? 'vu le ' + date(l.dernier_contact, true) : 'jamais branché')))))
      : el('p', { classe: 'doux' }, 'Aucun lecteur.'),
    el('div', { classe: 'actions' }, el('button', { classe: 'discret', onclick: () => aller('lecteurs') }, 'Gérer les lecteurs')));

  return el('section', { classe: 'vue-pro' }, sousNavPro('pro'),
    el('p', {}, el('button', { classe: 'discret', onclick: () => aller('pro') }, '← Organisations')),
    el('h2', {}, o.nom), fiche, membres, etablissements, affichages, lecteurs);
}

// --- Lecteurs EspacePlayer (11 octobre 2026) ---------------------------------
// Les boîtiers Raspberry Pi du forfait Affichage d'EspaceLigue Pro. On inscrit
// le numéro de série que le Pi montre au premier démarrage ; la base tire une
// clé, rendue une seule fois, qu'on dépose sur la carte SD dans
// espaceplayer.json. Le Pi rappelle le serveur chaque minute : un contact de
// moins de 3 minutes veut dire qu'il est en ligne.
function fichierCle(r) {
  const contenu = JSON.stringify({ cle: r.cle }, null, 2) + '\n';
  const url = URL.createObjectURL(new Blob([contenu], { type: 'application/json' }));
  return el('div', { classe: 'fiche cle-rendue' },
    el('h3', {}, 'Lecteur ', el('code', {}, r.serie), ' inscrit'),
    el('p', { classe: 'doux' }, 'Cette clé ne sera plus jamais affichée. Copiez le fichier à la racine de la '
      + 'partition « bootfs » de la carte SD, puis redémarrez le Pi.'),
    el('div', { classe: 'actions' },
      el('a', { href: url, download: 'espaceplayer.json', classe: 'bouton' }, 'Télécharger espaceplayer.json')),
    el('details', {}, el('summary', { classe: 'doux' }, 'Voir la clé'), el('code', {}, r.cle)));
}

function choixAffichage(orgs, organisation, choisi) {
  const o = orgs.find((x) => x.id === organisation);
  return [el('option', { value: '' }, o && o.affichages.length ? '— aucun pour l’instant —' : '— aucun affichage —'),
    ...(o ? o.affichages : []).map((a) => el('option', { value: a.id, selected: a.id === choisi },
      a.etablissement + ' · ' + a.nom))];
}

function champ(titre, controle) {
  return el('label', {}, titre, controle);
}

const enLigne = (l) => l.dernier_contact && Date.now() - new Date(l.dernier_contact) < 3 * 60 * 1000;

const ORDRES = { mettre_a_jour: 'Mettre à jour maintenant', redemarrer_ecran: 'Redémarrer l’écran',
                 redemarrer: 'Redémarrer le Pi', origine: 'Revenir à la version de l’image' };

function carteLecteur(l, orgs, logiciels) {
  const affichage = el('select', {}, choixAffichage(orgs, l.organisation_id, l.affichage_id));
  const nom = el('input', { value: l.nom || '', placeholder: 'ex. Hall d’entrée' });
  const statut = el('select', {}, el('option', { value: 'actif', selected: l.statut === 'actif' }, 'Actif'),
                                  el('option', { value: 'revoque', selected: l.statut === 'revoque' }, 'Révoqué'));
  const pastille = l.statut === 'revoque' ? el('span', { classe: 'pastille rouge-fond' }, 'Révoqué')
    : !l.affichage_id ? el('span', { classe: 'pastille ambre-fond' }, 'Sans affichage')
    : el('span', { classe: 'pastille vert-fond' }, 'Actif');
  const ecran = el('select', {}, el('option', { value: '1080p', selected: l.ecran !== '4k' }, '1080p, 60 Hz'),
                                 el('option', { value: '4k', selected: l.ecran === '4k' }, '4K, 60 Hz'));
  const fps = el('input', { type: 'checkbox', checked: l.fps });
  const courante = logiciels.find((g) => g.courante);
  const logiciel = el('select', {},
    el('option', { value: '' }, 'La courante' + (courante ? ' (' + courante.version + ')' : '')),
    logiciels.map((g) => el('option', { value: g.version, selected: g.version === l.logiciel_vise }, g.version)));
  const ordre = el('select', {}, el('option', { value: '' }, '— ordre —'),
    Object.entries(ORDRES).map(([cle, titre]) => el('option', { value: cle }, titre)));
  return el('form', { classe: 'carte-formulaire lecteur', onsubmit: async (ev) => {
      ev.preventDefault();
      try {
        await rpc('pro.admin_modifier_lecteur', { p_id: l.id, p_affichage: affichage.value || null,
          p_nom: nom.value, p_statut: statut.value });
        await agir('pro.admin_regler_lecteur', { p_id: l.id, p_ecran: ecran.value, p_fps: fps.checked,
          p_logiciel: logiciel.value || null }, 'Lecteur enregistré.');
      } catch (e) { dire(e.message, true); }
    } },
    el('div', { classe: 'tete-lecteur' },
      el('div', {}, el('strong', {}, l.nom || 'Lecteur sans nom'), ' ', pastille,
        el('div', { classe: 'doux' }, l.organisation, ' · ', el('code', {}, l.serie))),
      el('div', { classe: 'doux droite' }, enLigne(l) ? el('span', { classe: 'vert' }, '● En ligne')
        : ['Dernier contact', el('br'), l.dernier_contact ? date(l.dernier_contact, true) : 'jamais'])),
    el('div', { classe: 'champs' }, champ('Nom', nom), champ('Affichage', affichage), champ('Statut', statut)),
    el('div', { classe: 'champs' }, champ('Écran', ecran), champ('Logiciel', logiciel),
      el('label', { classe: 'case' }, fps, 'Compteur d’images')),
    el('div', { classe: 'doux versions' }, 'Logiciel ', l.version_logiciel || '—', ' · image ', l.version_image || '—',
      l.ordre ? [' · ', el('span', { classe: 'ambre' }, 'En attente : ' + ORDRES[l.ordre])] : null),
    el('div', { classe: 'actions' },
      el('button', { type: 'submit' }, 'Enregistrer'),
      ordre,
      el('button', { type: 'button', classe: 'discret', onclick: () => {
        if (!ordre.value) return;
        if (ordre.value === 'redemarrer' && !confirmer('Redémarrer le Pi ' + l.serie + ' ? L’écran sera noir une minute.', 'OUI')) return;
        agir('pro.admin_ordonner_lecteur', { p_id: l.id, p_ordre: ordre.value }, 'Ordre envoyé : exécuté d’ici une minute.');
      } }, 'Envoyer'),
      el('button', { type: 'button', classe: 'discret', onclick: async () => {
        if (!confirmer('Nouvelle clé pour ' + l.serie + ' ? L’ancienne cesse aussitôt de fonctionner : '
                       + 'il faudra refaire la carte SD.', 'CLÉ')) return;
        try {
          const r = await rpc('pro.admin_inscrire_lecteur', { p_serie: l.serie, p_organisation: l.organisation_id,
            p_affichage: l.affichage_id, p_nom: l.nom });
          dire('Nouvelle clé tirée.');
          await aller('lecteurs', r);
        } catch (e) { dire(e.message, true); }
      } }, 'Nouvelle clé'),
      el('button', { type: 'button', classe: 'discret', onclick: () => {
        if (confirmer('Retirer le lecteur ' + l.serie + ' pour de bon ?', 'RETIRER')) {
          agir('pro.admin_supprimer_lecteur', { p_id: l.id }, 'Lecteur retiré.');
        }
      } }, 'Retirer')));
}

// Logiciel des lecteurs : paquets signés (EspacePlayer/tools/paquet.py)
// déposés dans le seau public « espaceplayer ». Chaque lecteur vérifie la
// signature : un fichier modifié est refusé. La version courante est tirée la
// nuit par tous les lecteurs sans version visée.
async function televerserPaquet(fichier) {
  const m = /^espaceplayer-(\d+(?:\.\d+)*)\.paquet$/.exec(fichier.name);
  if (!m) throw new Error('Nom attendu : espaceplayer-<version>.paquet (tel que fabriqué par tools/paquet.py).');
  const entete = new TextDecoder().decode(await fichier.slice(0, 21).arrayBuffer());
  if (entete !== 'ESPACEPLAYER-PAQUET 1') throw new Error('Ce fichier n’est pas un paquet EspacePlayer.');
  const chemin = m[1] + '/' + fichier.name;
  const r = await fetch(SUPABASE + '/storage/v1/object/espaceplayer/' + chemin, {
    method: 'POST', credentials: 'omit',
    headers: { apikey: CLE, Authorization: 'Bearer ' + etat.jeton, 'Content-Type': 'application/octet-stream',
               'x-upsert': 'true' },
    body: fichier,
  });
  if (!r.ok) throw new Error('Téléversement refusé (' + r.status + ').');
  await rpc('pro.admin_publier_logiciel', { p_version: m[1], p_chemin: chemin, p_courante: false });
  return m[1];
}

function ficheLogiciel(logiciels) {
  const fichier = el('input', { type: 'file', accept: '.paquet', onchange: async () => {
    if (!fichier.files[0]) return;
    try {
      const v = await televerserPaquet(fichier.files[0]);
      dire('Version ' + v + ' téléversée. Visez-la pour un lecteur, ou rendez-la courante.');
      await afficher();
    } catch (e) { dire(e.message, true); }
  } });
  return el('div', { classe: 'fiche logiciel' },
    el('h3', {}, 'Logiciel des lecteurs'),
    logiciels.length ? tableau(['Version', 'Publiée', ''], logiciels.map((g) => el('tr', {},
      el('td', {}, el('code', {}, g.version)), el('td', {}, date(g.publie_le, true)),
      el('td', { classe: 'droite' }, g.courante ? el('span', { classe: 'pastille vert-fond' }, 'Courante')
        : el('button', { classe: 'discret', onclick: () => {
            if (confirmer('Rendre courante la version ' + g.version + ' ? Tous les lecteurs sans version visée '
                          + 'la tireront cette nuit.', 'OUI')) {
              agir('pro.admin_logiciel_courant', { p_version: g.version }, 'Version ' + g.version + ' courante.');
            }
          } }, 'Rendre courante')))))
      : el('p', { classe: 'doux' }, 'Aucune version téléversée : les lecteurs gardent celle de leur image.'),
    el('label', { classe: 'bouton discret' }, 'Téléverser un paquet…', fichier));
}

async function vueLecteurs(cleRendue) {
  const [lecteurs, orgs, logiciels] = await Promise.all([rpc('pro.admin_lecteurs'), rpc('pro.admin_affichages'),
                                                        rpc('pro.admin_logiciels')]);
  etat.args = [];  // la clé ne se montre qu'une fois, pas au prochain rechargement de la vue

  const serie = el('input', { placeholder: 'ex. 10000000abcdef01', required: true,
                              pattern: '[0-9a-fA-F]{8,16}', autocomplete: 'off', spellcheck: 'false' });
  const organisation = el('select', { required: true },
    el('option', { value: '' }, orgs.length ? '— choisir —' : '— aucune organisation —'),
    orgs.map((o) => el('option', { value: o.id }, o.nom)));
  const affichage = el('select', { disabled: true }, choixAffichage(orgs, ''));
  organisation.addEventListener('change', () => {
    affichage.replaceChildren(...choixAffichage(orgs, organisation.value));
    affichage.disabled = !organisation.value;
  });
  const nom = el('input', { placeholder: 'ex. Hall d’entrée' });

  const formulaire = el('form', { classe: 'carte-formulaire', onsubmit: async (ev) => {
      ev.preventDefault();
      try {
        const r = await rpc('pro.admin_inscrire_lecteur', { p_serie: serie.value, p_organisation: organisation.value,
          p_affichage: affichage.value || null, p_nom: nom.value });
        dire('Lecteur inscrit.');
        await aller('lecteurs', r);
      } catch (e) { dire(e.message, true); }
    } },
    el('h3', {}, 'Inscrire un lecteur'),
    el('div', { classe: 'champs' },
      el('label', { classe: 'large' }, 'Numéro de série', serie),
      champ('Organisation', organisation), champ('Affichage', affichage),
      el('label', { classe: 'large' }, 'Nom (facultatif)', nom)),
    el('div', { classe: 'pied-formulaire' },
      el('span', { classe: 'doux' }, 'Réinscrire un numéro existant tire une nouvelle clé.'),
      el('button', { type: 'submit' }, 'Inscrire et tirer la clé')));

  const etapes = el('div', { classe: 'fiche etapes' },
    el('h3', {}, 'Préparer un lecteur'),
    el('ol', {},
      el('li', {}, 'Démarrez le Pi sur une télé : son numéro de série s’affiche en bas à droite.'),
      el('li', {}, 'Inscrivez-le ici ; la page fait télécharger ', el('code', {}, 'espaceplayer.json'), '.'),
      el('li', {}, 'Copiez ce fichier sur la carte SD (partition « bootfs ») et redémarrez.'),
      el('li', {}, 'L’affichage de l’aréna apparaît. Changer d’affichage plus tard se fait ici, sans toucher au Pi.')));

  return el('section', { classe: 'vue-lecteurs' },
    sousNavPro('lecteurs'),
    el('div', { classe: 'entete-vue' }, el('h2', {}, 'Lecteurs EspacePlayer'),
      el('span', { classe: 'doux' }, lecteurs.length ? lecteurs.length + ' inscrit' + (lecteurs.length > 1 ? 's' : '') : '')),
    cleRendue ? fichierCle(cleRendue) : null,
    el('div', { classe: 'deux-colonnes' }, formulaire, etapes),
    ficheLogiciel(logiciels),
    el('h3', {}, 'Lecteurs inscrits'),
    lecteurs.length ? el('div', { classe: 'liste-lecteurs' }, lecteurs.map((l) => carteLecteur(l, orgs, logiciels)))
      : el('p', { classe: 'doux vide' }, 'Aucun lecteur pour l’instant. Le premier inscrit apparaîtra ici.'));
}

// --- Photos à approuver (4 octobre 2026) ----------------------------------
// La file des photos des cartes de joueur, traitée en lot. Le dossier
// `photos` n'est pas public : chaque image se lit avec le jeton, puis
// s'affiche par une adresse `blob:` (permise par la CSP).
async function imagePhoto(chemin) {
  const img = el('img', { classe: 'photo', alt: '' });
  try {
    const r = await fetch(SUPABASE + '/storage/v1/object/authenticated/photos/' + chemin, {
      credentials: 'omit', cache: 'no-store', headers: { apikey: CLE, Authorization: 'Bearer ' + etat.jeton },
    });
    if (r.ok) img.src = URL.createObjectURL(await r.blob());
  } catch (e) { /* l'image manque : la rangée reste, sans elle */ }
  return img;
}

async function effacerPhoto(chemin) {
  await fetch(SUPABASE + '/storage/v1/object/photos/' + chemin, {
    method: 'DELETE', credentials: 'omit', headers: { apikey: CLE, Authorization: 'Bearer ' + etat.jeton },
  }).catch(() => {});
}

// Approuvée : l'ancienne photo du joueur s'efface ; refusée : celle-ci.
async function moderer(p, approuver) {
  try {
    const aEffacer = await rpc('moderer_photo', { p_profil: p.profil_id, p_approuver: approuver });
    if (aEffacer) await effacerPhoto(aEffacer);
    dire(approuver ? 'Photo approuvée.' : 'Photo refusée.');
    await afficher();
  } catch (e) {
    dire(e.message, true);
  }
}

async function vuePhotos() {
  const ps = await rpc('admin_photos_en_attente');
  const images = await Promise.all(ps.map((p) => imagePhoto(p.chemin)));
  return el('section', {}, el('h2', {}, 'Photos à approuver (' + ps.length + ')'),
    ps.length === 0 ? el('p', { classe: 'doux' }, 'Aucune photo à approuver.') :
    el('div', { classe: 'photos' }, ps.map((p, i) => el('div', { classe: 'tuile' },
      images[i],
      el('b', {}, [p.prenom, p.nom].filter(Boolean).join(' ')),
      el('span', { classe: 'doux' }, date(p.soumise_le, true)),
      el('div', { classe: 'outils' },
        el('button', { classe: 'discret', onclick: () => moderer(p, false) }, 'Refuser'),
        el('button', { onclick: () => moderer(p, true) }, 'Approuver'))))));
}

// --- Finances (2 octobre 2026) -------------------------------------------
// Deux volets, comme dans les apps : l'entreprise EspaceLigue (revenus et dépenses
// saisis, en catégories gérées) et l'argent des ligues. Les graphiques sont du
// SVG dessiné ici : aucun script tiers (CSP).
const SVG = 'http://www.w3.org/2000/svg';
function svg(balise, attrs, ...enfants) {
  const n = document.createElementNS(SVG, balise);
  for (const [k, v] of Object.entries(attrs || {})) n.setAttribute(k, v);
  for (const e of enfants.flat()) if (e) n.append(e instanceof Node ? e : document.createTextNode(String(e)));
  return n;
}

const PERIODES = [['mois', 'Ce mois'], ['trimestre', '3 mois'], ['annee', 'Cette année'], ['douze', '12 mois']];
const PALETTE = ['#22C55E', '#14B8A6', '#84CC16', '#3B82F6', '#A855F7', '#F59E0B', '#EC4899', '#EF4444', '#06B6D4', '#94A3B8'];
const argent = (c) => (c / 100).toLocaleString('fr-CA', { style: 'currency', currency: 'CAD' });
const jourIso = (d) => d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');

function bornes(periode) {
  const a = new Date(); const ce = new Date(a.getFullYear(), a.getMonth(), 1);
  const finMois = new Date(a.getFullYear(), a.getMonth() + 1, 0);
  if (periode === 'mois') return [ce, finMois];
  if (periode === 'trimestre') return [new Date(a.getFullYear(), a.getMonth() - 2, 1), finMois];
  if (periode === 'annee') return [new Date(a.getFullYear(), 0, 1), new Date(a.getFullYear(), 11, 31)];
  return [new Date(a.getFullYear(), a.getMonth() - 11, 1), finMois];
}

function moisEntre(debut, fin) {
  const ms = []; const d = new Date(debut.getFullYear(), debut.getMonth(), 1);
  while (d <= fin) { ms.push(d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0')); d.setMonth(d.getMonth() + 1); }
  return ms;
}

const compact = (c) => (c / 100).toLocaleString('fr-CA', { style: 'currency', currency: 'CAD', notation: 'compact', maximumFractionDigits: 1 });
const nomMois = (m) => { const [an, mm] = m.split('-'); return new Date(an, mm - 1, 1).toLocaleDateString('fr-CA', { month: 'short' }); };

// Barres groupées par mois, sur un axe gradué ; `series` : [{ nom, couleur, valeurs: [cents par mois] }].
function graphiqueBarres(mois, series) {
  const L = 720, H = 200, gauche = 56, bas = 26, haut = 10;
  const brut = Math.max(0, ...series.flatMap((s) => s.valeurs));
  const pas = brut ? Math.pow(10, Math.floor(Math.log10(brut / 4))) * [1, 2, 2.5, 5, 10].find((f) => brut / 4 <= f * Math.pow(10, Math.floor(Math.log10(brut / 4)))) : 0;
  const max = pas ? pas * 4 : 1;
  const zone = L - gauche, hz = H - bas - haut;
  const groupe = zone / Math.max(1, mois.length), barre = Math.min(18, (groupe * 0.62) / series.length);
  const g = svg('svg', { viewBox: '0 0 ' + L + ' ' + H, class: 'graphique', role: 'img' });
  for (let k = 0; k <= 4; k++) {
    const y = haut + hz - hz * k / 4;
    g.append(svg('line', { x1: gauche, x2: L, y1: y, y2: y, class: k ? 'grille' : 'axe' }));
    if (pas) g.append(svg('text', { x: gauche - 8, y: y + 4, 'text-anchor': 'end', class: 'etiquette' }, compact(pas * k * 1)));
  }
  mois.forEach((m, i) => {
    const centre = gauche + i * groupe + groupe / 2, depart = centre - (barre * series.length) / 2;
    series.forEach((s, k) => {
      const h = hz * s.valeurs[i] / max;
      if (h > 0) g.append(svg('rect', { x: depart + k * barre + 1, y: haut + hz - h, width: barre - 2, height: h, fill: s.couleur, rx: 3 },
        svg('title', {}, s.nom + ' · ' + nomMois(m) + ' · ' + argent(s.valeurs[i]))));
    });
    if (mois.length <= 6 || i % 2 === 0 || mois.length <= 12) g.append(svg('text', { x: centre, y: H - 8, 'text-anchor': 'middle', class: 'etiquette' }, nomMois(m)));
  });
  return el('div', { classe: 'panneau' },
    el('div', { classe: 'panneau-tete' }, el('h3', {}, 'Par mois'), legende(series.map((s) => [s.nom, s.couleur]))),
    brut ? g : el('p', { classe: 'vide-graphe doux' }, 'Rien à montrer pour cette période.'));
}

// Un anneau ; `parts` : [[nom, couleur, cents]].
function graphiqueAnneau(titre, parts) {
  const total = parts.reduce((t, p) => t + p[2], 0) || 1;
  const r = 70, c = 2 * Math.PI * r;
  const g = svg('svg', { viewBox: '0 0 200 200', class: 'anneau', role: 'img' });
  g.append(svg('circle', { cx: 100, cy: 100, r, fill: 'none', class: 'fond-anneau', 'stroke-width': 22 }));
  let decalage = 0;
  for (const [nom, couleur, cents] of parts) {
    const long = c * cents / total;
    g.append(svg('circle', { cx: 100, cy: 100, r, fill: 'none', stroke: couleur, 'stroke-width': 22,
                             'stroke-dasharray': Math.max(0, long - 2) + ' ' + c, 'stroke-dashoffset': -decalage,
                             transform: 'rotate(-90 100 100)' }, svg('title', {}, nom + ' · ' + argent(cents))));
    decalage += long;
  }
  g.append(svg('text', { x: 100, y: 106, 'text-anchor': 'middle', class: 'centre-anneau' }, compact(total)));
  return el('div', { classe: 'panneau' }, el('div', { classe: 'panneau-tete' }, el('h3', {}, titre)),
    el('div', { classe: 'graphe-anneau' }, g,
      el('ul', { classe: 'parts' }, parts.map(([nom, couleur, cents]) =>
        el('li', {}, pastille(couleur), el('span', {}, nom),
          el('span', { classe: 'doux part' }, Math.round(100 * cents / total) + ' %'), el('b', {}, argent(cents)))))));
}

function pastille(couleur) {
  return svg('svg', { viewBox: '0 0 10 10', class: 'point' }, svg('circle', { cx: 5, cy: 5, r: 5, fill: couleur }));
}
function legende(elements) {
  return el('div', { classe: 'legende' }, elements.map(([t, c]) => el('span', {}, pastille(c), t)));
}

// Un indicateur : libellé, montant, précision.
function indicateur(libelle, valeur, sous, classe) {
  return el('div', { classe: 'indicateur' }, el('span', { classe: 'libelle' }, libelle),
    el('b', { classe: classe || '' }, valeur), sous ? el('span', { classe: 'sous' }, sous) : null);
}

function segments(options, choisi, rappel) {
  return el('div', { classe: 'segments', role: 'tablist' }, options.map(([k, t]) =>
    el('button', { type: 'button', role: 'tab', classe: k === choisi ? 'actif' : '', 'aria-selected': k === choisi ? 'true' : 'false',
      onclick: () => rappel(k) }, t)));
}

const VOLETS = [['apercu', 'Aperçu'], ['transactions', 'Transactions'], ['jetons', 'Jetons'], ['ligues', 'Ligues'], ['categories', 'Catégories']];

async function vueFinances() {
  const f0 = etat.finances;
  if (!VOLETS.some(([k]) => k === f0.volet)) f0.volet = 'apercu';
  const [debut, fin] = bornes(f0.periode);
  const mois = moisEntre(debut, fin);
  const periode = el('select', { classe: 'periode', 'aria-label': 'Période', onchange: (ev) => { f0.periode = ev.target.value; afficher(); } },
    PERIODES.map(([k, t]) => el('option', { value: k, selected: f0.periode === k }, t)));
  const etendue = el('span', { classe: 'doux etendue' }, date(jourIso(debut) + 'T12:00:00') + ' – ' + date(jourIso(fin) + 'T12:00:00'));
  let f = null;
  if (f0.volet !== 'jetons') f = await rpc('admin_finances', { p_debut: jourIso(debut), p_fin: jourIso(fin) });
  const nouvelle = f && (f0.volet === 'apercu' || f0.volet === 'transactions')
    ? el('button', { type: 'button', onclick: () => dialogueEcriture(f.categories) }, '+ Nouvelle transaction') : null;
  const tete = el('div', { classe: 'tete-finances' },
    el('div', {}, el('h2', {}, 'Finances'), etendue),
    el('div', { classe: 'actions' }, periode, nouvelle));
  const onglets = segments(VOLETS, f0.volet, (k) => { f0.volet = k; afficher(); });
  let corps;
  if (f0.volet === 'jetons') corps = await financesJetons(debut, fin, mois);
  else if (f0.volet === 'ligues') corps = financesLigues(f.ligues);
  else if (f0.volet === 'categories') corps = vueCategories(f.categories);
  else corps = financesEspaceLigue(f, mois, f0.volet);
  return el('section', { classe: 'finances' }, tete, onglets, corps);
}

function financesEspaceLigue(f, mois, volet) {
  const categorie = (id) => f.categories.find((c) => c.id === id);
  const visibles = f.ecritures.filter((e) => !(categorie(e.categorie_id) || {}).masquee);
  const total = (s) => visibles.filter((e) => e.sens === s).reduce((t, e) => t + e.montant_cents, 0);
  const revenus = total('revenu'), depenses = total('depense'), net = revenus - depenses;
  if (volet === 'transactions') return transactions(f, categorie);
  const parCategorie = (sens) => {
    const m = new Map();
    for (const e of visibles.filter((x) => x.sens === sens)) m.set(e.categorie_id, (m.get(e.categorie_id) || 0) + e.montant_cents);
    return [...m].map(([id, cents]) => { const c = categorie(id);
      return [c ? c.nom : 'Sans catégorie', c ? c.couleur : '#94A3B8', cents]; }).sort((a, b) => b[2] - a[2]);
  };
  const parMois = (sens) => mois.map((m) => visibles.filter((e) => e.sens === sens && e.jour.startsWith(m))
    .reduce((t, e) => t + e.montant_cents, 0));
  const nb = (s) => visibles.filter((e) => e.sens === s).length;
  const recentes = f.ecritures.slice(0, 5);
  return el('div', { classe: 'grille-finances' },
    el('div', { classe: 'indicateurs' },
      indicateur('Revenus', argent(revenus), nb('revenu') + ' transaction' + (nb('revenu') > 1 ? 's' : ''), 'vert'),
      indicateur('Dépenses', argent(depenses), nb('depense') + ' transaction' + (nb('depense') > 1 ? 's' : '')),
      indicateur('Résultat net', argent(net), revenus ? 'Marge ' + Math.round(100 * net / revenus) + ' %' : null, net < 0 ? 'rouge' : ''),
      indicateur('Dépenses moyennes', argent(Math.round(depenses / Math.max(1, mois.length))), 'Par mois')),
    graphiqueBarres(mois, [{ nom: 'Revenus', couleur: '#22C55E', valeurs: parMois('revenu') },
                           { nom: 'Dépenses', couleur: '#F87171', valeurs: parMois('depense') }]),
    el('div', { classe: 'deux-colonnes' },
      [['revenu', 'Revenus par catégorie'], ['depense', 'Dépenses par catégorie']].map(([s, t]) => {
        const parts = parCategorie(s);
        return parts.length ? graphiqueAnneau(t, parts)
          : el('div', { classe: 'panneau' }, el('div', { classe: 'panneau-tete' }, el('h3', {}, t)),
              el('p', { classe: 'vide-graphe doux' }, 'Aucune transaction.'));
      })),
    el('div', { classe: 'panneau' },
      el('div', { classe: 'panneau-tete' }, el('h3', {}, 'Dernières transactions'),
        f.ecritures.length > 5 ? el('button', { classe: 'lien', onclick: () => { etat.finances.volet = 'transactions'; afficher(); } }, 'Tout voir') : null),
      recentes.length ? tableEcritures(recentes, categorie, false) : etatVide(f.categories)));
}

function etatVide(categories) {
  return el('div', { classe: 'etat-vide' }, el('p', {}, 'Aucune transaction sur cette période.'),
    el('button', { type: 'button', onclick: () => dialogueEcriture(categories) }, '+ Nouvelle transaction'));
}

function tableEcritures(liste, categorie, avecActions) {
  return el('div', { classe: 'table' }, el('table', { classe: 'registre' },
    el('thead', {}, el('tr', {}, el('th', {}, 'Date'), el('th', {}, 'Description'), el('th', { classe: 'col-cat' }, 'Catégorie'),
      el('th', { classe: 'chiffre' }, 'Montant'), avecActions ? el('th', {}) : null)),
    el('tbody', {}, liste.map((e) => {
      const c = categorie(e.categorie_id);
      return el('tr', {},
        el('td', { classe: 'date' }, date(e.jour + 'T12:00:00')),
        el('td', {}, e.note || el('span', { classe: 'doux' }, e.sens === 'revenu' ? 'Revenu' : 'Dépense'),
          e.recurrence === 'mensuelle' ? el('span', { classe: 'etiquette-mini' }, 'Mensuel') : null,
          el('span', { classe: 'cat-mobile' }, pastille(c ? c.couleur : '#94A3B8'), c ? c.nom : 'Sans catégorie')),
        el('td', { classe: 'col-cat' }, el('span', { classe: 'puce' }, pastille(c ? c.couleur : '#94A3B8'), c ? c.nom : 'Sans catégorie')),
        el('td', { classe: 'chiffre ' + (e.sens === 'revenu' ? 'vert' : '') }, (e.sens === 'revenu' ? '' : '−') + argent(e.montant_cents)),
        avecActions ? el('td', { classe: 'geste' }, el('button', { classe: 'icone', title: 'Supprimer', 'aria-label': 'Supprimer', onclick: () => {
          if (confirmer('Supprimer cette transaction' + (e.recurrence === 'mensuelle' ? ' et tous ses mois' : '') + ' ?', 'SUPPRIMER')) {
            agir('admin_supprimer_ecriture', { p_id: e.id }, 'Transaction supprimée.');
          }
        } }, '×')) : null);
    }))));
}

function transactions(f, categorie) {
  const filtre = { sens: 'tous', texte: '' };
  const zone = el('div');
  const champ = el('input', { type: 'search', placeholder: 'Rechercher une description ou une catégorie' });
  const rendre = () => {
    const t = filtre.texte.toLowerCase();
    const liste = f.ecritures.filter((e) => (filtre.sens === 'tous' || e.sens === filtre.sens)
      && (!t || (e.note || '').toLowerCase().includes(t) || ((categorie(e.categorie_id) || {}).nom || '').toLowerCase().includes(t)));
    const somme = liste.reduce((s, e) => s + (e.sens === 'revenu' ? e.montant_cents : -e.montant_cents), 0);
    zone.replaceChildren(...[].concat(liste.length
      ? [tableEcritures(liste, categorie, true),
         el('div', { classe: 'pied-registre' }, el('span', { classe: 'doux' }, liste.length + ' transaction' + (liste.length > 1 ? 's' : '')),
           el('b', { classe: somme < 0 ? 'rouge' : 'vert' }, 'Net ' + argent(somme)))]
      : f.ecritures.length ? el('p', { classe: 'vide-graphe doux' }, 'Aucune transaction ne correspond.') : etatVide(f.categories)));
  };
  champ.addEventListener('input', () => { filtre.texte = champ.value.trim(); rendre(); });
  const sens = segments([['tous', 'Toutes'], ['revenu', 'Revenus'], ['depense', 'Dépenses']], 'tous', (k) => {
    filtre.sens = k; sens.querySelectorAll('button').forEach((b, i) => b.className = ['tous', 'revenu', 'depense'][i] === k ? 'actif' : '');
    rendre();
  });
  sens.classList.add('petits');
  rendre();
  return el('div', { classe: 'panneau' }, el('div', { classe: 'barre-filtres' }, champ, sens), zone);
}

// La fenêtre de saisie : le sens d'abord, puis le montant, comme une caisse.
function dialogueEcriture(categories) {
  let sensChoisi = 'depense';
  const cat = el('select', {});
  const remplir = () => cat.replaceChildren(el('option', { value: '' }, 'Sans catégorie'),
    ...categories.filter((c) => c.sens === sensChoisi).map((c) => el('option', { value: c.id }, c.nom)));
  const sens = segments([['depense', 'Dépense'], ['revenu', 'Revenu']], sensChoisi, (k) => {
    sensChoisi = k; sens.querySelectorAll('button').forEach((b, i) => b.className = ['depense', 'revenu'][i] === k ? 'actif' : '');
    remplir();
  });
  remplir();
  const montant = el('input', { inputmode: 'decimal', placeholder: '0,00', required: true, classe: 'montant', autocomplete: 'off' });
  const jour = el('input', { type: 'date', value: jourIso(new Date()), required: true });
  const note = el('input', { placeholder: 'Ex. : hébergement Supabase' });
  const mensuelle = el('input', { type: 'checkbox' });
  const finSerie = el('input', { type: 'date' });
  const champFin = el('label', { hidden: true }, 'Jusqu’au (facultatif)', finSerie);
  mensuelle.addEventListener('change', () => { champFin.hidden = !mensuelle.checked; });
  const d = el('dialog', { classe: 'dialogue' });
  const fermer = () => { d.close(); d.remove(); };
  d.append(el('form', { onsubmit: (ev) => {
    ev.preventDefault();
    const cents = dollarsVersCents(montant.value);
    if (!(cents > 0)) { montant.focus(); dire('Le montant n’est pas valide.', true); return; }
    fermer();
    agir('admin_enregistrer_ecriture', { p_id: null, p_jour: jour.value, p_sens: sensChoisi, p_montant_cents: cents,
      p_categorie: cat.value || null, p_note: note.value.trim(), p_recurrence: mensuelle.checked ? 'mensuelle' : 'aucune',
      p_fin: mensuelle.checked && finSerie.value ? finSerie.value : null }, 'Transaction enregistrée.');
  } },
    el('div', { classe: 'dialogue-tete' }, el('h3', {}, 'Nouvelle transaction'),
      el('button', { type: 'button', classe: 'icone', 'aria-label': 'Fermer', onclick: fermer }, '×')),
    sens,
    el('label', {}, 'Montant', el('div', { classe: 'champ-montant' }, montant, el('span', {}, '$'))),
    el('div', { classe: 'deux' }, el('label', {}, 'Date', jour), el('label', {}, 'Catégorie', cat)),
    el('label', {}, 'Description', note),
    el('label', { classe: 'case' }, mensuelle, 'Revient chaque mois'), champFin,
    el('div', { classe: 'dialogue-pied' }, el('button', { type: 'button', classe: 'discret', onclick: fermer }, 'Annuler'),
      el('button', { type: 'submit' }, 'Enregistrer'))));
  d.addEventListener('cancel', (ev) => { ev.preventDefault(); fermer(); });
  document.body.append(d);
  d.showModal();
  montant.focus();
}

function financesLigues(l) {
  const methodes = { carte: 'Carte', debit_preautorise: 'Prélèvement', interac: 'Interac', comptant: 'Comptant' };
  const total = l.paye_cents + l.du_cents;
  return el('div', { classe: 'grille-finances' },
    el('div', { classe: 'indicateurs' },
      indicateur('Encaissé', argent(l.paye_cents), 'Par les ligues', 'vert'),
      indicateur('À recevoir', argent(l.du_cents), 'Soldes ouverts', l.du_cents ? 'ambre' : ''),
      indicateur('Taux de recouvrement', total ? Math.round(100 * l.paye_cents / total) + ' %' : '—', null)),
    graphiqueBarres(l.par_mois.map((m) => m.mois), [
      { nom: 'Encaissé', couleur: '#22C55E', valeurs: l.par_mois.map((m) => m.paye_cents) },
      { nom: 'À recevoir', couleur: '#F59E0B', valeurs: l.par_mois.map((m) => m.du_cents) }]),
    l.par_methode.length ? graphiqueAnneau('Encaissements par méthode', l.par_methode.map((m, i) =>
      [methodes[m.methode] || 'Autre', PALETTE[(i + 3) % PALETTE.length], m.cents])) : null,
    el('div', { classe: 'panneau' }, el('div', { classe: 'panneau-tete' }, el('h3', {}, 'Par ligue')),
      l.par_ligue.length ? el('div', { classe: 'table' }, el('table', { classe: 'registre' },
        el('thead', {}, el('tr', {}, el('th', {}, 'Ligue'), el('th', { classe: 'chiffre' }, 'Encaissé'), el('th', { classe: 'chiffre' }, 'À recevoir'))),
        el('tbody', {}, l.par_ligue.map((x) => el('tr', {}, el('td', {}, x.ligue),
          el('td', { classe: 'chiffre' }, argent(x.paye_cents)),
          el('td', { classe: 'chiffre ' + (x.du_cents ? 'ambre' : 'doux') }, argent(x.du_cents)))))))
        : el('p', { classe: 'vide-graphe doux' }, 'Aucun paiement sur la période.')));
}

// Finances ▸ Jetons : l'argent encaissé contre le service rendu. L'encours
// (jetons détenus) est dû aux ligues ; il devient gagné quand ils se dépensent.
async function financesJetons(debut, fin, mois) {
  const j = await rpc('admin_finances_jetons', { p_debut: jourIso(debut), p_fin: jourIso(fin) });
  const t = j.totaux, v = j.valeur_cents;
  const duMois = (m, cle) => (j.par_mois.find((x) => x.mois === m) || {})[cle] || 0;
  const signe = (n) => (n > 0 ? '+' : n < 0 ? '−' : '') + Math.abs(n);
  const exporter = () => {
    const cellule = (x) => '"' + String(x == null ? '' : x).replace(/"/g, '""') + '"';
    const lignes = [['Date', 'Ligue', 'Mouvement', 'Recherche', 'Jetons', 'Montant ($)', 'Référence', 'Par', 'Motif']]
      .concat(j.mouvements.map((m) => [m.fait_le.slice(0, 19).replace('T', ' '), m.ligue, NATURES_JETONS[m.nature] || m.nature,
        GENRES_JETONS[m.genre] || '', m.quantite, m.prix_cents == null ? '' : (m.prix_cents / 100).toFixed(2).replace('.', ','),
        m.reference, m.par, m.note]));
    const csv = '﻿' + lignes.map((l) => l.map(cellule).join(';')).join('\r\n');
    const a = el('a', { href: URL.createObjectURL(new Blob([csv], { type: 'text/csv' })),
      download: 'jetons-' + jourIso(debut) + '-au-' + jourIso(fin) + '.csv' });
    document.body.append(a); a.click(); a.remove();
  };
  const ligneRappro = (titre, n, fort) => el('tr', { classe: fort ? 'fort' : '' }, el('td', {}, titre),
    el('td', { classe: 'chiffre' }, fort ? n : signe(n)), el('td', { classe: 'chiffre' }, argent(n * v)));
  return el('div', { classe: 'grille-finances' },
    el('div', { classe: 'indicateurs' },
      indicateur('Ventes nettes', argent(t.ventes_cents - t.rembourses_cents),
        t.vendus + ' jetons vendus' + (t.rembourses_cents ? ' · ' + argent(t.rembourses_cents) + ' remboursés' : ''), 'vert'),
      indicateur('Revenu gagné', argent(t.consommes * v), t.consommes + ' jetons dépensés'),
      indicateur('Encours dû', argent(j.encours_fin * v), j.encours_fin + ' jetons détenus', 'ambre'),
      indicateur('Offerts', argent(t.offerts * v), t.offerts + ' jetons en prime')),
    graphiqueBarres(mois, [
      { nom: 'Ventes', couleur: '#22C55E', valeurs: mois.map((m) => duMois(m, 'ventes_cents')) },
      { nom: 'Gagné', couleur: '#3B82F6', valeurs: mois.map((m) => duMois(m, 'consommes') * v) },
      { nom: 'Offerts', couleur: '#A855F7', valeurs: mois.map((m) => duMois(m, 'offerts') * v) }]),
    el('div', { classe: 'deux-colonnes' },
      el('div', { classe: 'panneau' }, el('div', { classe: 'panneau-tete' }, el('h3', {}, 'Rapprochement de l’encours'),
        el('span', { classe: 'doux' }, '1 jeton = ' + argent(v))),
        el('table', { classe: 'registre' },
          el('thead', {}, el('tr', {}, el('th', {}), el('th', { classe: 'chiffre' }, 'Jetons'), el('th', { classe: 'chiffre' }, 'Valeur'))),
          el('tbody', {},
            ligneRappro('Solde d’ouverture', j.encours_debut, true),
            ligneRappro('Vendus', t.vendus), ligneRappro('Offerts', t.offerts),
            ligneRappro('Dépensés', -t.consommes), ligneRappro('Retirés', -t.retires),
            ligneRappro('Corrections', t.corriges),
            ligneRappro('Solde de clôture', j.encours_fin, true)))),
      el('div', { classe: 'panneau' }, el('div', { classe: 'panneau-tete' }, el('h3', {}, 'Par ligue')),
        j.par_ligue.length ? el('div', { classe: 'table' }, el('table', { classe: 'registre' },
          el('thead', {}, el('tr', {}, el('th', {}, 'Ligue'), el('th', { classe: 'chiffre' }, 'Ventes'),
            el('th', { classe: 'chiffre' }, 'Dépensés'), el('th', { classe: 'chiffre' }, 'Solde'))),
          el('tbody', {}, j.par_ligue.map((l) => el('tr', l.ligue_id ? { classe: 'cliquable', onclick: () => aller('ligue', l.ligue_id) } : {},
            el('td', {}, l.ligue || 'Ligue effacée'), el('td', { classe: 'chiffre' }, argent(l.ventes_cents)),
            el('td', { classe: 'chiffre' }, l.consommes), el('td', { classe: 'chiffre' }, l.ligue_id ? l.solde : '—'))))))
          : el('p', { classe: 'vide-graphe doux' }, 'Aucun mouvement sur la période.'))),
    el('div', { classe: 'panneau' },
      el('div', { classe: 'panneau-tete' }, el('h3', {}, 'Mouvements'),
        j.mouvements.length ? el('button', { classe: 'discret', onclick: exporter }, 'Exporter en CSV') : null),
      j.mouvements.length ? el('div', { classe: 'table' }, el('table', { classe: 'registre' },
        el('thead', {}, el('tr', {}, el('th', {}, 'Date'), el('th', {}, 'Ligue'), el('th', {}, 'Mouvement'),
          el('th', { classe: 'chiffre' }, 'Jetons'), el('th', { classe: 'chiffre' }, 'Montant'))),
        el('tbody', {}, j.mouvements.slice(0, 200).map((m) => el('tr', { title: [m.par, m.note].filter(Boolean).join(' · ') },
          el('td', { classe: 'date' }, date(m.fait_le, true)), el('td', {}, m.ligue),
          el('td', {}, NATURES_JETONS[m.nature] || m.nature, m.genre ? el('span', { classe: 'doux' }, ' · ' + GENRES_JETONS[m.genre]) : null),
          el('td', { classe: 'chiffre ' + (m.quantite > 0 ? 'vert' : '') }, signe(m.quantite)),
          el('td', { classe: 'chiffre' }, m.prix_cents == null ? '' : argent(m.prix_cents)))))))
        : el('p', { classe: 'vide-graphe doux' }, 'Aucun mouvement sur la période.')));
}

// Les catégories : nom modifiable sur place, couleur en pastilles, visibilité
// dans les graphiques. Tout s'enregistre au changement.
function vueCategories(categories) {
  const sauver = (c, champs, message) => agir('admin_enregistrer_categorie', Object.assign({ p_id: c.id, p_nom: c.nom,
    p_sens: c.sens, p_couleur: c.couleur, p_ordre: c.ordre, p_masquee: c.masquee }, champs), message);
  // La couleur passe par le CSSOM : la CSP refuse les attributs style.
  const nuancier = (choisie, rappel) => el('div', { classe: 'nuancier' }, PALETTE.map((p) => {
    const b = el('button', { type: 'button', classe: 'nuance' + (p === choisie ? ' choisie' : ''), 'aria-label': p,
      onclick: () => rappel(p) });
    b.style.setProperty('--c', p);
    return b;
  }));
  const ligne = (c) => {
    const nom = el('input', { value: c.nom, classe: 'sur-place', 'aria-label': 'Nom' });
    nom.addEventListener('change', () => nom.value.trim() && sauver(c, { p_nom: nom.value.trim() }, 'Catégorie renommée.'));
    const visible = el('input', { type: 'checkbox', checked: !c.masquee });
    visible.addEventListener('change', () => sauver(c, { p_masquee: !visible.checked }, visible.checked ? 'Montrée dans les graphiques.' : 'Cachée des graphiques.'));
    const ligneEl = el('li', { classe: 'categorie' },
      el('button', { type: 'button', classe: 'puce-couleur', title: 'Changer la couleur', 'aria-label': 'Changer la couleur',
        onclick: () => ligneEl.classList.toggle('ouvert') }, pastille(c.couleur)), nom,
      nuancier(c.couleur, (p) => sauver(c, { p_couleur: p }, 'Couleur changée.')),
      el('label', { classe: 'interrupteur', title: 'Dans les graphiques' }, visible, el('span', {})),
      el('button', { classe: 'icone', title: 'Supprimer', 'aria-label': 'Supprimer', onclick: () => {
        if (confirmer('Supprimer « ' + c.nom + ' » ? Ses transactions restent, sans catégorie.', 'SUPPRIMER')) {
          agir('admin_supprimer_categorie', { p_id: c.id }, 'Catégorie supprimée.');
        }
      } }, '×'));
    return ligneEl;
  };
  const bloc = (sens, titre) => {
    const nom = el('input', { placeholder: 'Nouvelle catégorie', required: true });
    let couleur = PALETTE[0];
    const choix = nuancier(couleur, (p) => { couleur = p; choix.querySelectorAll('.nuance').forEach((b) =>
      b.classList.toggle('choisie', b.getAttribute('aria-label') === p)); });
    return el('div', { classe: 'panneau' },
      el('div', { classe: 'panneau-tete' }, el('h3', {}, titre), el('span', { classe: 'doux' }, 'Graphiques')),
      el('ul', { classe: 'categories' }, categories.filter((c) => c.sens === sens).map(ligne)),
      el('form', { classe: 'ajout-categorie', onsubmit: (ev) => { ev.preventDefault();
        agir('admin_enregistrer_categorie', { p_id: null, p_nom: nom.value.trim(), p_sens: sens, p_couleur: couleur,
          p_ordre: 99, p_masquee: false }, 'Catégorie ajoutée.'); } },
        nom, choix, el('button', { type: 'submit' }, 'Ajouter')));
  };
  return el('div', { classe: 'deux-colonnes' }, bloc('depense', 'Dépenses'), bloc('revenu', 'Revenus'));
}

// --- Thème clair ou foncé ------------------------------------------------
// Une préférence d'affichage, gardée dans ce navigateur : rien de sensible.
// Sans choix, la page suit le système.
function themeChoisi() {
  try { const t = localStorage.getItem('theme'); if (t === 'light' || t === 'dark') return t; } catch (e) { /* bloqué */ }
  return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
}
function poserTheme(t) {
  document.documentElement.setAttribute('data-theme', t);
  for (const id of ['theme', 'theme-connexion']) {
    const b = $(id);
    if (!b) continue;
    // Le mot se cache sur téléphone ; l'icône et l'aria-label restent.
    b.replaceChildren(t === 'light' ? '☾' : '☀︎', el('span', { classe: 'libelle' }, t === 'light' ? ' Foncé' : ' Clair'));
    b.setAttribute('aria-label', t === 'light' ? 'Passer au thème foncé' : 'Passer au thème clair');
  }
}
function basculerTheme() {
  const t = document.documentElement.getAttribute('data-theme') === 'light' ? 'dark' : 'light';
  try { localStorage.setItem('theme', t); } catch (e) { /* bloqué */ }
  poserTheme(t);
}
poserTheme(themeChoisi());

// --- Démarrage ------------------------------------------------------------
document.addEventListener('DOMContentLoaded', () => {
  $('theme').addEventListener('click', basculerTheme);
  $('theme-connexion').addEventListener('click', basculerTheme);
  $('connexion').hidden = false;
  $('formulaire-connexion').addEventListener('submit', connecter);
  $('apple').addEventListener('click', continuerAvecApple);
  retourApple();
  reprendreSession();
  $('deconnexion').addEventListener('click', () => deconnecter(''));
  $('formulaire-code').addEventListener('submit', validerCode);
  $('annuler-code').addEventListener('click', () => deconnecter(''));
  $('reessayer').addEventListener('click', demanderApprobation);
  $('utiliser-code').addEventListener('click', () => preparerCode().catch((e) => {
    $('etat-approbation').textContent = e.message;
  }));
  $('annuler-approbation').addEventListener('click', () => deconnecter(''));
  for (const ev of ['click', 'keydown']) document.addEventListener(ev, () => etat.jeton && reveiller());
});
