// Credential-pattern scanner shared between the npm-pack audit
// (scripts/check-secrets.sh) and the corpus publisher. Same high-
// confidence patterns, applied in JS so we can scan PR comment bodies
// before they are written into a consumer repo's .reviewlore-
// corpus.json (where a stray pasted token would otherwise end up in
// `git log` forever).
//
// Patterns intentionally mirror scripts/check-secrets.sh. Keep them in
// sync when adding new ones.

export const SECRET_PATTERNS = [
  // ghp_ classic PAT, gho_ OAuth, ghu_ user-to-server, ghs_ server, ghr_ refresh
  { label: "github_token",       re: /gh[pousr]_[A-Za-z0-9]{36,}/g },
  { label: "github_pat_finegrained", re: /github_pat_[A-Za-z0-9_]{60,}/g },
  { label: "gitlab_pat",         re: /glpat-[A-Za-z0-9_-]{20,}/g },
  { label: "npm_token",          re: /npm_[A-Za-z0-9]{36}/g },
  { label: "aws_access_key_id",  re: /AKIA[0-9A-Z]{16}/g },
  { label: "aws_secret_access_key", re: /aws_secret_access_key\s*=\s*[A-Za-z0-9/+=]{40}/gi },
  { label: "google_api_key",     re: /AIza[0-9A-Za-z_-]{35}/g },
  { label: "stripe_live_key",    re: /[sr]k_live_[0-9A-Za-z]{24,}/g },
  { label: "atlassian_api_token", re: /ATATT[A-Za-z0-9_=-]{20,}/g },
  { label: "jwt",                re: /eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g },
  { label: "generic_api_key",    re: /api[_-]?key\s*[:=]\s*["'`][A-Za-z0-9_\-]{32,}["'`]/gi },
  // Any PEM private key: RSA, EC, OPENSSH, PGP, DSA, PKCS#8, ENCRYPTED.
  { label: "private_key_pem",    re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/g },
  { label: "slack_token",        re: /xox[abprs]-[A-Za-z0-9-]{10,}/g },
  { label: "anthropic_api_key",  re: /sk-ant-[A-Za-z0-9_\-]{20,}/g },
];

// Comment fields that can carry pasted secrets: the text, the quoted code
// of an inline review comment, and file paths (generated fixtures).
const SCANNED_FIELDS = ["body", "diff_hunk", "path"];

const REDACTION = "[REDACTED]";

// Returns an array of { label } for every pattern that matched. Empty
// array means clean. Does not echo or return the matched substring —
// per .claude/rules/no-token-logging.md we never log credential values.
export function scanText(text) {
  if (typeof text !== "string" || text.length === 0) return [];
  const hits = [];
  for (const { label, re } of SECRET_PATTERNS) {
    re.lastIndex = 0;
    if (re.test(text)) hits.push({ label });
  }
  return hits;
}

// Returns { redacted, labels }: redacted = text with every match replaced
// by [REDACTED]; labels = unique pattern labels that fired.
export function redactText(text) {
  if (typeof text !== "string" || text.length === 0) {
    return { redacted: text, labels: [] };
  }
  const labels = new Set();
  let out = text;
  for (const { label, re } of SECRET_PATTERNS) {
    re.lastIndex = 0;
    if (re.test(out)) {
      labels.add(label);
      re.lastIndex = 0;
      out = out.replace(re, REDACTION);
    }
  }
  return { redacted: out, labels: [...labels] };
}

// Walk all comment arrays in a corpus object and apply `fn(commentRef)`
// where commentRef has a string `body` field. Used by both scanCorpus and
// redactCorpus to share the iteration shape.
function forEachComment(corpus, fn) {
  if (!corpus || typeof corpus !== "object") return;
  for (const key of ["issue_comments", "review_comments", "review_submissions"]) {
    const arr = corpus[key];
    if (!Array.isArray(arr)) continue;
    for (const c of arr) fn(c, key);
  }
}

// Returns an array of { html_url, kind, labels } — one entry per comment
// that contained any credential pattern. labels = de-duped list of
// pattern labels that fired. Never includes the matched substring.
export function scanCorpus(corpus) {
  const warnings = [];
  forEachComment(corpus, (c, kind) => {
    const hits = SCANNED_FIELDS.flatMap((f) => scanText(c?.[f]));
    if (hits.length > 0) {
      const labels = [...new Set(hits.map((h) => h.label))];
      warnings.push({
        html_url: c?.html_url ?? null,
        kind,
        labels,
      });
    }
  });
  return warnings;
}

// Mutates corpus in place: every comment body that contained credential
// patterns is rewritten with [REDACTED] substituted for each match.
// Returns the same `warnings` shape as scanCorpus so the caller can
// report which PR comments were affected.
export function redactCorpus(corpus) {
  const warnings = [];
  forEachComment(corpus, (c, kind) => {
    const labels = new Set();
    for (const field of SCANNED_FIELDS) {
      if (typeof c?.[field] !== "string") continue;
      const { redacted, labels: hit } = redactText(c[field]);
      if (hit.length > 0) {
        c[field] = redacted;
        hit.forEach((l) => labels.add(l));
      }
    }
    if (labels.size > 0) {
      warnings.push({
        html_url: c.html_url ?? null,
        kind,
        labels: [...labels],
      });
    }
  });
  return warnings;
}

