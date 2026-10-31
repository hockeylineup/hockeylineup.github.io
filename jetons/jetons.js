// EspaceLigue · Jetons — le gérant d'une ligue voit son solde, achète un
// paquet et suit ses transactions. Les données viennent de `jetons_ligue`, la
// même fonction que l'écran Jetons de l'app.
//
// L'achat : `jetons-achat` ouvre une session Stripe Checkout et la page y
// part. Au retour, rien n'est encore sûr : seul le webhook signé crédite la
// ligue. La page relit donc le solde quelques fois avant de le dire.
'use strict';

const NATURES = { paquet: 'Achat de jetons', forfait: 'Forfait', debit_confirmation: 'Recherche comblée',
                  correction: 'Correction', ajustement: 'Ajustement' };
const GENRES = { remplacant: 'Remplaçant', gardien: 'Gardien', arbitre: 'Arbitre' };
const ONGLETS = [['achat', 'Acheter'], ['transactions', 'Transactions']];

const etat = { ligues: [], ligue: null, j: null, onglet: 'achat', occupe: false, voulue: null };
const argent = (c) => (c / 100).toLocaleString('fr-CA', { style: 'currency', currency: 'CAD' });
const pluriel = (n, mot) => n + ' ' + mot + (Math.abs(n) > 1 ? 's' : '');
const quand = (iso) => new Date(iso).toLocaleDateString('fr-CA', { dateStyle: 'medium' });

function dire(texte, erreur) {
  const m = $('message');
  m.textContent = texte;
  m.className = 'message' + (erreur ? ' erreur' : '');
  m.hidden = !texte;
}

// Une Edge Function, avec le jeton de la session.
async function fonction(nom, corps) {
  const r = await fetch(SUPABASE + '/functions/v1/' + nom, {
    method: 'POST', credentials: 'omit', cache: 'no-store',
    headers: { apikey: CLE, Authorization: 'Bearer ' + await jetonFrais(), 'Content-Type': 'application/json' },
    body: JSON.stringify(corps),
  });
  const d = await r.json().catch(() => ({}));
  if (r.status === 401) { sessionPerdue(); throw new Error('Session expirée.'); }
  if (!r.ok) throw new Error(d.erreur || 'Erreur ' + r.status);
  return d;
}

// --- Connexion -----------------------------------------------------------------
async function connecter(ev) {
  ev.preventDefault();
  const bouton = ev.submitter;
  bouton.disabled = true;
  $('erreur-connexion').textContent = '';
  try {
    poserJetons(await auth('token?grant_type=password', { email: $('courriel').value.trim(), password: $('mdp').value }));
    $('mdp').value = '';
    await ouvrir(etat.voulue);
  } catch (e) {
    $('erreur-connexion').textContent = e.message;
  } finally {
    bouton.disabled = false;
  }
}

function deconnecter(raison) {
  oublierSession();
  $('app').hidden = true;
  $('connexion').hidden = false;
  $('erreur-connexion').textContent = raison || '';
}

// Les ligues que le compte gère (titulaire ou modérateur : tous voient le solde).
async function ouvrir(voulue) {
  const roles = await rpc('mes_roles');
  const vues = new Set();
  etat.ligues = (roles || []).filter((r) => r.role === 'gerant_ligue' && !vues.has(r.ligue_id) && vues.add(r.ligue_id))
    .sort((a, b) => a.ligue.localeCompare(b.ligue, 'fr'));
  $('connexion').hidden = true;
  $('app').hidden = false;
  $('qui').replaceChildren(el('span', { classe: 'courriel' }, (session.utilisateur && session.utilisateur.email) || ''));
  if (!etat.ligues.length) {
    $('contenu').replaceChildren(el('section', { classe: 'fiche' }, el('h2', null, 'Aucune ligue à gérer'),
      el('p', { classe: 'doux' }, 'Les jetons appartiennent à une ligue. Ce compte n’en gère aucune.')));
    return;
  }
  let garde = voulue;
  if (!garde) try { garde = localStorage.getItem('espaceligue-ligue'); } catch (e) { /* bloqué */ }
  etat.ligue = etat.ligues.some((l) => l.ligue_id === garde) ? garde : etat.ligues[0].ligue_id;
  $('ligue').replaceChildren(...etat.ligues.map((l) => el('option', { value: l.ligue_id }, l.ligue)));
  $('ligue').value = etat.ligue;
  $('choix-ligue').hidden = etat.ligues.length < 2;
  await charger();
}

