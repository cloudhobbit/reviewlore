import { isWithinRange, isPlainIssueComment } from "./filters.mjs";
import { RateLimitError, installRetry } from "./rate-limit.mjs";
import { createProgress, formatDuration } from "./progress.mjs";
import { buildOutput } from "./output.mjs";
import { loadPartial, savePartial, deletePartial, PARTIAL_VERSION } from "./cache.mjs";

// Progress is reported through callbacks, never printed here: `cli/`
// decides how to show it (lib/progress.mjs). Each stream reports
// `{ stream, count, fraction }` per page, where `fraction` is how much of
// the [since, now] window it has covered.

export function windowFraction(iso, since, now = Date.now(), { descending = false } = {}) {
  const t = Date.parse(iso);
  const span = now - since.getTime();
  if (!Number.isFinite(t) || span <= 0) return 0;
  const f = descending ? (now - t) / span : (t - since.getTime()) / span;
  return Math.min(1, Math.max(0, f));
}

// Thrown by a stream when `shouldStop()` says the time budget is spent.
// Its state is complete up to the last page, so the fetch can resume.
export class FetchInterrupted extends Error {
  constructor() {
    super("Fetch stopped early (time budget).");
    this.name = "FetchInterrupted";
  }
}

// Resume state per stream. Records are stored already shaped, so a
// checkpoint holds what the corpus will hold.
export function emptyStreams() {
  return {
    comments: { done: false, slices: null, items: [] },
    inline: { done: false, slices: null, items: [] },
    reviews: { done: false, after: null, listed: false, list: [], reviewed: [], prs: 0, items: [], prAuthors: {} },
  };
}

const PER_PAGE = 100;
const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_SLICES = 24;
export const DEFAULT_CONCURRENCY = 6;

// REVIEWLORE_FETCH_CONCURRENCY=1 reads each comment listing in one go, as
// before time slices.
export function fetchConcurrency(env = process.env) {
  const n = Number(env.REVIEWLORE_FETCH_CONCURRENCY);
  return Number.isInteger(n) && n >= 1 ? Math.min(n, 20) : DEFAULT_CONCURRENCY;
}

const hasNextPage = (response) => /rel="next"/.test(response.headers?.link ?? "");

// A small promise pool shared by both comment streams, so together they
// never run more than `size` listings at once. Higher priority first.
export function createPool(size) {
  let active = 0;
  const queue = [];
  const next = () => {
    while (active < size && queue.length) {
      const job = queue.shift();
      active++;
      job.fn().then(job.resolve, job.reject).finally(() => {
        active--;
        next();
      });
    }
  };
  return {
    run(fn, priority = 0) {
      return new Promise((resolve, reject) => {
        const i = queue.findIndex((j) => j.priority < priority);
        queue.splice(i === -1 ? queue.length : i, 0, { fn, priority, resolve, reject });
        next();
      });
    },
  };
}

// Split [since, now] into time slices of about a week (at most 24) that
// separate listings can read in parallel. The last one is open-ended.
export function makeSlices(since, now, { concurrency = DEFAULT_CONCURRENCY } = {}) {
  const span = now - since.getTime();
  const n = concurrency <= 1 ? 1 : Math.max(1, Math.min(MAX_SLICES, Math.ceil(span / (7 * DAY_MS))));
  return Array.from({ length: n }, (_, k) => ({
    from: new Date(since.getTime() + (span * k) / n).toISOString(),
    to: k === n - 1 ? null : new Date(since.getTime() + (span * (k + 1)) / n).toISOString(),
    through: null,
    done: false,
  }));
}

