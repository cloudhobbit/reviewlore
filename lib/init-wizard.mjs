// Interactive setup wizard. Runs on `reviewlore init`. Asks
// 6-8 questions, writes a .reviewlore.json the user can commit.
// Subsequent runs read from that file.
//
// Uses node:readline (stdlib) — no new dep. Plain text I/O on stdin/stderr
// so it works in any terminal and can be scripted with stdin redirection.

import { stdin, stdout, stderr } from "node:process";
import { existsSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { detectFormats, rendererNames } from "./renderers/index.mjs";
import { presetNames } from "./presets.mjs";
import { saveConfig, CONFIG_FILENAME } from "./config.mjs";
import { detectRepoFromGit } from "./git-info.mjs";

const PRESETS_PROMPT = presetNames();

// Custom stdin line reader. Avoids a Node bug where readline/promises'
// rl.question only reliably returns the first answer on non-TTY stdin.
//
// Usage:
//   const reader = createReader();
//   const line = await reader.nextLine();      // returns null at EOF
//   await reader.close();
function createReader() {
  let buffer = "";
  let resolveLine = null;
  let eof = false;

  const tryDeliver = () => {
    if (!resolveLine) return;
    const nl = buffer.indexOf("\n");
    if (nl !== -1) {
      const line = buffer.slice(0, nl);
      buffer = buffer.slice(nl + 1);
      const r = resolveLine;
      resolveLine = null;
      r(line);
    } else if (eof) {
      const r = resolveLine;
      resolveLine = null;
      r(buffer.length > 0 ? buffer : null);
      buffer = "";
    }
  };

  stdin.setEncoding("utf-8");
  const onData = (chunk) => { buffer += chunk; tryDeliver(); };
  const onEnd = () => { eof = true; tryDeliver(); };
  stdin.on("data", onData);
  stdin.on("end", onEnd);

  return {
    async nextLine() {
      if (resolveLine) throw new Error("nextLine() already in flight");
      return new Promise((res) => { resolveLine = res; tryDeliver(); });
    },
    close() {
      stdin.off("data", onData);
      stdin.off("end", onEnd);
      stdin.pause();
    },
  };
}

async function ask(reader, prompt, { default: def, choices } = {}) {
  const tail = def !== undefined ? ` (default: ${def})` : "";
  const hint = choices ? `\n  [${choices.join(" / ")}]` : "";
  stdout.write(`${prompt}${hint}${tail}\n> `);
  const line = await reader.nextLine();
  if (line === null) {
    if (def !== undefined) return def;
    throw new Error("Wizard input ended unexpectedly; cannot continue without an answer.");
  }
  const raw = line.trim();
  if (raw === "" && def !== undefined) return def;
  if (choices && !choices.includes(raw)) {
    stderr.write(`Please pick one of: ${choices.join(", ")}\n`);
    return ask(reader, prompt, { default: def, choices });
  }
  return raw;
}

async function askInt(reader, prompt, { default: def, min = 1 } = {}) {
  const raw = await ask(reader, prompt, { default: String(def) });
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n) || n < min) {
    stderr.write(`Must be an integer >= ${min}.\n`);
    return askInt(reader, prompt, { default: def, min });
  }
  return n;
}

async function askBool(reader, prompt, { default: def = false } = {}) {
  const raw = await ask(reader, prompt, { default: def ? "y" : "n", choices: ["y", "n"] });
  return raw === "y";
}

// Validate a comma-separated --format value against the renderer registry,
// re-prompting until every token is recognised. `auto` and `all` are accepted
// only as whole-arg values (same contract as resolveFormats), since mixing
// them with named renderers isn't meaningful. Mirrors askInt's retry loop so
// the wizard never silently saves a typo into .reviewlore.json.
async function askFormatList(reader, prompt, { default: def } = {}) {
  const raw = await ask(reader, prompt, { default: def });
  const trimmed = raw.trim();
  if (trimmed === "auto" || trimmed === "all") return trimmed;
  const tokens = trimmed.split(",").map((s) => s.trim()).filter(Boolean);
  const valid = new Set(rendererNames());
  const bad = tokens.find((t) => !valid.has(t));
  if (tokens.length === 0 || bad !== undefined) {
    const supported = `${rendererNames().join(", ")}, auto, all`;
    const label = bad !== undefined ? `Unknown format "${bad}".` : "Please choose at least one format.";
    stderr.write(`${label} Valid: ${supported}\n`);
    return askFormatList(reader, prompt, { default: def });
  }
  return tokens.join(",");
}

export async function runInitWizard({ cwd = process.cwd(), targetHint = "." } = {}) {
  const reader = createReader();
  stderr.write("\n");
  stderr.write("reviewlore setup wizard\n");
  stderr.write("─────────────────────────────────\n");
  stderr.write("I'll ask a few questions and save the answers to\n");
  stderr.write(`${CONFIG_FILENAME} so future runs use them automatically.\n\n`);

  const origin = detectRepoFromGit(resolve(cwd, targetHint));
  const guess = origin?.supported ? origin : null;
  if (guess) stderr.write(`Detected from git origin: ${guess.owner}/${guess.repo}${guess.host === "github.com" ? "" : ` on ${guess.host}`}\n`);
  else if (origin) stderr.write(`Origin isn't usable: ${origin.problem}\n`);

  const owner = await ask(reader, "GitHub owner / org?", { default: guess?.owner });
  const repo = await ask(reader, "GitHub repo name?", { default: guess?.repo });

  const target = await ask(reader, "Target directory (where rules will be written)?", { default: targetHint });
  const resolvedTarget = resolve(cwd, target);
  if (!existsSync(resolvedTarget) || !statSync(resolvedTarget).isDirectory()) {
    reader.close();
    throw new Error(`Target directory does not exist: ${resolvedTarget}`);
  }

  const detected = detectFormats(resolvedTarget);
  stderr.write(`\nLooking at ${resolvedTarget}, I see config for: ${detected.join(", ")}\n`);
  const formatChoice = await askFormatList(reader,
    "Which AI tool(s) should rules be generated for? (comma-separated; or 'auto')",
    { default: detected.join(",") });

  stderr.write("\nWhich tuning preset best matches your situation?\n");
  for (const p of PRESETS_PROMPT) stderr.write(`  - ${p}\n`);
  const preset = await ask(reader, "Preset name?", {
    default: "team-of-3",
    choices: PRESETS_PROMPT,
  });

  const useLlm = await askBool(reader,
    "Use Claude to synthesise polished rules? (requires ANTHROPIC_API_KEY; small per-run cost)",
    { default: false });

  const months = await askInt(reader, "Lookback window in months?", { default: 6 });

  stderr.write("\nDone! Re-run with `reviewlore run` any time —\n");
  stderr.write("it'll use these saved answers.\n\n");

  reader.close();

  const config = {
    owner,
    repo,
    // GitHub Enterprise / GHE.com: keep the host with the repo.
    ...(guess && guess.host !== "github.com" && guess.owner === owner && guess.repo === repo ? { host: guess.host } : {}),
    target,
    format: formatChoice,
    preset,
    llm: useLlm,
    months,
  };
  const path = join(resolvedTarget, CONFIG_FILENAME);
  saveConfig(path, config);
  stderr.write(`Saved: ${path}\n`);
  return { path, config };
}
