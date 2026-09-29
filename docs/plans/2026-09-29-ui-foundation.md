# Plan: UI foundation (redesign phase 1)

**Goal:** move the renderer onto the redesign's foundation: the ink palette, one selection style, the T3 Code type scale with configurable fonts, distinct form controls, richer markdown, and a small motion system. Layout and topology do not change in this phase.

**Constraints:**
- Visual reference: `design-plans/mockups/cw-code-redesign.html`. Open it in a browser. Screens 1, 8 (Settings · Appearance), 10 (States) and 11 (System) show every value used below. When this plan and the mockup disagree, this plan wins.
- Keep today's composer geometry exactly: `.composer` max-width `var(--composer-max)` (880px), min-height 156px, `.composer-writing` padding `20px 24px 4px`, `.composer-recipe-row` min-height 52px with gap 8px, recipe controls 34px tall, send and stop buttons 40px. Only colours and font sizes change.
- Keep the harness icons from `DriverIcon.tsx` unchanged.
- Provider colours `--claude`, `--opencode` and `--codex` stay exactly as they are. They identify the harness and are never used as a selection or accent colour.
- `theme.css` is a single 11.6k-line file. Tasks that edit it run strictly in order: 1 → 2 → 5 → 6 → 7. No two tasks edit it at the same time.
- Settings: adding a field needs no schema bump or migration (`SettingsStore.ts` fills missing keys from `DEFAULT_SETTINGS`). `AppSettings` is declared twice, in `packages/contracts/src/settings.ts` and in `apps/desktop/src/renderer/src/cw.ts`. Both copies must change together (AGENTS.md: keep the four layers in sync).
- Settings apply on the modal's Save, as they do today. The Appearance section's own previews update live from the draft.
- No new npm dependencies. Remove `@fontsource-variable/inter`.
- Tests follow AGENTS.md: unit tests for pure helpers only. UI is verified by typecheck and build.
- Done means `pnpm typecheck`, `pnpm test` and `pnpm build` pass from the repo root. Do not run `pnpm dev`; the user runs the app.

## Task 1: Tokens, palette and one selection style  [independent]

- **Files:** `apps/desktop/src/renderer/src/theme.css`, `apps/desktop/src/renderer/index.html` (background colour only)
- **What:**
  - Replace the colour tokens in `:root` with the values below, and add the new tokens.
  - Replace hard-coded hex and rgba values that duplicate a token with the token. This includes all `#2e3035`, `#1e1f22`, `#393b40`, `#548af7`, `#dfe1e5`, `#868a93` and `#2b2d30` literals, and `rgba(84, 138, 247, …)` → `color-mix(in srgb, var(--accent) N%, transparent)`.
  - Apply one selection treatment everywhere, fix the audit finding on PR detail, and give notification kinds their own tone.
- **Tokens:** set in `:root`, keeping the existing names where listed.
  ```css
  --gutter: #080a0f;          /* window edge, app-shell background */
  --line: #222630;            /* NEW: seams between regions (sidebar/main/right borders, head-seg bottom border) */
  --editor: #101219;          /* thread canvas, main-tabbar */
  --panel-head: #12141c;      /* main column head (.head-seg.main-seg background) */
  --bg: #151820;              /* base */
  --panel: #151820;           /* sidebar, settings nav */
  --tool: #181b24;            /* NEW: right workspace (.right, .right-body, .right-tabbar, .tool-rail, .bottom-tabbar, .pty-wrap) */
  --bg-deep: #151922;         /* wells: code blocks, diff lists, tool cards, tables */
  --card: #1b202b;            /* NEW: cards inside the thread (changes summary, compaction note) */
  --overlay: #1f2330;         /* menus, popovers, hover cards, modals */
  --composer-surface: #242734;
  --user-msg: #232735;        /* NEW: .msg-user bubble */
  --hover: #1d2029;           /* NEW: row hover */
  --raised: #262a36;          /* pressed, segmented "on", buttons */
  --border: #303440;
  --border-soft: #252a36;
  --text: #e9eaf0;
  --dim: #bdc0cc;
  --muted: #8a8fa0;
  --faint: #5f6476;
  --violet: #795cec;
  --violet-strong: #6146d6;
  --violet-ink: #a18cff;      /* NEW: active icons and text */
  --violet-soft: rgba(121, 92, 236, 0.2);   /* NEW: selected fill */
  --violet-line: rgba(161, 140, 255, 0.45); /* NEW: selected outline, focus */
  --success: #59a659;
  --warning: #e8b44f;
  --danger: #e06c60;
  --accent: #548af7;          /* information only: Input status, unseen/new dots, links, question dock */
  --update: #56c2d6;          /* NEW: PR updated since last turn */
  --md-code: #d2c4ff; --md-code-bg: rgba(121, 92, 236, 0.13); --md-code-line: rgba(161, 140, 255, 0.26);
  --md-marker: rgba(161, 140, 255, 0.75); --md-link: #7fa8f8; --md-strong: #f4f4f8;
  --dur-fast: 150ms; --dur-base: 180ms; --ease-out: cubic-bezier(0.22, 1, 0.36, 1);
  ```
  Keep `--claude`, `--opencode`, `--codex`, their `-soft` companions and the `.app-shell[data-driver]` `--driver` remap unchanged. Remove `--periwinkle` if nothing reads it. Otherwise map it to `--violet-ink`.
