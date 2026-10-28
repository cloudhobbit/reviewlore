// A search index over a repo's review history, for the MCP server
// (docs/plans/06-useful-mcp-server.md). Two tiers:
//
//   - rules: the repo's .claude/rules/*.md files. The plugin's rules are
//     already paraphrase-merged and cite their sources, so they answer
//     first ("add a changeset" finds the changeset rule even though half
//     its quotes never say "changeset");
//   - comments: every human review comment, after the same filters as
//     extraction (plain issues, PR authors, resolved threads, bots, AI
//     reviews, praise), searched sentence by sentence with BM25.
//
// Pure: data and rule files come in as arguments; nothing is read here.

import { dirname } from "node:path";
import { applySignals } from "./signals.mjs";
import { isNoise, stripMarkdown, splitSentences, looksLikeAIReview } from "./normalize.mjs";
import { tokenize, classifySentence } from "./patterns.mjs";
import { extractCandidates, buildClusters, filterClusters, pickExamples } from "./extract.mjs";
import { globCoversPath, staticPrefix, globToRegExp } from "./globs.mjs";
import { pathGlobs } from "./renderers/_common.mjs";

const K1 = 1.2;
const B = 0.75;
export const QUOTE_MAX = 400;
// Requests and prohibitions are what reviewers want changed; questions
// and other remarks are context.
const KIND_RANK = { request: 0, prohibition: 0, prescription: 1, question: 2 };
const kindRank = (k) => KIND_RANK[k] ?? 3;
// Search ranks comments that ask for something a little higher: rules come
// from requests. On the gallery check (eval/search-gallery.mjs) this lifts
// rules found from 9/14 to 10/14 and is flat between 1.25 and 1.5.
const KIND_BOOST = { request: 1.25, prohibition: 1.25, prescription: 1.1, question: 0.9, other: 0.8 };

export function clip(text, max = QUOTE_MAX) {
  const t = text.replace(/\*\*|__/g, "").replace(/\s+/g, " ").trim();
  return t.length <= max ? t : `${t.slice(0, max - 1).trimEnd()}…`;
}

// Byte-order string compare, for ties: deterministic across locales.
const cmp = (a = "", b = "") => (a < b ? -1 : a > b ? 1 : 0);

// ---- BM25 ----------------------------------------------------------------

function bm25(docs) {
  const postings = new Map();
  let total = 0;
  docs.forEach((tokens, d) => {
    total += tokens.length;
    const tf = new Map();
    for (const t of tokens) tf.set(t, (tf.get(t) ?? 0) + 1);
    for (const [t, n] of tf) {
      if (!postings.has(t)) postings.set(t, []);
      postings.get(t).push([d, n]);
    }
  });
  return {
    postings,
    vocab: [...postings.keys()].sort(), // for prefix lookups
    lengths: docs.map((d) => d.length),
    avgdl: total / Math.max(1, docs.length),
    n: docs.length,
  };
}

// Query words of 5+ letters also match vocabulary sharing their stem (a
// common suffix removed, at least 5 letters kept): "validation" finds
// "validate" and "validator", "deprecate" finds "deprecated", while
// "changeset" stays "changeset" rather than matching every "change".
const SUFFIX = /(?:ations?|ions?|ings?|ers?|ors?|ed|es|e|s)$/;
function expand(index, token) {
  if (token.length < 5) return index.postings.has(token) ? [token] : [];
  const stem = token.replace(SUFFIX, "");
  const prefix = token.slice(0, Math.max(5, stem.length));
  // First vocabulary word >= prefix, then every word that starts with it.
  let lo = 0;
  let hi = index.vocab.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (index.vocab[mid] < prefix) lo = mid + 1;
    else hi = mid;
  }
  const out = [];
  for (let i = lo; i < index.vocab.length && index.vocab[i].startsWith(prefix); i++) out.push(index.vocab[i]);
  return out;
}

