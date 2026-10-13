// EspaceLigue Pro · Gestion — l'onglet Planification : l'horaire maître
// (docs/planification.md d'espaceligue-pro). Chargé après horaire.js, dont il
// reprend les outils de dates, les calendriers iCal et la glace d'un match.
//
// Vue Jour : une colonne par plateau de l'établissement. Vue Semaine : sept
// colonnes pour un plateau. On glisse sur une case vide pour réserver, on
// glisse un bloc pour le déplacer, on tire son bord bas pour changer sa durée
// (pas de 15 minutes). La base tranche les chevauchements (exclusion et
// sections de gymnase) ; un refus remet le bloc en place.
//
// Le resurfaçage est compris dans la réservation : la bande au bas d'un bloc
// de glace, comptée par pro.surfacages. Les blocs EspaceLigue et calendrier
// ne se glissent pas : ils reviendraient de la source.
'use strict';

// Le CSP du site refuse l'attribut style : on passe par l'objet style.
const st = (n, css) => { n.style.cssText = css; return n; };

const plan = { vue: 'jour', date: null, etab: null, plateau: null, client: '', sous: 'grille', panneau: null };
const PAS = 15;          // minutes
const PX_MIN = 1.1;      // pixels par minute
const ETATS = { confirmee: 'Confirmée', option: 'Option', demandee: 'En conflit', annulee: 'Annulée' };
const JOURS_ISO = ['Lun', 'Mar', 'Mer', 'Jeu', 'Ven', 'Sam', 'Dim'];
const CLES_JOURS = ['lun', 'mar', 'mer', 'jeu', 'ven', 'sam', 'dim'];

const debutJour = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
const ajouterJours = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
const minutesDe = (d, jour) => (d - jour) / 60000;
const arrondir = (m) => Math.round(m / PAS) * PAS;
const aHeure = (jour, minutes) => new Date(jour.getTime() + minutes * 60000);
const isoJour = (d) => (d.getDay() + 6) % 7;  // 0 = lundi

function monRole() { return roleIci(); }
function mesPermissions() { return (etat.membres.find((m) => m.organisation_id === etat.organisation) || {}).permissions || []; }
const peutReserver = () => peutModifier() || mesPermissions().includes('reserver');
const peutChanger = () => peutModifier() || mesPermissions().includes('modifier');

function messageRefus(e) {
  return /chevauch|exclusion|conflicting key|déjà pris/i.test(e.message)
    ? (e.message.includes('gymnase') ? e.message : 'Ce plateau est déjà réservé à ce moment-là.') : e.message;
}

