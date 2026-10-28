// The fetcher for a repository's provider (docs/plans/14): GitHub through
// Octokit (lib/github-client.mjs, loaded only when needed), GitLab through
// lib/providers/gitlab.mjs and Node's fetch. Returns a function with the
// fetchCorpus options, or { error } when no token can be found — never
// printing anything (cli/ does that).

import { fetchCorpus } from "../fetchers.mjs";
import { resolveGitLabToken, noGitLabTokenMessage, createGitLabTransport, fetchGitLabCorpus } from "./gitlab.mjs";
import { PACKAGE_ROOT } from "../doctor.mjs";

export const MISSING_DEPS =
  "Fetching from GitHub needs reviewlore's npm dependencies (@octokit/rest), which aren't installed. " +
  "If you installed the Claude Code plugin, reinstall it (npm must be on your PATH); " +
  `otherwise run \`npm install\` in ${PACKAGE_ROOT}.`;

// where: { owner, repo, host, baseUrl, provider } from resolveRepo.
//   → { fetch(opts) → corpus } | { error }
export async function openFetcher(where, { token, env = process.env } = {}) {
  if (where.provider === "gitlab") {
    const resolved = resolveGitLabToken({ token, env });
    if (!resolved) return { error: noGitLabTokenMessage(where.host) };
    const transport = createGitLabTransport({ host: where.host, token: resolved.token, baseUrl: where.baseUrl });
    return { fetch: (opts) => fetchGitLabCorpus(transport, { ...opts, owner: where.owner, repo: where.repo, host: where.host }) };
  }
  let gh;
  try {
    gh = await import("../github-client.mjs");
  } catch (e) {
    if (e.code !== "ERR_MODULE_NOT_FOUND") throw e;
    return { error: MISSING_DEPS };
  }
  if (!gh.resolveToken({ token, host: where.host, env })) return { error: gh.noTokenMessage(where.host) };
  const octokit = gh.createClient({ token, host: where.host, baseUrl: where.baseUrl });
  return { fetch: (opts) => fetchCorpus(octokit, { ...opts, owner: where.owner, repo: where.repo, host: where.host }) };
}
