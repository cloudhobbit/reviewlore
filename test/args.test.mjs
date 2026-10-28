import { test } from "node:test";
import assert from "node:assert/strict";
import { parseArgs, ArgsError } from "../lib/args.mjs";

test("parseArgs: --flag value pairs", () => {
  const r = parseArgs(["--owner", "facebook", "--repo", "react"]);
  assert.equal(r.owner, "facebook");
  assert.equal(r.repo, "react");
});

test("parseArgs: --flag=value form", () => {
  const r = parseArgs(["--months=12"]);
  assert.equal(r.months, "12");
});

test("parseArgs: boolean flags", () => {
  const r = parseArgs(["--per-month", "--help"], {
    booleans: ["per-month", "help"],
  });
  assert.equal(r["per-month"], true);
  assert.equal(r.help, true);
});

test("parseArgs: positional args go into _", () => {
  const r = parseArgs(["facebook", "react", "6"]);
  assert.deepEqual(r._, ["facebook", "react", "6"]);
});

test("parseArgs: short aliases map to canonical", () => {
  const r = parseArgs(["-o", "x", "-r", "y"], {
    aliases: { o: "owner", r: "repo" },
  });
  assert.equal(r.owner, "x");
  assert.equal(r.repo, "y");
});

test("parseArgs: -- ends flag parsing", () => {
  const r = parseArgs(["--owner", "x", "--", "--not-a-flag", "raw"]);
  assert.equal(r.owner, "x");
  assert.deepEqual(r._, ["--not-a-flag", "raw"]);
});

test("parseArgs: trailing boolean without value", () => {
  const r = parseArgs(["--dry-run"], { booleans: ["dry-run"] });
  assert.equal(r["dry-run"], true);
});

test("parseArgs: non-boolean flag without value throws (regression: #2)", () => {
  assert.throws(() => parseArgs(["--token"]), ArgsError);
  assert.throws(() => parseArgs(["--token"]), /Missing value for --token/);
});

test("parseArgs: refuses to consume a known boolean as another flag's value (regression: #3)", () => {
  assert.throws(
    () => parseArgs(["--out", "--per-month"], { booleans: ["per-month"] }),
    ArgsError,
  );
});

test("parseArgs: negative numeric values are accepted as values", () => {
  const r = parseArgs(["--offset", "-5"]);
  assert.equal(r.offset, "-5");
});

test("parseArgs: short alias for non-boolean missing value throws", () => {
  assert.throws(
    () => parseArgs(["-t"], { aliases: { t: "target" } }),
    ArgsError,
  );
});
