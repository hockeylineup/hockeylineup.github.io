// EspaceLigue Pro · Gestion — contenu des affichages (avec l'apparence), urgences
// (docs/contenu-affichage.md d'espaceligue-pro). Chargé après gestion.js,
// dont il reprend lirePro, majPro, etat, dire et peutModifier.
//
// Tout s'écrit directement dans les tables (RLS : admin et gestionnaire ;
// l'apparence de l'organisation, admin seulement). L'aperçu est la vraie
// page d'affichage dans un cadre (?apercu) : elle reçoit par postMessage
// les données réelles de l'affichage, où l'on substitue ce qui est en cours
// d'édition, avant même l'enregistrement.
'use strict';

const ajoutPro = (table, corps) => rest('POST', table, corps,
  Object.assign({ Prefer: 'return=representation' }, PRO));
const retraitPro = (table, filtre) => rest('DELETE', table + '?' + new URLSearchParams(filtre), undefined,
  Object.assign({ Prefer: 'return=minimal' }, PRO));

const TYPES = {
  horaire: { nom: 'Horaire', aide: 'Les activités du plateau ou de l’établissement.', duree: 30 },
  pointage: { nom: 'Pointage en direct', aide: 'Paraît seulement pendant un match EspaceLigue.', duree: 20 },
  annonce: { nom: 'Annonce', aide: 'Un titre, un texte, une couleur, une image au besoin.', duree: 12 },
  image: { nom: 'Image', aide: 'Plein écran : commanditaire, affiche, promotion.', duree: 10 },
  video: { nom: 'Vidéo', aide: 'MP4, flux .m3u8, YouTube ou Vimeo, sans le son.', duree: 30 },
  rss: { nom: 'Fil d’actualités', aide: 'Les manchettes d’un fil RSS (nouvelles, résultats sportifs).', duree: 15 },
  meteo: { nom: 'Météo', aide: 'Conditions et prévisions à l’adresse de l’établissement.', duree: 12 },
};
const JOURS = ['Dim', 'Lun', 'Mar', 'Mer', 'Jeu', 'Ven', 'Sam'];
// Les trois dispositions, avec leurs zones (schéma du menu de choix).
const GABARITS = {
  plein: { nom: 'Plein écran', aide: 'Les panneaux occupent tout l’écran.' },
  bandeau: { nom: 'Panneaux + bandeau', aide: 'Un bandeau en bas : heure, météo, texte ou fil RSS défilant.' },
  colonne: { nom: 'Panneaux + colonne + bandeau', aide: 'Une colonne à droite (logo, météo, commanditaires) et le bandeau.' },
};
function schemaGabarit(g) {
  const z = (classe, titre, detail) => el('div', { classe: 'zone ' + classe }, el('strong', null, titre), detail ? el('small', null, detail) : null);
  return el('div', { classe: 'schema g-' + g, 'aria-hidden': 'true' },
    z('z-principale', 'Panneaux', 'horaire, annonces, images, vidéo…'),
    g === 'colonne' ? z('z-colonne', 'Colonne', 'logo · météo · commanditaires') : null,
    g !== 'plein' ? z('z-bandeau', 'Bandeau', 'heure · météo · texte ou RSS défilant') : null);
}

// Menu déroulant illustré : le choix courant, et les trois schémas à l'ouverture.
function choixGabarit(valeur, modifiable, change) {
  const menu = el('details', { classe: 'choix-gabarit' });
  const dessiner = () => {
    const g = GABARITS[valeur] ? valeur : 'plein';
    menu.replaceChildren(
      el('summary', null, schemaGabarit(g), el('div', null, el('strong', null, GABARITS[g].nom), el('p', { classe: 'doux' }, GABARITS[g].aide))),
      el('div', { classe: 'options' }, Object.entries(GABARITS).map(([k, v]) =>
        el('button', { type: 'button', classe: 'option' + (k === g ? ' choisi' : ''), 'aria-pressed': k === g ? 'true' : 'false',
          onclick: () => { valeur = k; menu.open = false; dessiner(); change(k); } },
          schemaGabarit(k), el('strong', null, v.nom), el('span', { classe: 'doux' }, v.aide)))));
  };
  dessiner();
  if (!modifiable) menu.addEventListener('toggle', () => { menu.open = false; });
  return menu;
}

const contenu = { affichage: null, affichages: [], panneaux: [], reglages: {}, apparence: {}, plateaux: [], minuterie: null };

