import { test } from "node:test";
import assert from "node:assert/strict";
import { synthesiseAll } from "../lib/llm.mjs";

// We can't easily mock @anthropic-ai/sdk's ESM default export from here,
// so these tests cover the error paths that don't require the SDK at all:
// missing API key, and graceful surfacing when a cluster errors.

test("synthesiseAll: surfaces missing ANTHROPIC_API_KEY as a per-cluster error", async () => {
  const old = process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  try {
    const clusters = [
      {
        label: ["a", "b"], items: [{ sentence: "x", author: "u", pr: 1, url: "u" }],
        occurrences: 1, distinctAuthors: 1, distinctPRs: 1, paths: [], kinds: [],
      },
    ];
    const out = await synthesiseAll(clusters);
    assert.equal(out.length, 1);
    assert.ok(out[0]._error);
    assert.match(out[0]._error, /ANTHROPIC_API_KEY/);
  } finally {
    if (old !== undefined) process.env.ANTHROPIC_API_KEY = old;
  }
});

test("synthesiseAll: processes empty cluster list without API key", async () => {
  const old = process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  try {
    const out = await synthesiseAll([]);
    assert.equal(out.length, 0);
  } finally {
    if (old !== undefined) process.env.ANTHROPIC_API_KEY = old;
  }
});
