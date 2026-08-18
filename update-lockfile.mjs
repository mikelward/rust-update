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
//     deliberate migration, not a weekly batch.
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
  // operator at all.
  if (wild(maj)) {
    if (op || min !== undefined || pat !== undefined || pre !== undefined) return null;
    maj = min = pat = pre = undefined;
  } else if (min !== undefined && wild(min)) {
    if ((pat !== undefined && !wild(pat)) || pre !== undefined) return null;
    min = pat = undefined;
  } else if (pat !== undefined && wild(pat)) {
    if (pre !== undefined) return null;
    pat = undefined;
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

// Runs `cargo update`, then enforces the cooldown and the no-transitive-
// majors rule by pinning offenders back, then derives the report. Effects
// are injected: `readLockfile` returns the current lockfile text,
// `runCargo(args)` runs cargo and returns { ok, output }, `fetcher` speaks
// HTTPS, `now` is the clock. Throws on an unparseable lockfile or a failed
// plain `cargo update`; policy violations that survive the fix-up loop land
// in the returned `blocking` list, and the CLI restores the lockfile and
// fails the run on them.
export const updateLockfile = async ({
  readLockfile,
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
  const cooldown = [];
  const crossings = [];
  const restored = [];
  const blocking = [];
  // Pins already applied, so a round never re-fights a decision — and so a
  // package pinned back for a crossing is not then "fixed" again.
  const pinned = new Set();

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
    // Blocking judged this round, held apart from the durable list: a pin
    // reshapes the graph, so a violation judged before the round's pin can
    // name a package the pin removes. If the round ends with a pin, these
    // are discarded and re-derived against the fresh parse; only a round
    // that settles with no pin gets to make its blocks final.
    const roundBlocking = [];
    const block = (why) => roundBlocking.push(why);
    const pin = (spec, to, why) => {
      const key = `${spec}@${to}`;
      if (pinned.has(key)) {
        // Asking for a pin that already happened means this round's
        // violation survived the previous round's fix: report, stop.
        block(why);
        return;
      }
      const result = runCargo(["update", spec, "--precise", to]);
      pinned.add(key);
      if (result.ok) {
        acted = true;
        return true;
      }
      block(`${why} — and pinning ${spec} back to ${to} failed:\n${result.output}`);
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
      if (pin(specFor(pair.after), target, why)) {
        restored.push({ name: pair.after.name, to: target });
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
      if (pin(specFor(a), target, why)) {
        restored.push({ name: a.name, to: target });
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
        const key =
          target.source === null
            ? `=${target.version}`
            : `${compatKeyOf(target.version)}\n${sourceIdentityOf(target.source)}`;
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
    // One pin per mover, however many of its edges crossed — asking twice
    // would trip pin()'s repeat guard on a batch that only needs one pin.
    const moverPins = new Map();
    for (const pair of pairs) {
      const before = edgeGroups(pair.before, oldLock.packages);
      const after = edgeGroups(pair.after, newLock.packages);
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
          block(
            `${crossing}, on a package that did not itself change — not something cargo update produces`,
          );
          continue;
        }
        crossings.push({
          name: pair.change.name,
          from: pair.change.from,
          to: pair.change.to,
          dragged: { name, from: was, to: now },
        });
        moverPins.set(`${pair.change.name}@${pair.change.to}`, {
          pkg: pair.change.after,
          to: pair.change.from,
          why: crossing,
        });
      }
    }
    for (const m of moverPins.values()) {
      if (pin(specFor(m.pkg), m.to, m.why)) break; // one pin per round
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
        cooldown.push({ name: c.name, from: c.from, to: target === c.from ? null : target, reasons: [firstReason, ...reasons] });
        if (pin(specFor(c.after), target, firstReason)) break; // one pin per round
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
        cooldown.push({ name: a.name, from: null, to: candidate, reasons: [firstReason, ...reasons] });
        if (pin(specFor(a), candidate, firstReason)) break; // one pin per round
      }
    }

    if (!acted) {
      blocking.push(...roundBlocking);
      break;
    }
    newText = readLockfile();
    newLock = parseLockfile(newText);
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
        // Newer, compatible, and not taken. Either the cooldown deferred
        // it (already reported) or the manifest's requirement excludes it
        // (an exact or bounded pin) — the date says which. With the
        // cooldown disabled no date can excuse the miss, so it is the
        // requirement's doing by elimination.
        const deferred = cooldown.some((c) => c.name === name);
        if (!deferred && cooldownDays <= 0) {
          requirementHeld.push({ name, current: pkg.version, newest: newestCompat.vers });
        } else if (!deferred) {
          const date = await versionDate(name, newestCompat.vers);
          if (date === null || date.getTime() > cutoff()) {
            cooldown.push({
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
      const wasRestored = restored.find((r) => r.name === pkg.name);
      unmanaged.push(
        wasRestored
          ? `${pkg.name} ${pkg.version}: source ${pkg.source} is not crates.io; ` +
              `cargo update had moved it and it was restored to ${wasRestored.to}`
          : `${pkg.name} ${pkg.version}: source ${pkg.source} is not crates.io`,
      );
    } else if (!isStable(pkg.version)) {
      const promoted = restored.find((r) => r.name === pkg.name);
      unmanaged.push(
        promoted
          ? `${pkg.name} ${pkg.version}: a pre-release pin; cargo update had promoted it ` +
              `and it was restored to ${promoted.to}`
          : `${pkg.name} ${pkg.version}: a pre-release pin, left alone`,
      );
    }
  }

  return {
    text: newText,
    oldText,
    changes: diff.changed.map((c) => ({ name: c.name, from: c.from, to: c.to, direct: direct.has(c.name) })),
    added: diff.added.map((p) => ({ name: p.name, version: p.version, direct: direct.has(p.name) })),
    removed: diff.removed.map((p) => ({ name: p.name, version: p.version })),
    held,
    cooldown,
    requirementHeld,
    unmanaged,
    errors,
    // The fix-up loop re-derives its view each round (one pin per round),
    // so a crossing or violation persisting into a later round would
    // otherwise be reported once per round.
    crossings: [...new Map(crossings.map((x) => [JSON.stringify(x), x])).values()],
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
          `from ${x.dragged.from} to ${x.dragged.to}`,
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