async function vuePlanification() {
  const org = etat.organisation;
  const [etablissements, plateaux, locataires] = await Promise.all([
    lirePro('etablissements', { select: 'id,nom,heures,fuseau', organisation_id: 'eq.' + org, order: 'nom' }),
    lirePro('plateaux', { select: 'id,nom,etablissement_id,type,surfacage,parent_id', organisation_id: 'eq.' + org,
      actif: 'is.true', order: 'nom' }),
    lirePro('locataires', { select: 'id,nom,type,telephone,courriel,actif', organisation_id: 'eq.' + org, order: 'nom' }),
  ]);
  const onglets = el('div', { classe: 'puces sous-onglets' }, [['grille', 'Horaire'], ['clients', 'Clients'], ['sources', 'Sources automatiques']]
    .map(([k, v]) => el('button', { type: 'button', classe: plan.sous === k ? 'actif' : null,
      onclick: () => { plan.sous = k; plan.panneau = null; afficher(); } }, v)));
  const entete = el('div', { classe: 'entete-vue' }, el('h2', null, 'Planification'), onglets);

  if (plan.sous === 'clients') return el('section', { classe: 'vue-planif' }, entete, await vueClients(locataires));
  if (plan.sous === 'sources') {
    const nomEtab = (id) => (etablissements.find((e) => e.id === id) || {}).nom || '';
    return el('section', { classe: 'vue-planif' }, entete, await blocCalendriers(plateaux, nomEtab, peutModifier()));
  }
  if (!plateaux.length) return el('section', { classe: 'vue-planif' }, entete,
    el('p', { classe: 'doux' }, 'Aucun plateau : ajoutez-en dans l’onglet Établissement.'));

  if (!etablissements.some((e) => e.id === plan.etab)) plan.etab = etablissements[0].id;
  const etab = etablissements.find((e) => e.id === plan.etab);
  // Le gymnase entier, puis ses sections ; les autres par nom.
  const ordre = (p) => { const parent = p.parent_id ? plateaux.find((x) => x.id === p.parent_id) : p; return parent.nom + (p.parent_id ? ' ~' + p.nom : ''); };
  const plEtab = plateaux.filter((p) => p.etablissement_id === etab.id).sort((a, b) => ordre(a).localeCompare(ordre(b), 'fr', { numeric: true }));
  if (!plEtab.some((p) => p.id === plan.plateau)) plan.plateau = plEtab[0] ? plEtab[0].id : null;
  if (!plan.date) plan.date = debutJour(new Date());

  const premier = plan.vue === 'jour' ? plan.date : lundiDe(plan.date);
  const nbJours = plan.vue === 'jour' ? 1 : 7;
  const dernier = ajouterJours(premier, nbJours);
  const ids = plan.vue === 'jour' ? plEtab.map((p) => p.id) : [plan.plateau];
  // En vue Semaine, un gymnase entier ou une section montre aussi ce qui bloque l'autre.
  const lies = plan.vue === 'semaine' ? plateaux.filter((p) => p.id === (plateaux.find((x) => x.id === plan.plateau) || {}).parent_id
    || p.parent_id === plan.plateau).map((p) => p.id) : [];
  const [reservations, surf] = await Promise.all([
    ids.length ? lirePro('reservations', {
      select: 'id,periode,titre,statut,source,serie_id,locataire_id,plateau_id,match_id,option_jusqu,surfacage,note,modifie_le,locataires(nom),calendriers(nom)',
      plateau_id: 'in.(' + ids.concat(lies).join(',') + ')', periode: 'ov.' + plage(premier, dernier), statut: 'neq.annulee', order: 'periode' }) : [],
    rest('POST', 'rpc/surfacages', { p_organisation: org, p_du: aaaammjj(premier), p_au: aaaammjj(ajouterJours(dernier, -1)) }, PRO)
      .catch(() => []),
  ]);
  const plIds = new Set(plEtab.map((p) => p.id));
  const surfEtab = surf.filter((s) => plIds.has(s.plateau_id));

  // Colonnes : { cle, titre, jour, plateau }.
  const colonnes = plan.vue === 'jour'
    ? plEtab.map((p) => ({ cle: p.id, titre: p.nom, sous: p.parent_id ? 'section' : (p.surfacage ? '' : ''), jour: plan.date, plateau: p }))
    : Array.from({ length: 7 }, (_, i) => { const j = ajouterJours(premier, i);
      return { cle: aaaammjj(j), titre: j.toLocaleDateString('fr-CA', { weekday: 'short', day: 'numeric' }), jour: j,
        plateau: plEtab.find((p) => p.id === plan.plateau) }; });

  // Heures montrées : l'ouverture la plus tôt et la fermeture la plus tard des jours affichés,
  // élargies à ce qui est réservé ; 6 h à 23 h sans heures connues.
  const heures = etab.heures || {};
  let deb = 24 * 60, fin = 0;
  for (const c of colonnes) {
    const h = heures[CLES_JOURS[isoJour(c.jour)]];
    if (h) { deb = Math.min(deb, minutesTexte(h.ouvre)); fin = Math.max(fin, minutesTexte(h.ferme) || 24 * 60); }
  }
  if (deb >= fin) { deb = 6 * 60; fin = 23 * 60; }
  for (const r of reservations) {
    const [a, b] = bornes(r.periode);
    const j = debutJour(a);
    deb = Math.min(deb, Math.max(0, Math.floor(minutesDe(a, j) / 60) * 60));
    fin = Math.max(fin, Math.min(24 * 60, Math.ceil(minutesDe(b, j) / 60) * 60));
  }
  deb = Math.floor(deb / 60) * 60; fin = Math.ceil(fin / 60) * 60;
  const ctx = { deb, fin, colonnes, reservations, plateaux, locataires, etab, surf: surfEtab };

  const nav = (n) => () => { plan.date = ajouterJours(plan.date, n * nbJours); plan.panneau = null; afficher(); };
  const dateChamp = el('input', { type: 'date', valeur: aaaammjj(plan.date), onchange: (ev) => {
    if (!ev.target.value) return; const [y, m, d] = ev.target.value.split('-').map(Number); plan.date = new Date(y, m - 1, d); afficher(); } });
  const titrePeriode = plan.vue === 'jour'
    ? plan.date.toLocaleDateString('fr-CA', { weekday: 'long', day: 'numeric', month: 'long' })
    : 'Semaine du ' + premier.toLocaleDateString('fr-CA', { day: 'numeric', month: 'long' });
  const nbSurf = surfEtab.reduce((n, s) => n + s.nombre, 0);
  const barre = el('div', { classe: 'barre-planif' },
    el('div', { classe: 'groupe' },
      el('button', { type: 'button', classe: 'discret', onclick: nav(-1), title: 'Précédent' }, '‹'),
      el('button', { type: 'button', classe: 'discret', onclick: () => { plan.date = debutJour(new Date()); afficher(); } }, 'Aujourd’hui'),
      el('button', { type: 'button', classe: 'discret', onclick: nav(1), title: 'Suivant' }, '›'),
      el('strong', { classe: 'periode' }, titrePeriode), dateChamp),
    el('div', { classe: 'groupe' },
      el('div', { classe: 'bascule' }, [['jour', 'Jour'], ['semaine', 'Semaine']].map(([k, v]) =>
        el('button', { type: 'button', classe: plan.vue === k ? 'actif' : 'discret', onclick: () => { plan.vue = k; afficher(); } }, v))),
      plan.vue === 'semaine' ? el('select', { onchange: (ev) => { plan.plateau = ev.target.value; afficher(); } },
        plEtab.map((p) => el('option', { value: p.id, selected: p.id === plan.plateau }, p.nom))) : null,
      etablissements.length > 1 ? el('select', { onchange: (ev) => { plan.etab = ev.target.value; afficher(); } },
        etablissements.map((e) => el('option', { value: e.id, selected: e.id === plan.etab }, e.nom))) : null,
      el('select', { title: 'Filtrer par client', onchange: (ev) => { plan.client = ev.target.value; afficher(); } },
        el('option', { value: '' }, 'Tous les clients'),
        locataires.map((l) => el('option', { value: l.id, selected: l.id === plan.client }, l.nom))),
      peutReserver() ? el('button', { type: 'button', onclick: () => {
        const j = plan.vue === 'jour' ? plan.date : debutJour(new Date());
        ouvrirPanneau({ nouveau: true, plateau: plan.vue === 'jour' ? (plEtab[0] || {}).id : plan.plateau,
          debut: aHeure(j, 18 * 60), fin: aHeure(j, 19 * 60 + 30) }); } }, '+ Réserver') : null),
    nbSurf ? el('div', { classe: 'compte-surfacage', title: 'Resurfaçages compris dans les réservations' },
      '❄ ' + nbSurf + ' resurfaçage' + (nbSurf > 1 ? 's' : '') + (plan.vue === 'jour' ? ' ce jour' : ' cette semaine')) : null);

  return el('section', { classe: 'vue-planif' }, entete, barre,
    el('div', { classe: 'planif-corps' + (plan.panneau ? ' avec-panneau' : '') }, grille(ctx),
      plan.panneau ? panneau(ctx) : null),
    plan.vue === 'semaine' && nbSurf ? tableauSurfacages(ctx, premier) : null);
}

