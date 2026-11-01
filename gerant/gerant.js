// EspaceLigue · Espace gérant — le gérant d'une ligue la règle depuis le web.
// Les mêmes réglages que Gestion dans l'app (VueParametresLigue), écrits aux
// mêmes endroits : la table `ligues` et `tarifs_remplacement`. La base vérifie
// que le compte gère la ligue (politique `ligue_maj`).
'use strict';

// Les colonnes de `ligues` que la page lit : celles de ParametresLigue (iOS).
const COLONNES = 'id,nom,sport,mode_remplacement,avis_absence,avis_disponible,avis_retenue,recherche_auto_fixe,'
  + 'remplacement_calibre,confirmation_pickup,stats_penalites,stats_gardiens,stats_temps,stats_tirs,classement,'
  + 'points_victoire,points_nul,points_defaite,rappel_jours,nb_trios,nb_paires,region,arbitre_inclus,nb_arbitres,'
  + 'tranche_age,trouvable';

const MODES = [['manuel', tr('Le gérant choisit')], ['automatique', tr('Premier arrivé, premier servi')]];
const PORTEES = [['equipe', tr('Équipe')], ['ligue', tr('Ligue')], ['tous', tr('Équipe et ligue')], ['personne', tr('Personne')]];
const TRANCHES = [['moins_30', tr('Moins de 30 ans')], ['30_44', tr('30 à 44 ans')], ['45_54', tr('45 à 54 ans')], ['55_plus', tr('55 ans et +')]];
const SENS = [['aucun', tr('Gratuit')], ['remplacant_paie', tr('Le remplaçant paie')], ['remplacant_paye', tr('Le remplaçant est payé')]];
const JOURS_RAPPEL = [1, 2, 3, 5, 7];

// Les sujets de Gestion (SujetReglages) sont dans commun/navigation.js, avec
// ceux de Jetons : les tarifs au gérant titulaire seulement.

const etat = { ligues: [], ligue: null, parametres: null, regions: [], positions: [], tarifs: [], sujet: 'ligue', occupe: false,
                saisons: [], lieux: [], arenas: [], liens: {} };
const STATUTS_ARENA = { demandee: tr('En attente de l’aréna'), acceptee: tr('Acceptée par l’aréna'), refusee: tr('Refusée par l’aréna') };

function dire(texte, erreur) {
  const m = $('message');
  m.textContent = texte;
  m.className = 'message' + (erreur ? ' erreur' : '');
  m.hidden = !texte;
}

const ligueChoisie = () => etat.ligues.find((l) => l.ligue_id === etat.ligue);
const titulaire = () => { const l = ligueChoisie(); return l && !l.moderateur; };
// Transférer des jetons : titulaire de cette ligue et d'au moins une autre.
const droits = () => ({ titulaire: titulaire(), transfert: titulaire() && etat.ligues.filter((l) => !l.moderateur).length > 1 });

// --- Connexion ---------------------------------------------------------------
async function connecter(ev) {
  ev.preventDefault();
  const bouton = ev.submitter;
  bouton.disabled = true;
  $('erreur-connexion').textContent = '';
  try {
    poserJetons(await auth('token?grant_type=password', { email: $('courriel').value.trim(), password: $('mdp').value }));
    $('mdp').value = '';
    await ouvrir();
  } catch (e) {
    $('erreur-connexion').textContent = e.message;
  } finally {
    bouton.disabled = false;
  }
}

function deconnecter(raison) {
  oublierSession();
  $('app').hidden = true;
  $('connexion').hidden = false;
  $('erreur-connexion').textContent = raison || '';
}

// Session ouverte : les ligues que le compte gère.
async function ouvrir() {
  const roles = await rpc('mes_roles');
  const vues = new Set();
  etat.ligues = (roles || []).filter((r) => r.role === 'gerant_ligue' && !vues.has(r.ligue_id) && vues.add(r.ligue_id))
    .sort((a, b) => a.ligue.localeCompare(b.ligue, LOCALE));
  $('connexion').hidden = true;
  $('app').hidden = false;
  const u = session.utilisateur;
  $('qui').replaceChildren(el('span', { classe: 'courriel' }, (u && u.email) || ''));
  if (!etat.ligues.length) {
    $('choix-ligue').hidden = true;
    $('onglets').replaceChildren();
    $('contenu').replaceChildren(el('section', { classe: 'fiche' },
      el('h2', null, tr('Aucune ligue à gérer')),
      el('p', { classe: 'doux' }, tr('Ce compte ne gère aucune ligue. Crée-la dans l\'app EspaceLigue, ou demande au gérant de t\'y nommer.'))));
    return;
  }
  let garde = null;
  try { garde = localStorage.getItem('espaceligue-ligue'); } catch (e) { /* bloqué */ }
  etat.ligue = etat.ligues.some((l) => l.ligue_id === garde) ? garde : etat.ligues[0].ligue_id;
  $('ligue').replaceChildren(...etat.ligues.map((l) => el('option', { value: l.ligue_id }, l.ligue)));
  $('ligue').value = etat.ligue;
  $('choix-ligue').hidden = etat.ligues.length < 2;
  await chargerLigue();
}