async function charger() {
  try {
    etat.j = await rpc('jetons_ligue', { p_ligue: etat.ligue });
    afficher();
  } catch (e) {
    dire(e.message, true);
  }
}

// --- Affichage -------------------------------------------------------------------
function afficher() {
  $('onglets').replaceChildren(...ONGLETS.map(([cle, titre]) =>
    el('button', { type: 'button', classe: cle === etat.onglet ? 'actif' : null,
                   onclick: () => { etat.onglet = cle; afficher(); } }, titre)));
  const nom = (etat.ligues.find((l) => l.ligue_id === etat.ligue) || {}).ligue || '';
  $('contenu').replaceChildren(el('div', { classe: 'tete-jetons' }, el('h2', null, 'Jetons'), el('span', { classe: 'doux' }, nom)),
    carteSolde(), ...(etat.onglet === 'achat' ? vueAchat() : vueTransactions()));
}

function carteSolde() {
  const j = etat.j;
  const prix = Object.entries(j.tarifs || {}).sort(([a], [b]) => ['remplacant', 'gardien', 'arbitre'].indexOf(a)
    - ['remplacant', 'gardien', 'arbitre'].indexOf(b));
  return el('section', { classe: 'solde' },
    el('img', { src: 'jeton.png', alt: '', classe: 'piece' }),
    el('div', { classe: 'chiffres' },
      el('span', { classe: 'libelle' }, 'Disponibles'),
      el('b', {}, pluriel(j.disponibles, 'jeton')),
      j.reserves ? el('span', { classe: 'doux' }, pluriel(j.reserves, 'jeton') + ' de côté pour des recherches en cours') : null),
    prix.length ? el('ul', { classe: 'prix' }, el('li', { classe: 'libelle' }, 'Coût d’une recherche'), prix.map(([g, n]) =>
      el('li', {}, el('span', {}, GENRES[g] || g), el('b', {}, pluriel(n, 'jeton'))))) : null);
}

function vueAchat() {
  const j = etat.j;
  if (!j.actifs) return [el('p', { classe: 'vide' }, 'Les jetons arrivent bientôt. Les recherches restent gratuites d’ici là.')];
  if (!j.paquets.length) return [el('p', { classe: 'vide' }, 'Aucun paquet en vente pour le moment.')];
  // Le meilleur prix par jeton porte l'étiquette.
  const unitaire = (p) => p.prix_cents / p.jetons;
  const meilleur = j.paquets.reduce((m, p) => (unitaire(p) < unitaire(m) ? p : m), j.paquets[0]);
  const base = Math.max(...j.paquets.map(unitaire));
  return [
    el('div', { classe: 'paquets' }, j.paquets.map((p) => {
      const economie = Math.round(100 * (1 - unitaire(p) / base));
      return el('article', { classe: 'paquet' + (p === meilleur && j.paquets.length > 1 ? ' vedette' : '') },
        p === meilleur && j.paquets.length > 1 ? el('span', { classe: 'ruban' }, 'Meilleur prix') : null,
        el('div', { classe: 'quantite' }, el('img', { src: 'jeton.png', alt: '' }), el('b', {}, p.jetons), el('span', {}, 'jetons')),
        el('div', { classe: 'montant' }, argent(p.prix_cents)),
        el('div', { classe: 'doux unitaire' }, argent(Math.round(unitaire(p))) + ' le jeton',
          economie > 0 ? el('span', { classe: 'economie' }, ' · ' + economie + ' % d’économie') : null),
        j.titulaire
          ? el('button', { type: 'button', onclick: (ev) => acheter(p, ev.currentTarget) }, 'Acheter')
          : null);
    })),
    j.titulaire
      ? el('p', { classe: 'doux note' }, 'Paiement sécurisé par Stripe. Les jetons n’expirent pas.')
      : el('p', { classe: 'doux note' }, 'Seul le gérant titulaire de la ligue peut acheter des jetons.'),
  ];
}

