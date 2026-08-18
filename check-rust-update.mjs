#!/usr/bin/env node
// Validates the diff the weekly dependency update produced, from the publish
// job — a runner that compiled nothing and executed no dependency code. The
// Rust sibling of npm-update's check-npm-update.mjs and gradle-update's
// check-gradle-update.mjs, and the same reasoning applies: everything the
// update job asserted about the lockfile, it asserted on a machine where the
// updated dependencies' own code had already run (the consumer's checks
// compile build scripts and proc macros), so the assertion that gates the
// push has to be re-derived somewhere that code never ran.
//
// What it enforces, purely from the two texts:
//   - the format version, the preamble, and every non-[[package]] section
//     are byte-identical
//   - the workspace's own packages are untouched: same set, same versions,
//     same dependency names
//   - every other diff is a crates.io package moving UP within its
//     semver-compatible range (Cargo's caret rule: same major, same minor at
//     0.x), stable on both sides, checksum moving with it — or a package
//     legitimately arriving or leaving as a consequence; a compatibility
//     group REPLACED by another is a transitive major and is refused
//   - both lockfiles are internally sound: every dependency reference
//     resolves to exactly one package, and every package is reachable from
//     the workspace's own packages — an orphan nothing depends on is not
//     something `cargo update` produces
//
// And with --verify-upstream, what the texts alone cannot give: that every
// new version really exists on crates.io un-yanked, that its checksum is the
// registry's own for that version, that the dependency edges the diff
// records are edges that version really declares, and that its publish date
// sits outside the cooldown. The artifact and its fingerprint both
// originated on the machine that later ran the batch's own build code, so
// code compromised within-major could forge a matching pair naming an
// hours-old or tampered release — re-asking the registry from this runner is
// pure metadata over HTTPS, the class of work the trust split already allows
// here, and closes that reach-back.
//
// validateLockfileUpdate is a pure function over the two file texts,
// exported for check-rust-update.test.js; verifyUpstream is pure but for the
// injected fetcher and clock. The CLI at the bottom is the only part that
// touches git, the filesystem, or the network.

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import {
  API_URL,
  CRATES_IO_SOURCE,
  INDEX_URL,
  compareSemver,
  compatKeyOf,
  diffLockfiles,
  fetchCrateIndex,
  fetchVersionDate,
  httpsFetcher,
  isStable,
  parseDepRef,
  parseLockfile,
  reqMatches,
  sourceIdentityOf,
  resolveDepRef,
  workspaceMembers,
} from "./update-lockfile.mjs";

// The crate names a package's dependency references resolve to. Reference
// FORM changes with disambiguation (a second `syn` major arriving turns
// "syn" into "syn 2.0.119" in every dependent), so identity comparisons work
// on the name set, never the raw strings.
const depNames = (pkg) => {
  const names = new Set();
  for (const ref of pkg.dependencies ?? []) {
    const parsed = parseDepRef(ref);
    if (parsed) names.add(parsed.name);
  }
  return names;
};

const setEqual = (a, b) => a.size === b.size && [...a].every((x) => b.has(x));

// Internal soundness of one lockfile: every reference resolves to exactly
// one package, and everything is reachable from the workspace's own
// packages. `which` labels the errors ("baseline" / "updated").
export const soundnessFailures = (lock, which) => {
  const errors = [];
  const members = workspaceMembers(lock);
  if (members.length === 0) {
    errors.push(`${which}: no workspace packages (entries without a source) — nothing anchors the graph`);
    return errors;
  }
  const reached = new Set(members);
  const queue = [...members];
  while (queue.length > 0) {
    const pkg = queue.pop();
    for (const ref of pkg.dependencies ?? []) {
      const targets = resolveDepRef(lock.packages, ref);
      if (targets.length !== 1) {
        errors.push(
          `${which}: ${pkg.name} ${pkg.version} depends on "${ref}", which resolves to ` +
            `${targets.length} packages — a reference must name exactly one`,
        );
        continue;
      }
      if (!reached.has(targets[0])) {
        reached.add(targets[0]);
        queue.push(targets[0]);
      }
    }
  }
  for (const pkg of lock.packages) {
    if (!reached.has(pkg)) {
      errors.push(
        `${which}: ${pkg.name} ${pkg.version} is not reachable from any workspace package — ` +
          `an orphan cargo update does not produce`,
      );
    }
  }
  return errors;
};

