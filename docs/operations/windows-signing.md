# Windows code signing

cw-code signs its Windows app and NSIS installer through SignPath, without Azure. The
reusable workflow `.github/workflows/sign-windows.yml` does the packaging, signing,
re-hashing and verification. A release workflow (step 09) calls it. This document covers
the provider choice, the configuration the owner must create, key custody, rotation,
outages, and what is still blocked on the owner.

## Status

The pipeline code is in place. It has not signed anything yet, because nothing below
"Blocked on the owner" is done. Until then, only `signing-mode: unsigned` can run, and
it only produces non-production artifacts that the step-09 validator refuses to publish.

## Provider evaluation

### SignPath Foundation (selected, pending enrollment)

SignPath Foundation gives free code signing to open-source projects. From its published
terms (<https://signpath.org/terms>), to be confirmed with SignPath during enrollment:

- **Eligibility.** The license must be OSI-approved with no commercial dual licensing. cw-code
  is MIT. The project must be actively maintained, already released, documented, and free
  of proprietary components and malware.
- **Publisher.** The certificate is issued to **SignPath Foundation**, not to cw-code.
  Windows, SmartScreen and electron-updater will all show "SignPath Foundation" as the
  publisher.
- **Origin verification.** SignPath only signs artifacts built from the repository's source
  on GitHub-hosted runners, submitted by its GitHub Action from the same workflow run, with
  the SignPath GitHub App installed on the repository. That is why signing is a set of
  workflow jobs and not an electron-builder sign hook.
- **Approval.** Each release signing request needs manual approval by a project approver in
  SignPath. A release makes two requests (app files, then the installer), so it needs two
  approvals.
- **Obligations.** MFA for every team member on SignPath and GitHub. Named roles (authors,
  reviewers, approvers). A public code signing policy page that states "Free code signing
  provided by SignPath.io, certificate by SignPath Foundation" and lists the team roles.
- **Upstream binaries.** The terms say projects may not sign upstream libraries, although
  unsigned upstream OSS binaries may ship inside a signed package. This conflicts with
  `app.xml`, which signs every PE file in `win-unpacked` (see "Open design question").
- **Cost and limits.** Free. Quotas and request limits are not in the public terms. Confirm
  them during enrollment.
- **Caveat.** Every Foundation project is signed by the same identity. Publisher
  verification in electron-updater therefore proves "signed by SignPath Foundation", not
  "built by cw-code". Update integrity also depends on the `sha512` in `latest.yml`, which
  is served from this repository's GitHub releases. The owner should decide whether this
  is acceptable.

### Commercial fallback (not enrolled; needs owner approval first)

If the Foundation rejects the project, or its terms become unacceptable, the options that
avoid Azure and keep the key in an HSM are:

- **SignPath commercial plan.** The certificate is in cw-code's own name and the workflow
  keeps working as-is (`signing-mode: signpath`, same variables).
- **A cloud-HSM signing service from a public CA** (for example SSL.com eSigner, DigiCert
  KeyLocker, Certum SimplySign, GlobalSign). These need a new signing mode: a job that
  replaces the two SignPath jobs. Rehash, verification and `signing.json` stay the same.

These options cost money and involve identity validation of the owner or organization.
Nothing may be enrolled or bought without the owner's explicit approval. Get quotes when
it comes to that; this document does not list prices.

## Pipeline

`sign-windows.yml` only has a `workflow_call` trigger. Its inputs are `signing-mode`
(`signpath` | `unsigned`), `production` (boolean), `version` and `source-sha`. Its
output, `release-artifact`, names the final artifact.

1. **guard** (ubuntu): fails on `pull_request`/`pull_request_target` callers and on
   `unsigned` + `production`. It requires a 40-hex `source-sha`. For production it also
   requires an `X.Y.Z` / `X.Y.Z-alpha.N` version and `github.ref == refs/heads/main`.
   It computes every artifact name.
2. **package-app**: checks out `source-sha` with `persist-credentials: false` and runs a
   frozen install. Then `release apply --version`, `electron-vite build`, and
   `electron-builder --win nsis --x64 --publish never`. In `signpath` mode it adds
   `-c.win.signtoolOptions.publisherName=<CW_WINDOWS_PUBLISHER_NAME>`, and it fails if that
   variable is empty. It uploads `win-unpacked/` and `package-info.json`.
3. **sign-app** (`signpath` only, environment `release-signing`): checks every SignPath
   variable and secret, submits the artifact with `app.xml`, waits for approval, and
   uploads the signed output.
4. **package-installer**: runs `electron-builder --prepackaged <app>/win-unpacked --win nsis
   --x64 --publish never -c.nsis.packElevateHelper=false` on the signed app (or the
   unsigned one in `unsigned` mode). It hashes every file in the app tree before and after
   the build, and fails if anything changed. It uploads the installer (for signing) and the
   update metadata (`*.yml`, `*.blockmap`) as separate artifacts.
5. **sign-installer** (`signpath` only, environment `release-signing`): submits the
   installer with `installer.xml` and uploads the signed installer.
6. **finalize**: puts the metadata, the final installer and the app in `release/`. Then:
   `release rehash --dir release`, `verify-signatures.ps1`,
   `release signing-manifest` (writes `signing.json`), and for production,
   `release check-signing-manifest --require-production`. It uploads the release set:
   installer, blockmap, `latest.yml`/`alpha.yml`, `signing.json`,
   `verify-signatures.json`, `rehash.json`, `package-info.json`.

Every third-party action is pinned to a full commit SHA with its tag in a trailing
comment. `tools/release/src/signingWorkflowPolicy.test.ts` enforces this, along with:
`workflow_call` as the only trigger, `persist-credentials: false` on every checkout,
secrets only in `release-signing` jobs, and no `${{ }}` interpolation inside `run:`
scripts.

### Why package-app builds an NSIS target

electron-builder only writes `resources/app-update.yml` (where `publisherName` lives) when
an NSIS target is part of the build; `--dir` with no target skips it. Note that `--win nsis
--dir` builds the full installer anyway, because an explicit target overrides `--dir`. So
package-app builds the NSIS target and throws that installer away.

The NSIS target also copies electron-builder's unsigned `elevate.exe` into
`win-unpacked/resources/` on every build, overwriting whatever is there. That copy has to
exist before signing, so SignPath signs it, and the installer step must not overwrite it.
That is what `-c.nsis.packElevateHelper=false` does on the `--prepackaged` step. The option
only controls that copy (and `isAdminRightsRequired` for `perMachine: true`, which this app
does not use). Per-machine installs keep working, because the signed `elevate.exe` is
already in the app. The tree-digest check turns any future electron-builder change here
into a hard failure.

### Known gap: the uninstaller

electron-builder generates `Uninstall cw-code.exe` inside the NSIS build and would sign it
through its own sign hook. SignPath can only sign the finished installer, so the embedded
uninstaller stays unsigned. electron-updater checks the installer's signature only, so
updates are not affected. Signing the uninstaller would need SignPath deep signing of NSIS
packages, which it does not offer as far as we know. Revisit if SignPath adds it.

## Configuration (owner)

### Repository variable

| Name | Value |
| --- | --- |
| `CW_WINDOWS_PUBLISHER_NAME` | Signer subject exactly as in the issued certificate. It can be the CN (`SignPath Foundation`) or a full DN. Prefer the full DN, copied from `(Get-AuthenticodeSignature <signed file>).SignerCertificate.Subject` on the first signed test build: electron-updater logs a warning when it matches on the CN only. |

package-app reads this variable without an environment, so it must be set at repository
level. It ends up in `app-update.yml` and is the `-ExpectedPublisher` for verification.

### Environment `release-signing`

Create it under Settings → Environments:

- **Required reviewers**: the owner (plus any co-maintainer). Enable "Prevent self-review"
  if more than one reviewer exists.
- **Deployment branches and tags**: selected branches only, `main`.
- **Allow administrators to bypass**: off.
- **Environment secret** `SIGNPATH_API_TOKEN`: API token of a SignPath CI user that only has
  submitter rights on the cw-code project. Never store it as a repository or organization
  secret, and never pass it from a caller. The reusable workflow deliberately does not
  declare it under `workflow_call.secrets`.
- **Environment variables**: `SIGNPATH_ORGANIZATION_ID`, `SIGNPATH_PROJECT_SLUG`,
  `SIGNPATH_SIGNING_POLICY_SLUG` (the release-signing policy),
  `SIGNPATH_APP_ARTIFACT_CONFIGURATION`, `SIGNPATH_INSTALLER_ARTIFACT_CONFIGURATION` (the
  slugs of the two configurations below).

### SignPath project

- Link GitHub.com as a trusted build system for the project and install the SignPath
  GitHub App on `albertofa/cw-code`.
- Create two artifact configurations from the committed files and validate them in
  SignPath's UI before the first run:
  - `.signpath/artifact-configurations/app.xml`: zip root → `win-unpacked` directory →
    `pe-file-set` including `**/*.exe`, `**/*.dll`, `**/*.node` (`max-matches="unbounded"`)
    → `authenticode-sign` each. Check two things in the UI: that `**/` also matches files
    directly under `win-unpacked` (for example `cw-code.exe`), and that `.node` files are
    accepted as PE files.
  - `.signpath/artifact-configurations/installer.xml`: zip root → the single
    `cw-code-Setup-*-x64.exe` → `authenticode-sign`.
- A release-signing policy with manual approval. Confirm that it applies an RFC 3161
  timestamp; `verify-signatures.ps1` rejects every file without one.

### Caller (step 09)

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

The SignPath action reads job details and downloads the artifact with the run's
`GITHUB_TOKEN`, hence `actions: read`.

## Fail-closed gates

| Failure | Where it stops |
| --- | --- |
| Called from a PR event | guard |
| `unsigned` + `production: true` | guard; also `signing-manifest` and `check-signing-manifest` |
| Production from a ref other than `main` | guard, plus the environment's branch rule |
| `CW_WINDOWS_PUBLISHER_NAME` empty in `signpath` mode | package-app, and again in finalize |
| Any SignPath variable or the API token missing | sign-app / sign-installer, before submitting |
| Provider refusal, denied approval, timeout | the SignPath action step fails the job |
| electron-builder changes a signed app file | package-installer tree-digest check |
| A file unsigned, invalid (`HashMismatch` etc.), without a timestamp, or signed by another subject | `verify-signatures.ps1` (exit 1), then `signing-manifest` |
| `app-update.yml` without the expected `publisherName` | `signing-manifest` |
| Installer bytes differ from `latest.yml`/`alpha.yml` | `signing-manifest` (rehash must run after the last byte change) |
| Non-production manifest handed to publishing | `check-signing-manifest --require-production` (step 09) |

`signing-mode: unsigned` is explicit: it is never the default and never combined with
production. Its `app-update.yml` has no `publisherName`, so electron-updater does not
verify signatures in those builds, and its `signing.json` says
`{ "mode": "unsigned", "production": false }`.

## Tooling

### `release rehash --dir <release dir>`

Rebuilds `<installer>.blockmap` with the same function electron-builder uses. In
electron-builder 26.15.3 that is the pure-JS `buildBlockMap` in
`app-builder-lib/out/targets/blockmap/blockmap.js`; this version no longer uses
`app-builder-bin`. The function is resolved through `apps/desktop`'s own electron-builder
so the two versions cannot drift. rehash then rewrites `files[0].sha512`, `files[0].size`,
the top-level `sha512` and `path` in whichever of `latest.yml`/`alpha.yml` exist. The YAML
is edited line by line on those keys only, so every other line (release notes,
`releaseDate`, unknown keys) stays byte-identical. It fails when no update info file is
present, when the files point at different installers, when the installer is missing, when
an entry lists more than one installer, or when the builder's digest does not match the
file on disk.

With electron-builder's github provider, only the file for the configured channel is
written (`latest.yml`, or `alpha.yml` when `publish.channel` is `alpha`).
`generateUpdatesFilesForAllChannels` has no effect for github. rehash handles either file
or both.

### `signing.json`

```json
{
  "mode": "signpath",
  "production": true,
  "publisher": "<CW_WINDOWS_PUBLISHER_NAME>",
  "verifiedAt": "<ISO-8601>",
  "files": [{ "path": "win-unpacked/cw-code.exe", "sha512": "<base64>", "signed": true, "subject": "<signer DN>", "timestamped": true }]
}
```

- `release signing-manifest --mode <m> --production <true|false> [--publisher <p>]
  --report <verify.json> --release-dir <dir> [--app-update <app-update.yml>] --out <file>`
  writes it from the verification report, and refuses on any gate in the table above.
- `release check-signing-manifest --manifest <file> [--require-production]` re-validates it.
  Step 09 must run this with `--require-production` before publishing.

In `signpath` mode, validation requires every file to be signed and timestamped by a
subject that matches `publisher`. Matching works like electron-updater's: a bare name is
compared with the CN, and a DN must match every RDN it lists.

### `scripts/verify-signatures.ps1`

```powershell
pwsh scripts/verify-signatures.ps1 -Root <dir> -ExpectedPublisher <CN or DN> [-AllowUnsigned] [-OutFile <json>]
```

`<dir>` must contain exactly one installer `.exe` at its top level, plus `win-unpacked/`.
The script runs `Get-AuthenticodeSignature` on every `.exe`/`.dll`/`.node` under
`win-unpacked/` and on the installer, and records for each file: status, signer subject,
publisher match, timestamp presence and sha512. It prints JSON and exits 1 on any failure.
`-AllowUnsigned` (unsigned mode only) tolerates signature failures, but a missing root,
installer or `win-unpacked/` still exits 1.

## Evidence (local, no certificate)

Captured on 2026-09-24 against an unsigned local build (`0.0.1-alpha.21`):

- `--win nsis --x64 --publish never` with two `publisherName` flags wrote
  `app-update.yml` with both names as a list, and electron-builder logged "file signing
  skipped via signExecutable configuration" for every file.
- `--prepackaged ... -c.nsis.packElevateHelper=false` produced the installer, blockmap and
  `latest.yml`, and left the win-unpacked tree byte-identical (SHA-256 of every file
  compared).
- `rehash` on that untouched output left `latest.yml` and the blockmap byte-identical to
  electron-builder's own (`changed: false`). On a copy with 64 bytes appended to the
  installer and both `latest.yml` and `alpha.yml` present, it rewrote both files and the
  blockmap to the new sha512/size, which matched an independent SHA-512.
- `verify-signatures.ps1`: unsigned build with `-ExpectedPublisher` → exit 1 (16/16 files
  failed); with `-AllowUnsigned` → exit 0; with no publisher and no `-AllowUnsigned` → exit 1;
  a root without `win-unpacked` and with `-AllowUnsigned` → exit 1.
- Controlled fixtures built from Microsoft-signed binaries that already ship in the build
  (`d3dcompiler_47.dll`, `conpty.dll`, `OpenConsole.exe`): expected publisher "Microsoft
  Corporation" (CN and DN forms) → exit 0; expected "SignPath Foundation" → exit 1 (wrong
  publisher); one byte flipped in `conpty.dll` → exit 1 (`HashMismatch`).

