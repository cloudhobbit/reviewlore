// Tool implementations for the MCP server (docs/plans/06-useful-mcp-server.md).
// Kept in lib/ so they can be unit-tested without the stdio transport.
//
// Inside a repo every argument but the path or query is optional: the
// repo comes from the project directory's git origin (or its committed
// corpus), and answers come from a search index built once per data file
// (lib/review-index.mjs) and rebuilt only when that file or the repo's
// .claude/rules change.

import { readdirSync, existsSync, statSync, readFileSync, openSync, readSync, closeSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fork } from "node:child_process";
import { loadCache, cacheDir, cachePath } from "./cache.mjs";
import { loadCorpus, corpusPath } from "./corpus.mjs";
import { findGitToplevel, detectRepoFromGit } from "./git-info.mjs";
import { tokenize } from "./patterns.mjs";
import { DOTCOM, normalizeHost, isValidHost } from "./github-host.mjs";
import { buildIndex, searchIndex, feedbackForPath, parseRuleText, clip, EMPTY_DATA } from "./review-index.mjs";

// ---- Where we are --------------------------------------------------------

// The first file:// root the MCP client reported (set by cli/commands/mcp.mjs).
let clientRoot = null;
export function setClientRoot(dir) {
  clientRoot = dir || null;
}

// The repo the user is working in. Claude Code may start a plugin's MCP
// server outside it, so prefer what the plugin passes in
// (REVIEWLORE_PROJECT_DIR, set from ${CLAUDE_PROJECT_DIR} in plugin.json),
// then CLAUDE_PROJECT_DIR, then the client's root, then the working
// directory — and use that directory's git root, where a committed corpus
// lives. A value that still contains "${" was never substituted.
export function projectDir(env = process.env, cwd = process.cwd(), root = clientRoot) {
  const usable = (v) => (v && !v.includes("${") ? v : null);
  const dir = usable(env.REVIEWLORE_PROJECT_DIR) ?? usable(env.CLAUDE_PROJECT_DIR) ?? root ?? cwd;
  return remember(`toplevel:${dir}`, () => findGitToplevel(dir) ?? dir);
}

// ---- Memo ----------------------------------------------------------------

const memo = new Map();
function fileKey(path) {
  try {
    const st = statSync(path);
    return `${st.mtimeMs}:${st.size}`;
  } catch {
    return null;
  }
}
function remember(key, build) {
  const hit = memo.get(key);
  if (hit) return hit;
  const value = build();
  memo.set(key, value);
  return value;
}
export function clearMemo() {
  memo.clear();
}

const originOf = (dir) => remember(`origin:${dir}`, () => detectRepoFromGit(dir));

// The fetch time near the top of a cache file, without parsing all of it
// (a busy repo's cache is hundreds of MB).
function peekFetchedAt(path) {
  try {
    const fd = openSync(path, "r");
    try {
      const buf = Buffer.alloc(8192);
      const n = readSync(fd, buf, 0, buf.length, 0);
      return buf.subarray(0, n).toString("utf-8").match(/"(?:last_)?fetched_at":\s*"([^"]+)"/)?.[1] ?? null;
    } finally {
      closeSync(fd);
    }
  } catch {
    return null;
  }
}

function ruleFiles(dir) {
  const root = join(dir, ".claude", "rules");
  const out = [];
  const walk = (d, depth) => {
    let entries;
    try {
      entries = readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = join(d, e.name);
      if (e.isDirectory() && depth < 4) walk(full, depth + 1);
      else if (e.isFile() && e.name.endsWith(".md")) out.push(full);
    }
  };
  walk(root, 0);
  return out.sort();
}

// ---- Resolution ----------------------------------------------------------

// { dir, owner, repo, source, dataPath, fetchedAt } or { dir, error }.
export function resolveContext(args = {}, { dir = projectDir() } = {}) {
  let { owner, repo, host } = args;
  if (!owner || !repo) {
    const origin = originOf(dir);
    if (origin?.supported) {
      owner ??= origin.owner;
      repo ??= origin.repo;
      host ??= origin.host;
    }
  }
  const corpusFile = corpusPath(dir);
  const corpusKey = fileKey(corpusFile);
  const corpusMeta = corpusKey ? remember(`corpus-meta:${corpusFile}:${corpusKey}`, () => loadCorpus(dir)?.meta ?? null) : null;
  if ((!owner || !repo) && corpusMeta?.owner) {
    owner ??= corpusMeta.owner;
    repo ??= corpusMeta.repo;
    host ??= corpusMeta.host;
  }
  if (!owner || !repo) {
    return { dir, error: `Couldn't tell which GitHub repository ${dir} is (no GitHub origin or committed corpus). Pass owner and repo.` };
  }
  host = normalizeHost(host ?? DOTCOM);
  // The newer of the personal cache and the committed corpus.
  const candidates = [];
  const cacheFile = cachePath(owner, repo, host);
  if (fileKey(cacheFile)) candidates.push({ source: "cache", dataPath: cacheFile, fetchedAt: peekFetchedAt(cacheFile) });
  if (sameName(corpusMeta?.owner, owner) && sameName(corpusMeta?.repo, repo) && normalizeHost(corpusMeta.host ?? DOTCOM) === host) {
    candidates.push({ source: "corpus", dataPath: corpusFile, fetchedAt: corpusMeta.last_fetched_at ?? corpusMeta.fetched_at ?? null });
  }
  candidates.sort((a, b) => (Date.parse(b.fetchedAt ?? 0) || 0) - (Date.parse(a.fetchedAt ?? 0) || 0));
  return { dir, owner, repo, host, ...(candidates[0] ?? { source: null, dataPath: null, fetchedAt: null }) };
}