- **Selection rule.** Every "this item is selected or active" state uses:
  - fill `var(--violet-soft)`;
  - text `var(--text)`;
  - icon `var(--violet-ink)`;
  - list and row items also get a 2px `var(--violet)` mark on their left edge, as `::before` or an inset box-shadow.

  Hover is always the neutral `var(--hover)`, never the selection colour. Apply the rule to each of these:
  - `.session-row.active`, `.working-card` active state, `.side-new-session.active`, `.side-nav.active`, `.side-quick-btn.on`, `.side-filter-btn.filtered`, `.side-footer` button `.active`
  - `.picker-row.active`, `.menu-row.active`, `.menu-check` (now `--violet-ink`), `.tree-row.active`, `.inspect-file.active` (was `--driver`), `.pr-files-file.active`
  - `.pr-inbox-chip.active`, `.usage-chip.on`, `.settings-nav-item.active`, the Skills list selected item, `.settings-prwf-item.active`, `.settings-prwf-cond.on`, `.binary-picker-row` selected, `.wf-run-seg-item.active`
  - **Audit finding:** `.pr-detail-tab.active` (border `var(--claude)` → `var(--violet)`, theme.css:8840-8844) and `.pr-detail-check-item.active` (inset `var(--claude)` → `var(--violet)`, theme.css:9252-9256)

  Segmented controls (`.seg`, `.usage-seg`, `.inspect-mode`) keep the neutral `var(--raised)` "on" state. `.tab.active` keeps its 2px `var(--violet)` underline. `.question-tab.active` and the QuestionDock stay blue, because they carry information.
- **Primary and focus:**
  - `.btn-primary`, `.composer-send` and the PR-detail primary button use the violet gradient `linear-gradient(135deg, var(--violet), var(--violet-strong))`.
  - `:focus-visible` is `outline: 2px solid var(--violet-ink)` with a 2px offset.
  - Field focus borders and the search focus use `var(--violet-line)`.
  - `.settings-switch` checked uses `var(--violet)`.
- **Specific fixes:**
  - `.gh-btn`: drop the blue fill `#243252`, border `#334877` and text `#9db8ff`. Use the neutral chip look (`rgba(255,255,255,0.045)` fill, `var(--dim)` text).
  - ApprovalDock: replace `rgba(255,159,10,…)` with `color-mix(in srgb, var(--warning) N%, transparent)`.
  - Add `.notif.success`, `.notif.warning` and `.notif.error` left borders of `var(--success)`, `var(--warning)` and `var(--danger)`. Today only `.notif.info` has one.
  - `.msg-user` background is `var(--user-msg)`.
  - Region borders (`.side` right, `.right` left, `.head-seg` bottom) use `var(--line)`.
