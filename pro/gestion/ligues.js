// EspaceLigue Pro · Gestion — les ligues EspaceLigue qui jouent chez
// l'organisation, et le vestiaire de leurs équipes (docs/horaire.md d'espaceligue-pro).
// Chargé après gestion.js, contenu.js et horaire.js.
//
// La ligue choisit l'établissement dans EspaceLigue (pro.demander_etablissement) ;
// la demande arrive ici. L'aréna l'accepte en donnant la glace par défaut et
// la durée d'un match (pro.decider_ligue), ou la refuse. Un match précis se
// déplace sur une autre glace depuis l'onglet Horaire (pro.placer_match).
// Chaque équipe reçoit un vestiaire pour sa saison (pro.assigner_vestiaire),
// montré à l'écran à côté de son nom.
'use strict';

const ouverts = new Set();
function repli(cle, sommaire, contenu, classe) {
  const d = el('details', { classe, open: ouverts.has(cle) }, sommaire, ...contenu);
  d.addEventListener('toggle', () => { d.open ? ouverts.add(cle) : ouverts.delete(cle); });
  return d;
}

const STATUTS_LIGUE = { demandee: 'À approuver', acceptee: 'Acceptée', refusee: 'Refusée' };

// Le nombre de demandes en attente, pour l'onglet.
async function liguesEnAttente() {
  if (!peutModifier()) return 0;
  try {
    const l = await rest('POST', 'rpc/ligues_a_approuver', { p_organisation: etat.organisation }, PRO);
    return l.filter((x) => x.statut === 'demandee').length;
  } catch (e) { return 0; }
}

