---
name: cw-code
description: A Rider Violet desktop shell for supervising parallel CLI coding sessions.
colors:
  bg: "#101826"
  bg-deep: "#09121f"
  raised: "#182132"
  overlay: "#1c2638"
  gutter: "#080f1b"
  border: "#303a50"
  border-soft: "#222d40"
  text: "#f2f1f8"
  dim: "#c8ccdc"
  muted: "#9ca4bd"
  faint: "#747d99"
  violet: "#7c43ff"
  violet-strong: "#5b27e6"
  violet-soft: "rgba(124, 67, 255, 0.16)"
  claude: "#e8835a"
  opencode: "#5ab8ff"
  codex: "#b49cff"
  success: "#25d6b3"
  warning: "#f5b84b"
  danger: "#ff657a"
  composer-surface: "#181f32"
  composer-surface-focus: "#1b2338"
  composer-muted: "#aeb4d5"
  composer-faint: "#78819f"
typography:
  display:
    fontFamily: "Segoe UI Variable, Inter, system-ui, -apple-system, Segoe UI, sans-serif"
    fontSize: "22px"
    fontWeight: 500
  headline:
    fontFamily: "Segoe UI Variable, Inter, system-ui, -apple-system, Segoe UI, sans-serif"
    fontSize: "15.5px"
    lineHeight: 1.4
  title:
    fontFamily: "Segoe UI Variable, Inter, system-ui, -apple-system, Segoe UI, sans-serif"
    fontSize: "14px"
    fontWeight: 700
  body:
    fontFamily: "Segoe UI Variable, Inter, system-ui, -apple-system, Segoe UI, sans-serif"
    fontSize: "14px"
    lineHeight: 1.55
  label:
    fontFamily: "JetBrains Mono, Cascadia Code, ui-monospace, SFMono-Regular, Menlo, Consolas, Liberation Mono, monospace"
    fontSize: "10.5px"
    letterSpacing: "0.05em"
rounded:
  r-sm: "6px"
  r-md: "8px"
  r-lg: "12px"
spacing:
  gutter: "6px"
  control: "8px"
  row: "10px"
  panel: "12px"
  thread: "22px"
components:
  button-default:
    backgroundColor: "transparent"
    textColor: "{colors.dim}"
    rounded: "{rounded.r-md}"
    padding: "6px 10px"
  button-primary:
    backgroundColor: "{colors.violet}"
    textColor: "#fff"
    rounded: "9px"
    size: "40px"
  input-field:
    backgroundColor: "{colors.bg-deep}"
    textColor: "{colors.text}"
    rounded: "{rounded.r-md}"
    padding: "6px 8px"
  nav-session-active:
    backgroundColor: "{colors.violet-soft}"
    textColor: "{colors.text}"
    rounded: "{rounded.r-md}"
    padding: "9px 10px"
  composer-hull:
    backgroundColor: "{colors.composer-surface}"
    rounded: "{rounded.r-lg}"
    width: "min(768px, 100%)"
    height: "156px"
---

# Design System: cw-code

## Overview

**Creative North Star: "Rider Violet Run Recipe"**

cw-code is a dense, calm operational workbench: Rider-led blue-graphite surfaces give the project rail, conversation stage, and contextual tools distinct depth without turning the window into a field of cards. The conversation remains the quietest and darkest region; violet is the deliberate control color that connects active navigation, focus, and the turn composer.

The Run Recipe structure makes each turn feel executable rather than conversational. Its Integrated Hull keeps writing, attachments, model, effort, permission, and one send-or-stop locus in one cohesive field. Provider colors, green, amber, and coral carry factual operational states; they are not decorative brand washes.

Confirmed rejections: dashboard navigation, decorative card grids, persistent separator-heavy chrome, detached composer controls, speaker avatars, and resting chat timestamps.

**Key Characteristics:**

- Stepped graphite depth and narrow gutters instead of pervasive borders.
- Comfortably zoomed IDE density: readable 14–15px UI text with compact 38–48px chrome.
- Violet is scarce, structurally meaningful, and strongest at active or focused controls.
- Monospace is reserved for code, paths, commands, and telemetry.

## Colors

The palette is a cool Rider blue-black foundation with a controlled electric-violet control plane and clear, provider-aware status signals.

### Primary

- **Run Violet:** the shared active-navigation, composer-send, and focus color. Its darker companion carries the send gradient; its translucent companion marks selected rows and open controls.

### Secondary

- **Claude Ember, OpenCode Sky, and Codex Lilac:** provider identity colors used for driver dots, icons, harness choices, and the current driver—not as general interface accents.

### Tertiary