- **Tests:** none (CSS).
- **Done when:** `rg -n "#2e3035|#1e1f22|#393b40|#548af7|#a06bff|#a9c5ff|#cfe0ff|#243252" apps/desktop/src/renderer/src/theme.css` returns nothing, `rg -n "var\(--claude\)" theme.css` shows only provider-identity rules (none under `.pr-detail-`), and `pnpm --filter @cw-code/desktop build` passes.

## Task 2: Type scale and default fonts  [depends on Task 1]

- **Files:** `apps/desktop/src/renderer/src/theme.css`, `apps/desktop/src/renderer/src/main.tsx`, `apps/desktop/package.json` (plus the lockfile via `pnpm remove`), `apps/desktop/src/renderer/src/components/FilePanel.tsx`, `apps/desktop/src/renderer/src/components/Sidebar.tsx` (the inline `fontSize: 11` styles only)
- **What:**
  - Add the type and font tokens.
  - Replace every `font-size: Npx` in `theme.css` with a token, using the mapping below, then apply the role overrides.
  - Set `html { font-size: 16px; }` as the root. It becomes the interface size that Task 3 changes.
  - Remove the Inter import from `main.tsx` and run `pnpm --filter @cw-code/desktop remove @fontsource-variable/inter`. JetBrains Mono stays bundled.
- **Tokens:**
  ```css
  --font-sans-default: "Segoe UI", system-ui, sans-serif;
  --font-mono-default: "JetBrains Mono Variable", "JetBrains Mono", "Cascadia Code", Consolas, monospace;
  --sans: var(--font-sans, var(--font-sans-default));
  --mono: var(--font-mono, var(--font-mono-default));
  --prompt-font: var(--font-prompt, var(--sans));
  --term-font: var(--font-term, var(--mono));
  --t-3xs: 0.625rem; --t-2xs: 0.6875rem; --t-xs: 0.75rem; --t-desc: 0.8125rem; --t-sm: 0.875rem;
  --t-base: 1rem; --t-lg: 1.125rem; --t-xl: 1.25rem; --t-2xl: 1.5rem;
  --fs-code: var(--font-size-code, 14px);
  --fs-prompt: var(--font-size-prompt, 14px);
  --fs-term: var(--font-size-term, var(--fs-code));
  ```
  Also fix the undefined `var(--font-mono, monospace)` at theme.css:5686 → `var(--mono)`, and the raw stack at :6349 → `var(--mono)`.
- **Mapping for `font-size` literals:**

  | Literal | Token |
  | --- | --- |
  | 8–9.5px | keep px (avatar initials, tiny badges) |
  | 10–10.5 | `var(--t-3xs)` |
  | 11 | `var(--t-2xs)` |
  | 11.5–12 | `var(--t-xs)` |
  | 12.5–14.5 | `var(--t-sm)` |
  | 15–16 | `var(--t-base)` |
  | 17–18 | `var(--t-lg)` |
  | 20 | `var(--t-xl)` |
  | 22–24 | `var(--t-2xl)` |

  The same mapping applies to the inline `fontSize: 11` in `FilePanel.tsx:40,314` and `Sidebar.tsx:1123,1199`: move them to a class, or use `var(--t-2xs)`.
- **Role overrides** (after the mapping; the T3 Code scale at a 16px root):
  - **Code surfaces** use `font-size: var(--fs-code)` with `font-family: var(--mono)`:
    - `.md-pre pre` and `.md-pre code` (line-height 1.375)
    - diff lines in `.diff-body`, `.inspect` diff rows and the PrFilesPanel diff (line-height 1.6)
    - the FilePanel editor textarea (line-height 1.6)
    - `.tool-detail pre`
    - the PrDetailView check log pane
  - **Composer:** `.composer-input` uses `font-family: var(--prompt-font); font-size: var(--fs-prompt); line-height: 1.625`.
  - **Messages:** `.msg-user` and `.msg-assistant` use `var(--t-sm)` with line-height 1.625. Markdown headings are handled in Task 6.
  - **Titles:**
    - The session title in `.session-row` uses `var(--t-sm)` at weight 500.
    - Row metadata, status words, ages, `.tab`, recipe menu values, chips and `.side-kbd` use `var(--t-xs)`. For `.side-kbd`, use `font-family: var(--sans)` with `letter-spacing: 0.1em`.
    - `.recipe-control` uses `var(--t-sm)` at weight 400.
  - **Settings:**
    - `.settings-label` uses `var(--t-sm)` at weight 500.
    - `.settings-hint` uses `var(--t-desc)` with line-height 1.45.
    - Settings section `h3` uses `var(--t-sm)` at weight 400, colour `color-mix(in srgb, var(--text) 70%, transparent)`, with no uppercase.
  - **Section and group labels:** remove `text-transform: uppercase` and the wide letter-spacing from sidebar section labels ("WORKING SET"), the settings nav group label ("HARNESSES"), `.agents-head-title`, the PR-detail sidebar `h4`s and the discovered summary. Make them `var(--t-xs)` at weight 500. Uppercase stays only on small tag chips (for example the approval kind chip).
  - **Headlines:**
    - `.newthread-title` uses `var(--t-2xl)` at weight 400 with letter-spacing -0.025em.
    - Page titles (`.usage-view` h1, the PR-detail title) use `var(--t-xl)` at weight 600.
