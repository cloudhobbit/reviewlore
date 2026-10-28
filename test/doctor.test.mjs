import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync, statSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runDoctor, renderDoctor, versionAtLeast } from "../lib/doctor.mjs";
import { saveScratch, discardScratch } from "../lib/scratch.mjs";

// Probes are stubbed so results don't depend on this machine's Node,
// node_modules or git; the repo checks use a real temp git repo.
const ALL_DEPS = () => true;
const GIT = () => "git version 2.40.0";

function withRepo(remote, fn) {
  const dir = mkdtempSync(join(tmpdir(), "doctor-"));
  try {
    spawnSync("git", ["init", "-q", dir]);
    if (remote) spawnSync("git", ["-C", dir, "remote", "add", "origin", remote]);
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const byId = (report) => Object.fromEntries(report.checks.map((c) => [c.id, c]));

test("versionAtLeast compares against a >= range", () => {
  assert.equal(versionAtLeast("20.11.0", ">=20.11"), true);
  assert.equal(versionAtLeast("22.1.0", ">=20.11"), true);
  assert.equal(versionAtLeast("20.10.9", ">=20.11"), false);
  assert.equal(versionAtLeast("v18.19.0", ">=20.11"), false);
});

test("doctor passes on a github.com clone with everything installed", () => {
  withRepo("git@github.com:acme/widgets.git", (dir) => {
    const report = runDoctor({ cwd: dir, nodeVersion: "22.0.0", engines: ">=20.11", resolve: ALL_DEPS, git: GIT });
    assert.equal(report.ok, true, renderDoctor(report));
    assert.match(byId(report).repo.message, /acme\/widgets/);
    assert.match(renderDoctor(report), /Ready\./);
  });
});

test("doctor fails on old Node with the install message", () => {
  withRepo("https://github.com/acme/widgets", (dir) => {
    const report = runDoctor({ cwd: dir, nodeVersion: "18.20.0", engines: ">=20.11", resolve: ALL_DEPS, git: GIT });
    assert.equal(report.ok, false);
    const node = byId(report).node;
    assert.equal(node.ok, false);
    assert.match(node.fix, /Node\.js 20\.11 or newer/);
    assert.match(node.fix, /nodejs\.org/);
  });
});

test("doctor fails outside a git repo, and for a non-github.com origin", () => {
  const plain = mkdtempSync(join(tmpdir(), "doctor-plain-"));
  try {
    const r = runDoctor({ cwd: plain, nodeVersion: "22.0.0", resolve: ALL_DEPS, git: GIT });
    assert.equal(r.ok, false);
    assert.match(byId(r).repo.message, /not inside a git repository/);
  } finally {
    rmSync(plain, { recursive: true, force: true });
  }
  withRepo("git@bitbucket.org:team/app.git", (dir) => {
    const r = runDoctor({ cwd: dir, nodeVersion: "22.0.0", resolve: ALL_DEPS, git: GIT });
    assert.equal(r.ok, false);
    assert.match(byId(r).repo.message, /bitbucket\.org isn't supported/);
  });
  // GitLab is supported, nested groups included, and needs no Octokit.
  withRepo("git@gitlab.com:group/sub/proj.git", (dir) => {
    const r = runDoctor({ cwd: dir, nodeVersion: "22.0.0", resolve: (s) => s !== "@octokit/rest", git: GIT });
    assert.equal(r.ok, true, renderDoctor(r));
    assert.match(byId(r).repo.message, /group\/sub\/proj on gitlab\.com/);
  });
  withRepo(null, (dir) => {
    const r = runDoctor({ cwd: dir, nodeVersion: "22.0.0", resolve: ALL_DEPS, git: GIT });
    assert.match(byId(r).repo.message, /no usable `origin` remote/);
  });
});

test("doctor without git skips the repo checks and fails", () => {
  const r = runDoctor({ cwd: tmpdir(), nodeVersion: "22.0.0", resolve: ALL_DEPS, git: () => null });
  assert.equal(r.ok, false);
  assert.equal(byId(r).git.ok, false);
  assert.equal(byId(r).repo, undefined);
});

test("missing Octokit is required only when there is no committed corpus", () => {
  const noOctokit = (s) => s !== "@octokit/rest";
  withRepo("https://github.com/acme/widgets.git", (dir) => {
    const without = runDoctor({ cwd: dir, nodeVersion: "22.0.0", resolve: noOctokit, git: GIT });
    assert.equal(without.ok, false);
    assert.match(byId(without)["deps.octokit"].fix, /reinstall it/);

    writeFileSync(join(dir, ".reviewlore-corpus.json"), JSON.stringify({ meta: { owner: "acme", repo: "widgets", totals: { total: 12 } } }));
    const withCorpus = runDoctor({ cwd: dir, nodeVersion: "22.0.0", resolve: noOctokit, git: GIT });
    assert.equal(withCorpus.ok, true, renderDoctor(withCorpus));
    assert.match(byId(withCorpus).corpus.message, /12 comments/);

    writeFileSync(join(dir, ".reviewlore-corpus.json"), JSON.stringify({ meta: { owner: "other", repo: "thing" } }));
    const foreign = runDoctor({ cwd: dir, nodeVersion: "22.0.0", resolve: noOctokit, git: GIT });
    assert.equal(foreign.ok, false);
    assert.match(byId(foreign).corpus.message, /holds other\/thing/);
  });
});

test("a missing MCP SDK is a warning, not a failure", () => {
  withRepo("https://github.com/acme/widgets.git", (dir) => {
    const r = runDoctor({ cwd: dir, nodeVersion: "22.0.0", resolve: (s) => !s.startsWith("@modelcontextprotocol"), git: GIT });
    assert.equal(r.ok, true);
    assert.equal(byId(r)["deps.mcp"].ok, false);
    assert.match(renderDoctor(r), /warn\s+deps\.mcp/);
  });
});

test("saveScratch writes a private file that discardScratch removes", () => {
  const base = mkdtempSync(join(tmpdir(), "scratch-base-"));
  try {
    const file = saveScratch("{}\n", { base });
    assert.equal(readFileSync(file, "utf-8"), "{}\n");
    if (process.platform !== "win32") assert.equal(statSync(file).mode & 0o777, 0o600);
    assert.equal(discardScratch(file, { base }), true);
    assert.equal(existsSync(file), false);
    // Already gone: not an error.
    assert.equal(discardScratch(file, { base }), false);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("discardScratch refuses paths it didn't create", () => {
  const base = mkdtempSync(join(tmpdir(), "scratch-base-"));
  try {
    const other = join(base, "notes.json");
    writeFileSync(other, "keep");
    assert.throws(() => discardScratch(other, { base }), /refusing to delete/);
    assert.throws(() => discardScratch(join(base, "reviewlore-x", "other.json"), { base }), /refusing/);
    assert.throws(() => discardScratch("/etc/reviewlore-x/candidates.json", { base }), /refusing/);
    assert.equal(readFileSync(other, "utf-8"), "keep");
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
