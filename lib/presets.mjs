// Named presets — collapses 6-8 individual tuning flags into a single
// --preset value with documented intent. Replaces "what threshold should
// I use?" with "which scenario am I in?"
//
// Each preset is a partial set of CLI-equivalent options. Explicit flags
// always override preset values, so users can preset + tweak.

export const PRESETS = {
  "team-of-3": {
    description: "Small team (~3 engineers). Loosens thresholds since a 3× threshold means almost everyone has flagged it.",
    options: {
      "min-occurrences": 2,
      "min-authors": 2,
      months: 6,
      "time-decay-half-life": 6,
    },
  },

  "team-of-50": {
    description: "Large team (~50 engineers, high PR volume). Tightens thresholds to surface only strong consensus.",
    options: {
      "min-occurrences": 5,
      "min-authors": 3,
      months: 6,
      "time-decay-half-life": 6,
      engine: "semantic",
    },
  },

  "oss-maintainer": {
    description: "Open-source project with many drive-by reviewers. Prioritises code-owner-class signal; uses CHANGES_REQUESTED weighting heavily via the existing state-weight system.",
    options: {
      "min-occurrences": 4,
      "min-authors": 3,
      months: 12,
      "time-decay-half-life": 9,
      engine: "semantic",
    },
  },

  "new-joiner": {
    description: "I'm new to this repo, what do reviewers care about? Looser thresholds, longer window — surfaces conventions the team takes for granted.",
    options: {
      "min-occurrences": 2,
      "min-authors": 2,
      months: 12,
      "time-decay-half-life": 0,        // no decay; conventions don't expire
    },
  },

  "monthly-refresh": {
    description: "I run this on a cron and want only what's changed recently. Tight window, strong recency bias.",
    options: {
      "min-occurrences": 2,
      "min-authors": 2,
      months: 1,
      "time-decay-half-life": 1,
    },
  },

  "exploratory": {
    description: "First pass — show me everything, I'll curate. Loosest thresholds, semantic engine.",
    options: {
      "min-occurrences": 2,
      "min-authors": 2,
      months: 12,
      "time-decay-half-life": 0,
      engine: "semantic",
      threshold: "0.25",
    },
  },
};

export function presetNames() {
  return Object.keys(PRESETS);
}

export function presetSummary() {
  return Object.entries(PRESETS)
    .map(([k, v]) => `  ${k.padEnd(16)} ${v.description}`)
    .join("\n");
}

// Apply a preset's options as defaults: only fill in values that the user
// hasn't explicitly set. Mutates and returns the args object for chainability.
export function applyPreset(args, presetName) {
  if (!presetName) return args;
  const preset = PRESETS[presetName];
  if (!preset) {
    throw new Error(
      `Unknown --preset "${presetName}". Available: ${presetNames().join(", ")}`,
    );
  }
  for (const [k, v] of Object.entries(preset.options)) {
    if (args[k] === undefined) args[k] = String(v);
  }
  return args;
}
