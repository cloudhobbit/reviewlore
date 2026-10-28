import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getRenderer, rendererNames } from "../lib/renderers/index.mjs";

const sampleCluster = {
  label: ["test", "missing", "edge"],
  occurrences: 4,
  weightedOccurrences: 5,
  distinctAuthors: 3,
  distinctPRs: 4,
  authors: ["alice", "bob", "carol"],
  paths: ["src/a.ts", "src/b.tsx"],
  kinds: ["request"],
  items: [
    { sentence: "Please add a test for the empty-array case.", author: "alice", pr: 1, url: "u1" },
    { sentence: "Missing test for null input.", author: "bob", pr: 2, url: "u2" },
    { sentence: "Add tests for edge cases.", author: "carol", pr: 3, url: "u3" },
  ],
};

function withTmpTarget(fn) {
  const dir = mkdtempSync(join(tmpdir(), "render-"));
  try { return fn(dir); } finally { rmSync(dir, { recursive: true, force: true }); }
}

test("getRenderer returns each registered format", () => {
  for (const n of rendererNames()) assert.equal(getRenderer(n).name, n);
});

test("getRenderer throws on unknown name", () => {
  assert.throws(() => getRenderer("bogus"), /Unknown format/);
});

test("claude renderer writes pr-feedback-*.md under .claude/rules/", () => {
  withTmpTarget((dir) => {
    const r = getRenderer("claude").write([sampleCluster], { targetDir: dir });
    assert.equal(r.written.length, 1);
    assert.ok(r.written[0].path.includes(join(".claude", "rules")));
    assert.ok(r.written[0].path.endsWith(".md"));
    const body = readFileSync(r.written[0].path, "utf-8");
    assert.match(body, /Reviewer feedback recurring/);
  });
});

test("cursor renderer writes .mdc under .cursor/rules/ with globs from paths", () => {
  withTmpTarget((dir) => {
    const r = getRenderer("cursor").write([sampleCluster], { targetDir: dir });
    assert.equal(r.written.length, 1);
    const body = readFileSync(r.written[0].path, "utf-8");
    assert.ok(r.written[0].path.endsWith(".mdc"));
    assert.match(body, /^---\n/);
    // Globs derived from .ts and .tsx file extensions
    assert.match(body, /globs:.*\*\*\/\*\.ts/);
    assert.match(body, /globs:.*\*\*\/\*\.tsx/);
  });
});

test("cursor renderer uses alwaysApply: false when no paths in cluster", () => {
  withTmpTarget((dir) => {
    const c = { ...sampleCluster, paths: [] };
    const r = getRenderer("cursor").write([c], { targetDir: dir });
    const body = readFileSync(r.written[0].path, "utf-8");
    assert.match(body, /alwaysApply: false/);
  });
});

