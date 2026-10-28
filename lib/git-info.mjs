// Read facts from the local git context. Used by:
//   - init wizard, to pre-fill owner/repo from origin
//   - `reviewlore run`, as a fallback when --owner/--repo aren't
//     provided
//
// Always best-effort: silently returns null when not in a git repo, the
// remote URL is unrecognised, or git itself isn't on PATH.

import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { normalizeHost, hostProblem, resolveHost, isGitLabHost, isValidHost } from "./github-host.mjs";

export function detectRepoFromGit(cwd = process.cwd(), { provider } = {}) {
  try {
    const r = spawnSync("git", ["-C", cwd, "remote", "get-url", "origin"], {
      encoding: "utf-8", timeout: 1500,
    });
    if (r.status !== 0 || !r.stdout) return null;
    return parseRemoteUrl(r.stdout.trim(), { provider });
  } catch {
    return null;
  }
}

// Parse a git remote URL — https://host[:port]/owner/repo(.git),
// [user@]host:owner/repo(.git) or ssh://[user@]host[:port]/owner/repo(.git) —
// into { host, owner, repo, url, supported, problem? }. `host` is
// normalised (github.com SSH aliases → github.com). `supported` means a
// GitHub host (github.com, GHE.com, GitHub Enterprise Server) and exactly
// owner/repo; otherwise `problem` says why (GitLab subgroups, Bitbucket,
// an SSH alias we can't resolve), so callers never quietly look up a
// same-named repository somewhere else.
// `provider: "gitlab"` (or a GitLab-looking host) reads nested groups:
// group/sub/proj → owner "group/sub", repo "proj".
export function parseRemoteUrl(url, { provider } = {}) {
  let host;
  let path;
  const scp = url.match(/^(?:[^@\s/]+@)?([^:/\s]+):(?!\/\/)(.+)$/);
  if (scp && !/^[a-z]+:\/\//i.test(url)) {
    [, host, path] = scp;
  } else {
    try {
      const u = new URL(url);
      if (!["https:", "http:", "ssh:", "git:"].includes(u.protocol)) return null;
      // An ssh:// port is the SSH port, not the web server's.
      host = u.protocol === "ssh:" || u.protocol === "git:" ? u.hostname : u.host;
      path = u.pathname;
    } catch {
      return null;
    }
  }
  const parts = path.replace(/^\/+|\/+$/g, "").replace(/\.git$/, "").split("/").filter(Boolean);
  if (parts.length < 2) return null;
  const normal = normalizeHost(host);
  if (provider === "gitlab" || (!provider && isGitLabHost(normal))) {
    const problem = isValidHost(normal) ? null : `"${host}" isn't a valid host name.`;
    return { host: normal, owner: parts.slice(0, -1).join("/"), repo: parts[parts.length - 1], url, provider: "gitlab", supported: !problem, ...(problem ? { problem } : {}) };
  }
  const owner = parts[0];
  const repo = parts[parts.length - 1];
  const problem = parts.length !== 2
    ? `${normal}/${parts.join("/")} isn't an owner/repo path; if it's a self-managed GitLab, pass --provider gitlab.`
    : hostProblem(normal);
  return { host: normal, owner, repo, url, provider: "github", supported: !problem, ...(problem ? { problem } : {}) };
}

// Returns the absolute path of the repository root that contains `cwd`, or
// null if `cwd` is not inside a git working tree. Unlike `existsSync(cwd/.git)`,
// this works from any subdirectory of the repo (monorepo packages, nested
// dirs, etc.) — the same scope `detectRepoFromGit` already supports.
export function findGitToplevel(cwd = process.cwd()) {
  try {
    const r = spawnSync("git", ["-C", cwd, "rev-parse", "--show-toplevel"], {
      encoding: "utf-8", timeout: 1500,
    });
    if (r.status !== 0 || !r.stdout) return null;
    // git prints C:/x on Windows; resolve() gives the native C:\x.
    return r.stdout.trim() ? resolve(r.stdout.trim()) : null;
  } catch {
    return null;
  }
}

function git(cwd, args, timeout = 5000) {
  try {
    const r = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf-8", timeout, maxBuffer: 64 * 1024 * 1024 });
    return r.status === 0 ? r.stdout : null;
  } catch {
    return null;
  }
}

