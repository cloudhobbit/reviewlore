---
description: Cut a new release of reviewlore (bump version, tag, push)
---

# /release

Cut a new release of this package. Before running, confirm with the user
which bump level to use (`patch` / `minor` / `major`).

## Steps

1. **Verify clean tree**: `git status` must be clean. Refuse to release on
   a dirty working copy.
2. **Run the full test + audit suite**: `npm test && npm run audit:all && npm run eval && npm run eval:real && npm run eval:skill`.
   If anything fails, stop and report.
3. **Update CHANGELOG.md first**: move the `[Unreleased]` entries under a
   new `[<new-version>] — YYYY-MM-DD` heading (Keep-a-Changelog format)
   and commit — `npm version` needs a clean tree.
4. **Bump version**: `npm version <patch|minor|major>` — this runs
   `scripts/update-version.js` (syncs `VERSION` in `cli/` and the plugin
   manifest's version), commits, and tags `v<new-version>`.
5. **Confirm with user** before pushing.
6. **Push**: `git push && git push --tags`. The `release.yml` workflow
   takes over (test matrix → npm publish via trusted publishing, with
   provenance).

## Pre-flight checklist for the user

- Is the npm trusted publisher configured for this repo and `release.yml`
  (see CONTRIBUTING.md, "First public release")?
- Is the new version number what they want? Re-read the diff since the
  last tag for unannounced breaking changes.
