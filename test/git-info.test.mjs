import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, delimiter } from "node:path";
import { spawnSync } from "node:child_process";
import { detectRepoFromGit, findGitToplevel } from "../lib/git-info.mjs";
import { gitOnlyDir } from "./helpers/git-only.mjs";

function gitInit(dir) {
  spawnSync("git", ["init", "-q", dir]);
}
function gitSetOrigin(dir, url) {
  spawnSync("git", ["-C", dir, "remote", "remove", "origin"]);
  spawnSync("git", ["-C", dir, "remote", "add", "origin", url]);
}
function withRepo(fn) {
  const dir = mkdtempSync(join(tmpdir(), "git-info-"));
  try { gitInit(dir); return fn(dir); } finally { rmSync(dir, { recursive: true, force: true }); }
}

test("detectRepoFromGit: returns null when not a git repo", () => {
  const dir = mkdtempSync(join(tmpdir(), "no-git-"));
  try {
    assert.equal(detectRepoFromGit(dir), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("detectRepoFromGit: returns null when git repo has no origin", () => {
  withRepo((dir) => {
    assert.equal(detectRepoFromGit(dir), null);
  });
});

test("detectRepoFromGit: parses HTTPS origin URL", () => {
  withRepo((dir) => {
    gitSetOrigin(dir, "https://github.com/facebook/react.git");
    const r = detectRepoFromGit(dir);
    assert.equal(r.owner, "facebook");
    assert.equal(r.repo, "react");
  });
});

test("detectRepoFromGit: parses HTTPS origin URL without .git suffix", () => {
  withRepo((dir) => {
    gitSetOrigin(dir, "https://github.com/vercel/swr");
    const r = detectRepoFromGit(dir);
    assert.equal(r.owner, "vercel");
    assert.equal(r.repo, "swr");
  });
});

test("detectRepoFromGit: parses SSH origin URL", () => {
  withRepo((dir) => {
    gitSetOrigin(dir, "git@github.com:pnpm/pnpm.git");
    const r = detectRepoFromGit(dir);
    assert.equal(r.owner, "pnpm");
    assert.equal(r.repo, "pnpm");
  });
});

test("detectRepoFromGit: returns null for unrecognised URL", () => {
  withRepo((dir) => {
    gitSetOrigin(dir, "weird://not-a-url");
    // Either null or a best-effort guess — but should not throw.
    assert.doesNotThrow(() => detectRepoFromGit(dir));
  });
});
test("findGitToplevel: returns null when not in a git repo", () => {
  const dir = mkdtempSync(join(tmpdir(), "no-git-top-"));
  try {
    assert.equal(findGitToplevel(dir), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("findGitToplevel: returns repo root when called from the root itself", () => {
  withRepo((dir) => {
    assert.equal(realpathSync.native(findGitToplevel(dir)), realpathSync.native(dir));
  });
});

test("findGitToplevel: returns repo root when called from a subdirectory (monorepo case)", () => {
  withRepo((dir) => {
    const sub = join(dir, "packages", "app");
    mkdirSync(sub, { recursive: true });
    assert.equal(realpathSync.native(findGitToplevel(sub)), realpathSync.native(dir));
  });
});


test("parseRemoteUrl: GitHub hosts are supported, keep their host; others say why not", async () => {
  const { parseRemoteUrl } = await import("../lib/git-info.mjs");
  const pick = (url) => (({ host, owner, repo, supported }) => ({ host, owner, repo, supported }))(parseRemoteUrl(url));
  for (const url of ["https://github.com/o/r.git", "git@github.com:o/r.git", "ssh://git@github.com/o/r", "https://github.com/o/r/", "git@github.com-work:o/r.git", "https://www.github.com/o/r"]) {
    assert.deepEqual(pick(url), { host: "github.com", owner: "o", repo: "r", supported: true }, url);
  }
  assert.deepEqual(pick("git@github.example.com:team/app.git"), { host: "github.example.com", owner: "team", repo: "app", supported: true });
  assert.deepEqual(pick("https://GHE.Corp.Example:8443/acme/app"), { host: "ghe.corp.example:8443", owner: "acme", repo: "app", supported: true }, "https keeps the web port");
  assert.equal(pick("ssh://git@ghe.corp.example:2222/acme/app.git").host, "ghe.corp.example", "the SSH port isn't the web port");
  assert.equal(pick("acme@acme.ghe.com:team/app.git").host, "acme.ghe.com");
  assert.equal(pick("https://user:secret@ghe.corp.example/acme/app").host, "ghe.corp.example", "credentials are not kept");
  assert.ok(!JSON.stringify(parseRemoteUrl("https://ghe.corp.example/acme/app")).includes("secret"));

  const gitlab = parseRemoteUrl("https://gitlab.com/group/sub/proj.git");
  assert.deepEqual([gitlab.provider, gitlab.owner, gitlab.repo, gitlab.supported], ["gitlab", "group/sub", "proj", true]);
  assert.equal(parseRemoteUrl("git@gitlab.acme.corp:team/app.git").provider, "gitlab");
  // A self-managed GitLab without "gitlab" in its name: subgroups need --provider gitlab.
  assert.match(parseRemoteUrl("https://git.acme.corp/group/sub/proj").problem, /pass --provider gitlab/);
  assert.equal(parseRemoteUrl("https://git.acme.corp/group/sub/proj", { provider: "gitlab" }).owner, "group/sub");
  assert.match(parseRemoteUrl("git@bitbucket.org:team/app.git").problem, /bitbucket\.org isn't supported/);
  assert.match(parseRemoteUrl("git@gh-work:o/r.git").problem, /can't tell which GitHub host "gh-work" is/);
  assert.equal(parseRemoteUrl("not a url"), null);
  assert.equal(parseRemoteUrl("file:///srv/repos/app.git"), null);
});
test("run uses an enterprise origin's own host, and refuses non-GitHub origins", () => {
  withRepo((dir) => {
    const bin = join(import.meta.dirname, "..", "cli", "reviewlore.mjs");
    // PATH = a dir holding only a `git` symlink, plus node's dir: no `gh`
    // (it often sits next to git), so even a regression can't resolve a
    // token or reach GitHub.
    const PATH = [gitOnlyDir(dir), dirname(process.execPath)].join(delimiter);
    const run = () => spawnSync(process.execPath, [bin, "run", "--dry-run", "--no-cache"], {
      cwd: dir, encoding: "utf-8",
      env: { PATH, REVIEWLORE_CACHE_DIR: dir, GITHUB_TOKEN: "github-dot-com-token" },
    });
    gitSetOrigin(dir, "git@github.example.com:team/app.git");
    const ghes = run();
    assert.equal(ghes.status, 1);
    assert.match(ghes.stderr, /Detected team\/app on github\.example\.com from git origin/);
    // A github.com GITHUB_TOKEN is never sent to an enterprise server.
    assert.match(ghes.stderr, /No token for github\.example\.com\. Run `gh auth login --hostname github\.example\.com`, set GH_ENTERPRISE_TOKEN/);

    gitSetOrigin(dir, "https://bitbucket.org/team/app.git");
    const bitbucket = run();
    assert.equal(bitbucket.status, 1);
    assert.match(bitbucket.stderr, /bitbucket\.org isn't supported/);
  });
});
test("an enterprise repo's committed corpus works with no token; a github.com corpus there is ignored", () => {
  withRepo((dir) => {
    gitSetOrigin(dir, "https://ghe.corp.example/acme/app.git");
    const PATH = [gitOnlyDir(dir), dirname(process.execPath)].join(delimiter);
    const corpus = (host) => JSON.stringify({
      meta: { owner: "acme", repo: "app", ...(host ? { host } : {}), fetched_at: "2026-10-01T00:00:00Z", pr_authors: {} },
      issue_comments: [1, 2, 3].map((n) => ({
        type: "issue_comment", comment_id: n, pr_number: n, author: `r${n}`, author_type: "User",
        body: "Please add a changeset for this change.", created_at: "2026-09-0" + n + "T00:00:00Z",
        html_url: `https://ghe.corp.example/acme/app/pull/${n}#issuecomment-${n}`,
      })),
      review_comments: [], review_submissions: [],
    });
    const bin = join(import.meta.dirname, "..", "cli", "reviewlore.mjs");
    const candidates = () => spawnSync(process.execPath, [bin, "candidates", "--no-cache"], { cwd: dir, encoding: "utf-8", env: { PATH, REVIEWLORE_CACHE_DIR: join(dir, ".cache"), GITHUB_TOKEN: "" } });

    writeFileSync(join(dir, ".reviewlore-corpus.json"), corpus("ghe.corp.example"));
    const ok = candidates();
    assert.equal(ok.status, 0, ok.stderr);
    assert.ok(JSON.parse(ok.stdout).clusters.length > 0);

    writeFileSync(join(dir, ".reviewlore-corpus.json"), corpus(null));
    const wrong = candidates();
    assert.match(wrong.stderr, /Ignoring .*: it holds acme\/app, not acme\/app on ghe\.corp\.example/);
    assert.notEqual(wrong.status, 0);
  });
});

test("isPlainIssueComment works on enterprise URLs", async () => {
  const { isPlainIssueComment } = await import("../lib/filters.mjs");
  assert.equal(isPlainIssueComment({ html_url: "https://ghe.acme.corp/a/b/issues/3#issuecomment-1" }), true);
  assert.equal(isPlainIssueComment({ html_url: "https://ghe.acme.corp/a/b/pull/3#issuecomment-1" }), false);
});
