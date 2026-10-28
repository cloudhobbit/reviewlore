import { Octokit } from "@octokit/rest";
import { spawnSync } from "node:child_process";
import { DOTCOM, normalizeHost, hostKind, apiBaseUrl } from "./github-host.mjs";

// The token for the repository's own GitHub host (docs/plans/02), never
// another host's: a github.com credential must not reach an enterprise
// server, or the reverse. Order, following the gh CLI's conventions:
//   github.com / GHE.com: --token, GH_TOKEN, GITHUB_TOKEN, `gh auth token --hostname <host>`
//   GitHub Enterprise Server, and any host that isn't recognisably github.com
//   or GHE.com (an --api-url pointing at an intranet name): --token,
//     GH_ENTERPRISE_TOKEN, GITHUB_ENTERPRISE_TOKEN, GITHUB_TOKEN only inside
//     GitHub Actions running on that same server, `gh auth token --hostname <host>`
// Returns { token, source, host } or null. The token never goes into messages.
export function resolveToken({ token, host = DOTCOM, env = process.env, gh = tryGhAuthToken } = {}) {
  const h = normalizeHost(host);
  const found = (value, source) => ({ token: value, source, host: h });
  if (token) return found(token, "flag");
  if (isDotcomLike(h)) {
    if (env.GH_TOKEN) return found(env.GH_TOKEN, "GH_TOKEN");
    if (env.GITHUB_TOKEN) return found(env.GITHUB_TOKEN, "GITHUB_TOKEN");
  } else {
    if (env.GH_ENTERPRISE_TOKEN) return found(env.GH_ENTERPRISE_TOKEN, "GH_ENTERPRISE_TOKEN");
    if (env.GITHUB_ENTERPRISE_TOKEN) return found(env.GITHUB_ENTERPRISE_TOKEN, "GITHUB_ENTERPRISE_TOKEN");
    if (env.GITHUB_TOKEN && env.GITHUB_ACTIONS === "true" && actionsHost(env) === h) return found(env.GITHUB_TOKEN, "GITHUB_TOKEN");
  }
  const ghToken = gh(h);
  return ghToken ? found(ghToken, "gh-cli") : null;
}

// github.com and GHE.com take the gh CLI's general tokens; every other host
// is treated as an enterprise server, so they never reach it.
const isDotcomLike = (host) => ["dotcom", "ghe.com"].includes(hostKind(host));

// The GitHub instance an Actions run belongs to.
function actionsHost(env) {
  try {
    const u = new URL(env.GITHUB_API_URL);
    return normalizeHost(u.pathname.startsWith("/api/v3") ? u.host : u.host.replace(/^api\./, ""));
  } catch {
    return null;
  }
}

function tryGhAuthToken(host) {
  try {
    const r = spawnSync("gh", ["auth", "token", "--hostname", host], { encoding: "utf-8", timeout: 2000 });
    if (r.status === 0 && r.stdout) {
      const t = r.stdout.trim();
      if (t.length > 0) return t;
    }
  } catch {
    /* gh not installed, or it errored — fall through */
  }
  return null;
}

export function noTokenMessage(host = DOTCOM) {
  const h = normalizeHost(host);
  if (h === DOTCOM) return "No GitHub token found. Either pass --token, set GITHUB_TOKEN, or run `gh auth login`.";
  const envVar = isDotcomLike(h) ? "GH_TOKEN" : "GH_ENTERPRISE_TOKEN";
  return `No token for ${h}. Run \`gh auth login --hostname ${h}\`, set ${envVar}, or pass --token.`;
}

export function createClient({ token, host = DOTCOM, baseUrl = apiBaseUrl(host) } = {}) {
  const resolved = resolveToken({ token, host });
  if (!resolved) throw new Error(noTokenMessage(host));
  return new Octokit({
    auth: resolved.token,
    baseUrl,
    userAgent: "reviewlore",
    // Octokit logs every failed request ("GET … - 403 with id …") on its
    // own, mid-progress line; reviewlore reports failures itself.
    log: { debug() {}, info() {}, warn: console.warn, error() {} },
  });
}
