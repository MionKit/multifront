---
type: feature
spec: full-plan
status: ready
created: 2026-10-16
milestone: 7
step: 7.14
---

# Publish the VS Code extension to the Marketplace and Open VSX

## Problem

`pnpm devx vsix` packs a tested `.vsix` (7.13), but nothing publishes it. A release has to put the same file in both stores, and only after the 7.13 checks pass on that exact file.

Today `packages/e2e/editor/vscode/vsix.spec.ts` always packs its own copy: `packVsix(temp)` in `packages/e2e/editor/lib/vsix.ts` runs `devx vsix` in a temp repo with `version.json` forced to `0.0.0`. So a workflow that runs `pnpm devx vsix` and then the spec would test a different file from the one it publishes. The deliverable says "from one tested file".

## Plan

1. **The spec can test a given `.vsix`.** This is the pattern `MULTIFRONT_CONSUMER_TARBALLS` already uses (`consumer/lib/pack.ts` `fixtureTarballs`), and mion's release gate too: pack once, test those bytes, publish those bytes.
   - `packages/e2e/editor/lib/vsix.ts`: new export `vsixUnderTest(dir, given = process.env.MULTIFRONT_VSIX): Promise<{vsix, extension}>`.
     - With `given` set: `resolve(given)`. If that file is missing, throw `<path> does not exist: run pnpm devx vsix`. Otherwise unzip it into `dir/extension/` with the existing `unzipVsix`.
     - Without it: today's `packVsix(dir)`, with `vsix = join(dir, VSIX_FILE)`.
   - `vsix.spec.ts` `beforeAll` calls it. The manifest test (`readZip`) and `runInVsCode({vsix})` use the returned `vsix` instead of `join(temp, VSIX_FILE)`.
   - `scripts/lib/env.mjs` `REGISTRY` gets a new internal row: `MULTIFRONT_VSIX`, "set by the vscode-release workflow: the .vsix pnpm devx vsix packed; editor/vscode/vsix.spec.ts tests that file instead of packing its own, and the publish steps publish it".
   - Also a `GITHUB_REF_NAME` row, internal: "set by GitHub Actions; on a release, the vscode-release workflow checks it is v<version.json>".
   - `VSCE_PAT` and `OVSX_PAT` get no row: only vsce and ovsx read them (milestone text).