async function chargerLigue() {
  dire('');
  try {
    const id = 'eq.' + etat.ligue;
    const [ligues, tarifs, regions] = await Promise.all([
      lire('ligues', { select: COLONNES, id }),
      lire('tarifs_remplacement', { select: 'position,sens,montant_cents', ligue_id: id }),
      etat.regions.length ? etat.regions : lire('regions', { select: 'code,nom', order: 'ordre' }),
    ]);
    etat.parametres = ligues[0];
    etat.tarifs = tarifs;
    etat.regions = regions;
    etat.positions = await lire('positions', { select: 'code,nom', sport: 'eq.' + etat.parametres.sport, order: 'ordre' });
    await chargerLieux();
  } catch (e) {
    dire(e.message, true);
    return;
  }
  if (!entreesNav(droits()).some(([p, c]) => p === 'gerant' && c === etat.sujet)) etat.sujet = 'ligue';
  afficher();
}

// Les lieux de la ligue et les arénas d'EspaceLigue Pro. Sans réponse des
// arénas (base pas à jour), les lieux restent à adresse seulement.
async function chargerLieux() {
  const id = 'eq.' + etat.ligue;
  [etat.saisons, etat.lieux] = await Promise.all([
    lire('saisons', { select: 'id,nom', ligue_id: id, order: 'debut.desc.nullslast,nom' }),
    lire('lieux', { select: 'id,saison_id,nom,adresse,latitude,longitude', ligue_id: id, order: 'nom' }),
  ]);
  try {
    const [arenas, liens] = await Promise.all([rest('POST', 'rpc/arenas_pro', {}),
      rest('POST', 'rpc/arenas_des_lieux', { p_ligue: etat.ligue })]);
    etat.arenas = arenas;
    etat.liens = Object.fromEntries(liens.map((l) => [l.lieu_id, l]));
  } catch (e) { etat.arenas = []; etat.liens = {}; }
}

async function relierArena(lieu, arena) {
  const statut = await rest('POST', 'rpc/relier_arena', { p_lieu: lieu, p_etablissement: arena || null });
  if (arena) etat.liens[lieu] = { lieu_id: lieu, etablissement_id: arena, statut: statut || 'demandee' };
  else delete etat.liens[lieu];
}

// --- Écrire ------------------------------------------------------------------
async function changer(maj) {
  if (etat.occupe) return;
  etat.occupe = true;
  try {
    const p = await rest('PATCH', 'ligues?' + new URLSearchParams({ id: 'eq.' + etat.ligue, select: COLONNES }),
                         maj, { Prefer: 'return=representation' });
    if (!p || !p.length) throw new Error(tr('Modification refusée.'));
    etat.parametres = p[0];
    dire(tr('Enregistré.'));
  } catch (e) {
    dire(e.message, true);
  } finally {
    etat.occupe = false;
    afficher();
  }
}

async function enregistrerTarif(position, sens, montantCents) {
  try {
    const ligne = { ligue_id: etat.ligue, position, sens, montant_cents: sens === 'aucun' ? 0 : montantCents };
    await rest('POST', 'tarifs_remplacement?on_conflict=ligue_id,position', ligne,
               { Prefer: 'resolution=merge-duplicates,return=minimal' });
    etat.tarifs = etat.tarifs.filter((t) => t.position !== position).concat([ligne]);
    dire(tr('Tarif enregistré.'));
  } catch (e) {
    dire(e.message, true);
  }
  afficher();
}

// --- Pièces de formulaire ------------------------------------------------------
// Chaque contrôle écrit dès qu'il change, comme dans l'app.
function bascule(texte, cle) {
  return el('label', { classe: 'case' },
    el('input', { type: 'checkbox', checked: !!etat.parametres[cle],
                  onchange: (e) => changer({ [cle]: e.target.checked }) }), texte);
}

