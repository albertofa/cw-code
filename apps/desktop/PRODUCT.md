# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Developers who work across multiple repositories and keep several AI-assisted CLI sessions active in parallel. They need to move quickly between projects, understand which sessions are working or waiting, inspect changes, and intervene without losing CLI context.

## Product Purpose

cw-code is a desktop workspace for running and supervising real Claude Code, OpenCode, and Codex CLI sessions. Success means a developer can operate many sessions across many projects from one window, resume the CLI's full context reliably, and inspect the resulting files, diffs, agents, and terminals without juggling separate shells.

## Positioning

The application is a visual desktop shell over the user's installed CLI binaries and subscriptions. The CLI remains the source of truth for inference and session continuation; cw-code adds organization, routing, inspection, and interaction without replacing the CLIs with SDK or AI-API calls.

## Operating Context

- Multi-project, multi-session work is the primary use case rather than an edge case.
- One turn may be active per session, while different sessions can run concurrently.
- Developers switch between session conversation, file inspection, diffs, agents, and real interactive terminal tabs.
- Session and supporting tool regions should be semi-customizable. Developers may keep information visible, move it, resize it, hide it, or bring it forward as their workflow requires.
- CLI-native sessions are discovered separately and enter the managed workspace only through explicit import.

## Capabilities and Constraints

- Preserve project-grouped sessions, session status, active-turn isolation, provider choice, resumable CLI context, file editor, git diff, agents, usage/cost information, and embedded interactive terminals.
- The Electron main/preload/renderer boundary remains typed; the renderer does not spawn processes or access the filesystem directly.
- CLI behavior stays behind the `CliDriver` seam.
- The application persists its own project, title, layout, and resume metadata; it does not treat parsed CLI-internal files as authoritative.
- Native-backed features must load lazily and degrade visibly.
- The redesign is currently explored as standalone HTML mockups. It must remain feasible in the existing Electron and React renderer.

## Brand Commitments

- Keep the product name `cw-code`.
- Structural and usability behavior should be heavily inspired by T3 Code because both products solve similar project-and-session orchestration problems.
- Preserve cw-code's current three-region shell: project-grouped sessions on the left, the active conversation in the center, and a contextual tool workspace on the right. Design variations may change emphasis, density, and whether the tool workspace is expanded, collapsed, or split, but must not replace this topology with a new navigation metaphor.
- VS Code is a reference for user-controlled, movable, resizable, and hideable work regions.
- JetBrains Rider remains a reference for a dark interface with clear surface distinction and disciplined accent color.

## Evidence on Hand

- The current renderer implementation and theme live under `apps/desktop/src/renderer/`.
- User-supplied reference captures of T3 Code, JetBrains Rider, and VS Code live under `.cw/pastes/`.
- The rejected first-round mockups live under `design/mockups/` and are anti-reference evidence: they repeated one three-column structure, used too much explanatory text, and relied excessively on borders and divider lines.
- No external customer claims, usage metrics, or brand assets are established and none should be invented.

## Product Principles

- Make concurrent work legible: project, session, active state, and waiting state must be understandable at a glance.
- Let the developer compose the workspace around the current task instead of enforcing one permanent panel arrangement.
- Keep conversation primary while making operational evidence immediately reachable.
- Use structure, spatial grouping, scale, and behavior before decorative containers or divider lines.
- Preserve CLI truth and explicit user control over imports, worktrees, mutations, and layout.
