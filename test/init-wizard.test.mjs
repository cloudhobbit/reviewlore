import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const REPO_ROOT = resolve(import.meta.dirname, "..");
const TOOLKIT_BIN = join(REPO_ROOT, "cli", "reviewlore.mjs");

function runWizard(cwd, stdinLines) {
  return spawnSync("node", [TOOLKIT_BIN, "init"], {
    cwd,
    input: stdinLines.join("\n") + "\n",
    encoding: "utf-8",
    env: { ...process.env, GITHUB_TOKEN: "" },
  });
}

test("init wizard re-prompts on unknown --format token and saves only valid choice", () => {
  const tmp = mkdtempSync(join(tmpdir(), "pr-init-fmt-"));
  try {
    // Order of prompts: owner, repo, target, format, preset, llm (y/n),
    // months. Target defaults to "." (the cwd we just created), preset/llm/
    // months use defaults. Format: first typo "claud", then "claude".
    const r = runWizard(tmp, [
      "acme",      // owner
      "demo",      // repo
      "",          // target → default "."
      "claud",     // format typo → wizard must reject and re-prompt
      "claude",    // format retry → accepted
      "",          // preset → default
      "",          // llm → default "n"
      "",          // months → default 6
    ]);
    assert.equal(r.status, 0, `wizard exited non-zero. stderr=\n${r.stderr}`);
    // The retry-loop message must surface so the user knows their typo
    // was caught (before the fix, no such message — "claud" was silently saved).
    assert.match(r.stderr, /Unknown format "claud"/);
    const configPath = join(tmp, ".reviewlore.json");
    assert.ok(existsSync(configPath), "config file should be written");
    const cfg = JSON.parse(readFileSync(configPath, "utf-8"));
    // Bug regression check: format must never be the typo "claud".
    assert.notEqual(cfg.format, "claud");
    assert.equal(cfg.format, "claude");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("init wizard accepts 'auto' as whole-arg format value", () => {
  const tmp = mkdtempSync(join(tmpdir(), "pr-init-auto-"));
  try {
    const r = runWizard(tmp, [
      "acme", "demo", "", "auto", "", "", "",
    ]);
    assert.equal(r.status, 0, `wizard exited non-zero. stderr=\n${r.stderr}`);
    const cfg = JSON.parse(readFileSync(join(tmp, ".reviewlore.json"), "utf-8"));
    assert.equal(cfg.format, "auto");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

