// EspaceLigue · la langue des pages connectées, comme dans l'app : le français
// est la langue de base, la clé d'un texte est le texte français lui-même.
//
// La langue : `?langue=en` (ou `fr`) dans l'adresse, sinon le dernier choix
// gardé dans ce navigateur, sinon celle du navigateur. Les traductions vivent
// dans des fichiers `en.js` qui complètent `EN` (la politique de sécurité des
// pages ne permet pas de lire un .json).
//
// - `tr('Il manque %@ joueurs', n)` : le texte dans la langue choisie ;
// - `data-tr` sur un élément du HTML : ses textes sont traduits au chargement
//   (et `data-tr-attr="placeholder aria-label"` pour des attributs) ;
// - un `button.langue` bascule d'une langue à l'autre.
'use strict';

const EN = {};

const LANGUE = (() => {
  // Les pages de contenu ont une adresse par langue : elles imposent la leur.
  const fixe = document.documentElement.dataset.langue;
  if (fixe === 'en' || fixe === 'fr') return fixe;
  const voulue = new URLSearchParams(location.search).get('langue');
  if (voulue === 'en' || voulue === 'fr') {
    try { localStorage.setItem('langue', voulue); } catch (e) { /* bloqué */ }
    return voulue;
  }
  try { const l = localStorage.getItem('langue'); if (l === 'en' || l === 'fr') return l; } catch (e) { /* bloqué */ }
  return (navigator.language || 'fr').toLowerCase().startsWith('en') ? 'en' : 'fr';
})();
const LOCALE = LANGUE === 'en' ? 'en-CA' : 'fr-CA';

function tr(texte, ...valeurs) {
  let t = LANGUE === 'en' && Object.prototype.hasOwnProperty.call(EN, texte) ? EN[texte] : texte;
  for (const v of valeurs) t = t.replace('%@', v);
  return t;
}

function traduirePage() {
  document.documentElement.lang = LOCALE;
  if (LANGUE !== 'en') return;
  document.title = tr(document.title);
  for (const n of document.querySelectorAll('[data-tr]')) {
    for (const t of n.childNodes) {
      if (t.nodeType !== Node.TEXT_NODE || !t.textContent.trim()) continue;
      const brut = t.textContent, cle = brut.trim();
      if (EN[cle]) t.textContent = brut.replace(cle, EN[cle]);
    }
  }
  for (const n of document.querySelectorAll('[data-tr-attr]')) {
    for (const a of n.getAttribute('data-tr-attr').split(' ')) {
      if (n.hasAttribute(a)) n.setAttribute(a, tr(n.getAttribute(a)));
    }
  }
}

function basculerLangue() {
  const autre = LANGUE === 'en' ? 'fr' : 'en';
  try { localStorage.setItem('langue', autre); } catch (e) { /* bloqué */ }
  const p = new URLSearchParams(location.search);
  p.delete('langue');
  location.replace(location.pathname + (p.size ? '?' + p : '') + location.hash);
}

document.addEventListener('DOMContentLoaded', () => {
  traduirePage();
  for (const b of document.querySelectorAll('button.langue')) {
    b.textContent = LANGUE === 'en' ? 'FR' : 'EN';
    b.setAttribute('aria-label', LANGUE === 'en' ? 'Afficher en français' : 'Show in English');
    b.setAttribute('lang', LANGUE === 'en' ? 'fr' : 'en');
    b.addEventListener('click', basculerLangue);
  }
});
