// Turn a GitHub API failure into a message that says what to do. Returns
// text; cli/ prints it. Built only from the status, GitHub's own error
// message and owner/repo — never from headers or the request, so no token
// can appear in it.

import { RateLimitError } from "./rate-limit.mjs";

export function explainGitHubError(err, { owner, repo, host = "github.com", provider = "github" } = {}) {
  const name = owner && repo ? `${owner}/${repo}` : "the repository";
  const gitlab = provider === "gitlab";
  const login = gitlab ? "a new GITLAB_TOKEN (read_api scope)" : host === "github.com" ? "`gh auth login`" : `\`gh auth login --hostname ${host}\``;
  const message = String(err?.message ?? err ?? "");
  if (err instanceof RateLimitError) return message;
  const graphqlTypes = (err?.errors ?? []).map((e) => e?.type);

  if (err?.status === 401) {
    if (gitlab) return `${host} rejected the token (401): it is invalid or expired. Set ${login}.`;
    return `${host === "github.com" ? "GitHub" : host} rejected the token (401): it is invalid or expired. Run ${login} again, or set a new token.`;
  }
  if (err?.status === 403 && /SAML/i.test(message)) {
    return `Your token isn't authorised for ${owner ?? "this organisation"}'s SAML single sign-on. ` +
      "Authorise it under GitHub → Settings → Tokens → Configure SSO, or run `gh auth refresh`.";
  }
  if (err?.status === 403 && gitlab) {
    return `${host} refused access to ${name} (403). The token needs the read_api scope and access to the project.`;
  }
  if (err?.status === 403) {
    return `GitHub refused access to ${name} (403). The token needs read access to its pull requests: ` +
      "the `repo` scope for a private repository (`public_repo` is enough for a public one), " +
      "or \"Pull requests: read\" on a fine-grained token.";
  }
  if (err?.status === 404 || graphqlTypes.includes("NOT_FOUND")) {
    return `${name} wasn't found on ${host}, or your token can't see it (a private repository needs a token with access to it).`;
  }
  if (/ENOTFOUND|ECONNREFUSED|ECONNRESET|ETIMEDOUT|fetch failed/i.test(message) || /ENOTFOUND|ECONNREFUSED|ETIMEDOUT/.test(err?.cause?.code ?? "")) {
    return `Couldn't reach ${host === "github.com" ? "api.github.com" : host}. Check your network connection or proxy settings${host === "github.com" ? "" : " (an internal CA needs NODE_EXTRA_CA_CERTS)"}, then re-run.`;
  }
  if (err?.status >= 500) {
    return `GitHub had a server error (${err.status}). Re-run in a few minutes.`;
  }
  return message;
}