// Compares old and new lockfile text. Returns { ok, errors, changes, added,
// removed, depChanged } where the last four are what a passing diff
// consists of — `depChanged` lists unchanged packages whose dependency
// names moved (a feature-selection consequence this validator admits
// structurally and --verify-upstream then checks against the registry).
// Never throws on content — every rule lands in errors so the workflow can
// print all of them.
export const validateLockfileUpdate = (oldText, newText) => {
  const errors = [];
  const oldLock = parseLockfile(oldText);
  const newLock = parseLockfile(newText);
  for (const [which, lock] of [["baseline", oldLock], ["updated", newLock]]) {
    for (const e of lock.errors) errors.push(`${which}: ${e}`);
  }
  if (errors.length > 0) return { ok: false, errors, changes: [], added: [], removed: [], depChanged: [] };

  if (oldLock.version !== newLock.version) {
    errors.push(
      `the lockfile format version changed (${oldLock.version} -> ${newLock.version}); ` +
        "the weekly batch may only move package versions",
    );
  }
  if (oldLock.preamble !== newLock.preamble) {
    errors.push("the lockfile preamble changed; the weekly batch may only move package versions");
  }
  const renderOthers = (lock) => lock.others.map((s) => s.raw.join("\n")).join("\n\n");
  if (renderOthers(oldLock) !== renderOthers(newLock)) {
    errors.push(
      "a non-[[package]] section ([metadata], [[patch.unused]]) changed; " +
        "the weekly batch may only move package versions",
    );
  }

  for (const [which, lock] of [["baseline", oldLock], ["updated", newLock]]) {
    errors.push(...soundnessFailures(lock, which));
  }
  if (errors.length > 0) return { ok: false, errors, changes: [], added: [], removed: [], depChanged: [] };

  // The workspace's own packages: untouched, in every respect the lockfile
  // records. Their manifests did not change (the workflow's tree check
  // holds everything but the lockfile still), so any movement here was not
  // produced by `cargo update` against this tree.
  // Grouped into lists, not a by-name map: renamed path dependencies can
  // hold one name at several versions (each pinned exactly by its own
  // manifest), and a map keyed by name would silently drop all but one.
  // Instances pair by version — Cargo refuses two sourceless packages at
  // the same name AND version, so the pairing is unambiguous.
  const membersByName = (lock) => {
    const m = new Map();
    for (const p of workspaceMembers(lock)) {
      if (!m.has(p.name)) m.set(p.name, []);
      m.get(p.name).push(p);
    }
    return m;
  };
  const oldMembers = membersByName(oldLock);
  const newMembers = membersByName(newLock);
  for (const [name, befores] of oldMembers) {
    const afters = newMembers.get(name) ?? [];
    for (const before of befores) {
      const after = afters.find((p) => p.version === before.version);
      if (after === undefined) {
        errors.push(
          afters.length === 0
            ? `workspace package ${name} vanished; cargo update does not do that`
            : `workspace package ${name} moved ${before.version} -> ` +
              `${afters.map((p) => p.version).join(", ")}; ` +
              "its version comes from a manifest this batch may not touch",
        );
        continue;
      }
      if (!setEqual(depNames(before), depNames(after))) {
        errors.push(
          `workspace package ${name} changed what it depends on; ` +
            "its dependencies come from a manifest this batch may not touch",
        );
      }
    }
    for (const after of afters) {
      if (!befores.some((p) => p.version === after.version)) {
        errors.push(
          `workspace package ${name} appeared at ${after.version}; cargo update does not do that`,
        );
      }
    }
  }
  for (const name of newMembers.keys()) {
    if (!oldMembers.has(name)) {
      errors.push(`workspace package ${name} appeared; cargo update does not do that`);
    }
  }

  const diff = diffLockfiles(oldLock, newLock);
  errors.push(...diff.errors);

  // A dependency edge crossing a compatibility boundary is a transitive
  // major, and it hides equally well behind a surviving old copy (another
  // dependent keeps 1.x alive while this one's edge moves to a new 2.x) as
  // behind a replaced one — so the rule is per EDGE, npm-update's instance
  // rule ported. Edges are keyed by (crate name, compatibility group), not
  // name alone: renamed dependencies let ONE package depend on two
  // incompatible versions of the same crate at once, and a by-name map
  // would drop one of those edges and misread the survivor as a crossing.
  // For each name a pair declares on both sides, a compat group lost AND a
  // compat group gained together are a crossing; a group only lost or only
  // gained is a legitimate drop or add of an edge. Soundness above already
  // guaranteed unique resolution per reference.
  for (const pair of [...diff.changed, ...diff.unchanged]) {
    const groupsOf = (pkg, packages) => {
      const byName = new Map();
      for (const ref of pkg.dependencies ?? []) {
        const target = resolveDepRef(packages, ref)[0];
        // Keyed as in the lockfile diff: dual edges to one crate from two
        // different sources — or to two compatible versions of a renamed
        // path dependency — are a valid graph, not a duplicate.
        const key =
          target.source === null
            ? `=${target.version}`
            : `${compatKeyOf(target.version)}\n${sourceIdentityOf(target.source)}`;
        if (!byName.has(target.name)) byName.set(target.name, new Map());
        const groups = byName.get(target.name);
        if (groups.has(key) && groups.get(key) !== target) {
          // Two same-group same-source instances of one name, both edges
          // of one package: a shape this rule cannot key. Refuse rather
          // than compare the wrong copies.
          errors.push(
            `${pkg.name} ${pkg.version}: two dependency edges to ${target.name} in the same ` +
              "compatibility group — refusing to reason about this graph",
          );
          continue;
        }
        groups.set(key, target);
      }
      return byName;
    };
    const before = groupsOf(pair.before, oldLock.packages);
    const after = groupsOf(pair.after, newLock.packages);
    for (const [name, beforeGroups] of before) {
      const afterGroups = after.get(name);
      if (afterGroups === undefined) continue; // every edge to this name dropped
      const lost = [...beforeGroups.keys()].filter((k) => !afterGroups.has(k));
      const gained = [...afterGroups.keys()].filter((k) => !beforeGroups.has(k));
      if (lost.length === 0 || gained.length === 0) continue;
      errors.push(
        `${pair.after.name}'s edge to ${name} crossed from ` +
          `${lost.map((k) => beforeGroups.get(k).version).join(", ")} to ` +
          `${gained.map((k) => afterGroups.get(k).version).join(", ")} — a semver-incompatible ` +
          "move; even a transitive breaking move is a deliberate migration, not a weekly batch",
      );
    }
  }

  for (const c of diff.changed) {
    const at = `${c.name}`;
    if (c.before.source !== c.after.source) {
      errors.push(`${at}: the source changed (${c.before.source} -> ${c.after.source})`);
      continue;
    }
    if (c.after.source !== CRATES_IO_SOURCE) {
      errors.push(`${at}: ${c.from} -> ${c.to} moved a package whose source is not crates.io (${c.after.source})`);
      continue;
    }
    if (!isStable(c.from) || !isStable(c.to)) {
      errors.push(`${at}: ${c.from} -> ${c.to} involves a pre-release; the weekly batch takes stable releases only`);
      continue;
    }
    if (compatKeyOf(c.from) !== compatKeyOf(c.to)) {
      // Unreachable through diffLockfiles' own grouping, but the rule this
      // whole file exists for is not left to a matcher's construction.
      errors.push(`${at}: ${c.from} -> ${c.to} crosses a semver-compatibility boundary`);
      continue;
    }
    if (compareSemver(c.to, c.from) <= 0) {
      errors.push(`${at}: ${c.from} -> ${c.to} is not an upgrade`);
      continue;
    }
    if (typeof c.before.checksum !== "string" || typeof c.after.checksum !== "string") {
      errors.push(`${at}: a registry package must carry a checksum on both sides`);
      continue;
    }
    if (c.before.checksum === c.after.checksum) {
      errors.push(`${at}: ${c.from} -> ${c.to} kept its checksum; two releases cannot share one`);
    }
  }

  for (const p of diff.added) {
    const at = `${p.name} ${p.version}`;
    if (p.source !== CRATES_IO_SOURCE) {
      errors.push(`${at}: arrived from a source that is not crates.io (${p.source})`);
      continue;
    }
    if (!isStable(p.version)) {
      errors.push(`${at}: arrived as a pre-release; the weekly batch takes stable releases only`);
      continue;
    }
    if (typeof p.checksum !== "string") {
      errors.push(`${at}: arrived without a checksum`);
    }
  }

  // Unchanged registry packages: the same release's bytes cannot change, so
  // source and checksum are pinned. The dependency NAMES can move —
  // feature unification across the new graph enables or disables optional
  // dependencies of a version that itself held still — so that movement is
  // admitted structurally and collected for the record; --verify-upstream's
  // graph pass is what vouches for every such edge against what the
  // version really declares, rather than either refusing it here (a
  // standing false alarm) or waving it through (an unvouched edge).
  const depChanged = [];
  for (const u of diff.unchanged) {
    if (u.before.source !== u.after.source) {
      errors.push(`${u.before.name} ${u.before.version}: kept its version but changed source`);
      continue;
    }
    if (u.before.checksum !== u.after.checksum) {
      errors.push(
        `${u.before.name} ${u.before.version}: kept its version but changed checksum — ` +
          "the same release cannot change its bytes",
      );
      continue;
    }
    const before = depNames(u.before);
    const after = depNames(u.after);
    if (!setEqual(before, after)) {
      depChanged.push({
        name: u.after.name,
        version: u.after.version,
        added: [...after].filter((n) => !before.has(n)).sort(),
        removed: [...before].filter((n) => !after.has(n)).sort(),
      });
    }
  }

  const changes = diff.changed.map((c) => ({
    name: c.name,
    from: c.from,
    to: c.to,
    checksum: c.after.checksum,
    deps: [...depNames(c.after)].sort(),
  }));
  const added = diff.added.map((p) => ({
    name: p.name,
    version: p.version,
    checksum: p.checksum,
    deps: [...depNames(p)].sort(),
  }));
  const removed = diff.removed.map((p) => ({ name: p.name, version: p.version }));

  if (errors.length === 0 && changes.length === 0 && added.length === 0 && removed.length === 0) {
    // The workflow only publishes when something moved; an identical file
    // here means the wrong artifact landed on this runner.
    errors.push("the lockfile is unchanged — nothing to publish");
  }
  return { ok: errors.length === 0, errors, changes, added, removed, depChanged };
};

