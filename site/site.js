/* Site de Régie — langue, liens vers le dépôt et bouton de téléchargement de la dernière version.
 * Le dépôt vient de data-repo (écrit par scripts/build-site.js), sinon de l'adresse compte.github.io/dépôt.
 * Le zip garde toujours le même nom : releases/latest/download/Regie-win-x64.zip pointe sur la dernière version. */
(function () {
  'use strict';

  const _ = I18N.t; // traduction (voir i18n.js et en.js) : langue du navigateur, ou ?lang=fr|en
  I18N.apply();
  for (const a of document.querySelectorAll('[data-lang]')) a.classList.toggle('on', a.dataset.lang === I18N.lang);
  if (I18N.lang === 'en') for (const img of document.querySelectorAll('img[data-src-en]')) img.src = img.dataset.srcEn; // captures de l'interface en anglais

  const ASSET = 'Regie-win-x64.zip';
  const PATHS = { repo: '', releases: '/releases', issues: '/issues', license: '/blob/main/LICENSE', modules: '/blob/main/MODULES.md' };

  function detectRepo() {
    if (document.body.dataset.repo) return document.body.dataset.repo;
    const host = location.hostname;
    if (!host.endsWith('.github.io')) return '';
    const owner = host.slice(0, -'.github.io'.length);
    const first = location.pathname.split('/').filter(Boolean)[0];
    return `${owner}/${first || host}`;
  }

  const repo = detectRepo();
  const buttons = document.querySelectorAll('[data-dl]');
  const metas = document.querySelectorAll('[data-dl-meta]');
  const note = document.getElementById('dl-note');
  const disable = (a) => { a.removeAttribute('href'); a.classList.add('off'); a.setAttribute('aria-disabled', 'true'); };
  const setMeta = (text) => metas.forEach((m) => { m.textContent = text; });

  for (const a of document.querySelectorAll('[data-link]')) {
    if (repo) a.href = `https://github.com/${repo}${PATHS[a.dataset.link] || ''}`;
    else disable(a);
  }

  if (!repo) {
    buttons.forEach(disable);
    note.textContent = _("Aperçu local : les liens s'activent une fois le site publié sur GitHub Pages.");
    return;
  }
  buttons.forEach((a) => { a.href = `https://github.com/${repo}/releases/latest/download/${ASSET}`; });

  // version, taille et date de la dernière release (l'API publique de GitHub autorise les appels depuis le navigateur)
  fetch(`https://api.github.com/repos/${repo}/releases/latest`, { headers: { Accept: 'application/vnd.github+json' } })
    .then((r) => (r.ok ? r.json() : Promise.reject(r.status)))
    .then((rel) => {
      const asset = (rel.assets || []).find((x) => x.name === ASSET);
      setMeta([rel.tag_name, asset && _('{n} Mo', { n: Math.round(asset.size / 1048576) }), _('Windows 10 et 11')].filter(Boolean).join(' · '));
      const date = new Date(rel.published_at).toLocaleDateString(I18N.lang === 'fr' ? 'fr-FR' : 'en-US', { day: 'numeric', month: 'long', year: 'numeric' });
      const link = document.createElement('a');
      link.href = rel.html_url;
      link.textContent = _('notes de version');
      note.replaceChildren(`${_('Version publiée le {date}', { date })} · `, link, ` · ${_('gratuit, open source (MIT).')}`);
    })
    .catch((status) => {
      if (status !== 404) return; // limite de l'API ou hors ligne : le lien direct fonctionne quand même
      buttons.forEach(disable);
      setMeta(_('Première version bientôt disponible'));
    });
})();
