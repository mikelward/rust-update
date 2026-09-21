#!/usr/bin/env node
// Refreshes Cargo.lock to the newest eligible releases WITHIN the ranges the
// consumer's manifests already declare — the Rust sibling of npm-update's
// weekly lockfile batch. Cargo.toml is never touched: requirements are ranges
// (caret by default), the lockfile is what pins, and a major is a deliberate,
// human-initiated migration this job cannot produce. Anything held back by
// that rule is reported so the weekly PR can say what is waiting.
//
// Unlike the npm and Gradle siblings, resolution itself is delegated to
// `cargo update`: Cargo's resolver is the authority on what a consistent
// lockfile even is (feature unification, per-target dependencies, MSRV-aware
// resolution under resolver v3), and reimplementing it here would be the
// fragile kind of cleverness. That delegation preserves the trust split,
// because `cargo update` executes no dependency code — build scripts and proc
// macros run at BUILD time, which starts with the consumer's checks, after
// this script is done and the lockfile is fingerprinted. What executes while
// anything is decided is Cargo itself (the consumer's pinned toolchain) and
// this file.
//
// On top of Cargo's resolution this script enforces two policies Cargo has no
// flag for, by pinning offenders back with `cargo update --precise`:
//
//   - The release-age cooldown, mirroring npm's `min-release-age`: a version
//     younger than the window is deferred in favor of the next-newest
//     eligible release, so a compromised release has time to be yanked before
//     an unattended job takes it. Publish dates come from the crates.io API.
//   - No transitive majors. A changed dependency's own new requirement can
//     drag one of ITS dependencies across a semver-incompatible boundary
//     (Cargo's caret rule: new major, or new minor at 0.x) with nothing in
//     any manifest to show for it. The dependent that dragged it is pinned
//     back to where it started; even a transitive breaking move is a
//     deliberate migration, not a weekly batch. The same crossing can also
//     surface on a dependent that did NOT change: when a bumped crate stops
//     requiring the group a shared transitive sat in, that copy loses its
//     last referencer and cargo dedups the wide-range dependents down onto a
//     surviving incompatible copy. The mover whose bump dropped the anchor is
//     pinned back — holding one package back rather than aborting the batch,
//     the way the npm sibling holds back a blocked package instead of sinking
//     the week's whole update.
//
// A violation neither pinning strategy can fix fails the run LOUDLY with the
// lockfile restored: a red weekly run costs a rerun (the cooldown case heals
// itself within the window), while a violating lockfile shipped quietly costs
// exactly the guarantee this job exists to give.
//
// Everything here is a pure function over parsed text plus injectable
// effects (a fetcher, a cargo runner, a clock), exported for
// update-lockfile.test.js. The CLI at the bottom is the only part that
// touches the filesystem, the network, or a real cargo.

import { readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { basename, dirname } from "node:path";
import { pathToFileURL } from "node:url";

// The one registry this job manages. A package from any other source — a git
// dependency, a private registry — is left alone and reported as unmanaged;
// the validator refuses a diff that CHANGES one.
export const CRATES_IO_SOURCE = "registry+https://github.com/rust-lang/crates.io-index";

// Version lists, yank status and checksums come from the sparse index;
// per-version publish dates only exist in the crates.io API. Both are
// metadata over HTTPS — no dependency code is involved in either.
export const INDEX_URL = "https://index.crates.io";
export const API_URL = "https://crates.io/api/v1";

// crates.io's crawler policy requires a User-Agent that identifies the tool
// and gives a way to reach its operator.
export const USER_AGENT =
  "mikelward-rust-update (+https://github.com/mikelward/rust-update)";

// ---------------------------------------------------------------------------
// Cargo.lock parser — the whole format, not a subset. A lockfile is
// machine-generated TOML with a fixed shape (Cargo's own serializer), so a
// line-oriented parse is sound; anything outside that shape is a parse error
// the callers treat as a stop, never a guess.
// ---------------------------------------------------------------------------

const STRING_PAIR = /^([A-Za-z_-]+) = "([^"]*)"$/;

// Parses a lockfile into { version, preamble, packages, others, errors }.
// `preamble` is the raw text before the first section (the @generated
// comment and the `version = N` line); `others` keeps any non-[[package]]
// section ([metadata], [[patch.unused]]) raw, so a validator can require
// them byte-identical without this file modeling their contents.
export const parseLockfile = (text) => {
  const lines = text.split("\n");
  const packages = [];
  const others = [];
  const errors = [];
  const preamble = [];
  let version = null;
  let section = null; // null | "preamble" | {package} | {other}
  let inDeps = false;

  const openSection = (header, i) => {
    if (header === "[[package]]") {
      section = { name: null, version: null, source: null, checksum: null, dependencies: null, line: i + 1 };
      packages.push(section);
    } else {
      section = { header, raw: [header] };
      others.push(section);
    }
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (section === null) {
      // Preamble: comments, blanks, and the format version.
      const v = /^version = (\d+)$/.exec(line);
      if (v) version = Number(v[1]);
      if (/^\[/.test(line.trim())) {
        openSection(line.trim(), i);
        continue;
      }
      if (line.trim() !== "" && !line.startsWith("#") && !v) {
        errors.push(`line ${i + 1}: unexpected content before the first section: ${line}`);
      }
      preamble.push(line);
      continue;
    }
    if (!section.header && inDeps) {
      // Inside a dependencies array. Cargo writes one ` "ref",` per line.
      if (line === "]") {
        inDeps = false;
        continue;
      }
      const m = /^ "([^"]+)",$/.exec(line);
      if (m) {
        section.dependencies.push(m[1]);
      } else {
        errors.push(`line ${i + 1}: unexpected dependencies entry: ${line}`);
      }
      continue;
    }
    if (/^\[/.test(line.trim())) {
      if (inDeps) errors.push(`line ${i + 1}: unterminated dependencies array`);
      inDeps = false;
      openSection(line.trim(), i);
      continue;
    }
    if (section.header) {
      // A section this file does not model: kept raw, compared raw.
      section.raw.push(line);
      continue;
    }
    if (line === "") continue;
    if (line === "dependencies = [") {
      if (section.dependencies !== null) {
        errors.push(`line ${i + 1}: duplicate dependencies array`);
      }
      section.dependencies = [];
      inDeps = true;
      continue;
    }
    const pair = STRING_PAIR.exec(line);
    if (pair && ["name", "version", "source", "checksum"].includes(pair[1])) {
      if (section[pair[1]] !== null) {
        errors.push(`line ${i + 1}: duplicate ${pair[1]} in a package`);
      }
      section[pair[1]] = pair[2];
      continue;
    }
    // `replace =`, inline arrays, or anything else Cargo's serializer does
    // not emit today: refuse to half-read it.
    errors.push(`line ${i + 1}: unrecognized package field: ${line}`);
  }
  if (inDeps) errors.push("unterminated dependencies array at end of file");

  for (const p of packages) {
    if (p.name === null || p.version === null) {
      errors.push(`line ${p.line}: a [[package]] entry is missing its name or version`);
    }
  }
  if (version === null) {
    errors.push('no `version = N` line — not a v3+ Cargo.lock');
  }

  return { version, preamble: preamble.join("\n"), packages, others, errors };
};

// One dependency reference: "name", "name version", or
// "name version (source)" — Cargo disambiguates only as far as needed.
export const parseDepRef = (ref) => {
  const m = /^(\S+)(?: (\S+))?(?: \((.+)\))?$/.exec(ref);
  if (!m) return null;
  return { name: m[1], version: m[2] ?? null, source: m[3] ?? null };
};

// The packages a reference could mean. Well-formedness is exactly one.
export const resolveDepRef = (packages, ref) => {
  const parsed = typeof ref === "string" ? parseDepRef(ref) : ref;
  if (!parsed) return [];
  return packages.filter(
    (p) =>
      p.name === parsed.name &&
      (parsed.version === null || p.version === parsed.version) &&
      (parsed.source === null || p.source === parsed.source),
  );
};

// ---------------------------------------------------------------------------
// Semver, as crates.io publishes it and Cargo compares it.
// ---------------------------------------------------------------------------

// The full semver.org grammar (the spec's own reference regex), anchored.
// Anything that does not match is refused by the callers rather than
// compared as garbage.
const SEMVER =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+[0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*)?$/;

export const parseSemver = (v) => {
  const m = SEMVER.exec(String(v));
  if (!m) return null;
  return {
    major: Number(m[1]),
    minor: Number(m[2]),
    patch: Number(m[3]),
    prerelease: m[4] === undefined ? null : m[4].split("."),
  };
};

export const isStable = (v) => {
  const p = parseSemver(v);
  return p !== null && p.prerelease === null;
};

// Spec precedence: numeric core, then prerelease (absence outranks
// presence; identifiers compare numerically when both numeric, lexically
// otherwise, numeric below alphanumeric; more identifiers outrank a
// prefix). Build metadata is ignored, per the spec.
export const compareSemver = (a, b) => {
  const x = parseSemver(a);
  const y = parseSemver(b);
  if (x === null || y === null) {
    throw new Error(`internal: comparing unparseable versions ${a} / ${b}`);
  }
  if (x.major !== y.major) return x.major - y.major;
  if (x.minor !== y.minor) return x.minor - y.minor;
  if (x.patch !== y.patch) return x.patch - y.patch;
  if (x.prerelease === null && y.prerelease === null) return 0;
  if (x.prerelease === null) return 1;
  if (y.prerelease === null) return -1;
  for (let i = 0; i < Math.max(x.prerelease.length, y.prerelease.length); i++) {
    const p = x.prerelease[i];
    const q = y.prerelease[i];
    if (p === undefined) return -1;
    if (q === undefined) return 1;
    const pn = /^\d+$/.test(p);
    const qn = /^\d+$/.test(q);
    if (pn && qn) {
      if (Number(p) !== Number(q)) return Number(p) - Number(q);
    } else if (pn !== qn) {
      return pn ? -1 : 1;
    } else if (p !== q) {
      return p < q ? -1 : 1;
    }
  }
  return 0;
};

// ---------------------------------------------------------------------------
// Cargo version requirements, as the index records them. The validator's
// graph pass needs "does this resolved version satisfy this declared req" —
// the semantics are the semver crate's (which Cargo uses), transcribed from
// its documented equivalences rather than paraphrased. Returns true, false,
// or null for a requirement this evaluator cannot parse — and callers treat
// null as a refusal, never a pass.
// ---------------------------------------------------------------------------

const COMPARATOR =
  /^(\^|~|=|>=|<=|>|<)?\s*(\d+|\*|x|X)(?:\.(\d+|\*|x|X))?(?:\.(\d+|\*|x|X))?(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+[0-9a-zA-Z.-]+)?$/;

