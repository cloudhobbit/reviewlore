import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CORPUS_FILENAME, corpusPath, loadCorpus, corpusInfo, publishCorpus,
} from "../lib/corpus.mjs";
import { mergeIntoCache } from "../lib/cache.mjs";

function withTmpCache(fn) {
  const dir = mkdtempSync(join(tmpdir(), "corpus-cache-"));
  const old = process.env.REVIEWLORE_CACHE_DIR;
  process.env.REVIEWLORE_CACHE_DIR = dir;
  try { return fn(dir); } finally {
    if (old !== undefined) process.env.REVIEWLORE_CACHE_DIR = old;
    else delete process.env.REVIEWLORE_CACHE_DIR;
    rmSync(dir, { recursive: true, force: true });
  }
}

function withTmpTarget(fn) {
  const dir = mkdtempSync(join(tmpdir(), "corpus-tgt-"));
  try { return fn(dir); } finally { rmSync(dir, { recursive: true, force: true }); }
}

const sampleCorpus = () => ({
  meta: {
    owner: "myorg", repo: "myrepo",
    fetched_at: "2026-05-15T00:00:00Z",
    last_fetched_at: "2026-05-15T00:00:00Z",
    totals: { issue_comments: 5, review_comments: 3, review_submissions: 2, total: 10 },
    pr_authors: { 1: "alice" },
  },
  issue_comments: [], review_comments: [], review_submissions: [],
});

test("corpusPath: deterministic <target>/.reviewlore-corpus.json", () => {
  withTmpTarget((dir) => {
    assert.equal(corpusPath(dir), join(dir, CORPUS_FILENAME));
  });
});

test("loadCorpus: returns null when no corpus file", () => {
  withTmpTarget((dir) => assert.equal(loadCorpus(dir), null));
});

test("loadCorpus: returns null on unparseable JSON (treat as missing)", () => {
  withTmpTarget((dir) => {
    writeFileSync(corpusPath(dir), "{ not json", "utf-8");
    assert.equal(loadCorpus(dir), null);
  });
});

test("publishCorpus: copies cache for (owner, repo) into target", () => {
  withTmpCache(() => withTmpTarget((dir) => {
    mergeIntoCache("myorg", "myrepo", sampleCorpus());
    const r = publishCorpus({ owner: "myorg", repo: "myrepo", targetDir: dir });
    assert.ok(existsSync(r.path));
    assert.equal(r.path, corpusPath(dir));
    assert.ok(r.sizeKb >= 0);
    const loaded = loadCorpus(dir);
    assert.equal(loaded.meta.owner, "myorg");
    assert.equal(loaded.meta.repo, "myrepo");
  }));
});

test("publishCorpus: throws clear error when cache is missing", () => {
  withTmpCache(() => withTmpTarget((dir) => {
    assert.throws(
      () => publishCorpus({ owner: "nope", repo: "nope", targetDir: dir }),
      /No cache for nope\/nope/,
    );
  }));
});

test("corpusInfo: returns null when missing; rich object when present", () => {
  withTmpTarget((dir) => {
    assert.equal(corpusInfo(dir), null);
    writeFileSync(corpusPath(dir), JSON.stringify(sampleCorpus()), "utf-8");
    const info = corpusInfo(dir);
    assert.ok(info);
    assert.equal(info.meta.owner, "myorg");
    assert.equal(info.totals.total, 10);
    assert.ok(info.sizeKb >= 0);
    assert.equal(typeof info.ageDays, "number");
    assert.ok(info.ageDays > -1, "ageDays should be a sane non-future value");
  });
});

test("corpusInfo: corrupt file reported, not crashed", () => {
  withTmpTarget((dir) => {
    writeFileSync(corpusPath(dir), "not json", "utf-8");
    const info = corpusInfo(dir);
    assert.equal(info.error, "corrupt");
  });
});

test("round-trip: published corpus loads identically", () => {
  withTmpCache(() => withTmpTarget((dir) => {
    const original = sampleCorpus();
    mergeIntoCache("myorg", "myrepo", original);
    publishCorpus({ owner: "myorg", repo: "myrepo", targetDir: dir });
    const loaded = loadCorpus(dir);
    // The corpus is slimmed: `totals` counts what it holds, the fetched
    // counts move to `source_totals`, and pr_authors keeps only PRs that
    // still have records.
    assert.deepEqual(loaded.issue_comments, original.issue_comments);
    assert.deepEqual(loaded.meta.source_totals, original.meta.totals);
    assert.deepEqual(loaded.meta.totals, { issue_comments: 0, review_comments: 0, review_submissions: 0, total: 0 });
    assert.deepEqual(loaded.meta.pr_authors, {});
    assert.equal(loaded.meta.schema_version, 2);
  }));
});

// --- Credential scanning on publish (security regression coverage) ---

const FAKE_PAT_IN_CORPUS = "ghp_" + "Z".repeat(40);

