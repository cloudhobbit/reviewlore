import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeHost, hostKind, apiBaseUrl, resolveHost, hostDirName } from "../lib/github-host.mjs";

test("hosts: kinds and API base URLs", () => {
  assert.equal(normalizeHost("WWW.GitHub.com"), "github.com");
  assert.equal(normalizeHost("github.com-work"), "github.com");
  assert.equal(hostKind("github.com"), "dotcom");
  assert.equal(hostKind("acme.ghe.com"), "ghe.com");
  assert.equal(hostKind("ghe.acme.corp"), "ghes");
  assert.equal(hostKind("gitlab.com"), null);
  assert.equal(hostKind("gh-work"), null);
  assert.equal(apiBaseUrl("github.com"), "https://api.github.com");
  assert.equal(apiBaseUrl("acme.ghe.com"), "https://api.acme.ghe.com");
  assert.equal(apiBaseUrl("ghe.acme.corp:8443"), "https://ghe.acme.corp:8443/api/v3");
  assert.equal(hostDirName("ghe.acme.corp:8443"), "ghe.acme.corp_8443");
});

test("resolveHost: --api-url, --host, git remote, Actions, GH_HOST, github.com", () => {
  assert.deepEqual(resolveHost({ flagApiUrl: "https://ghe.corp/api/v3/", flagHost: "x.y" }), { host: "ghe.corp", baseUrl: "https://ghe.corp/api/v3", source: "--api-url" });
  assert.equal(resolveHost({ flagApiUrl: "https://api.acme.ghe.com" }).host, "acme.ghe.com");
  assert.equal(resolveHost({ flagHost: "ghe.corp", detectedHost: "github.com" }).host, "ghe.corp");
  assert.equal(resolveHost({ detectedHost: "ghe.corp", env: { GH_HOST: "other.corp" } }).host, "ghe.corp");
  assert.equal(resolveHost({ env: { GITHUB_ACTIONS: "true", GITHUB_API_URL: "https://ghe.corp/api/v3", GH_HOST: "x.corp" } }).host, "ghe.corp");
  assert.equal(resolveHost({ env: { GITHUB_API_URL: "https://ghe.corp/api/v3", GH_HOST: "x.corp" } }).host, "x.corp", "GITHUB_API_URL only inside Actions");
  assert.deepEqual(resolveHost({ env: {} }), { host: "github.com", baseUrl: "https://api.github.com", source: "default" });
  assert.match(resolveHost({ flagHost: "gitlab.com" }).error, /is GitLab: pass --provider gitlab/);
  assert.match(resolveHost({ flagHost: "bitbucket.org" }).error, /isn't supported/);
  assert.match(resolveHost({ flagApiUrl: "not a url" }).error, /isn't a URL/);
});
