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

if (window.top !== window.self) {
  document.documentElement.textContent = '';
  throw new Error('cadre refusé');
}

const etat = { attente: null, facteur: null, jeton: null, rafraichir: null, expire: 0, courriel: '', proprietaire: false,
               onglet: 'tableau', minuterie: null, regions: [],
               finances: { periode: 'douze', volet: 'lineup' } };

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
}

async function rpc(nom, params) {
  if (Date.now() > etat.expire) {
    poserJetons(await auth('token?grant_type=refresh_token', { refresh_token: etat.rafraichir }));
  }
  const r = await fetch(SUPABASE + '/rest/v1/rpc/' + nom, {
    method: 'POST', credentials: 'omit', cache: 'no-store',
    headers: { apikey: CLE, Authorization: 'Bearer ' + etat.jeton,
               'Content-Type': 'application/json' },
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
// Apple ne rend la main qu'en rechargeant la page : le vérificateur PKCE est le
// seul secret posé dans le navigateur (sessionStorage), lu une fois puis effacé.
// Le jeton, lui, reste en mémoire comme pour le courriel.
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
  etat.jeton = etat.rafraichir = null;
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
  ['regions', 'Régions', vueRegions],
  ['parametres', 'Paramètres', vueParametres],
  ['journal', 'Journal', vueJournal],
  ['photos', 'Photos', vuePhotos],
];

function ouvrir() {
  $('connexion').hidden = true;
  $('app').hidden = false;
  $('qui').replaceChildren(el('span', { classe: 'courriel', title: etat.courriel }, etat.courriel),
    etat.proprietaire ? el('span', { classe: 'pastille proprio' }, 'Propriétaire') : null);
  reveiller();
  aller('tableau');
}

function aller(onglet, ...args) {
  etat.onglet = onglet;
  etat.args = args;
  dire('');
  $('onglets').replaceChildren(...ONGLETS.map(([cle, titre]) =>
    el('button', { classe: cle === onglet ? 'actif' : '', onclick: () => aller(cle) }, titre)));
  return afficher();
}

async function afficher() {
  const vue = { ligue: vueLigue, utilisateur: vueUtilisateur }[etat.onglet]
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
    ['matchs_a_venir', 'Matchs à venir'], ['remplacants_communs', 'Banque commune'],
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
          : u.remplacant_commun ? el('span', { classe: 'pastille' }, 'Banque commune') : '')))));
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
    u.remplacant ? [el('h3', {}, 'Banque commune'), el('div', { classe: 'fiche' },
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

async function vueJournal() {
  const js = await rpc('admin_journal', { p_limite: 300 });
  return el('section', {}, el('h2', {}, 'Journal'),
    tableau(['Quand', 'Qui', 'Action', 'Détail'], js.map((j) => el('tr', {},
      el('td', {}, date(j.fait_le, true)), el('td', {}, j.auteur), el('td', {}, j.action),
      el('td', {}, el('pre', {}, JSON.stringify(j.detail)))))));
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

// Barres groupées par mois ; `series` : [{ nom, couleur, valeurs: [cents par mois] }].
function graphiqueBarres(mois, series) {
  const L = 640, H = 220, bas = 24;
  const max = Math.max(1, ...series.flatMap((s) => s.valeurs));
  const groupe = L / Math.max(1, mois.length), barre = (groupe * 0.7) / series.length;
  const g = svg('svg', { viewBox: '0 0 ' + L + ' ' + H, class: 'graphique', role: 'img' });
  mois.forEach((m, i) => {
    series.forEach((s, k) => {
      const h = (H - bas - 8) * s.valeurs[i] / max;
      g.append(svg('rect', { x: i * groupe + groupe * 0.15 + k * barre, y: H - bas - h, width: barre * 0.9,
                             height: h, fill: s.couleur, rx: 2 },
                   svg('title', {}, s.nom + ' · ' + m + ' · ' + argent(s.valeurs[i]))));
    });
    if (mois.length <= 6 || i % 2 === 0) {
      const [an, mm] = m.split('-');
      g.append(svg('text', { x: i * groupe + groupe / 2, y: H - 6, 'text-anchor': 'middle', fill: '#9fb0cc', 'font-size': 12 },
        new Date(an, mm - 1, 1).toLocaleDateString('fr-CA', { month: 'short' })));
    }
  });
  return el('div', {}, g, legende(series.map((s) => [s.nom, s.couleur])));
}

// Un anneau ; `parts` : [[nom, couleur, cents]].
function graphiqueAnneau(parts) {
  const total = parts.reduce((t, p) => t + p[2], 0) || 1;
  const r = 70, c = 2 * Math.PI * r;
  const g = svg('svg', { viewBox: '0 0 200 200', class: 'anneau', role: 'img' });
  let decalage = 0;
  for (const [nom, couleur, cents] of parts) {
    const long = c * cents / total;
    g.append(svg('circle', { cx: 100, cy: 100, r, fill: 'none', stroke: couleur, 'stroke-width': 28,
                             'stroke-dasharray': Math.max(0, long - 2) + ' ' + c, 'stroke-dashoffset': -decalage,
                             transform: 'rotate(-90 100 100)' },
                 svg('title', {}, nom + ' · ' + argent(cents))));
    decalage += long;
  }
  return el('div', { classe: 'graphe-anneau' }, g,
    el('ul', { classe: 'parts' }, parts.map(([nom, couleur, cents]) =>
      el('li', {}, pastille(couleur), el('span', {}, nom), el('b', {}, argent(cents))))));
}

function pastille(couleur) {
  return svg('svg', { viewBox: '0 0 10 10', class: 'point' }, svg('circle', { cx: 5, cy: 5, r: 5, fill: couleur }));
}
function legende(elements) {
  return el('div', { classe: 'legende' }, elements.map(([t, c]) => el('span', {}, pastille(c), t)));
}

async function vueFinances() {
  const f0 = etat.finances;
  const [debut, fin] = bornes(f0.periode);
  const f = await rpc('admin_finances', { p_debut: jourIso(debut), p_fin: jourIso(fin) });
  const categorie = (id) => f.categories.find((c) => c.id === id);
  const visibles = f.ecritures.filter((e) => !(categorie(e.categorie_id) || {}).masquee);
  const mois = moisEntre(debut, fin);
  const choix = el('div', { classe: 'outils' },
    el('select', { onchange: (ev) => { f0.volet = ev.target.value; afficher(); } },
      el('option', { value: 'lineup', selected: f0.volet === 'lineup' }, 'EspaceLigue'),
      el('option', { value: 'ligues', selected: f0.volet === 'ligues' }, 'Ligues')),
    el('select', { onchange: (ev) => { f0.periode = ev.target.value; afficher(); } },
      PERIODES.map(([k, t]) => el('option', { value: k, selected: f0.periode === k }, t))));

  if (f0.volet === 'ligues') {
    const l = f.ligues;
    return el('section', {}, el('h2', {}, 'Finances · Ligues'), choix,
      el('div', { classe: 'tuiles' },
        el('div', { classe: 'tuile' }, el('b', { classe: 'vert' }, argent(l.paye_cents)), el('span', { classe: 'doux' }, 'Payé')),
        el('div', { classe: 'tuile' }, el('b', { classe: 'ambre' }, argent(l.du_cents)), el('span', { classe: 'doux' }, 'À payer'))),
      el('h3', {}, 'Par mois'),
      graphiqueBarres(l.par_mois.map((m) => m.mois), [
        { nom: 'Payé', couleur: '#35c07a', valeurs: l.par_mois.map((m) => m.paye_cents) },
        { nom: 'À payer', couleur: '#f5b642', valeurs: l.par_mois.map((m) => m.du_cents) }]),
      l.par_methode.length ? [el('h3', {}, 'Paiements par méthode'),
        graphiqueAnneau(l.par_methode.map((m, i) => [({ carte: 'Carte', debit_preautorise: 'Prélèvement', interac: 'Interac',
          comptant: 'Comptant' })[m.methode] || 'Autre', PALETTE[(i + 3) % PALETTE.length], m.cents]))] : null,
      el('h3', {}, 'Par ligue'),
      tableau(['Ligue', 'Payé', 'À payer'], l.par_ligue.map((x) => el('tr', {},
        el('td', {}, x.ligue), el('td', {}, argent(x.paye_cents)), el('td', {}, argent(x.du_cents))))));
  }

  const total = (s) => visibles.filter((e) => e.sens === s).reduce((t, e) => t + e.montant_cents, 0);
  const revenus = total('revenu'), depenses = total('depense');
  const parCategorie = (sens) => {
    const m = new Map();
    for (const e of visibles.filter((x) => x.sens === sens)) m.set(e.categorie_id, (m.get(e.categorie_id) || 0) + e.montant_cents);
    return [...m].map(([id, cents]) => { const c = categorie(id);
      return [c ? c.nom : 'Sans catégorie', c ? c.couleur : '#94A3B8', cents]; }).sort((a, b) => b[2] - a[2]);
  };
  const parMois = (sens) => mois.map((m) => visibles.filter((e) => e.sens === sens && e.jour.startsWith(m))
    .reduce((t, e) => t + e.montant_cents, 0));
  return el('section', {}, el('h2', {}, 'Finances · EspaceLigue'), choix,
    el('div', { classe: 'tuiles' },
      el('div', { classe: 'tuile' }, el('b', { classe: 'vert' }, argent(revenus)), el('span', { classe: 'doux' }, 'Revenus')),
      el('div', { classe: 'tuile' }, el('b', { classe: 'rouge' }, argent(depenses)), el('span', { classe: 'doux' }, 'Dépenses')),
      el('div', { classe: 'tuile' }, el('b', { classe: revenus >= depenses ? '' : 'rouge' }, argent(revenus - depenses)),
         el('span', { classe: 'doux' }, 'Solde'))),
    el('h3', {}, 'Par mois'),
    graphiqueBarres(mois, [{ nom: 'Revenus', couleur: '#35c07a', valeurs: parMois('revenu') },
                           { nom: 'Dépenses', couleur: '#ff5a5f', valeurs: parMois('depense') }]),
    el('div', { classe: 'deux-colonnes' },
      [['revenu', 'Revenus par catégorie'], ['depense', 'Dépenses par catégorie']].map(([s, t]) => {
        const parts = parCategorie(s);
        return parts.length ? el('div', {}, el('h3', {}, t), graphiqueAnneau(parts)) : null;
      })),
    el('h3', {}, 'Ajouter une écriture'), formulaireEcriture(f.categories, null),
    el('h3', {}, 'Écritures'),
    tableau(['Date', 'Catégorie', 'Note', 'Montant', ''], f.ecritures.map((e) => {
      const c = categorie(e.categorie_id);
      return el('tr', {},
        el('td', {}, date(e.jour + 'T12:00:00')),
        el('td', {}, c ? [pastille(c.couleur), ' ', c.nom] : 'Sans catégorie', e.recurrence === 'mensuelle' ? el('span', { classe: 'doux' }, ' · chaque mois') : null),
        el('td', {}, e.note || ''),
        el('td', { classe: e.sens === 'revenu' ? 'vert' : '' }, (e.sens === 'revenu' ? '+' : '−') + argent(e.montant_cents)),
        el('td', {}, el('button', { classe: 'discret', onclick: () => {
          if (confirmer('Supprimer cette écriture' + (e.recurrence === 'mensuelle' ? ' et tous ses mois' : '') + ' ?', 'SUPPRIMER')) {
            agir('admin_supprimer_ecriture', { p_id: e.id }, 'Écriture supprimée.');
          }
        } }, 'Supprimer')));
    })),
    el('h3', {}, 'Catégories'), vueCategories(f.categories));
}

function formulaireEcriture(categories) {
  const sens = el('select', {}, el('option', { value: 'depense' }, 'Dépense'), el('option', { value: 'revenu' }, 'Revenu'));
  const cat = el('select', {});
  const remplir = () => cat.replaceChildren(el('option', { value: '' }, 'Sans catégorie'),
    ...categories.filter((c) => c.sens === sens.value).map((c) => el('option', { value: c.id }, c.nom)));
  sens.addEventListener('change', remplir); remplir();
  const montant = el('input', { inputmode: 'decimal', placeholder: '0,00 $', required: true });
  const jour = el('input', { type: 'date', value: jourIso(new Date()), required: true });
  const note = el('input', { placeholder: 'Facultative' });
  const mensuelle = el('input', { type: 'checkbox' });
  const fin = el('input', { type: 'date' });
  const champFin = el('label', { hidden: true }, 'Jusqu’au (facultatif)', fin);
  mensuelle.addEventListener('change', () => { champFin.hidden = !mensuelle.checked; });
  return el('form', { classe: 'carte-formulaire', onsubmit: (ev) => {
    ev.preventDefault();
    const cents = Math.round(parseFloat(montant.value.replace(',', '.').replace(/[^0-9.]/g, '')) * 100);
    if (!(cents > 0)) { dire('Le montant n’est pas valide.', true); return; }
    agir('admin_enregistrer_ecriture', { p_id: null, p_jour: jour.value, p_sens: sens.value, p_montant_cents: cents,
      p_categorie: cat.value || null, p_note: note.value, p_recurrence: mensuelle.checked ? 'mensuelle' : 'aucune',
      p_fin: mensuelle.checked && fin.value ? fin.value : null }, 'Écriture enregistrée.');
  } },
    el('div', { classe: 'champs' },
      el('label', {}, 'Type', sens),
      el('label', {}, 'Montant', montant),
      el('label', {}, 'Date', jour),
      el('label', {}, 'Catégorie', cat),
      el('label', { classe: 'large' }, 'Note', note)),
    el('div', { classe: 'pied-formulaire' },
      el('label', { classe: 'case' }, mensuelle, 'Revient chaque mois'),
      champFin,
      el('button', { type: 'submit' }, 'Ajouter l’écriture')));
}

function vueCategories(categories) {
  const ligne = (c) => {
    const nom = el('input', { value: c.nom });
    const couleur = el('select', {}, PALETTE.map((p) => el('option', { value: p, selected: p === c.couleur }, p)));
    const visible = el('input', { type: 'checkbox', checked: !c.masquee });
    return el('tr', {},
      el('td', {}, c.sens === 'revenu' ? 'Revenu' : 'Dépense'),
      el('td', {}, nom), el('td', {}, pastille(c.couleur), ' ', couleur),
      el('td', {}, el('label', { classe: 'case' }, visible, 'Graphiques')),
      el('td', { classe: 'actions' },
        el('button', { onclick: () => agir('admin_enregistrer_categorie', { p_id: c.id, p_nom: nom.value, p_sens: c.sens,
          p_couleur: couleur.value, p_ordre: c.ordre, p_masquee: !visible.checked }, 'Catégorie enregistrée.') }, 'Enregistrer'),
        el('button', { classe: 'discret', onclick: () => {
          if (confirmer('Supprimer « ' + c.nom + ' » ? Ses écritures restent, sans catégorie.', 'SUPPRIMER')) {
            agir('admin_supprimer_categorie', { p_id: c.id }, 'Catégorie supprimée.');
          }
        } }, 'Supprimer')));
  };
  const sens = el('select', {}, el('option', { value: 'depense' }, 'Dépense'), el('option', { value: 'revenu' }, 'Revenu'));
  const nom = el('input', { placeholder: 'Nouvelle catégorie', required: true });
  const couleur = el('select', {}, PALETTE.map((p) => el('option', { value: p }, p)));
  return el('div', {},
    tableau(['Sens', 'Nom', 'Couleur', '', ''], categories.map(ligne)),
    el('form', { classe: 'outils', onsubmit: (ev) => { ev.preventDefault();
      agir('admin_enregistrer_categorie', { p_id: null, p_nom: nom.value, p_sens: sens.value, p_couleur: couleur.value,
        p_ordre: 99, p_masquee: false }, 'Catégorie ajoutée.'); } },
      sens, nom, couleur, el('button', { type: 'submit' }, 'Ajouter')));
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
    b.textContent = t === 'light' ? '☾ Foncé' : '☀︎ Clair';
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
