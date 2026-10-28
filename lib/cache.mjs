// Append-only JSON cache for fetched PR comments. Lets `reviewlore fetch`
// avoid re-paginating GitHub on every run, and gives `reviewlore generate`
// a stable "previous run" to diff against.
//
// Layout: $REVIEWLORE_CACHE_DIR (or ~/.reviewlore) /
//   <owner>__<repo>.json                      (github.com)
//   hosts/<host>/<owner>__<repo>.json         (GHE.com, GitHub Enterprise Server)
//
// Each file mirrors the JSON shape produced by `reviewlore fetch`
// (issue_comments / review_comments / review_submissions) with an
// additional meta.last_fetched_at field for the incremental cutoff.
//
// Pure JSON instead of SQLite to keep the toolkit dep-free. A 12-month
// window on an active repo is typically a few MB — readable and
// versionable with git if the user chooses.

import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { dedupBy } from "./filters.mjs";
import { DOTCOM, normalizeHost, hostDirName } from "./github-host.mjs";

export function cacheDir() {
  return process.env.REVIEWLORE_CACHE_DIR ?? join(homedir(), ".reviewlore");
}

// Per host, so github.com/acme/app and ghe.acme.corp/acme/app never share
// a file. github.com keeps the original location.
function repoFile(owner, repo, host, suffix) {
  const h = normalizeHost(host ?? DOTCOM);
  const base = h === DOTCOM ? cacheDir() : join(cacheDir(), "hosts", hostDirName(h));
  // GitLab namespaces nest ("group/sub"): "/" → "+", which GitLab paths
  // can't contain.
  return join(base, `${String(owner).replace(/\//g, "+")}__${repo}${suffix}`);
}

export function cachePath(owner, repo, host = DOTCOM) {
  return repoFile(owner, repo, host, ".json");
}

export function loadCache(owner, repo, host = DOTCOM) {
  const path = cachePath(owner, repo, host);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    return null;
  }
}

// Merge a freshly-fetched output with an existing cache. Deduplicates by
// comment_id / review_id; later (newer) wins on conflict.
//
// Concurrent invocations against the same (owner, repo) — CI matrices,
// `--cache` runs racing a scheduled job, two shells running `&` — must
// not interleave the read-modify-write window or one writer's data is
// silently lost. We hold an exclusive O_EXCL lock file across the
// load → merge → save window, and saveCache itself writes atomically
// via a temp-file rename so a half-written file can never be observed.
export function mergeIntoCache(owner, repo, freshOutput, host = freshOutput?.meta?.host ?? DOTCOM) {
  const release = acquireLock(owner, repo, host);
  try {
    const stamped = {
      ...freshOutput,
      meta: { ...freshOutput.meta, last_fetched_at: freshOutput.meta?.fetched_at },
    };
    const existing = loadCache(owner, repo, host);
    if (!existing) return saveCache(owner, repo, stamped, host);

    const merged = {
      meta: {
        ...existing.meta,
        ...freshOutput.meta,
        // The cache covers from the earliest window ever fetched. (An
        // incremental fetch's `since` is just its cutoff; letting it win
        // made the cache claim it only held the last few days.)
        since: earliestIso(existing.meta?.since, freshOutput.meta?.since),
        months_back: Math.max(existing.meta?.months_back ?? 0, freshOutput.meta?.months_back ?? 0) || undefined,
        last_fetched_at: freshOutput.meta.fetched_at,
        pr_authors: { ...(existing.meta?.pr_authors ?? {}), ...(freshOutput.meta?.pr_authors ?? {}) },
      },
      issue_comments: dedupBy(
        [...(existing.issue_comments ?? []), ...(freshOutput.issue_comments ?? [])],
        "comment_id",
      ),
      review_comments: dedupBy(
        [...(existing.review_comments ?? []), ...(freshOutput.review_comments ?? [])],
        "comment_id",
      ),
      review_submissions: dedupBy(
        [...(existing.review_submissions ?? []), ...(freshOutput.review_submissions ?? [])],
        "review_id",
      ),
    };
    merged.meta.totals = {
      issue_comments: merged.issue_comments.length,
      review_comments: merged.review_comments.length,
      review_submissions: merged.review_submissions.length,
      total:
        merged.issue_comments.length +
        merged.review_comments.length +
        merged.review_submissions.length,
    };
    return saveCache(owner, repo, merged, host);
  } finally {
    release();
  }
}

