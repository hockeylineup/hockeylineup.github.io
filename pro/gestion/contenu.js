// EspaceLigue Pro · Gestion — contenu des affichages, apparence, urgences
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
  video: { nom: 'Vidéo', aide: 'Fichier MP4 ou flux en direct (.m3u8), sans le son.', duree: 30 },
  rss: { nom: 'Fil d’actualités', aide: 'Les manchettes d’un fil RSS (nouvelles, résultats sportifs).', duree: 15 },
  meteo: { nom: 'Météo', aide: 'Conditions et prévisions à l’adresse de l’établissement.', duree: 12 },
};
const JOURS = ['Dim', 'Lun', 'Mar', 'Mer', 'Jeu', 'Ven', 'Sam'];
const GABARITS = { plein: 'Plein écran', bandeau: 'Avec bandeau en bas', colonne: 'Avec colonne et bandeau' };

const contenu = { affichage: null, affichages: [], panneaux: [], reglages: {}, apparence: {}, minuterie: null };

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
    el('p', { classe: 'doux' }, 'Aperçu en direct, avec vos modifications non enregistrées ; chaque panneau y dure 8 s au plus.'));
}

// --- Vue Contenu -------------------------------------------------------------------
async function vueContenu() {
  const org = etat.organisation;
  const [affichages, etablissements, panneaux, orgs] = await Promise.all([
    lirePro('affichages', { select: 'id,nom,jeton,etablissement_id,reglages', organisation_id: 'eq.' + org, order: 'nom' }),
    lirePro('etablissements', { select: 'id,nom', organisation_id: 'eq.' + org }),
    lirePro('panneaux', { select: '*', organisation_id: 'eq.' + org, order: 'ordre,id' }),
    lirePro('organisations', { select: 'apparence', id: 'eq.' + org }),
  ]);
  contenu.affichages = affichages;
  contenu.apparence = (orgs[0] && orgs[0].apparence) || {};
  if (!affichages.length) return el('section', { classe: 'fiche' }, el('h2', null, 'Contenu des affichages'),
    el('p', { classe: 'doux' }, 'Aucun affichage pour l’instant. EspaceLigue les crée avec vous.'));
  if (!affichages.some((a) => a.id === contenu.affichage)) contenu.affichage = affichages[0].id;
  const af = affichages.find((a) => a.id === contenu.affichage);
  contenu.reglages = JSON.parse(JSON.stringify(af.reglages || {}));
  contenu.panneaux = panneaux.filter((p) => !p.affichage_id || p.affichage_id === af.id);
  const nomEtab = (id) => (etablissements.find((e) => e.id === id) || {}).nom || '';
  const modifiable = peutModifier();

  const choix = el('select', { onchange: () => { contenu.affichage = choix.value; afficher(); } },
    affichages.map((a) => el('option', { value: a.id, selected: a.id === af.id }, nomEtab(a.etablissement_id) + ' · ' + a.nom)));

  const vue = el('section', { classe: 'vue-contenu' },
    el('div', { classe: 'entete-vue' }, el('h2', null, 'Contenu des affichages'), el('label', { classe: 'choix-affichage' }, choix)),
    el('p', { classe: 'doux' }, 'Les panneaux défilent l’un après l’autre dans la zone principale. Un panneau sans contenu '
      + 'du moment (pointage sans match, plage horaire passée) est sauté. Sans aucun panneau, l’écran montre l’horaire.'),
    cadreApercu(),
    formulaireGabarit(af, modifiable),
    el('div', { classe: 'entete-vue' }, el('h3', null, 'Panneaux'),
      modifiable ? ajoutPanneau(af) : null),
    contenu.panneaux.length ? contenu.panneaux.map((p, i) => cartePanneau(p, i, af, modifiable))
      : el('p', { classe: 'doux fiche' }, 'Aucun panneau : l’écran montre l’horaire seul.'));
  chargerApercu().catch((e) => dire(e.message, true));
  return vue;
}

function formulaireGabarit(af, modifiable) {
  const r = contenu.reglages;
  r.bandeau = r.bandeau || {};
  r.colonne = r.colonne || {};
  const majR = () => { rafraichirApercu(); };
  const gabarit = el('select', { disabled: !modifiable, onchange: () => { r.gabarit = gabarit.value; zones(); majR(); } },
    Object.entries(GABARITS).map(([k, v]) => el('option', { value: k, selected: (r.gabarit || 'plein') === k }, v)));
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
  const blocBandeau = el('div', { classe: 'champs' }, el('label', null, 'Texte défilant', texte), el('label', null, 'Fil RSS défilant', rss));
  const blocColonne = el('div', { classe: 'champs' }, el('label', { classe: 'case' }, meteo, ' Météo dans la colonne'),
    el('div', { classe: 'large' }, el('span', { classe: 'doux' }, 'Commanditaires (un à la fois, 8 s chacun)'), logos));
  const zones = () => { blocBandeau.hidden = (r.gabarit || 'plein') === 'plein'; blocColonne.hidden = r.gabarit !== 'colonne'; };
  zones();

  return el('form', { classe: 'carte-formulaire', onsubmit: async (ev) => {
      ev.preventDefault();
      try {
        await majPro('affichages', { id: 'eq.' + af.id }, { reglages: r });
        af.reglages = JSON.parse(JSON.stringify(r));
        dire('Mise en page enregistrée. L’écran la prend dans les 30 secondes.');
      } catch (e) { dire(e.message, true); }
    } },
    el('h3', null, 'Mise en page'),
    el('div', { classe: 'champs' }, el('label', null, 'Gabarit', gabarit)),
    blocBandeau, blocColonne,
    modifiable ? el('div', { classe: 'actions' }, el('button', { type: 'submit' }, 'Enregistrer la mise en page')) : null);
}

