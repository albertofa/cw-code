# cw-code landing-page plan

## Goal

Help a developer understand the app, check its requirements, and open the source
or download an available Windows release. Use the selected Console C identity
and the desktop's existing graphite palette, Inter, and JetBrains Mono.

**Status:** planned in this draft PR. The page is not built or published here.
The desktop branding and repository README are implemented in this PR.

## Page content, in reading order

### Header and introduction

- Console C logo and `cw-code` wordmark.
- Headline: **Your coding CLIs. One desktop workspace.**
- Description: **A desktop workspace for Claude Code, OpenCode, and Codex.**
- Supporting sentence: Run sessions across projects, inspect files and Git diffs,
  and open real CLI terminals.
- Platform and channel: Windows · Open source · Alpha.
- Before the first installer release: **View source** links to
  <https://github.com/albertofa/cw-code> and **Build from source** links to the
  README's development instructions.
- After a tested installer is published: **Download for Windows** becomes the
  primary action and targets that release; retain **View source** alongside it.
  Show the actual version and requirements from release metadata.

### Product demonstration

Use a current production-build screenshot containing a demonstration repository,
project-grouped sessions, a conversation, and a useful diff or terminal. Capture
the real interface at a legible resolution. A small detail crop can follow it.
Keep account names, personal paths, credentials, and client code out of captures.
Mark fabricated conversation content as demonstration data. Do not substitute a
mock interface or the social preview for a product screenshot.

### Features

- Run sessions across projects in one window.
- Read conversations and tool output.
- Inspect files and Git diffs.
- Open real CLI terminals.
- Resume sessions using the CLI's saved context.

### Requirements and limits

Requires Windows and at least one supported CLI installed and authenticated.
Link to the README for the current minimum CLI versions. Explain that the CLI
handles inference, authentication, model access, and usage charges; the desktop
app does not include a subscription or promise unlimited usage. History display
is best-effort. Link to current limitations and troubleshooting.

### Footer

Source · Releases · Installation · Report an issue · MIT License.
Include provider non-affiliation wording from `COPY.md` and font license notices.
Use actual repository destinations; do not create empty documentation links.

## Implementation

1. Add a small static site under `apps/site`, using Vite and semantic HTML/CSS.
   No backend, login, analytics, or contact form is needed for the initial page.
2. Reuse canonical assets from `design/brand/assets/`, especially
   `lockup-primary.svg`, `app-icon.svg`, and `social.png`. Copy them into the site
   through an explicit asset script instead of maintaining independent drawings.
3. Self-host the supplied Inter font and preserve its OFL notice. Use monospace
   only for actual code or commands. Build responsive sections for 390, 768,
   1440, and 1920px widths. Keep body copy readable and downloads keyboard-accessible.
4. Set the title to `cw-code — Desktop workspace for coding CLIs`, and use the
   website description from `COPY.md`. Add favicon, Open Graph image, alt text,
   and canonical URL when the final hosting address is known.
5. Prepare GitHub Pages deployment for the static build. Verify the repository's
   Pages settings and site base path before enabling deployment. A custom domain
   is optional and must be configured before its URL is used in metadata.
6. Open a separate implementation PR with desktop/mobile screenshots, asset sizes,
   link verification, and deployment preview. Publish after that PR is reviewed.

## Work packages

| Order | Work | Owner role | Acceptance |
| --- | --- | --- | --- |
| 1 | Capture current product screenshots | Desktop maintainer | Correct logo; demo-only content; readable workspace; no private data |
| 2 | Build static page and responsive layout | Frontend maintainer | Approved copy and assets; complete content above; no horizontal overflow |
| 3 | Wire release and source actions | Release maintainer | Every action resolves; download appears only when a tested installer exists |
| 4 | Add metadata and license notices | Frontend maintainer | Correct share preview, favicon, title, canonical URL, and font notices |
| 5 | Validate and deploy | Repository maintainer | Keyboard/contrast checks, mobile/desktop review, successful production build and preview |

## Release gates

- [ ] Source and release links verified against the repository.
- [ ] Current screenshot reviewed against the packaged app.
- [ ] No model-service, subscription, privacy, or feature-parity claims beyond
      established behavior.
- [ ] All images have appropriate alt text; focus is visible; contrast is adequate.
- [ ] No external font requests; reduced-motion preference respected.
- [ ] Layout verified at all listed widths and 200% browser zoom.
- [ ] Social preview and favicon checked on the deployment preview.
- [ ] Production build passes; asset budget is reviewed before adding video.
- [ ] Hosting address, Pages permissions, and release-channel wording confirmed.

The first version needs one page. A pricing page, customer testimonials, and
competitor rankings are not prerequisites for shipping it.
