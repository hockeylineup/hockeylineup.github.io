// « Finances » de l'Espace gérant : tout l'argent d'une saison, pour le gérant
// titulaire (20 novembre 2026). Pendant de VueFinancesLigue (iOS) : la base
// fait tout (`finances_ligue`, `enregistrer_ecriture_ligue`,
// `supprimer_ecriture_ligue`) et refuse les autres comptes.
'use strict';

const CATEGORIES = [['glace', tr('Glace')], ['arbitres', tr('Arbitres')], ['equipement', tr('Équipement')], ['autre', tr('Autre')]];
const fin = { saison: null };
const argent = (c) => (c / 100).toLocaleString(LOCALE, { style: 'currency', currency: 'CAD' });
const motif = (d) => d.motif === 'frais_saison' ? tr('Frais de saison')
  : d.motif === 'remplacement' ? tr('Remplacement') : (d.description || tr('Autre'));

function vueFinances() {
  const boite = el('div');
  if (!etat.saisons.length) return [carte(tr('Finances'), el('p', { classe: 'doux' }, tr('Aucune saison.')))];
  if (!etat.saisons.some((s) => s.id === fin.saison)) fin.saison = etat.saisons[0].id;
  const choixSaison = el('select', { onchange: (e) => { fin.saison = e.target.value; chargerFinances(boite); } },
    etat.saisons.map((s) => el('option', { value: s.id }, s.nom)));
  choixSaison.value = fin.saison;
  chargerFinances(boite);
  return [el('label', null, tr('Saison'), choixSaison), boite];
}

async function chargerFinances(boite) {
  boite.replaceChildren(el('p', { classe: 'doux' }, tr('Chargement…')));
  try {
    const f = await rpc('finances_ligue', { p_ligue: etat.ligue, p_saison: fin.saison });
    boite.replaceChildren(...rendreFinances(f, boite));
  } catch (e) {
    boite.replaceChildren();
    dire(e.message, true);
  }
}

function rendreFinances(f, boite) {
  const t = f.totaux;
  const solde = t.encaisse_cents - t.depense_cents;
  const ligne = (a, b) => el('tr', null, el('td', null, a), el('td', { classe: 'montant' }, b));
  const totaux = carte(tr('Sommaire'), el('table', { classe: 'finances' }, el('tbody', null,
    ligne(tr('Encaissé'), argent(t.encaisse_cents)), ligne(tr('À recevoir'), argent(t.a_recevoir_cents)),
    ligne(tr('Dépensé'), argent(t.depense_cents)), ligne(tr('À payer'), argent(t.a_payer_cents)),
    ligne(el('strong', null, tr('Solde')), el('strong', null, argent(solde))))));

  const tableDus = (titre, dus) => carte(titre, dus.length ? el('table', { classe: 'finances' },
    el('thead', null, el('tr', null, ...[tr('Nom'), tr('Motif'), tr('Montant'), tr('Reste'), ''].map((x) => el('th', null, x)))),
    el('tbody', null, dus.map((d) => el('tr', null,
      el('td', null, d.nom || tr('Compte supprimé')), el('td', null, motif(d)),
      el('td', { classe: 'montant' }, argent(d.montant_cents)),
      el('td', { classe: 'montant' }, d.reste_cents ? argent(d.reste_cents) : tr('Réglé')),
      el('td', null, f.paiement_manuel && d.sens === 'entree' && d.reste_cents
        ? el('button', { type: 'button', onclick: () => noterPaiement(d, boite) }, tr('Noter un paiement')) : null)))))
    : el('p', { classe: 'doux' }, tr('Rien pour cette saison.')));

  const joueurs = f.dus.filter((d) => d.motif !== 'remplacement');
  const remplacements = f.dus.filter((d) => d.motif === 'remplacement');
  return [totaux, tableDus(tr('Joueurs'), joueurs), tableDus(tr('Remplacements'), remplacements),
    carte(tr('Dépenses et revenus'), formulaireEcriture(null, boite),
      f.ecritures.length ? el('table', { classe: 'finances' }, el('tbody', null, f.ecritures.map((e) => el('tr', null,
        el('td', null, e.jour), el('td', null, (CATEGORIES.find(([c]) => c === e.categorie) || [, ''])[1]),
        el('td', null, e.note || ''),
        el('td', { classe: 'montant' }, (e.sens === 'revenu' ? '+' : '−') + argent(e.montant_cents)),
        el('td', null, el('button', { type: 'button', onclick: () => supprimerEcriture(e, boite) }, tr('Supprimer')))))))
      : el('p', { classe: 'doux' }, tr('Aucune dépense.'))),
    el('p', null, el('button', { type: 'button', onclick: () => exporterCsv(f) }, tr('Exporter (CSV)')))];
}

