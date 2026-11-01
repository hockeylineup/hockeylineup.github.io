// EspaceLigue · Jetons — le gérant d'une ligue voit son solde, achète un
// paquet et suit ses transactions. Les données viennent de `jetons_ligue`, la
// même fonction que l'écran Jetons de l'app.
//
// L'achat : `jetons-achat` ouvre une session Stripe Checkout et la page y
// part. Au retour, rien n'est encore sûr : seul le webhook signé crédite la
// ligue. La page relit donc le solde quelques fois avant de le dire.
'use strict';

const NATURES = { paquet: tr('Achat de jetons'), forfait: tr('Forfait'), debit_confirmation: tr('Recherche comblée'),
                  correction: tr('Correction'), ajustement: tr('Ajustement'), transfert: tr('Transfert') };
const GENRES = { remplacant: tr('Remplaçant'), gardien: tr('Gardien'), arbitre: tr('Arbitre') };
const ONGLETS = [['achat', tr('Acheter des jetons')], ['transactions', tr('Historique des transactions')]];
// Le filtre de l'historique : ce qu'il garde.
const FILTRES = [['tout', tr('Toutes'), () => true], ['achat', tr('Achats'), (m) => m.nature === 'paquet'],
                 ['utilisation', tr('Utilisations'), (m) => m.nature === 'debit_confirmation'],
                 ['recu', tr('Transferts reçus'), (m) => m.nature === 'transfert' && m.quantite > 0],
                 ['envoye', tr('Transferts envoyés'), (m) => m.nature === 'transfert' && m.quantite < 0]];
// Les icônes du menu (tracés 24 × 24).
const ICONES = { achat: ['M2 7a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2zM2 10h20'],
                 transactions: ['M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0zM12 7v5l3 2'],
                 transfert: ['M4 8h14l-4-4M20 16H6l4 4'] };

const etat = { ligues: [], ligue: null, j: null, onglet: 'achat', filtre: 'tout', occupe: false, voulue: null };
const argent = (c) => (c / 100).toLocaleString(LOCALE, { style: 'currency', currency: 'CAD' });
const jetons = (n) => tr(Math.abs(n) > 1 ? '%@ jetons' : '%@ jeton', n);
const quand = (iso) => new Date(iso).toLocaleDateString(LOCALE, { dateStyle: 'medium' });
const quandHeure = (iso) => new Date(iso).toLocaleString(LOCALE, { dateStyle: 'medium', timeStyle: 'short' });

function icone(cle) {
  const ns = 'http://www.w3.org/2000/svg';
  const s = document.createElementNS(ns, 'svg');
  for (const [k, v] of Object.entries({ viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': 2,
    'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true' })) s.setAttribute(k, v);
  for (const d of ICONES[cle]) { const p = document.createElementNS(ns, 'path'); p.setAttribute('d', d); s.append(p); }
  return s;
}
const aller = (cle) => { etat.onglet = cle; afficher(); window.scrollTo(0, 0); };

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
  if (r.status === 401) { sessionPerdue(); throw new Error(tr('Session expirée.')); }
  if (!r.ok) throw new Error(d.erreur ? tr(d.erreur) : tr('Erreur %@', r.status));
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
    $('contenu').replaceChildren(el('section', { classe: 'fiche' }, el('h2', null, tr('Aucune ligue à gérer')),
      el('p', { classe: 'doux' }, tr('Les jetons appartiennent à une ligue. Ce compte n’en gère aucune.'))));
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
  const onglets = ONGLETS.concat(etat.j.autres_ligues && etat.j.autres_ligues.length ? [['transfert', tr('Transférer des jetons')]] : []);
  if (!onglets.some(([cle]) => cle === etat.onglet)) etat.onglet = 'achat';
  $('onglets').replaceChildren(...onglets.map(([cle, titre]) =>
    el('button', { type: 'button', classe: cle === etat.onglet ? 'actif' : null, onclick: () => aller(cle) }, icone(cle), titre)));
  const nom = (etat.ligues.find((l) => l.ligue_id === etat.ligue) || {}).ligue || '';
  const titre = onglets.find(([cle]) => cle === etat.onglet)[1];
  $('contenu').replaceChildren(...[el('div', { classe: 'tete-jetons' }, el('h2', null, titre), el('span', { classe: 'doux' }, nom)),
    etat.onglet === 'transactions' ? null : carteSolde(),
    ...({ achat: vueAchat, transactions: vueTransactions, transfert: vueTransfert }[etat.onglet])()].filter(Boolean));
}