function minutesTexte(t) { if (!t) return 0; const [h, m] = t.split(':').map(Number); return h * 60 + m; }

// --- La grille -----------------------------------------------------------------------
function grille(ctx) {
  const haut = (ctx.fin - ctx.deb) * PX_MIN;
  const regle = st(el('div', { classe: 'regle' }), `height:${haut}px`);
  for (let m = ctx.deb; m < ctx.fin; m += 60) {
    regle.append(st(el('div', { classe: 'heure' }, String(m / 60).padStart(2, '0') + ' h'), `top:${(m - ctx.deb) * PX_MIN}px`));
  }
  const cols = ctx.colonnes.map((c) => colonne(ctx, c, haut));
  const tetes = ctx.colonnes.map((c) => {
    const n = ctx.surf.filter((s) => s.plateau_id === c.plateau.id && s.jour === aaaammjj(c.jour)).reduce((x, s) => x + s.nombre, 0);
    return el('div', { classe: 'tete-col' + (aaaammjj(c.jour) === aaaammjj(new Date()) && plan.vue === 'semaine' ? ' aujourdhui' : '') },
      el('strong', null, c.titre), c.plateau.parent_id && plan.vue === 'jour' ? el('span', { classe: 'doux' }, ' section') : null,
      n ? el('span', { classe: 'doux surf' }, ' ❄ ' + n) : null);
  });
  const gabarit = `56px repeat(${ctx.colonnes.length}, minmax(120px, 1fr))`;
  return el('div', { classe: 'grille-planif' },
    st(el('div', { classe: 'tetes' }, el('div'), ...tetes), `grid-template-columns:${gabarit}`),
    st(el('div', { classe: 'corps' }, regle, ...cols), `grid-template-columns:${gabarit}`));
}

function colonne(ctx, c, haut) {
  const col = st(el('div', { classe: 'col' }), `height:${haut}px`);
  col.dataset.cle = c.cle;
  col.colonne = c;
  // Hors des heures d'ouverture : grisé.
  const h = (ctx.etab.heures || {})[CLES_JOURS[isoJour(c.jour)]];
  const ouvre = h ? minutesTexte(h.ouvre) : null, ferme = h ? (minutesTexte(h.ferme) || 24 * 60) : null;
  const ferme1 = h ? [[ctx.deb, ouvre], [ferme, ctx.fin]] : [[ctx.deb, ctx.fin]];
  for (const [a, b] of ferme1) if (b > a) col.append(st(el('div', { classe: 'hors-heures' }), `top:${(Math.max(a, ctx.deb) - ctx.deb) * PX_MIN}px;height:${(Math.min(b, ctx.fin) - Math.max(a, ctx.deb)) * PX_MIN}px`));
  for (let m = ctx.deb; m < ctx.fin; m += 60) col.append(st(el('div', { classe: 'trait' }), `top:${(m - ctx.deb) * PX_MIN}px`));
  // Maintenant.
  const now = new Date();
  if (aaaammjj(now) === aaaammjj(c.jour)) {
    const m = minutesDe(now, c.jour);
    if (m >= ctx.deb && m <= ctx.fin) col.append(st(el('div', { classe: 'maintenant' }), `top:${(m - ctx.deb) * PX_MIN}px`));
  }

  // Les réservations de cette colonne, et celles d'un gymnase lié (en fantôme).
  const pl = c.plateau;
  const duJour = (r) => { const [a, b] = bornes(r.periode); return a < ajouterJours(c.jour, 1) && b > c.jour; };
  const siennes = ctx.reservations.filter((r) => r.plateau_id === pl.id && duJour(r))
    .sort((x, y) => bornes(x.periode)[0] - bornes(y.periode)[0]);
  const fantomes = ctx.reservations.filter((r) => r.plateau_id !== pl.id && duJour(r) && (r.plateau_id === pl.parent_id
    || (ctx.plateaux.find((p) => p.id === r.plateau_id) || {}).parent_id === pl.id) && r.statut !== 'demandee');
  // Couloirs : des blocs qui se chevauchent (une demande en conflit) se partagent la
  // largeur, groupe par groupe ; les autres gardent toute la colonne.
  const place = [];
  let groupe = [], finGroupe = 0;
  const fermerGroupe = () => { const n = Math.max(...groupe.map((x) => x[1])) + 1; groupe.forEach((x) => { x[2] = n; place.push(x); }); groupe = []; };
  for (const r of siennes) {
    const [a, b] = bornes(r.periode);
    if (groupe.length && a >= finGroupe) fermerGroupe();
    const pris = groupe.filter((x) => bornes(x[0].periode)[1] > a).map((x) => x[1]);
    let i = 0; while (pris.includes(i)) i++;
    groupe.push([r, i, 1]);
    finGroupe = Math.max(finGroupe, b);
  }
  if (groupe.length) fermerGroupe();
  for (const r of fantomes) col.append(bloc(ctx, c, r, 0, 1, true));
  for (const [r, i, n] of place) col.append(bloc(ctx, c, r, i, n, false));

  if (peutReserver()) col.addEventListener('pointerdown', (ev) => selectionner(ev, ctx, col));
  return col;
}

