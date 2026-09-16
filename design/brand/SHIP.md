# Branding shipping plan

## Delivered in this suite

- [x] Name treatment, positioning, headline, and descriptions.
- [x] Selected Console C symbol, wordmark, horizontal lockups, dark/light/white/violet variants.
- [x] App icon SVG, 12 PNG sizes, Windows ICO, favicon, profile image.
- [x] Social and repository preview exports, with outlined type.
- [x] Typography rules, bundled font files/licenses, color tokens, voice guidance.
- [x] Visual brand sheet, copy library, and reproducible asset generator.

The assets are delivered. The title-bar and About branding, runtime/packaging icon configuration, metadata, bundled license notices, and README opening are implemented in this branch. The tables below retain acceptance criteria; fresh-install/upgrade checks and publication remain release work. See `LANDING-PAGE.md` for the website implementation plan.

## P0 — Put the identity in the next Windows build

| Task | Touchpoints | Done when |
| --- | --- | --- |
| Integrate the title-bar symbol | `apps/desktop/src/renderer/src/components/TitleBar.tsx`, `.titlebar-logo` in `theme.css` | Supplied symbol replaces the CW text placeholder at 22px; adjacent name remains readable; dragging and window controls work. |
| Package the Windows icon | Copy `assets/cw-code.ico` into a desktop build-resource directory; set `win.icon` in `apps/desktop/electron-builder.yml` | Installed EXE, Start menu entry, shortcuts, taskbar, and uninstall entry show the correct icon; default Electron artwork is absent. |
| Set the runtime icon if required | `apps/desktop/src/main/index.ts`, `BrowserWindow` options and packaged-resource path | Development and packaged windows use a valid local resource; behavior is tested in each mode. |
| Align package descriptions | Root and desktop `package.json`; installer metadata | The short description is consistent. Keep `productName: cw-code` and `appId: com.cwcode.app`; do not change userData paths or session IDs. |
| Add About identity where appropriate | Existing Settings/About surface | Shows name, real app version, short description, repository/release links, project license, and third-party notices. |
| Verify font notices | Existing bundled Inter and JetBrains Mono packages; distributed license notices | Both font licenses are included in the shipped distribution; no remotely loaded fonts. |
| Smoke-test installation | `pnpm dist`, fresh install, upgrade over previous alpha | Installer builds; launch works; existing project/session metadata survives; icon caches do not conceal a wrong resource. |

Owner: desktop maintainer. Dependencies: Option C is selected; use the canonical assets in `design/brand/assets/`. Avoid an app identity rename: it is unrelated to shipping this brand and can affect stored state and upgrades.

## P0 — Make the release understandable

| Task | Touchpoints | Done when |
| --- | --- | --- |
| Apply concise opening copy | Root `README.md` | Uses `COPY.md` opening, actual Windows release link, CLI prerequisites, and current limitations. |
| Capture the current app | README and release assets | One clear full-window screenshot and one useful diff/terminal detail use demo data, contain no personal information, and match the release build. |
| Set repository metadata | Repository description, avatar where applicable, social preview | Supplied description and `repository-social.png` are uploaded; preview is checked. |
| Publish release notes | Release page | Contains actual version, tested requirements, known issues, installer, and changes; no template placeholders. |
| Reconcile design documentation | `apps/desktop/DESIGN.md` and its existing design sidecar | Documents actual graphite palette and Inter-first type without changing the app's approved appearance. |

Owner: release maintainer. Publishing is a later task; nothing is posted by this suite.

## P1 — Public landing page

Build one small page after the release is installable:

1. Logo, primary headline, short description, Windows download, source link.
2. Real product screenshot with meaningful alt text.
3. The five concise feature bullets from `COPY.md`.
4. Windows/CLI prerequisites and link to installation instructions.
5. Release status, source/license, issue link, and attribution.

Use Inter, the current graphite palette, and the supplied social image/favicon. Self-host fonts. Set page title to `cw-code — Desktop workspace for coding CLIs`; use the website description for metadata. Add canonical URL and social-image absolute URL only after the hosting location is known. Verify keyboard access, narrow-screen layout, contrast, and real download targets.

Owner: web maintainer. Dependencies: public source URL, release URL, hosting/domain choice, and current product captures. No pricing page or competitor comparison is required to explain the application.

## P2 — Supporting material

- Installation guide: install CLI → authenticate → install cw-code → open project → start session.
- Troubleshooting: missing/outdated CLI, failed resume, unavailable terminal, incomplete history.
- A short screen recording showing two projects, concurrent sessions, a diff, and a terminal. Use demonstration data and captions.
- Contribution and issue templates that request app version, driver version, reproduction, and redacted logs.
- A dated comparison only if users need it; verify competitor behavior directly before making factual claims.

## Release gate

- [x] `pnpm typecheck`, `pnpm test` (728 tests), and `pnpm build` pass on the integrated change.
- [x] `pnpm dist` produces the Windows installer and executable with the intended icon; installation/upgrade checks are still pending.
- [ ] Inspect 16, 22, 24, 32, 48, and 256px icon rendering, plus Windows scaling at 100%, 125%, 150%, and 200%.
- [ ] Test a clean install and an upgrade; existing projects and resume cursors remain available.
- [ ] Check title bar, taskbar, Start menu, installer, About, README, repository preview, and release page for consistent spelling and assets.
- [ ] Confirm all copy describes supported behavior and alpha limitations; resolve links/placeholders.
- [ ] Check release captures for private information and verify included font notices.

**Shipping boundary:** the next branded release needs both P0 sections. The landing page and supporting material can follow. Asset creation alone does not satisfy installer or publication checks.
