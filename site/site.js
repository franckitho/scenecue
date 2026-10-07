/* Site de SceneCue — langue, liens vers le dépôt et boutons de téléchargement de la dernière version.
 * Le dépôt vient de data-repo (écrit par scripts/build-site.js), sinon de l'adresse compte.github.io/dépôt.
 * Les fichiers gardent toujours le même nom : releases/latest/download/SceneCue-win-x64.zip pointe sur la dernière
 * version (de même pour SceneCue-linux-x64.deb et SceneCue-linux-x64.tar.gz). Le gros bouton propose la version
 * du système du visiteur : Windows, ou le .deb sous Linux ; la ligne en dessous donne les autres. */
(function () {
  'use strict';

  const _ = I18N.t; // traduction (voir i18n.js et en.js) : langue du navigateur, ou ?lang=fr|en
  I18N.apply();
  for (const a of document.querySelectorAll('[data-lang]')) a.classList.toggle('on', a.dataset.lang === I18N.lang);
  if (I18N.lang === 'en') for (const img of document.querySelectorAll('img[data-src-en]')) img.src = img.dataset.srcEn; // captures de l'interface en anglais

  const LINUX = /Linux/.test(navigator.userAgent) && !/Android/.test(navigator.userAgent);
  const ICON_WIN = 'M0 2.3l6.5-.9v6.2H0zm7.3-1L16 0v7.6H7.3zM0 8.4h6.5v6.2L0 13.7zm7.3 0H16V16l-8.7-1.2z';
  const ICON_DL = 'M7 0h2v9.2l3.3-3.3 1.4 1.4L8 13 2.3 7.3l1.4-1.4L7 9.2zM1 14h14v2H1z';
  const FILES = {
    win: { asset: 'SceneCue-win-x64.zip', title: 'Télécharger pour Windows', system: 'Windows 10 et 11', icon: ICON_WIN },
    deb: { asset: 'SceneCue-linux-x64.deb', title: 'Télécharger pour Linux', system: 'Ubuntu, Debian', icon: ICON_DL },
    tgz: { asset: 'SceneCue-linux-x64.tar.gz' },
  };
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
  const others = document.querySelector('[data-dl-others]');
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
  const url = (key) => `https://github.com/${repo}/releases/latest/download/${FILES[key].asset}`;
  let main = LINUX ? 'deb' : 'win';

  // gros boutons (en-tête et bas de page) : la version du système du visiteur
  function setMain(key) {
    main = key;
    const f = FILES[key];
    buttons.forEach((a) => {
      a.href = url(key);
      a.querySelector('b').textContent = _(f.title);
      a.querySelector('svg path').setAttribute('d', f.icon);
    });
    setMeta(`${_(f.system)} · ${_('gratuit')}`);
  }

  // ligne sous le bouton : les autres versions
  function setOthers(linux) {
    const link = (key, text) => {
      const a = document.createElement('a');
      a.href = url(key);
      a.textContent = text;
      return a;
    };
    others.hidden = !linux;
    if (!linux) return;
    if (main === 'deb') others.replaceChildren(`${_('Autres versions :')} `, link('win', 'Windows'), ' · ', link('tgz', _('Linux .tar.gz (autres distributions)')));
    else others.replaceChildren(`${_('Aussi pour Linux :')} `, link('deb', _('.deb (Ubuntu, Debian)')), ' · ', link('tgz', _('.tar.gz (autres distributions)')));
  }

  setMain(main);
  setOthers(true);

  // version, taille et date de la dernière release (l'API publique de GitHub autorise les appels depuis le navigateur)
  fetch(`https://api.github.com/repos/${repo}/releases/latest`, { headers: { Accept: 'application/vnd.github+json' } })
    .then((r) => (r.ok ? r.json() : Promise.reject(r.status)))
    .then((rel) => {
      const find = (key) => (rel.assets || []).find((x) => x.name === FILES[key].asset);
      // release d'avant la version Linux : seulement Windows
      const linux = !!find('deb') && !!find('tgz');
      if (!linux && main !== 'win') setMain('win');
      setOthers(linux);
      const asset = find(main);
      setMeta([rel.tag_name, asset && _('{n} Mo', { n: Math.round(asset.size / 1048576) }), _(FILES[main].system)].filter(Boolean).join(' · '));
      const date = new Date(rel.published_at).toLocaleDateString(I18N.lang === 'fr' ? 'fr-FR' : 'en-US', { day: 'numeric', month: 'long', year: 'numeric' });
      const link = document.createElement('a');
      link.href = rel.html_url;
      link.textContent = _('notes de version');
      note.replaceChildren(`${_('Version publiée le {date}', { date })} · `, link, ` · ${_('gratuit, open source (MIT).')}`);
    })
    .catch((status) => {
      if (status !== 404) return; // limite de l'API ou hors ligne : le lien direct fonctionne quand même
      buttons.forEach(disable);
      others.hidden = true;
      setMeta(_('Première version bientôt disponible'));
    });
})();
