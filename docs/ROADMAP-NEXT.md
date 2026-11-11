# Roadmap: next features

Sources: docs/COMPETITORS-2.md (Asana, Trello, Jira, Monday, Wrike, Plane, Focalboard, Vikunja, Taiga, OpenProject, Huly, Kanboard, Leantime, WeKan), docs/REQUEST-AUDIT.md, docs/QA-PASS-2.md.
Principle: a small medtech company with human and AI workers needs traceable decisions more than more views.

## Iteration A: decisions you can trust (now)

1. **Approvals and e-signatures.** Request approval on any item from one or more people with a meaning (reviewed, approved, verified, authored). Approvers approve, request changes (item stays open) or reject, with a comment. Signing asks for the signer's password when they have one, and records who, meaning, time, and a fingerprint of the item at signing. AI agents can request approvals but never sign. Pending approvals show on the item, in the Inbox and on an Approvals page. Verify: approve and reject flows, password check, AI blocked, fingerprint changes if the item changes.
2. **Workflow rules per item type.** Per type: which status moves are allowed, fields required before Done (estimate, owner, due date, custom fields), "approval required before Done", and "humans only can close". Enforced on the server for people, API and AI. Verify: blocked moves return a clear message; allowed moves pass.

## Iteration B: work comes in cleanly

3. **Intake forms and triage.** A shareable form per project (fields you pick). Submissions land in a Triage queue: accept (becomes a normal item), decline, or mark duplicate. AI can claim only accepted work.
4. **Milestones.** A type flag "milestone" with a diamond on the Timeline, progress from linked items, and dependencies.
5. **Flow metrics.** Cycle time, lead time and time in status from history, split human vs AI, on Insights.

## Iteration C: security and reach

6. **Two-step sign-in (TOTP)** for password accounts, required for admins when sign-in is on.
7. **Guest read-only links** scoped to one view.
8. **Two-way Google Calendar** for items with dates, using the existing Google connection.
9. **GitHub links**: branch, pull request and CI status on items; move on merge.

## Iteration D: bigger picture

10. Goals and a portfolio page with rolled-up progress across projects.
11. Releases or versions with generated release notes.
12. Action buttons on items and "field changed" and "on a schedule" automation triggers.
13. Relation and rollup fields.

Each item ships with tests, a guided tour step, and an MCP tool where it makes sense.
