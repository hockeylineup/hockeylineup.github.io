// EspaceLigue Pro · Gestion — l'onglet Établissement : la fiche de chaque
// établissement de l'organisation (nom, adresse, heures d'ouverture), ses
// plateaux (type, resurfaçage, sections d'un gymnase), ses vestiaires, ses
// jours de fermeture ; et les permissions des employés (administrateur).
// Chargé après gestion.js.
//
// Écrit directement dans pro.etablissements, pro.plateaux et pro.vestiaires
// (RLS : administrateur et gestionnaire). Un plateau retiré passe inactif
// (ses réservations restent) ; un vestiaire retiré l'est pour de bon, et les
// équipes qui l'avaient n'en ont plus.
'use strict';

const JOURS_OUVERTURE = { lun: 'Lundi', mar: 'Mardi', mer: 'Mercredi', jeu: 'Jeudi', ven: 'Vendredi', sam: 'Samedi', dim: 'Dimanche' };

async function vueEtablissement() {
  const org = etat.organisation;
  const modifiable = peutModifier();
  const [etablissements, plateaux, vestiaires, fermetures, employes] = await Promise.all([
    lirePro('etablissements', { select: 'id,nom,adresse,heures', organisation_id: 'eq.' + org, order: 'nom' }),
    lirePro('plateaux', { select: 'id,nom,etablissement_id,type,surfacage,parent_id,couleur', organisation_id: 'eq.' + org,
      actif: 'is.true', order: 'nom' }),
    lirePro('vestiaires', { select: 'id,nom,etablissement_id', organisation_id: 'eq.' + org, order: 'nom' }),
    lirePro('fermetures', { select: 'id,etablissement_id,jour,motif', organisation_id: 'eq.' + org,
      jour: 'gte.' + aaaammjj(new Date()), order: 'jour' }),
    roleIci() === 'admin' ? rest('POST', 'rpc/employes', { p_organisation: org }, PRO) : [],
  ]);
  return el('section', { classe: 'vue-etablissement' },
    el('div', { classe: 'entete-vue' }, el('h2', null, etablissements.length > 1 ? 'Établissements' : 'Établissement')),
    etablissements.length ? null : el('p', { classe: 'doux' }, 'Aucun établissement : l’équipe EspaceLigue doit d’abord en créer.'),
    ...etablissements.map((e) => ficheEtablissement(e,
      plateaux.filter((p) => p.etablissement_id === e.id),
      vestiaires.filter((v) => v.etablissement_id === e.id).sort((a, b) => a.nom.localeCompare(b.nom, 'fr', { numeric: true })),
      modifiable, fermetures.filter((f) => f.etablissement_id === e.id))),
    roleIci() === 'admin' ? blocEmployes(employes) : null);
}

// --- Employés : ce qu'un préposé peut faire dans la Planification ---------------------
const ROLES_EMPLOYE = { admin: 'Administrateur', gestionnaire: 'Gestionnaire', prepose: 'Préposé' };
function blocEmployes(employes) {
  const lignes = employes.map((m) => {
    const cases = ['reserver', 'modifier'].map((p) => {
      const c = el('input', { type: 'checkbox', checked: m.role !== 'prepose' || m.permissions.includes(p), disabled: m.role !== 'prepose' });
      c.permission = p;
      return c;
    });
    const changer = async () => {
      try {
        await rest('POST', 'rpc/regler_permissions', { p_membre: m.id,
          p_permissions: cases.filter((c) => c.checked).map((c) => c.permission) }, PRO);
        dire('Permissions de ' + m.courriel + ' enregistrées.');
      } catch (e) { dire(e.message, true); }
    };
    cases.forEach((c) => c.addEventListener('change', changer));
    return el('tr', null, el('td', null, el('strong', null, m.courriel)), el('td', { classe: 'doux' }, ROLES_EMPLOYE[m.role]),
      el('td', null, el('label', { classe: 'case' }, cases[0], 'Réserver')),
      el('td', null, el('label', { classe: 'case' }, cases[1], 'Modifier')));
  });
  return el('div', { classe: 'fiche' }, el('h3', null, 'Employés'),
    el('p', { classe: 'doux' }, 'Ce qu’un préposé peut faire dans la Planification. Les ajouts d’employés passent par EspaceLigue.'),
    el('div', { classe: 'table' }, el('table', null, el('tbody', null, lignes))));
}