// Both comment streams are listed oldest-update first (`since` filters on
// updated_at). That allows two things:
//
// - Time slices: a listing started at a slice's `from` stops at the first
//   comment updated at or after its `to`, so slices read in parallel
//   return exactly what one long listing would.
// - Resume: `through`, the last update time seen in a slice, is a valid
//   place to continue. Comments on that boundary come back twice and are
//   skipped by id.
//
// GitHub also stops paginating long listings after a few hundred pages
// (pnpm's issue comments ended mid-September with no error), so a slice
// whose listing ends before reaching `to` is continued from `through`; it
// is done when a listing brings nothing newer.
async function listAscending(octokit, method, params, { stream, since, onProgress, state, keep, shape, onPage, shouldStop, pool, now = Date.now() }) {
  const windowMs = Math.max(1, now - since.getTime());
  if (!state.done) state.slices ??= makeSlices(since, now);
  const covered = () => {
    if (state.done) return 1;
    let ms = 0;
    for (const sl of state.slices) {
      const end = sl.to ? Date.parse(sl.to) : now;
      if (sl.done) ms += end - Date.parse(sl.from);
      else if (sl.through) ms += Math.min(end, Date.parse(sl.through)) - Date.parse(sl.from);
    }
    return Math.min(1, Math.max(0, ms / windowMs));
  };
  const report = () => onProgress?.({ stream, count: state.items.length, fraction: covered() });
  if (state.done) {
    report();
    return state.items;
  }

  const seen = new Set(state.items.map((i) => i.comment_id));
  const add = (c) => {
    if (seen.has(c.id) || !keep(c)) return;
    seen.add(c.id);
    state.items.push(shape(c));
  };
  let failed = null;

  const runSlice = async (slice) => {
    const fromMs = Date.parse(slice.from);
    const toMs = slice.to ? Date.parse(slice.to) : Infinity;
    for (;;) {
      const start = slice.through ?? slice.from;
      let advanced = false;
      let reachedEnd = false;
      for await (const response of octokit.paginate.iterator(method, {
        ...params, since: new Date(start).toISOString(), sort: "updated", direction: "asc", per_page: PER_PAGE,
      })) {
        let lastSeen = null;
        for (const c of response.data) {
          const t = Date.parse(c.updated_at);
          if (t >= toMs) {
            reachedEnd = true;
            break;
          }
          if (t < fromMs) continue;
          add(c);
          lastSeen = c.updated_at;
        }
        const moved = lastSeen !== null && Date.parse(lastSeen) > Date.parse(start);
        if (moved) slice.through = lastSeen;
        advanced ||= moved;
        report();
        if (reachedEnd) break;
        // Another slice failed: keep this page, fetch no more.
        if (failed) throw new FetchInterrupted();
        // Stop only after a page that moved forward, so every run makes
        // progress and a resume never re-fetches the same page forever.
        if (moved && hasNextPage(response)) {
          onPage?.();
          if (shouldStop?.()) throw new FetchInterrupted();
        }
      }
      if (reachedEnd || !advanced) break;
    }
    slice.done = true;
    report();
    onPage?.();
  };

  // Newest slices first: that's where busy repos are busiest.
  const pending = state.slices.filter((sl) => !sl.done);
  const results = await Promise.allSettled(pending.map((slice) => (pool ?? createPool(1)).run(async () => {
    if (failed) throw new FetchInterrupted();
    try {
      await runSlice(slice);
    } catch (err) {
      failed ??= err;
      throw err;
    }
  }, Date.parse(slice.from))));
  const error = results.find((r) => r.status === "rejected" && !(r.reason instanceof FetchInterrupted)) ??
    results.find((r) => r.status === "rejected");
  if (error) throw error.reason;
  state.done = true;
  report();
  onPage?.();
  return state.items;
}

// `since` is the cutoff for what to list (updated since); `keepSince`, the
// start of the window, decides what to keep (created since). They differ on
// an incremental fetch, which must still keep an older comment that was
// edited, or a PR first listed, after the previous fetch started.
export async function fetchIssueComments(octokit, { owner, repo, since, keepSince = since, onProgress, state = emptyStreams().comments, onPage, shouldStop, pool, now }) {
  return listAscending(octokit, octokit.rest.issues.listCommentsForRepo, { owner, repo }, {
    stream: "comments", since, onProgress, state, onPage, shouldStop, pool, now,
    keep: (c) => isWithinRange(c.created_at, keepSince) && !isPlainIssueComment(c),
    shape: (c) => ({
      type: "issue_comment",
      comment_id: c.id,
      pr_number: parseInt(c.issue_url.split("/").pop(), 10),
      author: c.user?.login ?? "unknown",
      author_type: c.user?.type ?? "unknown",
      body: c.body,
      created_at: c.created_at,
      updated_at: c.updated_at,
      html_url: c.html_url,
    }),
  });
}

