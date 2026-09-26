// LineUp · Gestion — la page d'administration du système.
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

const SUPABASE = 'https://wkjyeyswlvdkaalhslvw.supabase.co';
// Publique par construction : c'est la même que dans les apps.
const CLE = 'sb_publishable_aDtOKUHIXbnSLWX6qPBpuQ_bixLx_ft';
const INACTIVITE_MS = 15 * 60 * 1000;

if (window.top !== window.self) {
  document.documentElement.textContent = '';
  throw new Error('cadre refusé');
}

const etat = { facteur: null, jeton: null, rafraichir: null, expire: 0, courriel: '', proprietaire: false,
               onglet: 'tableau', minuterie: null, regions: [] };

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
    const courriel = $('courriel').value.trim();
    poserJetons(await auth('token?grant_type=password',
                           { email: courriel, password: $('mdp').value }));
    $('mdp').value = '';
    const moi = await rpc('admin_moi');
    if (!moi.admin) {
      await fermerSession();
      throw new Error('Ce compte n’a pas accès à la gestion.');
    }
    etat.courriel = courriel;
    etat.proprietaire = moi.proprietaire;
    await preparerCode();
  } catch (e) {
    $('erreur-connexion').textContent = e.message;
  } finally {
    bouton.disabled = false;
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

async function preparerCode() {
  const moi = await authJeton('GET', 'user');
  const facteurs = (moi.factors || []).filter((f) => f.factor_type === 'totp');
  const verifie = facteurs.find((f) => f.status === 'verified');
  if (verifie) {
    etat.facteur = verifie.id;
    $('inscription-totp').hidden = true;
  } else {
    // Une inscription abandonnée laisse un facteur non vérifié : on le retire.
    for (const f of facteurs) await authJeton('DELETE', 'factors/' + f.id).catch(() => {});
    const ins = await authJeton('POST', 'factors', { factor_type: 'totp', friendly_name: 'LineUp Gestion' });
    etat.facteur = ins.id;
    $('qr').src = ins.totp.qr_code;
    $('secret').textContent = ins.totp.secret;
    $('inscription-totp').hidden = false;
  }
  $('formulaire-connexion').hidden = true;
  $('formulaire-code').hidden = false;
  $('erreur-code').textContent = '';
  $('code').value = '';
  $('code').focus();
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
  $('formulaire-connexion').hidden = false;
  $('formulaire-code').hidden = true;
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
  ['regions', 'Régions', vueRegions],
  ['parametres', 'Paramètres', vueParametres],
  ['journal', 'Journal', vueJournal],
];

function ouvrir() {
  $('connexion').hidden = true;
  $('app').hidden = false;
  $('qui').textContent = etat.courriel + (etat.proprietaire ? ' · propriétaire' : '');
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

// --- Démarrage ------------------------------------------------------------
document.addEventListener('DOMContentLoaded', () => {
  $('connexion').hidden = false;
  $('formulaire-connexion').addEventListener('submit', connecter);
  $('deconnexion').addEventListener('click', () => deconnecter(''));
  $('formulaire-code').addEventListener('submit', validerCode);
  $('annuler-code').addEventListener('click', () => deconnecter(''));
  for (const ev of ['click', 'keydown']) document.addEventListener(ev, () => etat.jeton && reveiller());
});
