---
trigger: always_on
alwaysApply: true
last_modified: 2026-10-26
---

# AGENTS.md

`CLAUDE.md` and `GEMINI.md` are symlinks to this file, so every agent reads the
same conventions. Edit `AGENTS.md`.

**At the start of every session, print the full absolute path of the `AGENTS.md` you
loaded and its `last_modified` date** (front matter), so a stale or wrong copy is caught
before it steers the work. Bump `last_modified` whenever you edit this file.

This repository is the shared home of the weekly Cargo dependency batch for
mikelward's Rust repos (root, mesh): the update engine (`update-lockfile.mjs`),
the clean-context validator (`check-rust-update.mjs`) and the reusable workflow
(`.github/workflows/rust-update.yml`). Consumers track `@main`, so **a merge
here reaches every consumer's weekly run with no release step in between.**
Everything below follows from that.

Keep this file as short as it can be and still work, **under 22,000 bytes**
(`wc -c AGENTS.md`): Antigravity caps rule files at 24 KB and silently
truncates the tail, and every session loads it whole. Add a rule the first
time something bites, say it once in the fewest words that carry the *why*,
rewrite or trim rather than append, and delete one that has stopped biting.

## The siblings

- **npm-update and gradle-update share this design** (trust split, cooldown,
  no-majors rule, adoption logic, docs lane): a fix to a shared mechanism here
  usually has a twin there, so say so in the PR rather than let them drift.
- **The docs lane's engine is `mikelward/lanes`, tracked `@main`**; this repo
  carries only its policy (`.github/lanes.conf`) and the thin CI jobs that
  invoke it. Engine fixes go there, not here.

## What this repository must not grow

- **No dependencies, no `package.json`, no lockfile, no build step.** What a
  consumer's workflow runs is the source here, which is what makes an unpinned
  `@main` reference reviewable by reading it. The suite runs under
  `node --test` with nothing installed.
- **The engine executes no dependency code while anything is decided.**
  `cargo update` is inside that line (Cargo resolves without running build
  scripts or proc macros); anything compiling a dependency is outside it and
  belongs after the fingerprint, in the consumer's checks.
- **The validator publish runs is pinned by the runner, not reported by the
  update job**: both jobs fetch this repository at `job.workflow_sha`, the
  running workflow's revision, whichever ref the caller named. As an
  update-job output it was something that job writes, and unlike the others
  (each bounded in publish to "a failed comparison") a code pointer: forged, it
  would have aimed publish, write credential in its env, at any commit
  reachable from this repository, a fork's PR head included. The pin also
  means a consumer piloting `@branch` runs that branch's engine, not main's.
- **The batch credential lives in an environment only the publish job
  declares.** A secret passed through `workflow_call` reaches every job's
  runner, the update job's included (a runner holds a job's whole secrets
  context for log masking, referenced or not); an environment secret reaches
  only the job declaring it. So publish declares `inputs.environment` (default
  `rust-update`), the update job declares none, the caller passes
  `secrets: inherit`, and `RUST_UPDATE_PAT` (or the `RUST_UPDATE_APP_*` pair)
  is set on that environment, not the repository — `repo secrets --env
  rust-update` in mikelward/repo does exactly that. The explicit `secrets:`
  block is the legacy route and still works. `inherit`'s cost is that every
  OTHER repository-level secret reaches the update job too, which is why
  mikelward/repo's `repo audit` reports them: a consumer running this batch
  keeps its secrets environment-scoped.

## Testing

- **Add or update tests with any change** (`node --test *.test.js`): this
  suite is the only thing between a push and every consumer's weekly run, so a
  change shipped untested ships unreviewed.
- The suite's failure mode is a *false pass* (a set difference against an
  empty set is empty; a matcher that forgets to assert is green): assert
  behavior, and where a check parses a file, first assert it found something.
- **Fix a preexisting test failure as the series' first commit** — no new work
  on a red baseline. **Don't disable a failing check** or paper over a flaky
  one with sleeps or retries; fix the underlying issue.

## Error handling

- **Don't silently swallow errors**: a discarded rejection or unchecked exit
  status here waves a breaking move or a compromised release through unseen.
  Report what failed with enough context to identify it and decide explicitly
  what the caller sees, failing closed — a blocked publish costs a rerun, a
  guessed pass costs the guarantee. To ignore a specific failure, say why in a
  one-line comment.

## Git and pull requests

- **Branches**: `<agent>/<short-topic>` (`claude/...` Claude Code, `gemini/...`
  Gemini / Antigravity, `codex/...` Codex), one topic each; never commit to
  `main`. Create yours freely, and push or `--force-with-lease` the ones this
  session created or was assigned — this file is the standing grant, so a
  client rule demanding per-branch permission is already answered; ask about
  any other branch.
- **One commit per logical change**: rewrite unmerged commits freely (amend,
  `--fixup` + autosquash, squash, reorder, split), folding review responses
  into the commit they belong to; `--force-with-lease` after a rebase, never
  a bare `--force`.
