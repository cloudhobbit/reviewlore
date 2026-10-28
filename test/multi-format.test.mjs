import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveFormats, detectFormats, getRenderer, rendererNames } from "../lib/renderers/index.mjs";

function withTmp(fn) {
  const dir = mkdtempSync(join(tmpdir(), "multi-fmt-"));
  try { return fn(dir); } finally { rmSync(dir, { recursive: true, force: true }); }
}

test("resolveFormats: default and single", () => {
  assert.deepEqual(resolveFormats(undefined, "/tmp"), ["claude"]);
  assert.deepEqual(resolveFormats("cursor", "/tmp"), ["cursor"]);
});

test("resolveFormats: comma-separated list", () => {
  assert.deepEqual(resolveFormats("claude,cursor,html", "/tmp"), ["claude", "cursor", "html"]);
});

test("resolveFormats: 'all' expands to every registered renderer", () => {
  const all = resolveFormats("all", "/tmp");
  assert.deepEqual(all.sort(), rendererNames().sort());
});

test("resolveFormats: unknown name throws", () => {
  assert.throws(() => resolveFormats("bogus", "/tmp"), /Unknown format/);
  assert.throws(() => resolveFormats("claude,bogus,cursor", "/tmp"), /bogus/);
});

test("detectFormats: empty target falls back to claude", () => {
  withTmp((dir) => {
    assert.deepEqual(detectFormats(dir), ["claude"]);
  });
});

test("detectFormats: detects multiple AI tools by presence of telltale files", () => {
  withTmp((dir) => {
    mkdirSync(join(dir, ".claude"), { recursive: true });
    mkdirSync(join(dir, ".cursor"), { recursive: true });
    writeFileSync(join(dir, ".windsurfrules"), "");
    const d = detectFormats(dir);
    assert.ok(d.includes("claude"));
    assert.ok(d.includes("cursor"));
    assert.ok(d.includes("windsurf"));
  });
});

test("detectFormats: AGENTS.md and CONVENTIONS.md detected", () => {
  withTmp((dir) => {
    writeFileSync(join(dir, "AGENTS.md"), "");
    writeFileSync(join(dir, "CONVENTIONS.md"), "");
    const d = detectFormats(dir);
    assert.ok(d.includes("agents"));
    assert.ok(d.includes("aider"));
  });
});

test("detectFormats: CONTRIBUTING.md picked only when nothing else matches", () => {
  withTmp((dir) => {
    writeFileSync(join(dir, "CONTRIBUTING.md"), "");
    assert.deepEqual(detectFormats(dir), ["contributing"]);
  });
  withTmp((dir) => {
    writeFileSync(join(dir, "CONTRIBUTING.md"), "");
    mkdirSync(join(dir, ".claude"), { recursive: true });
    const d = detectFormats(dir);
    assert.ok(d.includes("claude"));
    assert.ok(!d.includes("contributing"));
  });
});

// Smoke tests for the three new renderers.
const sampleCluster = {
  label: ["test", "missing"],
  occurrences: 3, weightedOccurrences: 4, distinctAuthors: 2, distinctPRs: 3,
  authors: ["alice", "bob"], paths: ["src/a.ts"], kinds: ["request"],
  items: [
    { sentence: "Add tests for null inputs.", author: "alice", pr: 1, url: "u1", path: "src/a.ts" },
    { sentence: "Missing edge-case tests.", author: "bob", pr: 2, url: "u2", path: "src/a.ts" },
  ],
};

test("aider renderer writes CONVENTIONS.md with managed block", () => {
  withTmp((dir) => {
    const r = getRenderer("aider").write([sampleCluster], { targetDir: dir });
    assert.equal(r.written.length, 1);
    const body = readFileSync(r.written[0].path, "utf-8");
    assert.match(body, /reviewlore:start/);
    assert.match(body, /Recurring reviewer feedback/);
  });
});

test("agents renderer writes AGENTS.md", () => {
  withTmp((dir) => {
    const r = getRenderer("agents").write([sampleCluster], { targetDir: dir });
    assert.ok(r.written[0].path.endsWith("AGENTS.md"));
    const body = readFileSync(r.written[0].path, "utf-8");
    assert.match(body, /AI coding agents/);
  });
});

test("windsurf renderer writes .windsurfrules numbered list", () => {
  withTmp((dir) => {
    const r = getRenderer("windsurf").write([sampleCluster], { targetDir: dir });
    assert.ok(r.written[0].path.endsWith(".windsurfrules"));
    const body = readFileSync(r.written[0].path, "utf-8");
    assert.match(body, /reviewlore start/);
    assert.match(body, /^1\. /m);
  });
});
