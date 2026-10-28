import { test } from "node:test";
import assert from "node:assert/strict";
import { classifySentence, tokenize } from "../lib/patterns.mjs";

test("classifies prohibition (don't)", () => {
  const r = classifySentence("Don't use any types here");
  assert.equal(r.kind, "prohibition");
  assert.match(r.remainder, /any types/);
});

test("classifies prescription (always)", () => {
  const r = classifySentence("Always run the linter before pushing");
  assert.equal(r.kind, "prescription");
});

test("classifies request (please)", () => {
  const r = classifySentence("Please add a test for this edge case");
  assert.equal(r.kind, "request");
});

test("classifies question (why)", () => {
  const r = classifySentence("Why are you mutating state directly here?");
  assert.equal(r.kind, "question");
});

test("returns null for non-matching sentences", () => {
  assert.equal(classifySentence("This change is fine."), null);
});

test("tokenize strips stopwords and short tokens", () => {
  const tokens = tokenize("use the new helper instead of the old one");
  assert.ok(tokens.includes("helper"));
  assert.ok(!tokens.includes("the"));
  assert.ok(!tokens.includes("of"));
});

test("tokenize KEEPS domain keywords like 'any' (regression: #1)", () => {
  const tokens = tokenize("avoid any types here");
  assert.ok(tokens.includes("any"), "'any' must survive stopword filter for typed-language repos");
  assert.ok(tokens.includes("type"), "plural 'types' folds to 'type'");
});

test("classifies new prescription patterns: consider, this should be", () => {
  assert.equal(classifySentence("Consider using a helper here").kind, "prescription");
  assert.equal(classifySentence("This should be a separate function").kind, "prescription");
  assert.equal(classifySentence("I'd suggest extracting this").kind, "prescription");
});

test("classifies prohibition variants: shouldn't, please don't", () => {
  assert.equal(classifySentence("Shouldn't we use unknown here?").kind, "prohibition");
  assert.equal(classifySentence("Please don't mutate state directly").kind, "prohibition");
});

test("strips nit: / note: / TODO: prefix before classifying", () => {
  assert.equal(classifySentence("nit: please add a comment").kind, "request");
  assert.equal(classifySentence("TODO: avoid any types").kind, "prohibition");
  assert.equal(classifySentence("Q: why are you mutating this?").kind, "question");
});

test("hedges are not prohibitions: \"I don't think / know / understand\"", () => {
  assert.equal(classifySentence("I don't know if that's ok."), null);
  assert.equal(classifySentence("I don't understand."), null);
  assert.equal(classifySentence("I don't think there are any tests that cover this"), null);
});

test("a hedge that carries a directive still counts", () => {
  assert.equal(classifySentence("I don't think we should encourage checking tags").kind, "prohibition");
});

test("typographic apostrophes match like ASCII ones", () => {
  assert.equal(classifySentence("we don’t accept changes to the code style").kind, "prohibition");
  // ...and apostrophe-less typos still match.
  assert.equal(classifySentence("dont mutate the config object").kind, "prohibition");
  assert.equal(classifySentence("lets not do that here").kind, "prohibition");
});

test("ambiguous triggers only count at the start of a clause", () => {
  assert.equal(classifySentence("We currently use about three sources here"), null);
  assert.equal(classifySentence("It's been a never ending stream of spam"), null);
  assert.equal(classifySentence("Just use toMatchInlineSnapshot here").kind, "prescription");
  assert.equal(classifySentence("I'd avoid mutating the config object").kind, "prohibition");
});

test("social requests about the review itself are dropped", () => {
  assert.equal(classifySentence("Could you please assign it to me?"), null);
  assert.equal(classifySentence("When you get a chance, could you do a final review?"), null);
  assert.equal(classifySentence("Please see: the linked thread"), null);
  assert.equal(classifySentence("Please stop or we will ban you."), null);
  // ...but a real request with the same lead is kept.
  assert.equal(classifySentence("Could you resolve conflicts, please?").kind, "request");
});

test("status reports with 'should' are not guidance", () => {
  assert.equal(classifySentence("This should be fixed in the latest release."), null);
  assert.equal(classifySentence("The default value here should be true").kind, "prescription");
});

test("covers imperative, let's, need-to and necessity phrasings", () => {
  assert.equal(classifySentence("Add a test in test/ui for this").kind, "prescription");
  assert.equal(classifySentence("Let's not do that and just check enabled").kind, "prohibition");
  assert.equal(classifySentence("We'll need the documentation update too").kind, "prescription");
  assert.equal(classifySentence("This can be omitted from the signature").kind, "prescription");
  assert.equal(classifySentence("Why not reuse parseAst from vite?").kind, "question");
  assert.equal(classifySentence("[Q] Is this necessary?").kind, "question");
});

test("remainderStart indexes the input sentence, prefix included", () => {
  const s = "nit: please rename this to fooBar";
  const r = classifySentence(s);
  assert.equal(s.slice(r.remainderStart), "rename this to fooBar");
});

test("tokenize folds simple plurals but leaves -ss / -us / -is words", () => {
  assert.deepEqual(tokenize("tests cases process status analysis"), ["test", "case", "process", "status", "analysis"]);
});

test("prefix stripping needs a colon or a spaced dash", () => {
  assert.equal(classifySentence("Optional-chaining should be used here").remainder, "used here");
  assert.equal(classifySentence("NIT -- avoid globals in this module").kind, "prohibition");
});
