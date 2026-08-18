# TODO

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

## Review and merge gates

- [ ] Add `codex-review-check.yml` (mikelward/codex-review's consumer
      check): Codex reviews run here, but nothing verifies the workflow
      pin the ruleset should require.
- [ ] Verify the settings half of the fleet's bar: a ruleset on the
      default branch requiring the CI gate, the `codex` status,
      conversation resolution and up-to-date branches, and the auto-merge
      setting enabled.

## Consumers

- [ ] Wire up `root` first (smallest dependency set, and the setuid binary
      is where the cooldown earns the most): caller workflow, plus
      `workflow_dispatch` with a `pr` input on its CI if it wants the
      dispatch. Then `mesh`, after a week of watching root's runs.