- **Tests:** none (CSS).
- **Done when:** `rg -n "font-size:\s*(1[0-9]|2[0-4])(\.5)?px" apps/desktop/src/renderer/src/theme.css` returns only lines inside `@media` print or preview HTML (`Markdown.tsx` `PREVIEW_CSS` is out of scope), `rg -n "fontsource-variable/inter" apps/desktop` returns nothing, and `pnpm --filter @cw-code/desktop build` passes.

## Task 3: Appearance settings and font picker  [independent]

- **Files:**
  - Contracts and main: `packages/contracts/src/settings.ts`, `apps/desktop/src/main/settings/SettingsStore.ts`, `apps/desktop/src/main/settings/SettingsStore.test.ts`
  - Renderer types and store: `apps/desktop/src/renderer/src/cw.ts`, `apps/desktop/src/renderer/src/stores/appStore.ts`, `apps/desktop/src/renderer/src/App.tsx`
  - New: `apps/desktop/src/renderer/src/appearanceFonts.ts`, `apps/desktop/src/renderer/src/appearanceFonts.test.ts`, `apps/desktop/src/renderer/src/components/FontFamilyPicker.tsx`, `apps/desktop/src/renderer/src/components/AppearanceSettings.tsx`, `apps/desktop/src/renderer/src/components/appearance.css` (imported by `AppearanceSettings.tsx`, so this task never edits `theme.css`)
  - Settings UI: `apps/desktop/src/renderer/src/components/SettingsModal.tsx` (add the nav item and section only)
- **What:**
  - Add nine typography settings, sanitize them, and carry them into the renderer store.
  - Apply them to the document root on load and after Save.
  - Add an "Appearance" item to the settings nav, directly after General. It contains a Typography section:
    - Interface font (picker plus size stepper)
    - Monospace font (picker plus size stepper)
    - an "Advanced" switch in the section header that reveals Prompt font and Terminal font
  - Each row has a reset button and a live preview driven by the draft:
    - the interface row shows a sidebar row plus a message line;
    - the monospace row shows a code block plus a terminal line;
    - the prompt row shows a composer line.
  - The layout and copy follow mockup screen 8.
