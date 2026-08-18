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