async function vueLigues() {
  const org = etat.organisation;
  const modifiable = peutModifier();
  const [ligues, plateaux, vestiaires, equipes, etablissements] = await Promise.all([
    modifiable ? rest('POST', 'rpc/ligues_a_approuver', { p_organisation: org }, PRO) : [],
    lirePro('plateaux', { select: 'id,nom,etablissement_id', organisation_id: 'eq.' + org, actif: 'is.true', order: 'nom' }),
    lirePro('vestiaires', { select: 'id,nom,etablissement_id', organisation_id: 'eq.' + org, order: 'nom' }),
    rest('POST', 'rpc/equipes_ligues', { p_organisation: org }, PRO),
    lirePro('etablissements', { select: 'id,nom', organisation_id: 'eq.' + org, order: 'nom' }),
  ]);
  const plusieurs = etablissements.length > 1;

  const matchs = Object.fromEntries(await Promise.all(ligues.filter((l) => l.statut === 'acceptee').map(async (l) =>
    [l.lieu_id, await rest('POST', 'rpc/matchs_ligue', { p_organisation: org, p_lieu: l.lieu_id }, PRO)])));

  const carteLigue = (l) => {
    const glaces = plateaux.filter((p) => p.etablissement_id === l.etablissement_id);
    const glace = el('select', { required: true },
      glaces.length > 1 && !l.plateau_id ? el('option', { value: '' }, '— choisir —') : null,
      glaces.map((p) => el('option', { value: p.id, selected: p.id === l.plateau_id }, p.nom)));
    const duree = el('input', { type: 'number', min: 15, max: 360, step: 5, valeur: l.duree_minutes || 90 });
    const decider = async (accepter) => {
      if (accepter && !glace.value) { dire('Choisissez la glace.', true); return; }
      if (!accepter && !confirm('Refuser « ' + l.ligue + ' » ? Ses matchs ne paraîtront plus sur vos affichages.')) return;
      try {
        const n = await rest('POST', 'rpc/decider_ligue', { p_organisation: org, p_lieu: l.lieu_id, p_accepter: accepter,
          p_plateau: accepter ? glace.value : null, p_duree: Number(duree.value) || 90 }, PRO);
        await afficher();
        dire(accepter ? `Ligue acceptée : ${n} match${n > 1 ? 's' : ''} à l’horaire. Les prochains suivront d’eux-mêmes.`
          : 'Ligue refusée.');
      } catch (e) { dire(e.message, true); }
    };
    const pastille = el('span', { classe: 'pastille ' + { demandee: 'ambre-fond', acceptee: 'vert-fond', refusee: 'rouge-fond' }[l.statut] },
      STATUTS_LIGUE[l.statut]);
    const entete = el('div', null, el('strong', null, l.ligue), ' ', pastille,
      el('div', { classe: 'doux' }, [`Saison ${l.saison}`, `lieu « ${l.lieu} »`, plusieurs ? l.etablissement : null,
        `${l.prochains} match${l.prochains > 1 ? 's' : ''} à venir`].filter(Boolean).join(' · ')));
    const reglages = [
      glaces.length ? el('div', { classe: 'champs' },
        el('label', null, glaces.length > 1 ? 'Glace par défaut' : 'Glace', glace),
        el('label', null, 'Durée d’un match (min)', duree))
        : el('p', { classe: 'doux' }, 'Cet établissement n’a aucun plateau : EspaceLigue doit d’abord en créer.'),
      el('div', { classe: 'actions' },
        glaces.length ? el('button', { type: 'button', onclick: () => decider(true) },
          l.statut === 'acceptee' ? 'Enregistrer' : 'Accepter') : null,
        l.statut !== 'refusee' ? el('button', { type: 'button', classe: 'discret', onclick: () => decider(false) }, 'Refuser') : null)];
    // Une ligue à approuver reste ouverte ; les autres se replient, chaque
    // section aussi, et gardent leur état quand la page se redessine.
    if (l.statut === 'demandee') return el('div', { classe: 'carte-formulaire' }, entete, ...reglages);
    const nMatchs = (matchs[l.lieu_id] || []).length;
    const eqs = equipes.filter((q) => q.ligue === l.ligue && q.saison === l.saison && q.etablissement_id === l.etablissement_id);
    const sousTitres = [
      ['reglages', 'Glace et durée', reglages],
      l.statut === 'acceptee' ? ['matchs', `Matchs à venir (${nMatchs})`,
        [tableMatchs(matchs[l.lieu_id] || [], plateaux.filter((p) => p.etablissement_id === l.etablissement_id), modifiable)]] : null,
      l.statut === 'acceptee' ? ['vestiaires', `Vestiaires des équipes (${eqs.length})`, [tableVestiaires(eqs, vestiaires, modifiable)]] : null,
    ].filter(Boolean).map(([k, titre, contenu]) => repli(l.lieu_id + ':' + k, el('summary', null, titre), contenu, 'sous-repli'));
    return repli(l.lieu_id, el('summary', null, entete), sousTitres, 'carte-formulaire carte-ligue');
  };

  const enAttente = ligues.filter((l) => l.statut === 'demandee');
  const autres = ligues.filter((l) => l.statut !== 'demandee');

  return el('section', { classe: 'vue-ligues' },
    el('div', { classe: 'entete-vue' }, el('h2', null, 'Ligues EspaceLigue')),
    el('p', { classe: 'doux' }, 'Une ligue qui joue chez vous choisit votre établissement dans EspaceLigue. Acceptez-la '
      + 'et choisissez sa glace : ses matchs s’ajoutent à l’horaire avec le pointage en direct. Un match précis peut '
      + 'ensuite changer de glace dans l’onglet Horaire.'),
    ...(modifiable ? [
      el('h3', null, 'À approuver'),
      ...(enAttente.length ? enAttente.map(carteLigue) : [el('p', { classe: 'doux' }, 'Aucune demande en attente.')]),
      ...(autres.length ? [el('h3', null, 'Déjà traitées'), ...autres.map(carteLigue)] : []),
    ] : [el('p', { classe: 'doux' }, 'Seuls l’administrateur et les gestionnaires approuvent les ligues.')]));
}

// --- Matchs -----------------------------------------------------------------------
// L'aréna corrige l'heure ou la glace d'un match : le vrai match change dans
// EspaceLigue et les gérants de la ligue reçoivent un avis (pro.deplacer_match).
const pourChamp = (iso) => { const d = new Date(iso); d.setMinutes(d.getMinutes() - d.getTimezoneOffset()); return d.toISOString().slice(0, 16); };