function formulaireEcriture(e, boite) {
  const sens = el('select', null, el('option', { value: 'depense' }, tr('Dépense')), el('option', { value: 'revenu' }, tr('Revenu')));
  const cat = el('select', null, CATEGORIES.map(([v, x]) => el('option', { value: v }, x)));
  const jour = el('input', { type: 'date', valeur: new Date().toLocaleDateString('en-CA'), 'aria-label': tr('Date') });
  const montant = el('input', { type: 'number', min: 0, step: '0.01', inputmode: 'decimal', placeholder: tr('Montant ($)') });
  const note = el('input', { type: 'text', maxlength: 300, placeholder: tr('Note') });
  return el('form', { classe: 'en-ligne', onsubmit: async (ev) => {
    ev.preventDefault();
    const cents = Math.round(Number(montant.value) * 100);
    if (!(cents > 0)) { dire(tr('Entre un montant.'), true); return; }
    try {
      await rpc('enregistrer_ecriture_ligue', { p_id: null, p_ligue: etat.ligue, p_saison: fin.saison, p_jour: jour.value || null,
        p_sens: sens.value, p_categorie: cat.value, p_montant_cents: cents, p_note: note.value });
      dire(tr('Enregistré.'), false, true);
      chargerFinances(boite);
    } catch (err) { dire(err.message, true); }
  } }, sens, cat, jour, montant, note, el('button', { type: 'submit' }, tr('Ajouter')));
}

async function supprimerEcriture(e, boite) {
  if (!confirm(tr('Supprimer cette entrée ?'))) return;
  try { await rpc('supprimer_ecriture_ligue', { p_id: e.id }); chargerFinances(boite); } catch (err) { dire(err.message, true); }
}

async function noterPaiement(d, boite) {
  const saisi = prompt(tr('Montant reçu ($) de %@ :', d.nom || ''), (d.reste_cents / 100).toFixed(2));
  if (saisi == null) return;
  const cents = Math.min(Math.round(Number(saisi.replace(',', '.')) * 100), d.reste_cents);
  if (!(cents > 0)) { dire(tr('Entre un montant.'), true); return; }
  const methode = confirm(tr('Payé par Interac ? (Annuler = comptant)')) ? 'interac' : 'comptant';
  try {
    await rest('POST', 'paiements', { du_id: d.id, ligue_id: etat.ligue, montant_cents: cents, methode },
               { Prefer: 'return=minimal' });
    dire(tr('Paiement noté.'), false, true);
    chargerFinances(boite);
  } catch (err) { dire(err.message, true); }
}

function exporterCsv(f) {
  const q = (v) => '"' + String(v ?? '').replace(/"/g, '""') + '"';
  const lignes = [['Type', 'Date', 'Nom ou catégorie', 'Motif ou note', 'Montant', 'Reste'].map(q).join(',')];
  f.dus.forEach((d) => lignes.push([d.sens === 'entree' ? 'À recevoir' : 'À payer', d.cree_le.slice(0, 10), d.nom,
    motif(d), (d.montant_cents / 100).toFixed(2), (d.reste_cents / 100).toFixed(2)].map(q).join(',')));
  f.ecritures.forEach((e) => lignes.push([e.sens === 'revenu' ? 'Revenu' : 'Dépense', e.jour, e.categorie, e.note,
    (e.montant_cents / 100).toFixed(2), ''].map(q).join(',')));
  const lien = el('a', { href: URL.createObjectURL(new Blob(['﻿' + lignes.join('\n')], { type: 'text/csv' })),
                         download: 'finances.csv' });
  document.body.append(lien); lien.click(); lien.remove();
}
