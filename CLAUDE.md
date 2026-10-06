# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

SceneCue: an Electron app (Windows) that composes **scenes** out of **modules** and shows them on top of the whole screen (transparent overlay, click-through) for Discord streams. Plain JavaScript, no build step, no framework. Repository: `github.com/franckitho/scenecue`. The app used to be called Régie: on first launch `migrateFromRegie()` in `main.js` takes over `%APPDATA%Regie` (`regie.json`, `media/`, `modules/`).

Languages, deliberately mixed:
- **Interface**: French is the source language, written as-is in the HTML and JS. English comes from an `en.js` dictionary next to each page (see Translation below). Never hard-code English in the UI.
- **Code comments**: French. Keep writing them in French.
- **Docs** (`README.md`, `MODULES.md`, this file, `text-animated/README.md`): English.

No linter, no unit tests.

## Commands

```bash
npm install && (cd cam && npm install)     # the Camera module has its own dependency (qrcode)
npm start                                   # SceneCue in dev mode (detects sibling modules)
npm run check                               # node --check on every JS file (also run by CI)
npm run package                             # dist/SceneCue-win32-x64/SceneCue.exe with every module (close SceneCue first: locked files)
npm run site -- --repo=franckitho/scenecue  # builds the website into _site/ (CI passes GITHUB_REPOSITORY instead)
npx electron scripts/snap.js <dir>           # SceneCue scenario: PNG screenshots + console.log + scenecue.json
npx electron scripts/snap-media.js <dir>     # Image / video module: 31 checks in results.txt + screenshots
npx electron scripts/snap-cam.js <dir>       # Camera module: 27 checks (fake camera, simulated iPhone)
npx electron scripts/snap-music.js <dir>     # Now playing module: 36 checks (simulated Spotify, then the real PowerShell once)
npx electron scripts/snap-i18n.js <dir>      # English UI: 17 checks, reports any French left on screen
npx electron scripts/snap-mirror.js <dir>    # Broadcast window: 23 checks (two screens), 29 with Virtual Display Driver (plugs/unplugs the virtual screen, ends with app.quit)
node media/scripts/make-icon.js             # regenerates a module icon (same for cam/scripts; npm run icon for SceneCue)
cd text-animated && npm start               # Animated text module on its own ("Pancarte")
```

The `snap*.js` scenarios start the real app with a temporary profile (`<dir>/userdata`), make the overlay invisible and drive the UI. Individual checks can't be run alone: run the whole scenario (about 1 min; windows appear on screen). They detect the main window by URL (`includes('/src/renderer/index.html')`, the URL carries `?lang=`). `snap.js`, `snap-media.js`, `snap-cam.js` and `snap-music.js` assert on French text: they force French with `--lang=fr-FR` (the app defaults to English; `snap-i18n.js` keeps `--lang=en-US` for the phone page). To test the packaged exe: `SCENECUE_MAIN="C:/…/dist/SceneCue-win32-x64/resources/app.asar/src/main.js"` (Windows path, not `/c/…`).

## Architecture

**One origin, `scenecue://app`.** `src/main.js` registers a protocol serving the repository root (or `app.asar`). Module pages are loaded in iframes on the same origin, which lets them get their bridge through `window.parent.sceneCueBridge(window)`. The `/@media/<file>` route serves the media library (`userData/media`) with `Range` support, which video seeking requires.

**Main process is the source of truth.** `scenecue.json` (in userData, i.e. `%APPDATA%\SceneCue`) holds `scenes[] → layers[] { id, module, name, visible, state }`, `shared[moduleId]`, `media[]`, `selected`, `display`, `mirror`, `lang`. In `layers` the order is bottom to top (the on-screen list is reversed). The SceneCue window sends the structure (`scenes`) and each layer's state (`layer-state`); the main process saves, then relays to the overlay if the scene is on screen. It also owns the global shortcuts Ctrl+Alt+B and Ctrl+Alt+1…9 (which clash with Pancarte).