const sampleCorpusWithSecret = () => ({
  meta: {
    owner: "myorg", repo: "myrepo",
    fetched_at: "2026-05-15T00:00:00Z",
    last_fetched_at: "2026-05-15T00:00:00Z",
    totals: { issue_comments: 1, review_comments: 0, review_submissions: 0, total: 1 },
    pr_authors: { 1: "alice" },
  },
  issue_comments: [
    {
      type: "issue_comment",
      comment_id: 1,
      pr_number: 1,
      author: "reviewer",
      body: `please fix this — for context my CI uses ${FAKE_PAT_IN_CORPUS}`,
      created_at: "2026-05-15T00:00:00Z",
      html_url: "https://github.com/myorg/myrepo/pull/1#issuecomment-1",
    },
  ],
  review_comments: [],
  review_submissions: [],
});

test("publishCorpus: redacts credentials in comment bodies before writing", () => {
  withTmpCache(() => withTmpTarget((dir) => {
    mergeIntoCache("myorg", "myrepo", sampleCorpusWithSecret());
    const r = publishCorpus({ owner: "myorg", repo: "myrepo", targetDir: dir });

    // The on-disk corpus must NOT contain the pasted PAT.
    const raw = readFileSync(r.path, "utf-8");
    assert.ok(!raw.includes(FAKE_PAT_IN_CORPUS),
      "published corpus must not contain raw credential strings");
    assert.ok(raw.includes("[REDACTED]"),
      "published corpus should show [REDACTED] in place of the credential");

    // Warnings surface the offending PR URL and label so the caller can report it.
    assert.ok(Array.isArray(r.warnings));
    assert.equal(r.warnings.length, 1);
    assert.equal(r.warnings[0].html_url, "https://github.com/myorg/myrepo/pull/1#issuecomment-1");
    assert.ok(r.warnings[0].labels.includes("github_token"));
  }));
});

test("publishCorpus: clean corpus has empty warnings array", () => {
  withTmpCache(() => withTmpTarget((dir) => {
    mergeIntoCache("myorg", "myrepo", sampleCorpus());
    const r = publishCorpus({ owner: "myorg", repo: "myrepo", targetDir: dir });
    assert.ok(Array.isArray(r.warnings));
    assert.equal(r.warnings.length, 0);
  }));
});

test("publishCorpus: onSecrets='refuse' throws with offending PR URL and writes nothing", () => {
  withTmpCache(() => withTmpTarget((dir) => {
    mergeIntoCache("myorg", "myrepo", sampleCorpusWithSecret());
    assert.throws(
      () => publishCorpus({ owner: "myorg", repo: "myrepo", targetDir: dir, onSecrets: "refuse" }),
      /pull\/1#issuecomment-1/,
    );
    assert.equal(existsSync(corpusPath(dir)), false,
      "corpus file must not be written when onSecrets='refuse' and matches exist");
  }));
});


test("publishCorpus: leaves the file alone when only fetch timestamps changed", () => {
  withTmpCache(() => withTmpTarget((dir) => {
    // An established cache (as on a scheduled runner seeded from the corpus):
    // it has been merged into at least once.
    mergeIntoCache("myorg", "myrepo", sampleCorpus());
    mergeIntoCache("myorg", "myrepo", sampleCorpus());
    const first = publishCorpus({ owner: "myorg", repo: "myrepo", targetDir: dir });
    assert.equal(first.unchanged, false);
    const before = readFileSync(first.path, "utf-8");
    // A later fetch that found nothing new: only fetched_at moves.
    mergeIntoCache("myorg", "myrepo", { ...sampleCorpus(), meta: { ...sampleCorpus().meta, fetched_at: "2099-01-01T00:00:00Z" } });
    const second = publishCorpus({ owner: "myorg", repo: "myrepo", targetDir: dir });
    assert.equal(second.unchanged, true);
    assert.equal(readFileSync(second.path, "utf-8"), before);
  }));
});

test("publishCorpus writes the slim, one-record-per-line corpus without diff hunks", () => {
  withTmpCache(() => withTmpTarget((dir) => {
    const data = sampleCorpus();
    data.review_comments = [{
      type: "review_comment", comment_id: 7, pr_number: 2, author: "bob", author_type: "User",
      body: "Please avoid the any type in this handler.", path: "src/a.ts", line: 3,
      diff_hunk: `+ const token = "${FAKE_PAT_IN_CORPUS}";`, in_reply_to_id: null,
      created_at: "2026-05-01T00:00:00Z", updated_at: "2026-05-01T00:00:00Z",
      html_url: "https://github.com/myorg/myrepo/pull/2#discussion_r7",
    }];
    mergeIntoCache("myorg", "myrepo", data);
    const r = publishCorpus({ owner: "myorg", repo: "myrepo", targetDir: dir });
    const text = readFileSync(r.path, "utf-8");
    assert.ok(!text.includes("ghp_"), "diff_hunk is not published");
    assert.ok(text.includes('\n{"type":"review_comment","comment_id":7,'), "one record per line");
    assert.equal(r.dropped.noise, 0);
    assert.ok(r.sourceSizeKb >= 0);
  }));
});