// Parses one comparator into { op, M, mn, p, pre }, or null on a shape
// outside the grammar (an op on a bare `*`, a wildcard before a concrete
// component, a prerelease on a partial or wildcard version).
const parseComparator = (cmp) => {
  const m = COMPARATOR.exec(cmp.trim());
  if (!m) return null;
  let [, op, maj, min, pat, pre] = m;
  const wild = (s) => s === "*" || s === "x" || s === "X";
  // Wildcards mean "unspecified from here on": normalize to absence, and
  // refuse `1.*.2` shapes. An operator with a TRAILING wildcard is a
  // partial version to Cargo (">=1.*" means ">=1", "^1.2.*" means "^1.2"),
  // so the wildcard drops rather than refusing — only a bare `*` takes no
  // operator at all. With NO operator, though, a wildcard is not caret: the
  // semver crate parses it as Op::Wildcard (parse.rs: `if default_op { op =
  // Op::Wildcard }`), which evaluates like `=` on the specified components
  // (eval.rs: `Op::Exact | Op::Wildcard => matches_exact`) — "1.2.*" means
  // >=1.2.0, <1.3.0, NOT ^1.2's <2.0.0. Dropping the wildcard under the
  // bare-comparator default (caret) got that wrong wherever caret and
  // wildcard diverge (major > 0 with a minor specified), a false PASS in
  // the graph check for an edge the requirement doesn't admit.
  if (wild(maj)) {
    if (op || min !== undefined || pat !== undefined || pre !== undefined) return null;
    maj = min = pat = pre = undefined;
  } else if (min !== undefined && wild(min)) {
    if ((pat !== undefined && !wild(pat)) || pre !== undefined) return null;
    min = pat = undefined;
    if (!op) op = "=";
  } else if (pat !== undefined && wild(pat)) {
    if (pre !== undefined) return null;
    pat = undefined;
    if (!op) op = "=";
  }
  const M = maj === undefined ? undefined : Number(maj);
  const mn = min === undefined ? undefined : Number(min);
  const p = pat === undefined ? undefined : Number(pat);
  // A prerelease tag needs the full numeric triple to hang off — the
  // semver crate rejects `~1.2-beta`, and so does this.
  if (pre !== undefined && (mn === undefined || p === undefined)) return null;
  return { op: op ?? "", M, mn, p, pre };
};

// One parsed comparator against one parsed version, by ordering alone.
// Prerelease ADMISSION is deliberately not here: the semver crate applies
// it once per REQUIREMENT (see reqMatches) — gating each comparator would
// make an ordinary `<2.0.0` refuse a prerelease that another comparator in
// the same requirement explicitly admits.
const comparatorSatisfied = ({ op, M, mn, p, pre }, v) => {
  const render = (a, b, c, tail) => `${a}.${b}.${c}${tail ? `-${tail}` : ""}`;
  const version = render(v.major, v.minor, v.patch, v.prerelease?.join("."));
  const cmpLower = () => compareSemver(version, render(M, mn ?? 0, p ?? 0, pre));
  const below = (a, b, c) => compareSemver(version, render(a, b, c)) < 0;

  // `*` alone constrains nothing by ordering; prereleases were already
  // refused at admission unless some comparator vouched for them.
  if (M === undefined) return true;

  switch (op ?? "") {
    case "":
    case "^": {
      if (cmpLower() < 0) return false;
      if (M > 0) return below(M + 1, 0, 0);
      if (mn === undefined) return below(1, 0, 0);
      if (mn > 0) return below(0, mn + 1, 0);
      if (p === undefined) return below(0, 1, 0);
      return below(0, 0, p + 1);
    }
    case "~": {
      if (cmpLower() < 0) return false;
      return mn === undefined ? below(M + 1, 0, 0) : below(M, mn + 1, 0);
    }
    case "=": {
      if (p !== undefined) return compareSemver(version, render(M, mn, p, pre)) === 0;
      if (mn !== undefined) return cmpLower() >= 0 && below(M, mn + 1, 0);
      return cmpLower() >= 0 && below(M + 1, 0, 0);
    }
    case ">=":
      return cmpLower() >= 0;
    case ">": {
      if (p !== undefined) return compareSemver(version, render(M, mn, p, pre)) > 0;
      if (mn !== undefined) return compareSemver(version, render(M, mn + 1, 0)) >= 0;
      return compareSemver(version, render(M + 1, 0, 0)) >= 0;
    }
    case "<":
      if (p !== undefined) return compareSemver(version, render(M, mn, p, pre)) < 0;
      return mn !== undefined ? below(M, mn, 0) : below(M, 0, 0);
    case "<=": {
      if (p !== undefined) return compareSemver(version, render(M, mn, p, pre)) <= 0;
      return mn !== undefined ? below(M, mn + 1, 0) : below(M + 1, 0, 0);
    }
    default:
      // Unreachable: the grammar admits no other operator.
      return false;
  }
};

// Does `version` satisfy the requirement string `req` (comma-separated
// comparators, ALL of which must match)? true / false / null-for-refuse.
export const reqMatches = (req, version) => {
  const v = parseSemver(version);
  if (v === null || typeof req !== "string" || req.trim() === "") return null;
  const parsed = [];
  for (const part of req.split(",")) {
    const one = parseComparator(part);
    if (one === null) return null;
    parsed.push(one);
  }
  // The semver crate's prerelease rule, applied ONCE per requirement: a
  // prerelease version is admitted only when some comparator names its
  // numeric core with a prerelease of its own; once admitted, every
  // comparator evaluates by ordinary precedence.
  if (v.prerelease !== null) {
    const admitted = parsed.some(
      (c) => c.pre !== undefined && c.M === v.major && c.mn === v.minor && c.p === v.patch,
    );
    if (!admitted) return false;
  }
  return parsed.every((c) => comparatorSatisfied(c, v));
};

// The identity of a package's origin for pairing purposes: its source with
// the resolved-revision fragment stripped. A git source names the exact
// commit after `#`, which moves on every branch advance — pairing on the
// full string would read a rev bump as a remove-plus-add — while two
// different repositories holding the same crate name must never pair.
export const sourceIdentityOf = (source) =>
  source === null || source === undefined ? "" : String(source).split("#")[0];

// A package's identity, in Cargo's own package-ID form: `source#name@version`
// (`cargo pkgid` prints exactly this, and `cargo update` takes it). A name and
// a version are NOT an identity here -- one graph can hold a crates.io copy
// and a git copy of the same crate at the same version, which is why
// `groupByCompat` and `specFor` both exist -- so anything asking "is this the
// same package" compares this whole string.
//
// The source's `#fragment` is dropped on purpose: for a git dependency that is
// the revision, so two packages differing only by revision compare as the same
// crate from the same place. This identifies a package WITHIN one snapshot of
// the graph; across a move that changes the version, see `isAt`.
// The CRATE a package is a version of: its package ID without the version.
// `idOf` identifies a package in the graph; this names the crate underneath
// one or more of them, and `slotOf` narrows it back to a compatibility group.
export const crateOf = (pkg) => `${sourceIdentityOf(pkg.source)}#${pkg.name}`;

export const idOf = (pkg) => `${crateOf(pkg)}@${pkg.version}`;

// Whether `pkg` is the package a pin landed on. A restoration is identified by
// where it LANDED, not where it came from: the version -- or, for a git
// dependency, the revision -- is exactly what the pin changed, so an `idOf`
// captured beforehand can never match the package in the finished lockfile.
// Source and name alone would not do either, since one graph can hold two
// pre-release copies of a crate at incompatible versions, so the target
// travels with them. `pin`'s own success check and the report's lookup both
// ask this one question, so they cannot drift apart.
export const isAt = (pkg, source, name, to) =>
  pkg.name === name &&
  sourceIdentityOf(pkg.source) === source &&
  (pkg.version === to || (pkg.source ?? "").endsWith(`#${to}`));

// The compatibility identity Cargo's caret semantics assign a version: the
// major — except at 0.x, where the MINOR is the breaking boundary, and at
// 0.0.x, where every release is. Two versions are semver-compatible to
// Cargo exactly when these keys are equal. null when the version is not
// valid semver, so callers refuse rather than guess.
export const compatKeyOf = (v) => {
  const p = parseSemver(v);
  if (p === null) return null;
  if (p.major > 0) return String(p.major);
  if (p.minor > 0) return `0.${p.minor}`;
  return `0.0.${p.patch}`;
};

// The compatibility slot a package occupies, as the edge-group diff keys it:
// a sourceless (workspace/path) package by its exact version, since caret
// semantics don't apply there, otherwise its source identity plus its
// caret-compat key. `edgeGroups`, the survival test, and the post-loop restore
// all ask "same slot?" through this one function so they cannot drift.
export const compatSlotOf = (p) =>
  p.source === null
    ? `=${p.version}`
    : `${compatKeyOf(p.version)}\n${sourceIdentityOf(p.source)}`;

// The compatibility SLOT a crate's version occupies: the crate plus the compat
// group that version falls in. `idOf` identifies a package and `crateOf` the
// crate; this identifies what the report's final pass ITERATES -- one package
// per crate per compat group -- so it is the granularity at which "did this run
// choose this version" can be asked. Renamed dependencies put two incompatible
// versions of one crate in a graph, and the crate alone cannot tell them apart:
// pinning the 1.x copy would answer for the 2.x one, hiding a hold-back that
// really is the manifest's. The version is passed in rather than read off the
// package, because at pin time the answer is about the target, not the version
// being left behind. `compatKeyOf` is null for a git revision, which matches
// nothing -- correct, since the final pass asks only about crates.io packages.
export const slotOf = (pkg, version) => `${crateOf(pkg)}@${compatKeyOf(version)}`;

// ---------------------------------------------------------------------------
// Lockfile diff: what moved, what arrived, what left.
// ---------------------------------------------------------------------------

// Groups packages by (name, compat key). Cargo unifies semver-compatible
// versions, so each group holds at most one package per lockfile; a
// duplicate is a shape Cargo does not produce and lands in errors.
const groupByCompat = (packages, errors, which) => {
  const byName = new Map();
  for (const p of packages) {
    const key = compatKeyOf(p.version);
    // Prereleases get their numeric core's key: grouping "2.0.0-rc.1" with
    // its stable line is what lets a diff SEE a prerelease move and refuse
    // it, rather than reading it as an unrelated add.
    if (key === null) {
      errors.push(`${which}: ${p.name} ${p.version} is not valid semver`);
      continue;
    }
    // Source identity is part of the group: a valid graph can hold the
    // same crate name at compatible versions from two different git
    // repositories (renamed dependencies), and keying by compat alone
    // would refuse that consumer's baseline forever. Within one REGISTRY
    // source, two compatible versions remain a shape Cargo does not
    // produce — the resolver errors on conflicting exact requirements in
    // one compatibility range rather than locking both. Sourceless PATH
    // packages carry no range to unify, though, so renamed path
    // dependencies can hold one name at compatible versions side by
    // side; their versions come from manifests this batch never touches,
    // so each version is its own group and pairs with itself.
    const groupKey =
      p.source === null ? `=${p.version}` : `${key}\n${sourceIdentityOf(p.source)}`;
    if (!byName.has(p.name)) byName.set(p.name, new Map());
    const groups = byName.get(p.name);
    if (groups.has(groupKey)) {
      errors.push(
        `${which}: ${p.name} has two semver-compatible versions from one source ` +
          `(${groups.get(groupKey).version} and ${p.version}) — not a lockfile Cargo produced`,
      );
      continue;
    }
    groups.set(groupKey, p);
  }
  return byName;
};