- **Clear Teal, Signal Amber, and Fault Coral:** success, input-required/warning, and error or destructive states. Use them for live status, diff metrics, and approval/error treatments.

### Neutral

- **Workbench Blue-Graphite:** `bg`, `bg-deep`, `raised`, `overlay`, and `gutter` create the stepped shell, deepest conversation canvas, hover plane, floating surfaces, and inter-region trough.
- **Cool Ink Ladder:** `text`, `dim`, `muted`, and `faint` set the reading hierarchy from primary content through metadata and telemetry.
- **Structural Slate:** `border` and `border-soft` appear only where a field, popover, code block, file list, or expanded detail needs a true edge.
- **Composer Ink:** the composer-specific surface and text tokens keep the Run Recipe hull visibly integrated but separate from the thread canvas.

### Named Rules

**The Violet Means Action Rule.** Violet identifies active navigation, a set control, focus, or the one turn-launching button; routine content and idle containers stay blue-graphite.

**The Provider Is Data Rule.** Claude Ember, OpenCode Sky, and Codex Lilac identify the selected or reported CLI provider only. Do not repurpose them as generic button colors.

## Typography

**Display Font:** Segoe UI Variable, with Inter, system UI, and Segoe UI fallbacks.

**Body Font:** Segoe UI Variable, with Inter, system UI, and Segoe UI fallbacks.

**Label/Mono Font:** JetBrains Mono, with Cascadia Code and system monospace fallbacks.

**Character:** Larger, legible system sans carries navigation, messages, settings, and prose. Mono is a precise operational annotation layer for code, paths, command output, and compact labels.

### Hierarchy

- **Display** (500, 22px): centered new-thread heading only.
- **Headline** (regular, 15.5px, 1.4): rendered Markdown second-level heading.
- **Title** (700, 14px): settings labels and compact operational titles.
- **Body** (regular, 14px, 1.55): base UI, user messages, and reading content; assistant messages use 14.5px at 1.65 for a calm reading cadence.
- **Label** (10.5px, 0.05em): uppercase project and settings group labels; mono supports small telemetry, paths, and inspect controls.

### Named Rules

**The Mono Is Evidence Rule.** Use the mono face for machine-adjacent information, never as the default for navigation or human-readable conversation.

## Layout

The shell is a three-region desktop workspace inside a 42px title bar: a 296px project-and-session rail, a fluid conversation column, and a 480px contextual right workspace. Regions use 6px gutters, 8px outer body padding, and 10px rounded clipping; the conversation’s inner reading measure is capped at 720px with 22px side padding.

The right workspace is user-resizable, hideable, and can split into two stacked panes. Its tab bar is 48px high; Files, Diff, Agents, Shell, and Preview remain tools within the same contextual region. Settings is a focused overlay rather than a fourth permanent workspace: it spans up to 1180px by 820px and replaces the workbench’s attention while open.

At 1380px the rail tightens to 276px; at 1120px it reaches 248px and the recipe controls can wrap. At 900px, the left rail and right workspace hide so the conversation retains the window; at 720px Settings becomes edge-to-edge and its navigation becomes a wrapped horizontal strip.

**The Conversation Stays Quiet Rule.** Keep the conversation canvas the darkest, least accented region. Put Git branch and worktree context in its header, not in the composer or a separate dashboard band.

## Elevation & Depth

Depth is primarily tonal: darkest canvases sit inside raised blue-graphite panels, with narrow gutters establishing region separation. Borders are intentionally sparse. Shadows are reserved for floating menus, modals, dragged sessions, notifications, attachment pickers, and the composer hull; focus gives the composer a tight violet contour plus a slightly deeper lift.

### Shadow Vocabulary

- **Floating panel:** `0 16px 40px rgba(0, 0, 0, 0.5)` for menus and pickers above the workbench.
- **Composer resting:** `0 14px 36px rgba(2, 5, 12, 0.48)` for the integrated Run Recipe hull.
- **Composer focused:** `0 0 0 1px rgba(158, 116, 255, 0.72), 0 16px 42px rgba(2, 5, 12, 0.58)` for the single active writing state.
- **Modal:** `0 28px 90px rgba(0, 0, 0, 0.62)` for the settings overlay.

### Named Rules

**The Edge Earns Its Place Rule.** Use a border for focus, text entry, popovers, code/data boundaries, or expanded disclosure content—not to divide every resting surface.

## Shapes

The system uses soft technical corners: 6px for small controls, 8px for fields, list rows, and utility surfaces, and 12px for menus, message bubbles, composer, and modal shells. Active state is normally a tonal fill or narrow underline/inset, never a heavy outlined pill. Status badges and harness selection may use fully rounded capsules where compact state grouping is useful.