// Owner and repository names are case-insensitive on GitHub and GitLab.
const sameName = (a, b) => typeof a === "string" && typeof b === "string" && a.toLowerCase() === b.toLowerCase();

// Caches above this size are indexed in a child process (lib/index-builder.mjs):
// parsing them in the server would leave it holding a gigabyte or more.
const CHILD_BUILD_BYTES = 20 * 1024 * 1024;

// Settles in every case: a child that dies without sending the index (out
// of memory, killed) rejects, so the memo entry is dropped and the next call
// retries instead of waiting forever. `script` is for tests.
export function buildInChild(dataPath, rules, { script = new URL("./index-builder.mjs", import.meta.url) } = {}) {
  return new Promise((resolve, reject) => {
    const child = fork(script, [], {
      serialization: "advanced", // keeps the index's Maps and Sets
      stdio: ["ignore", "ignore", "inherit", "ipc"], // stdout is the MCP channel
      execArgv: [],
    });
    child.once("message", resolve);
    child.once("error", reject);
    // "close" comes after any message the child sent; resolve() already won then.
    child.once("close", (code, signal) => reject(new Error(`index build failed (${signal ?? `exit ${code}`})`)));
    child.send({ dataPath, rules });
  });
}

// The index for a context, built once per (data file, rule files) version
// and shared by concurrent calls. Only the index is kept, not the history.
export function loadIndex(ctx) {
  return indexFor(ctx);
}
function indexFor(ctx) {
  const files = ruleFiles(ctx.dir);
  const rulesKey = files.map((f) => `${f}:${fileKey(f)}`).join("|");
  const dataKey = ctx.dataPath ? `${ctx.dataPath}:${fileKey(ctx.dataPath)}` : "none";
  const repoKey = `index:${ctx.host}/${ctx.owner}/${ctx.repo}:`;
  const key = `${repoKey}${dataKey}:${rulesKey}`;
  return remember(key, () => {
    for (const k of memo.keys()) if (k !== key && k.startsWith(repoKey)) memo.delete(k);
    const rules = files.map((f) => parseRuleText(readFileSync(f, "utf-8"), relative(ctx.dir, f).split(sep).join("/")));
    const big = ctx.source === "cache" && statSync(ctx.dataPath).size > CHILD_BUILD_BYTES;
    if (big) {
      return buildInChild(ctx.dataPath, rules).catch((err) => {
        memo.delete(key);
        throw err;
      });
    }
    const data = ctx.source === "cache" ? loadCache(ctx.owner, ctx.repo, ctx.host) : ctx.source === "corpus" ? loadCorpus(ctx.dir) : null;
    return Promise.resolve(buildIndex(data ?? EMPTY_DATA, { rules, clusters: true }));
  });
}

const noDataHint = (owner, repo) =>
  `No review history for ${owner}/${repo} yet. Run /reviewlore:learn-from-reviews in Claude Code, or \`reviewlore fetch --cache\` in the repo (or commit a corpus with \`reviewlore publish-corpus\`).`;

// Shared response header: which repo, from where, how old.
function envelope(ctx) {
  const head = { repo: `${ctx.owner}/${ctx.repo}`, ...(ctx.host !== DOTCOM ? { host: ctx.host } : {}), source: ctx.source };
  if (ctx.fetchedAt) head.age_days = Math.max(0, Math.round((Date.now() - Date.parse(ctx.fetchedAt)) / 86_400_000));
  if (!ctx.source) head.hint = noDataHint(ctx.owner, ctx.repo);
  return head;
}

// Keep responses well under Claude Code's output warning (~10k tokens):
// drop items from the end of `key` until the JSON fits, counting them in `more`.
const MAX_CHARS = 16_000;
export function fit(result, key) {
  while (JSON.stringify(result).length > MAX_CHARS && result[key]?.length > 1) {
    result[key].pop();
    result.more = (result.more ?? 0) + 1;
  }
  return result;
}