// Compares two parsed lockfiles. Returns { changed, added, removed,
// unchanged, errors }; `changed` pairs old and new instances of the same
// (name, compat key), everything else is genuinely new or gone.
export const diffLockfiles = (oldLock, newLock) => {
  const errors = [];
  const before = groupByCompat(oldLock.packages, errors, "baseline");
  const after = groupByCompat(newLock.packages, errors, "updated");
  const changed = [];
  const added = [];
  const removed = [];
  const unchanged = [];
  for (const [name, groups] of before) {
    for (const [key, pkg] of groups) {
      const now = after.get(name)?.get(key);
      if (now === undefined) {
        removed.push(pkg);
      } else if (now.version === pkg.version) {
        unchanged.push({ before: pkg, after: now });
      } else {
        changed.push({ name, key, from: pkg.version, to: now.version, before: pkg, after: now });
      }
    }
  }
  for (const [name, groups] of after) {
    for (const [key, pkg] of groups) {
      if (before.get(name)?.get(key) === undefined) added.push(pkg);
    }
  }
  return { changed, added, removed, unchanged, errors };
};

// The workspace's own packages: no source means the package lives in this
// repository, and its lockfile dependencies mirror its manifests.
export const workspaceMembers = (lock) => lock.packages.filter((p) => p.source === null);

// The crate names the workspace depends on directly, across every member
// and every dependency kind (the lockfile does not distinguish dev from
// normal — deliberate breadth: a dev dependency crossing a major is still a
// migration).
export const directDepNames = (lock) => {
  const names = new Set();
  const members = new Set(workspaceMembers(lock).map((p) => p.name));
  for (const member of workspaceMembers(lock)) {
    for (const ref of member.dependencies ?? []) {
      const parsed = parseDepRef(ref);
      if (parsed && !members.has(parsed.name)) names.add(parsed.name);
    }
  }
  return names;
};

// ---------------------------------------------------------------------------
// Registry metadata.
// ---------------------------------------------------------------------------

// The sparse index's path scheme: /1/n, /2/na, /3/n/nam, /na/me/name —
// lowercased, as the index stores names.
export const indexPathFor = (name) => {
  const n = String(name).toLowerCase();
  if (n.length === 1) return `1/${n}`;
  if (n.length === 2) return `2/${n}`;
  if (n.length === 3) return `3/${n[0]}/${n}`;
  return `${n.slice(0, 2)}/${n.slice(2, 4)}/${n}`;
};

// Fetches the index record for one crate: every published version with its
// checksum, yank status, and declared dependencies. Returns { versions,
// errors }; a crate the index does not know (404) is an error here, because
// every crate this job asks about came out of a lockfile that names it.
export const fetchCrateIndex = async (name, fetcher, indexUrl = INDEX_URL) => {
  const url = `${indexUrl}/${indexPathFor(name)}`;
  const versions = [];
  const errors = [];
  try {
    const res = await fetcher(url);
    if (!res.ok) {
      errors.push(`${url}: HTTP ${res.status}`);
      return { versions, errors };
    }
    for (const line of (await res.text()).split("\n")) {
      if (line.trim() === "") continue;
      let record;
      try {
        record = JSON.parse(line);
      } catch {
        errors.push(`${url}: unparseable index line`);
        continue;
      }
      if (typeof record.vers !== "string") {
        errors.push(`${url}: index line with no version`);
        continue;
      }
      versions.push({
        vers: record.vers,
        cksum: typeof record.cksum === "string" ? record.cksum : null,
        yanked: record.yanked === true,
        deps: Array.isArray(record.deps) ? record.deps : [],
      });
    }
    if (versions.length === 0 && errors.length === 0) {
      errors.push(`${url}: no versions in the index record`);
    }
  } catch (e) {
    errors.push(`${url}: ${e.message ?? e}`);
  }
  return { versions, errors };
};

// Publish time of one version, from the crates.io API. Returns a Date, or
// null when the answer is unavailable — and the callers treat null as "too
// new", the fail-closed direction for a cooldown. A network failure is the
// same null, never an exception: an unknowable date defers one candidate
// and is reported, it does not abort the batch.
export const fetchVersionDate = async (name, version, fetcher, apiUrl = API_URL) => {
  const url = `${apiUrl}/crates/${encodeURIComponent(name)}/${encodeURIComponent(version)}`;
  try {
    const res = await fetcher(url);
    if (!res.ok) return null;
    const created = (await res.json())?.version?.created_at;
    if (typeof created !== "string") return null;
    const date = new Date(created);
    return Number.isNaN(date.getTime()) ? null : date;
  } catch {
    return null;
  }
};

// ---------------------------------------------------------------------------
// Policy enforcement: cooldown and transitive majors, by pinning back.
// ---------------------------------------------------------------------------

// How many missing-date deferrals the cooldown tolerates per package before
// giving up on it. Candidates rejected for being inside the window don't
// count: each such rejection proves the crate released that recently, so
// the walk is bounded by its real cadence. Missing dates are the unbounded
// case (an API outage would otherwise be polled once per version ever
// published), so they are what the cap counts.
const MISSING_DATE_LIMIT = 5;

// Iterations of the fix-up loop. Every pin moves some version strictly
// downward within its compat group, so the loop terminates on its own —
// and every round applies at most ONE pin before re-parsing, because a pin
// can reshape the graph and judging stale entries would pin or block
// packages that no longer exist. A busy batch legitimately takes one round
// per deferral, so the bound is generous; it is a backstop against a bug,
// not a policy.
const MAX_ROUNDS = 100;

// The newest candidate in `index` acceptable as a pin-back target for
// `pkg`: same compat group, strictly below the version being vacated,
// at or above `floor` (the version the batch started from — never propose a
// downgrade below where the consumer already was; null when anything below
// works), stable, not yanked, and outside the cooldown. Returns
// { candidate, reasons } — candidate null when nothing qualifies.
export const findPinback = async (
  name,
  chosen,
  floor,
  index,
  { cooldownDays, now, versionDate },
) => {
  const reasons = [];
  const key = compatKeyOf(chosen);
  const candidates = index.versions
    .filter((v) => !v.yanked && isStable(v.vers) && compatKeyOf(v.vers) === key)
    .filter((v) => compareSemver(v.vers, chosen) < 0)
    .filter((v) => floor === null || compareSemver(v.vers, floor) > 0)
    .sort((a, b) => compareSemver(b.vers, a.vers));
  const cutoff = now.getTime() - cooldownDays * 24 * 60 * 60 * 1000;
  let missingDates = 0;
  for (const v of candidates) {
    if (missingDates >= MISSING_DATE_LIMIT) break;
    const date = await versionDate(name, v.vers);
    if (date === null) {
      reasons.push(`${name} ${v.vers}: no publish date, treated as too new`);
      missingDates++;
      continue;
    }
    if (date.getTime() > cutoff) {
      reasons.push(
        `${name} ${v.vers}: published ${date.toISOString().slice(0, 10)}, ` +
          `inside the ${cooldownDays}-day cooldown`,
      );
      continue;
    }
    return { candidate: v.vers, reasons };
  }
  return { candidate: null, reasons };
};

// ---------------------------------------------------------------------------
// The whole update.
// ---------------------------------------------------------------------------

/**
 * The packages Cargo names as standing in the way of a `--precise` pin, from
 * its own error output, nearest blocker first.
 *
 * A crate family that pins itself with exact `=` requirements cannot be
 * unwound one package at a time: `cargo update --precise 0.2.127
 * wasm-bindgen-macro-support` is refused because `wasm-bindgen-macro v0.2.128`
 * requires exactly 0.2.128, and pinning THAT is refused because `js-sys`
 * requires `wasm-bindgen` exactly in turn. The reachable pin is an ancestor's.
 *
 * An exact `=` is the motivating shape, not the only one Cargo reports this
 * way: an ordinary range that excludes the requested version (a parent that
 * raised `^1.0` to `^1.1`) names its package in the same form, and rolling
 * THAT back can succeed too. So nothing here — or in the report the walk
 * feeds — claims the blocking requirement was exact; the error text carries
 * the requirement, but tying each one to the right blocker is a second parse
 * of a format Cargo is free to change, and the walk does not need it.
 *
 * Cargo's error is the only signal available for this: a lockfile records
 * resolved edges, not the requirement strings that make one exact, so nothing
 * in the graph this tool parses distinguishes `=0.2.128` from `^0.2`.
 */
export const blockersFrom = (output) =>
  [...String(output ?? "").matchAll(/required by package `([^`\s]+) v([^`\s]+)`/g)].map(
    ([, name, version]) => ({ name, version }),
  );