// --- Médias --------------------------------------------------------------------
async function televerser(fichier) {
  if (fichier.size > 10 * 1024 * 1024) throw new Error('Fichier trop gros (10 Mo au plus).');
  const ext = (fichier.name.match(/\.[a-z0-9]+$/i) || [''])[0].toLowerCase();
  const chemin = etat.organisation + '/' + crypto.randomUUID() + ext;
  const r = await fetch(SUPABASE + '/storage/v1/object/pro-medias/' + chemin, {
    method: 'POST', credentials: 'omit',
    headers: { apikey: CLE, Authorization: 'Bearer ' + await jetonFrais(), 'Content-Type': fichier.type },
    body: fichier,
  });
  if (!r.ok) throw new Error('Téléversement refusé (' + r.status + ').');
  return SUPABASE + '/storage/v1/object/public/pro-medias/' + chemin;
}

// Un champ d'adresse avec son bouton « Téléverser… ».
function champMedia(libelle, valeur, accepte, change) {
  const entree = el('input', { valeur: valeur || '', placeholder: 'https://…', oninput: () => change(entree.value.trim()) });
  const fichier = el('input', { type: 'file', accept: accepte, hidden: true, onchange: async () => {
    if (!fichier.files[0]) return;
    dire('Téléversement…');
    try {
      entree.value = await televerser(fichier.files[0]);
      change(entree.value);
      dire('Téléversé. N’oubliez pas d’enregistrer.');
    } catch (e) { dire(e.message, true); }
  } });
  return el('label', { classe: 'large' }, libelle,
    el('div', { classe: 'media' }, entree, fichier,
      el('button', { type: 'button', classe: 'discret', onclick: () => fichier.click() }, 'Téléverser…')));
}

// --- Aperçu ----------------------------------------------------------------------
let donneesReelles = null;
async function chargerApercu() {
  const a = contenu.affichages.find((x) => x.id === contenu.affichage);
  donneesReelles = a ? await rest('POST', 'rpc/lire_affichage', { jeton: a.jeton }, PRO) : null;
  envoyerApercu();
}
function envoyerApercu() {
  const cadre = $('apercu');
  if (!cadre || !donneesReelles || !cadre.contentWindow) return;
  const d = Object.assign({}, donneesReelles, {
    reglages: contenu.reglages,
    apparence: Object.assign({}, contenu.apparence, contenu.reglages.apparence || {}),
    panneaux: contenu.panneaux.filter((p) => p.actif).map((p) => Object.assign({}, p, { duree: Math.min(p.duree, 8) })),
  });
  cadre.contentWindow.postMessage({ type: 'apercu', donnees: d }, location.origin);
}
const rafraichirApercu = () => { clearTimeout(contenu.minuterie); contenu.minuterie = setTimeout(envoyerApercu, 400); };

function cadreApercu() {
  const f = el('iframe', { id: 'apercu', src: '../affichage/?apercu', title: 'Aperçu de l’affichage', tabindex: '-1' });
  f.addEventListener('load', envoyerApercu);
  return el('div', { classe: 'apercu' }, f,
    el('p', { classe: 'doux' }, 'Aperçu en direct, 8 s par panneau.'));
}

// --- Vue Contenu -------------------------------------------------------------------
// L'aperçu à gauche, les réglages à droite en trois sections repliables
// (Disposition, Panneaux, Apparence). Les modifications s'accumulent dans
// contenu.sale et partent ensemble par la barre « Enregistrer » ; ajouter,
// retirer ou déplacer un panneau enregistre d'abord ce qui attend.
contenu.sale = new Set();
contenu.recolte = {};
contenu.ouverts = new Set(['panneaux']);

function marquer(cle) {
  if (!peutModifier()) return;
  contenu.sale.add(cle);
  const barre = $('barre-enregistrer');
  if (barre) barre.hidden = false;
}
// Appelé par gestion.js avant de changer d'onglet.
function quitterContenu() {
  return !contenu.sale.size || confirm('Des modifications ne sont pas enregistrées. Les abandonner ?');
}
window.addEventListener('beforeunload', (ev) => { if (contenu.sale.size) ev.preventDefault(); });

async function enregistrerContenu() {
  const af = contenu.affichages.find((a) => a.id === contenu.affichage);
  for (const cle of [...contenu.sale]) {
    if (cle === 'reglages') {
      await majPro('affichages', { id: 'eq.' + af.id }, { reglages: contenu.reglages });
      af.reglages = JSON.parse(JSON.stringify(contenu.reglages));
    } else if (cle === 'apparence') {
      await majPro('organisations', { id: 'eq.' + etat.organisation }, { apparence: contenu.apparence });
    } else if (contenu.recolte[cle]) {
      await majPro('panneaux', { id: 'eq.' + cle }, contenu.recolte[cle]());
    }
    contenu.sale.delete(cle);
  }
}
async function avantStructure() {
  if (contenu.sale.size) await enregistrerContenu();
}