### Negative fixtures once a real certificate exists

Do not create or trust self-signed certificates on developer machines. After the first
signed test build (non-production `signpath` run):

- **Wrong publisher**: run the verifier with `-ExpectedPublisher` set to any other subject,
  or put a binary signed by another publisher into a copy of the release set.
- **Corrupted signature**: copy the signed installer and flip one byte outside the
  signature block (for example at offset 4096). `Get-AuthenticodeSignature` reports
  `HashMismatch`.
- **Stripped signature**: the unsigned `package-app` artifact from the same run.
- **Missing timestamp**: only possible if the signing policy allows signing without a
  timestamp, which the production policy must not. If no such file can be produced, this
  rule stays covered by the script logic and by the `signing.json` validator tests.
- **Updater rejection**: install the signed build in a disposable VM and point it at a feed
  whose installer is signed by another subject. electron-updater must refuse it
  ("installer signed with incorrect certificate"). This belongs to the step-09 installed
  upgrade gate.

Record the commands and redacted outputs (signer subject, thumbprint, timestamp authority;
never the API token) in the PR.

## Key custody

SignPath Foundation keeps the private key in its HSM. cw-code never holds a key or a
certificate file. The only secret is `SIGNPATH_API_TOKEN`: a CI-user token that can submit
requests but not approve them, stored only as a `release-signing` environment secret.
Rotate it in SignPath and update the environment secret whenever a maintainer with access
leaves, or at least yearly. Approvers approve each request in SignPath with MFA.