// Rewrites specific dependency references in the lockfile TEXT: within the
// `[[package]]` block at each edit's `line` (the 1-indexed header line the
// parser records), the one entry ` "<fromRef>",` becomes ` "<toRef>",`. Text
// surgery rather than a re-render so cargo's formatting is preserved exactly
// and only the named edges move; `cargo metadata --locked` then validates the
// result. Throws if an edge is not found where it was recorded, since a
// silent miss would ship the crossing this exists to undo.
export const restoreLockfileEdges = (text, edits) => {
  const lines = text.split("\n");
  for (const { line, fromRef, toRef } of edits) {
    let inDeps = false;
    let done = false;
    for (let i = line; i < lines.length; i++) {
      const l = lines[i];
      if (!inDeps && /^\[/.test(l)) break; // next section reached without the array
      if (l === "dependencies = [") {
        inDeps = true;
        continue;
      }
      if (inDeps) {
        if (l === "]") break;
        if (l === ` "${fromRef}",`) {
          lines[i] = ` "${toRef}",`;
          done = true;
          break;
        }
      }
    }
    if (!done) {
      throw new Error(`restore: edge "${fromRef}" not found in the package block at line ${line}`);
    }
  }
  return lines.join("\n");
};

// Runs `cargo update`, then enforces the cooldown and the no-transitive-
// majors rule by pinning offenders back, then derives the report. Effects
// are injected: `readLockfile` returns the current lockfile text,
// `writeLockfile(text)` overwrites it, `runCargo(args)` runs cargo and returns
// { ok, output }, `fetcher` speaks HTTPS, `now` is the clock. Throws on an
// unparseable lockfile or a failed plain `cargo update`; policy violations
// that survive the fix-up loop land in the returned `blocking` list, and the
// CLI restores the lockfile and fails the run on them.
export const updateLockfile = async ({
  readLockfile,
  writeLockfile,
  runCargo,
  fetcher,
  now = new Date(),
  cooldownDays = 5,
  indexUrl = INDEX_URL,
  apiUrl = API_URL,
}) => {
  const oldText = readLockfile();
  const oldLock = parseLockfile(oldText);
  if (oldLock.errors.length > 0) {
    throw new Error(`cannot parse the committed Cargo.lock:\n${oldLock.errors.join("\n")}`);
  }

  const update = runCargo(["update"]);
  if (!update.ok) {
    throw new Error(`cargo update failed:\n${update.output}`);
  }

  // Effect caches: one index fetch per crate name, one date fetch per
  // (name, version), however many rounds the loop takes.
  const indexCache = new Map();
  const dateCache = new Map();
  const errors = [];
  const crateIndex = async (name) => {
    if (!indexCache.has(name)) {
      const result = await fetchCrateIndex(name, fetcher, indexUrl);
      errors.push(...result.errors);
      indexCache.set(name, result);
    }
    return indexCache.get(name);
  };
  const versionDate = (name, version) => {
    const key = `${name}@${version}`;
    if (!dateCache.has(key)) dateCache.set(key, fetchVersionDate(name, version, fetcher, apiUrl));
    return dateCache.get(key);
  };

  const cutoff = () => now.getTime() - cooldownDays * 24 * 60 * 60 * 1000;

  // What the fix-up loop decided, keyed for the report. `cooldown` entries
  // carry the walk's reasons; `crossings` name the dependent pinned back
  // and the major it would have dragged in; `blocking` is what nothing
  // could fix.
  //
  // `cooldown` records an action, so it is written where that action's
  // outcome is known — after the pin, not before it. `crossings` records a
  // DETECTION, whose outcome is known when it is detected: the crossing is
  // real whether or not a pin can unwind it, and a batch that cannot unwind
  // one blocks with the entry still standing. Don't "fix" that asymmetry by
  // moving the crossing push; do keep any new record on the side its own
  // outcome is settled.
  const cooldown = [];
  const crossings = [];
  const restored = [];
  // Unchanged dependents whose edge to a transitive this run's own fix-ups
  // deduped onto another in-range copy, while the copy it left still stands.
  // Keyed `${idOf(dep)}\n${transitive}`; its edge is put back to HEAD's copy
  // after the loop and cargo validates the result. See the post-loop restore.
  const edgeRestores = new Map();
  const blocking = [];
  // Every compatibility slot (see `slotOf`) whose version in the finished
  // lockfile is THIS RUN's choice rather than the resolver's: a crossing mover
  // pinned back, an ancestor rolled back to reach one, a restoration, a
  // cooldown deferral. The final pass needs it so a miss the engine caused is
  // not blamed on the manifest.
  const pinnedHere = new Set();
  // Every pin is recorded where its outcome is known, never where it is
  // asked for, and the two outcomes have different lifetimes.
  //
  // `applied` is the run: a pin that landed changed the lockfile, so being
  // asked for it again means the violation it was meant to fix survived
  // it. That is a stuck batch and gets reported rather than re-fought.
  //
  // `refused` is the ROUND. A refusal changes nothing, so within one round
  // the same request has the same answer and is worth memoizing — but a
  // pin that lands moves the graph, and the request cargo refused against
  // the old one may resolve against the new. That is the whole point of
  // the ancestor unwind below, and holding refusals for the run is what
  // used to block the retry it exists to enable.
  const applied = new Set();
  let refused = new Map();

  let newText = readLockfile();
  let newLock = parseLockfile(newText);
  let diff;
  for (let round = 0; ; round++) {
    if (newLock.errors.length > 0) {
      throw new Error(`cargo produced a lockfile this tool cannot parse:\n${newLock.errors.join("\n")}`);
    }
    diff = diffLockfiles(oldLock, newLock);
    if (diff.errors.length > 0) {
      throw new Error(`lockfile diff refused:\n${diff.errors.join("\n")}`);
    }
    if (round >= MAX_ROUNDS) {
      blocking.push(`the fix-up loop did not settle in ${MAX_ROUNDS} rounds — internal error`);
      break;
    }

    let acted = false;
    // Refusals are judged against this round's graph, so they expire with
    // it — see the declaration above.
    refused = new Map();
    // Blocking judged this round, held apart from the durable list: a pin
    // reshapes the graph, so a violation judged before the round's pin can
    // name a package the pin removes. If the round ends with a pin, these
    // are discarded and re-derived against the fresh parse; only a round
    // that settles with no pin gets to make its blocks final.
    const roundBlocking = [];
    const block = (why) => roundBlocking.push(why);
    // Returns `false` when no pin landed, otherwise `{ reached, via? }`.
    //
    // The two facts are separate and every caller needs the right one.
    // Truthy means A PIN LANDED: the graph has moved, so the round is over
    // and the caller stops. `reached` means THE REQUESTED PACKAGE is now at
    // the target this pin asked for, which a pin through an ancestor
    // achieves only when that ancestor's requirement drags it (an exact `=`
    // does, an excluding range does not — and a revert can also delete the
    // package outright). Anything recording the requested package's own
    // arrival — `restored`, `cooldown`, a crossing's `via` — is gated on
    // `reached`, or it asserts something that did not happen.
    // Cargo names a blocker in prose -- `required by package `p v1.0.0`` --
    // which is a name and a version, not a package ID. That pair is not an
    // identity, so resolving it against the graph is a lookup that can return
    // none, one, or several.
    //
    // Cargo's own answer to the same problem is the model. A package-ID spec
    // is a PARTIAL identity resolved against the graph: `cargo pkgid syn@3`
    // finds one package, and bare `syn` on a graph holding syn 2 and syn 3
    // does not choose -- it errors, lists the candidates, and does nothing.
    // So: exactly one is the only case that proceeds. Pinning the wrong copy
    // back would revert an unrelated, valid update, which is worse than the
    // walk declining to route through it.
    //
    // The graph narrows what the prose cannot. A blocker is a package whose
    // requirement refused this pin, so it has a dependency edge to the package
    // being pinned; where name and version alone are ambiguous, keeping only
    // the copies carrying that edge usually leaves one. `blocker.of` is what
    // the failure was about, which is why the queue carries it.
    const resolveBlocker = (blocker) => {
      const byNameVersion = newLock.packages.filter(
        (o) => o.name === blocker.name && o.version === blocker.version,
      );
      if (byNameVersion.length < 2 || blocker.of === undefined) return byNameVersion;
      const connected = byNameVersion.filter((o) =>
        (o.dependencies ?? []).some((ref) => resolveDepRef([blocker.of], ref).length > 0),
      );
      // Narrowing to nothing means the edge is not visible here; report the
      // ambiguity rather than silently dropping every candidate.
      return connected.length === 0 ? byNameVersion : connected;
    };

    const pin = (pkg, to, why) => {
      // The package, not a formatted spec: the spec is derived here so the
      // identity stays available. Parsing it back out of the string lost the
      // source, and two packages can share a name — `groupByCompat` and
      // `specFor` both exist for exactly that.
      const spec = specFor(pkg);
      const key = `${spec}@${to}`;
      if (applied.has(key)) {
        // Asking for a pin that already landed means this round's
        // violation survived that fix: report, stop.
        block(why);
        return false;
      }
      if (refused.has(key)) {
        // Same request, same graph, same answer — replay it rather than
        // spend another cargo invocation reaching it.
        block(`${why} — and pinning ${spec} back to ${to} failed:\n${refused.get(key)}`);
        return false;
      }
      const result = runCargo(["update", spec, "--precise", to]);
      if (result.ok) {
        applied.add(key);
        pinnedHere.add(slotOf(pkg, to));
        acted = true;
        // Cargo confirmed it set this spec to `to`; nothing to re-read.
        return { reached: true };
      }
      refused.set(key, result.output);
      // Refused. Before blocking the whole batch, walk the ancestors Cargo
      // named: whoever requires the mover at a version this pin would
      // exclude is where the reachable pin is, and pinning THEM back drags
      // the mover with them — the same outcome by the only route the
      // resolver allows. The motivating case is a family that pins itself
      // with exact `=` requirements (wasm-bindgen), which leaves no
      // reachable pin on the mover at all; an ordinary range that excludes
      // the version reads the same way to Cargo and is handled the same.
      // Breadth-first from the nearest blocker, each visited once, bounded
      // by the graph.
      const seen = new Set();
      // Each entry carries the package whose pin the failure was about, so a
      // blocker named ambiguously can be narrowed by the edge it refused on —
      // see `resolveBlocker`.
      const queue = blockersFrom(result.output).map((b) => ({ ...b, of: pkg }));
      // Every ancestor tried and every one that could not be, kept for the
      // failure message: a walk that ends in a block has to say what it
      // did, or a blocked consumer is left with only the mover's refusal
      // and no sign the ancestors were ever considered.
      const tried = [];
      const skipped = [];
      // `seen` is what terminates this: a finite graph, each identity visited
      // once. The count is a backstop for a blocker cargo names that is not in
      // the lockfile at all, and it counts VISITS rather than dequeues — a
      // shared layer is enqueued once per dependent, and charging those
      // duplicates lets a wide fan-in exhaust the budget before the moved
      // ancestor behind them ever reaches the front.
      let visited = 0;
      while (queue.length > 0 && visited <= newLock.packages.length) {
        const blocker = queue.shift();
        const at = `${blocker.name}@${blocker.version}`;
        // Resolve cargo's prose to a package before anything else reads it.
        // Zero or several and the walk does not guess — see `resolveBlocker`.
        const found = resolveBlocker(blocker);
        if (found.length !== 1) {
          if (seen.has(at)) continue;
          seen.add(at);
          visited++;
          skipped.push(
            found.length === 0
              ? `${at} — cargo named it, but no package in the lockfile matches`
              : `${at} — ambiguous: ${found.length} packages share that name and version ` +
                `(${found.map((o) => idOf(o)).join(", ")}), and cargo's error does not say ` +
                "which refused; pinning the wrong one back would revert an unrelated update",
          );
          continue;
        }
        const [target] = found;
        const id = idOf(target);
        if (seen.has(id)) continue;
        seen.add(id);
        visited++;
        // Only a package this batch MOVED can be pinned back, and only to
        // the version it moved from — that is what "back" means here, and
        // the diff is where it is recorded.
        const pair = diff.changed.find((c) => idOf(c.after) === id);
        if (pair === undefined) {
          // No version to pin it back to — but that is a dead end only for
          // THIS package, not for the walk. A parent that moved can have
          // introduced the blocker: reverting the parent takes the blocker
          // with it and frees the pin, and stopping here blocks a batch that
          // had a route. So climb to whoever depends on it in the new graph
          // and let them be tried the same way.
          //
          // Cargo names the chain only as far as the requirement it could
          // not satisfy, so the reverse edges are read from the lockfile
          // rather than from its error. Each is still visited once and the
          // step bound is unchanged, so this widens what the walk reaches
          // without widening how far it can run.
          const dependents = newLock.packages.filter((o) =>
            (o.dependencies ?? []).some((ref) => resolveDepRef([target], ref).length > 0),
          );
          for (const d of dependents) {
            queue.push({ name: d.name, version: d.version, of: target });
          }
          skipped.push(
            `${at} — this batch did not move it, so there is no version to pin back to` +
              (dependents.length > 0
                ? `; climbed to ${dependents.map((d) => `${d.name}@${d.version}`).join(", ")}`
                : ""),
          );
          continue;
        }
        const aspec = specFor(pair.after);
        const akey = `${aspec}@${pair.before.version}`;
        if (applied.has(akey)) {
          skipped.push(`${aspec} back to ${pair.before.version} — already pinned this run`);
          continue;
        }
        if (refused.has(akey)) {
          skipped.push(`${aspec} back to ${pair.before.version} — cargo already refused that this round`);
          continue;
        }
        const attempt = runCargo(["update", aspec, "--precise", pair.before.version]);
        if (attempt.ok) {
          applied.add(akey);
          pinnedHere.add(slotOf(pair.after, pair.before.version));
          acted = true;
          // The ancestor moved; the mover may not have. An exact `=` drags it
          // back, but an ordinary range that merely EXCLUDED the old version
          // does not: reverting a parent from `^2.1` to `^2.0` still admits
          // the child locked at 2.1, so the crossing survives into the next
          // round — where the mover's own pin is now permitted, because the
          // requirement that refused it is gone. Nothing has to be undone for
          // that retry to be allowed: the mover's refusal is this round's,
          // and this pin ends the round.
          //
          // This cannot spin. A retry either succeeds (progress) or fails and
          // walks again, and a walk only reaches ancestors this batch moved —
          // a set the successful pins keep shrinking — with MAX_ROUNDS behind
          // it either way.
          //
          // Which of the two happened is what every caller recording the
          // REQUESTED package's own arrival has to know, so it is answered
          // here rather than assumed: re-read, and look for the package AT
          // THE TARGET this pin asked for.
          //
          // Asking the other question — is it still at the version we were
          // moving it off — reads absence as arrival, and an ancestor revert
          // can remove the package from the graph outright: reverting the
          // parent that introduced a newly-added crate takes the crate with
          // it. The report would then name a version of a package the
          // lockfile does not contain at all.
          //
          // Matched on source identity as well as name: a crates.io copy and
          // a git one can share a name, and a same-named package sitting at
          // the target answers for a requested package that never moved. The
          // identity is the source without its fragment, which is what stays
          // put across a git restoration — the revision is the thing being
          // changed.
          //
          // A git restoration pins to a revision rather than a version, so
          // the target is matched against either. An unparseable lockfile
          // answers "did not arrive" — the round loop throws on it a few
          // lines later, and not writing a record beats writing one that
          // cannot be confirmed.
          const identity = sourceIdentityOf(pkg.source);
          const afterAncestor = parseLockfile(readLockfile());
          const reached =
            afterAncestor.errors.length === 0 &&
            afterAncestor.packages.some((o) => isAt(o, identity, pkg.name, to));
          // Dragged back by the ancestor, so its version is this run's choice
          // too; left where it was, and it is not.
          if (reached) pinnedHere.add(slotOf(pkg, to));
          return {
            reached,
            // The source travels with it for the same reason it travels with a
            // crossing: `via` makes its own claim about its own package, and
            // the claim cannot be checked against the final graph without one.
            via: {
              source: sourceIdentityOf(pair.after.source),
              name: pair.after.name,
              from: pair.after.version,
              to: pair.before.version,
            },
          };
        }
        tried.push(`${aspec} back to ${pair.before.version} also failed:\n${attempt.output}`);
        queue.push(...blockersFrom(attempt.output).map((b) => ({ ...b, of: pair.after })));
      }
      const trail = [
        ...(tried.length > 0 ? ["the ancestors cargo named were tried too:", ...tried] : []),
        ...(skipped.length > 0 ? ["ancestors cargo named that could not be pinned:", ...skipped] : []),
      ];
      block(
        `${why} — and pinning ${spec} back to ${to} failed:\n${result.output}` +
          (trail.length > 0 ? `\n${trail.join("\n")}` : ""),
      );
      return false;
    };
    // The package-ID spec a pin names. Registry packages are unambiguous as
    // name@version (one version per compat group per source, and only one
    // registry is managed); anything else gets the URL-qualified form —
    // two git repositories can expose the same crate name at the same
    // version, and Cargo rejects a bare name@version spec as ambiguous
    // exactly then.
    const specFor = (pkg) => {
      // name@version is enough only while no OTHER source in the graph
      // exposes the same crate name at the same version — a git copy
      // beside the crates.io one makes the bare spec ambiguous and Cargo
      // refuses it — so any shared name+version gets the URL-qualified
      // form, whichever side is being pinned.
      const shared = newLock.packages.some(
        (o) => o !== pkg && o.name === pkg.name && o.version === pkg.version,
      );
      return !shared && pkg.source === CRATES_IO_SOURCE
        ? `${pkg.name}@${pkg.version}`
        : `${sourceIdentityOf(pkg.source)}#${pkg.name}@${pkg.version}`;
    };

    // Restoration first: this job does not manage non-crates.io packages or
    // pre-release pins, but a bare `cargo update` still refreshes both — an
    // unpinned git branch's resolved commit moves with its remote, and a
    // pre-release pin whose stable release appeared gets promoted. The
    // reverse move exists too: a requirement that NAMES a pre-release
    // admits it (">=1.0, <2.0.0-beta" matches 2.0.0-alpha), so cargo can
    // move a stable pin onto one — and the batch takes stable releases
    // only, so that move is declined the same way. Restore each to its
    // committed identity, or the validator would refuse the move and
    // block the whole batch. A git source pins back by its old revision
    // fragment; any other non-registry source, and any pre-release move,
    // by the old version. Unrestorable blocks, as anything else would.
    for (const pair of [...diff.changed, ...diff.unchanged]) {
      if (pair.before.source === null && pair.after.source === null) continue;
      const registry =
        pair.before.source === CRATES_IO_SOURCE && pair.after.source === CRATES_IO_SOURCE;
      if (registry && isStable(pair.before.version) && isStable(pair.after.version)) continue;
      if (registry && pair.before.version === pair.after.version) continue;
      if (pair.before.source === pair.after.source && pair.before.version === pair.after.version) continue;
      const why = !registry
        ? `${pair.after.name} moved from ${pair.before.version} (${pair.before.source}) to ` +
          `${pair.after.version} (${pair.after.source}) — a non-crates.io dependency this job does not manage`
        : isStable(pair.before.version)
          ? `${pair.after.name} moved from ${pair.before.version} to ${pair.after.version} — ` +
            "a pre-release this job does not take"
          : `${pair.after.name} moved from ${pair.before.version} to ${pair.after.version} — ` +
            "a pre-release pin this job does not manage";
      const target = registry
        ? pair.before.version
        : ((pair.before.source ?? "").split("#")[1] ?? pair.before.version);
      const outcome = pin(pair.after, target, why);
      if (outcome) {
        if (outcome.reached)
          restored.push({
            source: sourceIdentityOf(pair.after.source),
            name: pair.after.name,
            to: target,
          });
        break; // one pin per round — the graph must be re-read first
      }
    }

    // A move can also cross compatibility groups outright, which the diff
    // reads as a removal plus an arrival, not a change — so the pairwise
    // pass above never sees it. Two arrivals qualify: a stable pin dragged
    // onto a pre-release (a requirement that names one admits it), pinned
    // back to the stable version it displaced, and a non-crates.io package
    // whose refresh crossed groups (a git branch advancing over a major
    // bump), pinned back to its committed revision. Either runs before the
    // crossing pass so the edge the move rewrote is unwound rather than
    // judged. A pre-release arrival with no displaced version behind it
    // has nowhere to go, and blocks; a non-registry arrival with no
    // removed counterpart is left for the post-loop appeared/vanished
    // blocks.
    if (!acted) for (const a of diff.added) {
      if (a.source === null) continue; // sourceless versions cannot move mid-run
      const registry = a.source === CRATES_IO_SOURCE;
      if (registry && isStable(a.version)) continue;
      const back = diff.removed
        .filter(
          (r) =>
            r.name === a.name &&
            (registry
              ? r.source === CRATES_IO_SOURCE
              : sourceIdentityOf(r.source) === sourceIdentityOf(a.source)),
        )
        .sort((x, y) => compareSemver(y.version, x.version))[0];
      if (back === undefined) {
        if (registry) {
          block(
            `${a.name} ${a.version} arrived as a pre-release — this job takes stable ` +
              `releases only, and no removed ${a.name} exists to restore`,
          );
        }
        continue;
      }
      const why = registry
        ? `${a.name} ${a.version} arrived as a pre-release — this job takes stable releases only`
        : `${a.name} moved from ${back.version} (${back.source}) to ${a.version} (${a.source}) — ` +
          "a non-crates.io dependency this job does not manage";
      const target = registry
        ? back.version
        : ((back.source ?? "").split("#")[1] ?? back.version);
      const outcome = pin(a, target, why);
      if (outcome) {
        if (outcome.reached)
          restored.push({ source: sourceIdentityOf(a.source), name: a.name, to: target });
        break; // one pin per round
      }
    }

    // Transitive majors next, only in rounds where no restoration
    // happened: a restore reshapes the graph, and judging edges that are
    // about to be unwound would pin movers for no reason.
    if (!acted) {
    // Transitive majors: an in-range bump can change a dependent's
    // own requirements, moving one of ITS dependencies across a breaking
    // boundary — and the old copy surviving for some other dependent hides
    // nothing, because the detection is per EDGE (npm-update's instance
    // rule, ported). Edges are keyed by (crate name, compatibility group),
    // not name alone: renamed dependencies let one package depend on two
    // incompatible versions of the same crate at once, and a by-name map
    // would drop one of those edges and misread the survivor as a
    // crossing. For each name a pair declares on both sides, a compat
    // group lost AND gained together are a crossing; a group only lost or
    // only gained is a legitimate drop or add of an edge. A crossing on a
    // CHANGED dependent is unwound by pinning the dependent back; one on
    // an UNCHANGED package (a workspace member included) has no bump to
    // unwind and is not something cargo update produces — refuse.
    const pairs = [
      ...diff.changed.map((c) => ({ before: c.before, after: c.after, change: c })),
      ...diff.unchanged.map((u) => ({ before: u.before, after: u.after, change: null })),
    ];
    const edgeGroups = (pkg, packages) => {
      const byName = new Map();
      for (const ref of pkg.dependencies ?? []) {
        const targets = resolveDepRef(packages, ref);
        if (targets.length !== 1) {
          block(
            `${pkg.name} ${pkg.version}: dependency "${ref}" does not resolve uniquely — ` +
              "refusing to reason about this graph",
          );
          continue;
        }
        const target = targets[0];
        // Keyed as in the lockfile diff: dual edges to one crate from two
        // different sources — or to two compatible versions of a renamed
        // path dependency — are a valid graph, not a duplicate.
        const key = compatSlotOf(target);
        if (!byName.has(target.name)) byName.set(target.name, new Map());
        const groups = byName.get(target.name);
        if (groups.has(key) && groups.get(key) !== target) {
          block(
            `${pkg.name} ${pkg.version}: two dependency edges to ${target.name} in the same ` +
              "compatibility group — refusing to reason about this graph",
          );
          continue;
        }
        groups.set(key, target);
      }
      return byName;
    };
    // Edge groups are read for every pair, and again for every changed
    // package when an unchanged dependent's crossing hunts its anchor mover
    // (below). Memoize per (side, package): a repeat call would recompute
    // the same groups and re-push the same block on an unresolvable ref.
    const edgeGroupsCache = new Map();
    const edgesOf = (pkg, packages, side) => {
      const key = `${side}:${idOf(pkg)}`;
      if (!edgeGroupsCache.has(key)) edgeGroupsCache.set(key, edgeGroups(pkg, packages));
      return edgeGroupsCache.get(key);
    };
    // One pin per mover, however many of its edges crossed — asking twice
    // would trip pin()'s repeat guard on a batch that only needs one pin.
    const moverPins = new Map();
    for (const pair of pairs) {
      const before = edgesOf(pair.before, oldLock.packages, "old");
      const after = edgesOf(pair.after, newLock.packages, "new");
      for (const [name, beforeGroups] of before) {
        const afterGroups = after.get(name);
        if (afterGroups === undefined) continue; // every edge to this name dropped
        const lost = [...beforeGroups.keys()].filter((k) => !afterGroups.has(k));
        const gained = [...afterGroups.keys()].filter((k) => !beforeGroups.has(k));
        if (lost.length === 0 || gained.length === 0) continue;
        const was = lost.map((k) => beforeGroups.get(k).version).join(", ");
        const now = gained.map((k) => afterGroups.get(k).version).join(", ");
        const crossing =
          `${pair.after.name}'s edge to ${name} would cross from ${was} ` +
          `to ${now} — a semver-incompatible move`;
        if (pair.change === null) {
          // The dependent did not itself change, so cargo consolidated its
          // edge onto a surviving copy. Which fix depends on whether the copy
          // it left still exists, so ask that FIRST — before hunting an anchor
          // mover — since a still-present group must not send an unrelated
          // update to the hold-back path merely because some changed package
          // also happened to drop its own edge to it.
          //
          // (a) EVERY compat group this edge left still stands in the shipped
          // tree — another dependent keeps it — so nothing vanished: cargo
          // merely re-deduped this unchanged dependent onto an in-range copy
          // its requirement already admits, typically because THIS run's own
          // cooldown pin-back re-ran the resolver (mesh's windows-sys 0.61.2,
          // kept alive by `mio`, while holding `rustix` back slid
          // errno/nu-ansi-term/rustix onto the 0.59.0 copy `fd-lock` keeps).
          // Record the dependent; its edge is put back to the surviving copy
          // after the loop and cargo validates the result, so nothing here has
          // to reason about whether the move was benign.
          const vanished = lost.filter(
            (k) => !newLock.packages.some((p) => p.name === name && compatSlotOf(p) === k),
          );
          if (vanished.length === 0) {
            edgeRestores.set(`${idOf(pair.after)}\n${name}`, { dep: pair.after, name });
            continue;
          }
          // (b) A group genuinely vanished — its last referencer, the anchor,
          // was a CHANGED package whose bump dropped that edge to `name`.
          // Pinning that mover back restores the copy and un-crosses this
          // dependent, which is the per-package hold-back — the mover is held
          // back, the dependent rides along. The hunt targets the VANISHED
          // groups specifically: a survivor another package still keeps is no
          // reason to pin. Only a mover this batch changed can be pinned back
          // to a version it moved from; if the anchor went with a package
          // removed outright, or none is found, there is nothing to hold back
          // and the batch blocks — the fail-loud case the incremental sibling
          // keeps too.
          const anchorMovers = diff.changed.filter((c) => {
            const beforeEdges = edgesOf(c.before, oldLock.packages, "old").get(name);
            const afterEdges = edgesOf(c.after, newLock.packages, "new").get(name);
            return vanished.some((k) => Boolean(beforeEdges?.has(k)) && !afterEdges?.has(k));
          });
          if (anchorMovers.length === 0) {
            block(
              `${crossing}, on a package that did not itself change, and no updated ` +
                `package in this batch dropped an edge to ${name} ${was} to unwind it — ` +
                "not something cargo update produces",
            );
            continue;
          }
          for (const c of anchorMovers) {
            crossings.push({
              source: sourceIdentityOf(c.after.source),
              name: c.name,
              from: c.from,
              to: c.to,
              dragged: { name, from: was, to: now },
            });
            moverPins.set(idOf(c.after), {
              pkg: c.after,
              to: c.from,
              why:
                `${c.name} ${c.from} → ${c.to} drops the ${name} ${was} anchor, ` +
                `forcing ${pair.after.name}'s edge across to ${now}`,
            });
          }
          continue;
        }
        crossings.push({
          // The mover's source identity travels with the record: two copies of
          // one crate from different sources can both cross, and every later
          // comparison -- the dedup key, the `via` attach, the reconciliation
          // against the shipped lockfile -- has to tell them apart.
          source: sourceIdentityOf(pair.change.after.source),
          name: pair.change.name,
          from: pair.change.from,
          to: pair.change.to,
          dragged: { name, from: was, to: now },
        });
        // Keyed on the mover's identity, not its name and version: two copies
        // of one crate from different sources can both cross in one round, and
        // a shared key would drop one of their pins.
        moverPins.set(idOf(pair.change.after), {
          pkg: pair.change.after,
          to: pair.change.from,
          why: crossing,
        });
      }
    }
    for (const m of moverPins.values()) {
      const outcome = pin(m.pkg, m.to, m.why);
      if (!outcome) continue;
      // An ancestor pin reached the same result by a different route, so the
      // report says so: the reader is owed the package that actually stayed
      // behind, not just the one whose edge was refused. Only when the mover
      // really stayed, though — an ancestor whose range merely excluded the
      // old version leaves it where it was, and the crossing is re-derived
      // next round with nothing held back yet.
      //
      // Matched on the compat group, not the bare name: two incompatible
      // versions of one crate can both move and both cross, and stamping
      // `via` by name alone tells the other group it was held back through
      // an ancestor whose pin it never needed.
      if (outcome.reached && outcome.via !== undefined) {
        for (const x of crossings) {
          if (x.source === sourceIdentityOf(m.pkg.source) && x.name === m.pkg.name && x.to === m.pkg.version) {
            x.via = outcome.via;
          }
        }
      }
      break; // one pin per round
    }
    }

    if (!acted && cooldownDays > 0) {
      // Cooldown next, only in rounds where no crossing work happened:
      // crossing pins reshape the diff, and dating a subtree that is about
      // to be unwound would defer candidates for no reason. A zero
      // cooldown skips the dates entirely — nothing to defer, so nothing
      // to ask.
      for (const c of diff.changed) {
        if (c.after.source !== CRATES_IO_SOURCE) continue;
        const date = await versionDate(c.name, c.to);
        if (date !== null && date.getTime() <= cutoff()) continue;
        const firstReason =
          date === null
            ? `${c.name} ${c.to}: no publish date, treated as too new`
            : `${c.name} ${c.to}: published ${date.toISOString().slice(0, 10)}, ` +
              `inside the ${cooldownDays}-day cooldown`;
        const index = await crateIndex(c.name);
        if (index.errors.length > 0) {
          block(`${firstReason}, and the index for ${c.name} could not be read`);
          continue;
        }
        const { candidate, reasons } = await findPinback(c.name, c.to, c.from, index, {
          cooldownDays,
          now,
          versionDate,
        });
        // A changed package always has a safe landing: the version it
        // started from, which the resolver already accepted once — though
        // a dependent bumped in the same batch can have raised its floor
        // since, which is what makes the pin itself fallible.
        const target = candidate ?? c.from;
        // Recorded only once the pin lands. A refusal has already blocked
        // the batch, and a deferral line for a package still sitting at the
        // version the cooldown rejected tells the reader the opposite of
        // what happened.
        const outcome = pin(c.after, target, firstReason);
        if (outcome) {
          if (outcome.reached) {
            cooldown.push({
              source: sourceIdentityOf(c.after.source),
              name: c.name,
              from: c.from,
              to: target === c.from ? null : target,
              reasons: [firstReason, ...reasons],
            });
          }
          break; // one pin per round
        }
      }
      // Skip once a pin landed this round: the graph is stale, and a pin
      // that removed a freshly-added transitive would otherwise be judged
      // (and blocked) on an entry that no longer exists.
      if (!acted) for (const a of diff.added) {
        if (a.source !== CRATES_IO_SOURCE) continue;
        const date = await versionDate(a.name, a.version);
        if (date !== null && date.getTime() <= cutoff()) continue;
        const firstReason =
          date === null
            ? `${a.name} ${a.version}: no publish date, treated as too new`
            : `${a.name} ${a.version}: published ${date.toISOString().slice(0, 10)}, ` +
              `inside the ${cooldownDays}-day cooldown`;
        const index = await crateIndex(a.name);
        if (index.errors.length > 0) {
          block(`${firstReason}, and the index for ${a.name} could not be read`);
          continue;
        }
        // A new arrival has no starting version to fall back to: if no
        // older release in its compat group is eligible and acceptable to
        // the resolver, the batch cannot keep the cooldown's promise and
        // the run fails loudly. It heals itself once the release ages out.
        const { candidate, reasons } = await findPinback(a.name, a.version, null, index, {
          cooldownDays,
          now,
          versionDate,
        });
        if (candidate === null) {
          block(
            `${firstReason}; ${a.name} is new in this batch and no older release in its ` +
              `compatibility range is outside the cooldown${reasons.length ? ` (${reasons.join("; ")})` : ""}`,
          );
          continue;
        }
        const outcome = pin(a, candidate, firstReason);
        if (outcome) {
          if (outcome.reached) {
            cooldown.push({
              source: sourceIdentityOf(a.source),
              name: a.name,
              from: null,
              to: candidate,
              reasons: [firstReason, ...reasons],
            });
          }
          break; // one pin per round
        }
      }
    }

    if (!acted) {
      blocking.push(...roundBlocking);
      break;
    }
    newText = readLockfile();
    newLock = parseLockfile(newText);
  }

  // Put back any self-inflicted, unwindable crossing recorded above: an
  // unchanged dependent's edge that this run's own fix-ups deduped onto
  // another in-range copy while the copy it left still stands. Rather than
  // reason about whether the move is benign, restore the edge to the surviving
  // copy of the compat group HEAD resolved and let cargo be the judge. A
  // legitimate re-dedup (the dependent's own requirement admits both versions)
  // reproduces HEAD's topology and `cargo metadata --locked` accepts it; a
  // move actually forced by something else — a feature change pulling in a new
  // major — cannot be put back, so cargo reports the lockfile out of date and
  // the batch blocks. No trust in the dependent's source or manifest is needed
  // here, which is why the clean-context validator needs no matching
  // exception: the shipped lockfile simply carries no crossing.
  if (edgeRestores.size > 0 && blocking.length === 0) {
    const refsTo = (pkg, name) =>
      (pkg.dependencies ?? []).filter((r) => (parseDepRef(r) ?? {}).name === name);
    // The reference string the shipped lockfile already uses for `pkg`. Cargo
    // renders a dependency reference at exactly the disambiguation the whole
    // lockfile needs — bare name, name+version, or name+version+source — and
    // every referrer of one package writes it identically, so reusing an
    // existing referrer's string restores an edge in cargo's own format
    // without re-deriving that rule and risking a form `--locked` rejects.
    // null when nothing references it, which a standing copy always is, so the
    // caller fails closed rather than invent one.
    const referenceTo = (pkg) => {
      for (const p of newLock.packages) {
        for (const ref of p.dependencies ?? []) {
          if (parseDepRef(ref)?.name !== pkg.name) continue;
          const resolved = resolveDepRef(newLock.packages, ref);
          if (resolved.length === 1 && idOf(resolved[0]) === idOf(pkg)) return ref;
        }
      }
      return null;
    };
    const edits = [];
    for (const { dep, name } of edgeRestores.values()) {
      const now = newLock.packages.find((p) => idOf(p) === idOf(dep));
      const head = oldLock.packages.find((p) => idOf(p) === idOf(dep));
      if (now === undefined || head === undefined) continue; // the dependent moved after all
      const nowRefs = refsTo(now, name);
      const headRefs = refsTo(head, name);
      // A single edge to `name` is the shape a dedup shuffle takes; more than
      // one (renamed dual edges to the same crate crossing at once) has no
      // unambiguous baseline to map to, so it fails closed rather than guess.
      if (nowRefs.length !== 1 || headRefs.length !== 1) {
        blocking.push(
          `cannot restore ${dep.name} ${dep.version}'s edge to ${name} to its baseline: ` +
            `${headRefs.length} baseline edge(s) and ${nowRefs.length} now — refusing to guess`,
        );
        continue;
      }
      // Restore to the copy that STILL STANDS in the compat group HEAD's edge
      // resolved to — not HEAD's reference verbatim. The group's package can
      // itself have moved within range (HEAD `foo 1.1`, the shipped tree keeps
      // `foo 1.2` through another dependent), so HEAD's string can name an
      // absent version; writing it would make `--locked` reject a safe batch.
      const headTarget = resolveDepRef(oldLock.packages, headRefs[0]);
      if (headTarget.length !== 1) {
        blocking.push(
          `cannot restore ${dep.name} ${dep.version}'s edge to ${name}: its baseline ` +
            `reference "${headRefs[0]}" does not resolve to a single package`,
        );
        continue;
      }
      const slot = compatSlotOf(headTarget[0]);
      const survivors = newLock.packages.filter((p) => p.name === name && compatSlotOf(p) === slot);
      if (survivors.length !== 1) {
        blocking.push(
          `cannot restore ${dep.name} ${dep.version}'s edge to ${name}: the baseline copy's ` +
            `compatibility group has ${survivors.length} copies in the shipped tree`,
        );
        continue;
      }
      const toRef = referenceTo(survivors[0]);
      if (toRef === null) {
        blocking.push(
          `cannot restore ${dep.name} ${dep.version}'s edge to ${name}: no reference to the ` +
            "surviving copy exists in the shipped tree",
        );
        continue;
      }
      if (nowRefs[0] === toRef) continue; // a later round already put it back
      edits.push({ line: now.line, fromRef: nowRefs[0], toRef });
    }
    if (blocking.length === 0 && edits.length > 0) {
      newText = restoreLockfileEdges(newText, edits);
      writeLockfile(newText);
      const check = runCargo(["metadata", "--format-version", "1", "--locked"]);
      if (!check.ok) {
        blocking.push(
          "restoring an unchanged dependent's edge to its baseline copy left a " +
            "lockfile cargo rejects, so the move was forced rather than a re-dedup — " +
            `a transitive major to migrate deliberately:\n${check.output}`,
        );
      } else {
        newLock = parseLockfile(newText);
        if (newLock.errors.length > 0) {
          throw new Error(`the restored lockfile does not parse:\n${newLock.errors.join("\n")}`);
        }
        diff = diffLockfiles(oldLock, newLock);
        if (diff.errors.length > 0) {
          throw new Error(`lockfile diff refused after restore:\n${diff.errors.join("\n")}`);
        }
      }
    }
  }

  // A non-crates.io package appearing or vanishing outright has no pin to
  // unwind it (only a manifest change could move a git dependency's URL,
  // and this batch touches no manifest) — not something this job's cargo
  // run should ever produce, so it blocks rather than publishes.
  for (const p of diff.added) {
    if (p.source !== CRATES_IO_SOURCE) {
      blocking.push(`${p.name} ${p.version} appeared from ${p.source} — not a crates.io package, and this job did not ask for it`);
    }
  }
  for (const p of diff.removed) {
    if (p.source !== CRATES_IO_SOURCE) {
      blocking.push(`${p.name} ${p.version} (${p.source ?? "workspace"}) vanished — not a crates.io package, and this job did not remove it`);
    }
  }

  // -------------------------------------------------------------------------
  // Reporting: what a manifest or a major is still holding, what this tool
  // does not manage. Direct dependencies only — they are the versions a
  // human declared and the migrations a human would plan.
  // -------------------------------------------------------------------------

  const held = [];
  const requirementHeld = [];
  const unmanaged = [];
  const direct = directDepNames(newLock);
  const afterGroups = groupByCompat(newLock.packages, [], "");
  for (const name of [...direct].sort()) {
    const groups = afterGroups.get(name);
    if (groups === undefined) continue; // renamed dependency: ref name ≠ package name
    for (const pkg of groups.values()) {
      if (pkg.source !== CRATES_IO_SOURCE) continue; // reported below
      if (!isStable(pkg.version)) continue; // reported below
      const index = await crateIndex(name);
      if (index.errors.length > 0) continue; // already in errors
      const stable = index.versions
        .filter((v) => !v.yanked && isStable(v.vers))
        .sort((a, b) => compareSemver(b.vers, a.vers));
      const newest = stable[0];
      if (newest !== undefined && compatKeyOf(newest.vers) !== compatKeyOf(pkg.version)) {
        held.push({ name, current: pkg.version, newest: newest.vers });
      }
      const newestCompat = stable.find((v) => compatKeyOf(v.vers) === compatKeyOf(pkg.version));
      if (newestCompat !== undefined && compareSemver(newestCompat.vers, pkg.version) > 0) {
        // Newer, compatible, and not taken. Three causes, and the report
        // must not attribute one of them to another: this run pinned the
        // package back itself, the cooldown deferred it, or the manifest's
        // requirement excludes it.
        //
        // The first is the one the engine KNOWS, so it is checked rather
        // than inferred by elimination -- and it is the one the elimination
        // never covered. A crossing mover pinned back, or an ancestor rolled
        // back to reach one, sits below its newest compatible release for
        // this run's own reasons, and the date cannot tell that apart from a
        // manifest bound: the report said "`a` stays at 1.2.0" under the
        // crossings and "the manifest's requirement keeps 1.2.0" two
        // sections later, in the same report, about the same package. The
        // old `cooldown.some(...)` guard was this same test, keyed on a
        // name and narrowed to one of the three causes.
        //
        // Silence is right here: wherever the pin came from -- `crossings`,
        // `cooldown`, `unmanaged`, a blocking message -- already says why.
        // The date then separates the other two, and with the cooldown
        // disabled no date can excuse the miss, so it is the requirement's
        // doing by elimination.
        if (pinnedHere.has(slotOf(pkg, pkg.version))) {
          // This run chose this version; nothing to attribute.
        } else if (cooldownDays <= 0) {
          requirementHeld.push({ name, current: pkg.version, newest: newestCompat.vers });
        } else {
          const date = await versionDate(name, newestCompat.vers);
          if (date === null || date.getTime() > cutoff()) {
            cooldown.push({
              source: sourceIdentityOf(pkg.source),
              name,
              from: pkg.version,
              to: null,
              reasons: [
                date === null
                  ? `${name} ${newestCompat.vers}: no publish date, treated as too new`
                  : `${name} ${newestCompat.vers}: published ${date.toISOString().slice(0, 10)}, ` +
                    `inside the ${cooldownDays}-day cooldown`,
              ],
            });
          } else {
            requirementHeld.push({ name, current: pkg.version, newest: newestCompat.vers });
          }
        }
      }
    }
  }
  for (const pkg of newLock.packages) {
    if (pkg.source === null) continue; // the workspace's own packages
    if (pkg.source !== CRATES_IO_SOURCE) {
      // By identity, not name: a git copy and a registry copy of one crate can
      // both reach this loop, and a name lookup hands the first one's record
      // to the second.
      const wasRestored = restored.find((r) => isAt(pkg, r.source, r.name, r.to));
      unmanaged.push(
        wasRestored
          ? `${pkg.name} ${pkg.version}: source ${pkg.source} is not crates.io; ` +
              `cargo update had moved it and it was restored to ${wasRestored.to}`
          : `${pkg.name} ${pkg.version}: source ${pkg.source} is not crates.io`,
      );
    } else if (!isStable(pkg.version)) {
      const promoted = restored.find((r) => isAt(pkg, r.source, r.name, r.to));
      unmanaged.push(
        promoted
          ? `${pkg.name} ${pkg.version}: a pre-release pin; cargo update had promoted it ` +
              `and it was restored to ${promoted.to}`
          : `${pkg.name} ${pkg.version}: a pre-release pin, left alone`,
      );
    }
  }

  // Does the settled lockfile still bear out what a record CLAIMS? Every
  // durable decision record -- one written in an earlier round and carried to
  // the report -- asserts that some package ended at some version, and a later
  // round can move the graph under it. An ancestor pin can remove the package
  // outright; it can also leave a mover at `to` while incidentally undoing the
  // crossing that justified holding it back, when reverting the parent moves
  // the dragged dependency home. The detection was true when it was made and
  // is not true of the lockfile that ships, and a report contradicting itself
  // -- "`m` stays at 2.0.0" printed beside "Updated: `m` 2.0.0 → 2.1.0", or
  // beside "Removed: `m`" -- is worse than one line short.
  //
  // Three findings in this one mechanism, so this is the predicate rather than
  // a fourth per-record filter. Each earlier patch tested a proxy for the
  // claim: first that the mover had not vanished, then that it sat at EITHER
  // end -- which is precisely the case where it moved and the line is false.
  // The claim itself is what gets checked, against the graph that shipped.
  //
  // Dropping a crossing loses nothing a reader sees. The one case where the
  // mover legitimately ends at `to` is a crossing nothing could unwind, and
  // that run BLOCKS: the crossing's own text is the blocking message, the CLI
  // restores the lockfile and prints those rather than this report, and a
  // batch that shipped is never the one whose mover stayed put.
  const standsInFinalGraph = (source, name, version) =>
    newLock.packages.some((o) => isAt(o, source, name, version));

  return {
    text: newText,
    oldText,
    changes: diff.changed.map((c) => ({ name: c.name, from: c.from, to: c.to, direct: direct.has(c.name) })),
    added: diff.added.map((p) => ({ name: p.name, version: p.version, direct: direct.has(p.name) })),
    removed: diff.removed.map((p) => ({ name: p.name, version: p.version })),
    held,
    cooldown: cooldown.filter((c) => standsInFinalGraph(c.source, c.name, c.to ?? c.from)),
    requirementHeld,
    unmanaged,
    errors,
    // The fix-up loop re-derives its view each round (one pin per round),
    // so a crossing or violation persisting into a later round would
    // otherwise be reported once per round.
    // Keyed on the crossing itself, not the whole record: a crossing re-derived
    // after an ancestor pin is the SAME one, and `via` gets attached to only
    // one of the two copies — stringifying the record whole would render both.
    // The copy that carries `via` is the one to keep; it says more.
    crossings: [
      ...crossings
        // A crossing is a detection, recorded when it is detected; what it
        // claims is that the mover STAYS AT `from`, so that is what is checked
        // against the shipped lockfile -- see `standsInFinalGraph`.
        .filter((x) => standsInFinalGraph(x.source, x.name, x.from))
        // `via` is a durable record nested inside one, and it makes a claim of
        // its own: the ancestor named is KEPT AT `via.to`. The graph can move
        // under that after it is written, so it is checked separately -- the
        // mover staying at `from` says nothing about where its ancestor ended
        // up. Only the attribution is dropped when it no longer holds, never
        // the crossing: "`m` stays at 2.0.0" is still true, and it is only the
        // "held back through `p`, kept at 1.0.0" half that would contradict
        // an Updated or Removed line about `p`.
        .map((x) => {
          if (x.via === undefined || standsInFinalGraph(x.via.source, x.via.name, x.via.to)) return x;
          const { via, ...withoutVia } = x;
          return withoutVia;
        })
        .reduce((byCrossing, x) => {
          const key = JSON.stringify({
            source: x.source,
            name: x.name,
            from: x.from,
            to: x.to,
            dragged: x.dragged,
          });
          const kept = byCrossing.get(key);
          if (kept === undefined || (kept.via === undefined && x.via !== undefined)) {
            byCrossing.set(key, x);
          }
          return byCrossing;
        }, new Map())
        .values(),
    ],
    blocking: [...new Set(blocking)],
  };
};

// ---------------------------------------------------------------------------
// The report the PR body carries.
// ---------------------------------------------------------------------------

export const reportMarkdown = (report) => {
  const lines = [];
  const tag = (d) => (d ? " (direct)" : "");
  if (report.changes.length > 0) {
    lines.push("## Updated", "");
    for (const c of report.changes) lines.push(`- \`${c.name}\`${tag(c.direct)}: ${c.from} → ${c.to}`);
    lines.push("");
  }
  if (report.added.length > 0) {
    lines.push("## Added", "");
    for (const a of report.added) lines.push(`- \`${a.name}\`${tag(a.direct)}: ${a.version}`);
    lines.push("");
  }
  if (report.removed.length > 0) {
    lines.push("## Removed", "");
    for (const r of report.removed) lines.push(`- \`${r.name}\`: was ${r.version}`);
    lines.push("");
  }
  if (report.held.length > 0) {
    lines.push("## Held back — new major available", "");
    for (const h of report.held) {
      lines.push(`- \`${h.name}\`: ${h.current} stays; ${h.newest} needs a deliberate migration`);
    }
    lines.push("");
  }
  if (report.crossings.length > 0) {
    lines.push("## Held back — would drag a transitive major", "");
    for (const x of report.crossings) {
      lines.push(
        `- \`${x.name}\` stays at ${x.from}: ${x.to} moves \`${x.dragged.name}\` ` +
          `from ${x.dragged.from} to ${x.dragged.to}` +
          (x.via === undefined
            ? ""
            : ` — held back through \`${x.via.name}\`, kept at ${x.via.to}, ` +
              "whose own requirement blocked pinning it directly"),
      );
    }
    lines.push("");
  }
  if (report.cooldown.length > 0) {
    lines.push("## Deferred by the release-age cooldown", "");
    for (const c of report.cooldown) {
      lines.push(
        c.to === null
          ? `- \`${c.name}\` stays at ${c.from}:`
          : c.from === null
            ? `- \`${c.name}\` (new in this batch) took ${c.to}, newer releases are cooling down:`
            : `- \`${c.name}\` took ${c.to}, newer releases are cooling down:`,
      );
      for (const r of c.reasons) lines.push(`  - ${r}`);
    }
    lines.push("");
  }
  if (report.requirementHeld.length > 0) {
    lines.push("## Held by the manifest requirement", "");
    for (const h of report.requirementHeld) {
      lines.push(
        `- \`${h.name}\`: ${h.newest} is compatible but the manifest's requirement ` +
          `keeps ${h.current}; loosen the requirement to take it`,
      );
    }
    lines.push("");
  }
  if (report.unmanaged.length > 0) {
    lines.push("## Not managed by this tool", "");
    for (const u of report.unmanaged) lines.push(`- ${u}`);
    lines.push("");
  }
  if (report.errors.length > 0) {
    lines.push("## Registry errors", "");
    for (const e of report.errors) lines.push(`- ${e}`);
    lines.push("");
  }
  if (lines.length === 0) lines.push("No dependency updates available this run.", "");
  return lines.join("\n");
};

// ---------------------------------------------------------------------------
// CLI.
// ---------------------------------------------------------------------------

const parseArgs = (argv) => {
  const args = { lockfile: "Cargo.lock", cooldownDays: 5, markdown: null };
  for (let i = 0; i < argv.length; i++) {
    const [flag, inline] = argv[i].split(/=(.*)/s, 2);
    const value = () => inline ?? argv[++i];
    if (flag === "--lockfile") args.lockfile = value();
    else if (flag === "--cooldown-days") args.cooldownDays = Number(value());
    else if (flag === "--markdown") args.markdown = value();
    else throw new Error(`unknown argument: ${argv[i]}`);
  }
  if (!Number.isFinite(args.cooldownDays) || args.cooldownDays < 0) {
    throw new Error("--cooldown-days must be a non-negative number");
  }
  // Cargo has no stable way to read or write a lockfile under any other
  // name — a differently-named input would leave cargo updating a
  // Cargo.lock beside it while this script watches the wrong file and
  // reports an eternally clean run.
  if (basename(args.lockfile) !== "Cargo.lock") {
    throw new Error(`--lockfile must name a Cargo.lock (got ${args.lockfile})`);
  }
  return args;
};

// Redirect chains this fetcher will follow before giving up — a loop
// backstop, not a policy.
const MAX_REDIRECTS = 10;

// The one fetcher anything in this repository uses against a registry.
// Registries are free to redirect (CDNs) but never off HTTPS — and every
// HOP is checked, not just the final URL: `redirect: "follow"` resolves the
// chain internally, so an https -> http -> https(attacker) chain reaches
// the caller as an ordinary https response. The intermediate http leg is
// exactly where an on-path attacker sits to forge the metadata or the
// publish date the cooldown stands on.
export const httpsFetcher = async (url, init) => {
  let current = url;
  for (let hop = 0; ; hop++) {
    if (new URL(current).protocol !== "https:") {
      throw new Error(`redirected off https: ${url} -> ${current}`);
    }
    const res = await fetch(current, {
      ...init,
      headers: { "User-Agent": USER_AGENT, ...(init?.headers ?? {}) },
      redirect: "manual",
      signal: AbortSignal.timeout(30_000),
    });
    if (res.status < 300 || res.status >= 400 || !res.headers.get("location")) return res;
    if (hop >= MAX_REDIRECTS) {
      throw new Error(`too many redirects: ${url} -> ${current} (stopped at ${hop})`);
    }
    current = new URL(res.headers.get("location"), current).href;
  }
};

const main = async () => {
  const args = parseArgs(process.argv.slice(2));
  const dir = dirname(args.lockfile) || ".";
  const readLockfile = () => readFileSync(args.lockfile, "utf8");
  const writeLockfile = (text) => writeFileSync(args.lockfile, text);
  const runCargo = (cargoArgs) => {
    try {
      // Both streams captured: cargo reports to stderr, and a failure's
      // explanation must reach the report rather than the void.
      const output = execFileSync("cargo", cargoArgs, {
        cwd: dir,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      });
      return { ok: true, output };
    } catch (e) {
      return { ok: false, output: `${e.stdout ?? ""}${e.stderr ?? ""}` || String(e) };
    }
  };

  const before = readLockfile();
  let report;
  try {
    report = await updateLockfile({
      readLockfile,
      writeLockfile,
      runCargo,
      fetcher: httpsFetcher,
      cooldownDays: args.cooldownDays,
    });
  } catch (e) {
    // A half-applied batch must not survive the failure that stopped it.
    writeFileSync(args.lockfile, before);
    throw e;
  }

  if (report.blocking.length > 0) {
    // A violation nothing could pin away: restore and fail loudly rather
    // than publish a batch that breaks the cooldown or crosses a major.
    writeFileSync(args.lockfile, before);
    for (const b of report.blocking) process.stderr.write(`::error::${b}\n`);
    process.exit(1);
  }

  const markdown = reportMarkdown(report);
  if (args.markdown !== null) writeFileSync(args.markdown, markdown);
  process.stdout.write(markdown + "\n");

  // A registry error is a held report line, not a broken run — unless
  // nothing could be decided at all, which would otherwise read as
  // "everything is up to date" forever, in silence.
  if (report.errors.length > 0 && report.changes.length === 0 && report.added.length === 0) {
    process.stderr.write(
      "Registry errors and no updates resolved — failing loudly rather than reporting a clean run.\n",
    );
    process.exit(1);
  }
};

// argv[1] is undefined under `node -e`/`--test` importing this as a module.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
