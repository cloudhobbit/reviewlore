// `reviewlore doctor`: offline checks that the toolkit can run here.
//
// Used by the plugin skill before it fetches anything, so a missing
// dependency or an unsupported remote is reported in plain words instead
// of a stack trace. No network, and no tokens: auth problems are reported
// by the real command's own error.
//
// Each probe is injectable so tests don't depend on the machine's Node,
// git or node_modules.

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { detectRepoFromGit, findGitToplevel } from "./git-info.mjs";
import { corpusInfo } from "./corpus.mjs";

export const PACKAGE_ROOT = fileURLToPath(new URL("..", import.meta.url));

const NODE_FIX =
  "Install Node.js LTS from https://nodejs.org (or `brew install node`, or " +
  "`winget install OpenJS.NodeJS.LTS`), then restart Claude Code.";

function depsFix(root) {
  return "If you installed the Claude Code plugin, reinstall it (npm must be on your PATH when Claude Code " +
    `installs it); otherwise run \`npm install\` in ${root}.`;
}

function packageEngines() {
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf-8"));
  return pkg.engines?.node ?? ">=20.11";
}

function canResolve(specifier) {
  try {
    import.meta.resolve(specifier);
    return true;
  } catch {
    return false;
  }
}

function gitVersion() {
  try {
    const r = spawnSync("git", ["--version"], { encoding: "utf-8", timeout: 1500 });
    return r.status === 0 ? r.stdout.trim() : null;
  } catch {
    return null;
  }
}

// ">=20.11" → [20, 11, 0]. Only the >= form is used in package.json.
function minimumVersion(range) {
  const m = String(range).match(/(\d+)(?:\.(\d+))?(?:\.(\d+))?/);
  return m ? [Number(m[1]), Number(m[2] ?? 0), Number(m[3] ?? 0)] : [0, 0, 0];
}

export function versionAtLeast(version, range) {
  const have = String(version).replace(/^v/, "").split(".").map((n) => Number(n) || 0);
  const need = minimumVersion(range);
  for (let i = 0; i < 3; i++) {
    if ((have[i] ?? 0) !== need[i]) return (have[i] ?? 0) > need[i];
  }
  return true;
}

function check(id, ok, required, message, fix) {
  return { id, ok, required, message, ...(ok ? {} : { fix }) };
}

// Returns { ok, checks: [{ id, ok, required, message, fix? }] }. `ok` is
// false when any required check fails.
export function runDoctor({
  cwd = process.cwd(),
  nodeVersion = process.versions.node,
  engines = packageEngines(),
  resolve = canResolve,
  git = gitVersion,
  root = PACKAGE_ROOT,
} = {}) {
  const checks = [];

  const nodeOk = versionAtLeast(nodeVersion, engines);
  checks.push(check(
    "node", nodeOk, true,
    `Node.js ${nodeVersion} (reviewlore needs ${engines})`,
    `reviewlore needs Node.js ${engines.replace(/^>=\s*/, "")} or newer. ${NODE_FIX}`,
  ));

  const gitOut = git();
  checks.push(check(
    "git", Boolean(gitOut), true,
    gitOut ?? "git not found on PATH",
    "Install git and make sure it is on your PATH.",
  ));

  // The repo and corpus checks need git; without it they'd only repeat
  // the git failure.
  let toplevel = null;
  let detected = null;
  if (gitOut) {
    toplevel = findGitToplevel(cwd);
    detected = toplevel ? detectRepoFromGit(toplevel) : null;
    if (!toplevel) {
      checks.push(check("repo", false, true, `${cwd} is not inside a git repository`,
        "Run this from inside a clone of the GitHub repository you want rules for."));
    } else if (!detected) {
      checks.push(check("repo", false, true, `${toplevel} has no usable \`origin\` remote`,
        "Add the GitHub repository as `origin`, or pass --owner and --repo to `run`/`candidates`."));
    } else if (!detected.supported) {
      checks.push(check("repo", false, true, `origin isn't usable: ${detected.problem}`,
        "GitLab and Bitbucket aren't supported yet. Pass --owner and --repo (and --host) to use a GitHub repository."));
    } else {
      const where = detected.host === "github.com" ? "" : ` on ${detected.host}`;
      checks.push(check("repo", true, true, `${detected.owner}/${detected.repo}${where} (${toplevel})`));
    }
  }

  // A committed corpus for this repo means no fetch, so no Octokit needed.
  let corpusUsable = false;
  if (toplevel) {
    const info = corpusInfo(toplevel);
    if (!info) {
      checks.push(check("corpus", true, false, "no committed corpus; PR history will be read from GitHub (needs a token)"));
    } else if (info.error) {
      checks.push(check("corpus", false, false, `${info.path} isn't valid JSON (unresolved merge conflict?)`,
        "Re-publish it with `reviewlore publish-corpus --force`, or delete it."));
    } else {
      const label = (o, r, h) => `${o}/${r}${!h || h === "github.com" ? "" : ` on ${h}`}`;
      const corpusRepo = label(info.meta.owner, info.meta.repo, info.meta.host);
      const repoName = detected?.supported ? label(detected.owner, detected.repo, detected.host) : null;
      if (repoName && corpusRepo.toLowerCase() !== repoName.toLowerCase()) { // names are case-insensitive
        checks.push(check("corpus", false, false, `${info.path} holds ${corpusRepo}, not ${repoName}`,
          "Re-publish it from this repository with `reviewlore publish-corpus --force`."));
      } else {
        corpusUsable = true;
        checks.push(check("corpus", true, false,
          `${info.totals.total ?? "?"} comments, ${Math.round(info.ageDays)} days old (no token needed)`));
      }
    }
  }

  const octokitOk = resolve("@octokit/rest");
  // GitLab is fetched with Node's own fetch: no Octokit needed.
  checks.push(check(
    "deps.octokit", octokitOk, !corpusUsable && detected?.provider !== "gitlab",
    octokitOk ? "@octokit/rest installed" : "@octokit/rest is not installed (needed to fetch from GitHub)",
    depsFix(root),
  ));
  const mcpOk = resolve("@modelcontextprotocol/sdk/server/index.js");
  checks.push(check(
    "deps.mcp", mcpOk, false,
    mcpOk ? "@modelcontextprotocol/sdk installed" : "@modelcontextprotocol/sdk is not installed (needed by the MCP server)",
    depsFix(root),
  ));

  return { ok: checks.every((c) => c.ok || !c.required), checks };
}

export function renderDoctor(report) {
  const lines = ["reviewlore doctor"];
  for (const c of report.checks) {
    const status = c.ok ? "ok  " : c.required ? "FAIL" : "warn";
    lines.push(`  ${status}  ${c.id.padEnd(13)} ${c.message}`);
    if (c.fix) lines.push(`        ${"".padEnd(13)} fix: ${c.fix}`);
  }
  lines.push(report.ok ? "Ready." : "Not ready: fix the FAIL lines above.");
  return `${lines.join("\n")}\n`;
}
