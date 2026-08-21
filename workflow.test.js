// Tests for shell logic inside .github/workflows/rust-update.yml itself —
// this repository ships no YAML parser on purpose (see zizmor.test.js), so
// these are regex assertions over the raw file text, the same convention.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, chmodSync, rmSync, readdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

const workflow = readFileSync(".github/workflows/rust-update.yml", "utf8");

test("the strict-policy probe pipes --slurp's output into a separate jq, never combined with --jq", () => {
  // `gh api` rejects --slurp combined with --jq outright ("the --slurp
  // option is not supported with --jq or --template") — a regression here
  // is silent everywhere else: `|| strict=false` swallows the failure and
  // the run just falls back to a manual merge, so nothing red ever reports
  // it. First assert the probe was actually found, so this test fails
  // loudly if the line moves or is reworded rather than passing vacuously.
  const probe = /strict=\$\(GH_TOKEN="\$DEFAULT_TOKEN" gh api --paginate --slurp [^\n]*\\\n\s*\|\s*jq /;
  assert.match(workflow, probe, "the strict-policy probe's gh api | jq pipeline was not found");

  // The specific regression: --jq attached directly to the same `gh api`
  // invocation that also carries --slurp.
  const combined = /gh api[^\n]*--slurp[^\n]*--jq|gh api[^\n]*--jq[^\n]*--slurp/;
  assert.doesNotMatch(workflow, combined, "--slurp and --jq must not appear on the same gh api invocation");
});

test("the strict-policy probe overrides GH_TOKEN to github.token, never the PAT/App-preferring one", () => {
  // Ported from gradle-update but had not run end-to-end here (TODO.md
  // "Known gaps") — this probe was still reading the ambient, PAT/App-
  // preferring $GH_TOKEN, which would fail under set -e for any consumer
  // that wired up either credential (neither docs/PAT.md's nor
  // docs/GITHUB_APP.md's permissions cover Administration:read).
  assert.match(
    workflow,
    /strict=\$\(GH_TOKEN="\$DEFAULT_TOKEN" gh api --paginate --slurp/,
    "the strict-policy probe must override GH_TOKEN to $DEFAULT_TOKEN",
  );
});

test("a half-supplied App credential is refused through env, never secrets, in its if:, but only when no PAT is set", () => {
  // The secrets context is unusable directly in a reusable workflow's own
  // if: conditions — referencing secrets.app-id here would silently break
  // the refusal, not just read wrong, so assert the env-based form is what
  // actually ships. Gated on env.PAT == '' too: once a token takes
  // priority, a leftover half-removed app-id from a PAT migration is
  // irrelevant and must not fail the run.
  const refuse = /if: env\.PAT == '' && \(env\.APP_ID == ''\) != \(env\.APP_PRIVATE_KEY == ''\)/;
  assert.match(workflow, refuse, "the half-credential refusal step's if: was not found reading env.PAT/env.APP_ID/env.APP_PRIVATE_KEY");
  assert.doesNotMatch(workflow, /if:\s*\(secrets\.app-id/, "the refusal step must not test secrets.app-id directly");
});

test("the App token mint is skipped once a PAT is set, even with a full App credential", () => {
  // Minting an installation token that GH_TOKEN resolution then discards
  // unused (PAT takes priority) is a needless credential mint — skip the
  // step entirely rather than mint-and-ignore.
  assert.match(workflow, /if: env\.PAT == '' && env\.APP_ID != ''/, "the mint step's if: must require env.PAT == '' before env.APP_ID != ''");
});

test("the App token is minted from env, scoped explicitly to contents and pull-requests", () => {
  const mint = /uses: actions\/create-github-app-token@v2\s*\n\s*with:\s*\n\s*app-id: \$\{\{ env\.APP_ID \}\}\s*\n\s*private-key: \$\{\{ env\.APP_PRIVATE_KEY \}\}/;
  assert.match(workflow, mint, "the mint step's app-id/private-key inputs were not found reading from env.APP_ID/env.APP_PRIVATE_KEY");

  // Without these the minted token silently inherits the App's whole
  // installation grant instead of just what this job uses (zizmor's
  // github-app audit catches this too, but that's advisory — this suite is
  // the one that actually gates the merge).
  assert.match(workflow, /permission-contents: write/, "the minted token must be scoped to permission-contents explicitly");
  assert.match(workflow, /permission-pull-requests: write/, "the minted token must be scoped to permission-pull-requests explicitly");
});

test("every GH_TOKEN in the publish job prefers a PAT, then the minted App token, then github.token", () => {
  const ghTokenLines = [...workflow.matchAll(/GH_TOKEN: (\$\{\{[^\n]*\}\})/g)].map((m) => m[1]);
  assert.ok(ghTokenLines.length >= 2, "expected at least two GH_TOKEN assignments in the publish job");
  for (const line of ghTokenLines) {
    assert.match(line, /env\.PAT \|\| steps\.app-token\.outputs\.token \|\| github\.token/, `GH_TOKEN did not prefer PAT, then the App token, found: ${line}`);
  }
});

test("the token secret is declared optional and read into env.PAT", () => {
  assert.match(workflow, /^\s*token:\s*$/m, "the reusable workflow must declare a token secret");
  assert.match(workflow, /PAT: \$\{\{ secrets\.token \}\}/, "the publish job must read secrets.token into env.PAT");
});

test("the Actions-API run-timestamp read stays on github.token, never the PAT/App-preferring GH_TOKEN", () => {
  // docs/PAT.md and docs/GITHUB_APP.md deliberately grant only Contents and
  // pull requests, not Actions — this read would fail under set -e for any
  // consumer that wired up either credential, silently before it even
  // opens the branch or the PR, if it ever went back to reading $GH_TOKEN.
  assert.match(workflow, /DEFAULT_TOKEN: \$\{\{ github\.token \}\}/, "DEFAULT_TOKEN (always github.token, never PAT or the App token) was not found");
  const read = /created=\$\(GH_TOKEN="\$DEFAULT_TOKEN" gh api "repos\/\$\{GITHUB_REPOSITORY\}\/actions\/runs\/\$\{GITHUB_RUN_ID\}" --jq \.created_at\)/;
  assert.match(workflow, read, "the actions/runs read must override GH_TOKEN to $DEFAULT_TOKEN for just this one command");
});

test("the CI dispatch also overrides GH_TOKEN to github.token, never the PAT/App-preferring one", () => {
  // This branch runs precisely when a PAT or App token was available but
  // didn't open the PR (nondefault_opened_pr false with
  // NONDEFAULT_TOKEN_USED true — an adopted rerun of a pre-existing
  // default-token PR), so the ambient $GH_TOKEN can still be that
  // credential here. `gh workflow run` is an Actions API write neither
  // docs/PAT.md's nor docs/GITHUB_APP.md's two documented permissions
  // cover, so it must not run under the ambient token either.
  const dispatch = /if GH_TOKEN="\$DEFAULT_TOKEN" gh workflow run "\$CI_WORKFLOW" --ref "\$branch" -f pr="\$pr"; then/;
  assert.match(workflow, dispatch, "the CI dispatch must override GH_TOKEN to $DEFAULT_TOKEN, the same way the actions/runs read does");
});

test("the CI dispatch and its PR-body claim key off nondefault_opened_pr, not the raw NONDEFAULT_TOKEN_USED flag", () => {
  assert.match(
    workflow,
    /if \[ "\$nondefault_opened_pr" != 'true' \] && \[ -n "\$CI_WORKFLOW" \]; then/,
    "the dispatch-skip condition was not found keyed on nondefault_opened_pr",
  );
  assert.match(
    workflow,
    /if \[ "\$nondefault_opened_pr" = 'true' \] && \[ -n "\$PAT" \]; then/,
    "the PAT PR-body message-selection branch was not found keyed on nondefault_opened_pr",
  );
  assert.match(
    workflow,
    /elif \[ "\$nondefault_opened_pr" = 'true' \]; then/,
    "the App PR-body message-selection branch was not found keyed on nondefault_opened_pr",
  );

  // nondefault_opened_pr must require THIS run to have put the real
  // identity on the wire (a fresh push or a fresh `gh pr create`) — an
  // adopted rerun that reuses an existing PR proves nothing about who
  // opened it, so NONDEFAULT_TOKEN_USED alone (this invocation merely had
  // a credential available) must not be sufficient on its own.
  assert.match(
    workflow,
    /if \[ "\$NONDEFAULT_TOKEN_USED" = 'true' \] && \{ \[ "\$adopt" != true \] \|\| \[ "\$pr_opened_here" = true \]; \}; then/,
    "nondefault_opened_pr's derivation must require adopt != true or pr_opened_here, not NONDEFAULT_TOKEN_USED by itself",
  );
});

test("the PR-body message distinguishes a PAT-opened PR from an App-opened one", () => {
  assert.match(workflow, /opened under a personal access token/, "the PAT-specific PR-body wording was not found");
  assert.match(workflow, /opened under a GitHub App installation/, "the App-specific PR-body wording was not found");
});

test("a PAT- or App-opened PR gets an explicit @codex review nudge, retried like the body edit", () => {
  // mesh#533, the first PR this workflow opened under the App's identity,
  // got no automatic Codex review — the connector's webhook trigger
  // apparently doesn't fire the same way it does for a human or
  // GITHUB_TOKEN-authored PR. A PAT's identity is a real user account
  // rather than an App or a bot, so it likely gets the native trigger, but
  // that's unconfirmed, so the nudge fires for either credential rather
  // than betting the merge gate on an assumption. A required `codex`
  // status that never gets set would otherwise leave the PR silently
  // stuck. Gated on nondefault_opened_pr, not unconditional: there's no
  // evidence of the gap on the GITHUB_TOKEN path, and nudging every PR
  // would just be noise.
  //
  // Retried: a rerun of a failed attempt doesn't get a second chance at
  // this block (a later rerun adopts the existing PR, and
  // nondefault_opened_pr goes false with it), so a transient gh pr comment
  // failure without a retry here would strand the PR with no automatic
  // recovery path — a Codex finding on the PR that added this nudge
  // (mikelward/rust-update#6).
  const nudge = /if \[ "\$nondefault_opened_pr" = 'true' \]; then\s*\n\s*nudged=false\s*\n\s*for _ in 1 2 3; do\s*\n\s*if gh pr comment "\$pr" --body '@codex review'; then/;
  assert.match(workflow, nudge, "the retried @codex review nudge, gated on nondefault_opened_pr, was not found");
});

test("the workflow declares an explicit empty top-level permissions block", () => {
  // Every job already declares its own downscoped permissions, so this
  // line grants nothing to any job that has one — but if it were removed
  // or moved below `jobs:`, a job added later without its own block would
  // silently inherit whatever the calling job granted instead of getting
  // no ambient token. Anchored to appear before `jobs:` so a regression
  // that re-adds it in the wrong place still fails this.
  const jobsIndex = workflow.indexOf("\njobs:");
  assert.notEqual(jobsIndex, -1, "the `jobs:` delimiter was not found in the workflow");
  const beforeJobs = workflow.slice(0, jobsIndex);
  assert.match(
    beforeJobs,
    /^permissions: \{\}$/m,
    "the top-level `permissions: {}` fallback was not found before `jobs:`",
  );
});

// The tree check (the "Verify only the lockfile changed" step's unexpected/
// planted computation) reads `git status --porcelain -z` through a direct
// pipe under `lastpipe`, classifying each whole NUL-terminated record. This
// guards against three bugs earlier forms had: a `tr '\0' '\n'` conversion
// let an untracked filename with an embedded newline split into two lines
// and hide behind an allowlist entry (verified directly: a file named
// "\nXXXchecks.md" vanished completely under that pipeline, `unexpected`
// coming back empty even though the file was there); a trailing `|| true`
// swallowed a genuine `git status` failure the same way it swallowed
// grep's ordinary no-matches exit 1; and — the reason this is a pipe and
// not a temp file, per Codex's review of the interim mktemp fix — reading
// a scratch file back by NAME reopens a window between the write and the
// read for anything already watching $RUNNER_TEMP to swap its content,
// which mktemp's unpredictable name narrows but does not close. Ported
// from the identical fix applied to mikelward/gradle-update and
// mikelward/npm-update (whose simpler shape doesn't need the pipe form,
// since capture_and_restore there re-reads a list across two separate
// loops with real work between them — this workflow has no such step).
test("the tree check reads NUL-terminated records through a direct pipe, not a tr-joined `|| true` pipe or a scratch file", () => {
  const riskyJoin = /git status --porcelain[^\n]*\\\n[^\n]*\| tr '\\\\0'/;
  assert.doesNotMatch(workflow, riskyJoin, "a git-status-into-tr pipeline reappeared — see the rust-update-nul-safety fix");
  assert.doesNotMatch(workflow, /_z=\$\(mktemp/, "a scratch-file variable reappeared — see the direct-pipe fix");

  const readLoops = [...workflow.matchAll(/while IFS= read -r -d '' entry; do/g)];
  assert.equal(readLoops.length, 2, `expected 2 NUL-record read loops, found ${readLoops.length}`);
});

// Extracts the tree-check block from the real file text (not a hand-copied
// literal) so a future edit that reintroduces either bug, or removes the
// fix, breaks this test rather than drifting unnoticed.
function extractTreeCheckBlock(text) {
  const startMarker = 'allow=("$LOCKFILE" checks.md deps-stat.txt report.md)';
  const start = text.indexOf(startMarker);
  assert.notEqual(start, -1, "tree-check block start marker not found in rust-update.yml");
  const plantedIfMarker = 'if [ -n "$planted" ]; then';
  const plantedIfStart = text.indexOf(plantedIfMarker, start);
  assert.notEqual(plantedIfStart, -1, "tree-check block's planted-check if not found");
  const fiEnd = text.indexOf("\n          fi\n", plantedIfStart);
  assert.notEqual(fiEnd, -1, "tree-check block's closing fi not found");
  const raw = text.slice(start, fiEnd + "\n          fi".length);
  return raw.replace(/^ {10}/gm, "");
}

const treeCheckBlock = extractTreeCheckBlock(workflow);

function runTreeCheckBlock(repoDir, runnerTemp, lockfile, extraPath = "") {
  // shopt -s lastpipe first: the extracted block relies on it (the tree
  // check's own `run:` script sets it before `set -euo pipefail`, one line
  // above where this extraction starts).
  const script = `shopt -s lastpipe\nset -euo pipefail\ncd "$1"\nLOCKFILE="$2"\nRUNNER_TEMP="$3"\n${treeCheckBlock}\necho OK\n`;
  const env = { ...process.env, PATH: `${extraPath}${extraPath ? ":" : ""}${process.env.PATH}` };
  return execFileSync("bash", ["-c", script, "bash", repoDir, lockfile, runnerTemp], { encoding: "utf8", env });
}

function initRepo(dir) {
  mkdirSync(dir, { recursive: true });
  const git = (...args) => execFileSync("git", args, { cwd: dir });
  git("init", "-q");
  git("config", "user.email", "test@example.com");
  git("config", "user.name", "test");
  writeFileSync(join(dir, "Cargo.lock"), "x");
  writeFileSync(join(dir, "checks.md"), "x");
  writeFileSync(join(dir, "deps-stat.txt"), "x");
  writeFileSync(join(dir, "report.md"), "x");
  git("add", "Cargo.lock", "checks.md", "deps-stat.txt", "report.md");
  git("commit", "-q", "-m", "init");
}

test("the tree check passes on a clean tree", () => {
  const repoDir = mkdtempSync(join(tmpdir(), "rust-update-treecheck-"));
  const runnerTemp = mkdtempSync(join(tmpdir(), "rust-update-runnertemp-"));
  try {
    initRepo(repoDir);
    const out = runTreeCheckBlock(repoDir, runnerTemp, "Cargo.lock");
    assert.match(out, /OK/);
  } finally {
    rmSync(repoDir, { recursive: true, force: true });
    rmSync(runnerTemp, { recursive: true, force: true });
  }
});

test("the tree check catches an untracked file whose name hides a second record behind an embedded newline", () => {
  const repoDir = mkdtempSync(join(tmpdir(), "rust-update-treecheck-"));
  const runnerTemp = mkdtempSync(join(tmpdir(), "rust-update-runnertemp-"));
  try {
    initRepo(repoDir);
    writeFileSync(join(repoDir, "\nXXXchecks.md"), "x");
    assert.throws(
      () => runTreeCheckBlock(repoDir, runnerTemp, "Cargo.lock"),
      /The batch touched files outside the lockfile/,
      "the adversarial untracked file was not detected — the NUL-safety fix regressed",
    );
  } finally {
    rmSync(repoDir, { recursive: true, force: true });
    rmSync(runnerTemp, { recursive: true, force: true });
  }
});

test("the tree check fails closed when git status itself fails, instead of the trailing `|| true` swallowing it", () => {
  const repoDir = mkdtempSync(join(tmpdir(), "rust-update-treecheck-"));
  const runnerTemp = mkdtempSync(join(tmpdir(), "rust-update-runnertemp-"));
  const binDir = mkdtempSync(join(tmpdir(), "rust-update-fakegit-"));
  try {
    initRepo(repoDir);
    const realGit = execFileSync("command", ["-v", "git"], { shell: "/bin/bash", encoding: "utf8" }).trim();
    const shim = `#!/bin/sh\nif [ "$1" = status ]; then echo "fatal: fake git status failure" >&2; exit 128; fi\nexec "${realGit}" "$@"\n`;
    const shimPath = join(binDir, "git");
    writeFileSync(shimPath, shim);
    chmodSync(shimPath, 0o755);
    assert.throws(
      () => runTreeCheckBlock(repoDir, runnerTemp, "Cargo.lock", binDir),
      (err) => {
        assert.notEqual(err.status, 0, "a fake git-status failure did not stop the script — the status-swallow fix regressed");
        assert.doesNotMatch(err.stdout?.toString() ?? "", /OK/, "the script reached its success echo despite git status failing");
        return true;
      },
    );
  } finally {
    rmSync(repoDir, { recursive: true, force: true });
    rmSync(runnerTemp, { recursive: true, force: true });
    rmSync(binDir, { recursive: true, force: true });
  }
});

// Codex found two rounds on this check: first that the original fixed
// scratch-file names were predictable (fixed with mktemp), then that even
// an unpredictable mktemp'd name is reopened by pathname for reading a
// moment after git status writes it — a window a process already running
// and watching $RUNNER_TEMP (left behind by a build script from the checks
// above) could in principle win, discovering the name the instant mktemp
// creates it and swapping the content before the read loop opens it. The
// real fix is structural, not another mktemp variant: a direct pipe has no
// name on disk at all for anything to discover. `shopt -s lastpipe` keeps
// the read loop in the CURRENT shell (so its variables survive past the
// pipe) rather than a subshell, and `pipefail` still catches a genuine git
// status failure the same way the temp-file form's bare command did.
test("both tree checks use a direct pipe under lastpipe, not a scratch file", () => {
  assert.match(workflow, /^\s*shopt -s lastpipe\s*$/m, "shopt -s lastpipe was not found ahead of the tree-check step's set -euo pipefail");
  assert.doesNotMatch(workflow, /_z=\$\(mktemp/, "a scratch-file variable reappeared — the tree checks should pipe directly, not write to a temp file");

  const pipes = [...workflow.matchAll(/git status --porcelain -z [^\n|]*\| while IFS= read -r -d '' entry; do/g)];
  assert.equal(pipes.length, 2, `expected 2 direct git-status-into-while pipes (unexpected, planted), found ${pipes.length}`);
});

test("no scratch file is left in $RUNNER_TEMP by either tree check, on a clean pass or a detected one", () => {
  const repoDir = mkdtempSync(join(tmpdir(), "rust-update-nofile-"));
  const runnerTemp = mkdtempSync(join(tmpdir(), "rust-update-runnertemp-"));
  try {
    initRepo(repoDir);
    runTreeCheckBlock(repoDir, runnerTemp, "Cargo.lock");
    assert.deepEqual(readdirSync(runnerTemp), [], "the clean-pass run left a file behind in $RUNNER_TEMP");
    writeFileSync(join(repoDir, "evil-untracked-file.txt"), "x");
    try {
      runTreeCheckBlock(repoDir, runnerTemp, "Cargo.lock");
    } catch {
      // Expected — the check exits 1 on the untracked file. What matters
      // here is only that it still left nothing behind to race against.
    }
    assert.deepEqual(readdirSync(runnerTemp), [], "the detecting run left a file behind in $RUNNER_TEMP");
  } finally {
    rmSync(repoDir, { recursive: true, force: true });
    rmSync(runnerTemp, { recursive: true, force: true });
  }
});

// A false pipefail trip Codex found on review of the direct-pipe fix
// above: the loop's per-record `[ "$keep" -eq 1 ] && var="$var$path"\n`
// used the LAST record's own test as the loop's own exit status once the
// git-status pipe made it part of a pipeline — an ALLOWLISTED record
// (keep=0, the common case: every normal run's own modified lockfile and
// report files) makes that `[ ]` test false, so under `pipefail` the whole
// pipe — and the step, under `set -e` — would exit nonzero on every
// ordinary run, even with nothing actually wrong. Verified directly:
// `shopt -s lastpipe; set -eo pipefail; printf 'a\0' | while IFS= read -r
// -d '' e; do [ 0 -eq 1 ] && x=1; done; echo unreached` never reaches
// "unreached". Fixed with `if`/`fi` (always exits 0 when its condition is
// false), not `[ ... ] &&`.
test("a normal run with only allowlisted changes does not abort the tree check", () => {
  const repoDir = mkdtempSync(join(tmpdir(), "rust-update-allowlisted-"));
  const runnerTemp = mkdtempSync(join(tmpdir(), "rust-update-runnertemp-"));
  try {
    initRepo(repoDir);
    // The two ordinary things a real batch changes: the lockfile itself,
    // and the report the "Run the checks" step already wrote.
    writeFileSync(join(repoDir, "Cargo.lock"), "y");
    writeFileSync(join(repoDir, "checks.md"), "y");
    const out = runTreeCheckBlock(repoDir, runnerTemp, "Cargo.lock");
    assert.match(out, /OK/, "a run with only allowlisted changes aborted instead of passing");
  } finally {
    rmSync(repoDir, { recursive: true, force: true });
    rmSync(runnerTemp, { recursive: true, force: true });
  }
});

test("--no-renames is present on both git status -z invocations", () => {
  const calls = [...workflow.matchAll(/git status --porcelain -z [^\n|]*\|/g)].map((m) => m[0]);
  assert.equal(calls.length, 2, `expected 2 git status -z invocations, found ${calls.length}`);
  for (const call of calls) {
    assert.match(call, /--no-renames/, `git status -z call missing --no-renames: ${call}`);
  }
});

test("a staged rename onto an allowlisted destination doesn't hide the source path going missing", () => {
  // Without --no-renames, `git status --porcelain -z` on a staged rename
  // emits the destination as a normal "XY path" record and the SOURCE as a
  // bare path with no status prefix at all — this loop's `${entry:3}`
  // strips the first 3 bytes of every record uniformly, so on that second,
  // prefix-less field it eats 3 bytes of the real old path instead. Picking
  // an old path whose first 3 bytes are exactly what's needed to land the
  // corrupted result on the allowlist (here: renaming "XXXchecks.md" onto
  // "checks.md" corrupts the old-path field into "checks.md" too) makes the
  // rename disappear from `unexpected` entirely. Codex found this on review
  // of the direct-pipe fix.
  const repoDir = mkdtempSync(join(tmpdir(), "rust-update-rename-"));
  const runnerTemp = mkdtempSync(join(tmpdir(), "rust-update-runnertemp-"));
  try {
    initRepo(repoDir);
    const git = (...args) => execFileSync("git", args, { cwd: repoDir });
    writeFileSync(join(repoDir, "XXXchecks.md"), "some content long enough for git to treat this as a rename rather than an add+delete pair");
    git("add", "XXXchecks.md");
    git("commit", "-q", "-m", "add XXXchecks.md");
    git("mv", "-f", "XXXchecks.md", "checks.md");
    assert.throws(
      () => runTreeCheckBlock(repoDir, runnerTemp, "Cargo.lock"),
      /The batch touched files outside the lockfile/,
      "a staged rename was not detected — the source path (XXXchecks.md) went missing without --no-renames",
    );
  } finally {
    rmSync(repoDir, { recursive: true, force: true });
    rmSync(runnerTemp, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// The check-runner loop and the publish-side verdict derivation. The update
// job's checks step runs unreviewed dependency code, so publish must never
// read a pass/fail boolean that step reported about itself — it derives the
// verdict from checks.md, whose bytes it first verified against the
// fingerprint captured in the runner's control plane. Ported from the
// identical fix in mikelward/npm-update (see its AGENTS.md "Trust model").
// ---------------------------------------------------------------------------

function extractChecksLoopBlock(text) {
  const startMarker = 'checkdir=$(dirname -- "$LOCKFILE")';
  const start = text.indexOf(startMarker);
  assert.notEqual(start, -1, "checks-loop block start marker not found in rust-update.yml");
  const endMarker = 'done <<< "$CHECKS"';
  const end = text.indexOf(endMarker, start);
  assert.notEqual(end, -1, "checks-loop block end marker not found");
  const raw = text.slice(start, end + endMarker.length);
  return raw.replace(/^ {10}/gm, "");
}

test("a check that drains stdin cannot swallow the commands after it", () => {
  // The loop feeds itself through a herestring, and each eval'd check used
  // to inherit that herestring as its own stdin — so a check that reads
  // stdin (cargo's own client does; so does anything piping through
  // `cat`) DRAINED the remaining commands: the loop ended early, the unrun
  // checks never reported, failed stayed 0, and the batch titled itself
  // clean on checks that never ran. Verified against the exact loop
  // structure before fixing: with the redirect absent, this case records
  // one ✅ line and exits with failed=0.
  assert.match(
    extractChecksLoopBlock(workflow),
    /\) < \/dev\/null\n\s*rc=\$\?/,
    "the eval subshell no longer redirects stdin — the herestring-drain fix regressed",
  );

  const dir = mkdtempSync(join(tmpdir(), "rust-update-checksloop-"));
  try {
    writeFileSync(join(dir, "Cargo.lock"), "x");
    const script = [
      'cd "$1"',
      'LOCKFILE="Cargo.lock"',
      "CHECKS=$'cat > /dev/null\\nfalse'",
      "failed=0",
      ": > checks.md",
      extractChecksLoopBlock(workflow),
      'echo "failed=$failed"',
    ].join("\n");
    const out = execFileSync("bash", ["-c", script, "bash", dir], { encoding: "utf8" });
    const checksMd = readFileSync(join(dir, "checks.md"), "utf8");
    assert.equal(
      checksMd,
      "- ✅ `cat > /dev/null`\n- ❌ `false` (exit 1)\n",
      "the stdin-draining first check swallowed the second — it never ran or never reported",
    );
    assert.match(out, /failed=1/, "the failing second check did not set failed=1");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the update job exports no passed output; publish wires the verdict from its own derivation", () => {
  // The boolean the untrusted job reported about itself is gone as an
  // output, checks.md is fingerprinted in the same control-plane channel
  // as the lockfile, publish verifies the downloaded copy against that
  // fingerprint, and the PR step's PASSED comes from publish's own
  // verdict step — the single place a false "all checks passed" can now
  // come from is the file publish just verified.
  assert.doesNotMatch(workflow, /passed: \$\{\{ steps\.checks\.outputs\.passed \}\}/);
  assert.doesNotMatch(workflow, /needs\.update\.outputs\.passed/);
  assert.match(workflow, /checks_sha: \$\{\{ steps\.checks\.outputs\.checks_sha \}\}/);
  assert.match(workflow, /checks_sha=\$\(sha256sum checks\.md \| cut -d' ' -f1\)/);
  assert.match(workflow, /CHECKS_SHA: \$\{\{ needs\.update\.outputs\.checks_sha \}\}/);
  assert.match(
    workflow,
    /\[ "\$\(sha256sum -- checks\.md \| cut -d' ' -f1\)" = "\$CHECKS_SHA" \]/,
    "publish no longer verifies checks.md against the update job's fingerprint",
  );
  assert.match(workflow, /PASSED: \$\{\{ steps\.verdict\.outputs\.passed \}\}/);
});

function extractVerdictBlock(text) {
  const startMarker = "declare -A expected_count recorded_count";
  const start = text.indexOf(startMarker);
  assert.notEqual(start, -1, "verdict block start marker not found in rust-update.yml");
  const endMarker = "echo 'passed=true' >> \"$GITHUB_OUTPUT\"\n          fi";
  const end = text.indexOf(endMarker, start);
  assert.notEqual(end, -1, "verdict block end marker not found");
  const raw = text.slice(start, end + endMarker.length);
  return raw.replace(/^ {10}/gm, "");
}

function runVerdictBlock(checksInput, checksMdContent) {
  const dir = mkdtempSync(join(tmpdir(), "rust-update-verdict-"));
  try {
    writeFileSync(join(dir, "checks.md"), checksMdContent);
    const outputFile = join(dir, "github_output");
    writeFileSync(outputFile, "");
    const script = `cd "$1"\nset -euo pipefail\n${extractVerdictBlock(workflow)}\n`;
    execFileSync("bash", ["-c", script, "bash", dir], {
      encoding: "utf8",
      env: { ...process.env, CHECKS: checksInput, GITHUB_OUTPUT: outputFile },
    });
    return readFileSync(outputFile, "utf8");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("a configured check containing backticks still round-trips through the verdict", () => {
  // Codex review: the first derivation parsed the command back out of its
  // backtick delimiters with [^`]+, so a configured check that itself
  // contains backticks (echo `date`, legal shell) wrote a line the parser
  // refused — failing a batch whose check genuinely passed. Lines are now
  // matched against the expected renderings built from the trusted
  // config, which has no delimiter blind spot.
  const checks = "echo `date`";
  assert.match(runVerdictBlock(checks, "- ✅ `echo `date``\n"), /passed=true/);
  assert.match(runVerdictBlock(checks, "- ❌ `echo `date`` (exit 1)\n"), /passed=false/);
});

test("the derived verdict passes only a checks.md that exactly matches the configured checks, all green", () => {
  const checks = "cargo test --locked\ncargo clippy";
  const green = "- ✅ `cargo test --locked`\n- ✅ `cargo clippy`\n";
  assert.match(runVerdictBlock(checks, green), /passed=true/);

  // Order doesn't matter — the loop records counts, not positions.
  const reordered = "- ✅ `cargo clippy`\n- ✅ `cargo test --locked`\n";
  assert.match(runVerdictBlock(checks, reordered), /passed=true/);

  // A final line missing its trailing newline is still validated, not
  // silently dropped by `while read`.
  const noTrailing = "- ✅ `cargo test --locked`\n- ✅ `cargo clippy`";
  assert.match(runVerdictBlock(checks, noTrailing), /passed=true/);

  // A configured check listed twice runs twice and must be recorded twice.
  const doubled = "cargo test --locked\ncargo test --locked";
  const doubledMd = "- ✅ `cargo test --locked`\n- ✅ `cargo test --locked`\n";
  assert.match(runVerdictBlock(doubled, doubledMd), /passed=true/);
});

test("the derived verdict fails closed on every malformed, mismatched, or failing checks.md", () => {
  const checks = "cargo test --locked\ncargo clippy";
  const cases = [
    // A recorded failure.
    ["- ✅ `cargo test --locked`\n- ❌ `cargo clippy` (exit 101)\n", "a ❌ line"],
    // An empty file while checks are configured: every configured check is
    // missing its record.
    ["", "an empty checks.md"],
    // One configured check silently absent.
    ["- ✅ `cargo test --locked`\n", "a missing check record"],
    // A duplicate ✅ padding out for the missing one — counts must match
    // per-check, not in aggregate.
    ["- ✅ `cargo test --locked`\n- ✅ `cargo test --locked`\n", "a duplicated record standing in for a missing one"],
    // A check identity this run never configured.
    ["- ✅ `cargo test --locked`\n- ✅ `cargo clippy`\n- ✅ `true`\n", "an unconfigured check"],
    // A line outside the canonical format entirely.
    ["- ✅ `cargo test --locked`\n- ✅ `cargo clippy`\nAll checks passed!\n", "a non-canonical line"],
    // A ❌ line missing its exit code no longer parses — refused, not read
    // as a pass or a failure of some guessed identity.
    ["- ✅ `cargo test --locked`\n- ❌ `cargo clippy`\n", "a malformed ❌ line"],
  ];
  for (const [content, label] of cases) {
    assert.match(
      runVerdictBlock(checks, content),
      /passed=false/,
      `${label} did not fail closed`,
    );
  }
});