// --- Plateaux : nom, type, resurfaçage, sections d'un gymnase ---------------------------
const TYPES_PLATEAU = { glace: 'Glace', gymnase: 'Gymnase', terrain: 'Terrain', piscine: 'Piscine', salle: 'Salle', autre: 'Autre' };
function listePlateaux(plateaux, modifiable) {
  const boite = el('div', { classe: 'liste-plateaux' });
  const lignes = [];
  const ajouter = (item, sections) => {
    const nom = el('input', { required: true, maxlength: 80, valeur: item ? item.nom : 'Glace ' + (lignes.filter((l) => !l.retire).length + 1),
      disabled: !modifiable, 'aria-label': 'Nom du plateau' });
    const type = el('select', { disabled: !modifiable }, Object.entries(TYPES_PLATEAU).map(([k, v]) =>
      el('option', { value: k, selected: k === (item ? item.type : 'glace') }, v)));
    const couleur = el('input', { type: 'color', disabled: !modifiable, title: 'Couleur dans la Planification',
      valeur: item ? couleurPlateau(item, plateaux) : PALETTE_PLATEAUX[lignes.length % PALETTE_PLATEAUX.length] });
    const surf = el('input', { type: 'number', min: 0, max: 60, step: 1, valeur: item ? item.surfacage : 10, disabled: !modifiable,
      title: 'Minutes de resurfaçage comprises à la fin de chaque réservation' });
    const nbSections = el('select', { disabled: !modifiable, title: 'Diviser le gymnase' },
      [0, 2, 3, 4].map((n) => el('option', { value: n, selected: n === sections.length }, n ? n + ' sections' : 'Entier seulement')));
    const sousBoite = el('div', { classe: 'sections' });
    const ligne = { item, nom, type, surf, couleur, nbSections, sections: [], retire: false };
    const ajouterSection = (s) => {
      const n = ligne.sections.filter((x) => !x.retire).length;
      const champ = el('input', { required: true, maxlength: 80, disabled: !modifiable, 'aria-label': 'Nom de la section',
        valeur: s ? s.nom : (nom.value.trim() || 'Gymnase') + ' ' + 'ABCD'[n] });
      const r = el('div', { classe: 'rangee-nom section' }, el('span', { classe: 'doux' }, '↳'), champ);
      ligne.sections.push({ item: s, champ, r, retire: false });
      sousBoite.append(r);
    };
    sections.forEach(ajouterSection);
    nbSections.addEventListener('change', () => {
      const voulu = Number(nbSections.value);
      let vis = ligne.sections.filter((x) => !x.retire);
      while (vis.length < voulu) { ajouterSection(null); vis = ligne.sections.filter((x) => !x.retire); }
      vis.slice(voulu).forEach((x) => { x.retire = true; x.r.hidden = true; });
    });
    const champSurf = el('label', { classe: 'mini' }, surf, 'min de resurfaçage');
    const majType = () => { champSurf.hidden = type.value !== 'glace'; nbSections.hidden = type.value !== 'gymnase';
      sousBoite.hidden = type.value !== 'gymnase'; };
    type.addEventListener('change', majType);
    majType();
    const rangee = el('div', { classe: 'rangee-plateau' }, el('div', { classe: 'rangee-nom' }, couleur, nom, type,
      modifiable ? el('button', { type: 'button', classe: 'discret', title: 'Retirer',
        onclick: () => { ligne.retire = true; bloc.hidden = true; } }, '×') : null),
      el('div', { classe: 'options-plateau' }, champSurf, nbSections));
    const bloc = el('div', { classe: 'plateau' }, rangee, sousBoite);
    lignes.push(ligne);
    boite.append(bloc);
  };
  plateaux.filter((p) => !p.parent_id).forEach((p) => ajouter(p, plateaux.filter((x) => x.parent_id === p.id)));
  return {
    noeud: el('div', null, boite, modifiable ? el('button', { type: 'button', classe: 'discret', onclick: () => ajouter(null, []) }, '+ Ajouter') : null),
    lignes, plateaux,
  };
}

