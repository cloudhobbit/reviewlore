// Tiny dependency-free flag parser. Supports --flag, --flag=value, --flag value,
// boolean flags, short aliases, and positional arguments.
//
// Throws ArgsError when a non-boolean flag is missing its value (rather than
// silently coercing to `true`), and refuses to consume a declared boolean
// flag as another flag's value.
//
// With `spec.values` (the flags that take a value) the parser is strict:
// any flag that isn't in `values`, `booleans` or `aliases` is an error,
// with a suggestion for near-misses (--month → --months).

export class ArgsError extends Error {
  constructor(message) {
    super(message);
    this.name = "ArgsError";
  }
}

// Levenshtein distance, for "did you mean" suggestions.
function distance(a, b) {
  const row = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let prev = row[0];
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cur = row[j];
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = cur;
    }
  }
  return row[b.length];
}

export function parseArgs(argv, spec = {}) {
  const out = { _: [] };
  const aliases = spec.aliases ?? {};
  const booleans = new Set(spec.booleans ?? []);
  const known = spec.values ? new Set([...spec.values, ...booleans]) : null;

  const canonOf = (key) => aliases[key] ?? key;
  const checkKnown = (key, dash) => {
    if (!known || known.has(canonOf(key))) return;
    const near = [...known].filter((k) => k.length > 1).sort((a, b) => distance(key, a) - distance(key, b))[0];
    const hint = near && distance(key, near) <= 2 ? ` Did you mean --${near}?` : "";
    throw new ArgsError(`Unknown option ${dash}${key}.${hint}`);
  };
  const isFlagLike = (s) => s.startsWith("--") || (s.startsWith("-") && s.length > 1 && !/^-?\d/.test(s));

  // A token is a usable value for another flag iff it's not flag-shaped AND
  // its canonical name isn't a known boolean flag (which would otherwise be
  // silently swallowed).
  const isUsableValue = (s) => {
    if (s === undefined) return false;
    if (!isFlagLike(s)) return true;
    // It's flag-shaped — but if it would resolve to a declared boolean, reject it.
    const bare = s.replace(/^-+/, "").split("=")[0];
    if (booleans.has(canonOf(bare))) return false;
    // Otherwise, treat as value (matches users who legitimately need negative numbers or odd values).
    return !s.startsWith("--");
  };

  let i = 0;
  while (i < argv.length) {
    const a = argv[i];
    if (a === "--") {
      out._.push(...argv.slice(i + 1));
      break;
    }
    if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      const key = eq === -1 ? a.slice(2) : a.slice(2, eq);
      checkKnown(key, "--");
      const canon = canonOf(key);
      if (eq !== -1) {
        out[canon] = a.slice(eq + 1);
      } else if (booleans.has(canon)) {
        out[canon] = true;
      } else if (isUsableValue(argv[i + 1])) {
        out[canon] = argv[++i];
      } else {
        throw new ArgsError(`Missing value for --${key}`);
      }
    } else if (a.startsWith("-") && a.length > 1 && !/^-?\d/.test(a)) {
      const key = a.slice(1);
      checkKnown(key, "-");
      const canon = canonOf(key);
      if (booleans.has(canon)) {
        out[canon] = true;
      } else if (isUsableValue(argv[i + 1])) {
        out[canon] = argv[++i];
      } else {
        throw new ArgsError(`Missing value for -${key}`);
      }
    } else {
      out._.push(a);
    }
    i++;
  }
  return out;
}