**Two windows, one compositor.**
- `index.html` + `scenecue.js`: the main window (scenes, layers, the layer editor in an iframe, putting on screen).
- `compositor.html` + `compositor.js`: stacks one iframe per layer and gives each its bridge.
  - With `?mode=overlay` it is the full-screen overlay, driven over IPC, with `backgroundThrottling: false`.
  - With `?mode=mirror` it is the broadcast window, used instead of the overlay when `store.mirror` names another screen ("Broadcast" menu). Fullscreen on that screen, always shown (even off air), it plays a live copy of the `display` screen (`getDisplayMedia`) in a `.stage` sized to that screen's ratio, with the layers on top; Discord shares that screen, so system audio comes along. Only this window may capture the screen (`setDisplayMediaRequestHandler` in `main.js`), and while it exists the SceneCue window is excluded from captures (`setContentProtection`). `applyOutput()` recreates the output window when the mode or screens change; after a cut it empties the scene instead of hiding the window.
  - `store.mirror` may also be `'virtual'`: the screen of the Virtual Display Driver (Electron `display.label` "VDD by MTT", hidden from the screen menus and numbering). `syncVirtual()` plugs it in while that setting is chosen (resolution of the `display` screen, touching the rightmost screen only by its top-right corner so the mouse can't slip onto it), and unplugs it when leaving the setting or in `will-quit`; otherwise SceneCue never touches it. `src/vdisplay.js` runs `src/vdisplay.ps1` (Windows PowerShell 5.1, C# through `Add-Type`, `ChangeDisplaySettingsEx`, no admin rights) via `-EncodedCommand`, since PowerShell can't read inside `app.asar`. The driver's own named pipe (`MTTVirtualDisplayPipe`) isn't used: its reload command is broken.
  - Without it, an embedded preview (the "Preview" thumbnail, layers above/below behind an editor), fed through `window.top.sceneCueFeed` with the `scene`, `ref` and `only=below|above` parameters.
- `src/preload.js` is only injected into those top-level windows (`host` object). Module iframes never reach it directly: they go through the bridge built in `scenecue.js` (`makePanelBridge`) or in `compositor.js`.

**Modules.** A folder with a `module.json`, at the root or in `modules/`, is discovered at startup (alphabetical folder order). It provides two pages: `panel` (the editor) and `layer` (the render, on a transparent background). The full bridge contract is in `MODULES.md`: `init/saveState/saveShared/setLive/suggestName`, the media library `pickMedia/importMedia/listMedia/removeMedia`, and the `state/enter/leave/show/live` channels. `module.json` may carry `en: { name, description }`; `localModules()` in `main.js` picks the right one and passes `names` (all languages) so `suggestName` recognizes automatic layer names in either language.

A module may also declare a **backend** (`"main"` in `module.json`): a Node script `require`d by `src/main.js` at startup (`loadBackends`), receiving `ctx { id, dataDir, emit, log, lang }`. Its methods are called through `bridge.call()`: IPC `module-call` from the SceneCue window, the overlay, or previews via `sceneCueFeed.call`. `ctx.emit` goes out as IPC `module-event`, which `scenecue.js` and `compositor.js` dispatch to every page of the module (`bridge.on`).

Things that break easily:
- CSP is `default-src 'self'`: no inline `<script>`, no `eval`, relative paths only.
- The `layer` page never paints a background. Stacked iframes need `color-scheme: normal`, otherwise Chromium renders them opaque.
- On `leave`, disappear in under 450 ms. Only `init().output === true` (the overlay) may play sound.
- `scripts/package.js` bundles every module without its `dist/`, `scripts/` or Electron, keeping only the module `node_modules` listed in `include`; it also leaves out `site/`, `_site/`, `docs/` and `.github/`.

**`text-animated/`** (Animated text) also runs **on its own** as Pancarte, with its own `package.json`, `src/main.js` and `src/preload.js`, and the same bridge. `render.js` is the rendering engine shared by the preview and the overlay. Everything is drawn on a logical canvas 1920 px wide (height follows the screen ratio), then scaled. On first launch, SceneCue imports the text and styles already set in Pancarte.

**`media/`** (Image / video) only works inside SceneCue: its fonts come from the root `node_modules`. `media.js` (`Media.Player`) is shared by the editor preview and the layer, on the same 1920 px canvas principle. Three sources:
- `<img>` for a still image.
- `ImageDecoder` for animated GIF, WebP and APNG: frames are decoded one by one into `ImageBitmap`s, then played on a `<canvas>`.
- `<video>` for videos. In boomerang mode, frames are captured during the first pass (`requestVideoFrameCallback`, with a fallback capture in the `requestAnimationFrame` loop), within `CACHE_BYTES`, then replayed backwards and forwards on the canvas, since Chromium can't play a video in reverse.

The end of a pass is also detected through `timeupdate`/`ended` and timers, not only `requestAnimationFrame`.

**`cam/`** (Camera) only works inside SceneCue. It has its own `package.json` (`qrcode` dependency, bundled through `include`). Two sources:
- **PC camera**: `getUserMedia` in every page that shows it. Chromium shares the device across processes, but in the format of whoever opens it first, so every page requests the same constraints.
- **iPhone**: `src/backend/backend.js` starts an HTTPS server on demand (port 8443, redirect from http 8080). `cert.js` generates, in pure Node, a self-signed certificate that meets iOS requirements, regenerated when the IP address changes. The server serves the `src/phone/` page and relays WebRTC signaling: the phone uses SSE and POST, the layers use `bridge.call('join'|'answer'|'leave'|'setActive')` and `bridge.on('offer')`.
  - The phone makes the offer, one connection per layer watching. The overlay gets full quality, previews a downscaled picture (`scaleResolutionDownBy`).
  - Signaling without trickle ICE: candidate gathering is awaited.
  - A layer without a picture re-registers every 8 s (`join`), and the phone drops an offer left unanswered for 15 s. That is what recovers from reconnections.
  - The `?k=` key in the URL is required by `/api/hello`.
  - `src/main.js` disables `WebRtcHideLocalIpsWithMdns` so real IPs are announced on the local network.
  - The server config (ports, `host`, network adapter, key, front/back camera) lives in `userData/modules/camera/config.json`, not in layer state.

**`music/`** (Now playing) only works inside SceneCue. It reads Spotify from Windows' media controls (SMTC), with no Spotify API or account:
- `src/backend/smtc.ps1` runs in Windows PowerShell 5.1 (the only one that loads WinRT types without extra modules). Every 500 ms it prints one JSON line: `{ app, title, artist, album, status, position, duration, updated, cover? }`, or `{ app: null }`.
  - The session is the one whose `SourceAppUserModelId` matches `spotify`: the web player (a browser session) is not seen.
  - `cover` (base64) is only sent on a track change, then again if it changes during the next few reads (Spotify can publish it late).
  - PowerShell can't call methods on WinRT streams: the cover is read through `AsStreamForRead`, called by reflection.
  - The script exits by itself when SceneCue stops reading its output (the write fails).
- `backend.js` copies the script to `userData/modules/music` (PowerShell can't read inside `app.asar`). It starts it on `watch`, which pages call every 20 s, and kills it 60 s after the last call. It only emits `track` on real changes (song, play/pause, cover, a jump of more than 1.5 s). After three crashes in a row it reports an error, and keeps retrying.
- `track.position` is valid at `track.at` (ms); pages extrapolate it while playing (`Music.positionOf`).
- Previews show a sample song while Spotify is closed. The overlay (`init().output`) never does: the card stays off screen without a song, or while paused with "Masquer".
- `snap-music.js` replaces `child_process.spawn` before loading `main.js`, so the backend reads a fake Spotify driven by the scenario.

## Translation

- Language: `store.lang` if the user picked one with the FR | EN switch (IPC `lang`, which reloads the main window), otherwise English (or French when launched with `--lang=fr…`). `main.js` adds `?lang=` to every page URL (`pageUrl`); `scenecue.js` passes it on to panel and compositor URLs, and `compositor.js` to layer URLs. Main-process strings (tray, dialogs, errors) use `L(fr, en)`.
- Each page loads `i18n.js` (identical copies in `src/renderer`, each module's renderer folder, `cam/src/phone` and `site/`) and an `en.js` dictionary keyed by the exact French text. `I18N.apply()` translates static HTML; JS uses `_('French text', { var })` (`const _ = I18N.t`; `_` because `t` is often a local time variable). Elements with mixed markup carry `data-i18n` and are translated as one HTML block keyed by their normalized `innerHTML`.
- The same French key maps to a single English text everywhere in a page: when one French word needs two translations, change the French wording (e.g. the "spin" motion is labelled "Toupie", not "Rotation").
- The phone page and Pancarte follow `navigator.language`. The cam backend translates messages shown in SceneCue with `ctx.lang()`; messages sent to the phone stay French and are translated by the phone page.
- After adding UI text, add it to the page's `en.js` and run `snap-i18n.js`.

## Website and CI

- `site/` is the GitHub Pages site (French source + `en.js`, English by default through `data-lang-default="en"` on `<html>`, `?lang=fr` for French). `scripts/build-site.js` assembles `_site/` (site files, `docs/images`, icon, self-hosted fonts) and injects the repository (`data-repo`, absolute `og:` URLs). The download button links to `releases/latest/download/SceneCue-win-x64.zip` and reads the latest release from the GitHub API at load time.
- `.github/workflows/build.yml`: Windows build on pushes to `main` and pull requests (zip kept 14 days as an artifact); a `v*` tag sets the package version and publishes a release with `SceneCue-win-x64.zip` (that file name must never change). `pages.yml` deploys `_site/` to GitHub Pages.

## Known pitfalls

- Chromium pauses muted videos and throttles `requestAnimationFrame` in a hidden or covered window. The overlay is immune, the editor preview is not. In test scenarios:
  - use `setBackgroundThrottling(false)`;
  - evaluate inside an iframe with `webContents.mainFrame.framesInSubtree…executeJavaScript` (`contentWindow.eval` is blocked by the CSP);
  - for a drag, send the `mouseMove` events with `modifiers: ['leftButtonDown']`;
  - mute with `webContents.setAudioMuted(true)` (the test video contains a beep);
  - for the camera, use `--use-fake-device-for-media-stream` (never the real webcam). The server must listen on `host: '127.0.0.1'`, otherwise the Windows firewall pops up a dialog. Accept the certificate with `app.on('certificate-error')`.
- What can't be tested here, for lack of a real iPhone: Safari, the Windows firewall, a Wi-Fi network with a "public" profile.
- Color tokens and controls (`.seg`, `.ctl.range`, `.switch`…) are **copied** into `src/renderer/scenecue.css` and each module's CSS, not shared. For visual consistency, change every copy.
- Media library copies are de-duplicated by name and size. A removal is refused while a layer references the file: the search looks for the file name in the JSON of layer states.