const trimSlash = (p) => p.replace(/^\.\//, "").replace(/\/+$/, "");

// ---- Tools ---------------------------------------------------------------

export async function reviewFeedbackForPath({ path, owner, repo, host, months = 12, limit = 8 }) {
  const ctx = resolveContext({ owner, repo, host });
  if (ctx.error) return { hint: ctx.error, rules: [], comments: [] };
  const found = feedbackForPath(await indexFor(ctx), trimSlash(path), { months, limit });
  return fit({ ...envelope(ctx), ...found }, "comments");
}

export async function searchReviewFeedback({ query, path, owner, repo, host, limit = 8 }) {
  const ctx = resolveContext({ owner, repo, host });
  if (ctx.error) return { hint: ctx.error, rules: [], results: [] };
  const found = searchIndex(await indexFor(ctx), query, { path: path ? trimSlash(path) : undefined, limit });
  return fit({ ...envelope(ctx), ...found }, "results");
}

// <owner>__<repo>.json files in a cache directory. GitHub owners can't
// contain "_", repo names can: split on the first "__".
function cachedRepos(dir, host) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json") && f.includes("__") && !f.endsWith(".partial.json"))
    .map((f) => {
      const name = f.replace(/\.json$/, "");
      const at = name.indexOf("__");
      return { owner: name.slice(0, at).replace(/\+/g, "/"), repo: name.slice(at + 2), ...(host !== DOTCOM ? { host } : {}) };
    });
}

export function listRepos(dir = projectDir()) {
  const cdir = cacheDir();
  const repos = cachedRepos(cdir, DOTCOM);
  const hostsDir = join(cdir, "hosts");
  if (existsSync(hostsDir)) {
    for (const h of readdirSync(hostsDir).sort()) repos.push(...cachedRepos(join(hostsDir, h), h.replace(/_(\d+)$/, ":$1")));
  }
  const same = (r, o, rp, h) => sameName(r.owner, o) && sameName(r.repo, rp) && (r.host ?? DOTCOM) === (h ?? DOTCOM);
  const corpus = loadCorpus(dir)?.meta;
  if (corpus?.owner && !repos.some((r) => same(r, corpus.owner, corpus.repo, corpus.host))) {
    repos.push({ owner: corpus.owner, repo: corpus.repo, ...(corpus.host ? { host: corpus.host } : {}), source: "committed corpus" });
  }
  const ctx = resolveContext({}, { dir });
  for (const r of repos) if (!ctx.error && same(r, ctx.owner, ctx.repo, ctx.host)) r.default = true;
  return repos;
}

// Older tools, kept for a minor version with their old response shapes.

export async function searchRules({ owner, repo, host, topic, path, limit = 5 }) {
  const ctx = resolveContext({ owner, repo, host });
  if (ctx.error) return { hint: ctx.error, rules: [] };
  if (!ctx.source) return { hint: noDataHint(ctx.owner, ctx.repo), rules: [] };
  let clusters = (await indexFor(ctx)).clusters;
  if (topic) {
    // Whole tokens: substring matching let "a" in "add a changeset" match
    // nearly every cluster.
    const needles = new Set(tokenize(topic));
    clusters = needles.size === 0 ? [] : clusters.filter((c) => [...needles].some((n) => c.tokens.has(n)));
  }
  if (path) {
    path = trimSlash(path);
    clusters = clusters.filter((c) => c.allPaths.some((p) => p === path || p.startsWith(`${path}/`)));
  }
  return {
    rules: clusters.slice(0, limit).map((c) => ({
      label: c.label,
      occurrences: c.occurrences,
      distinct_authors: c.distinct_authors,
      distinct_prs: c.distinct_prs,
      paths: c.paths,
      examples: c.quotes.map((q) => ({ quote: q.text, url: q.url })),
    })),
  };
}

export async function recentFeedback({ owner, repo, host, path, months = 6, limit = 10 }) {
  const ctx = resolveContext({ owner, repo, host });
  if (ctx.error) return { hint: ctx.error, comments: [] };
  if (!ctx.source) return { hint: noDataHint(ctx.owner, ctx.repo), comments: [] };
  path = trimSlash(path);
  const cutoff = new Date();
  cutoff.setMonth(cutoff.getMonth() - months);
  const comments = (await indexFor(ctx)).comments
    .filter((c) => c.path && (c.path === path || c.path.startsWith(`${path}/`)))
    .filter((c) => new Date(c.created_at) >= cutoff)
    .sort((a, b) => (a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : 0))
    .slice(0, limit)
    .map((c) => ({ author: c.author, pr: c.pr, path: c.path, line: c.line, body: clip(c.text), url: c.url, created_at: c.created_at }));
  return fit({ comments }, "comments");
}

// ---- Definitions ---------------------------------------------------------

