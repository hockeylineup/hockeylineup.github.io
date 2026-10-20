// EspaceLigue Pro · Gestion — outils de l'horaire des plateaux (docs/horaire.md
// d'espaceligue-pro) : dates, calendriers iCal. La grille est dans
// planification.js. Chargé après gestion.js et contenu.js.
//
// Trois sources de réservations, que l'écran montre pareil :
// - saisies ici, à la main (source `manuel`), une à une ou chaque semaine ;
// - les matchs des ligues EspaceLigue acceptées dans l'onglet Ligues (ligues.js ;
//   la base les tient à jour toutes les 5 minutes) ; la glace d'un match se
//   change ici ;
// - un calendrier iCal par plateau (Outlook, Google, iCloud), relu toutes les
//   15 minutes par l'Edge Function pro-calendriers.
// Les deux dernières ne se modifient pas ici : elles reviendraient de la source.
//
// Dans l'autre sens, un calendrier publié (pro.flux_ics) : une adresse ICS
// secrète, servie par l'Edge Function pro-ics, à laquelle Outlook, Google ou
// iCloud s'abonnent ; l'horaire d'ici en est la source.
'use strict';


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
// --- Calendriers publiés (EspaceLigue Pro → Outlook, Google, iCloud) --------------
async function blocFluxPublies(plateaux, etablissements, nomEtab, modifiable) {
  const flux = await lirePro('flux_ics', { select: '*', organisation_id: 'eq.' + etat.organisation, order: 'nom' });
  const adresse = (f) => SUPABASE + '/functions/v1/pro-ics?j=' + f.jeton;
  const portee = (f) => f.plateau_id ? (() => { const p = plateaux.find((x) => x.id === f.plateau_id); return p ? nomEtab(p.etablissement_id) + ' · ' + p.nom : '?'; })()
    : f.etablissement_id ? nomEtab(f.etablissement_id) : 'Toute l’organisation';
  const copier = async (texte) => { try { await navigator.clipboard.writeText(texte); dire('Adresse copiée.'); } catch { prompt('Adresse :', texte); } };
  const lignes = flux.map((f) => el('div', { classe: 'ligne-source' },
    el('div', null, el('strong', null, f.nom), el('div', { classe: 'doux' }, portee(f)
      + (f.avec_demandes ? ' · demandes comprises' : '') + (f.avec_importes ? ' · importés compris' : '')
      + ' · ' + (f.lu_le ? 'lu ' + quand(f.lu_le) : 'jamais lu'))),
    el('div', { classe: 'actions' },
      el('button', { type: 'button', classe: 'discret', onclick: () => copier(adresse(f)) }, 'Copier l’adresse'),
      el('button', { type: 'button', classe: 'discret', onclick: () => { location.href = adresse(f).replace(/^https:/, 'webcal:'); } }, 'S’abonner'),
      modifiable ? el('button', { type: 'button', classe: 'discret', onclick: async () => {
        if (!confirm('Retirer « ' + f.nom + ' » ? Les abonnés ne recevront plus l’horaire.')) return;
        try { await retraitPro('flux_ics', { id: 'eq.' + f.id }); await afficher(); dire('Calendrier publié retiré.'); }
        catch (e) { dire(e.message, true); }
      } }, 'Retirer') : null)));

  const choix = el('select', null,
    el('option', { value: '' }, 'Toute l’organisation'),
    etablissements.map((e) => el('option', { value: 'e:' + e.id }, e.nom)),
    plateaux.map((p) => el('option', { value: 'p:' + p.id }, nomEtab(p.etablissement_id) + ' · ' + p.nom)));
  const nom = el('input', { required: true, maxlength: 80, placeholder: 'ex. Horaire de la glace 1' });
  const demandes = el('input', { type: 'checkbox' });
  const importes = el('input', { type: 'checkbox' });
  return el('div', { classe: 'carte-formulaire' },
    el('h3', null, 'Calendriers publiés'),
    el('p', { classe: 'doux' }, 'EspaceLigue Pro est la source : abonnez Outlook, Google ou iCloud à l’adresse. Gardez-la pour vous.'),
    lignes,
    modifiable ? el('form', { classe: 'ajout-calendrier', onsubmit: async (ev) => {
      ev.preventDefault();
      const v = choix.value;
      try {
        await ajoutPro('flux_ics', { organisation_id: etat.organisation, nom: nom.value.trim(),
          etablissement_id: v.startsWith('e:') ? v.slice(2) : null, plateau_id: v.startsWith('p:') ? v.slice(2) : null,
          avec_demandes: demandes.checked, avec_importes: importes.checked });
        await afficher(); dire('Calendrier publié.');
      } catch (e) { dire(e.message, true); }
    } },
      el('div', { classe: 'champs' }, el('label', null, 'Portée', choix), el('label', null, 'Nom', nom)),
      el('label', null, demandes, ' Inclure les demandes non confirmées'),
      el('label', null, importes, ' Inclure les calendriers importés'),
      el('details', null, el('summary', null, 'Comment s’abonner ?'),
        el('ul', null,
          el('li', null, el('strong', null, 'Outlook : '), 'Ajouter un calendrier ▸ S’abonner à partir du web ▸ collez l’adresse.'),
          el('li', null, el('strong', null, 'Google Agenda : '), 'Autres agendas ▸ + ▸ À partir de l’URL ▸ collez l’adresse (relu toutes les quelques heures).'),
          el('li', null, el('strong', null, 'iCloud : '), 'bouton « S’abonner », ou Fichier ▸ Nouvel abonnement.'))),
      el('div', { classe: 'actions' }, el('button', { type: 'submit' }, 'Publier'))) : null);
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
