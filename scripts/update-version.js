#!/usr/bin/env node
// Sync the `VERSION = "..."` constant in the CLI entry points, and the
// Claude Code plugin manifest's version, to package.json's version.
// Runs automatically via `npm version <bump>` (see package.json scripts.version).

import { readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf-8"));
const version = pkg.version;

const targets = [
  join(root, "cli", "reviewlore.mjs"),
  join(root, "cli", "commands", "fetch.mjs"),
  join(root, "cli", "commands", "generate.mjs"),
  join(root, "cli", "commands", "mcp.mjs"),
  join(root, "cli", "commands", "export.mjs"),
];

const VERSION_RE = /^const VERSION = "[^"]+";$/m;

for (const file of targets) {
  const content = readFileSync(file, "utf-8");
  if (!VERSION_RE.test(content)) {
    console.error(`update-version: no VERSION line in ${file}`);
    process.exit(1);
  }
  const updated = content.replace(VERSION_RE, `const VERSION = "${version}";`);
  writeFileSync(file, updated, "utf-8");
  console.log(`  ✓ ${file} → ${version}`);
}

// Plugin installs are pinned to this version; a stale value would keep
// users on an old release after `npm version`.
const manifestPath = join(root, ".claude-plugin", "plugin.json");
const manifest = JSON.parse(readFileSync(manifestPath, "utf-8"));
manifest.version = version;
writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf-8");
console.log(`  ✓ ${manifestPath} → ${version}`);
