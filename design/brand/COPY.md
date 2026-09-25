# Ready-to-use copy

## Primary

**Name**<br>
cw-code

**Headline**<br>
Your coding CLIs. One desktop workspace.

**Short description / package metadata**<br>
A desktop workspace for Claude Code, OpenCode, and Codex.

**Repository description**<br>
Open-source Windows desktop workspace for Claude Code, OpenCode, and Codex. Manage sessions, inspect diffs, and use real terminals.

**Website description**<br>
Run Claude Code, OpenCode, and Codex from one Windows desktop app. Organize sessions by project, inspect files and diffs, and open real CLI terminals.

**Full description**<br>
cw-code is an open-source Windows desktop workspace for Claude Code, OpenCode, and Codex. Run sessions across projects, inspect files and Git diffs, and open real CLI terminals. It uses your installed CLIs and their authentication. Each CLI handles inference, model access, and session continuation.

## Website / README opening

# cw-code

A desktop workspace for Claude Code, OpenCode, and Codex.

- Run sessions across projects in one window.
- Read conversations and tool output.
- Inspect files and Git diffs.
- Open real CLI terminals.
- Resume sessions using the CLI's context.

Requires Windows and at least one supported CLI installed and signed in. Provider usage limits and charges depend on your CLI and account configuration.

**Primary link:** Download for Windows<br>
**Secondary link:** View source<br>
**Supporting links:** Installation · Documentation · Releases · Report an issue

Add the actual release link and current alpha label at integration time. Do not show a download action until an installer exists.

## In-app copy

**About heading:** cw-code<br>
**About description:** A desktop workspace for Claude Code, OpenCode, and Codex.<br>
**About details:** Version {version} · MIT License<br>
**About links:** Source code · Releases · Report an issue · Third-party licenses

**First-run heading:** Open a project<br>
**First-run description:** Choose a folder, select a CLI, and start a session.<br>
**First-run action:** Open folder

**CLI prerequisite:** Install and sign in to at least one supported CLI: Claude Code, OpenCode, or Codex.<br>
**Missing CLI:** {CLI} was not found. Install it, then check again.<br>
**Missing CLI action:** Check again

**History limitation:** Some earlier messages could not be displayed. Continuing this session uses the CLI's saved context.

These are integration strings, not new UI requirements. Match existing controls and actual states before applying them; do not show a recovery claim when the resume cursor itself is unavailable.

## Release and distribution

**Installer description:** Desktop workspace for coding CLIs.<br>
**Profile bio:** A desktop workspace for Claude Code, OpenCode, and Codex. Open source. Windows.<br>
**Social alt text:** cw-code. Your coding CLIs. One desktop workspace. Supports Claude Code, OpenCode, and Codex.

**Launch post:**<br>
cw-code is an open-source Windows desktop workspace for Claude Code, OpenCode, and Codex. Run sessions across projects, inspect files and diffs, and open real CLI terminals. Uses your installed CLIs and their authentication.

Append a tested release URL and its release channel when publishing.

**Release-note template:**

```text
cw-code {version}

Added
- {User-visible capability.}

Fixed
- {Trigger and corrected behavior.}

Requirements
- {Tested Windows target and supported CLI versions.}

Known issues
- {Concrete limitation and available workaround.}

Download: {Release URL}
```

Omit empty sections. Resolve every placeholder before publication.

## Attribution

cw-code is not affiliated with Anthropic, OpenAI, or the OpenCode project. Their names and products belong to their respective owners.

## Claim boundaries

- Say “uses your installed CLIs and their authentication”; do not promise subscription coverage for every configuration.
- Say “open source”; the repository supplies an MIT license. Do not imply model usage is free.
- Say “Windows”; other packaged platforms are not established by the current release configuration.
- Say “resume CLI context”; distinguish this from best-effort history display.
- Describe supported drivers; do not imply every feature is identical across providers.
- Keep unsupported competitive rankings, user counts, speed claims, and testimonials out of release copy.