- **Interfaces:**
  ```ts
  // AppSettings additions (both copies) and DEFAULT_SETTINGS values
  fontFamilySans: string;      // "" = default stack
  fontFamilyMono: string;      // ""
  fontFamilyPrompt: string;    // "" = follow fontFamilySans
  fontFamilyTerminal: string;  // "" = follow fontFamilyMono
  fontSizeInterface: number;   // 16, clamp 12–20, integer
  fontSizeCode: number;        // 14, clamp 10–18
  fontSizePrompt: number;      // 14, clamp 12–20
  fontSizeTerminal: number;    // 14, clamp 8–20
  typographyAdvanced: boolean; // false
  // sanitize: strings trimmed and capped at 200 chars; numbers Math.round + clamp (non-finite → default); boolean `=== true`

  // appearanceFonts.ts
  export type AppearancePrefs = Pick<AppSettings, "fontFamilySans" | "fontFamilyMono" | "fontFamilyPrompt" | "fontFamilyTerminal" | "fontSizeInterface" | "fontSizeCode" | "fontSizePrompt" | "fontSizeTerminal" | "typographyAdvanced">;
  export const DEFAULT_SANS_STACK = '"Segoe UI", system-ui, sans-serif';
  export const DEFAULT_MONO_STACK = '"JetBrains Mono Variable", "JetBrains Mono", "Cascadia Code", Consolas, monospace';
  export const TERMINAL_GLYPH_FALLBACK = '"Symbols Nerd Font Mono", "CaskaydiaCove Nerd Font", "JetBrainsMono Nerd Font"';
  export function cssFontFamilies(input: string): string | null;            // comma list → quoted CSS list; empty → null
  export function resolveTerminalFont(p: AppearancePrefs): { family: string; size: number };
  //   family = (advanced && fontFamilyTerminal ? fontFamilyTerminal : fontFamilyMono) list + ", " + TERMINAL_GLYPH_FALLBACK + ", " + DEFAULT_MONO_STACK
  //   size   = advanced ? fontSizeTerminal : fontSizeCode
  export function applyAppearance(root: HTMLElement, p: AppearancePrefs): void;
  //   sets root.style.fontSize = `${fontSizeInterface}px`;
  //   --font-sans / --font-mono / --font-prompt / --font-term to "<custom>, <default stack>" or removes them when unset;
  //   --font-size-code, --font-size-prompt (advanced ? fontSizePrompt : 14), --font-size-term
  export function isFontFamilyAvailable(family: string): boolean;          // canvas-width probe vs monospace/serif/sans-serif
  export function isMonospaceFamily(family: string): boolean;              // equal advances for "iMW0@#. " at 16px

  // appStore
  appearance: AppearancePrefs;   // filled in loadProjects and saveSettings next to the existing copied subset
  // App.tsx
  useEffect(() => applyAppearance(document.documentElement, appearance), [appearance]);
  ```
- **Font picker** (`FontFamilyPicker.tsx`, props `{ value: string; defaultLabel: string; requireMonospace?: boolean; onChange(value: string): void }`):
  - On first focus or click, call `window.queryLocalFonts?.()` inside the user gesture. Keep the resulting family list in module state, shared by every picker.
  - When fonts are available, render a button showing the family in its own face (with a "default" tag when the value is `""`). It opens a popover with a search input and a list of families, each rendered in its own face, plus the checked current value.
  - When `requireMonospace` is set, filter the list through `isMonospaceFamily`.
  - When `queryLocalFonts` is missing or rejects, render a text input instead. A typed name only commits when `isFontFamilyAvailable` (and `isMonospaceFamily` for mono rows) passes. Otherwise show "Not installed on this device" in `var(--danger)` below the input.
  - Electron 36 has no permission handler in main, so the default grant applies. Only if `queryLocalFonts` is denied at runtime, add `session.setPermissionRequestHandler` and `setPermissionCheckHandler` on the window's own session (not only `defaultSession`, because of the dev partition). They allow `"local-fonts"` and pass every other permission through unchanged.
- **Tests:**
  - `appearanceFonts.test.ts`: `cssFontFamilies` (quoting, trimming, empty) and `resolveTerminalFont` (simple mode follows mono and code size; advanced mode uses the terminal values).
  - `SettingsStore.test.ts`: clamping and defaults for the new fields.
- **Done when:** `pnpm test` passes the new tests, `pnpm typecheck` passes, and Settings shows an Appearance item with the Typography section.

## Task 4: Terminal follows the monospace setting  [depends on Task 3]

- **Files:**
  - Delete: `apps/desktop/src/main/pty/terminalFont.ts` and `apps/desktop/src/main/pty/terminalFont.test.ts`
  - IPC layers: `apps/desktop/src/main/index.ts`, `apps/desktop/src/preload/index.ts`, `apps/desktop/src/renderer/src/cw.ts`
  - Renderer: `apps/desktop/src/renderer/src/components/PtyTab.tsx`
