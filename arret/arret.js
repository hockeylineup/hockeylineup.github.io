'use strict';
// /arret/?j=JETON : le désabonnement d'une invitation par courriel (23 novembre
// 2026). Le lien du courriel reste sur espaceligue.ca (un lien vers un autre
// domaine que l'expéditeur nuit à la livraison) ; la page annule l'invitation
// par la fonction invitation-courriel.
const LOCAL = ['localhost', '127.0.0.1'].includes(location.hostname);
const SUPABASE = LOCAL ? 'https://supabase.lautmandam.mywire.org' : 'https://wkjyeyswlvdkaalhslvw.supabase.co';
const $ = (id) => document.getElementById(id);

async function arreter() {
  const jeton = new URLSearchParams(location.search).get('j') || '';
  if (!/^[0-9a-f]{32}$/.test(jeton)) {
    $('titre').textContent = tr('Lien invalide');
    return;
  }
  try {
    const r = await fetch(`${SUPABASE}/functions/v1/invitation-courriel?arreter=${jeton}`, { method: 'POST' });
    if (!r.ok) throw new Error();
    $('titre').textContent = tr('C\'est noté.');
    $('texte').textContent = tr('Tu ne recevras plus de courriel pour cette invitation.');
  } catch {
    $('titre').textContent = tr('Oups');
    $('texte').textContent = tr('Le serveur ne répond pas. Réessaie dans un moment.');
  }
}
arreter();