function choix(texte, cle, options, vide) {
  const s = el('select', { onchange: (e) => changer({ [cle]: e.target.value || null }) },
    vide ? el('option', { value: '' }, vide) : null,
    options.map(([v, t]) => el('option', { value: v }, t)));
  s.value = etat.parametres[cle] ?? '';
  return el('label', null, texte, s);
}

function nombre(texte, cle, min, max, defaut) {
  return el('label', null, texte,
    el('input', { type: 'number', min, max, step: 1, valeur: etat.parametres[cle] ?? defaut,
                  onchange: (e) => {
                    const n = Math.round(Number(e.target.value));
                    if (Number.isFinite(n) && n >= min && n <= max) changer({ [cle]: n });
                    else { dire(tr('Entre %@ et %@.', min, max), true); afficher(); }
                  } }));
}

function carte(titre, ...lignes) {
  return el('section', { classe: 'carte-formulaire' }, el('h3', null, titre), ...lignes);
}

// --- Les sujets ----------------------------------------------------------------
const VUES = {
  ligue() {
    const champ = el('input', { type: 'text', valeur: etat.parametres.nom, maxlength: 80, required: true });
    return [carte(tr('Nom de la ligue'),
      el('form', { classe: 'en-ligne', onsubmit: (e) => {
        e.preventDefault();
        const n = champ.value.trim();
        if (n && n !== etat.parametres.nom) changer({ nom: n }).then(() => ouvrirLigues());
      } }, champ, el('button', { type: 'submit' }, tr('Renommer'))),
      el('p', { classe: 'doux' }, tr('Le logo, les saisons et les membres se gèrent dans l\'app pour l\'instant.')))];
  },

  // Une aréna d'EspaceLigue Pro, ou un lieu avec son adresse seulement
  // (comme dans l'app). Choisir une aréna lui envoie une demande : elle
  // accepte d'afficher les matchs et choisit la glace.
  lieux() {
    const choixArena = (valeur) => el('select', null,
      el('option', { value: '' }, tr('Autre lieu (adresse seulement)')),
      etat.arenas.map((a) => el('option', { value: a.id, selected: a.id === valeur }, a.nom)));
    const parSaison = etat.saisons.map((s) => {
      const lieux = etat.lieux.filter((l) => l.saison_id === s.id);
      return carte(tr('Saison %@', s.nom), lieux.length ? lieux.map((l) => {
        const lien = etat.liens[l.id];
        const choix = choixArena(lien && lien.etablissement_id);
        choix.addEventListener('change', async () => {
          const a = etat.arenas.find((x) => x.id === choix.value);
          try {
            await relierArena(l.id, choix.value);
            if (a) {
              const p = await rest('PATCH', 'lieux?' + new URLSearchParams({ id: 'eq.' + l.id, select: 'id,saison_id,nom,adresse,latitude,longitude' }),
                { nom: a.nom, adresse: a.adresse, latitude: a.latitude, longitude: a.longitude }, { Prefer: 'return=representation' });
              if (p && p[0]) Object.assign(l, p[0]);
            }
            dire(a ? tr('Demande envoyée à %@.', a.nom) : tr('Lieu délié de l’aréna.'));
          } catch (e) { dire(e.message, true); }
          afficher();
        });
        return el('div', { classe: 'lieu' },
          el('div', null, el('strong', null, l.nom), l.adresse ? el('div', { classe: 'doux' }, l.adresse) : null,
            lien ? el('div', { classe: 'doux' }, STATUTS_ARENA[lien.statut] || '') : null),
          etat.arenas.length ? el('label', null, tr('Aréna'), choix) : null);
      }) : el('p', { classe: 'doux' }, tr('Aucun lieu dans cette saison.')));
    });

    // Ajouter un lieu à une saison.
    const saison = el('select', null, etat.saisons.map((s) => el('option', { value: s.id }, s.nom)));
    const arena = choixArena(null);
    const nom = el('input', { type: 'text', maxlength: 80, placeholder: tr('ex. Aréna Rosemont') });
    const adresse = el('input', { type: 'text', maxlength: 200, placeholder: tr('Adresse') });
    const manuel = el('div', { classe: 'champs' }, el('label', null, tr('Nom'), nom), el('label', null, tr('Adresse'), adresse));
    arena.addEventListener('change', () => { manuel.hidden = !!arena.value; });
    const ajout = etat.saisons.length ? carte(tr('Ajouter un lieu'), el('form', { onsubmit: async (e) => {
        e.preventDefault();
        const a = etat.arenas.find((x) => x.id === arena.value);
        const ligne = a ? { nom: a.nom, adresse: a.adresse, latitude: a.latitude, longitude: a.longitude }
                        : { nom: nom.value.trim(), adresse: adresse.value.trim() || null };
        if (!ligne.nom) { dire(tr('Entre le nom du lieu.'), true); return; }
        try {
          const [l] = await rest('POST', 'lieux?select=id', Object.assign({ ligue_id: etat.ligue, saison_id: saison.value }, ligne),
                                 { Prefer: 'return=representation' });
          if (a) await relierArena(l.id, a.id);
          await chargerLieux();
          dire(a ? tr('Lieu ajouté. Demande envoyée à %@.', a.nom) : tr('Lieu ajouté.'));
        } catch (err) { dire(err.message, true); }
        afficher();
      } },
      el('div', { classe: 'champs' }, el('label', null, tr('Saison'), saison),
        etat.arenas.length ? el('label', null, tr('Aréna'), arena) : null),
      manuel,
      el('button', { type: 'submit' }, tr('Ajouter')))) : null;

    return [
      el('p', { classe: 'doux' }, tr('Choisis une aréna enregistrée dans EspaceLigue Pro : elle reçoit une demande et, '
        + 'si elle accepte, tes matchs paraissent sur ses écrans avec le pointage et les vestiaires. '
        + 'Sinon, entre le lieu avec son adresse seulement.')),
      ...(parSaison.length ? parSaison : [el('p', { classe: 'doux' }, tr('Aucune saison : crée-la dans l’app.'))]),
      ajout,
    ];
  },

  matchs() {
    const p = etat.parametres;
    const rappel = el('select', { onchange: (e) => changer({ rappel_jours: Number(e.target.value) }) },
      el('option', { value: 0 }, tr('Aucun rappel')),
      JOURS_RAPPEL.map((n) => el('option', { value: n }, n === 1 ? tr('La veille') : tr('%@ jours avant', n))));
    rappel.value = String(p.rappel_jours || 0);
    return [
      carte(tr('Rappel'), el('label', null, tr('Rappel avant chaque match'), rappel)),
      carte(tr('Lineup en équipes fixes'), el('div', { classe: 'champs' },
        nombre(tr('Trios d\'attaquants'), 'nb_trios', 1, 9, 2), nombre(tr('Paires de défenseurs'), 'nb_paires', 1, 9, 2))),
      carte(tr('Arbitre'), bascule(tr('Inclure l\'arbitre dans la ligue'), 'arbitre_inclus'),
        p.arbitre_inclus ? nombre(tr('Arbitres par match'), 'nb_arbitres', 1, 4, 1) : null),
      carte(tr('Pickup'), bascule(tr('Les réguliers confirment leur présence'), 'confirmation_pickup')),
    ];
  },

  remplacements() {
    return [
      carte(tr('Remplacements'), choix(tr('Retenir un remplaçant'), 'mode_remplacement', MODES),
        bascule(tr('Remplacement de calibre équivalent'), 'remplacement_calibre'),
        etat.parametres.remplacement_calibre
          ? el('p', { classe: 'doux' }, tr('Même calibre, puis ±1 après 1 h, puis toute la banque après 2 h.')) : null),
      carte(tr('Équipes fixes'), bascule(tr('Chercher un remplaçant quand une absence laisse un trou'), 'recherche_auto_fixe')),
    ];
  },

  statistiques() {
    const p = etat.parametres;
    return [
      carte(tr('Statistiques'),
        bascule(tr('Pénalités'), 'stats_penalites'),
        bascule(tr('Gardiens (tirs et buts accordés)'), 'stats_gardiens'),
        bascule(tr('Période et temps de chaque but'), 'stats_temps'),
        bascule(tr('Tirs au but de chaque joueur'), 'stats_tirs')),
      carte(tr('Résultats'), bascule(tr('Classement des équipes'), 'classement'),
        p.classement ? el('div', { classe: 'champs' },
          nombre(tr('Victoire (pts)'), 'points_victoire', 0, 10, 2),
          nombre(tr('Nul (pts)'), 'points_nul', 0, 10, 1),
          nombre(tr('Défaite (pts)'), 'points_defaite', 0, 10, 0)) : null),
    ];
  },

  banque() {
    return [carte(tr('Banque générale'),
      choix(tr('Région'), 'region', etat.regions.map((r) => [r.code, r.nom]), tr('À choisir')),
      bascule(tr('Trouvable dans la région'), 'trouvable'),
      choix(tr('Âge moyen'), 'tranche_age', TRANCHES, tr('À choisir')))];
  },

  notifications() {
    return [carte(tr('Notifications aux gérants'),
      choix(tr('Un joueur s\'absente'), 'avis_absence', PORTEES),
      choix(tr('Un remplaçant répond présent'), 'avis_disponible', PORTEES),
      choix(tr('Un remplaçant est retenu'), 'avis_retenue', PORTEES))];
  },

  tarifs() {
    return [carte(tr('Tarifs de remplacement'), ...etat.positions.map((pos) => {
      const t = etat.tarifs.find((x) => x.position === pos.code) || { sens: 'aucun', montant_cents: 0 };
      const sens = el('select', null, SENS.map(([v, x]) => el('option', { value: v }, x)));
      sens.value = t.sens;
      const montant = el('input', { type: 'number', min: 0, step: '0.01', inputmode: 'decimal',
                                    valeur: (t.montant_cents / 100).toFixed(2), 'aria-label': tr('Montant ($)') });
      montant.disabled = t.sens === 'aucun';
      sens.addEventListener('change', () => { montant.disabled = sens.value === 'aucun'; });
      return el('form', { classe: 'tarif', onsubmit: (e) => {
        e.preventDefault();
        const cents = Math.round(Number(montant.value) * 100);
        if (sens.value !== 'aucun' && !(cents > 0)) { dire(tr('Entre un montant.'), true); return; }
        enregistrerTarif(pos.code, sens.value, cents);
      } }, el('strong', null, tr(pos.nom)), sens, el('span', { classe: 'dollar' }, montant, ' $'),
         el('button', { type: 'submit' }, tr('Enregistrer')));
    }))];
  },
};