function tableMatchs(matchs, glaces, modifiable) {
  if (!matchs.length) return el('p', { classe: 'doux' }, 'Aucun match à venir.');
  const lignes = matchs.map((m) => {
    const debut = el('input', { type: 'datetime-local', valeur: pourChamp(m.debut), disabled: !modifiable });
    const glace = el('select', { disabled: !modifiable || glaces.length < 2 },
      glaces.map((p) => el('option', { value: p.id, selected: p.id === m.plateau_id }, p.nom)));
    const bouton = el('button', { type: 'button', hidden: true, onclick: async () => {
        const quand = new Date(debut.value);
        if (isNaN(quand)) { dire('Heure invalide.', true); return; }
        const change = quand.getTime() !== new Date(m.debut).getTime();
        if (change && !confirm('Déplacer « ' + m.domicile + ' – ' + m.visiteur + ' » ? L’heure change aussi dans '
          + 'EspaceLigue pour les joueurs, et les gérants de la ligue sont avisés.')) return;
        try {
          const etatRes = await rest('POST', 'rpc/deplacer_match', { p_organisation: etat.organisation, p_match: m.match_id,
            p_debut: change ? quand.toISOString() : null, p_plateau: glace.value || null }, PRO);
          await afficher();
          dire(etatRes === 'demandee' ? 'Match enregistré, mais la glace est déjà prise à cette heure : voyez l’Horaire.'
            : 'Match enregistré.' + (change ? ' Les gérants de la ligue sont avisés.' : ''), etatRes === 'demandee');
        } catch (e) { dire(e.message, true); }
      } }, 'Enregistrer');
    const montrer = () => { bouton.hidden = false; };
    debut.addEventListener('input', montrer);
    glace.addEventListener('change', montrer);
    return el('tr', null,
      el('td', null, debut),
      el('td', null, el('strong', null, m.domicile + ' – ' + m.visiteur),
        m.statut === 'demandee' ? el('span', { classe: 'pastille rouge-fond', title: 'La glace était déjà prise' }, 'Conflit') : null),
      el('td', null, glace), el('td', null, bouton));
  });
  return el('div', { classe: 'table' }, el('table', null, el('thead', null, el('tr', null,
    el('th', null, 'Heure'), el('th', null, 'Match'), el('th', null, 'Glace'), el('th', null, ''))), el('tbody', null, lignes)));
}

// --- Vestiaires ----------------------------------------------------------------------
// Dans la carte d'une ligue acceptée : le vestiaire de chacune de ses équipes.
function tableVestiaires(equipes, vestiaires, modifiable) {
  if (!equipes.length) return el('p', { classe: 'doux' }, 'Aucune équipe dans cette saison pour l’instant.');
  if (!vestiaires.length) return el('p', { classe: 'doux' }, 'Aucun vestiaire : ajoutez-les dans l’onglet Établissement.');
  const lignes = equipes.map((q) => {
    const choix = el('select', { disabled: !modifiable, onchange: async () => {
        try {
          await rest('POST', 'rpc/assigner_vestiaire', { p_organisation: etat.organisation, p_equipe: q.equipe_id,
            p_vestiaire: choix.value || null }, PRO);
          dire('Vestiaire de « ' + q.equipe + ' » enregistré. Il paraît à l’écran dans la minute.');
        } catch (e) { dire(e.message, true); }
      } },
      el('option', { value: '' }, '— aucun —'),
      vestiaires.filter((v) => v.etablissement_id === q.etablissement_id)
        .map((v) => el('option', { value: v.id, selected: v.id === q.vestiaire_id }, v.nom)));
    return el('tr', null, el('td', null, el('strong', null, q.equipe)), el('td', null, choix));
  });
  return el('div', { classe: 'table' }, el('table', null, el('thead', null, el('tr', null,
    el('th', null, 'Équipe'), el('th', null, 'Vestiaire'))), el('tbody', null, lignes)));
}

// Dans l'onglet Horaire : la glace d'un match EspaceLigue précis.
function choixGlaceMatch(r, plateaux) {
  const pl = plateaux.find((p) => p.id === r.plateau_id);
  const glaces = plateaux.filter((p) => pl && p.etablissement_id === pl.etablissement_id);
  if (glaces.length < 2 || !r.match_id) return null;
  const s = el('select', { title: 'Glace de ce match', onchange: async () => {
      try {
        await rest('POST', 'rpc/placer_match', { p_organisation: etat.organisation, p_match: r.match_id, p_plateau: s.value }, PRO);
        await afficher();
        dire('Match déplacé sur ' + glaces.find((p) => p.id === s.value).nom + '.');
      } catch (e) { dire(e.message, true); }
    } },
    glaces.map((p) => el('option', { value: p.id, selected: p.id === r.plateau_id }, p.nom)));
  return s;
}
