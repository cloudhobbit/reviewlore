// Fetch progress for humans and agents, written to an injected stream
// (stderr from cli/). On a terminal one line is rewritten in place; in a
// log, a pipe or Claude Code's context it prints at most one line every
// `intervalMs`, so a 1,000-PR fetch doesn't produce 1,000 lines.
//
//   Fetching: reviews 61% · comments 74% · inline 40% · 23 requests · ~12 s left

const STREAMS = ["reviews", "comments", "inline"];

export function formatDuration(ms) {
  const s = Math.max(1, Math.round(ms / 1000));
  if (s < 90) return `${s} s`;
  return `${Math.round(s / 60)} min`;
}

// Remaining time from elapsed time and overall progress; null until
// there's enough to go on.
export function estimateRemaining(elapsedMs, fraction) {
  if (fraction <= 0.02 || elapsedMs < 2000) return null;
  if (fraction >= 1) return 0;
  return (elapsedMs * (1 - fraction)) / fraction;
}

export function createProgress({
  out,
  tty = Boolean(out?.isTTY) && !process.env.NO_COLOR,
  now = () => Date.now(),
  intervalMs = 5000,
  stats = { requests: 0 },
} = {}) {
  const started = now();
  const fractions = Object.fromEntries(STREAMS.map((s) => [s, 0]));
  const finishedAt = {};
  let lastPrinted = -Infinity;
  let pendingLine = false;

  const overall = () => STREAMS.reduce((sum, s) => sum + fractions[s], 0) / STREAMS.length;
  const line = () => {
    const parts = STREAMS.map((s) => `${s} ${Math.floor(fractions[s] * 100)}%`);
    parts.push(`${stats.requests} request${stats.requests === 1 ? "" : "s"}`);
    const left = estimateRemaining(now() - started, overall());
    if (left !== null && overall() < 1) parts.push(`~${formatDuration(left)} left`);
    return `Fetching: ${parts.join(" · ")}`;
  };

  const write = (text) => {
    if (!out) return;
    if (tty) {
      out.write(`\r\x1b[K${text}`);
      pendingLine = true;
    } else {
      out.write(`${text}\n`);
    }
  };
  const endLine = () => {
    if (pendingLine) out.write("\n");
    pendingLine = false;
  };

  return {
    stats,
    overall,
    update({ stream, fraction }) {
      if (stream in fractions) fractions[stream] = Math.max(fractions[stream], fraction);
      if (fraction >= 1 && stream in fractions) finishedAt[stream] ??= now();
      const t = now();
      if (tty || t - lastPrinted >= intervalMs) {
        lastPrinted = t;
        write(line());
      }
    },
    notice(message) {
      endLine();
      out?.write(`${message}\n`);
    },
    finish() {
      endLine();
      // Which list took longest: where to look if a fetch feels slow.
      const each = STREAMS.filter((s) => finishedAt[s] !== undefined).map((s) => `${s} ${formatDuration(finishedAt[s] - started)}`);
      out?.write(`Fetched in ${formatDuration(now() - started)}${each.length ? ` (${each.join(", ")})` : ""} · ${stats.requests} GitHub requests.\n`);
    },
  };
}
