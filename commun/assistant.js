// EspaceLigue · l'Assistant-Coach du site : une bulle en bas à droite qui
// ouvre une conversation, la même que dans l'app (Edge Function `assistant`).
//
// Les pages du site se rechargent à chaque lien : l'encadré (ouvert ou non) et
// la conversation vivent dans le sessionStorage de l'onglet, et chaque page
// les reprend. Une réponse coupée par un changement de page le dit, avec de
// quoi reposer la question.
//
// L'assistant exige un compte (c'est ce qui borne les questions par jour) :
// sans session dans l'onglet, l'encadré propose de se connecter.
//
// Dépend de commun/langue.js (tr) et commun/session.js (la session).
// Aucune réponse n'est écrite en HTML : le texte passe par des nœuds, et seuls
// les liens vers les pages connues du site deviennent des liens.
'use strict';

(() => {
  const CLE_AC = 'espaceligue-assistant';
  // Invisible : marque une réponse tirée du compte (voir l'Edge Function).
  const OUTIL = '⁣';
  // Les adresses que l'assistant peut proposer en lien (le guide les donne).
  const LIENS_PERMIS = /^\/(gerant|jetons)\/(\?(sujet|onglet)=[a-z]+)?$/;

  let etat = { ouvert: false, messages: [] };
  try { etat = JSON.parse(sessionStorage.getItem(CLE_AC)) || etat; } catch (e) { /* bloqué */ }
  const garder = () => { try { sessionStorage.setItem(CLE_AC, JSON.stringify(etat)); } catch (e) { /* bloqué */ } };
  let occupe = false;

  const connecte = () => !!(session.jeton || relire(CLE_RAFRAICHIR));

  // Où la personne se trouve : l'assistant en tient compte pour le chemin.
  function page() {
    const p = new URLSearchParams(location.search);
    const q = ['sujet', 'onglet'].find((k) => p.has(k));
    return location.pathname + (q ? '?' + q + '=' + p.get(q) : '');
  }

  // --- Dessin ------------------------------------------------------------------
  function svg(d, epais) {
    const ns = 'http://www.w3.org/2000/svg';
    const s = document.createElementNS(ns, 'svg');
    for (const [k, v] of Object.entries({ viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor',
      'stroke-width': epais || 2, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true' })) s.setAttribute(k, v);
    for (const t of [].concat(d)) { const p = document.createElementNS(ns, 'path'); p.setAttribute('d', t); s.append(p); }
    return s;
  }
  const BULLE = ['M4 11a8 8 0 1 1 3.3 6.5L4 19l1.2-3.4A8 8 0 0 1 4 11z', 'M9 10h.01M12 10h.01M15 10h.01'];
  const avatar = () => el('span', { classe: 'ac-avatar' }, svg(BULLE));

  // Le texte d'une réponse : les [liens](/gerant/…) permis deviennent des liens.
  function texte(t) {
    const morceaux = [];
    let i = 0;
    for (const m of t.matchAll(/\[([^\]\n]+)\]\(([^)\s]+)\)/g)) {
      morceaux.push(t.slice(i, m.index));
      morceaux.push(LIENS_PERMIS.test(m[2]) ? el('a', { href: m[2] + (LANGUE === 'en' ? (m[2].includes('?') ? '&' : '?') + 'langue=en' : '') }, m[1]) : m[1]);
      i = m.index + m[0].length;
    }
    morceaux.push(t.slice(i));
    return morceaux;
  }

  function message(m, i) {
    const b = el('div', { classe: 'ac-msg ' + (m.role === 'user' ? 'moi' : m.role === 'erreur' ? 'lui erreur' : 'lui') },
      texte(m.texte.replace(OUTIL, '')));
    if (m.coupee) {
      b.append(el('span', { classe: 'ac-coupee' }, tr('Réponse interrompue'), ' · ',
        el('button', { type: 'button', onclick: () => {
          const q = etat.messages[i - 1];
          etat.messages.splice(i - 1, 2);
          if (q && q.role === 'user') poser(q.texte);
        } }, tr('Reposer la question'))));
    }
    return b;
  }

  function rendre() {
    document.querySelectorAll('.ac-bulle, .ac-encadre').forEach((n) => n.remove());
    if (!etat.ouvert) {
      document.body.append(el('button', { type: 'button', classe: 'ac-bulle', onclick: () => { etat.ouvert = true; garder(); rendre(); } },
        avatar(), el('span', { classe: 'ac-libelle' }, 'Assistant-Coach')));
      return;
    }
    const fil = el('div', { classe: 'ac-fil', 'aria-live': 'polite' },
      el('div', { classe: 'ac-msg lui' },
        tr('Salut, moi c’est l’Assistant-Coach. Je connais ta ligue de A à Z : réglages, remplaçants, jetons, et même ton prochain match. Demande, je te guide.')),
      etat.messages.map(message));
    const champ = el('input', { placeholder: tr('Ta question…'), 'aria-label': tr('Ta question'), maxlength: 500,
                                disabled: !connecte() });
    const encadre = el('section', { classe: 'ac-encadre', 'aria-label': 'Assistant-Coach' },
      el('div', { classe: 'ac-tete' }, avatar(),
        el('div', { classe: 'ac-titre' }, el('b', {}, 'Assistant-Coach'), el('small', {}, tr('Répond sur l’app et le site'))),
        el('button', { type: 'button', title: tr('Nouvelle conversation'), 'aria-label': tr('Nouvelle conversation'),
                       onclick: () => { if (occupe) return; etat.messages = []; garder(); rendre(); } }, svg('M12 5v14M5 12h14')),
        el('button', { type: 'button', title: tr('Réduire'), 'aria-label': tr('Réduire'),
                       onclick: () => { etat.ouvert = false; garder(); rendre(); } }, svg('M6 12h12'))),
      fil,
      connecte()
        ? el('form', { classe: 'ac-saisie', onsubmit: (ev) => {
            ev.preventDefault();
            const q = champ.value.trim();
            if (q && !occupe) poser(q);
          } }, champ, el('button', { type: 'submit', 'aria-label': tr('Envoyer'), disabled: occupe }, svg('M5 12h14M13 6l6 6-6 6', 2.2)))
        : el('p', { classe: 'ac-connexion' }, tr('Connecte-toi pour poser une question.'), ' ',
            el('a', { href: '/gerant/' + (LANGUE === 'en' ? '?langue=en' : '') }, tr('Se connecter'))),
      el('p', { classe: 'ac-pied' }, tr('Aucune donnée personnelle n’est envoyée.')));
    document.body.append(encadre);
    fil.scrollTop = fil.scrollHeight;
    if (connecte() && !occupe && window.matchMedia('(min-width: 561px)').matches) champ.focus();
  }

  // --- Poser une question --------------------------------------------------------
  async function poser(q) {
    occupe = true;
    etat.messages.push({ role: 'user', texte: q });
    // Marquée coupée jusqu'à la fin : une page quittée en cours de route le dira.
    const rep = { role: 'assistant', texte: '', coupee: true };
    etat.messages.push(rep);
    garder();
    rendre();
    const bulle = document.querySelector('.ac-fil .ac-msg:last-child');
    bulle.replaceChildren(el('span', { classe: 'ac-ecrit' }, el('i'), el('i'), el('i')));
    try {
      if (!session.jeton && !(await reprendreSession())) throw new Error(tr('Session expirée.'));
      const r = await fetch(SUPABASE + '/functions/v1/assistant', {
        method: 'POST', credentials: 'omit', cache: 'no-store',
        headers: { apikey: CLE, Authorization: 'Bearer ' + await jetonFrais(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ page: page(), messages: etat.messages.slice(0, -1)
          .filter((m) => m.role === 'user' || (m.role === 'assistant' && m.texte))
          .map((m) => ({ role: m.role, texte: m.texte })) }),
      });
      if (!r.ok || !r.body) {
        const d = await r.json().catch(() => ({}));
        throw new Error(d.erreur ? tr(d.erreur) : tr('L\'Assistant-Coach ne répond pas pour l\'instant.'));
      }
      const lecteur = r.body.pipeThrough(new TextDecoderStream()).getReader();
      for (;;) {
        const { value, done } = await lecteur.read();
        if (done) break;
        rep.texte += value;
        garder();
        bulle.replaceChildren(...texte(rep.texte.replace(OUTIL, '')));
        bulle.parentNode.scrollTop = bulle.parentNode.scrollHeight;
      }
      rep.coupee = false;
    } catch (e) {
      etat.messages.splice(etat.messages.indexOf(rep), 1, { role: 'erreur', texte: e.message });
    }
    occupe = false;
    garder();
    rendre();
  }

  document.addEventListener('DOMContentLoaded', rendre);
})();