// Une section repliable dont l'état ouvert survit au réaffichage.
function section(cle, titre, resume, ...corps) {
  const d = el('details', { classe: 'section-contenu', open: contenu.ouverts.has(cle),
    ontoggle: () => { d.open ? contenu.ouverts.add(cle) : contenu.ouverts.delete(cle); } },
    el('summary', null, el('strong', null, titre), resume ? el('span', { classe: 'doux' }, resume) : null), ...corps);
  return d;
}

async function vueContenu() {
  const org = etat.organisation;
  const [affichages, etablissements, panneaux, orgs, plateaux] = await Promise.all([
    lirePro('affichages', { select: 'id,nom,jeton,etablissement_id,reglages', organisation_id: 'eq.' + org, order: 'nom' }),
    lirePro('etablissements', { select: 'id,nom', organisation_id: 'eq.' + org }),
    lirePro('panneaux', { select: '*', organisation_id: 'eq.' + org, order: 'ordre,id' }),
    lirePro('organisations', { select: 'apparence', id: 'eq.' + org }),
    lirePro('plateaux', { select: 'id,nom,etablissement_id', organisation_id: 'eq.' + org, order: 'nom' }),
  ]);
  contenu.sale.clear();
  contenu.recolte = {};
  contenu.affichages = affichages;
  contenu.plateaux = plateaux;
  contenu.apparence = Object.assign({}, (orgs[0] && orgs[0].apparence) || {});
  if (!affichages.length) return el('section', { classe: 'fiche' }, el('h2', null, 'Contenu'),
    el('p', { classe: 'doux' }, 'Aucun affichage. Créez-en un dans l’onglet Lecteurs.'));
  if (!affichages.some((a) => a.id === contenu.affichage)) contenu.affichage = affichages[0].id;
  const af = affichages.find((a) => a.id === contenu.affichage);
  contenu.reglages = JSON.parse(JSON.stringify(af.reglages || {}));
  contenu.panneaux = panneaux.filter((p) => !p.affichage_id || p.affichage_id === af.id);
  const nomEtab = (id) => (etablissements.find((e) => e.id === id) || {}).nom || '';
  const modifiable = peutModifier();

  const choix = el('select', { onchange: () => {
      if (!quitterContenu()) { choix.value = contenu.affichage; return; }
      contenu.affichage = choix.value; afficher();
    } },
    affichages.map((a) => el('option', { value: a.id, selected: a.id === af.id }, a.nom + (nomEtab(a.etablissement_id) ? ' (' + nomEtab(a.etablissement_id) + ')' : ''))));

  const g = contenu.reglages.gabarit || 'plein';
  const nbActifs = contenu.panneaux.filter((p) => p.actif).length;
  const barre = modifiable ? el('div', { id: 'barre-enregistrer', classe: 'barre-enregistrer', hidden: true },
    el('span', null, 'Modifications non enregistrées'),
    el('button', { type: 'button', classe: 'discret', onclick: () => { contenu.sale.clear(); afficher(); } }, 'Annuler'),
    el('button', { type: 'button', onclick: async (ev) => {
      ev.target.disabled = true;
      try {
        await enregistrerContenu();
        await afficher();
        dire('Enregistré. Les écrans suivent dans les 30 secondes.');
      } catch (e) { ev.target.disabled = false; dire(e.message, true); }
    } }, 'Enregistrer')) : null;

  const vue = el('section', { classe: 'vue-contenu' },
    el('div', { classe: 'entete-vue' }, el('h2', null, 'Contenu'),
      el('label', { classe: 'choix-affichage' }, el('span', null, 'Affichage'), choix)),
    el('div', { classe: 'editeur' },
      cadreApercu(),
      el('div', { classe: 'reglages' },
        section('disposition', 'Disposition', GABARITS[g] ? GABARITS[g].nom : '', formulaireGabarit(modifiable)),
        section('panneaux', 'Panneaux', nbActifs + ' actif' + (nbActifs > 1 ? 's' : '') + ', en boucle', listePanneaux(af, modifiable)),
        section('apparence', 'Apparence', 'tous les affichages', formulaireApparence()))),
    barre);
  if (contenu.nouveau) {
    const id = contenu.nouveau;
    contenu.nouveau = null;
    setTimeout(() => { const n = vue.querySelector('[data-panneau="' + id + '"]'); if (n) { n.scrollIntoView({ behavior: 'smooth', block: 'center' }); n.classList.add('vient'); } }, 50);
  }
  chargerApercu().catch((e) => dire(e.message, true));
  return vue;
}

