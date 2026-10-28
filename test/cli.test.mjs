import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";

const REPO_ROOT = resolve(import.meta.dirname, "..");
const TOOLKIT_BIN = join(REPO_ROOT, "cli", "reviewlore.mjs");

function run(bin, args, { input } = {}) {
  return spawnSync("node", [bin, ...args], {
    input,
    encoding: "utf-8",
    env: { ...process.env, GITHUB_TOKEN: "" },
  });
}

test("reviewlore fetch --version prints semver", () => {
  const r = run(TOOLKIT_BIN, ["fetch", "--version"]);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /^\d+\.\d+\.\d+/);
});

test("reviewlore fetch --help prints usage", () => {
  const r = run(TOOLKIT_BIN, ["fetch", "--help"]);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /Usage:/);
  assert.match(r.stdout, /--owner/);
});

test("reviewlore fetch without args outside a repo exits non-zero", () => {
  // Outside any git repo (nothing to auto-detect) and with only node on
  // PATH, so no `gh` token can be found either.
  const tmp = mkdtempSync(join(tmpdir(), "fetch-noargs-"));
  try {
    const r = spawnSync(process.execPath, [TOOLKIT_BIN, "fetch"], {
      cwd: tmp, encoding: "utf-8", env: { PATH: dirname(process.execPath), GITHUB_TOKEN: "" },
    });
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /--owner/);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("reviewlore generate --version prints semver", () => {
  const r = run(TOOLKIT_BIN, ["generate", "--version"]);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /^\d+\.\d+\.\d+/);
});

test("reviewlore generate --help prints usage", () => {
  const r = run(TOOLKIT_BIN, ["generate", "--help"]);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /Usage:/);
});

