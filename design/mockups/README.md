# cw-code visual design study

Open `index.html` to compare three populated desktop mockups. Each page is standalone, uses no network assets, and includes small interactive controls for density and panel visibility.

## Shared conclusions

- Preserve the current left sessions / center thread / right workspace structure.
- Make a roughly 110–115% scale the product default instead of relying on Chromium zoom.
- Use sans-serif for navigation and conversation; reserve monospace for code, paths, commands, branches, and telemetry.
- Create hierarchy with distinct surfaces first, one-pixel separators second, and accent color only where it communicates selection or state.
- Keep provider colors as identity cues. Use blue/teal for focus and primary actions; reserve green, yellow, and red for semantic status.
- Treat the right pane as a contextual workspace that can collapse, not a permanently equal competitor to the conversation.
- Give every interactive row a minimum 36px hit target, visible hover state, and a two-pixel keyboard focus treatment.

## Why 100% currently feels too small

The zoom observation maps directly to the current renderer CSS. `theme.css` starts from a 13px monospace body, then reduces many controls and metadata labels to 10.5–12.5px. The title bar is 36px, the sidebar is 264px, the main reading column is 720px, and many navigation rows are around 30px tall. Chromium zoom enlarges all of those fixed pixel values together, which is why one zoom step feels like a coherent improvement while changing the root font alone would not.

The first production pass should introduce a real density layer rather than baking in more one-off numbers:

| Role | Comfortable default | Compact option |
| --- | --- | --- |
| UI body | 14px / 20px | 13px / 18px |
| Conversation prose | 15px / 24px | 14px / 22px |
| Code and terminal | 13.5px / 21px | 12.5px / 19px |
| Metadata | 12px / 17px | 11px / 16px |
| Pane header | 44–48px | 38–42px |
| Navigation row | 38–42px | 32–36px |
| Standard control | 36px minimum | 32px minimum |
| Icon | 16–18px | 14–16px |
| Reading measure | 800–860px | 720–780px |

Suggested surface tokens for the first implementation slice:

```css
--chrome: #17191d;
--workspace: #1b1e23;
--panel: #20242a;
--raised: #272c34;
--hover: #2d343e;
--selected: #2c414f;
--border: #343b45;
--text: #eef1f5;
--text-secondary: #bcc4cf;
--text-muted: #7f8996;
--focus: #66a9d7;
--success: #5dcc7a;
--warning: #e5b454;
--danger: #ec7078;
```

## Concepts

| Concept | Best quality | Main tradeoff | Recommendation |
| --- | --- | --- | --- |
| Rider Focus | Strongest pane separation, palette, and professional IDE character | Can become toolbar-heavy if every action stays visible | Use as the visual-system baseline |
| T3 Conversation | Best reading flow and strongest agent-first identity | Progressive disclosure can hide operational detail | Borrow its thread and composer treatment |
| VS Code Workbench | Best tooling discoverability and persistent status | Risks feeling generic or overly busy | Borrow its activity rail and bottom-panel behavior selectively |

## Panel studies

- `subagents-panel.html` — three variations of the Subagents right-pane panel (A drill-in detail, B accordion stack, C split list + detail). Shows preview-first prompt/result, tool calls nested inside the agent, and running/completed status sourced from structured stream events. Pick one before implementing the panel rework.
- `usage-panel.html`: Usage view study. A is the full view: per-harness plan-limit cards, then the cw-code token ledger with a combined per-day chart and a tokens-by-model chart. B is every degraded or limit state. C is the context-window ring in the composer and the dock it opens (context, session totals, plan limits, link to the Usage view). Use the "Show data sources" toggle to see which CLI field feeds each element. Open a variant directly with `#a`, `#b` or `#c`.

## Recommended synthesis

Start from Rider Focus, use T3 Conversation's centered thread and composer, and adopt the Workbench concept's clear status bar plus optional bottom terminal. Keep the existing app structure and backend contracts unchanged.

This recommendation follows the strongest parts of the references rather than copying any one product. Rider's Islands theme explicitly uses differentiated tool-window surfaces to improve editor focus. T3 Code demonstrates a quiet conversation canvas with contextual tooling. VS Code formalizes distinct responsibilities for the activity bar, primary sidebar, editor surface, secondary sidebar, panel, and status bar.

## Implementation sequence

1. Introduce semantic theme and density tokens in `theme.css` without changing component behavior.
2. Ship Comfortable as the default density and retain Compact as a preference.
3. Replace blanket monospace usage with UI/prose and technical font roles.
4. Normalize pane headers, session rows, buttons, icons, and focus states.
5. Rework the center thread and composer hierarchy.
6. Consolidate the right pane into a labelled, collapsible inspector.
7. Consolidate usage, provider, branch, and turn state into one status surface.
8. Add layout persistence and test 1440×900, 1920×1080, 125% OS scale, keyboard focus, and high-contrast conditions.

Likely production touch points: `apps/desktop/src/renderer/src/theme.css` first; then `Sidebar.tsx`, `ThreadView.tsx`, `ComposerView.tsx`, `App.tsx`, and the right-pane components. The CLI drivers, session orchestration, preload bridge, and contracts do not need to change for the visual pass shown here.

## Reference material

- [JetBrains Rider UI themes](https://www.jetbrains.com/help/rider/User_interface_themes.html)
- [JetBrains Rider interface and tool windows](https://www.jetbrains.com/help/rider/Guided_Tour_Around_the_User_Interface.html?section=Windows+or+Linux)
- [JetBrains Rider Islands theme introduction](https://www.jetbrains.com/rider/whatsnew/2025-3/)
- [T3 Code introduction](https://pingdotgg-t3code.mintlify.app/introduction)
- [VS Code UX architecture](https://code.visualstudio.com/api/ux-guidelines/overview)
- [VS Code custom layout](https://code.visualstudio.com/docs/configure/custom-layout)