function ajoutPanneau(af) {
  const type = el('select', null, Object.entries(TYPES).map(([k, t]) => el('option', { value: k }, t.nom)));
  return el('div', { classe: 'actions' }, type, el('button', { type: 'button', onclick: async () => {
    try {
      const ordre = contenu.panneaux.reduce((m, p) => Math.max(m, p.ordre), 0) + 10;
      await ajoutPro('panneaux', { organisation_id: etat.organisation, affichage_id: af.id, type: type.value,
        duree: TYPES[type.value].duree, ordre, actif: false });
      await afficher();
      dire('Panneau ajouté, inactif : remplissez-le, cochez « Actif » et enregistrez.');
    } catch (e) { dire(e.message, true); }
  } }, 'Ajouter un panneau'));
}

function cartePanneau(p, i, af, modifiable) {
  const c = p.contenu = p.contenu || {};
  const maj = () => rafraichirApercu();
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
    horaire: () => [el('label', null, 'Présentation', choixDe('piste', { '': 'Automatique', B: 'Un plateau en vedette', E: 'Tous les plateaux' }))],
    pointage: () => [],
    annonce: () => [el('label', { classe: 'large' }, 'Titre', entree('titre', { maxlength: 80 })),
      el('label', { classe: 'large' }, 'Texte', entree('texte', { zone: true, rows: 3, maxlength: 300 })),
      el('label', null, 'Couleur', entree('couleur', { type: 'color' })),
      champMedia('Image (facultative)', c.image, 'image/*', (u) => { c.image = u || undefined; maj(); })],
    image: () => [champMedia('Image', c.url, 'image/*', (u) => { c.url = u; maj(); }),
      el('label', null, 'Cadrage', choixDe('ajustement', { '': 'Image entière', cover: 'Remplir l’écran' }))],
    video: () => [champMedia('Vidéo (MP4 ou .m3u8)', c.url, 'video/mp4', (u) => { c.url = u; maj(); }),
      el('label', null, 'Cadrage', choixDe('ajustement', { '': 'Image entière', cover: 'Remplir l’écran' }))],
    rss: () => [el('label', { classe: 'large' }, 'Adresse du fil', entree('url', { placeholder: 'https://ici.radio-canada.ca/rss/…' })),
      el('label', null, 'Titre affiché', entree('titre', { placeholder: 'ex. Sports' })),
      el('label', null, 'Manchettes', entree('nombre', { type: 'number', min: 1, max: 5, placeholder: '3' }))],
    meteo: () => [],
  }[p.type]();

  const duree = el('input', { type: 'number', min: 5, max: 600, valeur: p.duree, disabled: !modifiable,
    oninput: () => { p.duree = Number(duree.value) || 15; maj(); } });
  const actif = el('input', { type: 'checkbox', checked: p.actif, disabled: !modifiable, onchange: () => { p.actif = actif.checked; maj(); } });
  const tous = el('input', { type: 'checkbox', checked: !p.affichage_id, disabled: !modifiable });
  const jours = JOURS.map((j, n) => el('label', { classe: 'jour' },
    el('input', { type: 'checkbox', checked: !p.jours || p.jours.includes(n), disabled: !modifiable }), j));
  const debut = el('input', { type: 'time', valeur: (p.heure_debut || '').slice(0, 5), disabled: !modifiable });
  const fin = el('input', { type: 'time', valeur: (p.heure_fin || '').slice(0, 5), disabled: !modifiable });

  const deplacer = async (sens) => {
    const autre = contenu.panneaux[i + sens];
    if (!autre) return;
    try {
      await Promise.all([majPro('panneaux', { id: 'eq.' + p.id }, { ordre: autre.ordre === p.ordre ? autre.ordre + sens : autre.ordre }),
        majPro('panneaux', { id: 'eq.' + autre.id }, { ordre: p.ordre })]);
      await afficher();
    } catch (e) { dire(e.message, true); }
  };

  return el('form', { classe: 'carte-formulaire panneau' + (p.actif ? '' : ' inactif'), onsubmit: async (ev) => {
      ev.preventDefault();
      const coches = jours.map((j, n) => (j.firstChild.checked ? n : -1)).filter((n) => n >= 0);
      try {
        await majPro('panneaux', { id: 'eq.' + p.id }, {
          contenu: c, duree: p.duree, actif: p.actif, affichage_id: tous.checked ? null : af.id,
          jours: coches.length === 7 ? null : coches, heure_debut: debut.value || null, heure_fin: fin.value || null });
        await afficher();
        dire('Panneau enregistré. L’écran le prend dans les 30 secondes.');
      } catch (e) { dire(e.message, true); }
    } },
    el('div', { classe: 'tete-lecteur' },
      el('div', null, el('strong', null, TYPES[p.type].nom), ' ',
        p.actif ? el('span', { classe: 'pastille vert-fond' }, 'Actif') : el('span', { classe: 'pastille' }, 'Inactif'),
        !p.affichage_id ? el('span', { classe: 'pastille' }, 'Tous les affichages') : null,
        el('div', { classe: 'doux' }, TYPES[p.type].aide)),
      modifiable ? el('div', { classe: 'actions' },
        el('button', { type: 'button', classe: 'discret', title: 'Monter', disabled: i === 0, onclick: () => deplacer(-1) }, '↑'),
        el('button', { type: 'button', classe: 'discret', title: 'Descendre', disabled: i === contenu.panneaux.length - 1, onclick: () => deplacer(1) }, '↓')) : null),
    champs.length ? el('div', { classe: 'champs' }, champs) : null,
    el('details', null, el('summary', null, 'Durée, plage horaire, portée'),
      el('div', { classe: 'champs' },
        el('label', null, 'Durée (secondes)', duree),
        el('label', null, 'De', debut), el('label', null, 'À', fin),
        el('div', { classe: 'large jours' }, jours),
        el('label', { classe: 'case large' }, tous, ' Sur tous les affichages de l’organisation'))),
    modifiable ? el('div', { classe: 'actions' },
      el('label', { classe: 'case' }, actif, ' Actif'),
      el('button', { type: 'submit' }, 'Enregistrer'),
      el('button', { type: 'button', classe: 'discret', onclick: async () => {
        if (!confirm('Supprimer ce panneau ?' + (p.affichage_id ? '' : ' Il disparaîtra de tous les affichages.'))) return;
        try { await retraitPro('panneaux', { id: 'eq.' + p.id }); await afficher(); dire('Panneau supprimé.'); }
        catch (e) { dire(e.message, true); }
      } }, 'Supprimer')) : null);
}

// --- Vue Apparence ---------------------------------------------------------------
async function vueApparence() {
  const [o] = await lirePro('organisations', { select: 'id,nom,apparence', id: 'eq.' + etat.organisation });
  const a = Object.assign({}, o.apparence || {});
  const admin = roleIci() === 'admin';
  const apercuLogo = el('img', { classe: 'logo-apercu', src: a.logo || '', alt: '', hidden: !a.logo });
  const accent = el('input', { type: 'color', valeur: a.accent || '#1f6fff', disabled: !admin, oninput: () => { a.accent = accent.value; } });
  const theme = el('select', { disabled: !admin, onchange: () => { a.theme = theme.value; } },
    el('option', { value: 'sombre', selected: a.theme !== 'clair' }, 'Sombre (recommandé, lisible de loin)'),
    el('option', { value: 'clair', selected: a.theme === 'clair' }, 'Clair'));
  return el('section', null,
    el('h2', null, 'Apparence'),
    el('p', { classe: 'doux' }, 'Votre logo et votre couleur, sur tous vos affichages. '
      + (admin ? '' : 'Seul l’administrateur de l’organisation peut les changer.')),
    el('form', { classe: 'carte-formulaire', onsubmit: async (ev) => {
        ev.preventDefault();
        try {
          await majPro('organisations', { id: 'eq.' + o.id }, { apparence: a });
          dire('Apparence enregistrée. Les écrans la prennent dans les 30 secondes.');
        } catch (e) { dire(e.message, true); }
      } },
      el('div', { classe: 'champs' },
        admin ? champMedia('Logo (PNG transparent ou SVG)', a.logo, 'image/png,image/svg+xml,image/webp', (u) => {
          a.logo = u || undefined; apercuLogo.src = u || ''; apercuLogo.hidden = !u;
        }) : null,
        el('label', null, 'Couleur d’accent', accent),
        el('label', null, 'Thème', theme)),
      apercuLogo,
      admin ? el('div', { classe: 'actions' }, el('button', { type: 'submit' }, 'Enregistrer')) : null));
}

// --- Vue Urgence -------------------------------------------------------------------
async function vueUrgence() {
  const org = etat.organisation;
  const [urgences, affichages] = await Promise.all([
    lirePro('urgences', { select: '*', organisation_id: 'eq.' + org, order: 'debut.desc', limit: 20 }),
    lirePro('affichages', { select: 'id,nom', organisation_id: 'eq.' + org, order: 'nom' }),
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
      el('strong', null, '● En cours : ' + u.titre), el('p', null, u.texte || ''),
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
      el('div', { classe: 'actions' }, el('button', { type: 'submit', classe: 'danger' }, 'Diffuser'))) : null);
}