async function enregistrerPlateaux(liste, etab) {
  const org = etat.organisation;
  for (const l of liste.lignes) {
    const corps = { nom: l.nom.value.trim(), type: l.type.value, couleur: l.couleur.value,
      surfacage: l.type.value === 'glace' ? Math.max(0, Math.min(60, Number(l.surf.value) || 0)) : 0 };
    const gym = l.type.value === 'gymnase';
    if (l.retire) {
      if (l.item) await majPro('plateaux', { id: 'eq.' + l.item.id }, { actif: false });
      for (const s of l.sections) if (s.item) await majPro('plateaux', { id: 'eq.' + s.item.id }, { actif: false });
      continue;
    }
    let id = l.item && l.item.id;
    if (!id) id = (await ajoutPro('plateaux', Object.assign({ organisation_id: org, etablissement_id: etab }, corps)))[0].id;
    else if (corps.nom !== l.item.nom || corps.type !== l.item.type || corps.surfacage !== l.item.surfacage
      || corps.couleur !== couleurPlateau(l.item, liste.plateaux)) {
      await majPro('plateaux', { id: 'eq.' + id }, corps);
    }
    // Les sections : un plateau qui n'est plus un gymnase les perd toutes.
    for (const s of l.sections) {
      const nom = s.champ.value.trim();
      if (s.retire || !gym) { if (s.item) await majPro('plateaux', { id: 'eq.' + s.item.id }, { actif: false }); continue; }
      if (!s.item) await ajoutPro('plateaux', { organisation_id: org, etablissement_id: etab, nom, type: 'gymnase', surfacage: 0, parent_id: id });
      else if (nom !== s.item.nom) await majPro('plateaux', { id: 'eq.' + s.item.id }, { nom });
    }
  }
}

// --- Jours de fermeture (une série n'y crée rien) ---------------------------------------
function blocFermetures(e, fermetures, modifiable) {
  const jour = el('input', { type: 'date', min: aaaammjj(new Date()) });
  const motif = el('input', { maxlength: 80, placeholder: 'ex. Noël' });
  const liste = fermetures.map((f) => el('span', { classe: 'puce' },
    new Date(f.jour + 'T12:00').toLocaleDateString('fr-CA', { weekday: 'short', day: 'numeric', month: 'long', year: 'numeric' })
      + (f.motif ? ' · ' + f.motif : ''),
    modifiable ? el('button', { type: 'button', classe: 'discret', title: 'Retirer', onclick: async () => {
      try { await retraitPro('fermetures', { id: 'eq.' + f.id }); await afficher(); dire('Jour de fermeture retiré.'); }
      catch (err) { dire(err.message, true); }
    } }, '×') : null));
  return el('div', null, el('h3', null, 'Jours de fermeture'),
    fermetures.length ? el('div', { classe: 'puces' }, liste) : el('p', { classe: 'doux' }, 'Aucun à venir.'),
    modifiable ? el('div', { classe: 'outils' }, jour, motif, el('button', { type: 'button', classe: 'discret', onclick: async () => {
      if (!jour.value) { dire('Choisissez une date.', true); return; }
      try {
        await ajoutPro('fermetures', { organisation_id: etat.organisation, etablissement_id: e.id, jour: jour.value, motif: motif.value.trim() || null });
        await afficher();
        dire('Jour de fermeture ajouté.');
      } catch (err) { dire(/duplicate|unique/i.test(err.message) ? 'Ce jour est déjà fermé.' : err.message, true); }
    } }, 'Ajouter')) : null);
}

// Une liste de noms modifiables (plateaux ou vestiaires) : rangées existantes,
// rangées ajoutées, rangées retirées ; le tout s'enregistre avec la fiche.
function listeNoms(existants, etiquette, modifiable, nomNouveau, auChangement) {
  const rangees = el('div', { classe: 'liste-noms' });
  const ajouter = (item) => {
    const champ = el('input', { required: true, maxlength: 40, valeur: item ? item.nom : nomNouveau([...rangees.children].filter((x) => !x.dataset.retire).length + 1),
      disabled: !modifiable, 'aria-label': etiquette });
    const r = el('div', { classe: 'rangee-nom' }, champ, modifiable ? el('button', { type: 'button', classe: 'discret',
      title: 'Retirer', onclick: () => { r.dataset.retire = '1'; r.hidden = true; if (auChangement) auChangement(); } }, '×') : null);
    r.item = item;
    r.champ = champ;
    rangees.append(r);
  };
  existants.forEach(ajouter);
  return {
    noeud: el('div', null, rangees, modifiable ? el('button', { type: 'button', classe: 'discret',
      onclick: () => { ajouter(null); if (auChangement) auChangement(); } }, '+ Ajouter') : null),
    ajouter,
    rangees: () => [...rangees.children],
    visibles: () => [...rangees.children].filter((r) => !r.dataset.retire),
  };
}