// Re-asks the registry about the whole updated lockfile. Fail closed
// throughout: a version the index does not list, a yanked release, a
// checksum the registry does not vouch for, a dependency edge the
// dependent's version does not declare or whose resolved version does not
// satisfy the declared requirement, a missing publish date, and a date
// inside the cooldown are all refusals — on this side of the trust split a
// blocked publish costs a rerun, while a guessed pass costs the window a
// compromised release needs to be yanked. The resolve-time check ran
// minutes earlier, so a release that passed the cooldown there only gets
// older; no legitimate batch is refused by re-checking here.
//
// The graph pass covers EVERY registry package, not just the diff: the
// artifact came from a machine that ran dependency code, so an edge
// grafted onto an untouched package — or an edge quietly repointed at a
// coexisting version its requirement never allowed — must be caught here,
// where `cargo update`'s own resolution cannot be taken on faith.
export const verifyUpstream = async (
  newText,
  { changes, added },
  { fetcher, cooldownDays, now = new Date(), indexUrl = INDEX_URL, apiUrl = API_URL },
) => {
  const errors = [];
  const lock = parseLockfile(newText);
  if (lock.errors.length > 0) {
    // Unreachable behind a passing validateLockfileUpdate, but this
    // function must not assume its caller ran one.
    return lock.errors.map((e) => `updated: ${e}`);
  }
  const indexCache = new Map();
  const crateIndex = async (name) => {
    if (!indexCache.has(name)) indexCache.set(name, await fetchCrateIndex(name, fetcher, indexUrl));
    return indexCache.get(name);
  };
  // One existence verdict per (name, version), shared by the per-version
  // checks and the graph pass so a missing release is reported once.
  const recordCache = new Map();
  const recordFor = async (name, version) => {
    const key = `${name} ${version}`;
    if (recordCache.has(key)) return recordCache.get(key);
    const index = await crateIndex(name);
    let record = null;
    if (index.errors.length > 0) {
      errors.push(`${name}: could not verify against the index (${index.errors.join("; ")})`);
    } else {
      record = index.versions.find((v) => v.vers === version) ?? null;
      if (record === null) errors.push(`${name}: the index does not list version ${version}`);
    }
    recordCache.set(key, record);
    return record;
  };

  const checkVersion = async (name, version, checksum) => {
    const record = await recordFor(name, version);
    if (record === null) return;
    if (record.yanked) {
      errors.push(`${name} ${version}: yanked upstream — a yanked release must not be published`);
      return;
    }
    if (record.cksum === null || record.cksum !== checksum) {
      errors.push(
        `${name} ${version}: the lockfile's checksum does not match the registry's ` +
          `(${checksum} vs ${record.cksum ?? "none"}) — nothing vouches for these bytes`,
      );
      return;
    }
    // Mirrors the engine's cooldownDays <= 0 shortcut: existence, yank
    // status and checksum are still required above, but a caller that
    // disabled the cooldown does not need a date.
    if (cooldownDays <= 0) return;
    const date = await fetchVersionDate(name, version, fetcher, apiUrl);
    if (date === null) {
      errors.push(`${name} ${version}: no publish date, so the cooldown cannot be verified`);
      return;
    }
    const ageDays = (now.getTime() - date.getTime()) / 86_400_000;
    if (ageDays < cooldownDays) {
      errors.push(
        `${name} ${version}: published ${ageDays.toFixed(1)} days ago, ` +
          `inside the ${cooldownDays}-day cooldown`,
      );
    }
  };

  for (const c of changes) await checkVersion(c.name, c.to, c.checksum);
  for (const a of added) await checkVersion(a.name, a.version, a.checksum);

  // The graph pass: every edge of every crates.io package must be one its
  // dependent's version really declares — matched by the REAL crate name
  // (`package` when the dependency is renamed, `name` otherwise) — with at
  // least one declared requirement the resolved version satisfies (a crate
  // can appear under several kinds or targets with different requirements;
  // the edge is legitimate if any of them admits it). An unparseable
  // requirement refuses rather than passes.
  for (const pkg of lock.packages) {
    if (pkg.source !== CRATES_IO_SOURCE) continue;
    const record = await recordFor(pkg.name, pkg.version);
    if (record === null) continue;
    // The reverse direction first: every MANDATORY dependency the version
    // declares must appear as an edge. Dropping a required edge (and the
    // subtree behind it) leaves soundness and the subset checks below
    // green while producing a lockfile Cargo itself would reject — so the
    // required set is re-derived from the index. Optional dependencies are
    // legitimately absent (feature selection), and a dev dependency of a
    // registry package is never resolved into a consumer's lockfile.
    const edgeNames = new Set(
      (pkg.dependencies ?? []).map((ref) => parseDepRef(ref)?.name).filter((n) => n !== undefined),
    );
    for (const d of record.deps) {
      if (d.optional === true || d.kind === "dev") continue;
      const real = typeof d.package === "string" ? d.package : d.name;
      if (typeof real !== "string") {
        errors.push(`${pkg.name} ${pkg.version}: an index dependency record carries no name`);
        continue;
      }
      if (!edgeNames.has(real)) {
        errors.push(
          `${pkg.name} ${pkg.version}: the lockfile omits its mandatory dependency ${real} — ` +
            "a required edge cannot be dropped; this lockfile was not produced by cargo",
        );
      }
    }
    for (const ref of pkg.dependencies ?? []) {
      const targets = resolveDepRef(lock.packages, ref);
      if (targets.length !== 1) {
        errors.push(`${pkg.name} ${pkg.version}: dependency "${ref}" does not resolve uniquely`);
        continue;
      }
      const target = targets[0];
      if (target.source !== CRATES_IO_SOURCE) {
        errors.push(
          `${pkg.name} ${pkg.version}: depends on ${target.name} from ` +
            `${target.source ?? "this workspace"} — a registry package cannot; ` +
            "patched graphs are not something this job publishes",
        );
        continue;
      }
      const declared = record.deps.filter(
        (d) => (typeof d.package === "string" ? d.package : d.name) === target.name,
      );
      if (declared.length === 0) {
        errors.push(
          `${pkg.name} ${pkg.version}: the lockfile records a dependency on ${target.name}, ` +
            "which that version does not declare — this edge was not produced by cargo",
        );
        continue;
      }
      const verdicts = declared.map((d) => reqMatches(d.req, target.version));
      if (!verdicts.includes(true)) {
        errors.push(
          verdicts.includes(null)
            ? `${pkg.name} ${pkg.version}: the requirement it declares for ${target.name} ` +
                "could not be understood, so the edge cannot be verified"
            : `${pkg.name} ${pkg.version}: resolves ${target.name} to ${target.version}, ` +
                `which satisfies none of its declared requirements ` +
                `(${declared.map((d) => JSON.stringify(d.req)).join(", ")}) — ` +
                "this resolution was not produced by cargo",
        );
      }
    }
  }
  return errors;
};