## Renewal and rotation

- **Renewal with the same subject** (SignPath renewing the Foundation certificate): nothing
  changes if `CW_WINDOWS_PUBLISHER_NAME` holds the CN. If it holds a full DN, compare the new
  certificate's DN on the first signed build after renewal. If any listed RDN changed, follow
  the subject-change procedure below.
- **Subject change** (new provider, own-name certificate, DN change): clients installed
  from earlier releases only accept installers whose signer matches the names in their own
  `app-update.yml`.
  1. Ship a **transition release** signed by the still-trusted identity, whose
     `app-update.yml` lists both names. Add a second
     `-c.win.signtoolOptions.publisherName=<new subject>` flag to the package-app step
     (electron-builder turns repeated flags into a list; verified locally).
  2. Wait until the transition release has been widely adopted. Then switch the signing
     identity and `CW_WINDOWS_PUBLISHER_NAME` to the new subject.
  3. Clients older than the transition release cannot auto-update to the new identity.
     They have to reinstall manually. Say so in the release notes.
  4. Drop the old name in a later release.

## Outages and recovery

There is no unsigned production path. `signing-mode: unsigned` never publishes.

- **SignPath unavailable or approval delayed**: the SignPath step fails or times out
  (3600 s per request). Re-run the failed jobs once the service is back. Earlier artifacts
  from the same run are reused.
