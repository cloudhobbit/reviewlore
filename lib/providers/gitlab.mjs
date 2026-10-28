// GitLab (gitlab.com and self-managed): merge-request review history in
// the corpus shape the rest of reviewlore reads (docs/plans/14-other-code-hosts.md).
//
// REST v4 with Node's fetch — no new dependency. Per merge request updated
// in the window, its discussions:
//   - standalone notes (individual_note, no position)  → issue_comments
//   - notes on code, or in a thread                     → review_comments
//     (path/line from `position`; later notes in a thread reply to the first)
//   - system notes ("added 1 commit", "approved")       → dropped
// GitLab has no review bodies or "changes requested" state, so
// review_submissions stays empty; approvals aren't fetched (they'd only
// add weight to nothing).
//
// Tokens: --token, GITLAB_TOKEN, GITLAB_ACCESS_TOKEN (scope read_api), sent
// as `Authorization: Bearer`, which fetch drops on a redirect to another
// host (a custom PRIVATE-TOKEN header would follow it). The environment
// tokens only go to gitlab.com, the host named in GITLAB_HOST (glab's
// variable), or the instance a GitLab CI job runs on — never to whatever
// GitLab-looking host a checkout's origin names. Never read from glab's or
// any other credential store.

import { isWithinRange } from "../filters.mjs";
import { retryDecision } from "../rate-limit.mjs";
import { createProgress } from "../progress.mjs";
import { buildOutput } from "../output.mjs";
import { normalizeHost } from "../github-host.mjs";

const PER_PAGE = 100;

export const gitlabApiUrl = (host) => `https://${host}/api/v4`;

