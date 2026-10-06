/* Traduction de l'interface (copie identique dans chaque module).
 * Le français est la langue source : les textes restent en français dans le HTML et le JS, et un dictionnaire
 * français → anglais (en.js, à côté) les remplace quand la langue est l'anglais.
 *  - I18N.apply(racine) traduit le HTML statique : textes, attributs title / placeholder / aria-label / alt /
 *    data-label, libellés de data-options et data-titles. Un élément [data-i18n] est traduit d'un bloc (HTML compris).
 *  - I18N.t('Texte français', { variable }) pour les textes construits en JS ({variable} dans les deux langues).
 * Langue : ?lang=fr|en dans l'adresse de la page (donnée par Régie), sinon celle du système. */
(function () {
  'use strict';
  const param = new URLSearchParams(location.search).get('lang');
  const lang = param === 'fr' || param === 'en' ? param : /^fr\b/i.test(navigator.language || '') ? 'fr' : 'en';
  const dict = {};
  const missing = new Set(); // textes sans traduction rencontrés (repérés par scripts/snap-i18n.js)
  const norm = (s) => String(s).replace(/\s+/g, ' ').trim();
  const has = (k) => Object.prototype.hasOwnProperty.call(dict, k);

  function t(fr, vars) {
    let s = fr;
    if (lang !== 'fr') {
      if (has(fr)) s = dict[fr];
      else missing.add(fr);
    }
    if (vars) s = s.replace(/\{(\w+)\}/g, (m, k) => (vars[k] != null ? String(vars[k]) : m));
    return s;
  }

  function tr(s) {
    const k = norm(s);
    if (!k || !/\p{L}/u.test(k)) return null;
    if (has(k)) return dict[k];
    missing.add(k);
    return null;
  }

  const ATTRS = ['title', 'placeholder', 'aria-label', 'alt', 'data-label'];
  function apply(root = document.body) {
    document.documentElement.lang = lang;
    if (lang === 'fr' || !root) return;
    for (const el of root.querySelectorAll('[data-i18n]')) {
      const v = tr(el.innerHTML);
      if (v != null) el.innerHTML = v;
    }
    const walk = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode: (n) => (n.parentElement && n.parentElement.closest('[data-i18n], script, style, [data-no-i18n]')
        ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
    });
    for (let n = walk.nextNode(); n; n = walk.nextNode()) {
      const v = tr(n.nodeValue);
      if (v != null) n.nodeValue = n.nodeValue.match(/^\s*/)[0] + v + n.nodeValue.match(/\s*$/)[0];
    }
    for (const el of [root, ...root.querySelectorAll('*')]) {
      for (const a of ATTRS) {
        if (!el.hasAttribute(a)) continue;
        const v = tr(el.getAttribute(a));
        if (v != null) el.setAttribute(a, v);
      }
      if (el.dataset.options) {
        el.dataset.options = el.dataset.options.split(',').map((part) => {
          const i = part.indexOf(':');
          const v = i < 0 ? null : tr(part.slice(i + 1));
          return v != null ? `${part.slice(0, i)}:${v}` : part;
        }).join(',');
      }
      if (el.dataset.titles) el.dataset.titles = el.dataset.titles.split('|').map((p) => tr(p) ?? p).join('|');
    }
  }

  window.I18N = { lang, t, apply, add: (d) => Object.assign(dict, d), missing };
})();
