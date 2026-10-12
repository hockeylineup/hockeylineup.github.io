// EspaceLigue Pro · Gestion — l'horaire des plateaux (docs/horaire.md
// d'espaceligue-pro). Chargé après gestion.js et contenu.js.
//
// Trois sources de réservations, que l'écran montre pareil :
// - saisies ici, à la main (source `manuel`), une à une ou chaque semaine ;
// - les matchs des ligues EspaceLigue jouées sur un lieu associé à un plateau
//   (pro.associer_lieu ; la base les tient à jour toutes les 5 minutes) ;
// - un calendrier iCal par plateau (Outlook, Google, iCloud), relu toutes les
//   15 minutes par l'Edge Function pro-calendriers.
// Les deux dernières ne se modifient pas ici : elles reviendraient de la source.
'use strict';

const horaire = { plateau: null, lundi: null, edition: null };
const JOUR_MS = 86400000;
const SOURCES = { manuel: 'Saisie', espaceligue: 'EspaceLigue', calendrier: 'Calendrier' };

function lundiDe(d) {
  const x = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  x.setDate(x.getDate() - ((x.getDay() + 6) % 7));
  return x;
}
const hhmm = (d) => `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
const aaaammjj = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const plage = (debut, fin) => `[${debut.toISOString()},${fin.toISOString()})`;
const bornes = (periode) => {
  // PostgREST rend « ["2026-10-14 22:00:00+00","2026-10-14 23:30:00+00") ».
  return periode.replace(/^[[(]|[\])]$/g, '').split(',').map((x) =>
    new Date(x.replace(/"/g, '').trim().replace(' ', 'T').replace(/([+-]\d\d)$/, '$1:00')));
};
function messageConflit(e) {
  return /chevauchement|exclusion|conflicting key/i.test(e.message)
    ? 'Ce plateau est déjà réservé à ce moment-là.' : e.message;
}

async function vueHoraire() {
  const org = etat.organisation;
  const [etablissements, plateaux, locataires] = await Promise.all([
    lirePro('etablissements', { select: 'id,nom', organisation_id: 'eq.' + org, order: 'nom' }),
    lirePro('plateaux', { select: 'id,nom,etablissement_id', organisation_id: 'eq.' + org, actif: 'is.true', order: 'nom' }),
    lirePro('locataires', { select: 'id,nom', organisation_id: 'eq.' + org, order: 'nom' }),
  ]);
  if (!plateaux.length) return el('section', { classe: 'fiche' }, el('h2', null, 'Horaire'),
    el('p', { classe: 'doux' }, 'Aucun plateau pour l’instant. EspaceLigue les crée avec vous.'));
  if (!plateaux.some((p) => p.id === horaire.plateau)) horaire.plateau = plateaux[0].id;
  if (!horaire.lundi) horaire.lundi = lundiDe(new Date());
  const pl = plateaux.find((p) => p.id === horaire.plateau);
  const nomEtab = (id) => (etablissements.find((e) => e.id === id) || {}).nom || '';
  const fin = new Date(horaire.lundi.getTime() + 7 * JOUR_MS);
  const reservations = await lirePro('reservations', {
    select: 'id,periode,titre,statut,source,serie_id,locataire_id,locataires(nom),calendriers(nom)',
    plateau_id: 'eq.' + pl.id, periode: 'ov.' + plage(horaire.lundi, fin), statut: 'neq.annulee', order: 'periode' });
  const modifiable = peutModifier();

  const choixPlateau = el('div', { classe: 'puces' }, plateaux.map((p) =>
    el('button', { type: 'button', classe: p.id === pl.id ? 'actif' : null,
      onclick: () => { horaire.plateau = p.id; horaire.edition = null; afficher(); } },
      (etablissements.length > 1 ? nomEtab(p.etablissement_id) + ' · ' : '') + p.nom)));
  const semaine = (n) => () => { horaire.lundi = new Date(horaire.lundi.getTime() + n * 7 * JOUR_MS); afficher(); };
  const navigation = el('div', { classe: 'semaine' },
    el('button', { type: 'button', classe: 'discret', onclick: semaine(-1) }, '‹'),
    el('strong', null, 'Semaine du ' + horaire.lundi.toLocaleDateString('fr-CA', { day: 'numeric', month: 'long' })),
    el('button', { type: 'button', classe: 'discret', onclick: semaine(1) }, '›'),
    el('button', { type: 'button', classe: 'discret', onclick: () => { horaire.lundi = lundiDe(new Date()); afficher(); } }, 'Aujourd’hui'));

  const jours = [];
  for (let i = 0; i < 7; i++) {
    const jour = new Date(horaire.lundi.getTime() + i * JOUR_MS);
    const duJour = reservations.filter((r) => aaaammjj(bornes(r.periode)[0]) === aaaammjj(jour));
    jours.push(el('div', { classe: 'jour-horaire' + (aaaammjj(jour) === aaaammjj(new Date()) ? ' aujourdhui' : '') },
      el('h4', null, jour.toLocaleDateString('fr-CA', { weekday: 'long', day: 'numeric', month: 'short' })),
      duJour.length ? duJour.map((r) => ligneReservation(r, modifiable)) : el('p', { classe: 'doux' }, 'Libre')));
  }

  return el('section', { classe: 'vue-horaire' },
    el('div', { classe: 'entete-vue' }, el('h2', null, 'Horaire des plateaux')),
    el('p', { classe: 'doux' }, 'Ce que vos affichages montrent. Ajoutez des réservations à la main, ou branchez '
      + 'un calendrier et vos ligues EspaceLigue plus bas : elles s’ajoutent toutes seules.'),
    choixPlateau,
    modifiable ? formulaireReservation(pl, locataires) : null,
    navigation,
    el('div', { classe: 'grille-semaine' }, jours),
    el('h3', null, 'Sources automatiques'),
    await blocLigues(plateaux, nomEtab, modifiable),
    await blocCalendriers(plateaux, nomEtab, modifiable));
}

function ligneReservation(r, modifiable) {
  const [a, b] = bornes(r.periode);
  const origine = r.source === 'espaceligue' ? 'EspaceLigue · ' + ((r.locataires || {}).nom || '')
    : r.source === 'calendrier' ? 'Calendrier · ' + ((r.calendriers || {}).nom || '')
    : (r.locataires || {}).nom || 'Saisie';
  const actions = [];
  if (modifiable && r.statut === 'demandee') actions.push(el('button', { type: 'button', classe: 'discret', onclick: async () => {
    try { await majPro('reservations', { id: 'eq.' + r.id }, { statut: 'confirmee' }); await afficher(); dire('Réservation confirmée.'); }
    catch (e) { dire(messageConflit(e), true); }
  } }, 'Confirmer'));
  if (modifiable && r.source === 'manuel') {
    actions.push(el('button', { type: 'button', classe: 'discret', onclick: () => {
      horaire.edition = r; afficher().then(() => $('contenu').querySelector('.form-reservation').scrollIntoView({ behavior: 'smooth' }));
    } }, 'Modifier'));
    actions.push(el('button', { type: 'button', classe: 'discret', onclick: async () => {
      const serie = r.serie_id && confirm('Supprimer aussi les suivantes de la même série ?\nOK : toute la suite · Annuler : celle-ci seulement');
      try {
        if (serie) await rest('DELETE', 'reservations?' + new URLSearchParams({ serie_id: 'eq.' + r.serie_id,
          periode: 'sa.' + plage(new Date(a.getTime() - 1), a) }), undefined, Object.assign({ Prefer: 'return=minimal' }, PRO));
        await retraitPro('reservations', { id: 'eq.' + r.id });
        await afficher();
        dire(serie ? 'Réservations supprimées.' : 'Réservation supprimée.');
      } catch (e) { dire(e.message, true); }
    } }, 'Supprimer'));
  }
  return el('div', { classe: 'resa' + (r.statut === 'demandee' ? ' conflit' : '') },
    el('div', { classe: 'h' }, hhmm(a) + ' – ' + hhmm(b)),
    el('div', null, el('strong', null, r.titre || 'Réservé'),
      el('div', { classe: 'doux' }, origine, r.statut === 'demandee' ? el('span', { classe: 'pastille ambre-fond' }, 'En conflit, pas à l’écran') : null)),
    actions.length ? el('div', { classe: 'actions' }, actions) : null);
}

function formulaireReservation(pl, locataires) {
  const ed = horaire.edition;
  const [a, b] = ed ? bornes(ed.periode) : [null, null];
  const date = el('input', { type: 'date', required: true, valeur: a ? aaaammjj(a) : aaaammjj(new Date()) });
  const debut = el('input', { type: 'time', required: true, valeur: a ? hhmm(a) : '18:00' });
  const fin = el('input', { type: 'time', required: true, valeur: b ? hhmm(b) : '19:00' });
  const titre = el('input', { maxlength: 160, placeholder: 'ex. Patin libre, Hockey mineur U11', valeur: ed ? ed.titre || '' : '' });
  const liste = el('datalist', { id: 'locataires-liste' }, locataires.map((l) => el('option', { value: l.nom })));
  const locataire = el('input', { list: 'locataires-liste', placeholder: 'facultatif',
    valeur: ed && ed.locataires ? ed.locataires.nom : '' });
  const repeter = el('select', null, [1, 2, 4, 8, 12, 16, 26].map((n) =>
    el('option', { value: n }, n === 1 ? 'Une seule fois' : `Chaque semaine, ${n} fois`)));

  return el('form', { classe: 'carte-formulaire form-reservation', onsubmit: async (ev) => {
      ev.preventDefault();
      const [h1, m1] = debut.value.split(':').map(Number), [h2, m2] = fin.value.split(':').map(Number);
      const [y, mo, d] = date.value.split('-').map(Number);
      const d1 = new Date(y, mo - 1, d, h1, m1), d2 = new Date(y, mo - 1, d, h2, m2);
      if (d2 <= d1) d2.setDate(d2.getDate() + 1);  // passe minuit
      try {
        let locId = null;
        const nom = locataire.value.trim();
        if (nom) {
          const existant = locataires.find((l) => l.nom.toLowerCase() === nom.toLowerCase());
          locId = existant ? existant.id : (await ajoutPro('locataires', { organisation_id: etat.organisation, nom }))[0].id;
        }
        const corps = { titre: titre.value.trim() || null, locataire_id: locId };
        if (ed) {
          await majPro('reservations', { id: 'eq.' + ed.id }, Object.assign(corps, { periode: plage(d1, d2) }));
          horaire.edition = null;
          dire('Réservation modifiée.');
        } else {
          const n = Number(repeter.value), serie = n > 1 ? crypto.randomUUID() : null;
          const lignes = [];
          for (let i = 0; i < n; i++) {
            const x1 = new Date(d1), x2 = new Date(d2);
            x1.setDate(x1.getDate() + 7 * i); x2.setDate(x2.getDate() + 7 * i);  // même heure, changement d'heure compris
            lignes.push(Object.assign({ organisation_id: etat.organisation, plateau_id: pl.id, periode: plage(x1, x2),
              statut: 'confirmee', source: 'manuel', serie_id: serie }, corps));
          }
          await ajoutPro('reservations', lignes);
          horaire.lundi = lundiDe(d1);
          dire(n > 1 ? `${n} réservations ajoutées.` : 'Réservation ajoutée.');
        }
        await afficher();
      } catch (e) { dire(messageConflit(e), true); }
    } },
    el('h3', null, ed ? 'Modifier la réservation' : 'Ajouter une réservation · ' + pl.nom),
    el('div', { classe: 'champs' },
      el('label', null, 'Date', date), el('label', null, 'Début', debut), el('label', null, 'Fin', fin),
      ed ? null : el('label', null, 'Répéter', repeter),
      el('label', { classe: 'large' }, 'Activité (affichée à l’écran)', titre),
      el('label', { classe: 'large' }, 'Locataire', locataire, liste)),
    el('div', { classe: 'actions' }, el('button', { type: 'submit' }, ed ? 'Enregistrer' : 'Ajouter'),
      ed ? el('button', { type: 'button', classe: 'discret', onclick: () => { horaire.edition = null; afficher(); } }, 'Annuler') : null));
}

// --- Ligues EspaceLigue ----------------------------------------------------------
async function blocLigues(plateaux, nomEtab, modifiable) {
  const lieux = await rest('POST', 'rpc/lieux_a_associer', { p_organisation: etat.organisation }, PRO);
  const lignes = lieux.map((l) => {
    const choix = el('select', { disabled: !modifiable }, el('option', { value: '' }, '— pas sur nos plateaux —'),
      plateaux.map((p) => el('option', { value: p.id, selected: p.id === l.plateau_id }, nomEtab(p.etablissement_id) + ' · ' + p.nom)));
    const duree = el('input', { type: 'number', min: 15, max: 360, step: 5, valeur: l.duree_minutes || 90, disabled: !modifiable });
    return el('div', { classe: 'ligne-source' },
      el('div', null, el('strong', null, l.ligue), el('div', { classe: 'doux' },
        `${l.lieu} · saison ${l.saison} · à ${l.distance_m} m · ${l.prochains} match${l.prochains > 1 ? 's' : ''} à venir`)),
      el('label', null, 'Plateau', choix), el('label', null, 'Durée d’un match (min)', duree),
      modifiable ? el('button', { type: 'button', onclick: async () => {
        try {
          const n = await rest('POST', 'rpc/associer_lieu', { p_organisation: etat.organisation, p_lieu: l.lieu_id,
            p_plateau: choix.value || null, p_duree: Number(duree.value) || 90 }, PRO);
          await afficher();
          dire(choix.value ? `${n} match${n > 1 ? 's' : ''} ajouté${n > 1 ? 's' : ''} à l’horaire. Les prochains suivront d’eux-mêmes.` : 'Ligue retirée de vos plateaux.');
        } catch (e) { dire(e.message, true); }
      } }, 'Enregistrer') : null);
  });
  return el('div', { classe: 'carte-formulaire' },
    el('h3', null, 'Ligues EspaceLigue'),
    el('p', { classe: 'doux' }, 'Les ligues qui jouent à moins d’un kilomètre de vos établissements. Choisissez le plateau : '
      + 'leurs matchs s’ajoutent à l’horaire, avec le pointage en direct, et suivent les changements de la ligue.'),
    lignes.length ? lignes : el('p', { classe: 'doux' }, 'Aucune ligue EspaceLigue ne joue près de vos établissements pour l’instant.'));
}

// --- Calendriers iCal --------------------------------------------------------------
async function blocCalendriers(plateaux, nomEtab, modifiable) {
  const cals = await lirePro('calendriers', { select: '*', organisation_id: 'eq.' + etat.organisation, order: 'nom' });
  const nomPl = (id) => { const p = plateaux.find((x) => x.id === id); return p ? nomEtab(p.etablissement_id) + ' · ' + p.nom : '?'; };
  const synchroniser = async (c) => {
    dire('Synchronisation de « ' + c.nom + ' »…');
    const r = await fetch(SUPABASE + '/functions/v1/pro-calendriers?calendrier=' + encodeURIComponent(c.id),
      { method: 'POST', headers: { apikey: CLE } });
    const rapport = r.ok ? await r.json() : [];
    await afficher();
    const x = rapport[0] || {};
    dire(x.erreur ? 'Le calendrier n’a pas pu être lu : ' + x.erreur : `${x.evenements ?? 0} événement(s) importé(s).`, !!x.erreur);
  };
  const lignes = cals.map((c) => el('div', { classe: 'ligne-source' },
    el('div', null, el('strong', null, c.nom), el('div', { classe: 'doux' }, nomPl(c.plateau_id) + ' · '
      + (c.erreur ? '' : c.synchronise_le ? `${c.evenements} événement(s), lu ${quand(c.synchronise_le)}` : 'jamais lu')),
      c.erreur ? el('div', { classe: 'erreur' }, '⚠ ' + c.erreur) : null),
    modifiable ? el('div', { classe: 'actions' },
      el('button', { type: 'button', classe: 'discret', onclick: () => synchroniser(c).catch((e) => dire(e.message, true)) }, 'Synchroniser'),
      el('button', { type: 'button', classe: 'discret', onclick: async () => {
        if (!confirm('Retirer « ' + c.nom + ' » ? Ses réservations disparaîtront de l’horaire.')) return;
        try { await retraitPro('calendriers', { id: 'eq.' + c.id }); await afficher(); dire('Calendrier retiré.'); }
        catch (e) { dire(e.message, true); }
      } }, 'Retirer')) : null));

  const plateau = el('select', null, plateaux.map((p) => el('option', { value: p.id }, nomPl(p.id))));
  const nom = el('input', { required: true, maxlength: 80, placeholder: 'ex. Réservations Outlook' });
  const url = el('input', { required: true, type: 'url', placeholder: 'https://… ou webcal://…' });
  return el('div', { classe: 'carte-formulaire' },
    el('h3', null, 'Calendriers (Outlook, Google, iCloud)'),
    el('p', { classe: 'doux' }, 'Collez l’adresse iCal d’un calendrier : ses événements deviennent les réservations du plateau, '
      + 'relues toutes les 15 minutes, récurrences comprises. Les journées entières sont ignorées. '
      + 'Gardez cette adresse pour vous : elle donne accès au calendrier.'),
    lignes,
    modifiable ? el('form', { classe: 'ajout-calendrier', onsubmit: async (ev) => {
        ev.preventDefault();
        try {
          const [c] = await ajoutPro('calendriers', { organisation_id: etat.organisation, plateau_id: plateau.value,
            nom: nom.value.trim(), url: url.value.trim() });
          await synchroniser(c);
        } catch (e) { dire(e.message, true); }
      } },
      el('div', { classe: 'champs' }, el('label', null, 'Plateau', plateau), el('label', null, 'Nom', nom),
        el('label', { classe: 'large' }, 'Adresse iCal (.ics)', url)),
      el('details', null, el('summary', null, 'Où trouver l’adresse iCal ?'),
        el('ul', null,
          el('li', null, el('strong', null, 'Outlook (Microsoft 365) : '), 'Paramètres ▸ Calendrier ▸ Calendriers partagés ▸ Publier un calendrier ; choisissez le calendrier, « Peut afficher tous les détails », puis copiez le lien ICS.'),
          el('li', null, el('strong', null, 'Google Agenda : '), 'Paramètres de l’agenda ▸ Intégrer l’agenda ▸ « Adresse secrète au format iCal ».'),
          el('li', null, el('strong', null, 'iCloud : '), 'App Calendrier ▸ partager le calendrier ▸ « Calendrier public », puis copiez le lien (webcal://…).'))),
      el('div', { classe: 'actions' }, el('button', { type: 'submit' }, 'Ajouter le calendrier'))) : null);
}