- **Request denied**: fix the cause (wrong commit, configuration) and start a new run.
- **Verification failure after signing**: treat it as a release blocker. Do not rerun with
  `unsigned`. Investigate the signer, the timestamp and the configuration first.
- **Certificate revoked or Foundation subscription paused**: stop releasing and tell users
  through the GitHub release page. Picking a replacement provider needs owner approval, and
  the switch then follows the subject-change procedure. An urgent fix still ships signed
  or not at all.

## Local packaging

`apps/desktop/electron-builder.yml` sets `win.signExecutable: false` and
`win.verifyUpdateCodeSignature: true`. electron-builder never signs anything, even when a
developer has `CSC_LINK` set; all signing happens in the workflow. `pnpm dist` and
`dist:dir` therefore produce **unsigned, non-production** builds without `publisherName`.
Only a `sign-windows.yml` run in `signpath` mode produces a signed build, and the
publisher name only comes from `CW_WINDOWS_PUBLISHER_NAME`.

## Open design question

`app.xml` signs every PE file in `win-unpacked`. That covers Electron's DLLs, node-pty's
prebuilt `.node`/`.exe`/`.dll` files and electron-builder's `elevate.exe`, and it re-signs
the three Microsoft-signed files. `verify-signatures.ps1` expects all of them to carry the
cw-code signer. SignPath Foundation's terms forbid signing upstream libraries. If SignPath
holds the project to that during enrollment, `app.xml` must shrink to first-party binaries
(`cw-code.exe`, possibly `elevate.exe`). The verifier then needs an explicit per-file policy
for upstream files: either allowed unsigned, or required to be signed by their own
publisher. That is a policy decision for the owner, not something to change during
implementation.

## Blocked on the owner

- [ ] Apply to SignPath Foundation for `albertofa/cw-code` (or approve a commercial
      fallback) and accept its terms.
- [ ] Publish the required code signing policy page and enable MFA for all team members.
- [ ] Install the SignPath GitHub App and link GitHub.com as the trusted build system.
- [ ] Create the two artifact configurations from `.signpath/artifact-configurations/` and
      validate them in SignPath's UI. Settle the upstream-binary scope above.
- [ ] Create the release-signing policy, the approvers, and a submit-only CI user token.
- [ ] Create the `release-signing` environment with protection rules, the secret and the
      variables, plus the repository variable `CW_WINDOWS_PUBLISHER_NAME`.
- [ ] Run a non-production `signpath` build and record the redacted signing proof and the
      negative fixtures. Step 09's installed upgrade gate then proves that the updater
      accepts the signed build's successor.
