// Pattern extractors for recurring reviewer guidance.
//
// We classify each sentence as one of:
//   - "prescription"  ("use X", "always X", "prefer X", "add X", "should be X")
//   - "prohibition"   ("don't X", "avoid X", "never X", "let's not X")
//   - "request"       ("can you X", "could you X", "please X", "should we X")
//   - "question"      ("why not X", "why are you X", "is this necessary")
//
// Only sentences matching a pattern are kept as candidate rules. Precision
// matters more than recall here (see .claude/rules/skill-output-quality.md),
// so ambiguous trigger words only count at the start of a clause, and
// hedges / social requests are filtered out. Tune against
// eval/run-real-eval.mjs (dev split) — not against intuition.

// Strip a common "nit:" / "[Q]" / "TODO:" prefix before classifying.
// A dash only counts when spaced ("nit - foo", "NIT -- foo"), so words like
// "Optional-chaining" or "Q-values" keep their first letters.
const PREFIX_RE =
  /^\s*(?:\[(?:nit|q|question|suggestion|minor|optional)\]|(?:nit|note|todo|fixme|suggestion|q|question|minor|optional)(?:\s*:|\s+-{1,2}(?=\s)))\s*/i;

// Words that may precede an ambiguous trigger ("use", "never", ...) for it
// to count: "Just use X", "we should never X", "I'd avoid X". Without
// this, "We currently use three sources" reads as a rule.
const LEAD =
  String.raw`(?<=^|[;:,]\s*|\s[-–—]\s*|\b(?:and|but|so|then|also|just|please|maybe|perhaps|probably|rather|instead|i think|i'?d|i would|we|you|let'?s|should|would|could)\s+)`;

const REST = String.raw`\s*(?<rest>.{0,160})`;

const IMPERATIVE_VERBS =
  "add|use|remove|rename|move|assert|drop|replace|extract|keep|make|update|change|revert|split|mention|document|handle|wrap|inline|delete|simplify|reuse|pass|bump|squash|rebase|resolve|export|throw|return";

const PATTERNS = [
  {
    kind: "prohibition",
    re: new RegExp(String.raw`\b(?<trigger>please don'?t|do not|don'?t|shouldn'?t|should not|must not|mustn'?t|let'?s not|we don'?t (?:accept|want|need|do|use|allow|support)|can'?t (?:have|use|call|return|import|export|rely on|be))\b` + REST, "i"),
  },
  {
    kind: "prohibition",
    re: new RegExp(LEAD + String.raw`(?<trigger>never|avoid|stop (?:using|doing|calling|adding|relying))\b` + REST, "i"),
  },
  {
    kind: "prescription",
    re: new RegExp(String.raw`\b(?<trigger>make sure(?: to)?|remember to|we should|you should|we need to|you need to|we'?ll need|you'?ll need|would need to|needs? to be|this should be|this could be|(?<!\bi )should (?!we\b|i\b|you\b)[a-z]+|would be better(?: as)?|it'?s better to|i'?d (?:prefer|suggest|recommend|rather)|i would (?:prefer|suggest|recommend|rather)|consider|let'?s|can be (?:removed|omitted|dropped|simplified|inlined|deleted|replaced)|(?:is|are) (?:redundant|unnecessary)|isn'?t (?:needed|necessary)|no need to|not needed|please use)\b` + REST, "i"),
  },
  {
    kind: "prescription",
    re: new RegExp(LEAD + String.raw`(?<trigger>always|prefer|use|try)\b` + REST, "i"),
  },
  {
    kind: "request",
    re: new RegExp(String.raw`\b(?<trigger>can you|could you|would you mind|would you like to|can we|could we|should we|can (?:this|that|it|these) be|would it be (?:possible|worth|better)|worth considering|please|kindly)\b` + REST, "i"),
  },
  {
    kind: "prescription", // bare imperative: "Add a test for …"
    re: new RegExp(String.raw`^(?:(?:please|also|maybe|just|then|and)\s+)?(?<trigger>${IMPERATIVE_VERBS})\s` + REST, "i"),
  },
  {
    kind: "question",
    re: new RegExp(String.raw`\b(?<trigger>why (?:are you|did you|do we|is this|not)|curious why|what'?s the reason for|any reason (?:to|for|we|not)|is there a reason|is (?:this|that|it) (?:really )?(?:necessary|needed|required)|do we (?:really )?(?:need|want)|not sure (?:why|we need|this is needed))\b` + REST, "i"),
  },
];