function bloc(ctx, c, r, couloir, nbCouloirs, fantome) {
  const [a, b] = bornes(r.periode);
  const top = Math.max(minutesDe(a, c.jour), ctx.deb), bas = Math.min(minutesDe(b, c.jour), ctx.fin);
  const pl = ctx.plateaux.find((p) => p.id === r.plateau_id) || {};
  const client = (r.locataires || {}).nom || '';
  const filtre = plan.client && r.locataire_id !== plan.client;
  const classes = ['bloc', 'etat-' + r.statut, 'src-' + r.source];
  if (fantome) classes.push('fantome');
  if (filtre) classes.push('estompe');
  if (plan.panneau && plan.panneau.id === r.id) classes.push('choisi');
  const d = st(el('div', { classe: classes.join(' ') },
    el('div', { classe: 'b-titre' }, (r.serie_id ? '↻ ' : '') + (fantome ? pl.nom + ' · ' : '') + (r.titre || client || 'Réservé')),
    el('div', { classe: 'b-heure' }, hhmm(a) + '–' + hhmm(b) + (client && r.titre ? ' · ' + client : '')),
    r.statut === 'option' ? el('div', { classe: 'b-etat' }, 'Option' + (r.option_jusqu ? ' → ' + new Date(r.option_jusqu)
      .toLocaleDateString('fr-CA', { day: 'numeric', month: 'short' }) : '')) : null,
    r.statut === 'demandee' ? el('div', { classe: 'b-etat' }, 'En conflit') : null), `top:${(top - ctx.deb) * PX_MIN}px;height:${Math.max(14, (bas - top) * PX_MIN)}px;`
      + `left:calc(${(couloir / nbCouloirs) * 100}% + 2px);width:calc(${100 / nbCouloirs}% - 4px)`);
  // Resurfaçage : les dernières minutes du bloc.
  if (!fantome && r.surfacage && pl.surfacage && minutesDe(b, c.jour) <= ctx.fin) {
    d.append(st(el('div', { classe: 'b-surf', title: 'Resurfaçage compris' }, '❄'), `height:${pl.surfacage * PX_MIN}px`));
  }
  if (fantome) return d;
  d.reservation = r;
  d.addEventListener('pointerdown', (ev) => { ev.stopPropagation(); saisirBloc(ev, ctx, d, c); });
  if (r.source === 'manuel' && peutChanger() && (peutModifier() || !r.serie_id)) {
    d.classList.add('mobile');
    d.append(el('div', { classe: 'poignee', title: 'Changer la durée' }));
  }
  return d;
}

// Glisser sur une case vide : nouvelle réservation.
function selectionner(ev, ctx, col) {
  if (ev.button !== 0 || ev.pointerType === 'touch') {
    if (ev.pointerType === 'touch') {  // un toucher : 1 h 30 à partir de la case touchée
      const m = arrondir(ctx.deb + (ev.clientY - col.getBoundingClientRect().top) / PX_MIN);
      const c = col.colonne;
      ouvrirPanneau({ nouveau: true, plateau: c.plateau.id, debut: aHeure(c.jour, m), fin: aHeure(c.jour, m + 90) });
    }
    return;
  }
  ev.preventDefault();
  const rect = col.getBoundingClientRect();
  const m0 = Math.floor((ctx.deb + (ev.clientY - rect.top) / PX_MIN) / PAS) * PAS;
  const sel = el('div', { classe: 'selection' });
  col.append(sel);
  let m1 = m0 + PAS;
  const dessiner = () => {
    const a = Math.min(m0, m1), b = Math.max(m0 + PAS, m1);
    sel.style.top = (a - ctx.deb) * PX_MIN + 'px';
    sel.style.height = (b - a) * PX_MIN + 'px';
    sel.textContent = hhmm(aHeure(col.colonne.jour, a)) + ' – ' + hhmm(aHeure(col.colonne.jour, b));
  };
  dessiner();
  const bouger = (e) => { m1 = Math.max(ctx.deb, Math.min(ctx.fin, Math.ceil((ctx.deb + (e.clientY - rect.top) / PX_MIN) / PAS) * PAS)); dessiner(); };
  const lacher = () => {
    document.removeEventListener('pointermove', bouger);
    document.removeEventListener('pointerup', lacher);
    const a = Math.min(m0, m1), b = Math.max(m0 + PAS, m1);
    const c = col.colonne;
    // Un simple clic : 1 h 30, la plage habituelle d'une glace.
    ouvrirPanneau({ nouveau: true, plateau: c.plateau.id, debut: aHeure(c.jour, a),
      fin: aHeure(c.jour, b - a <= PAS ? a + 90 : b) });
  };
  document.addEventListener('pointermove', bouger);
  document.addEventListener('pointerup', lacher);
}

// Un bloc : un clic ouvre le panneau ; glisser le déplace ; la poignée change sa durée.
function saisirBloc(ev, ctx, d, c) {
  const r = d.reservation;
  if (ev.button !== 0 || ev.pointerType === 'touch' || !d.classList.contains('mobile')) {
    ouvrirPanneau({ id: r.id }); return;
  }
  ev.preventDefault();
  const etirer = ev.target.classList.contains('poignee');
  const [a, b] = bornes(r.periode);
  const x0 = ev.clientX, y0 = ev.clientY;
  const top0 = parseFloat(d.style.top), haut0 = parseFloat(d.style.height);
  let bouge = false, dm = 0, cible = d.parentElement;
  const bouger = (e) => {
    if (!bouge && Math.abs(e.clientY - y0) < 4 && Math.abs(e.clientX - x0) < 4) return;
    bouge = true;
    d.classList.add('en-mouvement');
    dm = arrondir((e.clientY - y0) / PX_MIN);
    if (etirer) { d.style.height = Math.max(PAS * PX_MIN, haut0 + dm * PX_MIN) + 'px'; return; }
    d.style.top = top0 + dm * PX_MIN + 'px';
    // Changer de colonne : celle sous le pointeur.
    const sous = document.elementsFromPoint(e.clientX, e.clientY).find((x) => x.classList && x.classList.contains('col'));
    if (sous && sous !== cible) { cible = sous; cible.append(d); }
  };
  const lacher = async () => {
    document.removeEventListener('pointermove', bouger);
    document.removeEventListener('pointerup', lacher);
    if (!bouge) { ouvrirPanneau({ id: r.id }); return; }
    const c2 = cible.colonne;
    const decal = (c2.jour - c.jour) + dm * 60000;
    const na = etirer ? a : new Date(a.getTime() + decal);
    const nb = etirer ? new Date(Math.max(a.getTime() + PAS * 60000, b.getTime() + dm * 60000)) : new Date(b.getTime() + decal);
    const corps = { periode: plage(na, nb) };
    if (!etirer && c2.plateau.id !== r.plateau_id) corps.plateau_id = c2.plateau.id;
    try {
      await majPro('reservations', { id: 'eq.' + r.id }, corps);
      dire((etirer ? 'Durée changée : ' : 'Déplacée : ') + hhmm(na) + ' – ' + hhmm(nb) + (corps.plateau_id ? ' · ' + c2.plateau.nom : '') + '.');
    } catch (e) { dire(messageRefus(e), true); }
    await afficher();
  };
  document.addEventListener('pointermove', bouger);
  document.addEventListener('pointerup', lacher);
}