function ouvrirLigues() {
  const l = ligueChoisie();
  if (l) l.ligue = etat.parametres.nom;
  $('ligue').replaceChildren(...etat.ligues.map((x) => el('option', { value: x.ligue_id }, x.ligue)));
  $('ligue').value = etat.ligue;
}

function afficher() {
  if (!etat.parametres) return;
  const aller = (cle) => { etat.sujet = cle; dire(''); afficher(); window.scrollTo(0, 0); };
  poserNavigation('gerant', etat.sujet, droits(), aller);
  // Téléphone : la barre du bas n'a qu'« Réglages » ; les sujets défilent en tête.
  const sujets = el('nav', { classe: 'sujets-mobile', 'aria-label': tr('Réglages') },
    entreesNav(droits()).filter(([p]) => p === 'gerant').map(([, cle, titre]) =>
      el('button', { type: 'button', classe: cle === etat.sujet ? 'actif' : null, onclick: () => aller(cle) }, tr(titre))));
  $('contenu').replaceChildren(sujets, el('h2', null, titreNav('gerant', etat.sujet)), ...VUES[etat.sujet]());
  const actif = sujets.querySelector('.actif');
  if (actif) sujets.scrollLeft = actif.offsetLeft - 16;
}

// --- Démarrage -----------------------------------------------------------------
sessionPerdue = () => deconnecter(tr('Session expirée.'));

document.addEventListener('DOMContentLoaded', async () => {
  // ?sujet=tarifs : un lien de l'Assistant-Coach ouvre ce réglage.
  const voulu = new URLSearchParams(location.search).get('sujet');
  if (NAVIGATION.some(([p, c]) => p === 'gerant' && c === voulu)) etat.sujet = voulu;
  $('formulaire-connexion').addEventListener('submit', connecter);
  $('apple').addEventListener('click', () => continuerAvecApple().catch((e) => {
    $('erreur-connexion').textContent = e.message;
  }));
  $('deconnexion').addEventListener('click', () => deconnecter(''));
  $('ligue').addEventListener('change', (e) => {
    etat.ligue = e.target.value;
    try { localStorage.setItem('espaceligue-ligue', etat.ligue); } catch (x) { /* bloqué */ }
    chargerLigue();
  });
  try {
    if (await retourApple() || await reprendreSession()) { await ouvrir(); return; }
  } catch (e) {
    $('erreur-connexion').textContent = e.message;
  }
  $('connexion').hidden = false;
});
