import { test } from "node:test";
import assert from "node:assert/strict";
import { extractCandidates, buildClusters, filterClusters, pickExamples } from "../lib/extract.mjs";

const fixture = {
  meta: { owner: "x", repo: "y" },
  issue_comments: [
    { author: "alice", pr_number: 1, html_url: "u1", body: "Please don't use any here, prefer unknown." },
    { author: "bob",   pr_number: 2, html_url: "u2", body: "Avoid `any` in new code — use unknown instead." },
    { author: "carol", pr_number: 3, html_url: "u3", body: "We shouldn't use any types, replace with unknown." },
    { author: "dave",  pr_number: 4, html_url: "u4", body: "lgtm" },
  ],
  review_comments: [
    { author: "alice", pr_number: 5, html_url: "u5", path: "src/a.ts", body: "Please add a test for this empty-array case." },
    { author: "bob",   pr_number: 6, html_url: "u6", path: "src/b.ts", body: "Missing test for the null-input case here." },
  ],
  review_submissions: [
    { author: "carol", pr_number: 7, html_url: "u7", body: "Add tests for the edge cases please.", state: "CHANGES_REQUESTED" },
  ],
};

test("extractCandidates pulls classified sentences and skips noise", () => {
  const cands = extractCandidates(fixture);
  assert.ok(cands.length >= 4);
  // 'lgtm' must be dropped (too short)
  assert.equal(cands.find((c) => c.author === "dave"), undefined);
});

test("buildClusters + filterClusters surface recurring 'any → unknown' theme", () => {
  const cands = extractCandidates(fixture);
  const clusters = buildClusters(cands, { threshold: 0.2 });
  const kept = filterClusters(clusters, { minOccurrences: 3, minAuthors: 2 });
  assert.ok(kept.length >= 1);
  // The 'any/unknown' cluster should be present
  const hasAnyUnknown = kept.some((c) =>
    c.items.some((i) => /any|unknown/.test(i.remainder)),
  );
  assert.ok(hasAnyUnknown);
});

test("filterClusters drops clusters below thresholds", () => {
  const cands = extractCandidates(fixture);
  const clusters = buildClusters(cands);
  const tooStrict = filterClusters(clusters, { minOccurrences: 99, minAuthors: 99 });
  assert.equal(tooStrict.length, 0);
});

test("captures 'avoid any types' even when remainder tokens are sparse (regression: #1)", () => {
  const data = {
    issue_comments: [
      { author: "a", pr_number: 1, html_url: "u1", body: "Avoid any types here." },
      { author: "b", pr_number: 2, html_url: "u2", body: "Don't use any types." },
      { author: "c", pr_number: 3, html_url: "u3", body: "Please avoid any types." },
    ],
    review_comments: [], review_submissions: [],
  };
  const cands = extractCandidates(data);
  // All 3 must be captured (previously the "any" stopword + sparse remainder dropped them).
  assert.equal(cands.length, 3);
  const clusters = buildClusters(cands, { threshold: 0.2 });
  const kept = filterClusters(clusters, { minOccurrences: 3, minAuthors: 3 });
  assert.ok(kept.length >= 1, "should cluster the 'any types' theme");
});

test("occurrences counts unique (author, pr) tuples, not raw items (regression: #21)", () => {
  // alice posts ONE comment with TWO imperative sentences on PR #1.
  // bob and carol each post one comment on different PRs.
  // Naive count: 4 items. De-duped count: 3 (author,pr) tuples.
  const data = {
    issue_comments: [
      { author: "alice", pr_number: 1, html_url: "u",
        body: "Avoid any types here. Always prefer unknown instead." },
      { author: "bob",   pr_number: 2, html_url: "u", body: "Don't use any types." },
      { author: "carol", pr_number: 3, html_url: "u", body: "Avoid any types please." },
    ],
    review_comments: [], review_submissions: [],
  };
  const cands = extractCandidates(data);
  const clusters = buildClusters(cands, { threshold: 0.15 });
  const top = clusters.sort((a, b) => b.occurrences - a.occurrences)[0];
  // Raw items might be 4; occurrences (unique tuples) should be 3.
  assert.equal(top.occurrences, 3);
  assert.ok(top.rawItems >= top.occurrences);
});

test("inline code is kept in quotes and tokens but can't trigger a pattern", () => {
  const data = {
    meta: {},
    issue_comments: [
      { author: "a", pr_number: 1, html_url: "u1", body: "Can't have `async` here, the hook is sync." },
      { author: "b", pr_number: 2, html_url: "u2", body: "This calls `use()` on the store in a loop." },
    ],
  };
  const cands = extractCandidates(data);
  assert.equal(cands.length, 1);
  assert.match(cands[0].sentence, /`async`/);
  assert.ok(cands[0].tokens.includes("async"));
});

test("cluster kind is the majority kind, not 'any prohibition wins'", () => {
  const data = {
    meta: {},
    issue_comments: [
      { author: "a", pr_number: 1, html_url: "u1", body: "Please add tests for the empty case." },
      { author: "b", pr_number: 2, html_url: "u2", body: "Please add tests for the null case." },
      { author: "c", pr_number: 3, html_url: "u3", body: "Please add tests for this edge case." },
    ],
  };
  const [cluster] = filterClusters(buildClusters(extractCandidates(data)));
  assert.equal(cluster.kind, "request");
});

test("pickExamples quotes each comment once and prefers distinct reviewers", () => {
  const items = [
    { author: "a", url: "u1", sentence: "one" },
    { author: "a", url: "u1", sentence: "one again" },
    { author: "a", url: "u2", sentence: "two" },
    { author: "b", url: "u3", sentence: "three" },
  ];
  assert.deepEqual(pickExamples(items, 3).map((i) => i.url), ["u1", "u3", "u2"]);
});

test("bullet-list reviews yield one candidate per actionable item", () => {
  const data = {
    meta: {},
    review_comments: [{
      author: "a", pr_number: 1, html_url: "u1", path: "src/a.ts",
      body: "A few things\n- Add a test for the parser\n- Rename this helper to parseConfig\n- Remove the debug logging",
    }],
  };
  assert.equal(extractCandidates(data).length, 3);
});