function formulaireGabarit(modifiable) {
  const r = contenu.reglages;
  r.bandeau = r.bandeau || {};
  r.colonne = r.colonne || {};
  const majR = () => { marquer('reglages'); rafraichirApercu(); };
  const gabarit = choixGabarit(r.gabarit || 'plein', modifiable, (g) => { r.gabarit = g; zones(); majR(); });
  const texte = el('input', { valeur: r.bandeau.texte || '', placeholder: 'ex. Bienvenue à l’aréna !', disabled: !modifiable,
    oninput: () => { r.bandeau.texte = texte.value; majR(); } });
  const rss = el('input', { valeur: r.bandeau.rss || '', placeholder: 'https://… (facultatif)', disabled: !modifiable,
    oninput: () => { r.bandeau.rss = rss.value.trim(); majR(); } });
  const meteo = el('input', { type: 'checkbox', checked: r.colonne.meteo !== false, disabled: !modifiable,
    onchange: () => { r.colonne.meteo = meteo.checked; majR(); } });
  const logos = el('div', { classe: 'logos' });
  const dessinerLogos = () => logos.replaceChildren(
    (r.colonne.logos || []).map((u, i) => el('span', { classe: 'vignette' }, el('img', { src: u, alt: '' }),
      modifiable ? el('button', { type: 'button', classe: 'discret', title: 'Retirer',
        onclick: () => { r.colonne.logos.splice(i, 1); dessinerLogos(); majR(); } }, '×') : null)),
    modifiable ? champMedia('Ajouter un commanditaire', '', 'image/*', (u) => {
      if (!u || !/^https?:/.test(u)) return;
      r.colonne.logos = (r.colonne.logos || []).concat(u); dessinerLogos(); majR();
    }) : null);
  dessinerLogos();
  const blocBandeau = el('div', { classe: 'champs' }, el('h4', null, 'Bandeau'),
    el('label', null, 'Texte défilant', texte), el('label', null, 'Fil RSS défilant', rss));
  const blocColonne = el('div', { classe: 'champs' }, el('h4', null, 'Colonne'), el('label', { classe: 'case' }, meteo, ' Météo'),
    el('div', { classe: 'large' }, el('span', { classe: 'doux' }, 'Commanditaires (8 s chacun)'), logos));
  const zones = () => { blocBandeau.hidden = (r.gabarit || 'plein') === 'plein'; blocColonne.hidden = r.gabarit !== 'colonne'; };
  zones();
  return el('div', { classe: 'corps-section' }, gabarit, blocBandeau, blocColonne);
}

// Les types de panneaux en cartes illustrées : une miniature de ce que montre
// l'écran. Le panneau ajouté est actif : vide, il est sauté à l'écran jusqu'à
// ce qu'on le remplisse.
const VIGNETTES = {
  horaire: () => el('div', { classe: 'v-horaire' }, el('b', null, 'Glace 1'), el('i'), el('i'), el('i')),
  pointage: () => el('div', { classe: 'v-pointage' }, el('span', null, '●'), el('b', null, '2 : 1'), el('span', null, '●')),
  annonce: () => el('div', { classe: 'v-annonce' }, el('b', null, 'Patin libre annulé'), el('i')),
  image: () => el('div', { classe: 'v-image' }, '🖼️'),
  video: () => el('div', { classe: 'v-video' }, '▶'),
  rss: () => el('div', { classe: 'v-rss' }, el('i'), el('i'), el('i')),
  meteo: () => el('div', { classe: 'v-meteo' }, '⛅', el('b', null, '16°')),
};

function listePanneaux(af, modifiable) {
  const galerie = el('div', { classe: 'galerie-panneaux', hidden: true }, Object.entries(TYPES).map(([k, t]) =>
    el('button', { type: 'button', classe: 'carte-type', onclick: async () => {
      try {
        await avantStructure();
        const ordre = contenu.panneaux.reduce((m, p) => Math.max(m, p.ordre), 0) + 10;
        const [p] = await ajoutPro('panneaux', { organisation_id: etat.organisation, affichage_id: af.id, type: k,
          duree: t.duree, ordre, actif: true });
        contenu.nouveau = p.id;
        contenu.ouverts.add(p.id);
        await afficher();
        dire(t.nom + ' ajouté.');
      } catch (e) { dire(e.message, true); }
    } },
    el('div', { classe: 'vignette-type' }, VIGNETTES[k]()),
    el('strong', null, t.nom), el('span', { classe: 'doux' }, t.aide))));
  const ajouter = el('button', { type: 'button', classe: 'ajout-panneau', onclick: () => {
    galerie.hidden = !galerie.hidden;
    ajouter.textContent = galerie.hidden ? '+ Ajouter un panneau' : 'Fermer';
  } }, '+ Ajouter un panneau');
  return el('div', { classe: 'corps-section' },
    contenu.panneaux.length ? glisserDeposer(el('div', { classe: 'liste-panneaux' }, contenu.panneaux.map((p, i) => lignePanneau(p, i, af, modifiable))), modifiable)
      : el('p', { classe: 'doux' }, 'Aucun panneau : l’écran montre l’horaire.'),
    modifiable ? ajouter : null, galerie);
}