function ouvrirPanneau(p) { plan.panneau = p; afficher(); }

// --- Le panneau latéral ---------------------------------------------------------------
function panneau(ctx) {
  const p = plan.panneau;
  const r = p.id ? ctx.reservations.find((x) => x.id === p.id) : null;
  if (p.id && !r) { plan.panneau = null; return null; }
  const fermer = el('button', { type: 'button', classe: 'discret fermer', title: 'Fermer',
    onclick: () => { plan.panneau = null; afficher(); } }, '×');
  if (r && r.source !== 'manuel') return panneauImporte(ctx, r, fermer);

  const modifiable = r ? peutChanger() && (peutModifier() || !r.serie_id) : peutReserver();
  const [a, b] = r ? bornes(r.periode) : [p.debut, p.fin];
  const plats = ctx.plateaux.filter((x) => x.etablissement_id === ctx.etab.id);
  const plateau = el('select', { disabled: !modifiable }, plats.map((x) =>
    el('option', { value: x.id, selected: x.id === (r ? r.plateau_id : p.plateau) }, x.nom + (x.parent_id ? ' (section)' : ''))));
  const date = el('input', { type: 'date', required: true, valeur: aaaammjj(a), disabled: !modifiable });
  const debut = el('input', { type: 'time', step: PAS * 60, required: true, valeur: hhmm(a), disabled: !modifiable });
  const fin = el('input', { type: 'time', step: PAS * 60, required: true, valeur: hhmm(b), disabled: !modifiable });
  const titre = el('input', { maxlength: 160, placeholder: 'Affiché à l’écran', valeur: r ? r.titre || '' : '', disabled: !modifiable });
  const liste = el('datalist', { id: 'clients-planif' }, ctx.locataires.filter((l) => l.actif !== false).map((l) => el('option', { value: l.nom })));
  const client = el('input', { list: 'clients-planif', placeholder: 'Nom du client', disabled: !modifiable,
    valeur: r ? (r.locataires || {}).nom || '' : (ctx.locataires.find((l) => l.id === plan.client) || {}).nom || '' });
  const note = el('textarea', { rows: 2, placeholder: 'Note interne', disabled: !modifiable }, r ? r.note || '' : '');
  const surfacage = el('input', { type: 'checkbox', checked: r ? r.surfacage : true, disabled: !modifiable });
  const plSel = () => ctx.plateaux.find((x) => x.id === plateau.value) || {};
  const ligneSurf = el('label', { classe: 'case' }, surfacage, 'Resurfaçage compris');
  const majSurf = () => { ligneSurf.hidden = !plSel().surfacage; ligneSurf.lastChild.textContent = `Resurfaçage compris (${plSel().surfacage} min à la fin)`; };
  plateau.addEventListener('change', majSurf);
  majSurf();

  // État : confirmée ou option (admin et gestionnaire).
  const statut = el('select', { disabled: !modifiable || !peutModifier() },
    el('option', { value: 'confirmee', selected: !r || r.statut === 'confirmee' }, 'Confirmée'),
    el('option', { value: 'option', selected: r && r.statut === 'option' }, 'Option (en attente du client)'),
    r && r.statut === 'demandee' ? el('option', { value: 'demandee', selected: true }, 'En conflit (pas à l’écran)') : null);
  const echeance = el('input', { type: 'date', valeur: r && r.option_jusqu ? aaaammjj(new Date(r.option_jusqu)) : aaaammjj(ajouterJours(new Date(), 7)) });
  const ligneEcheance = el('label', null, 'Option jusqu’au', echeance);
  const majStatut = () => { ligneEcheance.hidden = statut.value !== 'option'; };
  statut.addEventListener('change', majStatut);
  majStatut();

  // Répéter (nouvelle réservation, admin et gestionnaire).
  const repeter = el('select', null, el('option', { value: '0' }, 'Une seule fois'),
    el('option', { value: '1' }, 'Chaque semaine'), el('option', { value: '2' }, 'Aux deux semaines'));
  const jours = JOURS_ISO.map((j, i) => { const x = el('input', { type: 'checkbox', checked: i === isoJour(a) }); x.jour = i + 1;
    return { x, lab: el('label', { classe: 'jour' }, x, j) }; });
  const jusquau = el('input', { type: 'date', valeur: aaaammjj(ajouterJours(a, 7 * 15)) });
  const conflits = el('select', null, el('option', { value: 'sauter' }, 'Sauter les dates prises'),
    el('option', { value: 'demande' }, 'Les garder en conflit'));
  const blocRepeter = el('div', { classe: 'repeter' }, el('div', { classe: 'jours' }, jours.map((j) => j.lab)),
    el('label', null, 'Jusqu’au', jusquau), el('label', null, 'Dates déjà prises', conflits));
  const majRepeter = () => { blocRepeter.hidden = repeter.value === '0'; };
  repeter.addEventListener('change', majRepeter);
  majRepeter();
  // Modifier une occurrence d'une série : cette fois ou les suivantes.
  const portee = el('select', null, el('option', { value: 'une' }, 'Cette fois seulement'),
    el('option', { value: 'suivantes' }, 'Celle-ci et les suivantes'));

  const lirePlage = () => {
    const [y, mo, d] = date.value.split('-').map(Number);
    const [h1, m1] = debut.value.split(':').map(Number), [h2, m2] = fin.value.split(':').map(Number);
    const d1 = new Date(y, mo - 1, d, h1, m1), d2 = new Date(y, mo - 1, d, h2, m2);
    if (d2 <= d1) d2.setDate(d2.getDate() + 1);  // passe minuit
    return [d1, d2];
  };
  const idClient = async () => {
    const nom = client.value.trim();
    if (!nom) return null;
    const ex = ctx.locataires.find((l) => l.nom.toLowerCase() === nom.toLowerCase());
    if (ex) return ex.id;
    if (!peutModifier()) throw new Error('Client inconnu : choisissez-le dans la liste.');
    return (await ajoutPro('locataires', { organisation_id: etat.organisation, nom }))[0].id;
  };

  const enregistrer = async (ev) => {
    ev.preventDefault();
    try {
      const [d1, d2] = lirePlage();
      const loc = await idClient();
      const commun = { titre: titre.value.trim() || null, locataire_id: loc, note: note.value.trim() || null,
        surfacage: !!plSel().surfacage && surfacage.checked };
      const opt = statut.value === 'option' ? { option_jusqu: new Date(echeance.value + 'T23:59').toISOString() } : { option_jusqu: null };
      if (!r && repeter.value !== '0') {
        const choisis = jours.filter((j) => j.x.checked).map((j) => j.x.jour);
        if (!choisis.length) { dire('Choisissez au moins un jour.', true); return; }
        const res = await rest('POST', 'rpc/creer_serie', { p_organisation: etat.organisation, p_plateau: plateau.value,
          p_locataire: loc, p_titre: commun.titre, p_jours: choisis, p_heure_debut: debut.value, p_heure_fin: fin.value,
          p_du: date.value, p_au: jusquau.value, p_intervalle: Number(repeter.value), p_conflits: conflits.value,
          p_statut: statut.value === 'option' ? 'option' : 'confirmee', p_option_jusqu: opt.option_jusqu || null,
          p_surfacage: commun.surfacage }, PRO);
        plan.panneau = null;
        await afficher();
        dire(resumeSerie(res), res.some((x) => x.etat !== 'creee'));
        return;
      }
      if (!r) {
        await ajoutPro('reservations', Object.assign({ organisation_id: etat.organisation, plateau_id: plateau.value,
          periode: plage(d1, d2), statut: statut.value, source: 'manuel' }, commun, opt));
        plan.date = plan.vue === 'jour' ? debutJour(d1) : plan.date;
        plan.panneau = null;
        await afficher();
        dire(statut.value === 'option' ? 'Option posée.' : 'Réservation ajoutée.');
        return;
      }
      if (r.serie_id && portee.value === 'suivantes') {
        const [s] = await lirePro('series', { select: '*', id: 'eq.' + r.serie_id });
        if (!s) { dire('Cette série est trop ancienne pour être modifiée d’un coup : changez les dates une à une.', true); return; }
        const res = await rest('POST', 'rpc/modifier_serie', { p_serie: r.serie_id, p_a_partir_de: date.value,
          p_plateau: plateau.value, p_locataire: loc, p_titre: commun.titre, p_jours: s.jours, p_heure_debut: debut.value,
          p_heure_fin: fin.value, p_au: s.au, p_intervalle: s.intervalle_semaines, p_conflits: 'sauter',
          p_surfacage: commun.surfacage }, PRO);
        plan.panneau = null;
        await afficher();
        dire('Série modifiée. ' + resumeSerie(res), res.some((x) => x.etat !== 'creee'));
        return;
      }
      await majPro('reservations', { id: 'eq.' + r.id }, Object.assign({ plateau_id: plateau.value, periode: plage(d1, d2),
        statut: statut.value }, commun, opt));
      await afficher();
      dire('Réservation enregistrée.');
    } catch (e) { dire(messageRefus(e), true); }
  };

  const annuler = async (quoi) => {
    const msg = { une: 'Annuler cette réservation ?', suivantes: 'Annuler celle-ci et toutes les suivantes de la série ?',
      serie: 'Annuler toute la série (à venir) ?' }[quoi];
    if (!confirm(msg)) return;
    try {
      if (quoi === 'une') await majPro('reservations', { id: 'eq.' + r.id }, { statut: 'annulee' });
      else await rest('POST', 'rpc/annuler_serie', { p_serie: r.serie_id, p_a_partir_de: quoi === 'serie' ? null : aaaammjj(a) }, PRO);
      plan.panneau = null;
      await afficher();
      dire('Annulé.');
    } catch (e) { dire(e.message, true); }
  };
  const confirmer = async () => {
    try { await majPro('reservations', { id: 'eq.' + r.id }, { statut: 'confirmee', option_jusqu: null }); await afficher(); dire('Réservation confirmée.'); }
    catch (e) { dire(messageRefus(e), true); }
  };

  return el('form', { classe: 'panneau-planif', onsubmit: enregistrer },
    el('div', { classe: 'tete-panneau' }, el('h3', null, r ? (r.titre || (r.locataires || {}).nom || 'Réservation') : 'Nouvelle réservation'), fermer),
    r ? el('div', { classe: 'doux' }, ETATS[r.statut] + (r.serie_id ? ' · ↻ série' : '')
      + (r.modifie_le ? ' · modifiée ' + quand(r.modifie_le) : '')) : null,
    el('label', null, 'Client', client, liste),
    el('label', null, 'Activité', titre),
    el('label', null, 'Plateau', plateau),
    el('div', { classe: 'champs trois' }, el('label', null, 'Date', date), el('label', null, 'Début', debut), el('label', null, 'Fin', fin)),
    ligneSurf,
    peutModifier() || (r && r.statut !== 'confirmee') ? el('label', null, 'État', statut) : null,
    ligneEcheance,
    !r && peutModifier() ? el('label', null, 'Répéter', repeter) : null,
    !r && peutModifier() ? blocRepeter : null,
    r && r.serie_id && peutModifier() ? el('label', null, 'Appliquer à', portee) : null,
    el('label', null, 'Note', note),
    modifiable ? el('div', { classe: 'actions' },
      el('button', { type: 'submit' }, r ? 'Enregistrer' : 'Réserver'),
      r && r.statut !== 'confirmee' ? el('button', { type: 'button', classe: 'discret', onclick: confirmer }, 'Confirmer') : null) : null,
    r && modifiable ? el('div', { classe: 'actions annuler' },
      el('button', { type: 'button', classe: 'discret', onclick: () => annuler('une') }, 'Annuler cette fois'),
      r.serie_id && peutModifier() ? el('button', { type: 'button', classe: 'discret', onclick: () => annuler('suivantes') }, '… et les suivantes') : null,
      r.serie_id && peutModifier() ? el('button', { type: 'button', classe: 'discret', onclick: () => annuler('serie') }, 'Toute la série') : null) : null,
    r && r.locataire_id ? el('button', { type: 'button', classe: 'discret lien', onclick: () => {
      plan.client = r.locataire_id; plan.sous = 'clients'; plan.panneau = null; afficher(); } }, 'Voir la fiche du client →') : null);
}

