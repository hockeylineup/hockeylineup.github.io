// « Saisons » de l'Espace gérant (20 novembre 2026) : le pendant de l'écran
// Saison de l'app (VueSaison, DepotLigueStructure, DepotLigueBanque). Mêmes
// tables, mêmes règles : la base vérifie qui gère la ligue, et les frais ne
// se changent que par le gérant titulaire. Les frais d'un joueur ajouté à la
// saison se facturent seuls (30_finances_ligue.sql).
'use strict';

const JOURS = [[2, tr('Lun')], [3, tr('Mar')], [4, tr('Mer')], [5, tr('Jeu')], [6, tr('Ven')], [7, tr('Sam')], [1, tr('Dim')]];
const sai = { liste: [], choisie: null, equipes: [], matchs: [], joueurs: [], deLaSaison: new Set(), effectifs: {} };

function vueSaisons() {
  const boite = el('div');
  chargerSaisons(boite);
  return [boite];
}

async function chargerSaisons(boite) {
  boite.replaceChildren(el('p', { classe: 'doux' }, tr('Chargement…')));
  try {
    sai.liste = await lire('saisons', { select: 'id,nom,debut,fin,frais_joueur_cents,mode', ligue_id: 'eq.' + etat.ligue,
                                        order: 'debut.desc.nullslast,nom' });
    if (!sai.liste.some((s) => s.id === sai.choisie)) sai.choisie = sai.liste[0] ? sai.liste[0].id : null;
    if (sai.choisie) await chargerDetail();
    rendreSaisons(boite);
  } catch (e) { boite.replaceChildren(); dire(e.message, true); }
}

async function chargerDetail() {
  const f = { saison_id: 'eq.' + sai.choisie };
  const [equipes, matchs, js, joueurs] = await Promise.all([
    lire('equipes', { select: 'id,nom,couleur', ...f, order: 'nom' }),
    lire('matchs', { select: 'id,debut,domicile,visiteur,lieu_id', ...f, order: 'debut' }),
    lire('joueurs_saison', { select: 'profil_id', ...f }),
    sai.joueurs.length && sai.ligueJoueurs === etat.ligue ? sai.joueurs
      : lire('joueurs_ligue', { select: 'profil_id,position,actif,profils(prenom,nom)', ligue_id: 'eq.' + etat.ligue }),
  ]);
  sai.equipes = equipes; sai.matchs = matchs; sai.joueurs = joueurs; sai.ligueJoueurs = etat.ligue;
  sai.deLaSaison = new Set(js.map((j) => j.profil_id));
  const eff = equipes.length ? await lire('effectifs', { select: 'equipe_id,profil_id',
    equipe_id: 'in.(' + equipes.map((e) => e.id).join(',') + ')' }) : [];
  sai.effectifs = Object.fromEntries(eff.map((x) => [x.profil_id, x.equipe_id]));
}

const nomJoueur = (j) => [j.profils && j.profils.prenom, j.profils && j.profils.nom].filter(Boolean).join(' ') || '—';
const argentSaison = (c) => (c / 100).toLocaleString(LOCALE, { style: 'currency', currency: 'CAD' });

async function agirSaison(boite, action, message) {
  try { await action(); if (message) dire(message, false, true); await chargerSaisons(boite); }
  catch (e) { dire(e.message, true); }
}

function rendreSaisons(boite) {
  const choix = el('select', { onchange: async (e) => { sai.choisie = e.target.value; await chargerSaisons(boite); } },
    sai.liste.map((s) => el('option', { value: s.id }, s.nom)));
  choix.value = sai.choisie || '';
  const s = sai.liste.find((x) => x.id === sai.choisie);
  boite.replaceChildren(
    sai.liste.length ? el('label', null, tr('Saison'), choix) : el('p', { classe: 'doux' }, tr('Aucune saison.')),
    ...(s ? [carteInfos(s, boite), carteEquipes(s, boite), carteJoueurs(s, boite), carteHoraire(s, boite)] : []),
    carteNouvelleSaison(boite));
}

