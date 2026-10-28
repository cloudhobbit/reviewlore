// LLM-based rule synthesis. Optional path — gated behind the --llm flag.
//
// Why: heuristic clustering produces *evidence* (a bag of reviewer
// quotes); a real rule is a generalised statement that abstracts over
// them. An LLM does this trivially well. The output also gets a
// proper human-readable name (replacing "any / unknown / use / types")
// and a code-anchored "How to apply" derived from the file paths.
//
// Cost model: one short request per kept cluster, at low effort (this is
// a summarise-into-JSON task, not open-ended reasoning). The system prompt
// carries a cache marker, but it is currently below the model's minimum
// cacheable prefix (512 tokens on Sonnet 5.5), so it only starts caching
// if the prompt grows.
//
// Dependency: @anthropic-ai/sdk is an optionalDependency. If not
// installed, we surface a clear install instruction instead of crashing.

const MODEL = process.env.REVIEWLORE_MODEL ?? "claude-sonnet-5-5";
// Thinking is on by default on current models and counts toward
// max_tokens, so leave headroom beyond the ~200-token JSON answer.
const MAX_OUTPUT_TOKENS = 16000;
// Server-side fallback: if the model declines a cluster for policy
// reasons, the API retries on the model's default fallback in the same
// call instead of returning an empty refusal.
const FALLBACK_BETA = "server-side-fallback-2026-07-01";

const SYSTEM_PROMPT = `You are an expert at distilling PR-review feedback into durable repository conventions.

You receive a cluster of comments from N reviewers across M PRs that all express a recurring concern. Your job is to write a single rule a future contributor (human or AI) could follow.

Output STRICTLY this JSON shape:

{
  "name": "short imperative title, max 60 chars, no trailing period",
  "rule": "one or two sentences stating what to do (or not do). Be specific and actionable, not vague.",
  "why": "one sentence explaining the underlying reason. Cite the recurring nature ('multiple reviewers...') if useful, but lead with the technical/process rationale.",
  "when_to_apply": "one sentence describing when this rule kicks in. If file paths are provided, anchor to them (e.g. 'When editing TypeScript files in src/api/'). Otherwise describe a code situation.",
  "kind": "prohibition | prescription | request"
}

Critical:
- Do not invent details not present in the examples.
- Do not include reviewer names, PR numbers, or example quotations in any field — those go in the citation section, which is added downstream.
- If the cluster is incoherent (the examples don't actually share a theme), set name to "INCOHERENT" and rule/why/when_to_apply to brief explanations of why you can't synthesise a single rule.
- Output the JSON only, no preamble, no markdown fences.`;

function clusterToUserPrompt(cluster) {
  const examples = cluster.items
    .slice(0, 8)
    .map((i, idx) => `Example ${idx + 1}: "${i.sentence}"${i.path ? ` (on path: ${i.path})` : ""}`)
    .join("\n");
  const paths = cluster.paths?.length ? `\nObserved file paths: ${cluster.paths.slice(0, 8).join(", ")}` : "";
  const kinds = cluster.kinds?.length ? `\nClassified as: ${cluster.kinds.join(", ")}` : "";
  return `Cluster of ${cluster.occurrences} comments from ${cluster.distinctAuthors} reviewers across ${cluster.distinctPRs} PRs.${kinds}${paths}

${examples}

Synthesise the rule per the JSON schema above.`;
}

let cachedClient = null;

async function getClient(apiKey) {
  if (cachedClient) return cachedClient;
  let Anthropic;
  try {
    ({ default: Anthropic } = await import("@anthropic-ai/sdk"));
  } catch (e) {
    throw new Error(
      "The --llm flag requires @anthropic-ai/sdk to be installed. " +
        "Run: npm install @anthropic-ai/sdk",
    );
  }
  cachedClient = new Anthropic({ apiKey });
  return cachedClient;
}

export async function synthesiseRule(cluster, { apiKey } = {}) {
  const key = apiKey ?? process.env.ANTHROPIC_API_KEY;
  if (!key) {
    throw new Error(
      "ANTHROPIC_API_KEY is required for --llm. Set the env var or pass --api-key.",
    );
  }
  const client = await getClient(key);
  const response = await client.beta.messages.create({
    model: MODEL,
    max_tokens: MAX_OUTPUT_TOKENS,
    betas: [FALLBACK_BETA],
    fallbacks: "default",
    output_config: { effort: "low" },
    system: [
      {
        type: "text",
        text: SYSTEM_PROMPT,
        // Identical across every cluster in a run; caches once the prompt
        // exceeds the model's minimum cacheable prefix.
        cache_control: { type: "ephemeral" },
      },
    ],
    messages: [{ role: "user", content: clusterToUserPrompt(cluster) }],
  });

  const label = cluster.label.join(" / ");
  if (response.stop_reason === "refusal") {
    throw new Error(`Model declined to synthesise cluster "${label}"`);
  }
  if (response.stop_reason === "max_tokens") {
    throw new Error(`Model output was truncated for cluster "${label}"`);
  }

  const text = response.content
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("");
  return parseJsonResponse(text, cluster);
}

function parseJsonResponse(text, cluster) {
  // Defend against models that occasionally wrap JSON in code fences
  // or prose despite instructions.
  let cleaned = text.trim();
  cleaned = cleaned.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "").trim();
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start === -1 || end === -1) {
    throw new Error(`LLM did not return JSON for cluster "${cluster.label.join(" / ")}": ${text.slice(0, 200)}`);
  }
  const json = cleaned.slice(start, end + 1);
  let parsed;
  try {
    parsed = JSON.parse(json);
  } catch (e) {
    throw new Error(`LLM returned invalid JSON for cluster "${cluster.label.join(" / ")}": ${e.message}`);
  }
  for (const k of ["name", "rule", "why", "when_to_apply"]) {
    if (typeof parsed[k] !== "string" || parsed[k].length === 0) {
      throw new Error(`LLM response missing required field "${k}" for cluster "${cluster.label.join(" / ")}"`);
    }
  }
  return parsed;
}

// Synthesise N clusters in parallel with a small concurrency cap so we
// don't trip API rate limits or the cache TTL.
export async function synthesiseAll(clusters, opts = {}) {
  const concurrency = opts.concurrency ?? 4;
  const out = new Array(clusters.length);
  let idx = 0;
  const workers = Array.from({ length: Math.min(concurrency, clusters.length) }, async () => {
    while (true) {
      const i = idx++;
      if (i >= clusters.length) return;
      try {
        out[i] = await synthesiseRule(clusters[i], opts);
      } catch (e) {
        out[i] = { _error: e.message };
      }
    }
  });
  await Promise.all(workers);
  return out;
}
