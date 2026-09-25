# Brand guidelines

## Name and positioning

**cw-code** — always lowercase, including headings. Keep the hyphen. Do not invent an expansion for “cw.” The symbol is Console C; running text uses the full name.

**Category:** desktop workspace for coding CLIs.

**Audience:** developers who already use coding CLIs and need to manage sessions across repositories, inspect changes, and work in terminals from one window.

**Product promise:** keep your CLI workflow; organize the work in one desktop application.

**Headline:** Your coding CLIs. One desktop workspace.

**Core description:** A desktop workspace for Claude Code, OpenCode, and Codex.

The product executes the installed CLIs. They own authentication, model access, inference, and session continuation. cw-code provides the project/session workspace, chat rendering, file inspection, Git diff, and terminal access. Provider capabilities and billing remain subject to the selected CLI and account configuration.

## Logo

**Selected direction: Option C — Console C.** A cut-corner C with a short command line inside it. Preserve the selected filled geometry on its 64-unit canvas. Pair it with the lowercase Inter wordmark. The violet tile remains the primary treatment; the user selected the symbol without requesting a palette change. The logo does not borrow provider symbols or imply provider ownership.

- Use the violet tile and light wordmark on graphite for the primary identity.
- Use the dark single-color logo on light backgrounds and the white variant on solid dark backgrounds.
- Use the standalone tile for taskbar, Start menu, installer, avatar, and favicon.
- Use plain `cw-code` text when the logo would be too small to read.
- Minimum tile size: 16px; prefer 22–24px inside the desktop title bar.
- Minimum full lockup width: 132px. Below this, use the tile or normal UI text.
- Keep external clear space of at least one quarter of the tile's height. Asset bounds include internal geometry spacing; they do not replace external clear space.
- Keep original proportions, symbol geometry, and wordmark spacing. Do not stretch, rotate, add shadows, add gradients, animate the logo as a loading state, or recolor it by provider.
- The SVG tile has rounded corners and a transparent exterior. The avatar is full bleed for platforms that apply their own crop.

The small exports share the same geometry; verify their actual taskbar appearance at Windows scaling settings before release. If a surface only supports monochrome, use the supplied single-color mark.

## Typography

Keep the fonts already bundled in the application.

| Role | Typeface | Specification |
| --- | --- | --- |
| Wordmark | Inter | 600, −0.02em tracking; supplied as outlines |
| Marketing headline | Inter | 500, 48–88px, 1.08–1.15 line height, −0.02em |
| Section heading | Inter | 600, 24–32px, 1.2 line height |
| Marketing body | Inter | 400, 16–20px, 1.5 line height |
| App text | Existing Inter Variable stack | Preserve current UI scale and styles |
| Code, paths, command output | JetBrains Mono Variable | 400–500; preserve current UI scale |

Use sentence case. Use normal sans-serif text for navigation, features, and descriptions. Reserve monospace for actual technical content. Keep bold for names, actions, and important state. Font files and licenses are supplied; do not distribute Segoe UI font files.

## Color

These values come from the current `theme.css`, not the older `apps/desktop/DESIGN.md` palette.

| Color | Value | Brand use |
| --- | --- | --- |
| Graphite | `#1e1f22` | Main canvas |
| Editor | `#101214` | Dark inset and logo showcase |
| Raised | `#2e3035` | Secondary surfaces |
| Text | `#dfe1e5` | Primary text on dark |
| Secondary text | `#bcbec4` | Descriptions on dark |
| Violet | `#7c42ff` | App icon and brand emphasis |
| Focus blue | `#548af7` | Existing functional focus/action color |

Use white for the mark inside the violet tile. Use primary/secondary text for prose. Keep violet sparse outside the icon. Retain the desktop's existing provider and status colors for their functional roles. Brand work should not recolor the app's controls. Do not use low-contrast muted UI tokens for marketing body copy.

## Voice

Write like a developer explaining a tool to another developer. State the action, the object, and any limitation that changes the decision.

| Prefer | Avoid |
| --- | --- |
| Run sessions across projects. | Supercharge your development workflow. |
| Inspect files and Git diffs. | Gain unprecedented visibility. |
| Uses your installed CLIs. | Unlimited AI, powered by your subscription. |
| Resume a session. | Pick up where inspiration left off. |
| Install and sign in to a supported CLI. | Get started instantly. |

Use “CLI” freely for this audience. Use provider names in full on first mention. Keep sentences short; avoid “seamless,” “revolutionary,” “all-in-one,” and unsupported performance or productivity claims.

## Product imagery and comparisons

Use real, current desktop captures with synthetic repositories and sessions. Show project/session navigation, a conversation with tool calls, and a useful diff or terminal. Exclude personal paths, account details, credentials, and real client code. Label fabricated conversation content as demonstration data.

The launch images in this suite are typographic brand assets, not screenshots. The product screenshot remains a shipping task.

Lead public copy with cw-code's actual behavior. The documented design references are T3 Code for project/session organization, VS Code for configurable work regions, and Rider for interface discipline. These are design references, not claims of compatibility or feature parity. Detailed competitor comparisons require a dated check of the relevant product versions before publication.

Do not imply that cw-code includes a model subscription, offers unlimited usage, works offline for inference, or keeps model traffic entirely on the device. Do not promise full rendering of every native CLI interaction. Use the terminal fallback where supported.

## Scope and visual authority

This is an extension of the current identity for brand artifacts. It does not replace the desktop layout, theme, UI typography, or existing design tokens. `apps/desktop/DESIGN.md` still describes older blue-graphite colors and Segoe-first typography; reconcile that documentation with current code as a separate shipping task. Console C is now integrated into the desktop and packaging configuration. This does not establish a published installer release.