function champsSaison(s) {
  const nom = el('input', { type: 'text', maxlength: 80, required: true, valeur: s ? s.nom : '', placeholder: tr('Nom') });
  const debut = el('input', { type: 'date', valeur: (s && s.debut) || '' });
  const fin = el('input', { type: 'date', valeur: (s && s.fin) || '' });
  const frais = el('input', { type: 'number', min: 0, step: '0.01', inputmode: 'decimal',
                              valeur: ((s ? s.frais_joueur_cents : 0) / 100).toFixed(2) });
  frais.disabled = !titulaire();
  return { nom, debut, fin, frais, ligne: () => ({ nom: nom.value.trim(), debut: debut.value || null, fin: fin.value || null,
    ...(titulaire() ? { frais_joueur_cents: Math.max(0, Math.round(Number(frais.value) * 100) || 0) } : {}) }) };
}

function carteInfos(s, boite) {
  const c = champsSaison(s);
  return carte(tr('Saison'),
    el('p', { classe: 'doux' }, (s.mode === 'pickup' ? tr('Pickup') : tr('Équipes fixes')) + ' · '
      + tr('Frais par joueur régulier') + ' : ' + argentSaison(s.frais_joueur_cents)),
    el('form', { classe: 'champs', onsubmit: (ev) => {
      ev.preventDefault();
      agirSaison(boite, () => rest('PATCH', 'saisons?id=eq.' + s.id, c.ligne(), { Prefer: 'return=minimal' }), tr('Enregistré.'));
    } }, el('label', null, tr('Nom'), c.nom), el('label', null, tr('Début'), c.debut), el('label', null, tr('Fin'), c.fin),
       el('label', null, tr('Frais par joueur régulier ($)'), c.frais),
       el('button', { type: 'submit' }, tr('Enregistrer'))),
    el('p', null, el('button', { type: 'button', classe: 'danger', onclick: () => {
      if (confirm(tr('Supprimer la saison « %@ » et tout ce qu’elle contient ?', s.nom)))
        agirSaison(boite, () => rest('DELETE', 'saisons?id=eq.' + s.id), tr('Saison supprimée.'));
    } }, tr('Supprimer la saison'))));
}

function carteEquipes(s, boite) {
  const nom = el('input', { type: 'text', maxlength: 60, required: true, placeholder: tr('Nom de l’équipe') });
  const couleur = el('input', { type: 'color', valeur: '#1E40AF', 'aria-label': tr('Couleur') });
  return carte(tr('Équipes'),
    sai.equipes.length ? el('ul', { classe: 'equipes' }, sai.equipes.map((e) => {
      const n = el('input', { type: 'text', valeur: e.nom, maxlength: 60, 'aria-label': tr('Nom de l’équipe') });
      const c = el('input', { type: 'color', valeur: e.couleur || '#888888', 'aria-label': tr('Couleur') });
      const enregistrer = () => agirSaison(boite, () => rest('PATCH', 'equipes?id=eq.' + e.id,
        { nom: n.value.trim() || e.nom, couleur: c.value.toUpperCase() }, { Prefer: 'return=minimal' }), tr('Enregistré.'));
      n.addEventListener('change', enregistrer); c.addEventListener('change', enregistrer);
      return el('li', { classe: 'ligne-equipe' }, c, n, el('button', { type: 'button', onclick: () => {
        if (confirm(tr('Retirer l’équipe « %@ » ?', e.nom))) agirSaison(boite, () => rest('DELETE', 'equipes?id=eq.' + e.id));
      } }, tr('Retirer')));
    })) : el('p', { classe: 'doux' }, tr('Aucune équipe.')),
    el('form', { classe: 'ligne-equipe', onsubmit: (ev) => {
      ev.preventDefault();
      agirSaison(boite, () => rest('POST', 'equipes', { saison_id: s.id, ligue_id: etat.ligue, nom: nom.value.trim(),
        couleur: couleur.value.toUpperCase() }, { Prefer: 'return=minimal' }), tr('Équipe ajoutée.'));
    } }, couleur, nom, el('button', { type: 'submit' }, tr('Ajouter une équipe'))));
}