// ---------------------------------------------------------------------------
// CLI: compares the committed lockfile (HEAD) with the working copy the
// artifact overlaid, exactly as the publish job sees them.
// ---------------------------------------------------------------------------

const main = async () => {
  let lockfile = "Cargo.lock";
  let verify = false;
  let cooldownDays = 5;
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    const [flag, inline] = argv[i].split(/=(.*)/s, 2);
    const value = () => inline ?? argv[++i];
    if (flag === "--lockfile") lockfile = value();
    else if (flag === "--verify-upstream") verify = true;
    else if (flag === "--cooldown-days") cooldownDays = Number(value());
    else throw new Error(`unknown argument: ${argv[i]}`);
  }
  if (!Number.isFinite(cooldownDays) || cooldownDays < 0) {
    throw new Error("--cooldown-days must be a non-negative number");
  }

  const oldText = execFileSync("git", ["show", `HEAD:${lockfile}`], { encoding: "utf8" });
  const newText = readFileSync(lockfile, "utf8");
  const result = validateLockfileUpdate(oldText, newText);
  if (!result.ok) {
    for (const e of result.errors) console.error(`::error::${e}`);
    process.exit(1);
  }
  if (verify) {
    const upstreamErrors = await verifyUpstream(newText, result, { fetcher: httpsFetcher, cooldownDays });
    if (upstreamErrors.length > 0) {
      for (const e of upstreamErrors) console.error(`::error::${e}`);
      process.exit(1);
    }
  }
  for (const c of result.changes) console.log(`${c.name}: ${c.from} -> ${c.to}`);
  for (const a of result.added) console.log(`${a.name}: added at ${a.version}`);
  for (const r of result.removed) console.log(`${r.name}: removed (was ${r.version})`);
};

// argv[1] is undefined under `node -e`/`--test` importing this as a module.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
