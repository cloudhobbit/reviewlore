import { test } from "node:test";
import assert from "node:assert/strict";
import { applyPreset, presetNames, PRESETS } from "../lib/presets.mjs";

test("PRESETS: well-known names are defined", () => {
  const names = presetNames();
  for (const expected of ["team-of-3", "team-of-50", "oss-maintainer", "new-joiner", "monthly-refresh", "exploratory"]) {
    assert.ok(names.includes(expected), `expected preset "${expected}"`);
  }
});

test("PRESETS: each preset has a description and options", () => {
  for (const [name, def] of Object.entries(PRESETS)) {
    assert.ok(def.description, `${name} missing description`);
    assert.ok(def.options && typeof def.options === "object", `${name} missing options`);
  }
});

test("applyPreset: fills in defaults but doesn't override explicit args", () => {
  const args = { "min-occurrences": "10" }; // user explicitly set
  applyPreset(args, "team-of-3");
  // user-supplied value wins
  assert.equal(args["min-occurrences"], "10");
  // preset default fills in unset value
  assert.equal(args["min-authors"], "2");
});

test("applyPreset: unknown preset name throws", () => {
  assert.throws(() => applyPreset({}, "bogus-preset"), /Unknown --preset/);
});

test("applyPreset: no preset is a no-op", () => {
  const args = { foo: "bar" };
  applyPreset(args, undefined);
  assert.deepEqual(args, { foo: "bar" });
});

test("applyPreset: team-of-50 enables semantic engine and tightens thresholds", () => {
  const args = {};
  applyPreset(args, "team-of-50");
  assert.equal(args.engine, "semantic");
  assert.equal(args["min-occurrences"], "5");
  assert.equal(args["min-authors"], "3");
});

test("applyPreset: new-joiner disables time decay (conventions don't expire)", () => {
  const args = {};
  applyPreset(args, "new-joiner");
  assert.equal(args["time-decay-half-life"], "0");
  assert.equal(args.months, "12");
});