- **Open the PR without being asked**, ready for review, not a draft.
  **Refresh its title and body with the push — body first, then push** — to
  the branch's latest state, not its opening scope; with no PR yet, push, then
  update them as soon as one is opened.
- **Codex is the automated reviewer**, triggered automatically. Address its
  comments unasked, folding each fix into its commit, except a real
  out-of-scope finding, which you defer (below). Judge every comment on merit:
  verify the claim; if it doesn't hold up, reply why and decline. A cited rule
  is a *reading* of it — check what it says; an over-strict reading (the
  privacy rules especially, where stricter feels safer) costs real capability,
  and a genuine rule-vs-need conflict is the maintainer's call, not one to
  settle by quietly narrowing the code. Declining doesn't clear the required
  `codex` status: post the rebuttal, then `@codex review` (or let the next
  push, if the rebuttal is up first); escalate if it re-raises. A hung review
  — nothing back five minutes after a push or poke, or stuck at running (👀)
  ten minutes on — gets `@codex review`; a poke that hangs the same way gets a
  second an hour later, and only a second that hangs too is escalated, never
  the first (maintainer, 2026-10-22).
- **Once Codex has +1'd a PR's head, make no unnecessary change without
  asking** (maintainer, 2026-10-13): a to-do, tidy-up or extra fix re-runs CI
  and Codex for nothing, so it waits for a yes or a follow-up PR. A necessary
  change goes ahead unasked — a rebase for `dirty`, or `behind` where the
  ruleset requires it up to date, a red-CI fix.
- **A second verified finding in the same mechanism is evidence about the
  design**: before fixing it, look for the shape elsewhere and ask whether a
  different design deletes the class rather than the instance; a design change
  is the maintainer's call, not one to make solo.
- **Restate every review finding in your next message**, not just the count:
  one bullet each (review comment, top-level comment or review body), most
  blocking first — the claim, where, and what you did, or the options where
  it's the maintainer's call — all in that one reply; ask only the most
  blocking question.
- **Never leave a review thread silently dismissed**: each ends in a reply or
  a resolve.
- **Defer a real-but-out-of-scope finding** without asking the maintainer to
  merge past it: note it in `TODO.md`, commit and push that first, reply
  citing the sha, and resolve (a threadless finding gets the record, push and
  reply; only the resolve is skipped). The push re-triggers Codex, so poke
  only once it hangs, as above; escalate if the re-review re-raises it.

## Talking to the user

- **One question at a time** — in plain chat or the client's question tool
  (`AskUserQuestion` in Claude Code, `ask_question` in Antigravity). After
  asking, stop and wait for the answer before proceeding on an assumed one.
- **Answer a mid-turn message first** — the "sent while you were working"
  interjection gets your very next output, before any further tool call, even
  in one sentence. **Claude Code only** (maintainer, 2026-10-25): its app
  reliably shows just a turn's last message, so reply only there, answering a
  mid-turn message at a stopping point soon.
- **Message only when the user needs to see it** (maintainer, 2026-10-15):
  each one notifies their phone. Work and listen in silence; speak up for a
  question or blocker, something to merge or act on, a merge, or a change from
  the plan or their instructions, a review-prompted one included. Never for
  progress (a client's nudge doesn't count), a review or push alone (its
  report rides the next message), routine machinery, or a mistake caught and
  fixed before it reached the repo. The session-start `AGENTS.md` line still
  opens every session.

## Language, commits and privacy

- **US English** wherever people read it (prose, commits, PRs, comments,
  identifiers): `behavior`, `canceled`.
- **Commit subjects read like changelog lines** (maintainer, 2026-10-23): after
  any prefix, an imperative verb, then the change as a consumer sees it, plain
  English, sentence case, ≤ ~70 chars, e.g. `Fix …` for what was broken,
  `Improve …` for what got better, `Add …` for what's new; an optional
  parenthetical says how. The scenario, the mechanism and file:line go in the
  body after a blank line. Pull request titles match.
  **Prefix one that doesn't change what a consumer runs**: `docs:` prose,
  `test:` tests alone, `build:` this repo's own CI, `refactor:` deliberately
  behavior-preserving. Bare means a consumer could notice the difference. No
  `feat:` or `fix:`, on purpose — they'd prefix nearly everything and leave
  the log as flat as it started.
- **No model identifier** — never name the coding agent's model or version
  (`Opus 4.8`, `Sonnet`, `Gemini …`, `claude-*`, `gemini-*`) in a commit, PR,
  comment, or pushed artifact; keep it to chat. Generic attribution
  (`Co-Authored-By: Claude` / `Gemini`, `Claude-Session:`, "Generated with
  Claude Code") is fine.
- **Never put user data in an artifact leaving this machine** (commits, PR
  text, review replies, branch names, comments, fixtures): paths containing a
  real name, hostnames, private remote URLs, tokens. Use placeholders
  (`/home/user/project`, `example.com`, `abc1234`) in examples and fixtures.