function carteJoueurs(s, boite) {
  const joueurs = sai.joueurs.filter((j) => j.actif !== false)
    .sort((a, b) => nomJoueur(a).localeCompare(nomJoueur(b), LOCALE));
  const placer = (j, valeur) => agirSaison(boite, async () => {
    if (valeur === '') {
      await rest('DELETE', 'joueurs_saison?' + new URLSearchParams({ saison_id: 'eq.' + s.id, profil_id: 'eq.' + j.profil_id }));
    } else if (valeur === 'saison') {
      if (sai.effectifs[j.profil_id]) await rpc('placer_joueur', { p_saison: s.id, p_profil: j.profil_id, p_equipe: null });
      else await rest('POST', 'joueurs_saison', { saison_id: s.id, ligue_id: etat.ligue, profil_id: j.profil_id },
                      { Prefer: 'return=minimal' });
    } else {
      await rpc('placer_joueur', { p_saison: s.id, p_profil: j.profil_id, p_equipe: valeur });
    }
  });
  return carte(tr('Joueurs de la saison') + ' (' + sai.deLaSaison.size + ')',
    el('p', { classe: 'doux' }, tr('Un joueur de la saison est un régulier : ses frais se facturent seuls.')),
    joueurs.length ? el('table', { classe: 'tableau-gerant' }, el('tbody', null, joueurs.map((j) => {
      const sel = el('select', { 'aria-label': tr('Place de %@', nomJoueur(j)) },
        el('option', { value: '' }, tr('Pas dans la saison')),
        el('option', { value: 'saison' }, s.mode === 'pickup' ? tr('Régulier') : tr('Régulier, sans équipe')),
        s.mode === 'pickup' ? null : sai.equipes.map((e) => el('option', { value: e.id }, e.nom)));
      sel.value = sai.effectifs[j.profil_id] && s.mode !== 'pickup' ? sai.effectifs[j.profil_id]
        : sai.deLaSaison.has(j.profil_id) ? 'saison' : '';
      sel.addEventListener('change', () => placer(j, sel.value));
      return el('tr', null, el('td', null, nomJoueur(j)), el('td', null, j.position || ''), el('td', null, sel));
    }))) : el('p', { classe: 'doux' }, tr('Aucun joueur dans la banque de la ligue.')));
}

