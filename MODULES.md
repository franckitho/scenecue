# Writing a module for SceneCue

A module is a folder placed next to SceneCue (or in `modules/`) that contains a `module.json`.
SceneCue detects it at startup. In a scene, each instance of the module is a **layer**.
The same module can also run **on its own**, like `text-animated`.

## module.json

```json
{
  "id": "text-animated",
  "name": "Texte animé",
  "description": "Une phrase affichée dans le catalogue.",
  "en": { "name": "Animated text", "description": "A sentence shown in the catalog." },
  "version": "1.0.0",
  "icon": "assets/icon.png",
  "panel": "src/renderer/index.html",
  "layer": "src/renderer/overlay.html",
  "include": ["node_modules/@fontsource"]
}
```

| Field | Role |
|---|---|
| `name`, `description` | Shown in the catalog, in French (the source language). |
| `en` | Optional. `{ name, description }` used when the interface is in English. |
| `panel` | Editing page of a layer, shown in SceneCue's central area. |
| `layer` | Page rendered on screen. Transparent background; it fills its whole window and adapts to its size (full-screen overlay, thumbnail, editor backdrop). |
| `main` | Optional. Node script loaded in SceneCue's main process (server, disk access…). See “Backend”. |
| `include` | `node_modules` folders needed at runtime (fonts, backend dependencies…), copied into SceneCue's executable. Everything else (Electron, `dist`…) is left out. |

All paths are relative to the module folder.

## The bridge

The two pages only talk through a `bridge` object. It is provided:
- when running on its own, by the module's preload (`window.bridge`);
- inside SceneCue, by the parent page (same origin, `scenecue://app`).

```js
function hostBridge() {
  try {
    return window.parent !== window && typeof window.parent.sceneCueBridge === 'function'
      ? window.parent.sceneCueBridge(window)
      : null;
  } catch { return null; }
}
const api = window.bridge || hostBridge();
```

### `panel` side

| Member | Description |
|---|---|
| `embedded` | `true` inside SceneCue: hide your own title bar, on-air button and screen picker. |
| `init()` | Promise → `{ state, shared, displays, live, since, hotkey, embedded, backdrop }`. |
| `saveState(state)` | Saves the config of **this layer** (JSON object). SceneCue pushes it live to the screen. |
| `saveShared(data)` | Data shared by every instance of the module (e.g. saved styles). |
| `setLive(bool)` | Puts this layer's scene on screen, or cuts it. |
| `resetTimer()` | Resets the “on screen” time. |
| `suggestName(name)` | Suggests a name for the layer (e.g. the file name). Ignored if the user already renamed it. |
| `call(method, ...args)` | Calls the module's backend (`main`). Promise of the result. Also available on the `layer` side. |
| `on(channel, fn)` | `live` → `{ live, since }`, `displays` → list of screens (the first one is the output). |

#### Media library (SceneCue only)

Imported files are copied into SceneCue's folder and shared by every module.
Each media is described by `{ id, name, file, kind: 'image' | 'video', size, url }`.
`url` (`scenecue://app/@media/…`) can be read from the `panel` and `layer` pages (same origin, range requests for videos).
Promise-based methods, rejecting with a readable message (e.g. unsupported format):

| Member | Description |
|---|---|
| `pickMedia()` | Opens the file picker. → media, or `null` if cancelled. |
| `importMedia(file)` | Imports a dropped `File` (drag and drop). → media. |
| `listMedia()` | → list of media, newest first. |
| `removeMedia(id)` | → `{ ok: true }`, or `{ ok: false, used }` if layers still use it. |

`backdrop` (SceneCue only) holds two URLs, `below` and `above`: the scene's other layers,
under and over this one. Load them in iframes stacked around your preview with
`pointer-events: none` and `color-scheme: normal` (otherwise Chromium renders them opaque).

### `layer` side

`init()` returns `{ state, live, since, embedded, output }`. `output` is `true` in the real output (the overlay)
and `false` in previews (thumbnail, editor backdrop): only the output may play sound.

| Channel | When |
|---|---|
| `state` | New config for the layer (on every change in the editor). |
| `live` | `{ live, since }`: the scene has been on screen since `since` (ms). |
| `enter` | The scene comes on screen: play the entrance animation. |
| `leave` | The scene goes away: disappear in under 450 ms (and stop sound, video, timers). |
| `show` | Preview: show directly, without animation. |

## Backend (`main`)

```js
// src/backend/backend.js
module.exports = function backend(ctx) {
  // ctx.id, ctx.dataDir (module's data folder), ctx.log(...), ctx.emit(channel, data), ctx.lang() ('fr' or 'en')
  return {
    async start() { /* … */ return { ok: true }; }, // called by bridge.call('start')
    dispose() { /* when SceneCue closes */ },
  };
};
```

- Every returned method can be called with `bridge.call(name, ...args)` from this module's `panel` and `layer` pages (everywhere: overlay, previews).
  Arguments and results must be serializable (JSON).
- `ctx.emit(channel, data)` sends an event to **all** the module's pages, received with `bridge.on(channel, fn)`.
  Don't reuse SceneCue's channels (`state`, `live`, `displays`, `enter`, `leave`, `show`).
- The backend lives as long as SceneCue: it is loaded at startup, even if no scene uses the module.
  Only start a server on demand.

## Translation

The interface is French or English. SceneCue adds `?lang=fr` or `?lang=en` to the address of every `panel` and `layer` page.
Running on its own, a module follows the system language (`navigator.language`).

The bundled modules write their text in French and translate it with a copy of `src/renderer/i18n.js` and an `en.js` dictionary:

```html
<script src="i18n.js"></script>
<script src="en.js"></script>   <!-- I18N.add({ 'Texte français': 'English text', 'Bonjour {name}': 'Hello {name}' }) -->
<script src="app.js"></script>
```

```js
const _ = I18N.t;
I18N.apply();                         // translates the static HTML: text, title, placeholder, aria-label, alt,
                                      // data-label, data-options and data-titles labels
el.textContent = _('Bonjour {name}', { name });   // text built in JavaScript
```

Mark an element with `data-i18n` to translate its whole content at once (text with `<b>`, `<kbd>`…),
and with `data-no-i18n` to leave it untouched. `scripts/snap-i18n.js` reports French text left in the English interface.

## Rules

- Pages are served from `scenecue://app/…`: use relative paths, CSP `default-src 'self'`.
- No inline `<script>` (the CSP blocks them): everything goes in `.js` files.
- The `layer` page must not paint any background: no `background` on `html`/`body`.
- To run on its own, the module keeps its own `package.json`, `src/main.js` and `src/preload.js`.
  Those of `text-animated` are the template: editing window, transparent overlay, shortcut, notification area.