export async function fetchReviewComments(octokit, { owner, repo, since, keepSince = since, onProgress, state = emptyStreams().inline, onPage, shouldStop, pool, now }) {
  return listAscending(octokit, octokit.rest.pulls.listReviewCommentsForRepo, { owner, repo }, {
    stream: "inline", since, onProgress, state, onPage, shouldStop, pool, now,
    keep: (c) => isWithinRange(c.created_at, keepSince),
    shape: (c) => ({
      type: "review_comment",
      comment_id: c.id,
      pr_number: parseInt(c.pull_request_url.split("/").pop(), 10),
      author: c.user?.login ?? "unknown",
      author_type: c.user?.type ?? "unknown",
      body: c.body,
      path: c.path,
      line: c.line ?? c.original_line,
      diff_hunk: c.diff_hunk,
      in_reply_to_id: c.in_reply_to_id ?? null,
      // The review it was posted in, so it can carry that review's state
      // (an inline comment in a "changes requested" review counts more).
      pull_request_review_id: c.pull_request_review_id ?? null,
      created_at: c.created_at,
      updated_at: c.updated_at,
      html_url: c.html_url,
    }),
  });
}

// ---- Review submissions ------------------------------------------------
//
// GraphQL (docs/plans/03 and 17, and the GraphQL section of
// .claude/rules/octokit-pagination.md), against one REST request per PR.
// Two steps, so the slow part runs in parallel:
//   1. list the PRs updated in the window, 100 per query, newest first
//      (number, title, author — light pages, read in order);
//   2. fetch their reviews in batches of 25 PRs per query (aliased
//      `pullRequest(number:)` lookups), several batches at once.
// Each batch costs 1 point (25 nested connections round up to 1), so pnpm's
// ~4,200 PRs cost about 40 + 170 points.
const PR_LIST_PAGE = 100;
const REVIEW_BATCH = 25;
const REVIEW_PAGE = 50;
const REVIEW_CONCURRENCY = 4;

const reviewFields = (idField) => `${idField} url state body submittedAt author { login __typename }`;

const prListQuery = `query($owner: String!, $repo: String!, $after: String) {
  repository(owner: $owner, name: $repo) {
    pullRequests(first: ${PR_LIST_PAGE}, after: $after, orderBy: { field: UPDATED_AT, direction: DESC }) {
      pageInfo { hasNextPage endCursor }
      nodes { number title updatedAt author { login __typename } }
    }
  }
  rateLimit { cost remaining resetAt }
}`;

// PR numbers are integers from GitHub, so inlining them is safe.
const reviewBatchQuery = (numbers, idField) => `query($owner: String!, $repo: String!) {
  repository(owner: $owner, name: $repo) {
${numbers.map((n, i) => `    p${i}: pullRequest(number: ${Number(n)}) { number reviews(first: ${REVIEW_PAGE}) { pageInfo { hasNextPage endCursor } nodes { ${reviewFields(idField)} } } }`).join("\n")}
  }
}`;

const moreReviewsQuery = (idField) => `query($owner: String!, $repo: String!, $number: Int!, $after: String) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $number) {
      reviews(first: 100, after: $after) { pageInfo { hasNextPage endCursor } nodes { ${reviewFields(idField)} } }
    }
  }
}`;

// REST reports bot accounts as "name[bot]"; GraphQL's Bot.login omits the
// suffix. Match REST so author filters see the same names either way.
function graphqlLogin(author) {
  if (!author?.login) return "unknown";
  return author.__typename === "Bot" && !author.login.endsWith("[bot]") ? `${author.login}[bot]` : author.login;
}

function graphqlAuthorType(author) {
  if (!author) return "unknown";
  return author.__typename === "Bot" ? "Bot" : "User";
}

function reviewRecord(pr, r, idField) {
  return {
    type: "review_submission",
    review_id: Number(r[idField]),
    pr_number: pr.number,
    pr_title: pr.title,
    author: graphqlLogin(r.author),
    author_type: graphqlAuthorType(r.author),
    state: r.state,
    body: r.body,
    submitted_at: r.submittedAt,
    html_url: r.url,
  };
}