function vueTransactions() {
  const ms = etat.j.mouvements;
  if (!ms.length) return [el('p', { classe: 'vide' }, 'Aucune transaction pour le moment.')];
  return [el('section', { classe: 'panneau' }, el('div', { classe: 'table' }, el('table', { classe: 'registre' },
    el('thead', {}, el('tr', {}, el('th', {}, 'Date'), el('th', {}, 'Description'),
      el('th', { classe: 'chiffre' }, 'Jetons'), el('th', { classe: 'chiffre' }, 'Montant'))),
    el('tbody', {}, ms.map((m) => el('tr', {},
      el('td', { classe: 'date' }, quand(m.fait_le)),
      el('td', {}, NATURES[m.nature] || m.nature,
        m.genre ? el('span', { classe: 'doux' }, ' · ' + (GENRES[m.genre] || m.genre)) : null,
        m.match_debut ? el('span', { classe: 'doux' }, ' · match du ' + quand(m.match_debut)) : null,
        m.note ? el('div', { classe: 'doux petit' }, m.note) : null),
      el('td', { classe: 'chiffre ' + (m.quantite > 0 ? 'vert' : '') }, (m.quantite > 0 ? '+' : '−') + Math.abs(m.quantite)),
      el('td', { classe: 'chiffre' }, m.prix_cents ? argent(m.prix_cents) : '')))))))];
}

// --- Achat -------------------------------------------------------------------------
async function acheter(p, bouton) {
  if (etat.occupe) return;
  etat.occupe = true;
  bouton.disabled = true;
  bouton.textContent = 'Un instant…';
  dire('');
  try {
    const { url } = await fonction('jetons-achat', { ligue_id: etat.ligue, paquet_id: p.id });
    if (!/^https:\/\/checkout\.stripe\.com\//.test(url)) throw new Error('Adresse de paiement inattendue.');
    location.assign(url);
  } catch (e) {
    dire(e.message, true);
    bouton.disabled = false;
    bouton.textContent = 'Acheter';
    etat.occupe = false;
  }
}

// Au retour de Stripe : le webhook peut avoir quelques secondes de retard.
async function attendreCredit(avant) {
  dire('Paiement reçu. Les jetons arrivent…');
  for (let i = 0; i < 10; i++) {
    await new Promise((r) => setTimeout(r, 2000));
    await charger();
    if (etat.j.total > avant) { dire('Merci ! Les jetons sont dans la banque de la ligue.'); return; }
  }
  dire('Paiement reçu. Les jetons paraîtront dans quelques minutes.');
}

// --- Démarrage -----------------------------------------------------------------
sessionPerdue = () => deconnecter('Session expirée.');

document.addEventListener('DOMContentLoaded', async () => {
  const p = new URLSearchParams(location.search);
  const ligueVoulue = etat.voulue = p.get('ligue'), achat = p.get('achat');
  if (achat || ligueVoulue) history.replaceState(null, '', location.pathname);
  $('formulaire-connexion').addEventListener('submit', connecter);
  $('apple').addEventListener('click', () => continuerAvecApple().catch((e) => {
    $('erreur-connexion').textContent = e.message;
  }));
  $('deconnexion').addEventListener('click', () => deconnecter(''));
  $('ligue').addEventListener('change', (e) => {
    etat.ligue = e.target.value;
    try { localStorage.setItem('espaceligue-ligue', etat.ligue); } catch (x) { /* bloqué */ }
    charger();
  });
  try {
    if (await retourApple() || await reprendreSession()) {
      await ouvrir(ligueVoulue);
      if (achat === 'reussi' && etat.j) {
        // Le solde d'avant le crédit : si le webhook a déjà crédité, la boucle s'arrête au premier tour.
        const ventes = etat.j.mouvements.filter((m) => m.nature === 'paquet');
        const recent = ventes[0] && Date.now() - new Date(ventes[0].fait_le) < 10 * 60000;
        if (recent) dire('Merci ! Les jetons sont dans la banque de la ligue.');
        else attendreCredit(etat.j.total);
      } else if (achat === 'annule') {
        dire('Achat annulé. Rien n’a été facturé.');
      }
      return;
    }
  } catch (e) {
    $('erreur-connexion').textContent = e.message;
  }
  $('connexion').hidden = false;
});
