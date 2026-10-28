// Raw mode for `candidates --raw` (docs/plans/07-multilingual-and-high-recall.md):
// whole human review comments, in any language, for Claude to read —
// no English phrase classifier, no clustering. Only the language-agnostic
// filters apply: plain issues, PR authors, resolved threads (applySignals),
// bots, AI-written reviews and short praise (isNoise), and replies in
// threads a bot started.
//
// Within a token budget the strongest comments come first (review state,
// recency, inline comments a little higher), taken round-robin across
// top-level directories so one busy package can't fill the budget.

import { applySignals } from "./signals.mjs";
import { isNoise, stripMarkdown } from "./normalize.mjs";
import { botThreadReplies } from "./review-index.mjs";

const DAY = 86_400_000;
const KIND = { issue_comment: "comment", review_comment: "inline", review_submission: "review" };
const cmp = (a = "", b = "") => (a < b ? -1 : a > b ? 1 : 0);

// Where a PR/MR link's own part starts: GitHub /pull/, GitLab /-/merge_requests/.
const MARKERS = ["/pull/", "/-/merge_requests/"];
function splitUrl(url) {
  for (const m of MARKERS) {
    const i = url.indexOf(m);
    if (i !== -1) return [url.slice(0, i + m.length), url.slice(i + m.length)];
  }
  return [null, url];
}

export const estimateTokens = (text) => Math.ceil(text.length / 4);

// Share of a text's letters outside ASCII (a rough "not English" signal).
function nonAsciiShare(text) {
  const letters = text.match(/\p{L}/gu) ?? [];
  if (!letters.length) return 0;
  return letters.filter((ch) => ch.charCodeAt(0) > 127).length / letters.length;
}

// → { stats, rows }. `now` defaults to the data's fetch time, so the same
// corpus gives the same output whenever it's run.
export function rawComments(data, { budget = 60_000, maxChars = 1200, now } = {}) {
  const at = now ?? (Date.parse(data.meta?.last_fetched_at ?? data.meta?.fetched_at ?? "") || Date.now());
  const isBotReply = botThreadReplies(data);
  const enriched = applySignals(data);
  const survivors = [];
  for (const c of [...enriched.issue_comments, ...enriched.review_comments, ...enriched.review_submissions]) {
    if (isNoise(c) || isBotReply(c)) continue;
    let text = stripMarkdown(c.body, { keepInlineCode: true }).replace(/\s+/g, " ").trim();
    if (!text) continue;
    const cut = text.length > maxChars;
    if (cut) text = `${text.slice(0, maxChars - 1).trimEnd()}…`;
    const date = c.created_at ?? c.submitted_at ?? null;
    const ageMonths = date ? Math.max(0, (at - Date.parse(date)) / (30.44 * DAY)) : 0;
    const score = (c.weight ?? 1) * 0.5 ** (ageMonths / 6) * (c.type === "review_comment" ? 1.25 : 1);
    const url = c.html_url ?? "";
    const row = {
      u: splitUrl(url)[1],
      by: c.author,
      pr: c.pr_number,
      k: KIND[c.type] ?? c.type,
      state: c.type === "review_submission" ? c.state ?? null : null,
      ...(c.path ? { path: c.path } : {}),
      at: date ? date.slice(0, 10) : null,
      text,
    };
    survivors.push({ row, score, url, cut, group: c.path ? c.path.split("/")[0] : "(no path)" });
  }

  // Groups ordered by their strongest comment; take one from each in turn.
  const groups = new Map();
  for (const s of survivors.sort((a, b) => b.score - a.score || cmp(a.url, b.url))) {
    if (!groups.has(s.group)) groups.set(s.group, []);
    groups.get(s.group).push(s);
  }
  const queues = [...groups.values()];
  const rows = [];
  let tokens = 0;
  let truncated = 0;
  let full = false;
  for (let round = 0; !full && queues.some((q) => q.length > round); round++) {
    for (const q of queues) {
      const s = q[round];
      if (!s) continue;
      const cost = estimateTokens(JSON.stringify(s.row));
      if (tokens + cost > budget) {
        full = true;
        break;
      }
      rows.push(s.row);
      if (s.cut) truncated++;
      tokens += cost;
    }
  }
  const shownNonAscii = rows.filter((r) => nonAsciiShare(r.text) >= 0.3).length;
  // Links are url_base + u, on whatever host the repository lives on.
  const base = survivors.map((s) => splitUrl(s.url)[0]).find(Boolean) ?? null;
  return {
    url_base: base,
    stats: {
      comments: data.meta?.source_totals?.total ?? data.meta?.totals?.total ?? null,
      survivors: survivors.length,
      shown: rows.length,
      truncated,
      budget_tokens: budget,
      est_tokens: tokens,
      dropped_for_budget: survivors.length - rows.length,
      non_ascii_share: rows.length ? Math.round((shownNonAscii / rows.length) * 100) / 100 : 0,
    },
    rows,
  };
}