function panneauImporte(ctx, r, fermer) {
  const [a, b] = bornes(r.periode);
  const pl = ctx.plateaux.find((p) => p.id === r.plateau_id) || {};
  const glace = r.source === 'espaceligue' && peutModifier() ? choixGlaceMatch(r, ctx.plateaux) : null;
  return el('div', { classe: 'panneau-planif' },
    el('div', { classe: 'tete-panneau' }, el('h3', null, r.titre || 'Réservation'), fermer),
    el('div', { classe: 'doux' }, (r.source === 'espaceligue' ? 'Match EspaceLigue · ' + ((r.locataires || {}).nom || '')
      : 'Calendrier · ' + ((r.calendriers || {}).nom || '')) + ' · ' + ETATS[r.statut]),
    el('p', null, a.toLocaleDateString('fr-CA', { weekday: 'long', day: 'numeric', month: 'long' }) + ', ' + hhmm(a) + ' – ' + hhmm(b)
      + ' · ' + pl.nom),
    glace ? el('label', null, 'Glace de ce match', glace) : null,
    r.source === 'espaceligue' ? el('button', { type: 'button', classe: 'discret lien', onclick: () => { etat.onglet = 'ligues'; afficher(); } },
      'Changer l’heure dans l’onglet Ligues →')
      : el('p', { classe: 'doux' }, 'Se modifie dans le calendrier d’origine.'),
    r.statut === 'demandee' && peutModifier() ? el('button', { type: 'button', onclick: async () => {
      try { await majPro('reservations', { id: 'eq.' + r.id }, { statut: 'confirmee' }); await afficher(); dire('Réservation confirmée.'); }
      catch (e) { dire(messageRefus(e), true); }
    } }, 'Confirmer') : null);
}

