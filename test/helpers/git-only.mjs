// A directory to put on PATH that holds `git` and nothing else that matters:
// no `gh` (it often sits next to git), so a CLI under test can't resolve a
// token or reach a server even if it regresses.
import { mkdirSync, symlinkSync } from "node:fs";
import { join, dirname } from "node:path";
import { spawnSync } from "node:child_process";

export function gitOnlyDir(parent) {
  // Windows: git.exe sits in Git\cmd, apart from gh, and symlinks need admin.
  if (process.platform === "win32") return dirname(spawnSync("where", ["git"], { encoding: "utf-8" }).stdout.split(/\r?\n/)[0]);
  const binDir = join(parent, ".bin-git-only");
  mkdirSync(binDir);
  symlinkSync(spawnSync("sh", ["-c", "command -v git"], { encoding: "utf-8" }).stdout.trim(), join(binDir, "git"));
  return binDir;
}
