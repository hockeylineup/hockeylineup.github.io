// EspaceLigue Pro · Gestion — l'onglet Établissement : la fiche de chaque
// établissement de l'organisation (nom, adresse, heures d'ouverture), ses
// plateaux et ses vestiaires. Chargé après gestion.js.
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
  const [etablissements, plateaux, vestiaires] = await Promise.all([
    lirePro('etablissements', { select: 'id,nom,adresse,heures', organisation_id: 'eq.' + org, order: 'nom' }),
    lirePro('plateaux', { select: 'id,nom,etablissement_id', organisation_id: 'eq.' + org, actif: 'is.true', order: 'nom' }),
    lirePro('vestiaires', { select: 'id,nom,etablissement_id', organisation_id: 'eq.' + org, order: 'nom' }),
  ]);
  return el('section', { classe: 'vue-etablissement' },
    el('div', { classe: 'entete-vue' }, el('h2', null, etablissements.length > 1 ? 'Établissements' : 'Établissement')),
    etablissements.length ? null : el('p', { classe: 'doux' }, 'Aucun établissement : l’équipe EspaceLigue doit d’abord en créer.'),
    ...etablissements.map((e) => ficheEtablissement(e,
      plateaux.filter((p) => p.etablissement_id === e.id),
      vestiaires.filter((v) => v.etablissement_id === e.id).sort((a, b) => a.nom.localeCompare(b.nom, 'fr', { numeric: true })),
      modifiable)));
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

function ficheEtablissement(e, plateaux, vestiaires, modifiable) {
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

  const glaces = listeNoms(plateaux, 'Nom du plateau', modifiable, (n) => 'Glace ' + n);
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
    const retiresP = glaces.rangees().filter((r) => r.dataset.retire && r.item);
    if ((retiresV.length || retiresP.length) && !confirm([
      retiresP.length ? 'Retirer ' + retiresP.map((r) => '« ' + r.item.nom + ' »').join(', ') + ' ? Ses réservations restent, mais il ne paraît plus.' : '',
      retiresV.length ? 'Retirer ' + retiresV.map((r) => '« ' + r.item.nom + ' »').join(', ') + ' ? Les équipes qui l’avaient n’en auront plus.' : '',
    ].filter(Boolean).join('\n'))) return;
    try {
      await majPro('etablissements', { id: 'eq.' + e.id }, { nom: nom.value.trim(), adresse: adresse.value.trim() || null,
        heures: Object.fromEntries(jours.map((j) => [j.k, j.lire()])) });
      for (const r of glaces.rangees()) {
        const n = r.champ.value.trim();
        if (r.dataset.retire) { if (r.item) await majPro('plateaux', { id: 'eq.' + r.item.id }, { actif: false }); }
        else if (!r.item) await ajoutPro('plateaux', { organisation_id: org, etablissement_id: e.id, nom: n });
        else if (n !== r.item.nom) await majPro('plateaux', { id: 'eq.' + r.item.id }, { nom: n });
      }
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
    modifiable ? el('div', { classe: 'actions' }, el('button', { type: 'submit' }, 'Enregistrer')) : null);
}