function resumeSerie(res) {
  const n = (e) => res.filter((x) => x.etat === e);
  const dates = (l) => l.map((x) => new Date(x.jour + 'T12:00').toLocaleDateString('fr-CA', { day: 'numeric', month: 'short' })).join(', ');
  return [`${n('creee').length} réservation${n('creee').length > 1 ? 's' : ''} créée${n('creee').length > 1 ? 's' : ''}`,
    n('sautee').length ? `${n('sautee').length} sautée(s) : ${dates(n('sautee'))}` : null,
    n('demande').length ? `${n('demande').length} en conflit : ${dates(n('demande'))}` : null,
    n('fermee').length ? `${n('fermee').length} jour(s) de fermeture : ${dates(n('fermee'))}` : null].filter(Boolean).join(' · ').replace(/\.?$/, '.');
}

// Vue Semaine : les resurfaçages par jour, pour planifier les employés.
function tableauSurfacages(ctx, lundi) {
  const plats = [...new Set(ctx.surf.map((s) => s.plateau))];
  const jours = Array.from({ length: 7 }, (_, i) => ajouterJours(lundi, i));
  const n = (pl, j) => ctx.surf.filter((s) => s.plateau === pl && s.jour === aaaammjj(j)).reduce((x, s) => x + s.nombre, 0);
  return el('div', { classe: 'fiche' }, el('h3', null, 'Resurfaçages de la semaine'),
    el('div', { classe: 'table' }, el('table', null,
      el('thead', null, el('tr', null, el('th', null, ''), jours.map((j) => el('th', null,
        j.toLocaleDateString('fr-CA', { weekday: 'short', day: 'numeric' }))), el('th', null, 'Total'))),
      el('tbody', null, plats.map((pl) => el('tr', null, el('td', null, el('strong', null, pl)),
        jours.map((j) => el('td', null, String(n(pl, j) || '–'))), el('td', null, el('strong', null,
          String(jours.reduce((x, j) => x + n(pl, j), 0))))))))));
}

// --- Clients ---------------------------------------------------------------------------
const TYPES_CLIENT = { ligue: 'Ligue', club: 'Club', ecole: 'École', entreprise: 'Entreprise', particulier: 'Particulier', autre: 'Autre' };