test("reviewlore generate rejects non-numeric --min-occurrences (regression: #8)", () => {
  const tmp = mkdtempSync(join(tmpdir(), "pr-cli-"));
  try {
    const inputPath = join(tmp, "input.json");
    writeFileSync(inputPath, JSON.stringify({ meta: {}, issue_comments: [], review_comments: [], review_submissions: [] }));
    const r = run(TOOLKIT_BIN, ["generate", inputPath, "--target", tmp, "--min-occurrences", "abc"]);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /min-occurrences/);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("reviewlore generate rejects out-of-range --threshold (regression: #8)", () => {
  const tmp = mkdtempSync(join(tmpdir(), "pr-cli-"));
  try {
    const inputPath = join(tmp, "input.json");
    writeFileSync(inputPath, JSON.stringify({ meta: {}, issue_comments: [], review_comments: [], review_submissions: [] }));
    const r = run(TOOLKIT_BIN, ["generate", inputPath, "--target", tmp, "--threshold", "5"]);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /threshold/);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("reviewlore generate rejects non-existent --target (Tier 2 #7)", () => {
  const tmp = mkdtempSync(join(tmpdir(), "pr-cli-"));
  try {
    const inputPath = join(tmp, "input.json");
    writeFileSync(inputPath, JSON.stringify({ meta: {}, issue_comments: [], review_comments: [], review_submissions: [] }));
    const r = run(TOOLKIT_BIN, ["generate", inputPath, "--target", join(tmp, "nonexistent-dir")]);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /does not exist/);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("reviewlore generate warns when --target is not a git repo (Tier 2 #7)", () => {
  const tmp = mkdtempSync(join(tmpdir(), "pr-cli-"));
  try {
    const inputPath = join(tmp, "input.json");
    writeFileSync(inputPath, JSON.stringify({ meta: {}, issue_comments: [], review_comments: [], review_submissions: [] }));
    const r = run(TOOLKIT_BIN, ["generate", inputPath, "--target", tmp]);
    assert.equal(r.status, 0);
    assert.match(r.stderr, /not a git repository/);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("reviewlore --version prints semver", () => {
  const r = run(TOOLKIT_BIN, ["--version"]);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /^\d+\.\d+\.\d+/);
});

test("reviewlore --help lists every command", () => {
  const r = run(TOOLKIT_BIN, ["--help"]);
  assert.equal(r.status, 0);
  for (const cmd of ["run", "candidates", "fetch", "generate", "mcp", "doctor", "export", "init", "publish-corpus"]) {
    assert.match(r.stdout, new RegExp(`^  ${cmd}\\b`, "m"), cmd);
  }
});

test("reviewlore run auto-detects owner/repo from git remote (no flags needed)", () => {
  const tmp = mkdtempSync(join(tmpdir(), "auto-detect-"));
  try {
    // Init a git repo with a fake remote pointing at a private-looking repo.
    spawnSync("git", ["init", "-q", tmp]);
    spawnSync("git", ["-C", tmp, "remote", "add", "origin", "git@github.com:detected-org/detected-repo.git"]);

    // A committed corpus + --no-cache keeps the run offline: it never
    // resolves a token (env vars or `gh` login) or calls GitHub, whatever
    // credentials the machine running the tests has.
    const fixture = JSON.parse(readFileSync(join(REPO_ROOT, "lib", "fixtures", "demo-typescript.json"), "utf-8"));
    fixture.meta.owner = "detected-org";
    fixture.meta.repo = "detected-repo";
    writeFileSync(join(tmp, ".reviewlore-corpus.json"), JSON.stringify(fixture));

    // Spawn the bin with cwd inside the fake repo, no --owner / --repo args.
    const r = spawnSync("node", [TOOLKIT_BIN, "run", "--dry-run", "--no-cache"], {
      cwd: tmp,
      encoding: "utf-8",
      env: { ...process.env, REVIEWLORE_CACHE_DIR: tmp },
    });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stderr, /Detected detected-org\/detected-repo from git origin/);
    assert.match(r.stderr, /Using in-repo corpus/);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("reviewlore publish-corpus + run: no-token round-trip", () => {
  const cacheDir = mkdtempSync(join(tmpdir(), "cli-cache-"));
  const target = mkdtempSync(join(tmpdir(), "cli-tgt-"));
  try {
    // 1. Seed a fake cache by copying the demo fixture.
    const fixture = JSON.parse(readFileSync(
      join(REPO_ROOT, "lib", "fixtures", "demo-typescript.json"), "utf-8",
    ));
    fixture.meta.owner = "myorg";
    fixture.meta.repo = "myrepo";
    writeFileSync(join(cacheDir, "myorg__myrepo.json"), JSON.stringify(fixture));

    // 2. publish-corpus copies cache → target/.reviewlore-corpus.json
    const pub = spawnSync("node", [
      TOOLKIT_BIN, "publish-corpus",
      "--target", target, "--owner", "myorg", "--repo", "myrepo",
    ], { encoding: "utf-8", env: { ...process.env, REVIEWLORE_CACHE_DIR: cacheDir } });
    assert.equal(pub.status, 0, pub.stderr);
    assert.ok(existsSync(join(target, ".reviewlore-corpus.json")));
    assert.match(pub.stderr, /Published corpus/);

    // 3. run with no REVIEWLORE_CACHE_DIR → must use the in-repo corpus.
    //    If the corpus is correctly auto-detected, the auth code path is
    //    never reached (corpus check comes first), so no need to wipe PATH.
    const r = spawnSync("node", [
      TOOLKIT_BIN, "run",
      "--target", target, "--owner", "myorg", "--repo", "myrepo",
      "--preset", "exploratory",
    ], { encoding: "utf-8" });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stderr, /Using in-repo corpus/);
    assert.match(r.stderr, /Wrote \d+ file/);
  } finally {
    rmSync(cacheDir, { recursive: true, force: true });
    rmSync(target, { recursive: true, force: true });
  }
});

test("reviewlore init writes config via piped answers", () => {
  const tmp = mkdtempSync(join(tmpdir(), "init-"));
  try {
    // Provide answers in order: owner, repo, target, format, preset, llm, months
    const answers = ["my-org", "my-repo", tmp, "claude", "team-of-3", "n", "6"].join("\n") + "\n";
    const r = run(TOOLKIT_BIN, ["init"], { input: answers });
    assert.equal(r.status, 0, r.stderr);
    const cfgPath = join(tmp, ".reviewlore.json");
    assert.ok(existsSync(cfgPath), "config file should be written");
    const cfg = JSON.parse(readFileSync(cfgPath, "utf-8"));
    assert.equal(cfg.owner, "my-org");
    assert.equal(cfg.repo, "my-repo");
    assert.equal(cfg.preset, "team-of-3");
    assert.equal(cfg.llm, false);
    assert.equal(cfg.months, 6);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("reviewlore rejects unknown subcommand", () => {
  const r = run(TOOLKIT_BIN, ["bogus", "--owner", "x", "--repo", "y"]);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /unknown command "bogus"/);
  assert.match(r.stderr, /candidates, fetch, generate, mcp/);
});

test("reviewlore fetch / generate / mcp delegate to the stage commands", () => {
  for (const sub of ["fetch", "generate", "mcp"]) {
    const v = run(TOOLKIT_BIN, [sub, "--version"]);
    assert.equal(v.status, 0, `${sub}: ${v.stderr}`);
    assert.match(v.stdout, /^\d+\.\d+\.\d+/);
  }
  const demo = run(TOOLKIT_BIN, ["generate", "--demo"]);
  assert.equal(demo.status, 0, demo.stderr);
  assert.match(demo.stdout, /Generated output/);
});

test("reviewlore candidates prints JSON from an in-repo corpus, writes nothing", () => {
  const cacheDir = mkdtempSync(join(tmpdir(), "cli-cache-"));
  const target = mkdtempSync(join(tmpdir(), "cli-tgt-"));
  try {
    const fixture = JSON.parse(readFileSync(join(REPO_ROOT, "lib", "fixtures", "demo-typescript.json"), "utf-8"));
    fixture.meta.owner = "myorg";
    fixture.meta.repo = "myrepo";
    writeFileSync(join(target, ".reviewlore-corpus.json"), JSON.stringify(fixture));
    // Empty cache + --no-cache: fully offline, no token lookup of any kind.
    const r = spawnSync("node", [
      TOOLKIT_BIN, "candidates", "--target", target, "--owner", "myorg", "--repo", "myrepo",
      "--no-cache", "--limit", "5",
    ], { encoding: "utf-8", env: { ...process.env, REVIEWLORE_CACHE_DIR: cacheDir, GITHUB_TOKEN: "" } });
    assert.equal(r.status, 0, r.stderr);
    const out = JSON.parse(r.stdout);
    assert.equal(out.repo, "myorg/myrepo");
    assert.ok(out.clusters.length > 0 && out.clusters.length <= 5);
    assert.equal(out.stats.shown, out.clusters.length);
    const c = out.clusters[0];
    for (const k of ["id", "kind", "occurrences", "reviewers", "prs", "globs", "quotes"]) assert.ok(k in c, k);
    assert.ok(c.quotes[0].text && c.quotes[0].url);
    // History and the repo's instruction files, for the skill's checks.
    assert.equal(typeof out.history.prs, "number");
    assert.ok("warning" in out.history);
    assert.deepEqual(out.existing_instructions, []);
    // Nothing but the corpus in the target.
    assert.deepEqual(readdirSync(target), [".reviewlore-corpus.json"]);
  } finally {
    rmSync(cacheDir, { recursive: true, force: true });
    rmSync(target, { recursive: true, force: true });
  }
});

test("reviewlore without --owner/--repo + no git remote exits with clear error", () => {
  // Run from a non-git directory so auto-detection can't help.
  const tmp = mkdtempSync(join(tmpdir(), "no-git-"));
  try {
    const r = spawnSync("node", [TOOLKIT_BIN, "run", "--target", tmp], {
      cwd: tmp, encoding: "utf-8",
      env: { ...process.env, GITHUB_TOKEN: "" },
    });
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /--owner and --repo are required/);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("reviewlore generate --demo runs against bundled fixture without token", () => {
  const r = run(TOOLKIT_BIN, ["generate", "--demo"]);
  assert.equal(r.status, 0, r.stderr);
  // Stdout contains the rendered rule files.
  assert.match(r.stdout, /Generated output/);
  assert.match(r.stdout, /Generated by reviewlore/);
  assert.match(r.stdout, /^# Avoid: any/m);
  // Stderr says it cleaned up.
  assert.match(r.stderr, /demo mode/);
});

test("reviewlore fetch rejects --token without value (regression: #2)", () => {
  const r = run(TOOLKIT_BIN, ["fetch", "--owner", "x", "--repo", "y", "--token"]);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /Missing value for --token/);
});

test("reviewlore generate end-to-end on a fixture", () => {
  const tmp = mkdtempSync(join(tmpdir(), "pr-cli-"));
  try {
    const fixture = {
      meta: { owner: "x", repo: "y", since: "2025-01-01", months_back: 6 },
      issue_comments: Array.from({ length: 4 }, (_, i) => ({
        author: ["alice", "bob", "carol", "dave"][i],
        pr_number: i + 1,
        html_url: `https://example.test/${i}`,
        body: "Please don't use any types, prefer unknown instead.",
      })),
      review_comments: [],
      review_submissions: [],
    };
    const inputPath = join(tmp, "input.json");
    const targetPath = join(tmp, "target");
    mkdirSync(targetPath, { recursive: true });
    writeFileSync(inputPath, JSON.stringify(fixture), "utf-8");

    const r = run(TOOLKIT_BIN, ["generate", inputPath, "--target", targetPath, "--min-occurrences", "3"]);
    assert.equal(r.status, 0, r.stderr);
    assert.ok(existsSync(join(targetPath, ".claude", "rules")));
    const files = readdirSync(join(targetPath, ".claude", "rules"));
    assert.ok(files.length >= 1, "expected at least one rule file");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
test("reviewlore rejects non-numeric --months (regression)", () => {
  const tmp = mkdtempSync(join(tmpdir(), "toolkit-months-"));
  try {
    const r = spawnSync("node", [TOOLKIT_BIN, "run", "--target", tmp, "--owner", "x", "--repo", "y", "--months", "6m", "--token", "fake"], {
      encoding: "utf-8",
      env: { ...process.env, GITHUB_TOKEN: "fake" },
    });
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /--months must be a positive integer/);
    assert.match(r.stderr, /6m/);
    // Must not surface as an Invalid time value / RangeError stack.
    assert.doesNotMatch(r.stderr, /Invalid time value/);
    assert.doesNotMatch(r.stderr, /RangeError/);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("reviewlore rejects zero/negative --months (regression)", () => {
  const tmp = mkdtempSync(join(tmpdir(), "toolkit-months-"));
  try {
    const r = spawnSync("node", [TOOLKIT_BIN, "run", "--target", tmp, "--owner", "x", "--repo", "y", "--months", "0", "--token", "fake"], {
      encoding: "utf-8",
      env: { ...process.env, GITHUB_TOKEN: "fake" },
    });
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /--months must be a positive integer/);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("reviewlore run writes diff-mode state file and reports diff on re-run (bug: diff mode silently unavailable via `toolkit run`)", () => {
  const cacheDir = mkdtempSync(join(tmpdir(), "diff-cache-"));
  const target = mkdtempSync(join(tmpdir(), "diff-tgt-"));
  try {
    // Seed a fake cache by copying the demo fixture so we can run offline.
    const fixture = JSON.parse(readFileSync(
      join(REPO_ROOT, "lib", "fixtures", "demo-typescript.json"), "utf-8",
    ));
    fixture.meta.owner = "diffy";
    fixture.meta.repo = "diffy";
    writeFileSync(join(cacheDir, "diffy__diffy.json"), JSON.stringify(fixture));

    // Publish corpus into the target so `run` has zero-auth input.
    const pub = spawnSync("node", [
      TOOLKIT_BIN, "publish-corpus",
      "--target", target, "--owner", "diffy", "--repo", "diffy",
    ], { encoding: "utf-8", env: { ...process.env, REVIEWLORE_CACHE_DIR: cacheDir } });
    assert.equal(pub.status, 0, pub.stderr);

    // First run: no previous state, so no diff is rendered, but the
    // state file MUST be written so subsequent runs can diff.
    const r1 = spawnSync("node", [
      TOOLKIT_BIN, "run",
      "--target", target, "--owner", "diffy", "--repo", "diffy",
      "--preset", "exploratory", "--force",
    ], { encoding: "utf-8" });
    assert.equal(r1.status, 0, r1.stderr);
    const statePath = join(target, ".claude", ".reviewlore-state.json");
    assert.ok(existsSync(statePath),
      "first `toolkit run` must persist state for the diff feature to work on re-runs");

    // Second run with identical input: must surface the diff section on
    // stderr ("No cluster changes since previous run." when no changes).
    const r2 = spawnSync("node", [
      TOOLKIT_BIN, "run",
      "--target", target, "--owner", "diffy", "--repo", "diffy",
      "--preset", "exploratory", "--force",
    ], { encoding: "utf-8" });
    assert.equal(r2.status, 0, r2.stderr);
    assert.match(r2.stderr, /(Cluster diff vs previous run|No cluster changes since previous run)/,
      "second `toolkit run` must render a diff report against the previous state");
  } finally {
    rmSync(cacheDir, { recursive: true, force: true });
    rmSync(target, { recursive: true, force: true });
  }
});

function withCorpus(fn) {
  const cacheDir = mkdtempSync(join(tmpdir(), "cli-cache-"));
  const target = mkdtempSync(join(tmpdir(), "cli-tgt-"));
  try {
    const fixture = JSON.parse(readFileSync(join(REPO_ROOT, "lib", "fixtures", "demo-typescript.json"), "utf-8"));
    fixture.meta.owner = "myorg";
    fixture.meta.repo = "myrepo";
    writeFileSync(join(target, ".reviewlore-corpus.json"), JSON.stringify(fixture));
    // PATH holds only node: no `gh`, so no token can be found and nothing
    // can reach GitHub even if a code path falls through to fetching.
    const toolkit = (args) => spawnSync(process.execPath, [TOOLKIT_BIN, ...args, "--target", target, "--no-cache"], {
      encoding: "utf-8", env: { PATH: dirname(process.execPath), REVIEWLORE_CACHE_DIR: cacheDir, GITHUB_TOKEN: "" },
    });
    return fn({ target, toolkit, fixture });
  } finally {
    rmSync(cacheDir, { recursive: true, force: true });
    rmSync(target, { recursive: true, force: true });
  }
}

test("candidates ignores a committed corpus that belongs to another repo", () => {
  withCorpus(({ toolkit }) => {
    const m = toolkit(["candidates", "--owner", "other", "--repo", "repo"]);
    assert.match(m.stderr, /Ignoring .*holds myorg\/myrepo, not other\/repo/);
    // Falls through to fetching, which fails offline for lack of a token.
    assert.match(m.stderr, /No GitHub token found/);
    assert.notEqual(m.status, 0);
  });
});

test("an explicit --months window applies to a committed corpus", () => {
  withCorpus(({ toolkit }) => {
    // The fixture's comments are from 2026-01..04; a 1-month window ending now holds none of them.
    const all = JSON.parse(toolkit(["candidates", "--owner", "myorg", "--repo", "myrepo"]).stdout);
    const recent = JSON.parse(toolkit(["candidates", "--owner", "myorg", "--repo", "myrepo", "--months", "1"]).stdout);
    assert.ok(all.stats.candidates > 0);
    assert.equal(recent.stats.candidates, 0);
  });
});

test("run and candidates validate clustering flags", () => {
  withCorpus(({ toolkit }) => {
    const bad = [["--engine", "bogus", /--engine must be/], ["--min-occurrences", "abc", /--min-occurrences must be/], ["--threshold", "2", /--threshold must be/]];
    for (const cmd of ["run", "candidates"]) {
      for (const [flag, value, msg] of bad) {
        const r = toolkit([cmd, "--owner", "myorg", "--repo", "myrepo", flag, value]);
        assert.equal(r.status, 1, `${cmd} ${flag}`);
        assert.match(r.stderr, msg);
      }
    }
  });
});

test("a stage named after leading flags is dispatched with its own flags", () => {
  const r = run(TOOLKIT_BIN, ["--dry-run", "generate", "--demo"]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /Demo mode/);
});

test("candidates ignores preset thresholds (it must show single comments)", () => {
  withCorpus(({ toolkit }) => {
    const loose = JSON.parse(toolkit(["candidates", "--owner", "myorg", "--repo", "myrepo"]).stdout);
    const withPreset = JSON.parse(toolkit(["candidates", "--owner", "myorg", "--repo", "myrepo", "--preset", "team-of-3"]).stdout);
    assert.equal(withPreset.stats.clusters, loose.stats.clusters);
    const explicit = JSON.parse(toolkit(["candidates", "--owner", "myorg", "--repo", "myrepo", "--min-occurrences", "3"]).stdout);
    assert.ok(explicit.stats.clusters < loose.stats.clusters);
  });
});

test("a corrupt committed corpus is ignored with a warning, not a crash", () => {
  withCorpus(({ target, toolkit }) => {
    writeFileSync(join(target, ".reviewlore-corpus.json"), "<<<<<<< HEAD\n{}\n");
    const r = toolkit(["candidates", "--owner", "myorg", "--repo", "myrepo"]);
    assert.match(r.stderr, /isn't valid JSON/);
    assert.doesNotMatch(r.stderr, /TypeError|at .*\.mjs:\d+/);
    // Falls through to fetching, which fails offline for lack of a token.
    assert.match(r.stderr, /No GitHub token found/);
  });
});


test("candidates --save prints only a private file path; --discard deletes it", () => {
  withCorpus(({ target, toolkit }) => {
    const r = toolkit(["candidates", "--owner", "myorg", "--repo", "myrepo", "--save"]);
    assert.equal(r.status, 0, r.stderr);
    const path = r.stdout.trim();
    assert.doesNotMatch(path, /\n/);
    assert.ok(JSON.parse(readFileSync(path, "utf-8")).clusters.length > 0);
    if (process.platform !== "win32") assert.equal(statSync(path).mode & 0o777, 0o600);

    // Refuses anything it didn't write: here, the committed corpus.
    const refuse = toolkit(["candidates", "--discard", join(target, ".reviewlore-corpus.json")]);
    assert.equal(refuse.status, 1);
    assert.match(refuse.stderr, /refusing to delete/);
    assert.ok(existsSync(join(target, ".reviewlore-corpus.json")));

    const d = toolkit(["candidates", "--discard", path]);
    assert.equal(d.status, 0, d.stderr);
    assert.equal(existsSync(path), false);
  });
});

test("doctor --json reports checks and exits 1 outside a git repo", () => {
  const tmp = mkdtempSync(join(tmpdir(), "doctor-cli-"));
  try {
    const r = spawnSync("node", [TOOLKIT_BIN, "doctor", "--json"], {
      cwd: tmp, encoding: "utf-8", env: { ...process.env, GITHUB_TOKEN: "" },
    });
    assert.equal(r.status, 1);
    assert.equal(r.stderr, "");
    const report = JSON.parse(r.stdout);
    assert.equal(report.ok, false);
    assert.ok(report.checks.some((c) => c.id === "node" && c.ok));
    assert.ok(report.checks.some((c) => c.id === "repo" && !c.ok));
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("large stdout isn't truncated when piped (regression: exit before flush)", () => {
  const cacheDir = mkdtempSync(join(tmpdir(), "cli-cache-"));
  const target = mkdtempSync(join(tmpdir(), "cli-tgt-"));
  try {
    // ~600 unrelated requests (no shared words, so no merging): the JSON is
    // several 64 KB pipe buffers long.
    const word = (n) => Array.from({ length: 6 }, (_, k) => String.fromCharCode(97 + (Math.floor(n / 26 ** k) % 26))).join("");
    const review_comments = Array.from({ length: 600 }, (_, i) => ({
      author: `rev${i % 7}`, pr_number: i + 1, path: `src/f${i}.ts`,
      html_url: `https://github.com/myorg/myrepo/pull/${i + 1}#discussion_r${i}`,
      created_at: "2026-01-15T00:00:00Z",
      body: `Please avoid ${word(i)} ${word(i + 5000)} ${word(i + 9000)} in this module.`,
    }));
    writeFileSync(join(target, ".reviewlore-corpus.json"), JSON.stringify({
      meta: { owner: "myorg", repo: "myrepo", since: "2025-12-01T00:00:00Z", totals: { total: 600 } },
      issue_comments: [], review_comments, review_submissions: [],
    }));
    const r = spawnSync(process.execPath, [
      TOOLKIT_BIN, "candidates", "--owner", "myorg", "--repo", "myrepo", "--target", target, "--no-cache", "--limit", "5000",
    ], { encoding: "utf-8", maxBuffer: 64 * 1024 * 1024, env: { PATH: dirname(process.execPath), REVIEWLORE_CACHE_DIR: cacheDir, GITHUB_TOKEN: "" } });
    assert.equal(r.status, 0, r.stderr);
    assert.ok(r.stdout.length > 2 * 65536, `only ${r.stdout.length} bytes; the test needs more output`);
    assert.doesNotThrow(() => JSON.parse(r.stdout));
  } finally {
    rmSync(cacheDir, { recursive: true, force: true });
    rmSync(target, { recursive: true, force: true });
  }
});

test("candidates --demo needs no repo, token or network", () => {
  const tmp = mkdtempSync(join(tmpdir(), "demo-cli-"));
  try {
    const r = spawnSync(process.execPath, [TOOLKIT_BIN, "candidates", "--demo"], {
      cwd: tmp, encoding: "utf-8", env: { PATH: dirname(process.execPath), GITHUB_TOKEN: "" },
    });
    assert.equal(r.status, 0, r.stderr);
    const out = JSON.parse(r.stdout);
    assert.equal(out.demo, true);
    assert.equal(out.repo, "vitest-dev/vitest");
    assert.ok(out.clusters.some((c) => c.prs >= 2 && c.reviewers >= 2));
    // Pseudonymised: no real handles in the shipped fixture.
    assert.ok(out.clusters.every((c) => c.quotes.every((q) => /^user-\d+$/.test(q.author))));
    assert.ok(Buffer.byteLength(r.stdout) < 64 * 1024);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("fetch --time-budget / --no-output need --cache; bad budgets are rejected", () => {
  const env = { PATH: dirname(process.execPath), GITHUB_TOKEN: "" };
  const fetch = (args) => spawnSync(process.execPath, [TOOLKIT_BIN, "fetch", "--owner", "o", "--repo", "r", ...args], { encoding: "utf-8", env });
  for (const args of [["--time-budget", "90"], ["--no-output"]]) {
    const r = fetch(args);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /need --cache/);
  }
  const bad = fetch(["--cache", "--time-budget", "soon"]);
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /--time-budget must be a number/);
});

test("candidates lists the target's existing instruction files", () => {
  withCorpus(({ target, toolkit }) => {
    writeFileSync(join(target, "CLAUDE.md"), "# Conventions\n");
    const out = JSON.parse(toolkit(["candidates", "--owner", "myorg", "--repo", "myrepo"]).stdout);
    assert.deepEqual(out.existing_instructions, [{ path: "CLAUDE.md", bytes: 14, generated: false }]);
  });
});

test("unknown options are rejected per command, with a suggestion", () => {
  const r = run(TOOLKIT_BIN, ["run", "--month", "3"]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /Unknown option --month\. Did you mean --months\?/);
  const g = run(TOOLKIT_BIN, ["generate", "--sumary"]);
  assert.equal(g.status, 1);
  assert.match(g.stderr, /Did you mean --summary\?/);
  // A stage named after a flag with a value still gets its own flags.
  const d = run(TOOLKIT_BIN, ["--dry-run", "generate", "--demo", "--summary"]);
  assert.equal(d.status, 0, d.stderr);
});

test("missing owner/repo prints one hint line, not the whole help", () => {
  const tmp = mkdtempSync(join(tmpdir(), "no-git-hint-"));
  try {
    const r = spawnSync(process.execPath, [TOOLKIT_BIN, "run", "--target", tmp], {
      cwd: tmp, encoding: "utf-8", env: { PATH: dirname(process.execPath), GITHUB_TOKEN: "" },
    });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /Run `reviewlore --help` for usage/);
    assert.doesNotMatch(r.stderr, /Options:/);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("run explains an empty result from the history", () => {
  withCorpus(({ toolkit }) => {
    const r = toolkit(["run", "--owner", "myorg", "--repo", "myrepo", "--min-occurrences", "50", "--dry-run"]);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stderr, /No rules: nothing reached the bar \(50\+ \(reviewer, PR\) pairs from 2\+ reviewers\)\.\nOnly \d+ PRs? had human review.*\nNext steps:\n  • /s);
  });
});

// One maintainer asking for the same thing on four PRs; nobody else reviews.
function withMaintainerCorpus(fn) {
  const cacheDir = mkdtempSync(join(tmpdir(), "cli-cache-"));
  const target = mkdtempSync(join(tmpdir(), "cli-maint-"));
  try {
    const issue_comments = [1, 2, 3, 4].map((pr) => ({
      type: "issue_comment", comment_id: pr, pr_number: pr, author: "maint", author_type: "User",
      body: "Please don't update the CHANGELOG file in pull requests.", created_at: "2026-09-0" + pr + "T00:00:00Z",
      html_url: `https://github.com/o/r/pull/${pr}#issuecomment-${pr}`,
    }));
    writeFileSync(join(target, ".reviewlore-corpus.json"), JSON.stringify({
      meta: { owner: "o", repo: "r", fetched_at: "2026-10-01T00:00:00Z", pr_authors: {} }, issue_comments, review_comments: [], review_submissions: [],
    }));
    const toolkit = (args) => spawnSync(process.execPath, [TOOLKIT_BIN, ...args, "--owner", "o", "--repo", "r", "--target", target, "--no-cache"], {
      encoding: "utf-8", env: { PATH: dirname(process.execPath), REVIEWLORE_CACHE_DIR: cacheDir, GITHUB_TOKEN: "" },
    });
    return fn({ target, toolkit });
  } finally {
    rmSync(cacheDir, { recursive: true, force: true });
    rmSync(target, { recursive: true, force: true });
  }
}

test("single-maintainer repos: diagnosis without the flag, labelled rules with --single-reviewer", () => {
  withMaintainerCorpus(({ target, toolkit }) => {
    const plain = toolkit(["run"]);
    assert.equal(plain.status, 0, plain.stderr);
    assert.match(plain.stderr, /No rules: nothing reached the bar/);
    assert.match(plain.stderr, /Single-maintainer repo\? .*\(--single-reviewer\)/);
    assert.equal(existsSync(join(target, ".claude", "rules")), false);

    const single = toolkit(["run", "--single-reviewer"]);
    assert.doesNotMatch(single.stderr, /Next steps/, "it found a rule");
    assert.equal(single.status, 0, single.stderr);
    const dir = join(target, ".claude", "rules");
    const [file] = readdirSync(dir);
    const text = readFileSync(join(dir, file), "utf-8");
    assert.match(text, /^# Maintainer preference: /m);
    assert.match(text, /\*\*Support:\*\* one reviewer \(@maint\) on 4 PRs — below the team bar of 2 reviewers/);

    const cand = JSON.parse(toolkit(["candidates"]).stdout);
    // Four PRs is "thin": a longer window first, single-maintainer mode next.
    assert.match(cand.diagnosis.reasons[0], /Only 4 PRs/);
    assert.deepEqual(cand.diagnosis.suggestions.map((x) => x.cli ?? null).slice(0, 2), ["--months 12", "--single-reviewer"]);
    assert.equal(cand.diagnosis.suggestions.find((s) => s.cli === "--single-reviewer")?.skill, "/reviewlore:learn-from-reviews single-maintainer");
  });
});

test("candidates has no diagnosis when a cluster reaches the bar", () => {
  withCorpus(({ toolkit }) => {
    const out = JSON.parse(toolkit(["candidates", "--owner", "myorg", "--repo", "myrepo"]).stdout);
    assert.ok(out.clusters.some((c) => c.prs >= 2 && c.reviewers >= 2));
    assert.equal(out.diagnosis, undefined);
  });
});

test("candidates --raw prints a header line then one comment per line", () => {
  withCorpus(({ toolkit }) => {
    const r = toolkit(["candidates", "--owner", "myorg", "--repo", "myrepo", "--raw"]);
    assert.equal(r.status, 0, r.stderr);
    const lines = r.stdout.trim().split("\n").map((l) => JSON.parse(l));
    assert.equal(lines[0].mode, "raw");
    assert.equal(lines[0].stats.shown, lines.length - 1);
    assert.ok(lines.slice(1).every((x) => typeof x.u === "string" && x.by && x.text));
    assert.match(r.stderr, /review comments after filtering/);
    assert.equal(toolkit(["candidates", "--owner", "myorg", "--repo", "myrepo", "--raw", "--budget", "10"]).status, 1);
  });
});