// Glisser une rangée par sa poignée (⠿) pour changer l'ordre ; les flèches
// restent pour le tactile. Au dépôt, on renumérote toute la liste.
function glisserDeposer(liste, modifiable) {
  if (!modifiable) return liste;
  let tiree = null;
  liste.addEventListener('mousedown', (ev) => {
    const r = ev.target.closest('.poignee') && ev.target.closest('.ligne-panneau');
    if (r) r.draggable = true;
  });
  liste.addEventListener('mouseup', () => { if (!tiree) liste.querySelectorAll('[draggable="true"]').forEach((n) => { n.draggable = false; }); });
  liste.addEventListener('dragstart', (ev) => {
    tiree = ev.target.closest('.ligne-panneau');
    ev.dataTransfer.effectAllowed = 'move';
    ev.dataTransfer.setData('text/plain', tiree.dataset.panneau);
    setTimeout(() => tiree.classList.add('tiree'), 0);
  });
  liste.addEventListener('dragover', (ev) => {
    if (!tiree) return;
    ev.preventDefault();
    const sous = ev.target.closest('.ligne-panneau');
    if (!sous || sous === tiree) return;
    const b = sous.getBoundingClientRect();
    liste.insertBefore(tiree, ev.clientY > b.top + b.height / 2 ? sous.nextSibling : sous);
  });
  liste.addEventListener('dragend', async () => {
    if (!tiree) return;
    tiree.classList.remove('tiree');
    tiree.draggable = false;
    tiree = null;
    const ids = [...liste.children].map((n) => n.dataset.panneau);
    if (ids.join() === contenu.panneaux.map((p) => p.id).join()) return;
    try {
      await avantStructure();
      await Promise.all(ids.map((id, n) => {
        const p = contenu.panneaux.find((x) => x.id === id);
        return p.ordre === (n + 1) * 10 ? null : majPro('panneaux', { id: 'eq.' + id }, { ordre: (n + 1) * 10 });
      }));
      await afficher();
      dire('Ordre enregistré.');
    } catch (e) { dire(e.message, true); afficher(); }
  });
  return liste;
}

// Ce qu'on reconnaît d'un panneau sans l'ouvrir.
function resumePanneau(p) {
  const c = p.contenu || {};
  if (p.type === 'horaire') return (contenu.plateaux.find((pl) => pl.id === c.plateau) || {}).nom || 'Tous les plateaux';
  if (p.type === 'annonce') return c.titre || 'Sans titre';
  if (p.type === 'rss') return c.titre || (c.url ? c.url.replace(/^https?:\/\/(www\.)?/, '').split('/')[0] : 'Adresse à donner');
  if (p.type === 'image' || p.type === 'video') return c.url ? '' : 'Fichier à donner';
  return '';
}

