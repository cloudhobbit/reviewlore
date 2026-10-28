// Which GitHub a repository lives on: github.com, GHE.com (<sub>.ghe.com)
// or a GitHub Enterprise Server host (docs/plans/02-github-enterprise.md).
// The host travels with owner/repo so the API URL, the token and the
// cache file always match the repository's own instance.

export const DOTCOM = "github.com";

// Hosts that are known not to be GitHub: refuse rather than call their API.
const NOT_GITHUB = /(^|\.)(bitbucket\.org|dev\.azure\.com|visualstudio\.com|codeberg\.org|gitea\.com|sr\.ht)$/i;

// GitLab (docs/plans/14): gitlab.com, or a self-managed host with a
// "gitlab" label (gitlab.acme.corp). Other self-managed GitLab hosts need
// --provider gitlab: they look like any other server.
export const isGitLabHost = (host) => /(^|\.)gitlab(\.|$)/i.test(String(host ?? "").replace(/:\d+$/, ""));

// A host name as cache keys and messages use it: lower-cased, port kept.
// github.com, www.github.com and SSH aliases like "github.com-work" (a
// common ~/.ssh/config trick for multiple accounts) are all github.com.
export function normalizeHost(host) {
  const h = String(host ?? "").trim().toLowerCase();
  if (h === "www.github.com" || /^github\.com(-[^.:]+)?$/.test(h)) return DOTCOM;
  return h;
}

export const isValidHost = (host) => /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*(:\d{1,5})?$/.test(host);

// "dotcom" | "ghe.com" | "ghes" | null (not a GitHub host, or can't tell).
export function hostKind(host) {
  const h = normalizeHost(host);
  if (h === DOTCOM) return "dotcom";
  if (isGitLabHost(h)) return null;
  if (!isValidHost(h) || NOT_GITHUB.test(h.replace(/:\d+$/, ""))) return null;
  // A dotless name is an SSH alias we can't resolve without ~/.ssh/config.
  if (!h.replace(/:\d+$/, "").includes(".")) return null;
  if (/\.ghe\.com$/.test(h)) return "ghe.com";
  return "ghes";
}

// REST base URL for a host. GraphQL is derived from it by Octokit
// (…/api/v3 → …/api/graphql on GHES).
export function apiBaseUrl(host) {
  const h = normalizeHost(host);
  const kind = hostKind(h);
  if (kind === "dotcom") return "https://api.github.com";
  if (kind === "ghe.com") return `https://api.${h}`;
  if (kind === "ghes") return `https://${h}/api/v3`;
  return null;
}

// Why a host isn't usable, in words for an error message.
export function hostProblem(host) {
  const h = normalizeHost(host);
  if (hostKind(h)) return null;
  if (isGitLabHost(h)) return `${h} is GitLab: pass --provider gitlab.`;
  if (NOT_GITHUB.test(h.replace(/:\d+$/, ""))) return `${h} isn't supported: only GitHub (github.com, GHE.com, Enterprise Server) and GitLab are, so far.`;
  if (isValidHost(h) && !h.includes(".")) return `can't tell which GitHub host "${h}" is (an SSH alias?); pass --host <hostname>.`;
  return `"${host}" isn't a valid host name.`;
}

// The host and API URL to use, in order: --api-url, --host, the git
// remote's host (when owner/repo came from it), GITHUB_API_URL inside
// GitHub Actions, GH_HOST, github.com.
//   → { host, baseUrl, source } or { error }
export function resolveHost({ flagHost, flagApiUrl, detectedHost, env = process.env } = {}) {
  if (flagApiUrl) {
    let url;
    try {
      url = new URL(flagApiUrl);
    } catch {
      return { error: `--api-url "${flagApiUrl}" isn't a URL.` };
    }
    if (url.protocol !== "https:" && url.protocol !== "http:") return { error: "--api-url must be an http(s) URL." };
    const apiHost = normalizeHost(url.host);
    // https://api.github.com → github.com; https://api.acme.ghe.com → acme.ghe.com
    const host = apiHost === "api.github.com" ? DOTCOM : apiHost.replace(/^api\.(?=[^.]+\.ghe\.com$)/, "");
    return { host, baseUrl: flagApiUrl.replace(/\/+$/, ""), source: "--api-url" };
  }
  const pick = (host, source) => {
    const problem = hostProblem(host);
    return problem ? { error: problem } : { host: normalizeHost(host), baseUrl: apiBaseUrl(host), source };
  };
  if (flagHost) return pick(flagHost, "--host");
  if (detectedHost) return pick(detectedHost, "git remote");
  if (env.GITHUB_ACTIONS === "true" && env.GITHUB_API_URL) {
    return resolveHost({ flagApiUrl: env.GITHUB_API_URL, env: {} });
  }
  if (env.GH_HOST) return pick(env.GH_HOST, "GH_HOST");
  return { host: DOTCOM, baseUrl: apiBaseUrl(DOTCOM), source: "default" };
}

// Path-safe form of a host for cache directories (":" isn't valid on Windows).
export const hostDirName = (host) => normalizeHost(host).replace(/:/g, "_");