async function vueClients(locataires) {
  const modifiable = peutModifier();
  const cherche = el('input', { type: 'search', placeholder: 'Rechercher un client (nom, téléphone, courriel)', valeur: plan.recherche || '' });
  const liste = el('div', { classe: 'liste-clients' });
  const dessiner = () => {
    const q = cherche.value.trim().toLowerCase();
    plan.recherche = cherche.value;
    liste.replaceChildren(...locataires.filter((l) => !q || [l.nom, l.telephone, l.courriel].some((x) => (x || '').toLowerCase().includes(q)))
      .map((l) => el('button', { type: 'button', classe: 'ligne-client' + (l.id === plan.client ? ' actif' : '') + (l.actif === false ? ' inactif' : ''),
        onclick: () => { plan.client = l.id; afficher(); } },
        el('strong', null, l.nom), el('span', { classe: 'doux' }, TYPES_CLIENT[l.type] || ''))));
  };
  cherche.addEventListener('input', dessiner);
  dessiner();
  const nouveau = modifiable ? el('button', { type: 'button', onclick: async () => {
    const nom = prompt('Nom du nouveau client');
    if (!nom || !nom.trim()) return;
    try { const [l] = await ajoutPro('locataires', { organisation_id: etat.organisation, nom: nom.trim() }); plan.client = l.id; await afficher(); }
    catch (e) { dire(e.message, true); }
  } }, '+ Nouveau client') : null;
  const choisi = locataires.find((l) => l.id === plan.client);
  return el('div', { classe: 'clients' },
    el('div', { classe: 'col-liste' }, el('div', { classe: 'outils' }, cherche, nouveau), liste),
    choisi ? await ficheClient(choisi.id, modifiable) : el('p', { classe: 'doux' }, locataires.length ? 'Choisissez un client.' : 'Aucun client pour l’instant.'));
}

async function ficheClient(id, modifiable) {
  const maintenant = new Date();
  const [[l], prochaines, saison] = await Promise.all([
    lirePro('locataires', { select: '*', id: 'eq.' + id }),
    lirePro('reservations', { select: 'id,periode,titre,statut,serie_id,plateaux(nom)', locataire_id: 'eq.' + id,
      statut: 'neq.annulee', periode: 'ov.' + plage(maintenant, ajouterJours(maintenant, 400)), order: 'periode', limit: 12 }),
    lirePro('reservations', { select: 'periode', locataire_id: 'eq.' + id, statut: 'eq.confirmee',
      periode: 'ov.' + plage(ajouterJours(maintenant, -365), ajouterJours(maintenant, 365)) }),
  ]);
  const heures = saison.reduce((n, r) => { const [a, b] = bornes(r.periode); return n + (b - a) / 3600000; }, 0);
  const ch = (k, attrs) => el('input', Object.assign({ valeur: l[k] || '', disabled: !modifiable || !!l.ligue_id && k === 'nom' }, attrs || {}));
  const champs = { nom: ch('nom', { required: true, maxlength: 160 }), contact: ch('contact'), telephone: ch('telephone', { type: 'tel' }),
    courriel: ch('courriel', { type: 'email' }), adresse: ch('adresse') };
  const type = el('select', { disabled: !modifiable }, Object.entries(TYPES_CLIENT).map(([k, v]) => el('option', { value: k, selected: k === l.type }, v)));
  const notes = el('textarea', { rows: 3, disabled: !modifiable }, l.notes || '');
  const actif = el('input', { type: 'checkbox', checked: l.actif !== false, disabled: !modifiable });
  return el('form', { classe: 'carte-formulaire fiche-client', onsubmit: async (ev) => {
      ev.preventDefault();
      try {
        const corps = Object.fromEntries(Object.entries(champs).map(([k, x]) => [k, x.value.trim() || null]));
        await majPro('locataires', { id: 'eq.' + id }, Object.assign(corps, { type: type.value, notes: notes.value.trim() || null, actif: actif.checked }));
        await afficher();
        dire('Client enregistré.');
      } catch (e) { dire(e.message, true); }
    } },
    el('div', { classe: 'tete-panneau' }, el('h3', null, l.nom), el('span', { classe: 'doux' },
      Math.round(heures) + ' h réservées sur un an')),
    l.ligue_id ? el('p', { classe: 'doux' }, 'Ligue EspaceLigue : ses matchs s’ajoutent d’eux-mêmes.') : null,
    el('div', { classe: 'champs' }, el('label', null, 'Nom', champs.nom), el('label', null, 'Type', type),
      el('label', null, 'Personne-ressource', champs.contact), el('label', null, 'Téléphone', champs.telephone),
      el('label', null, 'Courriel', champs.courriel), el('label', null, 'Adresse de facturation', champs.adresse)),
    el('label', null, 'Notes internes', notes),
    el('label', { classe: 'case' }, actif, 'Client actif'),
    modifiable ? el('div', { classe: 'actions' }, el('button', { type: 'submit' }, 'Enregistrer'),
      el('button', { type: 'button', classe: 'discret', onclick: () => { plan.sous = 'grille'; afficher(); } }, 'Voir à l’horaire')) : null,
    el('h4', null, 'Prochaines réservations'),
    prochaines.length ? el('div', { classe: 'table' }, el('table', null, el('tbody', null, prochaines.map((r) => {
      const [a, b] = bornes(r.periode);
      return el('tr', null, el('td', null, a.toLocaleDateString('fr-CA', { weekday: 'short', day: 'numeric', month: 'short' })),
        el('td', null, hhmm(a) + '–' + hhmm(b)), el('td', null, (r.plateaux || {}).nom || ''),
        el('td', null, (r.serie_id ? '↻ ' : '') + (r.titre || '')), el('td', { classe: 'doux' }, ETATS[r.statut]));
    }))))
      : el('p', { classe: 'doux' }, 'Aucune.'));
}
