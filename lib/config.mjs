// Repo-level config file: .reviewlore.json
//
// Written by the `init` wizard. Read at the start of every
// reviewlore run if present. Lets teams version their tuning
// decisions instead of re-discovering CLI flags each time.
//
// Lookup order (first hit wins):
//   1. Path passed via --config <path>
//   2. <cwd>/.reviewlore.json
//   3. <target>/.reviewlore.json
//   4. None.
//
// Precedence: explicit CLI flag > config file > preset > built-in default.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

export const CONFIG_FILENAME = ".reviewlore.json";

export function findConfigPath({ explicit, cwd = process.cwd(), targetDir } = {}) {
  if (explicit) {
    const p = resolve(explicit);
    return existsSync(p) ? p : null;
  }
  const cwdPath = join(cwd, CONFIG_FILENAME);
  if (existsSync(cwdPath)) return cwdPath;
  if (targetDir) {
    const targetPath = join(resolve(targetDir), CONFIG_FILENAME);
    if (existsSync(targetPath)) return targetPath;
  }
  return null;
}

export function loadConfig(path) {
  if (!path || !existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf-8"));
  } catch (e) {
    throw new Error(`Failed to parse ${path}: ${e.message}`);
  }
}

// Apply config defaults: only fill in args that aren't already set.
// Same precedence rule as applyPreset — explicit user flags win.
export function applyConfig(args, config) {
  if (!config) return args;
  for (const [k, v] of Object.entries(config)) {
    if (args[k] === undefined && v !== undefined && v !== null) {
      args[k] = typeof v === "boolean" ? v : String(v);
    }
  }
  return args;
}

export function saveConfig(path, data) {
  writeFileSync(path, JSON.stringify(data, null, 2) + "\n", "utf-8");
}