function carteHoraire(s, boite) {
  const eq = Object.fromEntries(sai.equipes.map((e) => [e.id, e.nom]));
  const lieux = etat.lieux.filter((l) => l.saison_id === s.id);
  const nomLieu = (id) => (lieux.find((l) => l.id === id) || {}).nom || '';
  const quand = (d) => new Date(d).toLocaleString(LOCALE, { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
  const choixEquipe = () => el('select', null, sai.equipes.map((e) => el('option', { value: e.id }, e.nom)));
  const dom = choixEquipe(), vis = choixEquipe();
  if (sai.equipes[1]) vis.value = sai.equipes[1].id;
  const debut = el('input', { type: 'datetime-local', required: true, 'aria-label': tr('Date et heure') });
  const lieu = el('select', null, el('option', { value: '' }, tr('Sans lieu')), lieux.map((l) => el('option', { value: l.id }, l.nom)));
  return carte(tr('Horaire') + ' (' + sai.matchs.length + ')',
    sai.matchs.length ? el('table', { classe: 'tableau-gerant' }, el('tbody', null, sai.matchs.map((m) => el('tr', null,
      el('td', null, quand(m.debut)), el('td', null, (eq[m.domicile] || '?') + ' – ' + (eq[m.visiteur] || '?')),
      el('td', null, nomLieu(m.lieu_id)),
      el('td', null, el('button', { type: 'button', onclick: () => {
        if (confirm(tr('Supprimer ce match ?'))) agirSaison(boite, () => rest('DELETE', 'matchs?id=eq.' + m.id));
      } }, tr('Supprimer'))))))) : el('p', { classe: 'doux' }, tr('Aucun match.')),
    sai.equipes.length < 2 ? el('p', { classe: 'doux' }, tr('Il faut au moins deux équipes pour ajouter un match.'))
      : el('form', { classe: 'ajout-match', onsubmit: (ev) => {
        ev.preventDefault();
        if (dom.value === vis.value) { dire(tr('Choisis deux équipes différentes.'), true); return; }
        agirSaison(boite, () => rest('POST', 'matchs', { saison_id: s.id, ligue_id: etat.ligue, domicile: dom.value,
          visiteur: vis.value, debut: new Date(debut.value).toISOString(), lieu_id: lieu.value || null },
          { Prefer: 'return=minimal' }), tr('Match ajouté.'));
      } }, dom, vis, debut, lieu, el('button', { type: 'submit' }, tr('Ajouter un match'))));
}

// Chaque jour coché entre deux dates, à l'heure choisie (DepotLigue.joursDeMatch).
function joursDeMatch(debut, fin, jours, heure) {
  const [h, m] = heure.split(':').map(Number);
  const dates = [];
  const d = new Date(debut + 'T00:00');
  const dernier = new Date(fin + 'T00:00');
  while (d <= dernier && dates.length < 400) {
    if (jours.has(d.getDay() + 1)) { const x = new Date(d); x.setHours(h, m, 0, 0); dates.push(x.toISOString()); }
    d.setDate(d.getDate() + 1);
  }
  return dates;
}

function carteNouvelleSaison(boite) {
  const c = champsSaison(null);
  const mode = el('select', null, el('option', { value: 'fixe' }, tr('Équipes fixes')), el('option', { value: 'pickup' }, tr('Pickup')));
  const cases = JOURS.map(([n, t]) => el('label', { classe: 'case' }, el('input', { type: 'checkbox', value: n }), t));
  const heure = el('input', { type: 'time', valeur: '21:00', 'aria-label': tr('Heure') });
  const horaire = el('div', { hidden: true }, el('p', { classe: 'doux' }, tr('Pickup : Blancs et Noirs, et un match chaque jour coché.')),
    el('div', { classe: 'en-ligne' }, ...cases, heure));
  mode.addEventListener('change', () => { horaire.hidden = mode.value !== 'pickup'; });
  return carte(tr('Nouvelle saison'), el('form', { classe: 'champs', onsubmit: (ev) => {
    ev.preventDefault();
    const ligne = { ligue_id: etat.ligue, mode: mode.value, ...c.ligne() };
    if (ligne.debut && ligne.fin && ligne.fin < ligne.debut) { dire(tr('La fin vient avant le début.'), true); return; }
    agirSaison(boite, async () => {
      const [s] = await rest('POST', 'saisons', ligne, { Prefer: 'return=representation' });
      sai.choisie = s.id;
      const jours = new Set(cases.filter((x) => x.firstChild.checked).map((x) => Number(x.firstChild.value)));
      if (mode.value !== 'pickup' || !jours.size || !ligne.debut || !ligne.fin) return;
      const [blancs] = await rest('POST', 'equipes', { saison_id: s.id, ligue_id: etat.ligue, nom: 'Blancs', couleur: '#F5F5F5' },
                                  { Prefer: 'return=representation' });
      const [noirs] = await rest('POST', 'equipes', { saison_id: s.id, ligue_id: etat.ligue, nom: 'Noirs', couleur: '#111111' },
                                 { Prefer: 'return=representation' });
      const dates = joursDeMatch(ligne.debut, ligne.fin, jours, heure.value || '21:00');
      if (dates.length) await rest('POST', 'matchs', dates.map((d) => ({ saison_id: s.id, ligue_id: etat.ligue,
        domicile: blancs.id, visiteur: noirs.id, debut: d })), { Prefer: 'return=minimal' });
    }, tr('Saison créée.'));
  } }, el('label', null, tr('Nom'), c.nom), el('label', null, tr('Mode'), mode), el('label', null, tr('Début'), c.debut),
     el('label', null, tr('Fin'), c.fin), el('label', null, tr('Frais par joueur régulier ($)'), c.frais), horaire,
     el('button', { type: 'submit' }, tr('Créer la saison'))));
}