- **What:**
  - Remove the Windows Terminal font lookup from all layers: the `term.font` handler at index.ts:913 and its import at :35, preload `getTerminalFont` at :163 and :352, and the `cw.ts` type at :620.
  - `PtyTab` reads `appearance` from the app store. It creates the terminal with `resolveTerminalFont(appearance)` for family and size, replacing `TERMINAL_FONT_STACK` and the literal 13.
  - A separate effect keyed on the resolved family and size sets `term.options.fontFamily` and `term.options.fontSize` on the live terminal, then refits.
- **Interfaces:** consumes `resolveTerminalFont` and `appStore.appearance` from Task 3.
- **Tests:** none new. Delete the removed module's test.
- **Done when:** `rg -n "term\.font|getTerminalFont|readWindowsTerminalFontFace" apps` returns nothing and `pnpm typecheck && pnpm test` pass.

## Task 5: Form controls  [depends on Tasks 2 and 3]

- **Files:** `apps/desktop/src/renderer/src/theme.css`, `apps/desktop/src/renderer/src/components/SettingsModal.tsx`, `apps/desktop/src/renderer/src/components/UpdatesSettings.tsx`, `apps/desktop/src/renderer/src/components/BinaryPicker.tsx`, `apps/desktop/src/renderer/src/components/QuestionDock.tsx`
- **What:** one control vocabulary.
  - **Checkbox** (pick many): 16px square, radius 4px.
    - Off: `#1d2029` fill with an inset 1.5px `#5d6378` outline.
    - Hover: outline `var(--muted)`.
    - On: `var(--violet)` fill with a white 12px check. Mixed: a white 8×2px dash.
    - Disabled: opacity 0.4.
  - **Radio** (pick one): 16px circle with the same off state. On: 1.5px `var(--violet-ink)` ring with an 8px `var(--violet-ink)` dot.
  - **Switch** (a setting on or off), restyling `.settings-switch`:
    - Track: 34×20px, radius 10px.
    - Off: `#2a2e3b` with an inset 1.5px `#4a4f62` outline and a 14px `#9da1a8` knob.
    - On: `var(--violet)` with a white knob.
    - Transition: 150ms on the knob position.
  - Style native `input[type="checkbox"]` and `input[type="radio"]` globally with `appearance: none` and the visuals above, so markup and accessibility stay native. `.settings-switch input` keeps its current hidden-input pattern.
  - Convert the settings rows that use a bare `.settings-toggle` checkbox to the `.settings-switch` markup. These are SettingsModal.tsx:544, :582, :595, :632 and :820, and UpdatesSettings.tsx:163.
  - The model list (`.settings-check`, SettingsModal.tsx:468) stays a checkbox.
  - BinaryPicker radios (:340, :380, :414) use the radio style and drop `accent-color`.
  - QuestionDock replaces the text pseudo-controls with `span` visuals using the same classes: `[ ✓ ]` in `.question-cell` at :196, :208 and :222, and ✓/○ in `.question-tab-box` at :272. Use a radio look when `q.multiSelect` is false and a checkbox look when it is true. Inside the question dock the "on" colour is `var(--accent)`, to match the dock.
- **Tests:** none (UI).
- **Done when:** `rg -n "settings-toggle" apps/desktop/src/renderer/src/components` returns nothing, `rg -n "\[ ✓ \]|○" QuestionDock.tsx` returns nothing, and `pnpm typecheck && pnpm --filter @cw-code/desktop build` pass.

## Task 6: Markdown  [depends on Task 5]

- **Files:**
  - Markdown: `apps/desktop/src/renderer/src/components/Markdown.tsx`, `apps/desktop/src/renderer/src/theme.css`
  - New helpers: `apps/desktop/src/renderer/src/components/markdownAlerts.ts`, `apps/desktop/src/renderer/src/components/markdownAlerts.test.ts`, `apps/desktop/src/renderer/src/components/markdownPaths.ts`, `apps/desktop/src/renderer/src/components/markdownPaths.test.ts`
  - File reveal: `apps/desktop/src/renderer/src/stores/panelStore.ts`, `apps/desktop/src/renderer/src/components/FilePanel.tsx`, `apps/desktop/src/renderer/src/components/ThreadView.tsx`