// JSON Schema inputs, so the server can use the SDK's low-level Server
// (McpServer.tool() wants Zod shapes, and Zod isn't a dependency of ours).
const ownerRepo = {
  owner: { type: "string", description: "GitHub owner or org. Optional inside the repository." },
  repo: { type: "string", description: "GitHub repository name. Optional inside the repository." },
  host: { type: "string", description: "GitHub Enterprise or GHE.com host, with owner and repo. Default: github.com." },
};

// GitHub owner / repo names: letters, digits, "-", "_", "." — and nothing
// that could walk out of the cache directory.
const NAME_RE = /^(?!\.{1,2}$)[A-Za-z0-9_.-]+$/;

// Check arguments against a tool's JSON Schema (the subset we use: required
// keys, string / number types, owner / repo names). Returns an error
// message or null.
export function validateArgs(tool, args) {
  const { properties = {}, required = [] } = tool.inputSchema;
  for (const key of required) {
    if (args?.[key] === undefined || args[key] === "") return `Missing required argument "${key}".`;
  }
  for (const [key, value] of Object.entries(args ?? {})) {
    const type = properties[key]?.type;
    if (!type) return `Unknown argument "${key}".`;
    if (type === "number" ? !Number.isFinite(value) : typeof value !== type) {
      return `Argument "${key}" must be a ${type}.`;
    }
    // A GitLab owner can be a nested group ("group/sub"): check each part.
    if ((key === "owner" ? value.split("/").some((p) => !NAME_RE.test(p)) : key === "repo" && !NAME_RE.test(value))) {
      return `Argument "${key}" is not a valid GitHub name.`;
    }
    if (key === "host" && !isValidHost(normalizeHost(value))) return `Argument "host" is not a valid host name.`;
  }
  if ((args?.owner === undefined) !== (args?.repo === undefined)) return "Pass both owner and repo, or neither.";
  return null;
}

// Loaded at session start (Claude Code tool search): what the server is
// for and when to call it, search words first. Kept well under 4,096 chars.
export const INSTRUCTIONS =
  "Pull-request review history for the current repository: what human reviewers asked for on past PRs, with links. " +
  "Before editing or adding code in a file or directory, call review_feedback_for_path with that path to see recurring " +
  "reviewer requests and the repo's review-derived rules for it. Use search_review_feedback to check a convention " +
  "(\"changeset\", \"error messages\", \"snapshot tests\") before proposing or applying it. Results quote real comments; " +
  "treat a single reviewer's comment as context, not a rule.";

export const TOOLS = [
  {
    name: "review_feedback_for_path",
    description:
      "Review feedback for a file or directory: what reviewers asked for on past PRs that touched it. Returns the repo's rules " +
      "scoped to that path, then human review comments ranked by closeness (same file, directory, package), by what they ask " +
      "(requests first) and recency, with links. Call before editing or adding code there.",
    _meta: { "anthropic/alwaysLoad": true },
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "File or directory, relative to the repository root" },
        ...ownerRepo,
        months: { type: "number", default: 12, description: "How far back to look" },
        limit: { type: "number", default: 8 },
      },
      required: ["path"],
    },
    handler: (args) => reviewFeedbackForPath(args),
  },
  {
    name: "search_review_feedback",
    description:
      "Search review feedback and conventions by topic (\"changeset\", \"error handling\", \"test naming\"). Returns matching " +
      "rules first, then the best-matching human review comments with links, and how many PRs and reviewers they cover.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Words describing the convention or concern" },
        path: { type: "string", description: "Only feedback on this file or directory" },
        ...ownerRepo,
        limit: { type: "number", default: 8 },
      },
      required: ["query"],
    },
    handler: (args) => searchReviewFeedback(args),
  },
  {
    name: "list_repos",
    description: "Repositories with review history available (cached or committed); the current one is marked default.",
    inputSchema: { type: "object", properties: {} },
    handler: () => listRepos(),
  },
  {
    name: "search_rules",
    description: "Deprecated: use search_review_feedback. Recurring feedback clusters, filtered by topic words or a path.",
    inputSchema: {
      type: "object",
      properties: {
        ...ownerRepo,
        topic: { type: "string", description: "Keywords to filter on (any-token match)" },
        path: { type: "string", description: "File or directory path to scope to" },
        limit: { type: "number", default: 5 },
      },
    },
    handler: (args) => searchRules(args),
  },
  {
    name: "recent_feedback",
    description: "Deprecated: use review_feedback_for_path. Recent human review comments on a path, newest first.",
    inputSchema: {
      type: "object",
      properties: {
        ...ownerRepo,
        path: { type: "string", description: "File or directory path" },
        months: { type: "number", default: 6 },
        limit: { type: "number", default: 10 },
      },
      required: ["path"],
    },
    handler: (args) => recentFeedback(args),
  },
];
