import { test } from "node:test";
import assert from "node:assert/strict";
import { explainGitHubError } from "../lib/github-errors.mjs";
import { RateLimitError } from "../lib/rate-limit.mjs";
import { explainEmptyResult } from "../lib/instructions.mjs";
import { parseArgs, ArgsError } from "../lib/args.mjs";

const err = (status, message = "", extra = {}) => Object.assign(new Error(message), { status, ...extra });
const ctx = { owner: "acme", repo: "widgets" };

test("explainGitHubError says what to do for each failure", () => {
  assert.match(explainGitHubError(err(401, "Bad credentials"), ctx), /invalid or expired.*gh auth login/);
  assert.match(explainGitHubError(err(403, "Resource protected by organization SAML enforcement."), ctx), /SAML single sign-on/);
  assert.match(explainGitHubError(err(403, "Resource not accessible by integration"), ctx), /acme\/widgets \(403\).*`repo` scope/);
  assert.match(explainGitHubError(err(404, "Not Found"), ctx), /acme\/widgets wasn't found.*private/);
  const gqlNotFound = Object.assign(new Error("Could not resolve to a Repository"), { errors: [{ type: "NOT_FOUND" }] });
  assert.match(explainGitHubError(gqlNotFound, ctx), /wasn't found/);
  assert.match(explainGitHubError(new TypeError("fetch failed"), ctx), /Couldn't reach api\.github\.com/);
  assert.match(explainGitHubError(err(502), ctx), /server error \(502\)/);
  const limit = new RateLimitError("Hit GitHub's API rate limit; it resets at 15:00 UTC. Re-run then.");
  assert.equal(explainGitHubError(limit, ctx), limit.message);
});

test("explainGitHubError never includes request headers", () => {
  const e = err(401, "Bad credentials", { request: { headers: { authorization: "token ghp_xxx" } }, response: { headers: { "x-oauth-scopes": "repo" } } });
  assert.doesNotMatch(explainGitHubError(e, ctx), /ghp_|authorization|scopes/i);
});

test("explainEmptyResult / diagnoseEmpty: the reason with numbers, the most useful option first", async () => {
  const { diagnoseEmpty } = await import("../lib/instructions.mjs");
  const thin = diagnoseEmpty({ prs: 12, reviewers: 7, top_reviewer_share: 0.31, warning: "thin" });
  assert.match(thin.reasons[0], /Only 12 PRs/);
  assert.equal(thin.suggestions[0].cli, "--months 12");
  const single = diagnoseEmpty({ prs: 50, reviewers: 4, top_reviewer_share: 0.92, warning: "single-reviewer" }, { months: 12 });
  assert.match(single.reasons[0], /one reviewer wrote 92%/);
  assert.equal(single.suggestions[0].cli, "--single-reviewer");
  assert.equal(single.suggestions[0].skill, "/reviewlore:learn-from-reviews single-maintainer");
  assert.equal(single.suggestions[1].cli, "--months 24");
  const plenty = diagnoseEmpty({ prs: 300, reviewers: 40, top_reviewer_share: 0.2, warning: null });
  assert.match(plenty.suggestions[0].text, /Zero can be the right answer/);
  assert.ok(!diagnoseEmpty({ prs: 3, reviewers: 1, top_reviewer_share: 1, warning: "thin" }, { months: 24 }).suggestions.some((x) => x.cli?.startsWith("--months")));
  assert.match(explainEmptyResult({ prs: 12, reviewers: 7, top_reviewer_share: 0.31, warning: "thin" }), /^Only 12 PRs.*\nNext steps:\n  • Look further back: 12 months\. \(--months 12\)/s);
});

test("strict parseArgs rejects unknown options and suggests near misses", () => {
  const spec = { booleans: ["force"], values: ["months", "owner"], aliases: { m: "months", f: "force" } };
  assert.deepEqual(parseArgs(["--months", "3", "-f", "x"], spec), { _: ["x"], months: "3", force: true });
  assert.throws(() => parseArgs(["--month", "3"], spec), (e) => e instanceof ArgsError && /Unknown option --month\. Did you mean --months\?/.test(e.message));
  assert.throws(() => parseArgs(["--zzzzzz"], spec), (e) => /Unknown option --zzzzzz\.$/.test(e.message));
  assert.throws(() => parseArgs(["-q"], spec), /Unknown option -q/);
  // Without `values` the parser stays permissive.
  assert.equal(parseArgs(["--anything", "1"]).anything, "1");
});
