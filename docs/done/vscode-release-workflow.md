---
type: feature
spec: full-plan
status: done
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
   - `packages/e2e/editor/lib/vsix.ts`: new export `vsixUnderTest(dir): Promise<{vsix, extension}>`, reading `MULTIFRONT_VSIX`.
     - Set: `resolve()`d. If that file is missing, throw `<resolved path> does not exist: run pnpm devx vsix`. Otherwise unzip it into `dir/extension/` with the existing `unzipVsix`.
     - Unset: today's `packVsix(dir)`, with `vsix = join(dir, VSIX_FILE)`. `VSIX_FILE` is no longer exported (no other importer).
   - `vsix.spec.ts` `beforeAll` calls it. The manifest test (`readZip`) and `runInVsCode({vsix})` use the returned `vsix` instead of `join(temp, VSIX_FILE)`.
   - `scripts/lib/env.mjs` `REGISTRY` gets a new internal row: `MULTIFRONT_VSIX`, "set by the vscode-release workflow: the .vsix pnpm devx vsix packed; editor/vscode/vsix.spec.ts tests that file instead of packing its own, and the publish steps publish it".
   - With the workflow: internal rows `GITHUB_REF_NAME` ("on a release, the vscode-release workflow checks it is v<version.json>") and `GITHUB_ENV` (the workflow writes `MULTIFRONT_VSIX` there), and `secret` rows `VSCE_PAT` and `OVSX_PAT` (repository secrets the workflow hands to vsce and ovsx).
   - The `GITHUB_OUTPUT` row, own commit: it named only ci.yml's Playwright version step, and now also its pnpm store path step.
2. **`.github/workflows/vscode-release.yml`**, one job `vsix` on `ubuntu-latest`, `permissions: contents: read`, `concurrency: {group: vscode-release-${{ github.ref }}, cancel-in-progress: ${{ github.event_name == 'pull_request' }}}` (a release is never cancelled mid-publish).
   - Triggers: `release: types: [published]`, and a `pull_request` dry run to `main` when `.github/workflows/vscode-release.yml`, `packages/e2e/editor/vscode/vsix.spec.ts` or `packages/e2e/editor/lib/vsix.ts` changes.
   - Steps, the setup copied from ci.yml's `check` job:
     1. Checkout, `pnpm/action-setup@v6`, `setup-node@v5` (node 26, pnpm cache).
     2. "version.json is major.minor.patch, the release tag v + it", on PRs too. Reads `version.json`. Fails with `::error::` when the version is not plain `major.minor.patch` (the Marketplace refuses semver pre-release versions: vsce's `validateManifestForPublishing`) or, on a release only, when `$GITHUB_REF_NAME != v$version`. Nothing is packed or published after a failure. Then writes `MULTIFRONT_VSIX=${{ github.workspace }}/packages/vscode/multifront-vscode-<version>.vsix` to `$GITHUB_ENV`, so every later step has it.
     3. `pnpm install --frozen-lockfile`.
     4. `pnpm devx vsix`.
     5. ci.yml's `.vscode-test` cache, with the same key so it reuses the `check` job's cache, and `sudo sysctl -w kernel.core_pattern=/dev/null`.
     6. "Test the packed file": `pnpm devx test --reporter verbose packages/e2e/editor/vscode/vsix.spec.ts`. The harness starts its own Xvfb.
     7. "Publish to the VS Code Marketplace", `if: github.event_name == 'release'`: `pnpm exec vsce publish --packagePath "$MULTIFRONT_VSIX" --skip-duplicate`, env `VSCE_PAT: ${{ secrets.VSCE_PAT }}`. vsce reads `VSCE_PAT` itself.
     8. "Publish to Open VSX", same `if`: `pnpm exec ovsx publish "$MULTIFRONT_VSIX" --skip-duplicate`, env `OVSX_PAT: ${{ secrets.OVSX_PAT }}`. ovsx reads `OVSX_PAT` itself. Because a PAT is given, ovsx does not try OIDC, so no `id-token` permission.
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
- Review: `VSCE_PAT` and `OVSX_PAT` get `secret` rows after all. AGENTS.md lists every env var a CI step reads, the registry has a `secret` scope for credentials, and `FORCE_COLOR` sets the precedent of a row for a var only a tool reads. The milestone step text follows.
- Review: the version check runs on the PR dry run too (only the tag compare needs a release), and the `.vsix` path goes through `GITHUB_ENV` once instead of three `env:` mappings.

## Tests

Area Editor.

- `packages/e2e/editor/vscode/vsix.spec.ts` with no env var: unchanged behaviour. It runs in ci.yml's `check` job and floor jobs, and on this host (Xvfb and the cached VS Code 1.137.0 are present).
- With `MULTIFRONT_VSIX`: on this host, `pnpm devx vsix`, then `MULTIFRONT_VSIX=<abs path> pnpm devx test packages/e2e/editor/vscode/vsix.spec.ts`. Every check passes on the given file. A test that runs only when `MULTIFRONT_VSIX` is set (`it.runIf`) checks the file under test is that one, so a slip back to a fresh pack fails the release instead of publishing an untested file.
- In CI: the workflow's PR dry run runs the same thing on this PR. The PR description and the `PR` message quote its log lines showing the spec's tests executing, the `MULTIFRONT_VSIX` one included.
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