- **What:**
  - **Inline code:** mono at 0.86em and weight 500, colour `var(--md-code)` on `var(--md-code-bg)`, with an inset 1px `var(--md-code-line)` ring, radius 0.4em and padding `0.12em 0.4em`.
  - **File chips:** inline code whose text passes `parseFilePath` renders as a chip: `inline-flex`, height 1.5em, radius 0.5em, padding `0 0.5em`, fill `rgba(255,255,255,0.045)`, inset 1px `var(--border)`, font `var(--sans)` `var(--t-xs)` at weight 500. It shows a FileIcon, the basename and an optional faint mono `:line`, with the full path as its title.
    - Clicking calls a new `onOpenSource(path, line)` prop.
    - `ThreadView` passes `(path) => usePanelStore.getState().revealFile(sessionId, path)`.
    - The existing `.html` chip (`HtmlFileChip`) is unchanged.
  - **Headings, lists, quotes and links:**
    - h1 / h2 / h3 / h4 at 1.25 / 1.125 / 1 / 0.875rem, weight 600, line-height 1.3, margin `1.25rem 0 0.5rem`.
    - p, ul, ol, blockquote, `.md-pre` and `.md-table-wrap`: margin `0.65rem 0`. `li + li`: margin-top 0.25rem.
    - List markers `var(--md-marker)`; ordered numbers `var(--muted)`, weight 600, tabular.
    - `strong` is `var(--md-strong)` at 600.
    - Links are `var(--md-link)` with no underline, and a dotted underline on hover.
    - Blockquote: 2px `var(--border)` left border, `var(--muted)` text.
    - Tables sit in a radius-10px `var(--bg-deep)` wrapper with a `var(--border-soft)` ring. Font is `var(--t-xs)`; header cells are weight 600, `var(--muted)`, on `rgba(255,255,255,0.025)`; rows are separated by a 1px `rgba(255,255,255,0.05)` line.
  - **GitHub alerts:** a `blockquote` override checks the first paragraph with `parseAlertMarker`. For NOTE, TIP, IMPORTANT, WARNING and CAUTION it renders `div.md-alert.<kind>`: a header with icon and label, then the rest of the content.
    - Style: radius 10px, an inset 2px left bar in the tone colour and a tinted fill.
    - Tones: note and tip `var(--md-link)`; important `var(--violet-ink)`; warning `var(--warning)`; caution `var(--danger)`.
  - **Code blocks:** `Pre` gets a 34px header bar with a file-code icon, the language from `className="language-x"` in faint mono, and on the right a wrap toggle (`pre-wrap` on or off) and the existing copy button (always visible, no longer hover-only). The body keeps its `var(--bg-deep)` background with a `var(--border-soft)` ring and 12px radius.
- **Interfaces:**
  ```ts
  // markdownPaths.ts
  export interface FileRef { path: string; line?: number; endLine?: number }
  export function parseFilePath(text: string): FileRef | null;
  //   accepts: no whitespace; not a URL (no "://"); last segment has an extension of 1–8 alphanumerics;
  //   optional ":<line>" or ":<line>-<endLine>" suffix; rejects pure versions like "1.2.3" or "v2.1.0",
  //   CSS custom properties ("--violet"), and flags ("--verbose")
  // markdownAlerts.ts
  export type AlertKind = "note" | "tip" | "important" | "warning" | "caution";
  export function parseAlertMarker(firstLine: string): { kind: AlertKind; rest: string } | null; // "[!NOTE] text" → { kind: "note", rest: "text" }, case-insensitive
  // panelStore
  revealRequest: { sessionId: string; path: string; line?: number; nonce: number } | null;
  revealFile(sessionId: string, path: string, line?: number): void; // sets revealRequest (nonce+1) and calls activateOrOpen(sessionId, "files")
  // FilePanel: when revealRequest.sessionId matches, call its existing open(path) once per nonce.
  ```
- **Tests:**
  - `markdownPaths.test.ts`: accepted and rejected examples, taken from the rules above.
  - `markdownAlerts.test.ts`: every kind, lower case, no marker, marker with trailing text.
- **Done when:** `pnpm test` passes the new tests, the existing `Markdown.render.test.tsx` still passes, and `pnpm --filter @cw-code/desktop build` passes.

