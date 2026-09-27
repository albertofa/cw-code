# Windows code signing

cw-code signs its own Windows binaries, the app executable and the NSIS installer, through
SignPath, without Azure. The reusable workflow `.github/workflows/sign-windows.yml` does
the packaging, signing, re-hashing and verification. This document covers the provider
choice, the signing scope, the configuration the owner must create, key custody,
rotation, outages, and what is still blocked on the owner.

## Status

The pipeline code is in place, but nothing has been signed yet: every item under
"Blocked on the owner" is still open. **No workflow calls `sign-windows.yml` yet.** Step 09
adds the release workflow that does. Until the owner finishes enrollment, only
`signing-mode: unsigned` can run, and it only produces non-production artifacts that the
step-09 validator refuses to publish.

## Signing scope: first-party only

SignPath Foundation's terms forbid signing upstream libraries. Unsigned upstream OSS
binaries may still ship inside a signed package. cw-code therefore signs exactly two
**first-party** files:

- `win-unpacked/cw-code.exe` (`.signpath/artifact-configurations/app.xml`)
- the single top-level NSIS installer `cw-code-Setup-<version>-x64.exe`
  (`.signpath/artifact-configurations/installer.xml`)

This list lives in code in two places: `$FirstPartyAppFiles` in
`scripts/verify-signatures.ps1`, and `FIRST_PARTY_APP_FILES` / `roleOf` in
`tools/release/src/signingManifest.ts`. Callers cannot change it. Every other PE file under
`win-unpacked` (Electron's DLLs, ffmpeg, node-pty's prebuilt `.node`/`.exe`/`.dll` files,
electron-builder's `elevate.exe`) is **third-party**.

| Role | Accepted |
| --- | --- |
| first-party (signpath mode) | Authenticode `Valid`, signer matches `CW_WINDOWS_PUBLISHER_NAME`, timestamp countersignature present |
| first-party (unsigned mode) | same rule as third-party |
| third-party | `NotSigned`, or `Valid` from any publisher. Anything else (`HashMismatch`, `NotTrusted`, `UnknownError`, ...) fails |

A third-party file that is `Valid` today (for example the Microsoft-signed
`d3dcompiler_47.dll`, `conpty.dll` and `OpenConsole.exe`) can turn `NotTrusted` later. That
happens if the vendor's certificate is revoked, or if it expires and the file was signed
without a timestamp. The verifier then fails and the release is blocked. This is
intentional (fail closed). The fix is to update the dependency that ships the file, not to
widen the rule.

"Timestamp present" means `Get-AuthenticodeSignature` returned a `TimeStamperCertificate`.
Chain trust comes from the `Valid` status at verification time. The script does not
evaluate the timestamp authority's own trust separately.

## Provider evaluation

### SignPath Foundation (selected, pending enrollment)

From its published terms (<https://signpath.org/terms>), to be confirmed with SignPath
during enrollment:

- **Eligibility.** The license must be OSI-approved with no commercial dual licensing. cw-code
  is MIT. The project must be actively maintained, already released, documented, and free
  of proprietary components and malware.
- **Publisher.** The certificate is issued to **SignPath Foundation**, not to cw-code.
  Windows, SmartScreen and electron-updater show "SignPath Foundation" as the publisher.
- **Origin verification.** SignPath only signs artifacts submitted by its GitHub Action from
  a GitHub-hosted runner, as workflow artifacts of the same run, with the SignPath GitHub
  App installed. That is why signing is a set of workflow jobs and not an electron-builder
  sign hook.
- **Approval.** Each release signing request is approved manually in SignPath. A release
  makes two requests (app executable, then installer).
- **Obligations.** MFA for every team member on SignPath and GitHub. Named roles (authors,
  reviewers, approvers). A public code signing policy page stating "Free code signing
  provided by SignPath.io, certificate by SignPath Foundation".
- **Upstream binaries.** May not be signed; see "Signing scope" above.
- **Cost and limits.** Free. Quotas are not in the public terms. Confirm them during
  enrollment.
- **Caveat.** All Foundation projects share one identity. electron-updater's publisher check
  therefore proves "signed by SignPath Foundation", not "built by cw-code". Update integrity
  also depends on the `sha512` in `latest.yml`, which is served from this repository's
  GitHub releases.

### Provenance: which commit SignPath records

SignPath's origin verification records the workflow run's `GITHUB_SHA` and ref. The jobs
build `source-sha`. These are equal for an alpha built from `main`'s head, but they differ
when a `workflow_run` or a stable promotion builds an older, already-tested commit. The
guard requires `source-sha` to be an ancestor of `origin/main`, and `source-sha` is
recorded in `package-info.json`, in `signing.json` and in both job summaries. **The owner
must confirm with SignPath during enrollment that building an ancestor of the run's commit
satisfies its origin policy.** If it does not, stable promotion must be restructured so
that the run's own commit is the one built.

### Commercial fallback (not enrolled; needs owner approval first)

- **SignPath commercial plan.** The certificate is in cw-code's own name, and the workflow
  keeps working (`signing-mode: signpath`).
- **A cloud-HSM signing service from a public CA** (for example SSL.com eSigner, DigiCert
  KeyLocker, Certum SimplySign, GlobalSign). This needs a new signing mode: jobs that
  replace the two SignPath jobs. Verification, rehash and `signing.json` stay the same.

These options cost money and involve identity validation. Nothing may be enrolled or bought
without the owner's explicit approval.

## Pipeline

`sign-windows.yml` only has a `workflow_call` trigger. Its inputs are `signing-mode`
(`signpath` | `unsigned`), `production`, `version` and `source-sha`. Its output,
`release-artifact`, names the final artifact.

1. **guard** (ubuntu):
   - Allowlists the caller event: `workflow_dispatch`, `workflow_run`, `push`, `schedule`.
   - Rejects `unsigned` + `production`.
   - Requires a 40-hex `source-sha`.
   - In `signpath` mode (production or not), requires `github.ref == refs/heads/main`, and
     that `source-sha` is an ancestor of `origin/main` (full-history, blobless checkout of
     `main`).
   - Production requires an `X.Y.Z` / `X.Y.Z-alpha.N` version.
   - Checks that `job.workflow_sha` is a commit SHA.
   - Computes the artifact names (`cw-code-<version>-windows-<mode>-attempt<n>-<kind>`) and
     writes the request (mode, version, source-sha, run SHA/ref, tooling commit) to the step
     summary.
2. **package-app**: checks out `source-sha`, runs a frozen install, `release apply
   --version`, `electron-vite build`, and `electron-builder --win nsis --x64 --publish
   never`. In `signpath` mode it adds
   `-c.win.signtoolOptions.publisherName=<CW_WINDOWS_PUBLISHER_NAME>` and fails if that
   variable is empty. It writes `package-info.json` (`version`, `sourceSha`,
   `signingMode`, `production`, `runId`, `toolingSha`) and uploads `win-unpacked/` plus
   `package-info.json`.
3. **sign-app** (`signpath` only, environment `release-signing`): checks every SignPath
   variable and the secret, submits the artifact with `app.xml` (signs
   `win-unpacked/cw-code.exe` only), and uploads the signed output.
4. **package-installer**:
   - In `signpath` mode, verifies the signed app first
     (`verify-signatures.ps1 -AppOnly`: first-party `cw-code.exe` valid, correct publisher,
     timestamped; third-party files `NotSigned`/`Valid`).
   - Hashes the app tree, runs `electron-builder --prepackaged <app>/win-unpacked --win nsis
     --x64 --publish never -c.nsis.packElevateHelper=false`, and fails if any app file
     changed.
   - Stages the installer, its blockmap and `latest.yml`/`alpha.yml` **by name** (never
     `builder-debug.yml`).
5. **sign-installer** (`signpath` only, environment `release-signing`): submits the
   installer with `installer.xml`.
6. **finalize**:
   - Puts the metadata, the final installer and the app in `release/`, then runs:
     `rehash`, `verify-signatures.ps1`, `signing-manifest` (checks `package-info.json`
     against the workflow inputs and the update info version), and `check-signing-manifest
     --release-dir release` (plus `--require-production` for production).
   - Uploads the release set: installer, blockmap, update info, `signing.json`,
     `verify-signatures.json`, `rehash.json`, `package-info.json`, and the verified
     `win-unpacked/`, which step 09 needs to re-hash every listed file.

**Gate tooling comes from the signing workflow's own commit.** `package-installer` and
`finalize` check out `job.workflow_sha` into `tooling/`: the commit of `sign-windows.yml`
itself, which for a local reusable workflow is the caller's commit. Each checkout confirms
`HEAD` equals that SHA. `tree-digest.ps1`, `verify-signatures.ps1`, `rehash`,
`signing-manifest` and `check-signing-manifest` always run from `tooling/`. Only the app
is built from `source-sha`, so a stable promotion of an older commit is still checked by
the current gates. actionlint 1.7.12 does not know `job.workflow_sha` yet (GitHub
documents it in the `job` context), so `.github/actionlint.yaml` ignores exactly that
message for this file.

The rehash in `finalize` uses the tooling commit's electron-builder. When `source-sha` is
older, its blockmap chunking could in theory differ from the installer's builder version.
The blockmap still describes the final installer bytes exactly; only differential
download efficiency could change.

Intermediate artifacts are kept for 1 day, the final set for 14 days. Artifacts are never
overwritten, and names include the run attempt. After a failure, use **Re-run all jobs**
so every artifact gets a fresh name. "Re-run failed jobs" can collide with an artifact
that a partially failed job already uploaded.

Dependency caches are disabled in this workflow (`cache:` is absent on purpose, so no
shared cache can feed a signing run). All third-party actions are pinned to full commit
SHAs. `tools/release/src/signingWorkflowPolicy.test.ts` enforces:

- `workflow_call` as the only trigger;
- SHA pins with a version comment;
- `persist-credentials: false` on every checkout;
- secrets only in `release-signing` jobs;
- no `${{ }}` inside `run:` scripts in any block style;
- gate scripts only run from `tooling/`, and every tooling checkout uses
  `job.workflow_sha`;
- no `cache:` or `overwrite:`.

### Why package-app builds an NSIS target, and why packElevateHelper=false

electron-builder only writes `resources/app-update.yml` (where `publisherName` lives) when
an NSIS target is part of the build. `--win nsis --dir` builds the installer anyway,
because an explicit target overrides `--dir`. So package-app builds the NSIS target and
throws that installer away. The same build also copies `elevate.exe` into
`win-unpacked/resources/`.

The installer must pack exactly the tree that was signed and verified.
`-c.nsis.packElevateHelper=false` keeps the `--prepackaged` step from writing
`elevate.exe` into that tree again (the option only controls that copy, plus
`isAdminRightsRequired` for `perMachine: true`, which this app does not use). The
tree-digest check turns any other write by electron-builder into a hard failure.
Per-machine installs keep working because `elevate.exe` is already in the app.

### Known gap: the uninstaller

`Uninstall cw-code.exe` is generated inside the NSIS build, and electron-builder's own sign
hook is disabled. SignPath signs only the finished installer, so the embedded uninstaller
stays unsigned. electron-updater verifies the installer only, so updates are not affected.

## Configuration (owner)

### Repository variable

| Name | Value |
| --- | --- |
| `CW_WINDOWS_PUBLISHER_NAME` | **Recommended: the CN only, `SignPath Foundation`.** |

Trade-off. A full DN pins more attributes, and electron-updater logs a warning when it
matches on the CN only. But when SignPath Foundation renews its certificate, a changed
O/L/S attribute would make every installed client reject updates until a transition
release ships, and clients that miss that release are stranded. The Foundation identity is
shared by all its projects anyway, so a DN adds little assurance here. Use a full DN only
with an own-name certificate, and then follow the rotation procedure below on every
renewal. The decision is the owner's.

package-app reads the variable outside any environment, so it must be set at repository
level. It ends up in `app-update.yml` and is the expected publisher for verification.

### Environment `release-signing`

- Required reviewers: the owner (plus a co-maintainer, with "Prevent self-review").
- Deployment branches and tags: selected branches only, `main`.
- Allow administrators to bypass: off.
- Environment secret `SIGNPATH_API_TOKEN`: a SignPath CI user token with submitter rights
  only. Never a repository or organization secret, and never passed from a caller. The
  workflow does not declare it under `workflow_call.secrets`.
- Environment variables: `SIGNPATH_ORGANIZATION_ID`, `SIGNPATH_PROJECT_SLUG`,
  `SIGNPATH_SIGNING_POLICY_SLUG`, `SIGNPATH_APP_ARTIFACT_CONFIGURATION`,
  `SIGNPATH_INSTALLER_ARTIFACT_CONFIGURATION`.

### Repository protection

- Branch protection or a ruleset on `main`: required pull request review, no direct push,
  no force push, no deletion, and "Do not allow bypassing" for admins.
- `CODEOWNERS` entries that make the owner a required reviewer for `.github/workflows/`,
  `.signpath/`, `scripts/` and `tools/release/`, with "Require review from Code Owners"
  enabled. Changing any of these changes what gets signed or how it is checked.

### SignPath project

- Link GitHub.com as the trusted build system and install the SignPath GitHub App on
  `albertofa/cw-code`.
- Create the two artifact configurations from `.signpath/artifact-configurations/` and
  validate them in SignPath's UI.
- A release-signing policy with manual approval that applies an RFC 3161 timestamp.

### Caller (step 09, not written yet)

```yaml
jobs:
  sign:
    uses: ./.github/workflows/sign-windows.yml
    permissions:
      contents: read
      actions: read
    with:
      signing-mode: signpath
      production: true
      version: ${{ needs.plan.outputs.version }}
      source-sha: ${{ needs.plan.outputs.sha }}
```

## Credentials

- **Short-lived credentials.** The SignPath GitHub Action authenticates with a long-lived
  API token; we know of no OIDC or other short-lived option for it. The mitigations are
  scope and exposure: a submit-only CI user, a token stored only as a `release-signing`
  environment secret (reviewers plus the `main`-only rule), used by two jobs, and never
  written to disk. Rotate it when a maintainer with access leaves, or at least yearly.
  Switch to short-lived credentials if SignPath adds them.
- **Key custody.** SignPath Foundation keeps the private key in its HSM. cw-code never holds
  a key or a certificate file.
- The run's `GITHUB_TOKEN` is read-only (`contents: read`, plus `actions: read` for the
  SignPath jobs), and checkouts never persist it.

## Fail-closed gates

| Failure | Where it stops |
| --- | --- |
| Caller event outside the allowlist | guard |
| `unsigned` + `production: true` | guard, `signing-manifest`, `check-signing-manifest` |
| `signpath` mode from a ref other than `main`, or `source-sha` not on `main` | guard, plus the environment's branch rule |
| `job.workflow_sha` missing, or the tooling checkout at another commit | guard, then each tooling checkout |
| `CW_WINDOWS_PUBLISHER_NAME` empty in `signpath` mode | package-app, package-installer, finalize |
| SignPath variable or token missing | sign-app / sign-installer, before submitting |
| Provider refusal, denied approval, timeout | the SignPath action step |
| Signed `cw-code.exe` invalid, wrong publisher, or without timestamp | package-installer (`-AppOnly`), then finalize |
| electron-builder changes an app file | package-installer tree-digest check |
| First-party file not `Valid`/publisher/timestamp; third-party file not `NotSigned`/`Valid` | `verify-signatures.ps1`, then `signing-manifest` |
| `app-update.yml` without the expected `publisherName` | `signing-manifest` |
| `package-info.json` differs from inputs (version, sourceSha, runId, mode, production), or update info version differs | `signing-manifest` |
| Installer bytes differ from `latest.yml`/`alpha.yml` | `signing-manifest`, `check-signing-manifest` |
| Any listed file changed after `signing.json` was written, or first-party set incomplete | `check-signing-manifest --release-dir` |
| Non-production manifest handed to publishing | `check-signing-manifest --require-production --release-dir` (step 09) |

## Tooling

### `release rehash --dir <release dir>`

Rebuilds `<installer>.blockmap` with electron-builder's own `buildBlockMap`
(`app-builder-lib/out/targets/blockmap/blockmap.js`; electron-builder 26.15.3 no longer uses
`app-builder-bin`), resolved through the tooling checkout's `apps/desktop`. It then rewrites
`files[0].sha512`, `files[0].size`, the top-level `sha512` and `path` in whichever of
`latest.yml`/`alpha.yml` exist, touching only those lines. With the github provider,
electron-builder writes only the configured channel's file (`publish.channel`), so either
file or both may be present.

### `signing.json`

```json
{
  "mode": "signpath",
  "production": true,
  "publisher": "SignPath Foundation",
  "version": "1.2.0",
  "sourceSha": "<40-hex>",
  "runId": "<github.run_id>",
  "verifiedAt": "<ISO-8601>",
  "files": [
    { "path": "win-unpacked/cw-code.exe", "role": "first-party", "sha512": "<base64>", "status": "Valid", "signed": true, "subject": "<signer DN>", "timestamped": true },
    { "path": "win-unpacked/ffmpeg.dll", "role": "third-party", "sha512": "<base64>", "status": "NotSigned", "signed": false, "subject": null, "timestamped": false }
  ]
}
```

- `release signing-manifest --mode <m> --production <true|false> [--publisher <p>]
  --version <v> --source-sha <sha> --run-id <id> --package-info <file> --report
  <verify.json> --release-dir <dir> [--app-update <app-update.yml>] --out <file>`
- `release check-signing-manifest --manifest <file> [--release-dir <dir>]
  [--require-production]` re-validates the manifest. With `--release-dir` it also re-hashes
  every listed file, checks the installer and version against `latest.yml`/`alpha.yml`, and
  requires the first-party set. `--require-production` requires `--release-dir`.

Validation recomputes each file's role from its path, so a relabelled role is rejected. It
also requires `signed` to be true exactly when `status` is `Valid`, and applies the rules in
"Signing scope". Publisher matching uses electron-updater's semantics through
`builder-util-runtime`'s `parseDn`: a bare name is compared with the CN, and a DN must
match every RDN it lists. `verify-signatures.ps1` carries a line-by-line port of the same
`parseDn`. A parity check against the JS original is in the local evidence.

### `scripts/verify-signatures.ps1`

```powershell
pwsh scripts/verify-signatures.ps1 -Root <dir> -ExpectedPublisher <name or DN> [-AllowUnsigned] [-AppOnly] [-OutFile <json>]
```

`<dir>` holds `win-unpacked/` and, unless `-AppOnly` is set, exactly one installer `.exe` at
the top level. The script checks every `.exe`/`.dll`/`.node` under `win-unpacked/` and the
installer, applies the role rules, prints JSON, and exits 1 on any failure.
`-AllowUnsigned` (unsigned mode) applies the third-party rule to first-party files, so
`NotSigned` is accepted but `HashMismatch` still fails. A missing root, installer,
`win-unpacked/` or `cw-code.exe` always exits 1.

## Evidence (local, no certificate)

Captured on 2026-09-24 against an unsigned local build of `0.0.1-alpha.21`
(`agents-scratchpad/updater/step07/round2/`):

- Packaging: the NSIS-target build with two `publisherName` flags wrote both names to
  `app-update.yml`, and electron-builder logged "file signing skipped via signExecutable
  configuration". `--prepackaged ... -c.nsis.packElevateHelper=false` produced the
  installer, blockmap and `latest.yml`, and left the app tree byte-identical.
- `rehash` on electron-builder's untouched output: `latest.yml` and the blockmap stayed
  byte-identical. On a copy with 64 bytes appended and both channel files present, both
  files and the blockmap were rewritten to an independently verified sha512/size.
- `verify-signatures.ps1` on the unsigned build:

  | Run | Exit |
  | --- | --- |
  | With a publisher | 1; exactly the 2 first-party files fail (16 PE files checked) |
  | `-AllowUnsigned` | 0 (13 `NotSigned`, 3 Microsoft-signed `Valid`) |
  | `-AppOnly` with a publisher | 1 |
  | No publisher and no `-AllowUnsigned` | 1 |
  | No `win-unpacked` | 1 |

- Controlled fixtures from Microsoft-signed binaries in the build (a copy of
  `OpenConsole.exe` stands in for `cw-code.exe` and the installer):

  | Case | Exit |
  | --- | --- |
  | Expected publisher "Microsoft Corporation" (CN and DN) | 0 |
  | Expected "SignPath Foundation" (wrong first-party publisher) | 1 |
  | One byte flipped in a third-party DLL (`HashMismatch`) | 1, also with `-AllowUnsigned` |
  | One byte flipped in the first-party exe | 1 |

- `parseDn` parity between `builder-util-runtime` and the PowerShell port on 6 DN samples
  (quoted commas, `+` separators, hex escapes, extra spaces, a bare name): identical.
- `signing-manifest` (unsigned) wrote a manifest with provenance and 2 first-party + 14
  third-party entries. Then `check-signing-manifest`:

  | Case | Exit |
  | --- | --- |
  | `--release-dir` | 0 |
  | `--require-production` | 1 (not production) |
  | `--require-production` without `--release-dir` | 1 |
  | After one byte of `ffmpeg.dll` was flipped | 1 |
  | After restoring it | 0 |

  `signing-manifest` with a wrong run id → 1; in signpath mode against the unsigned
  report → 1.

### Negative fixtures once a real certificate exists

Do not create or trust self-signed certificates on developer machines. After the first
signed test build (non-production `signpath` run):

- **Wrong publisher**: run the verifier with another `-ExpectedPublisher`.
- **Corrupted signature**: flip one byte of the signed installer or `cw-code.exe` →
  `HashMismatch`.
- **Stripped signature**: use the unsigned `package-app` artifact of the same run.
- **Missing timestamp**: only possible if the signing policy allows untimestamped signing,
  which the production policy must not. Otherwise this rule is covered by the script logic
  and the validator tests.
- **Updater rejection**: in a disposable VM, serve an installer signed by another subject.
  electron-updater must refuse it. This is part of step 09's installed upgrade gate.

Record the commands and redacted output (signer subject, thumbprint, timestamp authority;
never the token) in the PR.

## Renewal and rotation

- **Renewal with the same CN** (the recommended CN-only setting): nothing to do.
- **Subject change** (new provider, own-name certificate, or a DN setting whose attributes
  changed): clients only accept installers whose signer matches the names in their own
  `app-update.yml`.
  1. Ship a transition release signed by the still-trusted identity, whose `app-update.yml`
     lists both names. Add a second `-c.win.signtoolOptions.publisherName=<new subject>`
     flag in package-app (electron-builder turns repeated flags into a list; verified
     locally).
  2. After wide adoption, switch the signing identity and `CW_WINDOWS_PUBLISHER_NAME`.
  3. Clients older than the transition release must reinstall manually. Say so in the
     release notes.
  4. Drop the old name in a later release.

## Outages and recovery

There is no unsigned production path. `signing-mode: unsigned` never publishes.

- **SignPath unavailable or approval delayed**: the SignPath step fails or times out
  (3600 s wait, 900 s download). Re-run all jobs once the service is back.
- **Request denied**: fix the cause and start a new run.
- **Verification failure**, including a third-party file that turned `NotTrusted`: this is
  a release blocker. Fix the dependency or the signing configuration. Never switch to
  `unsigned`.
- **Certificate revoked or Foundation subscription paused**: stop releasing and tell users on
  the GitHub releases page. A replacement provider needs owner approval, and the switch
  follows the rotation procedure.

## Local packaging

`apps/desktop/electron-builder.yml` sets `win.signExecutable: false`, so electron-builder
never signs any file, and `win.verifyUpdateCodeSignature: true`. `pnpm dist` and `dist:dir`
produce **unsigned, non-production** builds. One exception: if `CSC_LINK`/`WIN_CSC_LINK`
(or `signtoolOptions.certificateSubjectName`/`certificateSha1`) is set, electron-builder
still reads that certificate to derive a `publisherName` for `app-update.yml`, even though
it signs nothing. Keep those unset for local builds. Signed builds only come from
`sign-windows.yml` in `signpath` mode, with the publisher from `CW_WINDOWS_PUBLISHER_NAME`.

## Blocked on the owner

- [ ] Apply to SignPath Foundation for `albertofa/cw-code` (or approve a commercial
      fallback) and accept its terms.
- [ ] Confirm with SignPath that building `source-sha` (an ancestor of the run's commit)
      satisfies origin verification.
- [ ] Publish the code signing policy page; enable MFA for all team members.
- [ ] Install the SignPath GitHub App and link GitHub.com as the trusted build system.
- [ ] Create and validate the two artifact configurations; create the release-signing
      policy (manual approval, RFC 3161 timestamp), the approvers, and a submit-only CI
      user token.
- [ ] Create the `release-signing` environment (reviewers, `main` only, no admin bypass,
      secret, variables) and the repository variable `CW_WINDOWS_PUBLISHER_NAME`
      (recommended: `SignPath Foundation`).
- [ ] Protect `main` (required review, no direct or force push, no admin bypass) and add
      `CODEOWNERS` for `.github/workflows/`, `.signpath/`, `scripts/` and `tools/release/`.
- [ ] Run a first non-production `signpath` build (after step 09 adds a caller), and
      record the redacted proof and the negative fixtures.
