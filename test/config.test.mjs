import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  findConfigPath, loadConfig, applyConfig, saveConfig, CONFIG_FILENAME,
} from "../lib/config.mjs";

function withTmp(fn) {
  const dir = mkdtempSync(join(tmpdir(), "cfg-"));
  try { return fn(dir); } finally { rmSync(dir, { recursive: true, force: true }); }
}

test("findConfigPath: returns null when no config exists", () => {
  withTmp((dir) => {
    assert.equal(findConfigPath({ cwd: dir }), null);
  });
});

test("findConfigPath: finds config in cwd", () => {
  withTmp((dir) => {
    const path = join(dir, CONFIG_FILENAME);
    writeFileSync(path, "{}");
    assert.equal(findConfigPath({ cwd: dir }), path);
  });
});

test("findConfigPath: finds config in targetDir if not in cwd", () => {
  withTmp((dir) => {
    withTmp((tdir) => {
      const path = join(tdir, CONFIG_FILENAME);
      writeFileSync(path, "{}");
      assert.equal(findConfigPath({ cwd: dir, targetDir: tdir }), path);
    });
  });
});

test("findConfigPath: cwd wins over targetDir", () => {
  withTmp((dir) => {
    withTmp((tdir) => {
      const cwdPath = join(dir, CONFIG_FILENAME);
      const tPath = join(tdir, CONFIG_FILENAME);
      writeFileSync(cwdPath, "{}");
      writeFileSync(tPath, "{}");
      assert.equal(findConfigPath({ cwd: dir, targetDir: tdir }), cwdPath);
    });
  });
});

test("findConfigPath: explicit --config path takes priority and validates existence", () => {
  withTmp((dir) => {
    const cfg = join(dir, "custom.json");
    writeFileSync(cfg, "{}");
    assert.equal(findConfigPath({ explicit: cfg, cwd: dir }), cfg);
    // explicit but missing → null (not silent fallback)
    assert.equal(findConfigPath({ explicit: join(dir, "nope.json"), cwd: dir }), null);
  });
});

test("loadConfig: parses valid JSON; throws on garbage", () => {
  withTmp((dir) => {
    const path = join(dir, CONFIG_FILENAME);
    writeFileSync(path, '{"owner":"x"}');
    assert.deepEqual(loadConfig(path), { owner: "x" });
    writeFileSync(path, "not json {");
    assert.throws(() => loadConfig(path), /Failed to parse/);
  });
});

test("applyConfig: fills in unset values; user args win", () => {
  const args = { owner: "user-set" };
  applyConfig(args, { owner: "config", repo: "config-repo" });
  assert.equal(args.owner, "user-set");
  assert.equal(args.repo, "config-repo");
});

test("applyConfig: handles booleans correctly", () => {
  const args = {};
  applyConfig(args, { llm: true });
  assert.equal(args.llm, true);
});

test("saveConfig + loadConfig roundtrip", () => {
  withTmp((dir) => {
    const path = join(dir, CONFIG_FILENAME);
    const data = { owner: "o", repo: "r", preset: "team-of-3", llm: false };
    saveConfig(path, data);
    assert.ok(existsSync(path));
    assert.deepEqual(loadConfig(path), data);
  });
});

test("applyConfig + applyPreset: config-supplied preset expands into per-flag defaults", async () => {
  // Regression: previously the bin ran applyPreset BEFORE applyConfig, so a
  // config file written by the wizard containing only { preset: "team-of-50" }
  // never expanded into min-occurrences / engine — the preset silently did
  // nothing. The fix runs applyConfig first, then applyPreset.
  const { applyPreset } = await import("../lib/presets.mjs");
  const args = {};
  // Simulate config { preset: "team-of-50" } with no CLI overrides.
  applyConfig(args, { preset: "team-of-50" });
  assert.equal(args.preset, "team-of-50", "config should fill args.preset");
  applyPreset(args, args.preset);
  // team-of-50 sets min-occurrences=5, min-authors=3, engine=semantic.
  assert.equal(args["min-occurrences"], "5");
  assert.equal(args["min-authors"], "3");
  assert.equal(args.engine, "semantic");
});

test("applyConfig + applyPreset: explicit CLI preset wins over config preset", async () => {
  const { applyPreset } = await import("../lib/presets.mjs");
  // User passed --preset team-of-3 on the CLI; config says team-of-50.
  const args = { preset: "team-of-3" };
  applyConfig(args, { preset: "team-of-50" });
  assert.equal(args.preset, "team-of-3", "CLI preset must win over config preset");
  applyPreset(args, args.preset);
  // team-of-3 thresholds, not team-of-50.
  assert.equal(args["min-occurrences"], "2");
  assert.equal(args["min-authors"], "2");
});