## Task 7: Motion  [depends on Task 6]

- **Files:** `apps/desktop/src/renderer/src/theme.css`, `apps/desktop/src/renderer/src/components/TurnBlock.tsx`, `apps/desktop/src/renderer/src/components/ReasoningBlock.tsx`, `apps/desktop/src/renderer/src/components/ToolCard.tsx`, `apps/desktop/src/renderer/src/components/ToolGroupCard.tsx`
- **What:** the "moves / snaps" rules from mockup screen 11.
  - **Popups enter:** add `@keyframes cw-pop-in` (from `opacity: 0; transform: translateY(4px) scale(0.98)`) using `var(--dur-fast) var(--ease-out)`. Apply it to:
    - `.menu-panel`, with the from-translate flipped to -4px for `.menu-panel-down`
    - `.picker-panel`, `.ctx-menu`, `.session-hovercard`
    - the context-ring popover (`.context-dock`)
    - `.attach-picker`, `.slash-menu`, `.gh-menu`, `.notif`
  - **Modals enter:** add `@keyframes cw-modal-in` (from `opacity: 0; transform: scale(0.98)`, 180ms `var(--ease-out)`). Apply it to `.settings-modal`, `.skills-modal`, `.wf-run-modal` and `.confirm-card`, and give the backdrops an 180ms opacity fade.
  - **No exit animations:** close stays instant, which matches today's conditional rendering.
  - **Collapses:**
    - Turn detail, reasoning and tool detail use one ChevronRight rotated 90deg when open (`transition: transform var(--dur-base) var(--ease-out)`), replacing the swapped ChevronRight/ChevronDown icons.
    - Revealed content fades in with `@keyframes cw-reveal` (from `opacity: 0; transform: translateY(-2px)`, `var(--dur-fast)`).
    - No height animation.
  - **Hover-revealed actions** (message meta copy button, tab close ×, row actions) fade their opacity over `var(--dur-fast)`. Hover backgrounds, tab and nav activation, and route or page changes stay instant. Remove any background-colour transition on rows.
  - **Live indicators:**
    - Replace the smooth `pulse` on status dots with a stepped duty cycle: `@keyframes cw-status-pulse` holds 0–40% at opacity 1 and 50–90% at 0.5, with `steps(6)` ramps, over 2s.
    - Change `turn-text-sweep` and `tool-sweep` to `steps(30)` timing.
    - Nothing in the sidebar shimmers.
  - **Reduced motion:** extend the global `prefers-reduced-motion` block (theme.css:5909) so it also sets `transition-duration: 0.01ms !important`. Confirm the new keyframes fall under it.
- **Tests:** none (CSS and UI).
- **Done when:** `pnpm --filter @cw-code/desktop build` passes, and `rg -n "cw-pop-in|cw-modal-in|cw-reveal|cw-status-pulse" theme.css` shows the four keyframes and their users.

## Task 8: Copy fixes  [independent]

- **Files:** `apps/desktop/src/renderer/src/components/ThreadView.tsx`, `apps/desktop/src/renderer/src/components/GitInspectPanel.tsx`
- **What:**
  - In the pending-session breadcrumb, change both "New thread" strings (ThreadView.tsx:267 title, :268 `<strong>`) to "New session", matching the sidebar button.
  - Change the Git diff panel header "Inspect" (GitInspectPanel.tsx:114) to "Git diff", matching its tab title in `toolTabs.ts:16`, the same way the Subagents panel header matches its tab.
- **Tests:** none.
- **Done when:** `rg -n "New thread|> Inspect<" apps/desktop/src/renderer/src/components` returns nothing.

## Order

- **Wave A (parallel):** Tasks 1, 3 and 8.
- **Wave B (parallel):** Task 2 (after 1) and Task 4 (after 3).
- **Wave C, in order:** Task 5, then Task 6, then Task 7.
- **Checkpoint:** full `pnpm typecheck && pnpm test && pnpm build`, plus screenshots of the running app for the user. Phase 2 (sidebar, tool rail, settings page, pickers, PR inbox, diff scopes, undo, taskbar badge) is planned after this checkpoint.