// Map doc → score. Each query word counts once per doc (its best variant).
// With `requireRarest`, only docs containing the query's rarest word (any
// variant) count: "Add a changeset for every change" must mention a
// changeset, not merely "add" and "change".
function score(index, query, { requireRarest = false } = {}) {
  const scores = new Map();
  const words = [...new Set(tokenize(query))];
  let must = null;
  if (requireRarest) {
    let best = Infinity;
    for (const w of words) {
      const terms = expand(index, w);
      const df = terms.reduce((n, t) => n + index.postings.get(t).length, 0);
      if (df > 0 && df < best) {
        best = df;
        must = new Set(terms.flatMap((t) => index.postings.get(t).map(([d]) => d)));
      }
    }
    if (!must) return scores;
  }
  for (const word of words) {
    const best = new Map();
    for (const term of expand(index, word)) {
      const list = index.postings.get(term);
      const idf = Math.log(1 + (index.n - list.length + 0.5) / (list.length + 0.5));
      for (const [d, tf] of list) {
        const s = idf * ((tf * (K1 + 1)) / (tf + K1 * (1 - B + (B * index.lengths[d]) / index.avgdl)));
        if (s > (best.get(d) ?? 0)) best.set(d, s);
      }
    }
    for (const [d, s] of best) if (!must || must.has(d)) scores.set(d, (scores.get(d) ?? 0) + s);
  }
  return scores;
}

// ---- Build ---------------------------------------------------------------

function threadRoots(reviewComments) {
  const byId = new Map(reviewComments.map((c) => [c.comment_id, c]));
  return (c) => {
    let cur = c;
    const seen = new Set();
    while (cur.in_reply_to_id != null && byId.has(cur.in_reply_to_id) && !seen.has(cur.comment_id)) {
      seen.add(cur.comment_id);
      cur = byId.get(cur.in_reply_to_id);
    }
    return cur.comment_id ?? c.comment_id;
  };
}

export const EMPTY_DATA = { meta: {}, issue_comments: [], review_comments: [], review_submissions: [] };

// For the older search_rules tool: clusters with 2+ PRs and 2+ reviewers.
function legacyClusters(data) {
  return filterClusters(buildClusters(extractCandidates(data), { threshold: 0.34 }), { minOccurrences: 2, minAuthors: 2 })
    .map((c) => ({
      label: c.label,
      kind: c.kind,
      occurrences: c.occurrences,
      distinct_authors: c.distinctAuthors,
      distinct_prs: c.distinctPRs,
      paths: c.paths.slice(0, 5),
      allPaths: c.paths,
      tokens: new Set([...(c.label ?? []), ...c.items.flatMap((i) => i.tokens ?? [])]),
      quotes: pickExamples(c.items, 3).map((i) => ({ text: clip(i.sentence), author: i.author, pr: i.pr, url: i.url, ...(i.path ? { path: i.path } : {}) })),
    }));
}

// rules: [{ file, title, body, paths[], urls[], generated }] (see parseRuleText).
// The index holds only plain data (Maps, Sets, arrays), so it can be sent
// between processes.
// Threads a bot or AI reviewer started: the human replies there answer
// the bot ("Declined.", "Fixed in abc123") rather than review the code.
// On pnpm these crowded real review out of path results.
// → (comment) => true for such a reply.
export function botThreadReplies(data) {
  const rootOf = threadRoots(data.review_comments ?? []);
  const botRoots = new Set((data.review_comments ?? []).filter((c) => c.in_reply_to_id == null && isNoise(c) && (c.author_type === "Bot" || /\[bot\]$|^Copilot$/.test(c.author) || looksLikeAIReview(c.body ?? ""))).map((c) => c.comment_id));
  return (c) => c.type === "review_comment" && c.in_reply_to_id != null && botRoots.has(rootOf(c));
}

