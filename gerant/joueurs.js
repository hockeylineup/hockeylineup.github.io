// « Banque de joueurs » de l'Espace gérant (21 novembre 2026) : le pendant de
// VueJoueurs dans l'app (DepotLigueBanque.modifierJoueur, retirerJoueur).
// Même table `joueurs_ligue`, mêmes règles : la base vérifie que le compte
// gère la ligue (politique `joueur_ligue`).
'use strict';

const CALIBRES = ['AAA', 'A', 'B', 'C', 'D', 'E', 'F'];
const COLONNES_JOUEUR = 'profil_id,position,calibre,numero,actif,marqueur,profils(prenom,nom)';
const ban = { liste: [], ligue: null, texte: '', position: '', calibre: '', inactifs: false };

function vueJoueurs() {
  const boite = el('div');
  chargerBanque(boite);
  return [boite];
}

async function chargerBanque(boite) {
  boite.replaceChildren(el('p', { classe: 'doux' }, tr('Chargement…')));
  try {
    ban.liste = await lire('joueurs_ligue', { select: COLONNES_JOUEUR, ligue_id: 'eq.' + etat.ligue });
    ban.ligue = etat.ligue;
    rendreBanque(boite);
  } catch (e) { boite.replaceChildren(); dire(e.message, true); }
}

const nomBanque = (j) => [j.profils && j.profils.prenom, j.profils && j.profils.nom].filter(Boolean).join(' ') || tr('Sans nom');
const filtreJoueur = (j) => j.profil_id ? 'profil_id=eq.' + j.profil_id + '&ligue_id=eq.' + etat.ligue : '';

// Écrit dès qu'un champ change ; la ligne rendue remplace l'ancienne.
async function modifierBanque(boite, j, maj) {
  try {
    const p = await rest('PATCH', 'joueurs_ligue?' + filtreJoueur(j) + '&select=' + encodeURIComponent(COLONNES_JOUEUR), maj,
                         { Prefer: 'return=representation' });
    if (!p || !p.length) throw new Error(tr('Modification refusée.'));
    Object.assign(j, p[0]);
    dire(tr('Enregistré.'), false, true);
  } catch (e) { dire(e.message, true); }
  rendreListe(boite);
}

function rangeeJoueur(boite, j) {
  const position = el('select', { 'aria-label': tr('Position') }, el('option', { value: '' }, tr('À préciser')),
    etat.positions.map((p) => el('option', { value: p.code }, tr(p.nom))));
  position.value = j.position || '';
  position.addEventListener('change', () => modifierBanque(boite, j, { position: position.value || null }));
  const calibre = el('select', { 'aria-label': tr('Calibre') }, el('option', { value: '' }, tr('À préciser')),
    CALIBRES.map((c) => el('option', { value: c }, c)));
  calibre.value = j.calibre || '';
  calibre.addEventListener('change', () => modifierBanque(boite, j, { calibre: calibre.value || null }));
  const numero = el('input', { type: 'number', min: 0, max: 99, step: 1, valeur: j.numero ?? '', placeholder: '#',
                               'aria-label': tr('Numéro de chandail') });
  numero.addEventListener('change', () => {
    const n = numero.value === '' ? null : Math.round(Number(numero.value));
    if (n !== null && !(n >= 0 && n <= 99)) { dire(tr('Entre %@ et %@.', 0, 99), true); rendreListe(boite); return; }
    modifierBanque(boite, j, { numero: n });
  });
  const caseJ = (texte, cle) => el('label', { classe: 'case' }, el('input', { type: 'checkbox', checked: !!j[cle],
    onchange: (e) => modifierBanque(boite, j, { [cle]: e.target.checked }) }), texte);
  return el('div', { classe: 'joueur-banque' + (j.actif ? '' : ' inactif') },
    el('strong', null, nomBanque(j)), numero, position, calibre, caseJ(tr('Actif'), 'actif'), caseJ(tr('Marqueur'), 'marqueur'),
    el('button', { type: 'button', classe: 'danger', onclick: async () => {
      if (!confirm(tr('Retirer %@ de la ligue ? Il sort aussi de ses équipes.', nomBanque(j)))) return;
      try {
        await rest('DELETE', 'joueurs_ligue?' + filtreJoueur(j));
        ban.liste = ban.liste.filter((x) => x !== j);
        dire(tr('Joueur retiré.'), false, true);
      } catch (e) { dire(e.message, true); }
      rendreListe(boite);
    } }, tr('Retirer')));
}

// La barre de filtres se pose une fois ; seule la liste se refait (le curseur reste).
function rendreBanque(boite) {
  const liste = el('div', { classe: 'liste-banque' });
  boite.liste = liste;
  const filtrer = (cle) => (e) => { ban[cle] = e.target.type === 'checkbox' ? e.target.checked : e.target.value; rendreListe(boite); };
  const recherche = el('input', { type: 'search', valeur: ban.texte, placeholder: tr('Chercher un joueur'),
                                  'aria-label': tr('Chercher un joueur'), oninput: filtrer('texte') });
  const fPosition = el('select', { 'aria-label': tr('Position'), onchange: filtrer('position') },
    el('option', { value: '' }, tr('Toutes les positions')),
    etat.positions.map((p) => el('option', { value: p.code }, tr(p.nom))), el('option', { value: '-' }, tr('Position à préciser')));
  fPosition.value = ban.position;
  const fCalibre = el('select', { 'aria-label': tr('Calibre'), onchange: filtrer('calibre') },
    el('option', { value: '' }, tr('Tous les calibres')), CALIBRES.map((c) => el('option', { value: c }, c)));
  fCalibre.value = ban.calibre;
  const fInactifs = el('label', { classe: 'case' }, el('input', { type: 'checkbox', checked: ban.inactifs,
    onchange: filtrer('inactifs') }), tr('Afficher les inactifs'));
  boite.replaceChildren(el('div', { classe: 'filtres-banque' }, recherche, fPosition, fCalibre, fInactifs), liste);
  rendreListe(boite);
}

function rendreListe(boite) {
  const texte = ban.texte.trim().toLocaleLowerCase(LOCALE);
  const vus = ban.liste.filter((j) => (ban.inactifs || j.actif)
    && (!ban.position || (ban.position === '-' ? !etat.positions.some((p) => p.code === j.position) : j.position === ban.position))
    && (!ban.calibre || j.calibre === ban.calibre)
    && (!texte || nomBanque(j).toLocaleLowerCase(LOCALE).includes(texte)))
    .sort((a, b) => nomBanque(a).localeCompare(nomBanque(b), LOCALE));
  // Groupés par position, dans l'ordre du sport ; « à préciser » à la fin.
  const groupes = etat.positions.map((p) => [tr(p.nom), vus.filter((j) => j.position === p.code)])
    .concat([[tr('Position à préciser'), vus.filter((j) => !etat.positions.some((p) => p.code === j.position))]])
    .filter(([, js]) => js.length);
  boite.liste.replaceChildren(...(groupes.length
    ? groupes.map(([titre, js]) => carte(titre + ' (' + js.length + ')', ...js.map((j) => rangeeJoueur(boite, j))))
    : [el('p', { classe: 'doux' }, ban.liste.length ? tr('Aucun joueur ne correspond aux filtres.') : tr('Aucun joueur dans la banque de la ligue.'))]));
}
