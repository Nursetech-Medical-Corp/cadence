---
name: feature-check
description: Check a Cadence change against the feature checklist before committing or pushing. Runs the unit tests, the browser scenario scripts, and an adversarial pass over the scenarios the change touches. Use before every commit that changes app behavior, after adding a feature or plugin, and when the user reports something broken.
---

# Feature check

Run this before committing any change to app behavior. Do not report a feature as done until every step passes.

1. **Unit tests.** `pnpm test`. All must pass.
2. **Type check and build.** `npx tsc --noEmit && npx vite build`.
3. **Browser scenarios.** `pnpm e2e`. Each script starts its own server on a fresh database (ports 5198 and 5199), so stop anything on those ports first. Every scenario must print PASS.
4. **Checklist.** Read `docs/FEATURES-CHECKLIST.md`. For each row in a section your change touches, confirm it still holds: a script covers it (marked e2e), a unit test covers it, or you check it by hand in the browser and say so.
5. **Adversarial pass.** For the touched feature, try to break it the way a hurried person would:
   - do it twice fast, undo it, undo twice, then reload;
   - drag to the edge, drop on a text field, drop on itself, drop outside;
   - click while a panel or editor is open;
   - use it with empty text, very long text, a deleted task, a finished task, a routine's old copy;
   - use another day, another person, a token with less access, a list space;
   - make a change in another tab or through MCP while this one is open.
   Write down what happened for each. Anything wrong is a bug: fix it.
6. **Lock it in.** For every bug found (by you or the user), add a row to `docs/FEATURES-CHECKLIST.md` and a scenario to the matching `tests/e2e/*.e2e.cjs` (or a unit test), then run step 3 again.
7. **Report.** List what passed, what you checked by hand, and anything you could not check (for example Google sync without a connected account). Never say "done" for an unchecked row.
