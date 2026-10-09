// Liste d'attente : le courriel (et la ligue) partent à `inscrire_liste_attente`,
// la seule porte de la table. Servie depuis le Mac, la base du M1.
'use strict';
const LOCAL = ['localhost', '127.0.0.1'].includes(location.hostname);
const SUPABASE = LOCAL ? 'https://supabase.lautmandam.mywire.org' : 'https://wkjyeyswlvdkaalhslvw.supabase.co';
const CLE = LOCAL ? 'sb_publishable_sHSVbbwMhsDTqjYb93S1md_P0EIsxy4' : 'sb_publishable_aDtOKUHIXbnSLWX6qPBpuQ_bixLx_ft';

document.addEventListener('DOMContentLoaded', () => {
  const f = document.getElementById('attente');
  const reponse = document.getElementById('reponse');
  f.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const bouton = ev.submitter;
    bouton.disabled = true;
    reponse.className = '';
    reponse.textContent = '';
    try {
      const r = await fetch(SUPABASE + '/rest/v1/rpc/inscrire_liste_attente', {
        method: 'POST', credentials: 'omit', cache: 'no-store',
        headers: { apikey: CLE, 'Content-Type': 'application/json' },
        body: JSON.stringify({ p_courriel: document.getElementById('courriel').value.trim(),
                               p_ligue: document.getElementById('ligue').value.trim() || null }),
      });
      if (!r.ok) {
        const d = await r.json().catch(() => ({}));
        throw new Error(d.message || 'Envoi impossible. Réessaie plus tard.');
      }
      f.replaceChildren(Object.assign(document.createElement('p'), {
        id: 'reponse', textContent: 'Merci ! On t\'écrit dès l\'ouverture.' }));
    } catch (e) {
      reponse.className = 'erreur';
      reponse.textContent = e.message;
      bouton.disabled = false;
    }
  });
});