function lignePanneau(p, i, af, modifiable) {
  const c = p.contenu = p.contenu || {};
  const maj = () => { marquer(p.id); rafraichirApercu(); };
  const entree = (cle, attrs) => {
    const n = el(attrs && attrs.zone ? 'textarea' : 'input', Object.assign({ disabled: !modifiable,
      oninput: () => { c[cle] = n.type === 'number' ? Number(n.value) || undefined : n.value; maj(); } }, attrs || {}));
    n.value = c[cle] ?? '';
    return n;
  };
  const choixDe = (cle, options) => {
    const s = el('select', { disabled: !modifiable, onchange: () => { c[cle] = s.value || undefined; maj(); } },
      Object.entries(options).map(([k, v]) => el('option', { value: k, selected: (c[cle] || '') === k }, v)));
    return s;
  };
  const champs = {
    // Le plateau se choisit ici, panneau par panneau : l'affichage n'est qu'une liste de panneaux.
    horaire: () => [el('label', null, 'Plateau', choixDe('plateau', Object.assign({ '': 'Tous les plateaux (une colonne chacun)' },
      Object.fromEntries(contenu.plateaux.filter((pl) => pl.etablissement_id === af.etablissement_id)
        .map((pl) => [pl.id, pl.nom + ' seulement'])))))],
    pointage: () => [],
    annonce: () => [el('label', { classe: 'large' }, 'Titre', entree('titre', { maxlength: 80 })),
      el('label', { classe: 'large' }, 'Texte', entree('texte', { zone: true, rows: 3, maxlength: 300 })),
      el('label', null, 'Couleur', entree('couleur', { type: 'color' })),
      champMedia('Image (facultative)', c.image, 'image/*', (u) => { c.image = u || undefined; maj(); })],
    image: () => [champMedia('Image', c.url, 'image/*', (u) => { c.url = u; maj(); }),
      el('label', null, 'Cadrage', choixDe('ajustement', { '': 'Image entière', cover: 'Remplir l’écran' }))],
    video: () => [champMedia('Vidéo : MP4, .m3u8, lien YouTube ou Vimeo', c.url, 'video/mp4', (u) => { c.url = u; maj(); }),
      el('label', null, 'Cadrage', choixDe('ajustement', { '': 'Image entière', cover: 'Remplir l’écran' }))],
    rss: () => [el('label', { classe: 'large' }, 'Adresse du fil', entree('url', { placeholder: 'https://ici.radio-canada.ca/rss/…' })),
      el('label', null, 'Titre affiché', entree('titre', { placeholder: 'ex. Sports' })),
      el('label', null, 'Manchettes', entree('nombre', { type: 'number', min: 1, max: 5, placeholder: '3' }))],
    meteo: () => [],
  }[p.type]();

  const duree = el('input', { type: 'number', min: 5, max: 600, valeur: p.duree, disabled: !modifiable,
    oninput: () => { p.duree = Number(duree.value) || 15; maj(); } });
  const actif = el('input', { type: 'checkbox', checked: p.actif, disabled: !modifiable, title: 'Actif',
    onclick: (ev) => ev.stopPropagation(),
    onchange: () => { p.actif = actif.checked; ligne.classList.toggle('inactif', !p.actif); maj(); } });
  const tous = el('input', { type: 'checkbox', checked: !p.affichage_id, disabled: !modifiable, onchange: maj });
  const jours = JOURS.map((j, n) => el('label', { classe: 'jour' },
    el('input', { type: 'checkbox', checked: !p.jours || p.jours.includes(n), disabled: !modifiable, onchange: maj }), j));
  const debut = el('input', { type: 'time', valeur: (p.heure_debut || '').slice(0, 5), disabled: !modifiable, onchange: maj });
  const fin = el('input', { type: 'time', valeur: (p.heure_fin || '').slice(0, 5), disabled: !modifiable, onchange: maj });
  contenu.recolte[p.id] = () => {
    const coches = jours.map((j, n) => (j.firstChild.checked ? n : -1)).filter((n) => n >= 0);
    return { contenu: c, duree: p.duree, actif: p.actif, affichage_id: tous.checked ? null : af.id,
      jours: coches.length === 7 ? null : coches, heure_debut: debut.value || null, heure_fin: fin.value || null };
  };

  const geste = (titre, texte, action, desactive) => el('button', { type: 'button', classe: 'discret', title: titre, disabled: desactive,
    onclick: async (ev) => { ev.preventDefault(); ev.stopPropagation(); try { await action(); } catch (e) { dire(e.message, true); } } }, texte);
  const deplacer = async (sens) => {
    const autre = contenu.panneaux[i + sens];
    if (!autre) return;
    await avantStructure();
    await Promise.all([majPro('panneaux', { id: 'eq.' + p.id }, { ordre: autre.ordre === p.ordre ? autre.ordre + sens : autre.ordre }),
      majPro('panneaux', { id: 'eq.' + autre.id }, { ordre: p.ordre })]);
    await afficher();
  };
  const supprimer = async () => {
    if (!confirm('Supprimer ce panneau ?' + (p.affichage_id ? '' : ' Il disparaîtra de tous les affichages.'))) return;
    contenu.sale.delete(p.id);
    await avantStructure();
    await retraitPro('panneaux', { id: 'eq.' + p.id });
    await afficher();
    dire('Panneau supprimé.');
  };

  const resume = resumePanneau(p);
  const ligne = el('details', { classe: 'ligne-panneau' + (p.actif ? '' : ' inactif'), 'data-panneau': p.id, open: contenu.ouverts.has(p.id),
    ontoggle: () => { ligne.open ? contenu.ouverts.add(p.id) : contenu.ouverts.delete(p.id); } },
    el('summary', null,
      modifiable ? el('span', { classe: 'poignee', title: 'Glisser pour changer l’ordre', 'aria-hidden': 'true' }, '⠿') : null,
      el('span', { classe: 'mini-type' }, VIGNETTES[p.type]()),
      el('span', { classe: 'nom-panneau' }, el('strong', null, TYPES[p.type].nom),
        resume ? el('span', { classe: 'doux' }, resume) : null,
        !p.affichage_id ? el('span', { classe: 'pastille' }, 'Tous les affichages') : null),
      el('span', { classe: 'doux duree' }, p.duree + ' s'),
      modifiable ? el('span', { classe: 'gestes' },
        el('label', { classe: 'interrupteur', title: 'Actif', onclick: (ev) => ev.stopPropagation() }, actif),
        geste('Monter', '↑', () => deplacer(-1), i === 0),
        geste('Descendre', '↓', () => deplacer(1), i === contenu.panneaux.length - 1),
        geste('Supprimer', '×', supprimer)) : null),
    el('div', { classe: 'corps-panneau' },
      champs.length ? el('div', { classe: 'champs' }, champs) : el('p', { classe: 'doux' }, TYPES[p.type].aide),
      el('details', { classe: 'plus' }, el('summary', null, 'Durée et horaire de diffusion'),
        el('div', { classe: 'champs' },
          el('label', null, 'Durée (secondes)', duree),
          el('label', null, 'De', debut), el('label', null, 'À', fin),
          el('div', { classe: 'large jours' }, jours),
          el('label', { classe: 'case large' }, tous, ' Sur tous les affichages de l’organisation')))));
  return ligne;
}

