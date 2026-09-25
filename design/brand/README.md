# cw-code brand suite

**A desktop workspace for Claude Code, OpenCode, and Codex.**

Start with [the visual brand sheet](brand-sheet.png), then [brand guidelines](BRAND.md), [ready-to-use copy](COPY.md), and [the shipping plan](SHIP.md).

See [validation results](VALIDATION.md) for repository checks and the limits of asset-only verification.

**Selected logo: Option C — Console C**, with the violet app-icon treatment.

This suite extends the current desktop design. Console C is integrated into the title bar, About section, runtime window icon, Windows packaging configuration, and GitHub README. Installation/release checks remain on the shipping plan. The [landing-page plan](https://github.com/albertofa/cw-code/pull/17) is tracked separately in a draft PR.

## Assets

| Asset | Use |
| --- | --- |
| [Primary lockup](assets/lockup-primary.svg) | Violet icon and light wordmark on dark surfaces |
| `assets/lockup-{light,dark,white,violet}.svg` | Single-color horizontal logo |
| `assets/wordmark-{light,dark,white,violet}.svg` | Wordmark without symbol |
| `assets/mark-{light,dark,white,violet}.svg` | Standalone Console C symbol |
| [Application icon](assets/app-icon.svg) | Master square tile |
| `assets/app-icon-{16…1024}.png` | Transparent PNG exports at supplied pixel sizes |
| [Windows icon](assets/cw-code.ico) | Seven embedded sizes, 16–256px |
| [Favicon](assets/favicon.ico) | 16, 32, 48px |
| [Profile image](assets/avatar.png) | 512px full-bleed avatar; circle-crop safe |
| [Social image](assets/social.png) | 1200 × 630px link preview |
| [Repository image](assets/repository-social.png) | 1280 × 640px repository preview |
| [Vector brand sheet](assets/brand-sheet.svg) | Scalable identity reference |
| [Tokens](tokens.json) | Brand palette and typography handoff |

All logo and social-image lettering is outlined: exports need no installed font. SVGs contain accessible titles. For inline use, provide an accessible name once; hide the symbol from assistive technology when the adjacent product name already labels it.

## Rebuild

From the repository root:

```powershell
pnpm install --frozen-lockfile
python -m pip install fonttools brotli resvg-py Pillow
python design/brand/generate.py
```

The generator uses the app's installed Fontsource packages, draws the mark as SVG geometry, outlines font glyphs, then rasterizes the SVGs. No image-generation service or external font download is required. Review generated files before committing after font dependency updates.

The `fonts/` directory includes the existing Inter and JetBrains Mono Latin variable fonts and their SIL Open Font License notices. Use the app's existing packages for application UI; these copies support a self-contained brand handoff. Add appropriate language subsets for international publishing. Original mark geometry and project-authored artwork follow the repository license. This suite does not establish trademark clearance.