function carteSolde() {
  const j = etat.j;
  const prix = Object.entries(j.tarifs || {}).sort(([a], [b]) => ['remplacant', 'gardien', 'arbitre'].indexOf(a)
    - ['remplacant', 'gardien', 'arbitre'].indexOf(b));
  return el('section', { classe: 'solde' },
    el('img', { src: 'jeton.png', alt: '', classe: 'piece' }),
    el('div', { classe: 'chiffres' },
      el('span', { classe: 'libelle' }, tr('Disponibles')),
      el('b', {}, jetons(j.disponibles)),
      j.reserves ? el('span', { classe: 'doux' }, tr('%@ de côté pour des recherches en cours', jetons(j.reserves))) : null,
      j.mouvements.length ? el('button', { type: 'button', classe: 'lien', onclick: () => aller('transactions') }, tr('Voir l’historique →')) : null),
    prix.length ? el('ul', { classe: 'prix' }, el('li', { classe: 'libelle' }, tr('Coût d’une recherche')), prix.map(([g, n]) =>
      el('li', {}, el('span', {}, GENRES[g] || g), el('b', {}, jetons(n))))) : null);
}

function vueAchat() {
  const j = etat.j;
  if (!j.actifs) return [el('p', { classe: 'vide' }, tr('Les jetons arrivent bientôt. Les recherches restent gratuites d’ici là.'))];
  if (!j.paquets.length) return [el('p', { classe: 'vide' }, tr('Aucun paquet en vente pour le moment.'))];
  // Le meilleur prix par jeton porte l'étiquette.
  const unitaire = (p) => p.prix_cents / p.jetons;
  const meilleur = j.paquets.reduce((m, p) => (unitaire(p) < unitaire(m) ? p : m), j.paquets[0]);
  const base = Math.max(...j.paquets.map(unitaire));
  return [
    el('div', { classe: 'paquets' }, j.paquets.map((p) => {
      const economie = Math.round(100 * (1 - unitaire(p) / base));
      return el('article', { classe: 'paquet' + (p === meilleur && j.paquets.length > 1 ? ' vedette' : '') },
        p === meilleur && j.paquets.length > 1 ? el('span', { classe: 'ruban' }, tr('Meilleur prix')) : null,
        el('div', { classe: 'quantite' }, el('img', { src: 'jeton.png', alt: '' }), el('b', {}, p.jetons), el('span', {}, tr('jetons'))),
        el('div', { classe: 'montant' }, argent(p.prix_cents)),
        el('div', { classe: 'doux unitaire' }, tr('%@ le jeton', argent(Math.round(unitaire(p)))),
          economie > 0 ? el('span', { classe: 'economie' }, ' · ' + tr('%@ % d’économie', economie)) : null),
        j.titulaire
          ? el('button', { type: 'button', onclick: (ev) => acheter(p, ev.currentTarget) }, tr('Acheter'))
          : null);
    })),
    j.titulaire ? null : el('p', { classe: 'doux note' }, tr('Seul le gérant titulaire de la ligue peut acheter des jetons.')),
    el('div', { classe: 'bas-achat' },
      j.mouvements.length ? el('section', { classe: 'panneau' },
        el('div', { classe: 'panneau-tete' }, el('h3', {}, tr('Dernières transactions')),
          el('button', { type: 'button', classe: 'lien', onclick: () => aller('transactions') }, tr('Voir tout l’historique →'))),
        registre(soldes().slice(0, 4))) : null,
      el('aside', { classe: 'aide-jetons' }, el('h3', {}, tr('Comment fonctionnent les jetons ?')), el('ul', {},
        el('li', {}, tr('Ils appartiennent à la ligue.')),
        el('li', {}, tr('Une recherche dans la banque générale met son prix de côté.')),
        el('li', {}, tr('Débités seulement si quelqu’un est confirmé ; sinon, rendus.')),
        el('li', {}, tr('Ils n’expirent pas.'))))),
  ];
}

// Les mouvements, du plus récent, chacun avec le solde qui le suit.
function soldes() {
  let s = etat.j.total;
  return etat.j.mouvements.map((m) => { const r = { m, solde: s }; s -= m.quantite; return r; });
}

function description(m) {
  if (m.nature === 'paquet') return tr('Achat de jetons (%@)', m.quantite);
  if (m.nature === 'transfert') return tr(m.quantite > 0 ? 'Transfert reçu' : 'Transfert envoyé');
  return NATURES[m.nature] || m.nature;
}

function registre(lignes) {
  return el('div', { classe: 'table' }, el('table', { classe: 'registre' },
    el('thead', {}, el('tr', {}, el('th', {}, tr('Date')), el('th', {}, tr('Description')),
      el('th', { classe: 'chiffre' }, tr('Jetons')), el('th', { classe: 'chiffre' }, tr('Solde')))),
    el('tbody', {}, lignes.map(({ m, solde }) => el('tr', {},
      el('td', { classe: 'date' }, quandHeure(m.fait_le)),
      el('td', {}, description(m),
        m.genre ? el('span', { classe: 'doux' }, ' · ' + (GENRES[m.genre] || m.genre)) : null,
        m.match_debut ? el('span', { classe: 'doux' }, ' · ' + tr('match du %@', quand(m.match_debut))) : null,
        m.note ? el('div', { classe: 'doux petit' }, m.note) : null),
      el('td', { classe: 'chiffre ' + (m.quantite > 0 ? 'vert' : 'rouge') }, (m.quantite > 0 ? '+' : '−') + Math.abs(m.quantite)),
      el('td', { classe: 'chiffre solde-ligne' }, solde))))));
}