// Resume state: the PR list (`list`, `after`, `listed`) and the PRs whose
// reviews are stored (`reviewed`). PRs updated while a fetch is paused are
// picked up, with all their reviews in the window (`keepSince`), by the
// next incremental fetch, whose cutoff is when the first run started
// (fetchCorpus).
async function fetchReviewsGraphQLWith(octokit, { owner, repo, since, keepSince = since, onProgress, state, onPage, shouldStop }, idField) {
  const report = (fraction) => onProgress?.({ stream: "reviews", count: state.prs, fraction });
  if (state.done) {
    report(1);
    return { reviews: state.items, prAuthors: state.prAuthors };
  }
  state.list ??= [];
  state.reviewed ??= [];

  // 1. The PR list counts as the first tenth of the progress.
  while (!state.listed) {
    const page = await octokit.graphql(prListQuery, { owner, repo, after: state.after });
    const { nodes, pageInfo } = page.repository.pullRequests;
    let reachedEnd = false;
    for (const pr of nodes) {
      if (!isWithinRange(pr.updatedAt, since)) {
        reachedEnd = true;
        continue;
      }
      if (state.prAuthors[pr.number] !== undefined) continue; // repeated after a resume
      state.prAuthors[pr.number] = graphqlLogin(pr.author);
      state.list.push({ number: pr.number, title: pr.title });
    }
    const last = nodes[nodes.length - 1];
    report(0.1 * (last ? windowFraction(last.updatedAt, since, Date.now(), { descending: true }) : 1));
    if (reachedEnd || !pageInfo.hasNextPage) state.listed = true;
    else state.after = pageInfo.endCursor;
    onPage?.();
    if (!state.listed && shouldStop?.()) throw new FetchInterrupted();
  }

  // 2. Reviews, REVIEW_CONCURRENCY batches at a time.
  const done = new Set(state.reviewed);
  const titles = new Map(state.list.map((p) => [p.number, p.title]));
  const todo = state.list.map((p) => p.number).filter((n) => !done.has(n));
  const batches = [];
  for (let i = 0; i < todo.length; i += REVIEW_BATCH) batches.push(todo.slice(i, i + REVIEW_BATCH));
  const total = state.list.length || 1;
  let next = 0;
  let stop = null;
  const worker = async () => {
    while (next < batches.length && !stop) {
      const numbers = batches[next++];
      try {
        const data = await octokit.graphql(reviewBatchQuery(numbers, idField), { owner, repo });
        const records = [];
        for (let i = 0; i < numbers.length; i++) {
          const pr = data.repository[`p${i}`];
          if (!pr) continue; // deleted or inaccessible since it was listed
          const prReviews = [...pr.reviews.nodes];
          let { hasNextPage, endCursor } = pr.reviews.pageInfo;
          while (hasNextPage) {
            const more = await octokit.graphql(moreReviewsQuery(idField), { owner, repo, number: pr.number, after: endCursor });
            const conn = more.repository.pullRequest.reviews;
            prReviews.push(...conn.nodes);
            ({ hasNextPage, endCursor } = conn.pageInfo);
          }
          const meta = { number: pr.number, title: titles.get(pr.number) };
          for (const r of prReviews) {
            if (isWithinRange(r.submittedAt, keepSince)) records.push(reviewRecord(meta, r, idField));
          }
        }
        // Commit a batch only once it is complete, so a resume never skips half of it.
        state.items.push(...records);
        state.reviewed.push(...numbers);
      } catch (err) {
        stop ??= err;
        return;
      }
      state.prs = state.reviewed.length;
      report(0.1 + (0.9 * state.reviewed.length) / total);
      onPage?.();
      if (shouldStop?.()) stop ??= new FetchInterrupted();
    }
  };
  await Promise.all(Array.from({ length: Math.min(REVIEW_CONCURRENCY, batches.length) }, worker));
  if (stop) throw stop;
  state.done = true;
  report(1);
  onPage?.();
  return { reviews: state.items, prAuthors: state.prAuthors };
}

export async function fetchReviewSubmissionsGraphQL(octokit, { state = emptyStreams().reviews, ...opts }) {
  try {
    return await fetchReviewsGraphQLWith(octokit, { ...opts, state }, state.idField ?? "fullDatabaseId");
  } catch (err) {
    // Older GitHub Enterprise Server versions lack fullDatabaseId.
    if (state.idField === "databaseId" || !/fullDatabaseId/.test(err?.message ?? "")) throw err;
    state.idField = "databaseId";
    return fetchReviewsGraphQLWith(octokit, { ...opts, state }, "databaseId");
  }
}