// --- Apparence (dans l'onglet Contenu) ---------------------------------------------
// Logo, couleur et thème de l'organisation, communs à tous ses affichages
// (admin seulement). L'aperçu les montre en direct.
function formulaireApparence() {
  const a = contenu.apparence;
  const admin = roleIci() === 'admin';
  const maj = () => { marquer('apparence'); rafraichirApercu(); };
  const apercuLogo = el('img', { classe: 'logo-apercu', src: a.logo || '', alt: '', hidden: !a.logo });
  const accent = el('input', { type: 'color', valeur: a.accent || '#1f6fff', disabled: !admin, oninput: () => { a.accent = accent.value; maj(); } });
  const theme = el('select', { disabled: !admin, onchange: () => { a.theme = theme.value; maj(); } },
    el('option', { value: 'sombre', selected: a.theme !== 'clair' }, 'Sombre (lisible de loin)'),
    el('option', { value: 'clair', selected: a.theme === 'clair' }, 'Clair'));
  return el('div', { classe: 'corps-section' },
    admin ? null : el('p', { classe: 'doux' }, 'Seul l’administrateur peut les changer.'),
    el('div', { classe: 'champs' },
      admin ? champMedia('Logo (PNG transparent ou SVG)', a.logo, 'image/png,image/svg+xml,image/webp', (u) => {
        a.logo = u || undefined; apercuLogo.src = u || ''; apercuLogo.hidden = !u; maj();
      }) : null,
      el('label', null, 'Couleur d’accent', accent),
      el('label', null, 'Thème', theme)),
    apercuLogo,
    (contenu.reglages.gabarit || 'plein') === 'plein' ? el('p', { classe: 'doux' }, 'Le logo paraît avec la disposition bandeau ou colonne.') : null);
}

// --- Vue Urgence -------------------------------------------------------------------
async function vueUrgence() {
  const org = etat.organisation;
  const [urgences, affichages, [o], etablissements] = await Promise.all([
    lirePro('urgences', { select: '*', organisation_id: 'eq.' + org, order: 'debut.desc', limit: 20 }),
    lirePro('affichages', { select: 'id,nom', organisation_id: 'eq.' + org, order: 'nom' }),
    lirePro('organisations', { select: 'id,alertes', id: 'eq.' + org }),
    lirePro('etablissements', { select: 'nom,latitude,longitude', organisation_id: 'eq.' + org }),
  ]);
  const maintenant = Date.now();
  const enCours = urgences.filter((u) => new Date(u.debut) <= maintenant && (!u.fin || new Date(u.fin) > maintenant));
  const nomAff = (id) => (id ? (affichages.find((a) => a.id === id) || {}).nom : 'Tous les affichages');
  const modifiable = peutModifier();

  const titre = el('input', { maxlength: 120, required: true, placeholder: 'ex. Évacuation' });
  const texte = el('textarea', { rows: 3, maxlength: 500, placeholder: 'ex. Dirigez-vous vers la sortie la plus proche.' });
  const cible = el('select', null, el('option', { value: '' }, 'Tous les affichages'),
    affichages.map((a) => el('option', { value: a.id }, a.nom)));
  const duree = el('select', null, el('option', { value: '' }, 'Jusqu’à ce qu’on la retire'),
    [[15, '15 minutes'], [60, '1 heure'], [240, '4 heures'], [1440, '24 heures']].map(([m, t]) => el('option', { value: m }, t)));

  return el('section', null,
    el('h2', null, 'Message d’urgence'),
    el('p', { classe: 'doux' }, 'Prend l’écran entier, par-dessus tout le reste, en 30 secondes au plus.'),
    enCours.length ? enCours.map((u) => el('div', { classe: 'fiche urgence-active' },
      el('strong', null, '● En cours : ' + u.titre),
      u.source === 'naad' ? el('span', { classe: 'pastille' }, 'En Alerte · ' + ((TYPES_ALERTES[u.type] || {}).nom || u.type)) : null, el('p', null, u.texte || ''),
      el('p', { classe: 'doux' }, nomAff(u.affichage_id) + (u.fin ? ' · jusqu’à ' + quand(u.fin) : ' · sans fin')),
      modifiable ? el('div', { classe: 'actions' }, el('button', { type: 'button', onclick: async () => {
        try { await majPro('urgences', { id: 'eq.' + u.id }, { fin: new Date().toISOString() }); await afficher(); dire('Message retiré.'); }
        catch (e) { dire(e.message, true); }
      } }, 'Retirer maintenant')) : null)) : el('p', { classe: 'fiche doux' }, 'Aucun message d’urgence en cours.'),
    modifiable ? el('form', { classe: 'carte-formulaire', onsubmit: async (ev) => {
        ev.preventDefault();
        if (!confirm('Diffuser « ' + titre.value.trim() + ' » sur ' + nomAff(cible.value || null).toLowerCase() + ' ?')) return;
        try {
          await ajoutPro('urgences', { organisation_id: org, affichage_id: cible.value || null, titre: titre.value.trim(),
            texte: texte.value.trim() || null, fin: duree.value ? new Date(Date.now() + duree.value * 60000).toISOString() : null });
          await afficher();
          dire('Message diffusé.');
        } catch (e) { dire(e.message, true); }
      } },
      el('h3', null, 'Diffuser un message'),
      el('div', { classe: 'champs' }, el('label', { classe: 'large' }, 'Titre', titre), el('label', { classe: 'large' }, 'Texte', texte),
        el('label', null, 'Où', cible), el('label', null, 'Durée', duree)),
      el('div', { classe: 'actions' }, el('button', { type: 'submit', classe: 'danger' }, 'Diffuser'))) : null,
    alertesPubliques(o, etablissements));
}

