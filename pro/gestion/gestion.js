// EspaceLigue Pro · Gestion — la page de l'organisation (ville, école, aréna).
// Ses lecteurs EspacePlayer et l'affichage de chacun ; le contenu des
// affichages, l'apparence et les urgences sont dans contenu.js.
//
// Rien ne passe par une fonction : les tables du schéma `pro` se lisent et
// s'écrivent directement, et la base décide (RLS de pro.sql) :
// - tout membre voit les lecteurs et les affichages de son organisation ;
// - l'administrateur et le gestionnaire changent le nom et l'affichage d'un
//   lecteur, rien d'autre (le statut reste à l'équipe EspaceLigue) ;
// - ils ajoutent et retirent les affichages de l'organisation (un lecteur
//   dont l'affichage est retiré passe en attente : on delete set null) ;
// - un affichage d'une autre organisation est refusé par la clé étrangère.
// En français, le vouvoiement (marché institutionnel).
'use strict';

const PRO = { 'Accept-Profile': 'pro', 'Content-Profile': 'pro' };
const lirePro = (table, requete) => rest('GET', table + '?' + new URLSearchParams(requete), undefined, PRO);
const majPro = (table, filtre, corps) => rest('PATCH', table + '?' + new URLSearchParams(filtre), corps,
  Object.assign({ Prefer: 'return=minimal' }, PRO));

const ROLES = { admin: 'Administrateur', gestionnaire: 'Gestionnaire', prepose: 'Préposé' };
const EN_LIGNE_MS = 3 * 60 * 1000;
const etat = { membres: [], organisations: [], organisation: null, onglet: 'horaire' };
const ONGLETS = { horaire: 'Horaire', contenu: 'Contenu', apparence: 'Apparence', urgence: 'Urgence', lecteurs: 'Lecteurs' };

function dire(texte, erreur) {
  const m = $('message');
  m.textContent = texte;
  m.className = 'message' + (erreur ? ' erreur' : '');
  m.hidden = !texte;
}

