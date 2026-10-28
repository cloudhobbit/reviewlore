// Private temp files for `candidates --save` / `--discard`.
//
// The plugin skill used `mktemp` and `rm` in bash, which don't exist in
// PowerShell or cmd. Doing it in Node keeps the skill's commands valid in
// any shell. The file holds reviewers' comments, so it is created 0600 in
// a fresh directory, and `--discard` deletes only files this module made.

import { mkdtempSync, writeFileSync, rmSync, realpathSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, basename, resolve } from "node:path";

const PREFIX = "reviewlore-";
const FILENAME = "candidates.json";

export function saveScratch(text, { base = tmpdir() } = {}) {
  const dir = mkdtempSync(join(base, PREFIX));
  const file = join(dir, FILENAME);
  writeFileSync(file, text, { mode: 0o600 });
  return file;
}

function real(p) {
  try {
    return realpathSync(p);
  } catch {
    return resolve(p);
  }
}

// Deletes a file made by saveScratch (and its directory). Throws for any
// other path, so a mistyped argument can't delete something else.
export function discardScratch(path, { base = tmpdir() } = {}) {
  const file = resolve(path);
  const dir = dirname(file);
  const ours = basename(file) === FILENAME &&
    basename(dir).startsWith(PREFIX) &&
    real(dirname(dir)) === real(base);
  if (!ours) {
    throw new Error(`refusing to delete ${path}: not a file written by \`candidates --save\``);
  }
  if (!existsSync(file)) return false;
  rmSync(dir, { recursive: true, force: true });
  return true;
}
