# Pancarte

Shows animated text (WordArt style) on a transparent background, on top of the whole screen, so your friends see it in your Discord stream while you're away.

It is also the **Animated text** module of [Régie](../README.md) (see `module.json`). The same code runs on its own or as a layer in a scene.

## Usage

- Run `dist/Pancarte-win32-x64/Pancarte.exe` (build it first, see below).
- Type your text, pick a style from the gallery, then tune it (font, colors, outline, 3D extrusion, curve, animation, entrance).
- Drag the text in the preview to place it. The checkerboard stands for transparency.
- **Show Pancarte** or **Ctrl+Alt+B** (from any app) shows or hides it.
- Clicks go through Pancarte: you can keep using your PC.
- If you close the window while Pancarte is shown, the app goes to the notification area. To quit: right-click its icon → Quit.
- Optional subtitle and timer (countdown or stopwatch). **Dim** darkens the screen behind the text.
- The interface follows the Windows language (French or English).

**Discord**: share your **entire screen**. When sharing a window, Pancarte doesn't show up.
A game in exclusive fullscreen can cover it: switch the game to borderless windowed.

## Development

```bash
npm install
npm start            # run in dev mode
npm run package      # rebuild dist/Pancarte-win32-x64/Pancarte.exe (close the app first)
```

`scripts/snap.js` runs a scenario and saves screenshots to check the rendering:
`npx electron scripts/snap.js <folder>`.
