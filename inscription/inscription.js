// EspaceLigue · Inscription — créer un compte, le même que dans l'app.
// Comme l'app (Api.inscription) : prénom et nom partent dans les métadonnées,
// d'où la base tire le profil. Avec la confirmation par courriel, le compte
// attend un code avant d'ouvrir une session.
'use strict';

function montrer(id) {
  for (const x of ['formulaire', 'confirmation', 'pret']) $(x).hidden = x !== id;
}

async function inscrire(ev) {
  ev.preventDefault();
  const bouton = ev.submitter;
  bouton.disabled = true;
  $('erreur').textContent = '';
  const courriel = $('courriel').value.trim();
  try {
    const d = await auth('signup', {
      email: courriel, password: $('mdp').value,
      data: { prenom: $('prenom').value.trim(), nom: $('nom').value.trim() },
    });
    $('mdp').value = '';
    if (d.access_token) { poserJetons(d); montrer('pret'); return; }
    // Courriel déjà pris : GoTrue répond quand même 200, sans identité, pour
    // ne pas révéler les adresses existantes (même test que l'app).
    const u = d.user || d;
    if (Array.isArray(u.identities) && !u.identities.length) {
      throw new Error('Un compte existe déjà avec ce courriel. Connecte-toi plutôt.');
    }
    $('adresse').textContent = courriel;
    montrer('confirmation');
    $('code').focus();
  } catch (e) {
    $('erreur').textContent = e.message;
  } finally {
    bouton.disabled = false;
  }
}

// Deux types essayés, comme l'app : `signup` d'abord, puis `email`.
async function confirmer(ev) {
  ev.preventDefault();
  const bouton = ev.submitter;
  bouton.disabled = true;
  $('erreur-code').textContent = '';
  const email = $('adresse').textContent;
  const token = $('code').value.trim();
  try {
    let d = null, derniere = null;
    for (const type of ['signup', 'email']) {
      try { d = await auth('verify', { type, email, token }); break; } catch (e) { derniere = e; }
    }
    if (!d) throw derniere;
    if (d.access_token) poserJetons(d);
    montrer('pret');
  } catch (e) {
    $('erreur-code').textContent = e.message;
  } finally {
    bouton.disabled = false;
  }
}

async function renvoyer() {
  $('erreur-code').textContent = '';
  try {
    await auth('resend', { type: 'signup', email: $('adresse').textContent });
    $('erreur-code').textContent = 'Code renvoyé.';
  } catch (e) {
    $('erreur-code').textContent = e.message;
  }
}

document.addEventListener('DOMContentLoaded', async () => {
  $('formulaire').addEventListener('submit', inscrire);
  $('confirmation').addEventListener('submit', confirmer);
  $('renvoyer').addEventListener('click', renvoyer);
  $('apple').addEventListener('click', () => continuerAvecApple().catch((e) => { $('erreur').textContent = e.message; }));
  try {
    if (await retourApple()) montrer('pret');
  } catch (e) {
    $('erreur').textContent = e.message;
  }
});
