// Tests for shell logic inside .github/workflows/rust-update.yml itself —
// this repository ships no YAML parser on purpose (see zizmor.test.js), so
// these are regex assertions over the raw file text, the same convention.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const workflow = readFileSync(".github/workflows/rust-update.yml", "utf8");

test("the strict-policy probe pipes --slurp's output into a separate jq, never combined with --jq", () => {
  // `gh api` rejects --slurp combined with --jq outright ("the --slurp
  // option is not supported with --jq or --template") — a regression here
  // is silent everywhere else: `|| strict=false` swallows the failure and
  // the run just falls back to a manual merge, so nothing red ever reports
  // it. First assert the probe was actually found, so this test fails
  // loudly if the line moves or is reworded rather than passing vacuously.
  const probe = /strict=\$\(gh api --paginate --slurp [^\n]*\\\n\s*\|\s*jq /;
  assert.match(workflow, probe, "the strict-policy probe's gh api | jq pipeline was not found");

  // The specific regression: --jq attached directly to the same `gh api`
  // invocation that also carries --slurp.
  const combined = /gh api[^\n]*--slurp[^\n]*--jq|gh api[^\n]*--jq[^\n]*--slurp/;
  assert.doesNotMatch(workflow, combined, "--slurp and --jq must not appear on the same gh api invocation");
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
