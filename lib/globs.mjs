// The glob dialect rule files use in `paths:` — **, *, ?, {a,b} and
// character classes [abc] / [a-z]. Negation ([!…], leading !) is rejected
// rather than guessed at.

const escape = (s) => s.replace(/[.+^$()|\\]/g, "\\$&");

export function globToRegExp(glob) {
  if (!glob || /[!\s]/.test(glob) || glob.startsWith("/")) return null;
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i];
    if (ch === "*" && glob[i + 1] === "*") {
      const slash = glob[i + 2] === "/";
      re += slash ? "(?:.*/)?" : ".*";
      i += slash ? 2 : 1;
    } else if (ch === "*") re += "[^/]*";
    else if (ch === "?") re += "[^/]";
    else if (ch === "[") {
      const end = glob.indexOf("]", i + 2);
      if (end === -1) return null;
      re += `[${glob.slice(i + 1, end).replace(/[\\^]/g, "\\$&")}]`;
      i = end;
    } else if (ch === "]") return null;
    else if (ch === "{") {
      const end = glob.indexOf("}", i);
      if (end === -1) return null;
      re += `(?:${glob.slice(i + 1, end).split(",").map((p) => escape(p).replace(/\*/g, "[^/]*")).join("|")})`;
      i = end;
    } else re += escape(ch);
  }
  return new RegExp(`^${re}$`);
}

// The directory part of a glob before its first wildcard ("packages/a/**/*.ts"
// → "packages/a"), or "" when it starts with one.
export function staticPrefix(glob) {
  const wild = glob.search(/[*?{]/);
  const head = wild === -1 ? glob : glob.slice(0, wild);
  return head.includes("/") ? head.slice(0, head.lastIndexOf("/")) : "";
}

// Whether a rule scoped to `glob` applies to `path` — a file, or a
// directory (no extension), in which case any file under it may match.
export function globCoversPath(glob, path) {
  const re = globToRegExp(glob);
  if (!re) return false;
  if (re.test(path)) return true;
  if (/\.[^/]+$/.test(path)) return false; // a file that didn't match
  const prefix = staticPrefix(glob);
  return prefix === "" || prefix === path || prefix.startsWith(`${path}/`) || path.startsWith(`${prefix}/`);
}
