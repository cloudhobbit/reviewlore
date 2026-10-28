// Retry and rate-limit handling for every GitHub request (REST and
// GraphQL both go through Octokit's "request" hook).
//
// GitHub's guidance (docs.github.com, "Rate limits for the REST API"):
// honour `retry-after`; when `x-ratelimit-remaining` is 0, wait until
// `x-ratelimit-reset`; for a secondary limit without headers wait at
// least a minute and back off exponentially. 502/504 are retried briefly.
//
// Messages never include header values or anything from the request, so
// no token can end up in them.

export class RateLimitError extends Error {
  constructor(message, resetAt) {
    super(message);
    this.name = "RateLimitError";
    this.resetAt = resetAt;
  }
}

const MAX_ATTEMPTS = 3;

function header(err, name) {
  const h = err?.response?.headers ?? {};
  return h[name] ?? h[name.toLowerCase()];
}

function hhmm(date) {
  return `${date.toISOString().slice(11, 16)} UTC`;
}

// Pure: what to do about `err` on the given (0-based) attempt.
// Returns { retry: true, waitMs, reason } or { retry: false, error? }.
export function retryDecision(err, attempt, { now = Date.now(), maxWaitMs = 60_000 } = {}) {
  const status = err?.status;
  if (status === 502 || status === 504) {
    return attempt < 2 ? { retry: true, waitMs: 1000 * 2 ** attempt, reason: `GitHub returned ${status}` } : { retry: false };
  }
  if (status !== 403 && status !== 429) return { retry: false };

  const retryAfter = Number(header(err, "retry-after"));
  if (Number.isFinite(retryAfter) && retryAfter >= 0) {
    const waitMs = retryAfter * 1000;
    if (attempt >= MAX_ATTEMPTS) return { retry: false, error: limitError("GitHub's secondary rate limit") };
    if (waitMs > maxWaitMs) return { retry: false, error: limitError("GitHub's secondary rate limit", new Date(now + waitMs)) };
    return { retry: true, waitMs, reason: "secondary rate limit" };
  }

  if (header(err, "x-ratelimit-remaining") === "0") {
    const reset = new Date(Number(header(err, "x-ratelimit-reset")) * 1000);
    const waitMs = Math.max(0, reset.getTime() - now) + 1000;
    if (attempt >= 1 || waitMs > maxWaitMs || Number.isNaN(reset.getTime())) {
      return { retry: false, error: limitError("GitHub's API rate limit", Number.isNaN(reset.getTime()) ? null : reset) };
    }
    return { retry: true, waitMs, reason: "rate limit" };
  }

  // A secondary limit is a 403/429 whose message says so; other 403s are
  // permission problems and must not be retried.
  if (/secondary rate limit|abuse/i.test(err?.message ?? "") || status === 429) {
    const waitMs = 60_000 * 2 ** attempt;
    if (attempt >= MAX_ATTEMPTS) return { retry: false, error: limitError("GitHub's secondary rate limit") };
    if (waitMs > maxWaitMs) return { retry: false, error: limitError("GitHub's secondary rate limit", new Date(now + waitMs)) };
    return { retry: true, waitMs, reason: "secondary rate limit" };
  }
  return { retry: false };
}

function limitError(what, resetAt = null) {
  const when = resetAt ? `; it resets at ${hhmm(resetAt)}` : "";
  return new RateLimitError(`Hit ${what}${when}. Re-run then.`, resetAt);
}

// Wraps every request with retries. `onWait({ waitMs, reason })` lets the
// caller report the pause; `stats.requests` counts requests sent.
export function installRetry(octokit, {
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  now = () => Date.now(),
  maxWaitMs = 60_000,
  onWait,
  stats = { requests: 0 },
} = {}) {
  octokit.hook.wrap("request", async (request, options) => {
    for (let attempt = 0; ; attempt++) {
      stats.requests++;
      try {
        return await request(options);
      } catch (err) {
        const d = retryDecision(err, attempt, { now: now(), maxWaitMs });
        if (!d.retry) throw d.error ?? err;
        onWait?.({ waitMs: d.waitMs, reason: d.reason });
        await sleep(d.waitMs);
      }
    }
  });
  return stats;
}