export function buildIndex(data, { rules = [], clusters = false } = {}) {
  const rootOf = threadRoots(data.review_comments ?? []);
  const isBotReply = botThreadReplies(data);
  const enriched = applySignals(data);
  const comments = [];
  const sentences = [];
  for (const c of [...enriched.issue_comments, ...enriched.review_comments, ...enriched.review_submissions]) {
    if (isNoise(c)) continue;
    if (isBotReply(c)) continue;
    const text = stripMarkdown(c.body, { keepInlineCode: true });
    const parts = splitSentences(text);
    let kind = null;
    for (const s of parts) {
      const k = classifySentence(s)?.kind;
      if (k && kindRank(k) < kindRank(kind)) kind = k;
    }
    const i = comments.length;
    comments.push({
      author: c.author,
      pr: c.pr_number,
      path: c.path ?? null,
      line: c.line ?? null,
      url: c.html_url,
      created_at: c.created_at ?? c.submitted_at ?? null,
      kind: kind ?? "other",
      text,
      thread: c.type === "review_comment" ? rootOf(c) : null,
      tokens: new Set(tokenize(text)),
    });
    for (const s of parts) sentences.push({ comment: i, sentence: s, tokens: tokenize(s) });
  }
  const ruleDocs = rules.map((r) => tokenize(`${r.title} ${r.title} ${r.body}`));
  return {
    comments,
    sentences,
    rules,
    sentenceIndex: bm25(sentences.map((s) => s.tokens)),
    ruleIndex: bm25(ruleDocs),
    ...(clusters ? { clusters: legacyClusters(data) } : {}),
  };
}

// ---- Rule files ----------------------------------------------------------

const PROVENANCE = "<!-- Generated by reviewlore";