// REST: list PRs, then one listReviews per PR, 4 at a time. Used when
// GraphQL isn't available (or REVIEWLORE_FETCH=rest). Resumable per PR:
// `state.restDone` lists the PRs already fetched.
export async function fetchReviewSubmissionsRest(octokit, { owner, repo, since, keepSince = since, onProgress, onPage, shouldStop, concurrency = 4, state = emptyStreams().reviews }) {
  if (state.done) {
    onProgress?.({ stream: "reviews", count: state.prs, fraction: 1 });
    return { reviews: state.items, prAuthors: state.prAuthors };
  }
  const prs = await octokit.paginate(
    octokit.rest.pulls.list,
    { owner, repo, state: "all", sort: "updated", direction: "desc", per_page: 100 },
    (response, done) => {
      const last = response.data[response.data.length - 1];
      if (last && !isWithinRange(last.updated_at, since)) done();
      return response.data;
    },
  );
  const prsInRange = prs.filter((pr) => isWithinRange(pr.updated_at, since));

  // pr_number → login, used downstream to drop PR authors' own comments.
  for (const pr of prsInRange) state.prAuthors[pr.number] = pr.user?.login ?? "unknown";

  const finished = new Set(state.restDone ?? []);
  state.restDone = [...finished];
  const todo = prsInRange.filter((pr) => !finished.has(pr.number));
  let next = 0;
  let stop = null; // first error, or the time budget: workers take no new PRs
  const worker = async () => {
    while (next < todo.length && !stop) {
      const pr = todo[next++];
      try {
        const reviews = await octokit.paginate(octokit.rest.pulls.listReviews, {
          owner, repo, pull_number: pr.number, per_page: 100,
        });
        state.items.push(...reviews.filter((r) => isWithinRange(r.submitted_at, keepSince)).map((r) => ({
          type: "review_submission",
          review_id: r.id,
          pr_number: pr.number,
          pr_title: pr.title,
          author: r.user?.login ?? "unknown",
          author_type: r.user?.type ?? "unknown",
          state: r.state,
          body: r.body,
          submitted_at: r.submitted_at,
          html_url: r.html_url,
        })));
        state.restDone.push(pr.number);
      } catch (err) {
        stop ??= err;
        return;
      }
      state.prs = state.restDone.length;
      onProgress?.({ stream: "reviews", count: state.prs, fraction: state.prs / prsInRange.length });
      onPage?.();
      if (shouldStop?.()) stop ??= new FetchInterrupted();
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, todo.length) }, worker));
  if (stop) throw stop;
  state.done = true;
  onProgress?.({ stream: "reviews", count: state.prs, fraction: 1 });
  onPage?.();
  return { reviews: state.items, prAuthors: state.prAuthors };
}

// GraphQL unless told otherwise or unavailable; a 403/404 from the GraphQL
// endpoint (e.g. an app token without GraphQL access) falls back to REST.
export async function fetchReviewSubmissions(octokit, { mode, onNotice, state = emptyStreams().reviews, ...opts }) {
  const rest = () => fetchReviewSubmissionsRest(octokit, { ...opts, state });
  if (mode === "rest" || typeof octokit.graphql !== "function") return rest();
  try {
    return await fetchReviewSubmissionsGraphQL(octokit, { ...opts, state });
  } catch (err) {
    if (err instanceof RateLimitError || (err?.status !== 403 && err?.status !== 404)) throw err;
    onNotice?.(`GitHub's GraphQL API isn't available to this token (HTTP ${err.status}); fetching reviews over REST instead.`);
    return rest();
  }
}

