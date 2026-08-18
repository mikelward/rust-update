# rust-update

Weekly Cargo dependency batches for mikelward's Rust repos, as a reusable
GitHub Actions workflow — the Rust sibling of
[npm-update](https://github.com/mikelward/npm-update) and
[gradle-update](https://github.com/mikelward/gradle-update), for repos built
on Cargo workspaces (root, mesh).

## What it does

Once a week (the consumer owns the cron), the workflow refreshes `Cargo.lock`
via `cargo update` — every package moves to the newest eligible **stable**
release **within its semver-compatible range** — runs the consumer's own
checks against the result, and opens one batched pull request — assigned to
the repo owner, with auto-merge armed so a clean batch lands once the
consumer's required checks pass.

- **No breaking moves, direct or transitive.** Cargo's caret rule is the
  boundary: a new major — or a new minor at 0.x, or anything at 0.0.x — is a
  deliberate, human-initiated migration. Cargo's resolver already can't cross
  it for anything a manifest names; where a changed dependency's own new
  requirement would drag one of ITS dependencies across (the transitive major
  npm-update walks its lockfile for), the engine pins the dependent back to
  where it started and reports why. The newest major of each direct
  dependency is *reported* in the PR body under "Held back", never taken.
- **`Cargo.toml` is never touched.** Requirements are ranges and the lockfile
  is what pins, so the batch is a lockfile refresh — the npm shape, not the
  Gradle one. A newer compatible release the manifest's requirement excludes
  (an exact pin) is reported under "Held by the manifest requirement" rather
  than taken.
- **Release-age cooldown.** A release younger than `cooldown-days` (default
  5, matching the siblings) is skipped in favor of the next-newest eligible
  one, so a compromised release has time to be yanked before an unattended
  job takes it. Publish dates come from the crates.io API; version lists,
  yank status and checksums from the sparse index.
- **Stable only.** A pre-release never enters a batch; a pre-release the
  consumer already pins is left alone and reported as unmanaged, as are git
  dependencies and anything not from crates.io — and left alone is enforced:
  a git dependency whose unpinned branch advanced under `cargo update` is
  restored to its committed revision, a pre-release pin `cargo update`
  promoted to a newer release is restored to the pin, and a stable pin it
  moved onto a pre-release (a requirement that names one admits it) is
  pinned back to where it started, before anything is published.

**The transitive story, honestly:** stronger than gradle-update's. The
lockfile pins every transitive exactly, so the diff the publish job validates
is the complete story — there is no unlocked layer underneath it. What this
job cannot promise is that a batch always exists: a violation nothing can pin
away (a brand-new transitive whose only release is inside the cooldown, say)
fails the run loudly with the lockfile restored, and heals itself once the
release ages past the window.

## Trust model

Inherited from npm-update wholesale. Resolving versions runs `cargo update`
under the consumer's own pinned toolchain — Cargo executes **no dependency
code** to resolve (build scripts and proc macros run when something
*compiles*) — plus registry **metadata** over HTTPS. The consumer's checks
that validate the batch do compile and execute dependency code, so:

- the **update job** holds a read-only token, fingerprints the lockfile
  before the checks run, truncates `$GITHUB_PATH`/`$GITHUB_ENV` afterwards,
  and verifies nothing outside the lockfile changed — ignored paths included;
- the **publish job** runs on a fresh runner, executes no dependency code,
  re-validates the diff from a clean context (`check-rust-update.mjs`: only
  in-place, in-range, stable, upward moves and their add/remove consequences
  pass; a dependency edge crossing a compatibility boundary is refused as a
  transitive major, whether or not the old copy survives for another
  dependent), re-asks the registry that every new version exists un-yanked
  with **the registry's own checksum** and a publish date outside the
  cooldown, and walks the whole graph against the index: every edge must be
  one its dependent's version really declares, resolved to a version that
  satisfies the declared requirement, and every mandatory declaration must
  still be present as an edge (the artifact and its fingerprint both
  originate on the machine that ran the batch's own build code, so they
  alone cannot vouch for any of that). Then `cargo metadata --locked` makes
  Cargo itself vouch that the verified lockfile is exactly what resolution
  against the checked-out manifests produces — the workspace's own
  requirements included, which no registry record can answer for. It is the
  only job that can write.

Read the PR body's check results as evidence, not proof — the lockfile diff
is the part that is actually verified.

## Consuming it

A consumer keeps one small caller workflow, e.g.
`.github/workflows/rust-update.yml`:

```yaml
name: Dependency update
on:
  schedule:
    - cron: '17 6 * * 6'   # Saturdays, off the congested top of the hour
  workflow_dispatch:
permissions: {}
concurrency:
  group: rust-update
  cancel-in-progress: false
jobs:
  update:
    uses: mikelward/rust-update/.github/workflows/rust-update.yml@main
    permissions:
      contents: write
      pull-requests: write
      actions: write
```

The called workflow downscopes those permissions per job; the job that
compiles anything only ever sees `contents: read`.

Inputs (all optional): `lockfile` (default `Cargo.lock`; it must name a
`Cargo.lock` — Cargo supports no other lockfile filename), `cooldown-days`
(default 5), `checks` (commands one per line, run in the lockfile's
directory, default `cargo test --locked`), `commit-prefix` (default empty —
a bare subject; consumers whose commit conventions prefix non-behavior
changes set it), and `ci-workflow` (default empty — disabled) — a consumer
workflow dispatched against the pushed branch. A pull request opened under
GITHUB_TOKEN's identity DOES trigger a consumer's own `on: pull_request`
workflows, same as any other, but GitHub gates that run pending manual
approval, since that identity is not a repository collaborator; dispatch
sidesteps the gate. It must carry `workflow_dispatch` with a `pr` input on
the consumer's default branch.

Two optional secrets, `app-id` and `app-private-key`, let a consumer supply
a GitHub App installation instead of GITHUB_TOKEN — an App installation IS a
collaborator, so the pull requests it opens never hit the approval gate in
the first place, and `ci-workflow` becomes unnecessary. See
[`docs/GITHUB_APP.md`](docs/GITHUB_APP.md) for the one-time setup. Providing
one secret without the other is refused: a partial credential mints no
token.

What a consumer must already have: a committed `Cargo.lock`, `target/` in
`.gitignore` (the tree check refuses anything else the build drops in the
workspace), and — for unattended landing — auto-merge enabled with a ruleset
requiring its checks **with branches up to date** (strict required status
checks). The publish job verifies that policy before arming auto-merge and
falls back to a manual merge without it: auto-merge can fire long after the
run's own base-freshness check, and the head-pinned arming closes only the
arming-time race, not a later base advance. The strict policy closes the
rest — a moved base blocks the merge until someone with write access
updates the branch, and the merged tree must then pass the required checks
again — so the ruleset must require the consumer's real CI, whose
`--locked` checks refuse a lockfile the updated manifests reject. A
`rust-toolchain.toml` pin is honored automatically: rustup installs the
pinned toolchain on the first cargo invocation.

## Testing

```
node --test update-lockfile.test.js check-rust-update.test.js
```

No install step: the engine and its suite are dependency-free on purpose, so
what runs inside a consumer's workflow is exactly what a reader reads here.