test("copilot renderer writes single .github/copilot-instructions.md", () => {
  withTmpTarget((dir) => {
    const r = getRenderer("copilot").write([sampleCluster, sampleCluster], { targetDir: dir });
    assert.equal(r.written.length, 1);
    assert.ok(r.written[0].path.endsWith("copilot-instructions.md"));
    const body = readFileSync(r.written[0].path, "utf-8");
    assert.match(body, /## Recurring reviewer feedback/);
    assert.match(body, /reviewlore:start/);
    assert.match(body, /reviewlore:end/);
    // Both clusters rendered
    const sectionCount = (body.match(/^### /gm) || []).length;
    assert.equal(sectionCount, 2);
  });
});

test("copilot renderer updates managed block in place; preserves surrounding text", () => {
  withTmpTarget((dir) => {
    // Pre-existing copilot-instructions.md with user prose + an old managed block
    const path = join(dir, ".github", "copilot-instructions.md");
    mkdirSync(join(dir, ".github"), { recursive: true });
    writeFileSync(
      path,
      `# My existing instructions\n\nKeep this stuff.\n\n<!-- reviewlore:start -->\nOLD CONTENT\n<!-- reviewlore:end -->\n\nAlso keep this trailing prose.\n`,
      "utf-8",
    );
    getRenderer("copilot").write([sampleCluster], { targetDir: dir });
    const body = readFileSync(path, "utf-8");
    assert.match(body, /# My existing instructions/);
    assert.match(body, /Keep this stuff/);
    assert.match(body, /Also keep this trailing prose/);
    assert.ok(!body.includes("OLD CONTENT"));
  });
});

test("copilot renderer refuses to write into unmanaged existing file unless --force", () => {
  withTmpTarget((dir) => {
    const path = join(dir, ".github", "copilot-instructions.md");
    mkdirSync(join(dir, ".github"), { recursive: true });
    writeFileSync(path, "user wrote this without markers\n", "utf-8");
    const r = getRenderer("copilot").write([sampleCluster], { targetDir: dir });
    assert.equal(r.written.length, 0);
    assert.equal(r.skipped.length, 1);
    const r2 = getRenderer("copilot").write([sampleCluster], { targetDir: dir, force: true });
    assert.equal(r2.written.length, 1);
  });
});

test("contributing renderer appends managed section to CONTRIBUTING.md", () => {
  withTmpTarget((dir) => {
    const r = getRenderer("contributing").write([sampleCluster], { targetDir: dir });
    assert.equal(r.written.length, 1);
    const body = readFileSync(r.written[0].path, "utf-8");
    assert.match(body, /## Recurring review feedback/);
    assert.match(body, /3 reviewers/);
  });
});

test("json renderer writes one machine-readable file", () => {
  withTmpTarget((dir) => {
    const r = getRenderer("json").write([sampleCluster], { targetDir: dir });
    const parsed = JSON.parse(readFileSync(r.written[0].path, "utf-8"));
    assert.equal(parsed.cluster_count, 1);
    assert.equal(parsed.clusters[0].distinct_authors, 3);
    assert.equal(parsed.clusters[0].examples.length, 3);
  });
});

test("html renderer writes a self-contained reviewlore-report.html", () => {
  withTmpTarget((dir) => {
    const r = getRenderer("html").write([sampleCluster], {
      targetDir: dir,
      meta: { owner: "test", repo: "ts-app", months_back: 6 },
    });
    assert.equal(r.written.length, 1);
    assert.ok(r.written[0].path.endsWith("reviewlore-report.html"));
    const body = readFileSync(r.written[0].path, "utf-8");
    // self-contained: no external <script src=, no <link rel="stylesheet" href=
    assert.equal(body.includes('<link rel="stylesheet"'), false);
    assert.equal(body.includes('<script src='), false);
    // includes owner/repo from meta
    assert.match(body, /test\/ts-app/);
    // has a rule card
    assert.match(body, /<details class="rule"/);
    // has the inline filter script
    assert.match(body, /data-severity=/);
  });
});

test("html renderer escapes HTML in user-supplied content", () => {
  withTmpTarget((dir) => {
    const malicious = {
      ...sampleCluster,
      items: [
        { sentence: "<script>alert('xss')</script>", author: "x", pr: 1, url: "http://example.test" },
      ],
    };
    const r = getRenderer("html").write([malicious], {
      targetDir: dir,
      meta: { owner: "<img>", repo: "test" },
    });
    const body = readFileSync(r.written[0].path, "utf-8");
    assert.equal(body.includes("<script>alert"), false);
    assert.match(body, /&lt;script&gt;/);
    assert.match(body, /&lt;img&gt;/);
  });
});

test("json renderer respects --force", () => {
  withTmpTarget((dir) => {
    const path = join(dir, "reviewlore-rules.json");
    writeFileSync(path, "x", "utf-8");
    const r1 = getRenderer("json").write([sampleCluster], { targetDir: dir });
    assert.equal(r1.written.length, 0);
    assert.equal(r1.skipped.length, 1);
    const r2 = getRenderer("json").write([sampleCluster], { targetDir: dir, force: true });
    assert.equal(r2.written.length, 1);
  });
});
