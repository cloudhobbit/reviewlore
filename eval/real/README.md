# Real-data eval set

`comments.json` holds 540 comments sampled from the cached review history
of five public repositories, each hand-labelled for whether it contains
review guidance. `eval/run-real-eval.mjs` scores candidate extraction
against it; `npm run eval:real` fails CI if the held-out split drops
below the floors set in that script.

| Split | Repos | Comments | Positives | Use |
|---|---|---|---|---|
| `dev` | vitest-dev/vitest, pnpm/pnpm | 300 | 35 | Tune patterns and filters against this. |
| `test` | expressjs/express, tj/commander.js, vercel/swr | 240 | 25 | Held out. Report it; don't tune against it. |

## Labelling rubric

A comment is **positive** (`label: 1`) when someone other than the PR
author asks for, or prescribes, a change to the PR: its code, tests,
docs, naming or API, or a process step (add a changeset, rebase, split
the PR). Soft phrasing counts ("Can we make this simpler?", "why not
reuse X?", "I think the default should be true").

A comment is **negative** (`label: 0`) when it is:

- by a bot account, on a plain issue (not a PR), or by the PR's author —
  these are negative by definition;
- a pure information question, status update, thanks, approval, or
  bug-report / reproduction discussion;
- an opinion or rejection with no requested action ("a close from me");
- a GitHub `suggestion` block with no prose, since there is no rule text
  to learn from.

Labels are at comment level: the eval checks whether the pipeline extracts
at least one candidate from a comment, not which sentence it picks.

## Sampling and privacy

The comments are public GitHub review comments. If you wrote one and want
it removed from this set, open an issue on this repository.

- Comments with a body of at least 20 characters were sampled uniformly
  per repo, ordered by a SHA-256 hash of `repo + comment id`, so the
  sample is reproducible from the same cache.
- Author logins and `@mentions` are replaced with per-repo pseudonyms
  (`user-1`, `user-2`, …); bot accounts keep their public bot names.
  Email addresses and home-directory paths in bodies are scrubbed.
- Bodies and `html_url`s are otherwise kept as posted (public GitHub
  content); the URL is what distinguishes a PR comment from a plain-issue
  comment.

## Known contamination

The held-out comments were read during labelling, and three changes made
afterwards were partly prompted by held-out examples: matching
typographic apostrophes (`don’t`), "we don't accept …", and "can be
omitted / is redundant". Without them the held-out split scores
65.0% precision / 52.0% recall (with them: 69.6% / 64.0%). The next
labelling round should add a fresh held-out repo nobody has read.

## Extending

Add comments with the same record shape and a `split`, keep the rubric
above, and raise `FLOORS` in `eval/run-real-eval.mjs` when the pipeline
improves. Never lower a floor to make a change pass.
