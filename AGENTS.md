# AGENTS.md

Conventions for AI agents working in this repository.

`CLAUDE.md` is a symlink to this file, so every agent reads the same
conventions. Edit `AGENTS.md`.

This repository is the shared home of the weekly Cargo dependency batch for
mikelward's Rust repos (root, mesh): the update engine
(`update-lockfile.mjs`), the clean-context validator
(`check-rust-update.mjs`), and the reusable workflow
(`.github/workflows/rust-update.yml`). Consumers track `@main`, so **a merge
here reaches every consumer's weekly run with no release step in between.**
Everything below follows from that.

Keep this file as short as it can be and still work. Every session loads it
whole, so each rule costs context on every turn: add one the first time
something bites, say it once in the fewest words that carry the *why*,
rewrite or trim an existing rule rather than appending beside it, and delete
one that has stopped biting.

## The siblings

- **npm-update and gradle-update share this design** — trust split, cooldown,
  no-majors rule, adoption logic, docs lane. A fix to a shared mechanism here
  usually has a twin there; say so in the PR rather than letting the siblings
  drift.
- **The docs lane's engine is `mikelward/lanes`, tracked `@main`** — this
  repo carries only its policy (`.github/lanes.conf`) and the thin CI jobs
  that invoke it. Engine fixes go there, not here; the hand-synced
  `scripts/docs-lane.sh` copy this rule used to guard is gone.

## What this repository must not grow

- **No dependencies. No `package.json`, no lockfile, no build step.** What a
  consumer's workflow runs is the source here, which is what makes an
  unpinned `@main` reference reviewable by reading it. The suite runs under
  `node --test` with nothing installed.
- **The engine must execute no dependency code while anything is decided.**
  `cargo update` is inside that line (Cargo resolves without running build
  scripts or proc macros); anything that compiles a dependency is outside it
  and belongs after the fingerprint, in the consumer's checks.

## Testing

- `node --test *.test.js`. No install step — there is nothing to install.
- **Add or update tests with any change.** This suite is the only thing
  between a push and every consumer's weekly run, so a change that ships
  untested ships unreviewed.
- The suite's failure mode is a *false pass* — a set difference against an
  empty set is empty, a matcher that forgets to assert is green — so assert
  behavior, and where a check is derived from parsing a file, assert first
  that the parse found something.
- **Fix any preexisting test failure as the first commit of the series.**
  Don't stack new work on a red baseline.
- **Don't disable a failing check** to make it pass, and don't paper over a
  flaky one with sleeps or retries — fix the underlying issue.

## Error handling

- **Don't silently swallow errors.** A discarded rejection or an unchecked
  exit status here means a breaking move or a compromised release waved
  through with nothing to say so. Report what failed with enough context to
  identify it, and decide explicitly what the caller sees — the fail-closed
  direction: a blocked publish costs a rerun, a guessed pass costs the
  guarantee. To ignore a specific failure, say why in a one-line comment.

## Git and pull requests

- **Branch naming.** `<agent>/<short-topic>` — `claude/...` for Claude Code,
  `codex/...` for Codex. One topic per branch; never commit to `main`.
- **One commit per logical change.** Rewrite unmerged commits freely — amend,
  `--fixup` + autosquash, squash, reorder, split — so each commit that lands
  is coherent, with review responses folded into the commit they belong to.
  `--force-with-lease` after a rebase, never a bare `--force`.
- **Open the pull request without being asked**, ready for review, not a
  draft.
- **Refresh the title and body on every push** so they describe the branch's
  latest state, not the scope it had when opened.
- **Codex is the automated reviewer**, and its reviews are triggered
  automatically. Address its comments without being asked, folding each fix
  into the commit it belongs to. Judge every comment on merit: verify the
  claim before acting, and if it doesn't hold up, reply saying why and
  decline.
- **Never leave a review thread silently dismissed** — every thread ends in a
  reply or a resolve.

## Language and spelling

- Use **US English** everywhere people read English: prose, commit subjects
  and bodies, pull request titles and descriptions, comments, and identifiers
  — `behavior` not `behaviour`, `canceled` not `cancelled`.

## Commit messages

- A clear, plain-English subject in sentence case, short (≤ ~70 chars) and
  free of internal jargon. Mechanism and file:line detail go in the body,
  after a blank line.
- **Prefix a subject that does not change what a consumer runs**: `docs:` for
  prose, `test:` for tests alone, `build:` for this repository's own CI, and
  `refactor:` for deliberately behavior-preserving code. A bare subject means
  a consumer could notice the difference. There is no `feat:` or `fix:`, on
  purpose — they would prefix nearly everything and leave the log as flat as
  it started.

## Privacy

- **Never put user data in any artifact that leaves this machine** — commit
  subjects and bodies, pull request text, review replies, branch names,
  comments, or fixtures. That covers absolute paths containing a real name,
  hostnames, private remote URLs and tokens. Use generic placeholders
  (`/home/user/project`, `example.com`, `abc1234`) in examples and fixtures.
