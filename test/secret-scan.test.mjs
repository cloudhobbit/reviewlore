import { test } from "node:test";
import assert from "node:assert/strict";
import {
  scanText, redactText, scanCorpus, redactCorpus, SECRET_PATTERNS,
} from "../lib/secret-scan.mjs";

// Synthetic strings shaped like real credentials but not real ones.
// Long enough to satisfy the {36,} / {60,} / {40} / {20,} quantifiers.
const FAKE_PAT       = "ghp_" + "A".repeat(40);
const FAKE_FG_PAT    = "github_pat_" + "B".repeat(64);
const FAKE_AWS_ID    = "AKIA" + "ABCDEFGHIJKLMNOP";
const FAKE_ANTHROPIC = "sk-ant-" + "C".repeat(30);
const FAKE_SLACK     = "xoxb-" + "1234567890abcdef";
const FAKE_PEM       = "-----BEGIN RSA PRIVATE KEY-----";

test("scanText: empty / non-string is clean", () => {
  assert.deepEqual(scanText(""), []);
  assert.deepEqual(scanText(null), []);
  assert.deepEqual(scanText(undefined), []);
  assert.deepEqual(scanText(42), []);
});

test("scanText: benign prose has no hits", () => {
  assert.deepEqual(scanText("please refactor this function — it's hard to read"), []);
});

test("scanText: flags a GitHub classic PAT pasted in a comment", () => {
  const hits = scanText(`my failing CI uses ${FAKE_PAT} please help`);
  assert.ok(hits.some((h) => h.label === "github_token"), "expected github_token hit");
});

test("scanText: flags multiple distinct credential types in one body", () => {
  const body = `aws: ${FAKE_AWS_ID}\nanthropic: ${FAKE_ANTHROPIC}\nslack: ${FAKE_SLACK}`;
  const labels = scanText(body).map((h) => h.label);
  assert.ok(labels.includes("aws_access_key_id"));
  assert.ok(labels.includes("anthropic_api_key"));
  assert.ok(labels.includes("slack_token"));
});

test("scanText: flags a PEM private key header", () => {
  const hits = scanText(`oops I pasted my key:\n${FAKE_PEM}\nMIIBOgIBAAJBA...`);
  assert.ok(hits.some((h) => h.label === "private_key_pem"));
});

test("redactText: substitutes [REDACTED] for matches and reports labels", () => {
  const body = `token=${FAKE_PAT} key=${FAKE_ANTHROPIC}`;
  const { redacted, labels } = redactText(body);
  assert.ok(!redacted.includes(FAKE_PAT), "PAT should be scrubbed from output");
  assert.ok(!redacted.includes(FAKE_ANTHROPIC), "anthropic key should be scrubbed from output");
  assert.ok(redacted.includes("[REDACTED]"));
  assert.ok(labels.includes("github_token"));
  assert.ok(labels.includes("anthropic_api_key"));
});

test("redactText: returns input unchanged when no matches", () => {
  const body = "this comment has nothing sensitive in it";
  const { redacted, labels } = redactText(body);
  assert.equal(redacted, body);
  assert.deepEqual(labels, []);
});

test("scanCorpus: surfaces affected PR URLs and labels without leaking the secret value", () => {
  const corpus = {
    issue_comments: [
      { body: "looks good", html_url: "https://github.com/o/r/pull/1#c1" },
      { body: `actually CI is failing with ${FAKE_PAT}`, html_url: "https://github.com/o/r/pull/2#c2" },
    ],
    review_comments: [
      { body: `try AWS key ${FAKE_AWS_ID}`, html_url: "https://github.com/o/r/pull/3#r3" },
    ],
    review_submissions: [
      { body: null, html_url: "https://github.com/o/r/pull/4#s4" },
    ],
  };
  const warnings = scanCorpus(corpus);
  assert.equal(warnings.length, 2);
  const urls = warnings.map((w) => w.html_url);
  assert.ok(urls.includes("https://github.com/o/r/pull/2#c2"));
  assert.ok(urls.includes("https://github.com/o/r/pull/3#r3"));
  for (const w of warnings) {
    // Never echo the matched substring itself.
    const json = JSON.stringify(w);
    assert.ok(!json.includes(FAKE_PAT), "warning must not contain the PAT value");
    assert.ok(!json.includes(FAKE_AWS_ID), "warning must not contain the AWS key value");
  }
});

test("redactCorpus: mutates bodies in place and reports affected comments", () => {
  const corpus = {
    issue_comments: [
      { body: `oops ${FAKE_PAT} oops`, html_url: "https://github.com/o/r/pull/1" },
    ],
    review_comments: [],
    review_submissions: [],
  };
  const warnings = redactCorpus(corpus);
  assert.equal(warnings.length, 1);
  assert.ok(!corpus.issue_comments[0].body.includes(FAKE_PAT));
  assert.ok(corpus.issue_comments[0].body.includes("[REDACTED]"));
});

test("SECRET_PATTERNS: every entry has label + global regex (so replace works)", () => {
  for (const p of SECRET_PATTERNS) {
    assert.equal(typeof p.label, "string");
    assert.ok(p.re instanceof RegExp);
    assert.ok(p.re.flags.includes("g"), `pattern ${p.label} must be global for replace()`);
  }
});


// Fake values are assembled at runtime so this file never holds a literal
// that a secret scanner (or GitHub push protection) would flag.
const fake = (prefix, n, ch = "A") => prefix + ch.repeat(n);

test("scanText catches the token formats added in 0.3", () => {
  const cases = {
    github_token: [fake("ghu_", 36), fake("ghr_", 36), fake("ghp_", 36)],
    gitlab_pat: [fake("glpat-", 20)],
    npm_token: [fake("npm_", 36)],
    google_api_key: [fake("AIza", 35)],
    stripe_live_key: [fake("sk_" + "live_", 24), fake("rk_" + "live_", 24)],
    atlassian_api_token: [fake("ATATT", 24)],
    jwt: [`${fake("eyJ", 12)}.${fake("eyJ", 12)}.${fake("", 12, "x")}`],
    private_key_pem: ["-----BEGIN " + "PRIVATE KEY-----", "-----BEGIN " + "ENCRYPTED PRIVATE KEY-----", "-----BEGIN " + "DSA PRIVATE KEY-----"],
  };
  for (const [label, values] of Object.entries(cases)) {
    for (const v of values) {
      assert.deepEqual(scanText(`pasted: ${v} oops`).map((h) => h.label), [label], v.slice(0, 8));
    }
  }
  assert.deepEqual(scanText("set the npm_config_registry var; AIza is a prefix"), []);
});

test("scanCorpus and redactCorpus cover diff_hunk, not just body", () => {
  const secret = fake("ghp_", 36);
  const corpus = {
    review_comments: [{ html_url: "u1", body: "looks fine", diff_hunk: `@@ -1 +1 @@\n+const t = "${secret}";` }],
  };
  assert.deepEqual(scanCorpus(corpus).map((w) => w.labels), [["github_token"]]);
  const warnings = redactCorpus(corpus);
  assert.equal(warnings.length, 1);
  assert.ok(!corpus.review_comments[0].diff_hunk.includes(secret));
  assert.match(corpus.review_comments[0].diff_hunk, /\[REDACTED\]/);
});
