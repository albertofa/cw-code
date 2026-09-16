# Validation

## Desktop integration — 2026-09-16

- `pnpm typecheck`: passed.
- `pnpm test`: 57 test files and 728 tests passed, including the current main branch changes.
- `pnpm build`: production main, preload, and renderer bundles passed.
- `pnpm dist`: Windows executable and NSIS installer built successfully. Artifacts are unsigned; signing credentials are not configured.
- Production Electron launched with an isolated temporary user-data directory. Title-bar logo decoded correctly; Settings → General displayed Console C, version 0.0.1-alpha.11, MIT License, and the package description. No inference was requested and no existing session metadata was changed.
- The packaged executable's extracted icon is Console C. Packaged `resources/branding/icon.ico` has the same SHA-256 as the source icon. Project and font license notices are bundled alongside it.
- The canonical 256px icon matches the user-selected Option C preview pixel-for-pixel.

The clean profile reported unavailable/outdated local CLIs, as expected for the environment. This does not block the branding smoke check. Tests emitted non-failing fixture diagnostics for jsdom canvas and expected Git recovery errors.

Fresh installation, upgrade over an existing install, taskbar appearance at multiple Windows scale factors, and release publication remain pending. The landing page is planned, not built or deployed.

## Brand assets and review page

- All 18 canonical SVG files parsed successfully.
- Windows ICO contains 16, 24, 32, 48, 64, 128, and 256px images.
- Social image is 1200 × 630px; repository image is 1280 × 640px.
- Brand sheet, selected logo variants, and social exports were visually inspected.
- Standalone HTML review uses embedded assets and fonts; all 20 preview images decoded in the browser.
- Independent selected-asset review found no material issue with geometry, documentation, or the selected direction.
- Measured contrast: primary text on graphite 12.59:1, secondary text 8.87:1, white mark on violet 5.15:1.

See [the shipping checklist](SHIP.md) and [landing-page plan](https://github.com/albertofa/cw-code/pull/17) for remaining work.