// POSIX `rename(2)` on the same filesystem is atomic — readers either
// see the previous file or the new one, never a truncated half-write.
export function saveCache(owner, repo, output, host = DOTCOM) {
  const path = cachePath(owner, repo, host);
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp.${process.pid}.${Math.random().toString(36).slice(2)}`;
  writeFileSync(tmp, JSON.stringify(output, null, 2), "utf-8");
  try {
    renameSync(tmp, path);
  } catch (err) {
    try { unlinkSync(tmp); } catch {}
    throw err;
  }
  return path;
}

// O_EXCL lock file with stale-lock recovery. Cross-process safe on a
// single filesystem; deliberately not using a runtime dep (proper-lockfile)
// since this is a one-shot CLI and the surface is tiny.
const LOCK_STALE_MS = 30_000;
const LOCK_RETRY_MS = 25;
const LOCK_MAX_WAIT_MS = 15_000;

function acquireLock(owner, repo, host = DOTCOM) {
  const lockPath = `${cachePath(owner, repo, host)}.lock`;
  mkdirSync(dirname(lockPath), { recursive: true });
  const start = Date.now();
  let fd;
  while (true) {
    try {
      fd = openSync(lockPath, "wx");
      break;
    } catch (err) {
      if (err.code !== "EEXIST") throw err;
      // Stale-lock recovery: if the lock file is older than the threshold
      // the previous holder crashed without releasing — reclaim it.
      try {
        const age = Date.now() - statSync(lockPath).mtimeMs;
        if (age > LOCK_STALE_MS) {
          try { unlinkSync(lockPath); } catch {}
          continue;
        }
      } catch {
        continue;
      }
      if (Date.now() - start > LOCK_MAX_WAIT_MS) {
        throw new Error(
          `reviewlore: timed out waiting for cache lock at ${lockPath}. ` +
            `Delete it manually if no other run is in progress.`,
        );
      }
      sleepSync(LOCK_RETRY_MS);
    }
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    try { closeSync(fd); } catch {}
    try { unlinkSync(lockPath); } catch {}
  };
}

function sleepSync(ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) { /* busy-wait — fine for sub-25ms naps */ }
}

function earliestIso(a, b) {
  if (!a) return b;
  if (!b) return a;
  return new Date(a) <= new Date(b) ? a : b;
}

// Returns the date to use for an incremental fetch — the cache's
// last_fetched_at — or null when the caller must fetch its whole window:
// no cache, or a cache that doesn't reach back to `requestedSince` (e.g.
// asking for 12 months with 6 cached), which fetching the full window
// backfills.
export function incrementalSince(owner, repo, requestedSince, host = DOTCOM) {
  const c = loadCache(owner, repo, host);
  if (!c?.meta?.last_fetched_at) return null;
  if (requestedSince && !(c.meta.since && new Date(c.meta.since) <= requestedSince)) return null;
  return new Date(c.meta.last_fetched_at);
}

// ---- Partial fetches (resume) -------------------------------------------
//
// A fetch that stops early (time budget, rate limit, kill) leaves
// <owner>__<repo>.partial.json: each stream's records so far plus where to
// resume. The next fetch of the same repo picks it up when its window
// covers the one requested; success deletes it. Same sensitivity as the
// cache itself (comment bodies), same directory.

const PARTIAL_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
// 3: comment streams resume per time slice, reviews per PR. Older partials
// are ignored.
export const PARTIAL_VERSION = 3;
const DAY_MS = 24 * 60 * 60 * 1000;

export function partialPath(owner, repo, host = DOTCOM) {
  return repoFile(owner, repo, host, ".partial.json");
}

export function savePartial(owner, repo, partial, host = DOTCOM) {
  const path = partialPath(owner, repo, host);
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp.${process.pid}.${Math.random().toString(36).slice(2)}`;
  writeFileSync(tmp, JSON.stringify(partial), "utf-8");
  try {
    renameSync(tmp, path);
  } catch (err) {
    try { unlinkSync(tmp); } catch {}
    throw err;
  }
  return path;
}

// The partial to resume for a fetch of [requestedSince, now], or null.
// Its window must start no later than requested (a day's slack: the
// window start moves with the clock) and it must be under a week old.
export function loadPartial(owner, repo, requestedSince, now = Date.now(), host = DOTCOM) {
  const path = partialPath(owner, repo, host);
  if (!existsSync(path)) return null;
  let p;
  try {
    p = JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    return null;
  }
  if (p?.version !== PARTIAL_VERSION || !p.since || !p.started_at || !p.streams) return null;
  if (Date.parse(p.since) > requestedSince.getTime() + DAY_MS) return null;
  if (now - Date.parse(p.started_at) > PARTIAL_MAX_AGE_MS) return null;
  return p;
}

export function deletePartial(owner, repo, host = DOTCOM) {
  try { unlinkSync(partialPath(owner, repo, host)); } catch {}
}
