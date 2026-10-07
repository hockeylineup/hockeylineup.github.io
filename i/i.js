'use strict';
// La page d'une invitation : /i/?c=CODE (Vincent, 4 octobre 2026). Avec
// l'app installée, le téléphone ne vient jamais ici. Sans elle : le nom et le
// logo de la ligue (`apercu_invitation`, ouvert sans compte), le code, et les
// magasins. Toucher un magasin copie le lien : à la première ouverture,
// EspaceLigue le lit dans le presse-papiers et propose de joindre la ligue.

// Servie depuis le Mac (`lancer-site.sh` du dépôt lineup), la page parle à la
// base de développement du M1 ; en ligne, à la production. Comme les apps :
// Debug au M1, Release à la production (7 octobre 2026).
const LOCAL = ['localhost', '127.0.0.1'].includes(location.hostname);
const SUPABASE = LOCAL ? 'https://supabase.lautmandam.mywire.org' : 'https://wkjyeyswlvdkaalhslvw.supabase.co';
// La clé publiable : faite pour vivre dans une page, RLS fait le reste.
const CLE = LOCAL ? 'sb_publishable_sHSVbbwMhsDTqjYb93S1md_P0EIsxy4' : 'sb_publishable_aDtOKUHIXbnSLWX6qPBpuQ_bixLx_ft';
// ⚠️ À remplir quand l'app sera publiée. Vides : le bouton dit « Bientôt ».
const APP_STORE = '';
const PLAY_STORE = '';

const $ = (id) => document.getElementById(id);
const code = (new URLSearchParams(location.search).get('c') || '').trim().toUpperCase();
const lien = location.origin + '/i/?c=' + encodeURIComponent(code);

function introuvable() {
  $('titre').textContent = 'Invitation introuvable';
  $('texte').textContent = 'Ce code est expiré ou n\'existe pas. Demande un nouveau lien à ton gérant.';
}

async function copier() {
  try { await navigator.clipboard.writeText(lien); return true; } catch { return false; }
}

function magasin(el, url) {
  if (!url) { el.textContent += ' · bientôt'; el.classList.add('secondaire'); el.removeAttribute('href'); }
  el.addEventListener('click', async (ev) => {
    ev.preventDefault();
    await copier();
    if (url) location.href = url;
  });
}

async function charger() {
  if (!/^[0-9A-F]{6,12}$/.test(code)) return introuvable();
  let lignes;
  try {
    const r = await fetch(SUPABASE + '/rest/v1/rpc/apercu_invitation', {
      method: 'POST', credentials: 'omit', cache: 'no-store',
      headers: { apikey: CLE, 'Content-Type': 'application/json' },
      body: JSON.stringify({ p_code: code }),
    });
    lignes = r.ok ? await r.json() : null;
  } catch { lignes = null; }
  if (!lignes) {
    $('titre').textContent = 'Invitation';
    $('texte').textContent = 'Le serveur ne répond pas. Réessaie dans un moment.';
    return;
  }
  const inv = lignes[0];
  if (!inv) return introuvable();

  document.title = 'EspaceLigue · ' + inv.ligue;
  if (inv.logo) {
    $('logo').src = SUPABASE + '/storage/v1/object/public/logos/' + inv.logo;
    if (inv.logo_pastille) $('logo').classList.add('pastille');
  }
  $('titre').textContent = inv.ligue;
  $('texte').textContent = inv.reserve
    ? 'Tu es invité à joindre la ligue. Crée ton compte avec l\'adresse courriel qui a reçu l\'invitation.'
    : 'Tu es invité à joindre la banque de joueurs. Un gérant approuvera ta demande.';
  $('code').textContent = code;
  $('bloc-code').hidden = false;
  // Un lien du même domaine n'ouvre pas l'app sur iOS : le schéma lineup://.
  $('ouvrir').href = 'lineup://rejoindre?code=' + encodeURIComponent(code);
  magasin($('ios'), APP_STORE);
  magasin($('android'), PLAY_STORE);
  $('magasins').hidden = false;
}

charger();
