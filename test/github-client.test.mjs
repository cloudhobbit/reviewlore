import { test } from "node:test";
import assert from "node:assert/strict";
import { createClient, resolveToken } from "../lib/github-client.mjs";

test("createClient throws when no token can be resolved (env/flag/gh)", () => {
  const oldToken = process.env.GITHUB_TOKEN;
  const oldPath = process.env.PATH;
  delete process.env.GITHUB_TOKEN;
  // Empty PATH so the gh-cli fallback can't find `gh`.
  process.env.PATH = "";
  try {
    assert.throws(() => createClient(), /No GitHub token found/);
  } finally {
    if (oldToken !== undefined) process.env.GITHUB_TOKEN = oldToken;
    process.env.PATH = oldPath;
  }
});

test("resolveToken: flag wins over env", () => {
  const oldToken = process.env.GITHUB_TOKEN;
  process.env.GITHUB_TOKEN = "env-tok";
  try {
    const r = resolveToken({ token: "flag-tok" });
    assert.equal(r.token, "flag-tok");
    assert.equal(r.source, "flag");
  } finally {
    if (oldToken !== undefined) process.env.GITHUB_TOKEN = oldToken;
    else delete process.env.GITHUB_TOKEN;
  }
});

test("resolveToken: per-host order, and no cross-host leaks", () => {
  const gh = (host) => `gh-token-for-${host}`;
  const none = () => null;
  // github.com: flag, GH_TOKEN, GITHUB_TOKEN, gh --hostname github.com.
  assert.equal(resolveToken({ token: "flag", env: { GITHUB_TOKEN: "env" }, gh }).source, "flag");
  assert.equal(resolveToken({ env: { GH_TOKEN: "a", GITHUB_TOKEN: "b" }, gh }).token, "a");
  assert.equal(resolveToken({ env: { GITHUB_TOKEN: "b" }, gh }).source, "GITHUB_TOKEN");
  assert.equal(resolveToken({ env: {}, gh }).token, "gh-token-for-github.com");
  assert.equal(resolveToken({ env: {}, gh: none }), null);
  // GHE.com follows github.com's variables; gh is asked for that host.
  assert.equal(resolveToken({ host: "acme.ghe.com", env: {}, gh }).token, "gh-token-for-acme.ghe.com");
  // GitHub Enterprise Server: never GITHUB_TOKEN from a developer's shell…
  assert.equal(resolveToken({ host: "ghe.corp", env: { GITHUB_TOKEN: "dotcom", GH_TOKEN: "dotcom" }, gh: none }), null);
  assert.equal(resolveToken({ host: "ghe.corp", env: { GITHUB_TOKEN: "dotcom", GH_ENTERPRISE_TOKEN: "corp" }, gh }).token, "corp");
  assert.equal(resolveToken({ host: "ghe.corp", env: { GITHUB_ENTERPRISE_TOKEN: "corp2" }, gh }).token, "corp2");
  assert.equal(resolveToken({ host: "ghe.corp", env: {}, gh }).token, "gh-token-for-ghe.corp");
  // …only inside Actions running on that same server.
  const actions = { GITHUB_ACTIONS: "true", GITHUB_TOKEN: "actions", GITHUB_API_URL: "https://ghe.corp/api/v3" };
  assert.equal(resolveToken({ host: "ghe.corp", env: actions, gh: none }).token, "actions");
  assert.equal(resolveToken({ host: "other.corp", env: actions, gh: none }), null);
});

test("noTokenMessage names the host and the variable, never a value", async () => {
  const { noTokenMessage } = await import("../lib/github-client.mjs");
  assert.match(noTokenMessage(), /No GitHub token found/);
  assert.equal(noTokenMessage("ghe.corp"), "No token for ghe.corp. Run `gh auth login --hostname ghe.corp`, set GH_ENTERPRISE_TOKEN, or pass --token.");
  assert.match(noTokenMessage("acme.ghe.com"), /set GH_TOKEN/);
});
test("createClient prefers explicit token over env", () => {
  const oldToken = process.env.GITHUB_TOKEN;
  process.env.GITHUB_TOKEN = "env-token";
  try {
    // Should not throw — explicit token takes precedence and is non-empty.
    const c = createClient({ token: "explicit-token" });
    assert.ok(c);
    // Should not throw when only env is set either.
    const c2 = createClient();
    assert.ok(c2);
  } finally {
    if (oldToken !== undefined) process.env.GITHUB_TOKEN = oldToken;
    else delete process.env.GITHUB_TOKEN;
  }
});

test("createClient does not expose the token on the returned object", () => {
  // Defensive: the token must not leak via JSON serialization. Octokit
  // stores auth state internally but a plain JSON.stringify of the client
  // should not surface the credential string.
  const c = createClient({ token: "ghp_secret_value_xyz" });
  const json = JSON.stringify(c, null, 2);
  assert.equal(
    json.includes("ghp_secret_value_xyz"),
    false,
    "token must not appear in JSON.stringify of client",
  );
});
