# TODO

## Reconsider later

- **`docs/PAT.md`'s personal access token is the currently used path for
  authoring the weekly PR, not `docs/GITHUB_APP.md`'s GitHub App** (repo
  owner decision, 2026-08-19, mirrored in `gradle-update`): simpler
  one-time setup while every consumer (`root`, `mesh`) is single-owner, at
  the cost of a broader-blast-radius credential tied to a real user account
  rather than the App's narrower, independently revocable, per-repo
  installation. **Switch back once a consumer repository takes external
  contributions** — a PAT's blast radius matters more once people other than
  the owner have any access to the repository or its Actions logs.
  Reversible without a workflow change: both paths are already wired into
  `rust-update.yml` (`token` takes priority over `app-id`/`app-private-key`
  if both are set), so reverting is re-pointing a consumer's `secrets:`
  block, not touching the reusable workflow.

## Decisions needing review

Recorded at creation (2026-08-18) so they get a human look:

- **Lockfile-only updates.** `Cargo.toml` is never touched; a newer
  compatible release an exact requirement excludes is reported under "Held
  by the manifest requirement" rather than taken. The alternative — bumping
  requirement floors the way `npm update --save` does — is additive later
  and reversible; starting lockfile-only keeps the diff to one generated
  file.
- **Resolution is delegated to `cargo update`,** with the cooldown and the
  no-transitive-majors rule enforced on top by `--precise` pin-backs.
  Alternative: a pure-JS resolver like the siblings' engines, which would
  make decisions reproducible off-toolchain but reimplements feature
  unification, per-target dependencies, and MSRV-aware resolution — the
  fragile kind of cleverness. Cargo executes no dependency code while
  resolving, so the trust split survives the delegation.
- **A violation nothing can pin away fails the run loudly** with the
  lockfile restored (the common case: a brand-new transitive whose only
  release is inside the cooldown). It heals itself once the release ages
  out. Alternative: revert only the top-level bump that dragged it in and
  retry — smarter, unimplemented, and the failure mode of the simple
  version is a missed week, not a bad publish.
- **Default checks are `cargo test --locked`** — consumers override
  (root: `make test`; mesh adds clippy). `--locked` so a check cannot
  quietly re-resolve what the engine settled.
- **No cargo caching in the update job.** A cache action in the untrusted
  window is new third-party attack surface with write access to what later
  runs restore; the cost is a cold registry fetch and build per weekly run.
- **Codex's duplicate-versions finding was accepted for path packages only**
  (2026-08-18): sourceless path packages now group by exact version, since
  renamed path dependencies can hold one name at compatible versions. The
  registry half was declined — Cargo's resolver errors on conflicting exact
  requirements inside one compatibility range rather than locking both, so
  one-version-per-group-per-source stays enforced for sourced packages.
  Reversible: the grouping key is one expression in each of three places.
- **A declined pre-release move is silent in the PR report** (2026-08-18):
  a stable pin cargo moved onto a pre-release is pinned back but not
  reported, matching how pre-releases never count as candidates anywhere in
  the report. Alternative: a "declined pre-releases" section — additive
  later if a consumer wants the visibility.

## Port from gradle-update once v1 lands

- **The license-check machinery** (gradle-update PR #12): `review-checks`
  (flag a batch for human review without failing it, command output captured
  into the PR body's Review section) and `regenerate` / `regenerated-files`
  (derived files rebuilt and committed with the batch, fingerprinted and
  validated). Motivated there by license inventories; port when a Rust
  consumer grows one (`cargo deny` / `cargo about` output would be the
  analog).

## Known gaps

- **The publish-path branch logic** (adoption, supersession, auto-merge
  arming with the strict-policy probe) is ported from gradle-update but has
  not yet run end-to-end here; the first consumer runs are the shakedown.
  One gap already caught by inspection while adding PAT support
  (2026-08-19): the strict-policy probe read the ambient, PAT/App-preferring
  `GH_TOKEN` instead of overriding to `$DEFAULT_TOKEN` the way the other
  Actions-API reads in this job do — neither credential's documented
  permissions cover `rules/branches`, so this would have failed under
  `set -e` for any consumer with either wired up. Fixed; the rest of this
  entry stands.
- **Codex didn't auto-review the first App-opened PR** (mesh#533; fixed
  2026-08-19). The "Open the pull request" step now posts `@codex review`
  itself whenever this run opened the PR under a non-default identity
  (`nondefault_opened_pr` — a PAT or a minted App token; the same nudge now
  also covers a PAT-opened PR, unconfirmed to have the same gap but cheap
  insurance either way). Harmless if Codex already reacted on its own. Based
  on one data point, not a confirmed root cause; `gradle-update.yml` already
  carries the same nudge, ported alongside PAT support.

## Review and merge gates

- [ ] **Decide whether to pin `actions/create-github-app-token` by SHA**,
      matching every other third-party action in `rust-update.yml`
      (`actions/checkout`, `actions/upload-artifact`,
      `actions/download-artifact`). Left on `@v2` for now — the repo owner
      is undecided. Worth weighing seriously rather than deferred by
      default: this is the one action in the file that handles a private
      key and mints a write-scoped token, arguably the most sensitive thing
      here to leave unpinned.
- [x] Add `codex-review-check.yml` (mikelward/codex-review's consumer
      check): Codex reviews run here, but nothing verifies the workflow
      pin the ruleset should require.
- [ ] Verify the settings half of the fleet's bar: a ruleset on the
      default branch requiring the CI gate, the `codex` status,
      conversation resolution and up-to-date branches, and the auto-merge
      setting enabled.
## Consumers

- [x] `root` and `mesh` are both wired up (`root` also gained its first
      `ci.yml` in the same pass). Live shakedown surfaced the
      first-time-contributor approval gate `docs/GITHUB_APP.md` and this
      file's App-token support address.