const resolves = (cwd, ref) => git(cwd, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]) !== null;

// The branch a change will be merged into, from local refs only (never a
// fetch): an explicit ref, then origin's default branch, then the first of
// origin/main, origin/master, main, master that exists. Null if none.
export function detectBaseRef(cwd, explicit) {
  if (explicit) return resolves(cwd, explicit) ? explicit : null;
  const head = git(cwd, ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"])?.trim();
  if (head && resolves(cwd, head)) return head;
  return ["origin/main", "origin/master", "main", "master"].find((ref) => resolves(cwd, ref)) ?? null;
}

// Files changed on this branch since it left `base`, including staged,
// unstaged and untracked work: [{ path, status }] where status is
// A(dded), M(odified), D(eleted), R(enamed — path is the new name) or
// U(ntracked). Returns { mergeBase, changed } or null if git fails.
export function changedPaths(cwd, base) {
  const mergeBase = git(cwd, ["merge-base", "HEAD", base])?.trim();
  if (!mergeBase) return null;
  const diff = git(cwd, ["diff", "--name-status", "-M", "-z", mergeBase]);
  if (diff === null) return null;
  const parts = diff.split("\0").filter((p) => p !== "");
  const changed = [];
  for (let i = 0; i < parts.length;) {
    const code = parts[i++][0];
    if (code === "R" || code === "C") {
      i++; // old name
      changed.push({ path: parts[i++], status: code === "R" ? "R" : "A" });
    } else {
      changed.push({ path: parts[i++], status: code === "T" ? "M" : code });
    }
  }
  const untracked = git(cwd, ["ls-files", "--others", "--exclude-standard", "-z"]) ?? "";
  for (const path of untracked.split("\0").filter(Boolean)) changed.push({ path, status: "U" });
  changed.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return { mergeBase, changed };
}

// Paths of all files git tracks under `cwd` (for checking rule `paths`).
export function trackedFiles(cwd) {
  const out = git(cwd, ["ls-files", "-z"]);
  return out === null ? [] : out.split("\0").filter(Boolean);
}

// owner/repo and their GitHub host for a command: flags first, then the
// git origin of `dir`; the host as resolveHost orders it (--api-url,
// --host, the origin's host when owner/repo came from it, Actions,
// GH_HOST, github.com).
//   → { owner, repo, host, baseUrl, detected: bool } or { error } or {} (nothing found)
export function resolveRepo({ owner, repo, host, apiUrl, provider, dir, env = process.env }) {
  if (provider && !["github", "gitlab"].includes(provider)) return { error: `--provider must be github or gitlab (got "${provider}").` };
  let detected = null;
  if (!owner || !repo) {
    detected = detectRepoFromGit(dir, { provider });
    if (detected && !detected.supported) {
      return { error: `origin is ${detected.url.replace(/\/\/[^@/]*@/, "//")}: ${detected.problem} Pass --owner and --repo (and --host) to use another repository.` };
    }
    if (detected) {
      owner ??= detected.owner;
      repo ??= detected.repo;
    }
  }
  if (!owner || !repo) return {};
  const gitlab = provider === "gitlab" || (!provider && (detected?.provider === "gitlab" || (!detected && isGitLabHost(host ?? ""))));
  if (gitlab) {
    const h = normalizeHost(host ?? detected?.host ?? "gitlab.com");
    if (!isValidHost(h)) return { error: `"${h}" isn't a valid host name.` };
    return { owner, repo, host: h, baseUrl: apiUrl?.replace(/\/+$/, "") ?? `https://${h}/api/v4`, provider: "gitlab", detected: Boolean(detected) };
  }
  const target = resolveHost({ flagHost: host, flagApiUrl: apiUrl, detectedHost: detected?.host, env });
  if (target.error) return { error: target.error };
  return { owner, repo, host: target.host, baseUrl: target.baseUrl, provider: "github", detected: Boolean(detected) };
}

// "acme/app" on github.com, "acme/app on ghe.acme.corp" elsewhere.
export const repoLabel = (owner, repo, host = "github.com") => `${owner}/${repo}${host === "github.com" ? "" : ` on ${host}`}`;