// All three streams, concurrently, each resuming from `streams` (see
// emptyStreams). Waits for every stream to settle so their states are
// consistent, then rethrows: a real error before an interruption.
export async function fetchAll(octokit, { owner, repo, since, keepSince = since, mode, onProgress, onNotice, streams = emptyStreams(), onPage, shouldStop, concurrency = DEFAULT_CONCURRENCY, now = Date.now() }) {
  const common = { owner, repo, since, keepSince, onProgress, onPage, shouldStop };
  // The comment listings share one pool of `concurrency` time slices.
  const pool = createPool(Math.max(1, concurrency));
  const sliced = { pool, now };
  if (concurrency <= 1) {
    for (const st of [streams.comments, streams.inline]) if (!st.done) st.slices ??= makeSlices(since, now, { concurrency: 1 });
  }
  const results = await Promise.allSettled([
    fetchIssueComments(octokit, { ...common, ...sliced, state: streams.comments }),
    fetchReviewComments(octokit, { ...common, ...sliced, state: streams.inline }),
    fetchReviewSubmissions(octokit, { ...common, mode, onNotice, state: streams.reviews }),
  ]);
  const failed = results.find((r) => r.status === "rejected" && !(r.reason instanceof FetchInterrupted)) ??
    results.find((r) => r.status === "rejected");
  if (failed) throw failed.reason;
  const [issueComments, reviewComments, { reviews, prAuthors }] = results.map((r) => r.value);
  return { issueComments, reviewComments, reviewSubmissions: reviews, prAuthors };
}

// Thrown by fetchCorpus when the time budget ran out; progress is saved.
export class PartialFetch extends Error {
  constructor(fraction) {
    super(`Partial: ${Math.floor(fraction * 100)}% of the window fetched; re-run the same command to continue.`);
    this.name = "PartialFetch";
    this.fraction = fraction;
  }
}

const CHECKPOINT_EVERY_MS = 5000;

// Fetch and shape a repo's review history: retries and rate limits
// (lib/rate-limit.mjs), progress on `out` (stderr from cli/), then the
// corpus shape from lib/output.mjs. Pass a fresh client: the retry hook
// is installed on it.
//
// With `checkpoint`, progress is saved to the cache directory (at most
// every 5 s, and whenever the fetch stops early or fails) and an earlier
// partial fetch of the same repo is resumed. `budgetMs` stops cleanly
// after that long with a PartialFetch error.
export async function fetchCorpus(octokit, { owner, repo, host = "github.com", since, keepSince = since, monthsBack, out, mode, checkpoint = false, budgetMs, concurrency = DEFAULT_CONCURRENCY, now = () => Date.now() }) {
  const progress = createProgress({ out, now });
  installRetry(octokit, {
    stats: progress.stats,
    onWait: ({ waitMs, reason }) => progress.notice(`GitHub ${reason}: waiting ${formatDuration(waitMs)} before retrying…`),
  });

  let partial = checkpoint ? loadPartial(owner, repo, since, now(), host) : null;
  if (partial) {
    since = new Date(partial.since);
    keepSince = new Date(partial.keep_since ?? partial.since);
    progress.notice(`Resuming the fetch started ${partial.started_at.slice(0, 16).replace("T", " ")} UTC.`);
  } else {
    partial = {
      version: PARTIAL_VERSION, owner, repo, since: since.toISOString(), keep_since: keepSince.toISOString(),
      started_at: new Date(now()).toISOString(), streams: emptyStreams(),
    };
  }
  const save = () => { if (checkpoint) savePartial(owner, repo, partial, host); };
  let lastSave = now();
  const onPage = () => {
    if (now() - lastSave >= CHECKPOINT_EVERY_MS) {
      lastSave = now();
      save();
    }
  };
  const deadline = budgetMs == null ? Infinity : now() + budgetMs;

  let data;
  try {
    data = await fetchAll(octokit, {
      owner, repo, since, keepSince, mode,
      streams: partial.streams, onPage, shouldStop: () => now() >= deadline, concurrency, now: now(),
      onProgress: (e) => progress.update(e),
      onNotice: (m) => progress.notice(m),
    });
  } catch (err) {
    save();
    if (err instanceof FetchInterrupted) {
      progress.notice(`Stopped after the time budget; progress saved.`);
      throw new PartialFetch(progress.overall());
    }
    if (checkpoint) progress.notice("Progress so far is saved; re-running resumes from here.");
    throw err;
  }
  progress.finish();
  const output = buildOutput({ owner, repo, host, since, monthsBack, ...data });
  // The next incremental fetch must cover everything since the first
  // (possibly interrupted) run started.
  output.meta.fetched_at = partial.started_at;
  if (checkpoint) deletePartial(owner, repo, host);
  return output;
}