function vueTransactions() {
  if (!etat.j.mouvements.length) return [el('p', { classe: 'vide' }, tr('Aucune transaction pour le moment.'))];
  const garde = FILTRES.find(([cle]) => cle === etat.filtre)[2];
  const lignes = soldes().filter(({ m }) => garde(m));
  return [el('section', { classe: 'panneau' },
    el('div', { classe: 'filtres' }, FILTRES.map(([cle, titre]) => el('button', { type: 'button',
      classe: cle === etat.filtre ? 'actif' : null, onclick: () => { etat.filtre = cle; afficher(); } }, titre))),
    lignes.length ? registre(lignes) : el('p', { classe: 'vide' }, tr('Aucune transaction de ce genre.')))];
}

// Le titulaire de plusieurs ligues déplace des jetons de celle-ci vers une autre.
function vueTransfert() {
  const j = etat.j;
  const vers = el('select', { 'aria-label': tr('Vers la ligue') }, j.autres_ligues.map((l) => el('option', { value: l.id }, l.nom)));
  const quantite = el('input', { type: 'number', min: 1, max: j.disponibles, step: 1, inputmode: 'numeric', required: true,
    placeholder: String(Math.min(10, j.disponibles || 10)) });
  const note = el('input', { placeholder: tr('Facultatif') });
  const bouton = el('button', { type: 'submit', disabled: j.disponibles <= 0 }, tr('Transférer'));
  return [el('form', { classe: 'panneau transfert', onsubmit: async (ev) => {
    ev.preventDefault();
    const n = parseInt(quantite.value, 10);
    if (!(n > 0)) { quantite.focus(); return; }
    const nom = vers.options[vers.selectedIndex].textContent;
    if (!confirm(tr('Transférer %@ vers « %@ » ?', jetons(n), nom))) return;
    bouton.disabled = true;
    try {
      await rpc('jetons_transferer', { p_de: etat.ligue, p_vers: vers.value, p_quantite: n, p_note: note.value.trim() });
      dire(tr(n > 1 ? '%@ transférés vers « %@ ».' : '%@ transféré vers « %@ ».', jetons(n), nom));
      await charger();
    } catch (e) {
      dire(e.message, true);
      bouton.disabled = false;
    }
  } },
    el('div', { classe: 'panneau-tete' }, el('h3', {}, tr('Transférer vers une autre ligue')),
      el('span', { classe: 'doux' }, tr('%@ disponibles', jetons(j.disponibles)))),
    el('div', { classe: 'champs-transfert' },
      el('label', {}, tr('Vers'), vers), el('label', {}, tr('Jetons'), quantite), el('label', {}, tr('Note'), note)),
    el('div', { classe: 'pied-transfert' }, bouton)),
    el('p', { classe: 'doux note' }, tr('Seulement entre les ligues dont tu es le gérant titulaire. Les jetons de côté restent ici.'))];
}

// --- Achat -------------------------------------------------------------------------
async function acheter(p, bouton) {
  if (etat.occupe) return;
  etat.occupe = true;
  bouton.disabled = true;
  bouton.textContent = tr('Un instant…');
  dire('');
  try {
    const { url } = await fonction('jetons-achat', { ligue_id: etat.ligue, paquet_id: p.id });
    if (!/^https:\/\/checkout\.stripe\.com\//.test(url)) throw new Error(tr('Adresse de paiement inattendue.'));
    location.assign(url);
  } catch (e) {
    dire(e.message, true);
    bouton.disabled = false;
    bouton.textContent = tr('Acheter');
    etat.occupe = false;
  }
}

// Au retour de Stripe : le webhook peut avoir quelques secondes de retard.
async function attendreCredit(avant) {
  dire(tr('Paiement reçu. Les jetons arrivent…'));
  for (let i = 0; i < 10; i++) {
    await new Promise((r) => setTimeout(r, 2000));
    await charger();
    if (etat.j.total > avant) { dire(tr('Merci ! Les jetons sont dans la banque de la ligue.')); return; }
  }
  dire(tr('Paiement reçu. Les jetons paraîtront dans quelques minutes.'));
}

// --- Démarrage -----------------------------------------------------------------
sessionPerdue = () => deconnecter(tr('Session expirée.'));

document.addEventListener('DOMContentLoaded', async () => {
  const p = new URLSearchParams(location.search);
  const ligueVoulue = etat.voulue = p.get('ligue'), achat = p.get('achat');
  // ?onglet=transactions : un lien de l'Assistant-Coach ouvre cet onglet.
  if (['achat', 'transactions', 'transfert'].includes(p.get('onglet'))) etat.onglet = p.get('onglet');
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
        if (recent) dire(tr('Merci ! Les jetons sont dans la banque de la ligue.'));
        else attendreCredit(etat.j.total);
      } else if (achat === 'annule') {
        dire(tr('Achat annulé. Rien n’a été facturé.'));
      }
      return;
    }
  } catch (e) {
    $('erreur-connexion').textContent = e.message;
  }
  $('connexion').hidden = false;
});