function quand(iso) {
  return new Date(iso).toLocaleString('fr-CA', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}

const roleIci = () => (etat.membres.find((m) => m.organisation_id === etat.organisation) || {}).role;
const peutModifier = () => ['admin', 'gestionnaire'].includes(roleIci());

// --- Connexion ---------------------------------------------------------------
async function connecter(ev) {
  ev.preventDefault();
  const bouton = ev.submitter;
  bouton.disabled = true;
  $('erreur-connexion').textContent = '';
  try {
    poserJetons(await auth('token?grant_type=password', { email: $('courriel').value.trim(), password: $('mdp').value }));
    $('mdp').value = '';
    await ouvrir();
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

// Session ouverte : les organisations dont le compte est membre.
async function ouvrir() {
  const u = session.utilisateur;
  [etat.membres, etat.organisations] = await Promise.all([
    lirePro('membres', { select: 'organisation_id,role', user_id: 'eq.' + u.id }),
    lirePro('organisations', { select: 'id,nom', order: 'nom' }),
  ]);
  etat.organisations = etat.organisations.filter((o) => etat.membres.some((m) => m.organisation_id === o.id));
  $('connexion').hidden = true;
  $('app').hidden = false;
  $('qui').replaceChildren(el('span', { classe: 'courriel' }, u.email || ''));

  if (!etat.organisations.length) {
    $('choix-organisation').hidden = true;
    $('contenu').replaceChildren(el('section', { classe: 'fiche' },
      el('h2', null, 'Aucune organisation'),
      el('p', { classe: 'doux' }, 'Ce compte n’est membre d’aucune organisation EspaceLigue Pro. '
        + 'Communiquez avec EspaceLigue pour y être ajouté.')));
    return;
  }
  let garde = null;
  try { garde = localStorage.getItem('espaceligue-pro-organisation'); } catch (e) { /* bloqué */ }
  etat.organisation = etat.organisations.some((o) => o.id === garde) ? garde : etat.organisations[0].id;
  $('organisation').replaceChildren(...etat.organisations.map((o) =>
    el('option', { value: o.id, selected: o.id === etat.organisation }, o.nom)));
  $('choix-organisation').hidden = etat.organisations.length < 2;
  await afficher();
}

// --- Lecteurs ----------------------------------------------------------------
async function afficher() {
  dire('');
  $('onglets').replaceChildren(...Object.entries(ONGLETS).map(([k, v]) => el('button', {
    classe: k === etat.onglet ? 'actif' : null, onclick: () => { etat.onglet = k; afficher(); } }, v)));
  try {
    const vue = { horaire: vueHoraire, lecteurs: vueLecteurs, contenu: vueContenu, apparence: vueApparence, urgence: vueUrgence }[etat.onglet];
    $('contenu').replaceChildren(await vue());
  } catch (e) {
    dire(e.message, true);
  }
}

async function vueLecteurs() {
  const org = etat.organisation;
  const [lecteurs, affichages, etablissements, plateaux] = await Promise.all([
    lirePro('lecteurs', { select: 'id,serie,nom,statut,affichage_id,dernier_contact',
                          organisation_id: 'eq.' + org, order: 'nom.nullslast,serie' }),
    lirePro('affichages', { select: 'id,nom,jeton,etablissement_id', organisation_id: 'eq.' + org, order: 'nom' }),
    lirePro('etablissements', { select: 'id,nom', organisation_id: 'eq.' + org, order: 'nom' }),
    lirePro('plateaux', { select: 'id,nom,etablissement_id', organisation_id: 'eq.' + org, order: 'nom' }),
  ]);
  const nomEtab = (id) => (etablissements.find((e) => e.id === id) || {}).nom || '';
  const libelle = (a) => nomEtab(a.etablissement_id) + ' · ' + a.nom;
  const modifiable = peutModifier();

  const cartes = lecteurs.map((l) => {
    const enLigne = l.dernier_contact && Date.now() - new Date(l.dernier_contact) < EN_LIGNE_MS;
    const pastille = l.statut === 'revoque' ? el('span', { classe: 'pastille rouge-fond' }, 'Désactivé')
      : !l.affichage_id ? el('span', { classe: 'pastille ambre-fond' }, 'Aucun affichage')
      : el('span', { classe: 'pastille vert-fond' }, 'Actif');
    const choix = el('select', { disabled: !modifiable || l.statut === 'revoque' },
      el('option', { value: '' }, '— aucun (écran en attente) —'),
      affichages.map((a) => el('option', { value: a.id, selected: a.id === l.affichage_id }, libelle(a))));
    const nom = el('input', { value: l.nom || '', placeholder: 'ex. Hall d’entrée', disabled: !modifiable });
    return el('form', { classe: 'carte-formulaire lecteur', onsubmit: async (ev) => {
        ev.preventDefault();
        try {
          await majPro('lecteurs', { id: 'eq.' + l.id }, { nom: nom.value.trim() || null, affichage_id: choix.value || null });
          await afficher();
          dire('Enregistré. L’écran change dans la minute qui suit.');
        } catch (e) { dire(e.message, true); }
      } },
      el('div', { classe: 'tete-lecteur' },
        el('div', null, el('strong', null, l.nom || 'Lecteur sans nom'), ' ', pastille,
          el('div', { classe: 'doux' }, 'Numéro de série ', el('code', null, l.serie))),
        el('div', { classe: 'doux droite' }, enLigne ? el('span', { classe: 'vert' }, '● En ligne')
          : ['Hors ligne', el('br'), l.dernier_contact ? 'vu le ' + quand(l.dernier_contact) : 'jamais branché'])),
      l.statut === 'revoque'
        ? el('p', { classe: 'doux' }, 'Ce lecteur a été désactivé par EspaceLigue. Communiquez avec nous pour le réactiver.')
        : el('div', { classe: 'champs' }, el('label', null, 'Nom', nom), el('label', null, 'Affichage', choix)),
      modifiable && l.statut !== 'revoque' ? el('div', { classe: 'actions' }, el('button', { type: 'submit' }, 'Enregistrer')) : null);
  });

  return el('section', { classe: 'vue-lecteurs' },
    el('div', { classe: 'entete-vue' }, el('h2', null, 'Lecteurs d’affichage'),
      el('span', { classe: 'doux' }, ROLES[roleIci()] || '')),
    el('p', { classe: 'doux' }, 'Choisissez ce que montre chaque écran. Le changement paraît en moins d’une minute, '
      + 'sans toucher au lecteur.' + (modifiable ? '' : ' Seuls l’administrateur et les gestionnaires peuvent le changer.')),
    lecteurs.length ? cartes
      : el('div', { classe: 'fiche' }, el('h3', null, 'Aucun lecteur'),
          el('p', { classe: 'doux' }, 'Vos lecteurs EspacePlayer apparaîtront ici dès qu’EspaceLigue les aura associés '
            + 'à votre organisation.')),
    el('div', { classe: 'fiche' }, el('h3', null, 'Vos affichages'),
      affichages.length
        ? el('div', { classe: 'affichages' }, affichages.map((a) => el('div', { classe: 'rangee-affichage' },
            el('a', { classe: 'ligne', href: '../affichage/#' + a.jeton, target: '_blank', rel: 'noopener' },
              el('span', null, libelle(a)), el('span', null, 'Ouvrir ↗')),
            modifiable ? el('button', { type: 'button', classe: 'discret', onclick: () => retirerAffichage(a, lecteurs) }, 'Retirer') : null)))
        : el('p', { classe: 'doux' }, 'Aucun affichage pour l’instant.'),
      modifiable && etablissements.length ? formulaireAffichage(etablissements, plateaux) : null,
      el('p', { classe: 'doux' }, 'Chaque adresse fonctionne aussi sur n’importe quel écran avec un navigateur. '
        + 'Gardez-la pour vous : elle suffit à voir l’affichage.')));
}

async function retirerAffichage(a, lecteurs) {
  const n = lecteurs.filter((l) => l.affichage_id === a.id).length;
  if (!confirm('Retirer l’affichage « ' + a.nom + ' » ? Son contenu (panneaux, mise en page) sera perdu.'
    + (n ? '\n' + n + (n > 1 ? ' lecteurs le montrent : ils passeront' : ' lecteur le montre : il passera') + ' en attente.' : ''))) return;
  try {
    await retraitPro('affichages', { id: 'eq.' + a.id });
    await afficher();
    dire('Affichage retiré.');
  } catch (e) { dire(e.message, true); }
}

// Un affichage montre un plateau (près de la glace) ou tout l'établissement (hall).
function formulaireAffichage(etablissements, plateaux) {
  const nom = el('input', { required: true, maxlength: 80, placeholder: 'ex. Glace 2, Hall d’entrée' });
  const etab = el('select', null, etablissements.map((e) => el('option', { value: e.id }, e.nom)));
  const plateau = el('select');
  const langue = el('select', null, el('option', { value: 'fr' }, 'Français'), el('option', { value: 'en' }, 'Anglais'));
  const remplir = () => plateau.replaceChildren(
    el('option', { value: '' }, 'Hall d’entrée : l’horaire de tous les plateaux'),
    plateaux.filter((p) => p.etablissement_id === etab.value)
      .map((p) => el('option', { value: p.id }, 'Près de « ' + p.nom + ' » : ce plateau seulement')));
  etab.addEventListener('change', remplir);
  remplir();
  return el('form', { classe: 'carte-formulaire', onsubmit: async (ev) => {
      ev.preventDefault();
      try {
        await ajoutPro('affichages', { organisation_id: etat.organisation, etablissement_id: etab.value,
                                       plateau_id: plateau.value || null, nom: nom.value.trim(), langue: langue.value });
        await afficher();
        dire('Affichage ajouté. Choisissez-le pour un lecteur, puis réglez son contenu dans l’onglet Contenu.');
      } catch (e) { dire(e.message, true); }
    } },
    el('h3', null, 'Ajouter un affichage'),
    el('p', { classe: 'doux' }, 'Un écran au hall montre l’horaire de tous les plateaux de l’établissement. '
      + 'Un écran près d’un plateau (une glace, un gymnase) montre ce qui s’y passe et ce qui suit.'),
    el('div', { classe: 'champs' }, el('label', null, 'Nom', nom),
      etablissements.length > 1 ? el('label', null, 'Établissement', etab) : null,
      el('label', null, 'Emplacement de l’écran', plateau), el('label', null, 'Langue', langue)),
    el('div', { classe: 'actions' }, el('button', { type: 'submit' }, 'Ajouter')));
}

sessionPerdue = () => deconnecter('Session expirée.');

document.addEventListener('DOMContentLoaded', async () => {
  $('formulaire-connexion').addEventListener('submit', connecter);
  $('apple').addEventListener('click', () => continuerAvecApple().catch((e) => {
    $('erreur-connexion').textContent = e.message;
  }));
  $('deconnexion').addEventListener('click', () => deconnecter(''));
  $('organisation').addEventListener('change', (e) => {
    etat.organisation = e.target.value;
    try { localStorage.setItem('espaceligue-pro-organisation', etat.organisation); } catch (x) { /* bloqué */ }
    afficher();
  });
  // Les lecteurs disent seuls s'ils sont en ligne : on relit chaque minute.
  // (onglet Lecteurs seulement : ailleurs, on effacerait une édition en cours).
  setInterval(() => {
    if (!$('app').hidden && etat.onglet === 'lecteurs' && !document.querySelector('#contenu :focus')) afficher();
  }, 60000);
  try {
    if (await retourApple() || await reprendreSession()) { await ouvrir(); return; }
  } catch (e) {
    $('erreur-connexion').textContent = e.message;
  }
  $('connexion').hidden = false;
});
