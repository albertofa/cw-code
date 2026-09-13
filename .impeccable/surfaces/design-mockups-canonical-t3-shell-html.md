---
version: 1
slug: "design-mockups-canonical-t3-shell-html"
primary_target: "design/mockups/canonical-t3-shell.html"
related_targets: []
---

## Direction contract

**THESIS:** Keep cw-code’s proven T3-like three-region workspace, but give it a visual identity led by Rider rather than copying T3’s flat near-black treatment. Preserve project-grouped sessions, the conversation stage, and the contextual tool workspace; refuse new navigation metaphors, dashboard layouts, decorative card grids, and separator-heavy chrome.

**OWN-WORLD:** Rider is the primary visual authority: stepped graphite panels, a subtly colored top chrome, softly inset work regions, crisp active tabs, and disciplined cyan, violet, green, amber, and coral accents. T3 contributes information hierarchy and conversation composition; VS Code contributes tool density and docking behavior. ZCode and OpenCode contribute input-local controls and a calmer command surface; DeepSeek Harness contributes an inspectable event-ledger model for agent work. Segoe UI Variable carries navigation and prose at a visibly larger default scale; monospace is limited to code, paths, commands, and telemetry. Separation comes from tonal depth, narrow gutters, and active fills. Borders appear only where interaction or focus genuinely needs an edge.

**STORY:** The developer scans several projects and sessions, sees running and waiting work immediately, opens one conversation, then reveals Files, Diff, Agents, or Terminal in the right workspace without losing context. Messages read as a continuous coding work log rather than chat: no speaker names, avatars, or resting timestamps; timestamp and copy appear on hover. The workspace can be resized, collapsed, or split like an IDE. Settings opens as a large focused configuration window above the inert workbench, so the project/session sidebar is not part of the settings layout.

**FIRST VIEWPORT:** At 1920×1080, a roughly 296px session sidebar sits left, a fluid conversation owns the center, and a roughly 500px contextual workspace sits right when expanded. A 42–44px title bar, 38–42px rows, 14–15px UI text, and a restrained thread width provide the requested zoomed-in comfort. The conversation canvas is the darkest, calmest surface and uses fewer accents than the navigation/tool panes. Most global and tool actions are icon-only with tooltips; project names, session names, file names, and states remain textual. The composer is one cohesive containment field with one focus state and one send/stop locus. Its writing and next-turn configuration zones are distinguished through internal placement, density, shape, and restrained tonal depth—never detached gaps or separator rules. It carries only attachments/context, model, effort, permission, and send/stop. Git branch and worktree context live in the conversation header beside the session title. The same system extends into a provider-focused Settings overlay and an Agents workspace with a compact roster above a full-width selected-agent inspector.

**FORM:** Category-standard T3/IDE workspace executed at full fidelity; standing canon selected after rejecting the speculative direction round. Seed key `f827ee73`, kind `canon`.

**FINISH:** unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance
