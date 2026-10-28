// HTML report renderer: a self-contained, single-file dashboard for
// recurring reviewer-feedback patterns. Designed for the human audience
// (tech lead, EM, new joiner, contributor evaluating the repo) — not for
// an AI tool to consume.
//
// Output: <target>/reviewlore-report.html
//
// Design constraints:
//   - Single file. Inline CSS, vanilla JS only. No build step, no CDN,
//     no fonts/icons fetched. Works opened from `file://` or hosted on
//     GitHub Pages identically.
//   - Embedded data — the user can email the file to a stakeholder and
//     it works offline.
//   - Filterable by kind / severity / path; sortable by recency / count.

import { writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { normalizeAll, relativeAge } from "./_common.mjs";

export const name = "html";
export const describe = "Self-contained HTML report: <target>/reviewlore-report.html";

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function renderRuleCard(rule, maxOcc, now) {
  const barPct = Math.max(4, Math.round((rule.weighted_occurrences / maxOcc) * 100));
  const ageStr = rule.last_seen ? `last seen ${escapeHtml(relativeAge(rule.last_seen, now))}` : "";
  const pathsStr = rule.paths.length
    ? `<span class="meta">${escapeHtml(rule.paths.slice(0, 3).join(", "))}${rule.paths.length > 3 ? ` +${rule.paths.length - 3}` : ""}</span>`
    : "";
  const examples = rule.examples
    .map(
      (e) => `
      <li>
        <blockquote>${escapeHtml(e.quote)}</blockquote>
        <div class="example-meta">
          — <span class="author">@${escapeHtml(e.author)}</span>
          on <a href="${escapeHtml(e.url)}">PR #${escapeHtml(String(e.pr ?? "?"))}</a>
          ${e.path ? ` · <code>${escapeHtml(e.path)}</code>` : ""}
        </div>
      </li>`,
    )
    .join("");

  return `
    <details class="rule"
             data-severity="${escapeHtml(rule.severity)}"
             data-kind="${escapeHtml(rule.kind)}"
             data-occurrences="${rule.weighted_occurrences}"
             data-last-seen="${escapeHtml(rule.last_seen ?? "")}">
      <summary>
        <div class="bar-wrap">
          <div class="bar bar-${escapeHtml(rule.severity)}" style="width:${barPct}%"></div>
        </div>
        <div class="rule-head">
          <span class="count">${rule.weighted_occurrences.toFixed(1)}×</span>
          <span class="title">${escapeHtml(rule.title)}</span>
          <span class="badges">
            <span class="badge badge-${escapeHtml(rule.severity)}">${escapeHtml(rule.severity)}</span>
            <span class="badge badge-kind">${escapeHtml(rule.kind)}</span>
          </span>
          <span class="meta">${rule.distinct_authors} reviewers · ${rule.distinct_prs} PRs</span>
          <span class="meta">${ageStr}</span>
          ${pathsStr}
        </div>
      </summary>
      <div class="detail">
        <p class="rule-body">${escapeHtml(rule.body)}</p>
        <p><strong>Why:</strong> ${escapeHtml(rule.why)}</p>
        <p><strong>When to apply:</strong> ${escapeHtml(rule.when_to_apply)}</p>
        <p class="source-tag">Source: ${escapeHtml(rule.source)}${
          rule.synth_error ? ` <em>(synth error: ${escapeHtml(rule.synth_error)})</em>` : ""
        }</p>
        <h4>Evidence</h4>
        <ul class="examples">${examples}</ul>
      </div>
    </details>`;
}

function renderContributors(rules) {
  const counts = new Map();
  for (const r of rules) {
    for (const a of r.authors ?? []) {
      counts.set(a, (counts.get(a) ?? 0) + 1);
    }
  }
  const top = [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10);
  if (top.length === 0) return "";
  return `
    <section class="contributors">
      <h2>Top reviewers contributing to these patterns</h2>
      <ul>${top.map(([a, n]) => `<li><strong>@${escapeHtml(a)}</strong> <span class="meta">in ${n} rule${n === 1 ? "" : "s"}</span></li>`).join("")}</ul>
    </section>`;
}

export function renderHtml(rules, meta = {}, now = new Date()) {
  const maxOcc = Math.max(1, ...rules.map((r) => r.weighted_occurrences));
  const total = rules.length;
  const owner = escapeHtml(meta.owner ?? "");
  const repo = escapeHtml(meta.repo ?? "");
  const window = meta.months_back ? `last ${meta.months_back} months` : "selected window";

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${owner}/${repo} — review patterns</title>
<style>
  :root {
    --fg: #1a1a1a; --muted: #5f6b7a; --bg: #fafbfc; --card: #fff; --border: #e3e8ee;
    --must: #d63a3a; --should: #d68d3a; --consider: #5a8fc9;
    --kind: #6b7280;
  }
  * { box-sizing: border-box; }
  body { margin: 0; font: 14px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
         color: var(--fg); background: var(--bg); padding: 2rem 1rem; }
  .wrap { max-width: 980px; margin: 0 auto; }
  h1 { font-size: 1.6rem; margin: 0 0 .25rem; }
  .subtitle { color: var(--muted); margin-bottom: 2rem; }
  .toolbar { display: flex; gap: 1rem; flex-wrap: wrap; align-items: center;
             background: var(--card); border: 1px solid var(--border); border-radius: 8px;
             padding: .75rem 1rem; margin-bottom: 1rem; position: sticky; top: 0; z-index: 10; }
  .toolbar label { font-size: .9rem; color: var(--muted); }
  .toolbar select, .toolbar input {
    padding: .25rem .5rem; border: 1px solid var(--border); border-radius: 4px; font: inherit;
  }
  .stats { color: var(--muted); margin-left: auto; }
  details.rule { background: var(--card); border: 1px solid var(--border); border-radius: 8px;
                 margin-bottom: .6rem; overflow: hidden; }
  details.rule summary { padding: .75rem 1rem; cursor: pointer; list-style: none; }
  details.rule summary::-webkit-details-marker { display: none; }
  .bar-wrap { height: 4px; background: #f0f3f7; border-radius: 2px; margin-bottom: .5rem; }
  .bar { height: 100%; border-radius: 2px; }
  .bar-must { background: var(--must); }
  .bar-should { background: var(--should); }
  .bar-consider { background: var(--consider); }
  .rule-head { display: flex; align-items: baseline; flex-wrap: wrap; gap: .75rem; }
  .count { font-weight: 600; font-variant-numeric: tabular-nums; color: var(--fg);
           min-width: 4em; }
  .title { font-weight: 600; flex: 1; min-width: 200px; }
  .meta { font-size: .85rem; color: var(--muted); }
  .badges { display: inline-flex; gap: .3rem; }
  .badge { font-size: .7rem; text-transform: uppercase; letter-spacing: .03em;
           padding: 1px 7px; border-radius: 10px; font-weight: 600; }
  .badge-must { background: #fde0e0; color: #b32424; }
  .badge-should { background: #fcebd0; color: #a85c10; }
  .badge-consider { background: #e0eaf7; color: #2a5a99; }
  .badge-kind { background: #eef0f3; color: #4a5460; }
  .detail { padding: .25rem 1rem 1rem 1rem; border-top: 1px solid var(--border);
            background: #fafbfc; }
  .rule-body { font-size: 1.05rem; margin: 1rem 0 .75rem; }
  .source-tag { font-size: .8rem; color: var(--muted); margin: .5rem 0; }
  .examples { list-style: none; padding: 0; }
  .examples li { margin-bottom: .75rem; }
  blockquote { margin: 0; padding: .5rem .75rem; background: #fff;
               border-left: 3px solid var(--border); color: #2a2a2a; font-style: italic; }
  .example-meta { font-size: .8rem; color: var(--muted); margin-top: .25rem; }
  .example-meta code { background: #f0f3f7; padding: 1px 5px; border-radius: 3px; }
  a { color: #0969da; text-decoration: none; }
  a:hover { text-decoration: underline; }
  .empty { text-align: center; color: var(--muted); padding: 3rem; }
  .contributors { margin-top: 2rem; padding: 1.25rem; background: var(--card);
                  border: 1px solid var(--border); border-radius: 8px; }
  .contributors h2 { font-size: 1rem; margin: 0 0 .5rem; }
  .contributors ul { list-style: none; padding: 0; display: flex; flex-wrap: wrap; gap: 1rem; }
  footer { margin-top: 2rem; padding-top: 1rem; border-top: 1px solid var(--border);
           color: var(--muted); font-size: .85rem; text-align: center; }
</style>
</head>
<body>
<div class="wrap">
  <h1>${owner}/${repo} <span style="color:var(--muted); font-weight: normal;">— review patterns</span></h1>
  <p class="subtitle">${window} · generated ${escapeHtml(now.toISOString().slice(0, 10))} · ${total} rule${total === 1 ? "" : "s"}</p>

  <div class="toolbar">
    <label>Filter: severity
      <select id="filter-severity">
        <option value="">all</option>
        <option value="must">must</option>
        <option value="should">should</option>
        <option value="consider">consider</option>
      </select>
    </label>
    <label>kind
      <select id="filter-kind">
        <option value="">all</option>
        <option value="prohibition">prohibition</option>
        <option value="prescription">prescription</option>
        <option value="request">request</option>
        <option value="question">question</option>
      </select>
    </label>
    <label>search
      <input id="filter-text" placeholder="title or quote…" style="width: 12em;">
    </label>
    <label>sort by
      <select id="sort">
        <option value="count">most cited</option>
        <option value="recent">most recent</option>
      </select>
    </label>
    <span class="stats"><span id="visible-count">${total}</span> visible</span>
  </div>

  <div id="rules">
    ${rules.length === 0
      ? `<div class="empty">No rules met the thresholds. Try lowering --min-occurrences or extending --months.</div>`
      : rules.map((r) => renderRuleCard(r, maxOcc, now)).join("\n")}
  </div>

  ${renderContributors(rules)}

  <footer>
    Generated by <a href="https://github.com/cloudhobbit/reviewlore">reviewlore</a>.
    This report is self-contained — share it freely.
  </footer>
</div>

<script>
(function () {
  const rules = Array.from(document.querySelectorAll("details.rule"));
  const sevEl = document.getElementById("filter-severity");
  const kindEl = document.getElementById("filter-kind");
  const textEl = document.getElementById("filter-text");
  const sortEl = document.getElementById("sort");
  const countEl = document.getElementById("visible-count");
  const container = document.getElementById("rules");

  function apply() {
    const sev = sevEl.value, kind = kindEl.value, text = textEl.value.toLowerCase().trim();
    let visible = 0;
    for (const r of rules) {
      const matchSev = !sev || r.dataset.severity === sev;
      const matchKind = !kind || r.dataset.kind === kind;
      const matchText = !text || r.innerText.toLowerCase().includes(text);
      const show = matchSev && matchKind && matchText;
      r.style.display = show ? "" : "none";
      if (show) visible++;
    }
    countEl.textContent = visible;
  }
  function resort() {
    const key = sortEl.value;
    const sorted = [...rules].sort((a, b) => {
      if (key === "recent") return (b.dataset.lastSeen || "").localeCompare(a.dataset.lastSeen || "");
      return Number(b.dataset.occurrences) - Number(a.dataset.occurrences);
    });
    for (const r of sorted) container.appendChild(r);
  }
  sevEl.onchange = apply;
  kindEl.onchange = apply;
  textEl.oninput = apply;
  sortEl.onchange = resort;
})();
</script>
</body>
</html>`;
}

export function write(clusters, { targetDir, force = false, synth = null, meta = {} } = {}) {
  const path = join(targetDir, "reviewlore-report.html");
  if (existsSync(path) && !force) {
    return { written: [], skipped: [{ path, slug: "html", occurrences: clusters.length }] };
  }
  const rules = normalizeAll(clusters, synth);
  const html = renderHtml(rules, meta);
  writeFileSync(path, html, "utf-8");
  return { written: [{ path, slug: "html", occurrences: clusters.length }], skipped: [] };
}