// --- Alertes publiques (En Alerte, flux NAAD) ---------------------------------------
const TYPES_ALERTES = {
  amber: { nom: 'Alerte AMBER', aide: 'Enlèvement d’enfant (Sûreté du Québec, SPVM). Fortement recommandé.' },
  immediat: { nom: 'Danger immédiat', aide: 'Alertes à diffuser immédiatement : tornade, évacuation, matières dangereuses…' },
  meteo_avertissement: { nom: 'Avertissements météo', aide: 'Phénomène dangereux en cours ou imminent (neige, pluie verglaçante, orage…).' },
  meteo_veille: { nom: 'Veilles météo', aide: 'Conditions favorables à un phénomène dangereux.' },
  meteo_avis: { nom: 'Avis météo', aide: 'Phénomène moins grave (brouillard, chaleur…). Fréquents.' },
  securite: { nom: 'Autres alertes civiles', aide: 'Qualité de l’air, avis d’eau, personne disparue, etc.' },
};

function alertesPubliques(o, etablissements) {
  const admin = roleIci() === 'admin';
  const choisis = new Set(((o && o.alertes) || {}).types || []);
  const sansPosition = etablissements.filter((e) => e.latitude == null || e.longitude == null);
  const cases = Object.entries(TYPES_ALERTES).map(([k, t]) => {
    const c = el('input', { type: 'checkbox', checked: choisis.has(k), disabled: !admin,
      onchange: () => { c.checked ? choisis.add(k) : choisis.delete(k); } });
    return el('label', { classe: 'case alerte-type' }, c, el('span', null, el('strong', null, t.nom), el('br'), el('span', { classe: 'doux' }, t.aide)));
  });
  return el('form', { classe: 'carte-formulaire', onsubmit: async (ev) => {
      ev.preventDefault();
      try {
        await majPro('organisations', { id: 'eq.' + o.id }, { alertes: { types: [...choisis] } });
        dire('Alertes publiques enregistrées.');
      } catch (e) { dire(e.message, true); }
    } },
    el('h3', null, 'Alertes publiques (En Alerte)'),
    el('p', { classe: 'doux' }, 'Les alertes officielles du système canadien En Alerte prennent l’écran entier, d’elles-mêmes, '
      + 'quand l’un de vos établissements est dans la zone visée, et s’effacent quand elles prennent fin. Délai : une à deux minutes. '
      + (admin ? '' : 'Seul l’administrateur de l’organisation peut les choisir.')),
    sansPosition.length ? el('p', { classe: 'erreur' }, 'Sans position, ces établissements ne recevront aucune alerte : '
      + sansPosition.map((e) => e.nom).join(', ') + '. Communiquez avec EspaceLigue pour la faire ajouter.') : null,
    el('div', { classe: 'alerte-types' }, cases),
    admin ? el('div', { classe: 'actions' }, el('button', { type: 'submit' }, 'Enregistrer')) : null);
}