function ficheEtablissement(e, plateaux, vestiaires, modifiable, fermetures) {
  const nom = el('input', { required: true, maxlength: 160, valeur: e.nom, disabled: !modifiable });
  const adresse = el('input', { maxlength: 200, valeur: e.adresse || '', disabled: !modifiable });

  const heures = e.heures || {};
  const jours = Object.entries(JOURS_OUVERTURE).map(([k, v]) => {
    const h = heures[k];
    const ouvert = el('input', { type: 'checkbox', checked: !!h, disabled: !modifiable });
    const ouvre = el('input', { type: 'time', valeur: h ? h.ouvre : '06:00', disabled: !modifiable });
    const ferme = el('input', { type: 'time', valeur: h ? h.ferme : '23:00', disabled: !modifiable });
    const maj = () => { ouvre.hidden = ferme.hidden = !ouvert.checked; ferme_txt.hidden = !ouvert.checked; ferme_lbl.hidden = ouvert.checked; };
    const ferme_txt = el('span', { classe: 'doux' }, 'à');
    const ferme_lbl = el('span', { classe: 'doux' }, 'Fermé');
    ouvert.onchange = maj;
    const ligne = el('div', { classe: 'jour-heures' }, el('label', { classe: 'case' }, ouvert, v), ouvre, ferme_txt, ferme, ferme_lbl);
    maj();
    return { k, ligne, lire: () => (ouvert.checked ? { ouvre: ouvre.value, ferme: ferme.value } : null) };
  });

  const glaces = listePlateaux(plateaux, modifiable);
  const vest = listeNoms(vestiaires, 'Nom du vestiaire', modifiable, (n) => 'Vestiaire ' + n,
    () => { nombre.value = vest.visibles().length; });
  const nombre = el('input', { type: 'number', min: 0, max: 60, valeur: vestiaires.length, disabled: !modifiable,
    onchange: () => {
      const voulu = Math.max(0, Math.min(60, Number(nombre.value) || 0));
      let vis = vest.visibles();
      while (vis.length < voulu) { vest.ajouter(null); vis = vest.visibles(); }
      vis.slice(voulu).forEach((r) => { r.dataset.retire = '1'; r.hidden = true; });
    } });

  const enregistrer = async (ev) => {
    ev.preventDefault();
    const org = etat.organisation;
    const retiresV = vest.rangees().filter((r) => r.dataset.retire && r.item);
    const retiresP = glaces.lignes.filter((l) => l.retire && l.item);
    if ((retiresV.length || retiresP.length) && !confirm([
      retiresP.length ? 'Retirer ' + retiresP.map((l) => '« ' + l.item.nom + ' »').join(', ') + ' ? Ses réservations restent, mais il ne paraît plus.' : '',
      retiresV.length ? 'Retirer ' + retiresV.map((r) => '« ' + r.item.nom + ' »').join(', ') + ' ? Les équipes qui l’avaient n’en auront plus.' : '',
    ].filter(Boolean).join('\n'))) return;
    try {
      await majPro('etablissements', { id: 'eq.' + e.id }, { nom: nom.value.trim(), adresse: adresse.value.trim() || null,
        heures: Object.fromEntries(jours.map((j) => [j.k, j.lire()])) });
      await enregistrerPlateaux(glaces, e.id);
      for (const r of vest.rangees()) {
        const n = r.champ.value.trim();
        if (r.dataset.retire) { if (r.item) await retraitPro('vestiaires', { id: 'eq.' + r.item.id }); }
        else if (!r.item) await ajoutPro('vestiaires', { organisation_id: org, etablissement_id: e.id, nom: n });
        else if (n !== r.item.nom) await majPro('vestiaires', { id: 'eq.' + r.item.id }, { nom: n });
      }
      await afficher();
      dire('Établissement enregistré.');
    } catch (err) { dire(err.message, true); }
  };

  return el('form', { classe: 'carte-formulaire fiche-etablissement', onsubmit: enregistrer },
    el('div', { classe: 'champs' }, el('label', null, 'Nom', nom), el('label', null, 'Adresse', adresse)),
    el('h3', null, 'Heures d’ouverture'),
    el('div', { classe: 'heures' }, jours.map((j) => j.ligne)),
    el('div', { classe: 'champs' },
      el('div', null, el('h3', null, 'Plateaux'), glaces.noeud),
      el('div', null, el('h3', null, 'Vestiaires'),
        el('label', { classe: 'nombre-vestiaires' }, 'Nombre', nombre), vest.noeud)),
    blocFermetures(e, fermetures, modifiable),
    modifiable ? el('div', { classe: 'actions' }, el('button', { type: 'submit' }, 'Enregistrer')) : null);
}
