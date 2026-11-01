// EspaceLigue · la barre de gauche commune à l'Espace gérant et à Jetons.
// Deux pages pour le code (Jetons garde son adresse : l'app et Stripe y
// mènent), une seule pour la personne : les mêmes entrées dans les deux, et
// une entrée de l'autre page y mène sans nouvelle connexion (la session vit
// dans l'onglet, la ligue choisie dans le navigateur).
'use strict';

// [page, clé, titre, titre court (barre du bas sur téléphone), condition]
const NAVIGATION = [
  ['gerant', 'ligue', 'Nom de la ligue'],
  ['gerant', 'lieux', 'Lieux et arénas'],
  ['gerant', 'matchs', 'Matchs'],
  ['gerant', 'remplacements', 'Remplacements'],
  ['gerant', 'statistiques', 'Statistiques et classement'],
  ['gerant', 'banque', 'Banque générale'],
  ['gerant', 'notifications', 'Notifications aux gérants'],
  ['gerant', 'tarifs', 'Tarifs de remplacement', null, 'titulaire'],
  ['jetons', 'achat', 'Acheter des jetons', 'Acheter'],
  ['jetons', 'transactions', 'Historique des transactions', 'Historique'],
  ['jetons', 'transfert', 'Transférer des jetons', 'Transférer', 'transfert'],
];
const GROUPES = { gerant: 'Réglages de la ligue', jetons: 'Jetons' };

// Les icônes (tracés 24 × 24).
const ICONES_NAV = {
  ligue: ['M5 21V4h11l-2 4 2 4H5'],
  lieux: ['M12 21s-7-6.2-7-11.5a7 7 0 0 1 14 0C19 14.8 12 21 12 21z', 'M12 12a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5z'],
  matchs: ['M4 6h16v14H4zM4 10h16M8 3v4M16 3v4'],
  remplacements: ['M16 3l4 4-4 4M20 7H8', 'M8 21l-4-4 4-4M4 17h12'],
  statistiques: ['M5 20V11M11 20V5M17 20v-6M3 20h18'],
  banque: ['M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM3 12h18', 'M12 3a14 14 0 0 1 0 18a14 14 0 0 1 0-18'],
  notifications: ['M6 16v-5a6 6 0 0 1 12 0v5l2 2H4z', 'M10 21h4'],
  tarifs: ['M12 2v20', 'M17 6H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6'],
  achat: ['M2 7a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2zM2 10h20'],
  transactions: ['M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0zM12 7v5l3 2'],
  transfert: ['M4 8h14l-4-4M20 16H6l4 4'],
};

function iconeNav(cle) {
  const ns = 'http://www.w3.org/2000/svg';
  const s = document.createElementNS(ns, 'svg');
  for (const [k, v] of Object.entries({ viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': 2,
    'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true' })) s.setAttribute(k, v);
  for (const d of ICONES_NAV[cle]) { const p = document.createElementNS(ns, 'path'); p.setAttribute('d', d); s.append(p); }
  return s;
}

/** Les entrées visibles : `droits` dit si le compte est titulaire, et s'il peut transférer. */
const entreesNav = (droits) => NAVIGATION.filter(([, , , , si]) => !si || droits[si]);

/** Le titre d'une entrée de cette page. */
const titreNav = (page, cle) => tr((NAVIGATION.find(([p, c]) => p === page && c === cle) || [])[2] || '');

/**
 * Remplit la barre : `page` est la page courante, `actif` sa section, `aller`
 * change de section sans quitter la page (sans clé : la liste des réglages, sur téléphone). Une entrée de l'autre page est un
 * lien ; sur téléphone, la barre du bas ne garde que « Réglages » et les jetons.
 */
function poserNavigation(page, actif, droits, aller) {
  const enfants = [];
  let groupe = null;
  for (const [p, cle, titre, court] of entreesNav(droits)) {
    if (p !== groupe) { groupe = p; enfants.push(el('p', { classe: 'groupe-nav' }, tr(GROUPES[p]))); }
    const contenu = [iconeNav(cle), el('span', { classe: 'long' }, tr(titre)), el('span', { classe: 'court' }, tr(court || titre))];
    const classe = (p === page && cle === actif ? 'actif' : '') + (p === 'gerant' ? ' reglage' : '');
    enfants.push(p === page
      ? el('button', { type: 'button', classe, onclick: () => aller(cle) }, ...contenu)
      : el('a', { classe: 'bouton-nav ' + classe, href: '/' + p + '/?' + (p === 'gerant' ? 'sujet=' : 'onglet=') + cle }, ...contenu));
  }
  // Téléphone : une seule entrée pour tous les réglages, dans la barre du bas.
  const reglages = [iconeNav('ligue'), el('span', { classe: 'court' }, tr('Réglages'))];
  enfants.push(page === 'gerant'
    ? el('button', { type: 'button', classe: 'seul-mobile actif', onclick: () => aller(null) }, ...reglages)
    : el('a', { classe: 'bouton-nav seul-mobile', href: '/gerant/' }, ...reglages));
  $('onglets').replaceChildren(...enfants);
}

/**
 * Le solde de la ligue au pied de la barre, avec la pièce : un lien vers
 * Jetons. `n` connu (page Jetons) ou lu de `jetons_ligue` ; caché si la
 * lecture échoue (jetons éteints, droits).
 */
const soldesNav = {};
async function poserSoldeNav(ligue, n) {
  let a = document.querySelector('.solde-nav');
  if (!a) {
    a = el('a', { classe: 'solde-nav', href: '/jetons/?onglet=achat' },
      el('img', { src: '/jetons/jeton.png', alt: '' }), el('span', {}), el('span', { classe: 'fleche', 'aria-hidden': 'true' }, '›'));
    document.querySelector('.cote').insertBefore(a, document.querySelector('.cote .compte'));
  }
  if (n === undefined) {
    if (!(ligue in soldesNav)) {
      try { soldesNav[ligue] = (await rpc('jetons_ligue', { p_ligue: ligue })).disponibles; } catch (e) { soldesNav[ligue] = null; }
    }
    n = soldesNav[ligue];
  } else soldesNav[ligue] = n;
  a.hidden = n === null || n === undefined;
  if (!a.hidden) a.children[1].replaceChildren(el('b', {}, String(n)), ' ', tr(Math.abs(n) > 1 ? 'jetons' : 'jeton'));
}

// Téléphone : le compte, le thème et la langue passent dans le menu ⋯.
document.addEventListener('DOMContentLoaded', () => {
  const plus = $('plus'), compte = document.querySelector('.compte');
  if (!plus || !compte) return;
  plus.addEventListener('click', (ev) => {
    ev.stopPropagation();
    plus.setAttribute('aria-expanded', compte.classList.toggle('ouvert'));
  });
  document.addEventListener('click', (ev) => {
    if (!ev.target.closest('.compte')) { compte.classList.remove('ouvert'); plus.setAttribute('aria-expanded', false); }
  });
});