// "I don'?t think / know / understand ..." is a hedge, not a prohibition,
// unless the sentence also carries a directive ("I don'?t think we should").
const HEDGE_RE =
  /\bi (?:really |just |still )?(?:don'?t|do not) (?:really )?(?:think|know|understand|see|believe|feel|remember|recall|mind|get|care|have)\b/i;
const DIRECTIVE_RE =
  /\b(?:should|shouldn'?t|need(?:s|ed)? to|must|have to|encourage|necessary|needed)\b/i;

// "should be fine / fixed / released" reports status; it isn'?t guidance.
const STATUS_RE =
  /\bshould (?:now |already |hopefully )?(?:be )?(?:fine|good|ok|okay|fixed|resolved|working|work|released|available|merged|done)\b/i;

// Requests about the review itself, not the code: "please review",
// "could you assign this to me", "please see", "let me know".
const SOCIAL_STRONG_RE = /^(?:\S+\s+){0,3}?(?:re-?review|review|merge|approve|assign)\b/i;
const SOCIAL_WEAK_RE =
  /^(?:also |kindly |just )?(?:see|note|ping|accept|stop|ignore|disregard|confirm|share|clarify|let (?:me|us) know|take a look|have a look|look (?:at (?:it|this|my|the|whatever)|into))\b/i;

function isRejected(kind, trigger, rest, sentence) {
  if (kind === "prohibition" && /^(?:do not|don'?t)$/.test(trigger) &&
      HEDGE_RE.test(sentence) && !DIRECTIVE_RE.test(sentence)) return true;
  if (trigger.includes("should") && STATUS_RE.test(sentence)) return true;
  if (kind === "request" && (SOCIAL_STRONG_RE.test(rest) || SOCIAL_WEAK_RE.test(rest))) return true;
  return false;
}

// Returns { kind, trigger, remainder, fullSentence, remainderStart } or
// null. `remainderStart` indexes into the *input* sentence, so a caller
// that classified a masked copy (e.g. inline code blanked out) can slice
// the same span from the unmasked original.
export function classifySentence(sentence) {
  // Typographic apostrophes ("don’t") would otherwise never match.
  const normalized = sentence.replace(/[‘’]/g, "'");
  const unprefixed = normalized.replace(PREFIX_RE, "");
  const lead = normalized.length - unprefixed.trimStart().length;
  const cleaned = unprefixed.trim();
  for (const p of PATTERNS) {
    const m = cleaned.match(p.re);
    if (!m) continue;
    const trigger = m.groups.trigger.toLowerCase();
    const rest = m.groups.rest;
    if (isRejected(p.kind, trigger, rest, cleaned)) continue;
    return {
      kind: p.kind,
      trigger,
      remainder: rest.replace(/[.?!]+$/, "").trim(),
      fullSentence: cleaned,
      remainderStart: lead + m.index + m[0].length - rest.length,
    };
  }
  return null;
}

// Tokenize remainder for clustering: lowercase words, strip stopwords/punct,
// keep word stems (very rough — no real stemming, just lowercasing).
// Stopwords list — intentionally excludes domain-relevant tokens that often
// appear as the *subject* of reviewer feedback. Notably we KEEP: any, null,
// none, void, true, false (TypeScript/Flow/JS language keywords that are
// usually the topic of "don't use any" / "prefer null" style rules).
const STOPWORDS = new Set([
  "a", "an", "the", "is", "are", "this", "that", "these", "those", "it", "to",
  "of", "for", "in", "on", "at", "by", "with", "and", "or", "but", "not", "as",
  "be", "we", "you", "i", "they", "them", "us", "our", "your", "their", "my",
  "me", "him", "her", "his", "hers", "have", "has", "had", "do", "does", "did",
  "can", "could", "should", "would", "will", "shall", "may", "might", "must",
  "than", "then", "here", "there", "if", "else", "when", "where", "why", "how",
  "all", "some", "yes", "very", "just", "more", "most", "less",
  "so", "such", "also", "too", "ok", "okay",
  "really", "actually", "maybe", "probably", "kind", "thing", "place",
  "way", "time", "something", "nothing",
  // Trigger words and contraction fragments ("don't" → "don"): they say
  // *how* something was asked, not *what* — keep them out of labels.
  "please", "thanks", "thank", "let", "lets", "think", "sure", "know",
  "don", "doesn", "didn", "isn", "aren", "wasn", "won", "shouldn", "couldn", "wouldn",
]);

const TOKEN_RE = /[a-z0-9][a-z0-9_-]{1,}/g;

// Fold simple plurals so "add a test case" and "add test cases" share
// tokens. Deliberately crude: no stemming library (no new deps), and words
// ending in -ss / -us / -is ("process", "status", "analysis") are left alone.
function singular(t) {
  return t.length > 4 && t.endsWith("s") && !/(?:ss|us|is)$/.test(t) ? t.slice(0, -1) : t;
}

export function tokenize(text) {
  return (text.toLowerCase().match(TOKEN_RE) ?? [])
    .filter((t) => !STOPWORDS.has(t) && t.length > 1)
    .map(singular);
}