// Any .claude/rules file: `paths:` frontmatter (list or one string), the
// first H1 as title, prose as body, and the GitHub links it cites.
export function parseRuleText(text, file) {
  let rest = text.replace(/\r\n/g, "\n");
  const paths = [];
  if (rest.startsWith("---\n")) {
    const end = rest.indexOf("\n---", 4);
    if (end !== -1) {
      const lines = rest.slice(4, end).split("\n");
      let inPaths = false;
      for (const line of lines) {
        const inline = line.match(/^paths:\s*(\S.*)$/);
        if (inline) {
          paths.push(...inline[1].replace(/^\[|\]$/g, "").split(",").map((p) => p.trim().replace(/^["']|["']$/g, "")).filter(Boolean));
          inPaths = false;
        } else if (/^paths:\s*$/.test(line)) inPaths = true;
        else if (inPaths && /^\s+-\s+/.test(line)) paths.push(line.replace(/^\s+-\s+/, "").trim().replace(/^["']|["']$/g, ""));
        else if (!/^\s/.test(line)) inPaths = false;
      }
      rest = rest.slice(end + 4);
    }
  }
  const title = rest.match(/^# (.+)$/m)?.[1].trim() ?? file.replace(/^.*\//, "").replace(/\.md$/, "");
  const body = rest
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/^#.*$/gm, "")
    .replace(/^\s*— @.*$/gm, "")
    .replace(/\s+/g, " ")
    .trim();
  // PR links on any host: github.com, GitHub Enterprise, GitLab merge requests.
  const urls = [...new Set(text.match(/https:\/\/[^\s)>\]]+\/(?:pull|-\/merge_requests)\/\d+[^\s)>\]]*/g) ?? [])];
  return { file, title, body, paths, urls, generated: text.includes(PROVENANCE) };
}

const ruleResult = (r) => ({
  source: "rule",
  title: r.title,
  rule: clip(r.body),
  paths: r.paths,
  file: r.file,
  generated: r.generated,
  sources: r.urls.slice(0, 5),
});

// ---- Queries -------------------------------------------------------------

const under = (p, dir) => p === dir || p.startsWith(`${dir}/`);

const commentResult = (c, quote, extra = {}) => ({
  source: "review",
  quote: clip(quote),
  author: c.author,
  pr: c.pr,
  url: c.url,
  ...(c.path ? { path: c.path, line: c.line } : {}),
  kind: c.kind,
  created_at: c.created_at,
  ...extra,
});

const support = (results) => ({
  prs: new Set(results.map((r) => r.pr)).size,
  reviewers: new Set(results.map((r) => r.author)).size,
});

// Rules first, then review comments ranked by BM25 on their best sentence.
export function searchIndex(index, query, { path, limit = 8, requireRarest = false } = {}) {
  const rules = [...score(index.ruleIndex, query)]
    .filter(([d]) => !path || !index.rules[d].paths.length || index.rules[d].paths.some((g) => globCoversPath(g, path)))
    .sort((a, b) => b[1] - a[1] || cmp(index.rules[a[0]].file, index.rules[b[0]].file))
    .slice(0, 3)
    .map(([d]) => ruleResult(index.rules[d]));

  const best = new Map(); // comment → [score, sentence]
  for (const [d, s] of score(index.sentenceIndex, query, { requireRarest })) {
    const { comment, sentence } = index.sentences[d];
    const boosted = s * (KIND_BOOST[index.comments[comment].kind] ?? 1);
    if (boosted > (best.get(comment)?.[0] ?? 0)) best.set(comment, [boosted, sentence]);
  }
  const ranked = [...best]
    .filter(([i]) => !path || (index.comments[i].path && under(index.comments[i].path, path)))
    .sort((a, b) => b[1][0] - a[1][0] || cmp(index.comments[b[0]].created_at, index.comments[a[0]].created_at) || cmp(index.comments[a[0]].url, index.comments[b[0]].url));
  const results = ranked.slice(0, limit).map(([i, [, sentence]]) => commentResult(index.comments[i], sentence));
  return { rules, results, support: support(results), more: Math.max(0, ranked.length - limit) };
}

const jaccard = (a, b) => {
  let both = 0;
  for (const t of a) if (b.has(t)) both++;
  return both / Math.max(1, a.size + b.size - both);
};

// What reviewers said about a file or directory: the rules scoped to it,
// then inline comments ranked by closeness (same file > same directory >
// same package), then by what they ask (requests first), then recency.
// A thread shows once, as its first remaining comment, with a reply count.
export function feedbackForPath(index, path, { months = 12, limit = 8, now = Date.now() } = {}) {
  path = path.replace(/^\.\//, "").replace(/\/+$/, "");
  const rules = index.rules
    .filter((r) => r.paths.length && r.paths.some((g) => globCoversPath(g, path)))
    .map(ruleResult);

  const inline = index.comments.filter((c) => c.path);
  const isFile = inline.some((c) => c.path === path) || /\.[^/]+$/.test(path);
  const dir = isFile ? dirname(path) : path;
  // The package (packages/<name>, apps/<name>, …) or else the first two
  // directory levels: src/api, not all of src.
  const pkg = pathGlobs([isFile ? path : `${path}/x`]).map(staticPrefix).find(Boolean) ?? "";
  const top2 = (dir === "." ? "" : dir).split("/").slice(0, 2).join("/");
  const scope = (pkg.split("/").length >= 2 ? pkg : top2) || null;
  const level = (p) => {
    if (isFile && p === path) return 0;
    if (dir !== "." && (isFile ? dirname(p) === dir : under(p, dir))) return 1;
    if (scope && under(p, scope)) return 2;
    return null;
  };
  const cutoff = now - months * 30.44 * 24 * 60 * 60 * 1000;

  const threads = new Map();
  for (const c of inline) {
    const lv = level(c.path);
    if (lv === null || Date.parse(c.created_at) < cutoff) continue;
    const key = c.thread ?? c.url;
    const t = threads.get(key);
    if (!t) threads.set(key, { first: c, level: lv, kind: c.kind, latest: c.created_at, count: 1 });
    else {
      t.count++;
      if (cmp(c.created_at, t.first.created_at) < 0) t.first = c;
      if (lv < t.level) t.level = lv;
      if (kindRank(c.kind) < kindRank(t.kind)) t.kind = c.kind;
      if (cmp(c.created_at, t.latest) > 0) t.latest = c.created_at;
    }
  }
  const ranked = [...threads.values()].sort((a, b) =>
    a.level - b.level || kindRank(a.kind) - kindRank(b.kind) || cmp(b.latest, a.latest) || cmp(a.first.url, b.first.url));

  // The same reviewer making the same point on several PRs shows once.
  const kept = [];
  for (const t of ranked) {
    const dup = kept.find((k) => k.first.author === t.first.author && jaccard(k.first.tokens, t.first.tokens) >= 0.8);
    if (dup) dup.similar = (dup.similar ?? 0) + 1;
    else kept.push(t);
  }
  const MATCH = ["file", "dir", "package"];
  const comments = kept.slice(0, limit).map((t) => commentResult(t.first, t.first.text, {
    kind: t.kind,
    match: MATCH[t.level],
    ...(t.count > 1 ? { replies: t.count - 1 } : {}),
    ...(t.similar ? { similar: t.similar } : {}),
  }));
  const counts = { file: 0, dir: 0, package: 0 };
  for (const t of kept) counts[MATCH[t.level]]++;
  return { rules, comments, counts, more: Math.max(0, kept.length - limit) };
}

// ---- Precedents for a change (docs/plans/09) ------------------------------

// What review history says about a set of changed files, for the
// review-my-changes skill. Deterministic; the skill judges which items the
// diff actually triggers.
//   rules:      rule files whose `paths` match a changed file, then rules
//               with no `paths` (they apply to the PR as a whole)
//   recurring:  feedback clusters with 2+ PRs and 2+ reviewers, about the
//               changed files' areas first, then PR-wide ones
//   file_history: per changed file, the top ranked earlier comments
// changed: [{ path, status }] with status A/M/D/R/U.
export function precedentsFor(index, changed, { limit = 8, perFile = 3, months = 12, now = Date.now() } = {}) {
  const live = changed.filter((c) => c.status !== "D").map((c) => c.path);

  const rules = [];
  for (const r of index.rules) {
    if (!r.paths.length) {
      rules.push({ file: r.file, title: r.title, generated: r.generated, unscoped: true, matched: [], evidence_urls: r.urls.slice(0, 3) });
      continue;
    }
    const res = r.paths.map(globToRegExp).filter(Boolean);
    const matched = live.filter((p) => res.some((re) => re.test(p)));
    if (matched.length) rules.push({ file: r.file, title: r.title, generated: r.generated, unscoped: false, matched, evidence_urls: r.urls.slice(0, 3) });
  }
  rules.sort((a, b) => Number(a.unscoped) - Number(b.unscoped) || cmp(a.file, b.file));

  // A changed file's area: the glob `candidates` would give it.
  const areas = [...new Set(live.flatMap((p) => pathGlobs([p])))];
  const areaRes = areas.map((g) => [g, globToRegExp(g)]).filter(([, re]) => re);
  const recurring = [];
  for (const c of index.clusters ?? []) {
    const hit = areaRes.find(([, re]) => c.allPaths.some((p) => re.test(p)));
    if (hit) recurring.push({ c, scope: hit[0] });
    else if (!c.allPaths.length) recurring.push({ c, scope: null });
  }
  recurring.sort((a, b) => Number(a.scope === null) - Number(b.scope === null) || b.c.distinct_prs - a.c.distinct_prs || b.c.occurrences - a.c.occurrences);

  const fileHistory = [];
  for (const path of live) {
    const f = feedbackForPath(index, path, { months, limit: perFile, now });
    if (!f.comments.length) continue;
    fileHistory.push({
      path,
      same_file: f.counts.file,
      same_dir: f.counts.dir,
      same_package: f.counts.package,
      comments: f.comments.map(({ source, ...c }) => c),
    });
  }

  const shownRecurring = recurring.slice(0, limit).map(({ c, scope }) => ({
    kind: c.kind, prs: c.distinct_prs, reviewers: c.distinct_authors, label: c.label, scope, quotes: c.quotes,
  }));
  return {
    rules,
    recurring: shownRecurring,
    file_history: fileHistory,
    stats: {
      changed: changed.length,
      rules_matched: rules.filter((r) => !r.unscoped).length,
      rules_unscoped: rules.filter((r) => r.unscoped).length,
      recurring: shownRecurring.length,
      files_with_history: fileHistory.length,
    },
  };
}