2. **`.github/workflows/vscode-release.yml`**, one job `vsix` on `ubuntu-latest`, `permissions: contents: read`, `concurrency: {group: vscode-release-${{ github.ref }}, cancel-in-progress: ${{ github.event_name == 'pull_request' }}}` (a release is never cancelled mid-publish).
   - Triggers: `release: types: [published]`, and a `pull_request` dry run to `main` when `.github/workflows/vscode-release.yml`, `packages/e2e/editor/vscode/vsix.spec.ts` or `packages/e2e/editor/lib/vsix.ts` changes.
   - Steps, the setup copied from ci.yml's `check` job:
     1. Checkout, `pnpm/action-setup@v6`, `setup-node@v5` (node 26, pnpm cache).
     2. "The release tag is v + version.json", `if: github.event_name == 'release'`. Reads `version.json`. Fails with `::error::` when the version is not plain `major.minor.patch` (the Marketplace refuses semver pre-release versions: vsce's `validateManifestForPublishing`) or when `$GITHUB_REF_NAME != v$version`. Nothing is packed or published after a failure.
     3. `pnpm install --frozen-lockfile`.
     4. `id: vsix`: writes `path=${{ github.workspace }}/packages/vscode/multifront-vscode-<version>.vsix` to `$GITHUB_OUTPUT`.
     5. `pnpm devx vsix`.
     6. ci.yml's `.vscode-test` cache, with the same key so it reuses the `check` job's cache, and `sudo sysctl -w kernel.core_pattern=/dev/null`.
     7. "Test the packed file": `pnpm devx test --reporter verbose packages/e2e/editor/vscode/vsix.spec.ts`, with `MULTIFRONT_VSIX: ${{ steps.vsix.outputs.path }}`. The harness starts its own Xvfb.
     8. "Publish to the VS Code Marketplace", `if: github.event_name == 'release'`: `pnpm exec vsce publish --packagePath "$MULTIFRONT_VSIX" --skip-duplicate`, env `VSCE_PAT: ${{ secrets.VSCE_PAT }}`. vsce reads `VSCE_PAT` itself.
     9. "Publish to Open VSX", same `if`: `pnpm exec ovsx publish "$MULTIFRONT_VSIX" --skip-duplicate`, env `OVSX_PAT: ${{ secrets.OVSX_PAT }}`. ovsx reads `OVSX_PAT` itself. Because a PAT is given, ovsx does not try OIDC, so no `id-token` permission.
   - `--skip-duplicate` on both: re-running a release whose Open VSX step failed must not fail on the Marketplace version that already went out.
3. **`ovsx` 1.2.0** as a new exact-pinned root devDependency (`pnpm add -D -w ovsx@1.2.0`).
   - 1.2.0 is the newest release older than 30 days (2026-09-10).
   - Its `@vscode/vsce ^3.7.1` dependency dedupes with the root 3.9.2. It has no install scripts. `@napi-rs/keyring` is an optional binary.
4. **SETUP.md "Publishing the extension"**, short:
   - The one-time setup:
     - The Marketplace publisher `mionkit`.
     - An Azure DevOps PAT with Marketplace "Manage" scope over all accessible organizations, stored as the repository secret `VSCE_PAT`. It expires, so it must be renewed.
     - Open VSX: sign in, sign the Eclipse Foundation publisher agreement, create the namespace `mionkit` (`pnpm exec ovsx create-namespace mionkit`) and ask for it to be verified. Its token goes in the secret `OVSX_PAT`.
   - How to release: set `version.json` (`major.minor.patch`), then publish a GitHub release tagged `v<version>`.
   - The first release is checked by hand: install from each store into a clean VS Code and a clean VSCodium, and the 7.13 checks pass there.
5. **Docs.**
   - `docs/architecture.md` "Packaging" gets one sentence on the release: it packs once, `vsix.spec.ts` tests that file, then the same file goes to both stores.
   - `docs/milestones/README.md` "Test infrastructure" gets one row: Release, VS Code stores | M7 (7.14) | `vscode-release.yml`, `MULTIFRONT_VSIX`.
   - `packages/vscode/README.md` (the Marketplace page): the status line drops "not published yet" and stays thin.
   - Milestone step 7.14 gets `- Status: done`, its text matched to what shipped, and open question 5 is marked settled.
   - `docs/plan.md` versioning bullet notes the version shape.
   - `publicdocs/05-editor-setup.md` stays as it is. Nothing is in the stores until the first release, and the milestone's docs writer owns that page.

## Decisions

- One tested file: `MULTIFRONT_VSIX` makes `vsix.spec.ts` test the file the workflow then publishes (consumer tarballs and mion pattern).
- Release tag shape: `v<version>`, as mion tags.
- Pre-release channel (orchestrator): none. A release whose `version.json` is not plain `major.minor.patch` fails before anything is packed. Milestone open question 5 is settled (publisher `mionkit`, no pre-release channel), and `docs/plan.md`'s versioning bullet notes the version shape.
- CI proof (orchestrator): the workflow's `pull_request` dry run on its three paths, both publish steps gated on `github.event_name == 'release'`.
- ovsx 1.2.0, the `MULTIFRONT_VSIX` and `GITHUB_REF_NAME` rows and `--skip-duplicate` (orchestrator): approved as planned.

## Tests

Area Editor.

- `packages/e2e/editor/vscode/vsix.spec.ts` with no env var: unchanged behaviour. It runs in ci.yml's `check` job and floor jobs, and on this host (Xvfb and the cached VS Code 1.137.0 are present).
- With `MULTIFRONT_VSIX`: on this host, `pnpm devx vsix`, then `MULTIFRONT_VSIX=<abs path> pnpm devx test packages/e2e/editor/vscode/vsix.spec.ts`. Every check passes on the given file, and the error is checked for a missing path.
- In CI: the workflow's PR dry run runs the same thing on this PR. The `PR` message quotes its log lines showing the spec's tests executing.
- The publish steps cannot run before the first real release. That run is checked by hand (SETUP.md), as the step says.

## Fuzzing

None: no cheap oracle for publishing.

## Out of scope

- Store pre-release channel.
- Signing the `.vsix`, OIDC trusted publishing, npm publishing of the packages.
- `publicdocs/` (milestone docs writer).
- The milestone 7 exit test.

## Done when

- `.github/workflows/vscode-release.yml` packs, tests the packed file and publishes it to both stores on a `v<version>` release; its PR dry run is green with the vsix spec's tests visible in the log.
- `vsix.spec.ts` tests a given `.vsix` through `MULTIFRONT_VSIX`, and its own pack without it.
- SETUP.md has "Publishing the extension"; milestone step 7.14 has `- Status: done`.
- `pnpm devx check` is green.
- The simplify-comments pass ran on every touched source file, committed on its own.
