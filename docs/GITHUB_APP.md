# Running the weekly batch as a GitHub App, not the default token

**Not the currently used path.** `docs/PAT.md` covers the same problem with
a simpler one-time setup while every consumer is single-owner; see this
repository's `TODO.md` for why this App path is the one to come back to
once a repository takes external contributions.

## The problem this solves

The publish job pushes the update branch and opens the pull request with
`github.token` — the repository's default `GITHUB_TOKEN`. GitHub does not
treat that identity (`github-actions[bot]`) as a collaborator, so the first
time it opens a pull request in a consumer, any workflow with an `on:
pull_request` trigger — a consumer's own `ci.yml` included — gets queued and
held for manual approval before a single job runs, the same gate GitHub
applies to a first-time external contributor. Confirmed live on
`mikelward/mesh#531`: `ci.yml`'s `pull_request`-triggered run sat at
`action_required` with zero jobs started, while the SAME workflow, dispatched
separately by this job's `ci-workflow` input, ran and passed normally on the
same commit.

There is no workflow-file fix. The gate evaluates before any job or `if:`
condition is read, and `pull_request`'s `branches`/`branches-ignore` filters
match the PR's **base** branch — always the consumer's default branch here —
not its head, so the weekly batch's `deps/update-*` branches can't be
excluded that way either. The one lever is the actor: a GitHub App
installation with write access on the repository *is* a collaborator as far
as this gate is concerned, so a pull request it opens never trips it.

This is a deliberate grant, not a workaround: you install the App on exactly
the repositories you want it to act on, with exactly two permissions, and can
revoke it at any time from the App's settings — an explicit, auditable,
narrowly-scoped credential, not GitHub quietly remembering that a bot's first
run was clicked "approve" and trusting it forever after.

## One-time setup, per GitHub account or organization

1. **Register the App.** GitHub → Settings → Developer settings → GitHub
   Apps → New GitHub App.
   - Name and homepage URL: anything; the homepage can point at this
     repository.
   - Webhook: uncheck "Active" — this App only ever mints tokens for
     workflow jobs to use, it never receives events.
   - Repository permissions:
     - **Contents: Read and write** — to push the update branch.
     - **Pull requests: Read and write** — to open, and re-open on
       supersession, the batch pull request.
     - Nothing else. In particular not Actions, not Administration — the
       publish job's own `permissions:` block only scopes the auto-generated
       GITHUB_TOKEN it replaces; a minted installation token's effective
       access comes from the App's own permissions, set here, not from that
       block. So these two are the real ceiling once wired up: grant only
       what the batch actually needs.
   - "Where can this GitHub App be installed?": your choice — "Only on this
     account" is the narrower one if every consumer lives under the same
     account.
2. **Generate a private key.** On the App's settings page, "Generate a
   private key" downloads a `.pem` file once — store it somewhere you can
   retrieve it, GitHub does not keep a copy.
3. **Note the App ID.** Shown on the same settings page, near the top.
4. **Install the App** on each consumer repository (`root`, `mesh`, and any
   repository added later): the App's settings page → Install App → pick
   the account → select repositories → choose `root` and `mesh` explicitly
   rather than "All repositories", so adding a new repository to the
   account never silently grants this App access to it.
5. **Add two secrets to each consumer repository's `rust-update` environment**
   (Settings → Environments → `rust-update` → Environment secrets; or, from
   mikelward/repo, `repo secrets --name NAME --env rust-update --file PATH
   OWNER/REPO...` once per secret, which creates the environment when it is
   missing) — repeated per repository because a personal GitHub account has
   no account-wide secret store the way an organization does, and as
   environment rather than repository secrets on purpose: a repository secret
   passed to a reusable workflow reaches the runner of every job in it, the
   update job included, where build-script and proc-macro code runs with sudo,
   while an environment secret reaches only the job that declares the
   environment, and only the publish job does:
   - `RUST_UPDATE_APP_ID` — the numeric App ID from step 3.
   - `RUST_UPDATE_APP_PRIVATE_KEY` — the full contents of the `.pem` file
     from step 2, unmodified (`-----BEGIN RSA PRIVATE KEY-----` line and
     all).

## What the consumer's caller workflow passes

The publish job reads both from the `rust-update` environment when the caller
passes `secrets: inherit` — the only way an environment secret can reach a
called workflow. A consumer opts in like this:

```yaml
jobs:
  update:
    uses: mikelward/rust-update/.github/workflows/rust-update.yml@main
    permissions:
      contents: write
      pull-requests: write
      actions: write
    # `inherit`, not a `secrets:` block naming the pair: an environment
    # secret reaches a called workflow no other way. zizmor flags this
    # (secrets-inherit); allow it for this file in .github/zizmor.yml, with
    # this reason. The older `secrets: app-id: ...` block still works but
    # delivers the key to every job's runner.
    secrets: inherit
    with:
      # ...existing inputs...
```

Both secrets are optional on the reusable workflow's side: a consumer that
sets neither keeps today's behavior (`github.token`, and the approval prompt
on its first bot-opened pull request each repository). Setting one without
the other is refused — a partial credential can mint no token at all, and
failing loudly beats silently falling back to a weaker one.

## What changes for you, once wired

Nothing about the weekly batch's shape. The pull request is still opened
under the `github-actions[bot]` identity in every visible respect covered
elsewhere in this repository's docs — GitHub's UI shows the App's own name
as the actor once it holds the token, which is the one visible difference:
expect the PR author to read as this App's name rather than
`github-actions[bot]` after the switch. Nothing else — commit author,
`Co-Authored-By` lines, PR body content, checks, and the trust model in
`README.md` are all unaffected; this only changes which credential opens the
pull request and pushes the branch.