const GITLAB_COM = "gitlab.com";
const bareHost = (value) => normalizeHost(String(value ?? "").replace(/^[a-z]+:\/\//i, "").replace(/\/.*$/, ""));

// Hosts the environment's GitLab tokens may be sent to.
function envTokenHosts(env) {
  const hosts = new Set([GITLAB_COM]);
  if (env.GITLAB_HOST) hosts.add(bareHost(env.GITLAB_HOST));
  if (env.GITLAB_CI === "true" && env.CI_SERVER_HOST) hosts.add(bareHost(env.CI_SERVER_HOST));
  return hosts;
}

export function resolveGitLabToken({ token, host = GITLAB_COM, env = process.env } = {}) {
  if (token) return { token, source: "flag" };
  if (!envTokenHosts(env).has(normalizeHost(host))) return null;
  if (env.GITLAB_TOKEN) return { token: env.GITLAB_TOKEN, source: "GITLAB_TOKEN" };
  if (env.GITLAB_ACCESS_TOKEN) return { token: env.GITLAB_ACCESS_TOKEN, source: "GITLAB_ACCESS_TOKEN" };
  return null;
}

export const noGitLabTokenMessage = (host) =>
  (normalizeHost(host) === GITLAB_COM
    ? `No token for ${host}. Set GITLAB_TOKEN to a personal access token with the read_api scope, or pass --token. `
    : `No token for ${host}. Set GITLAB_TOKEN to a personal access token with the read_api scope and GITLAB_HOST=${host} ` +
      "(GITLAB_TOKEN alone is only sent to gitlab.com), or pass --token. ") +
  "GitLab needs one even for a public project: it doesn't serve merge-request comments anonymously.";

// A transport: getPage(path, query) → { data, next } where `next` is the
// next page number or null. Retries 429/5xx like the GitHub client.
export function createGitLabTransport({ host, token, baseUrl = gitlabApiUrl(host), fetchImpl = globalThis.fetch, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), stats = { requests: 0 }, onWait } = {}) {
  const getPage = async (path, query = {}) => {
    const url = new URL(`${baseUrl}${path}`);
    for (const [k, v] of Object.entries(query)) if (v != null) url.searchParams.set(k, String(v));
    for (let attempt = 0; ; attempt++) {
      stats.requests++;
      let res;
      try {
        res = await fetchImpl(url, { headers: { Authorization: `Bearer ${token}`, Accept: "application/json", "User-Agent": "reviewlore" } });
      } catch (err) {
        throw Object.assign(new Error(`fetch failed: ${err.message}`), { cause: err });
      }
      if (res.ok) {
        const next = res.headers.get("x-next-page");
        return { data: await res.json(), next: next ? Number(next) : null };
      }
      const headers = Object.fromEntries(res.headers.entries());
      // Only the status and GitLab's own message: never the request or its headers.
      let message = `${res.status}`;
      try {
        const body = await res.json();
        message = String(body.message ?? body.error ?? message);
      } catch { /* not JSON */ }
      const err = Object.assign(new Error(message), { status: res.status, response: { headers } });
      const d = retryDecision(err, attempt, {});
      if (!d.retry) throw d.error ?? err;
      onWait?.({ waitMs: d.waitMs, reason: d.reason });
      await sleep(d.waitMs);
    }
  };
  return { getPage, stats };
}

const BOT_RE = /^(project|group)_\d+_bot(_[0-9a-f]+)?$|\[bot\]$|^(gitlab-bot|renovate-bot|dependabot|ghost)$/i;

function user(author) {
  const login = author?.username ?? "unknown";
  return { author: login, author_type: author?.bot || BOT_RE.test(login) ? "Bot" : "User" };
}

async function allPages(transport, path, query, onPage) {
  const out = [];
  let page = 1;
  while (page) {
    const { data, next } = await transport.getPage(path, { ...query, per_page: PER_PAGE, page });
    out.push(...data);
    onPage?.(data);
    page = next;
  }
  return out;
}

// Merge requests updated since `since`, newest first.
async function mergeRequests(transport, project, since) {
  return allPages(transport, `/projects/${project}/merge_requests`, {
    state: "all", order_by: "updated_at", sort: "desc", updated_after: since.toISOString(),
  });
}

// One MR's discussions → corpus records.
export function mapDiscussions(mr, discussions, since) {
  const issue = [];
  const review = [];
  for (const d of discussions) {
    const notes = (d.notes ?? []).filter((n) => !n.system);
    if (!notes.length) continue;
    const rootId = notes[0].id;
    const threaded = !d.individual_note || notes.length > 1;
    for (const [i, n] of notes.entries()) {
      if (!isWithinRange(n.created_at, since)) continue;
      const base = {
        comment_id: n.id,
        pr_number: mr.iid,
        ...user(n.author),
        body: n.body,
        created_at: n.created_at,
        updated_at: n.updated_at ?? n.created_at,
        html_url: `${mr.web_url}#note_${n.id}`,
      };
      const position = n.position ?? (i > 0 ? notes[0].position : null);
      if (!threaded && !position) {
        issue.push({ type: "issue_comment", ...base });
      } else {
        review.push({
          type: "review_comment",
          ...base,
          path: position?.new_path ?? position?.old_path ?? null,
          line: position?.new_line ?? position?.old_line ?? null,
          in_reply_to_id: i > 0 ? rootId : null,
          ...(typeof n.resolved === "boolean" ? { resolved: n.resolved } : {}),
        });
      }
    }
  }
  return { issue, review };
}

// → { issueComments, reviewComments, reviewSubmissions, prAuthors }, the
// arrays buildOutput takes. `project` is the URL-encoded path.
// `keepSince` (the window start) decides which notes to keep; `since`, which
// MRs to list (updated since) — they differ on an incremental fetch.
export async function fetchGitLab(transport, { repoPath, since, keepSince = since, onProgress, concurrency = 4 }) {
  const project = encodeURIComponent(repoPath);
  const mrs = (await mergeRequests(transport, project, since)).filter((mr) => isWithinRange(mr.updated_at, since));
  onProgress?.({ stream: "comments", count: 0, fraction: 1 });
  onProgress?.({ stream: "inline", count: 0, fraction: 1 });
  const prAuthors = {};
  for (const mr of mrs) prAuthors[mr.iid] = mr.author?.username ?? "unknown";

  const issueComments = [];
  const reviewComments = [];
  let next = 0;
  let done = 0;
  let failed = null;
  const worker = async () => {
    while (next < mrs.length && !failed) {
      const mr = mrs[next++];
      try {
        const discussions = await allPages(transport, `/projects/${project}/merge_requests/${mr.iid}/discussions`, {});
        const { issue, review } = mapDiscussions(mr, discussions, keepSince);
        issueComments.push(...issue);
        reviewComments.push(...review);
      } catch (err) {
        failed ??= err;
        return;
      }
      done++;
      onProgress?.({ stream: "reviews", count: done, fraction: mrs.length ? done / mrs.length : 1 });
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, mrs.length) }, worker));
  if (failed) throw failed;
  onProgress?.({ stream: "reviews", count: done, fraction: 1 });
  return { issueComments, reviewComments, reviewSubmissions: [], prAuthors };
}

// Fetch and shape a GitLab project's review history, like fetchCorpus does
// for GitHub (progress on `out`, corpus shape from lib/output.mjs). No
// resume yet: a GitLab fetch runs in one go.
export async function fetchGitLabCorpus(transport, { owner, repo, host, since, keepSince = since, monthsBack, out, now = () => Date.now() }) {
  // The next incremental fetch starts from here: notes written while this
  // one runs must fall after it, as in fetchCorpus.
  const startedAt = new Date(now()).toISOString();
  const progress = createProgress({ out, now, stats: transport.stats });
  const data = await fetchGitLab(transport, {
    repoPath: `${owner}/${repo}`, since, keepSince,
    onProgress: (e) => progress.update(e),
  });
  progress.finish();
  const output = buildOutput({ owner, repo, host, since, monthsBack, ...data });
  output.meta.provider = "gitlab";
  output.meta.fetched_at = startedAt;
  return output;
}