The composer is the signature silhouette: one 12px rounded hull with internal zones distinguished by placement and tonal depth, not a rule or detached sub-card. Panel corners clip their content; tabs remain square enough to read as an IDE strip, using a 2px violet active underline.

## Components

### Buttons

**Quiet utilities with one decisive action.**

- **Shape:** gently curved utility controls (8px); icon controls use 6px corners.
- **Primary:** general primary buttons follow the current driver; the turn action is a 40px, 9px-corner violet-to-deep-violet send button.
- **Hover / Focus:** utilities lift onto `raised`; send brightens and rises 1px. Keyboard focus uses a 2px lilac outline with 2px offset.
- **Secondary / Ghost:** standard buttons are transparent with a structural slate border; menus, tabs, and icon tools are borderless at rest and gain a raised or violet-soft fill on interaction.

### Chips

**Attachment evidence, not tag decoration.**

- **Style:** attachment chips use a deep translucent background, 8px corners, compact 3px × 6px padding, and optional circular 26px thumbnail.
- **State:** chips stay quiet until their remove control is hovered; provider and model selections use their own purposeful pills or menu state.

### Cards / Containers

**Tonal work regions rather than a card grid.**

- **Corner Style:** 8px for tool cards, rows, and internal documents; 10–12px for larger panel and composer containers.
- **Background:** tool details and code sit in `bg-deep`; hover rises toward `raised`; popovers use `overlay`.
- **Shadow Strategy:** resting in-flow containers are flat; only floating or composer surfaces use the depth vocabulary.
- **Border:** none by default; soft slate boundaries support details, code, diff lists, and fields.
- **Internal Padding:** compact 7–12px rows and details; thread content uses 22px lateral padding.

### Inputs / Fields

**Dark, quiet entry points with exact focus feedback.**

- **Style:** `bg-deep` field, structural slate 1px border, 8px corners, and 6px × 8px padding.
- **Focus:** fields swap their border to the current provider driver; search focus uses violet. The composer takes one hull-wide violet focus contour rather than a local textarea ring.
- **Error / Disabled:** error panels use coral over a faint coral wash; disabled controls lower opacity to 0.4.

### Navigation

**Project-grouped sessions and tool tabs read as an IDE, not a dashboard.**

- Session rows use 9px × 10px padding and an 8px corner. Hover lifts to `raised`; active selection is a left-to-right violet fill. Project headings are compact uppercase labels with count and avatar.
- Right tabs are 12px, borderless items with a 2px violet underline only on the active tab. The panel may be hidden, resized, or split without changing the main shell topology.

### Run Recipe Composer

**The cohesive control hull for an entire next turn.**

- Writing lives in the upper padded zone; attachments/context, model, effort, permission, and send/stop live in the 46px lower recipe row.
- The hull is centered at up to 768px wide, at least 156px tall, and always presents exactly one send-or-stop locus.
- On focus, the full hull changes surface and gains the violet contour; tool sweep motion belongs to active work cards and is disabled with reduced-motion preferences.

## Do's and Don'ts

### Do:

- **Do** preserve the three-region workspace: grouped projects and sessions, conversation, and contextual tools.
- **Do** make state factual with the established provider, success, warning, and danger colors.
- **Do** use tonal layering, narrow gutters, and active fills before adding a divider.
- **Do** keep the composer as one integrated Run Recipe hull with one focus state and one turn action.
- **Do** give tooltips to icon-only global and tool actions while retaining text for names, files, and states.

### Don't:

- **Don't** turn the workbench into dashboard cards, a new navigation metaphor, or a decorative grid.
- **Don't** use violet, provider colors, or status colors as broad decorative washes.
- **Don't** fracture composer controls into detached rows, gaps, or separator-led sub-panels.
- **Don't** add speaker names, avatars, or resting timestamps to the continuous work-log conversation.
- **Don't** blanket every panel and row with borders; an edge must correspond to interaction, focus, or a true content boundary.


## Selected product identity — Console C

The approved logo is Option C, Console C: a cut-corner C and command-line bar,
white on the existing `#7c42ff` violet tile, paired with a lowercase Inter
wordmark. The master is `design/brand/assets/app-icon.svg` at the repository root.
The 22px title-bar icon and 40px About icon use the renderer copy at
`src/renderer/src/assets/console-c.svg`. The runtime and Windows installer use
`resources/icon.ico`; the brand generator synchronizes both copies.

Preserve the existing UI layout and `theme.css` font/color values. This addition
records the selected identity only; the earlier palette and Segoe-first sections
above predate the current graphite/Inter implementation and remain separate
historical documentation drift.
