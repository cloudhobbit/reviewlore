#!/usr/bin/env node
// Re-draw the unlabelled sample behind comments.json from cached corpora
// in ~/.reviewlore/ (override with REVIEWLORE_CACHE_DIR).
//
//   node eval/real/sample.mjs > /tmp/sample.json
//
// Output records match comments.json minus `label` and the body scrubbing
// for home-directory paths. Labels are added by hand — see README.md.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { createHash } from "node:crypto";

const PLAN = {
  "vitest-dev__vitest": ["dev", 150],
  "pnpm__pnpm": ["dev", 150],
  "expressjs__express": ["test", 80],
  "tj__commander.js": ["test", 80],
  "vercel__swr": ["test", 80],
};
const cacheDir = process.env.REVIEWLORE_CACHE_DIR ?? join(homedir(), ".reviewlore");
const hash = (s) => createHash("sha256").update(s).digest("hex");

const out = [];
for (const [repo, [split, n]] of Object.entries(PLAN)) {
  const d = JSON.parse(readFileSync(join(cacheDir, `${repo}.json`), "utf8"));
  const prAuthors = d.meta?.pr_authors ?? {};
  const picked = [...(d.issue_comments ?? []), ...(d.review_comments ?? []), ...(d.review_submissions ?? [])]
    .filter((c) => (c.body ?? "").trim().length >= 20)
    .map((c) => [hash(repo + (c.comment_id ?? c.review_id)), c])
    .sort((a, b) => a[0].localeCompare(b[0]))
    .slice(0, n)
    .map(([, c]) => c);

  // Per-repo pseudonyms; bot accounts keep their public names.
  const ids = new Map();
  const alias = (login) => {
    if (!ids.has(login)) ids.set(login, `user-${ids.size + 1}`);
    return ids.get(login);
  };
  for (const c of picked) {
    const isBot = c.author_type === "Bot" || /\[bot\]$/i.test(c.author ?? "");
    // Alias the author before their @mentions so numbering is stable.
    const author = isBot ? c.author : alias(c.author);
    const prAuthor = prAuthors[c.pr_number];
    const body = c.body
      .replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, "<email>")
      .replace(/@([A-Za-z0-9-]+(\[bot\])?)/g, (m, login) => (/\[bot\]$/.test(login) ? m : `@${alias(login)}`));
    out.push({
      id: `${repo}#${c.comment_id ?? c.review_id}`, repo, split, type: c.type,
      author, author_type: c.author_type,
      is_pr_author: prAuthor != null && prAuthor === c.author, pr_number: c.pr_number,
      state: c.state, path: c.path, in_reply_to_id: c.in_reply_to_id,
      html_url: c.html_url, created_at: c.created_at ?? c.submitted_at, body,
    });
  }
}
process.stdout.write(JSON.stringify(out, null, 1) + "\n");
