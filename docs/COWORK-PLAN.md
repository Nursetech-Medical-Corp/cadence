# Cowork plan: organize the Nursetech Cadence workspace

Paste this whole file into a new Cowork chat as the first message. Work one step at a time and stop for approval after each.

## Connect first

- Cadence MCP is the connector. It talks to the same server and data as the REST API, with the same permission checks. MCP is the better fit for Claude: it has planning tools (estimate_missing, replan, forecast, sprints, templates) built in.
- In Claude: Settings, Connectors, Add custom connector, paste `https://<cadence host>/mcp`, then sign in to Cadence and click Allow (OAuth). Claude acts as you, with your permissions.
- Fallback for clients without OAuth: a `tt_` token from Team and permissions, as `https://<cadence host>/mcp?ws=<workspace id>&key=tt_...`.
- First calls: `get_guide`, then `get_workspace`.
- Also connect Google Drive (SOPs, recurring task lists, financial model).

## Terms

- Space = top level area (API calls it project). Levels inside: Project > Phase > Task > Subtask.
- "All spaces" = rollup space that shows every other space. Build it last.

## Steps (approve each)

1. **Read the workspace.** List spaces, items, sprints, recurring items, people. Report counts and anything odd. No changes.
2. **Create spaces:** Finance, Sales, Marketing, Gen Business, Fundraising, HR & People, Logistics, R&D, QA.
   - QA is FDA / quality system (design controls, CAPA, NCR, DR, CO, test plans), NOT bots.
   - Same statuses and levels across spaces unless a space needs its own.
3. **Sort.** Propose a mapping of every existing item to a space, nested Project > Phase > Task. Show the mapping as a table, wait for approval, then apply.
4. **Estimates.** Hours or minutes per open item (use `estimate_missing`, then adjust). Show the table, user reviews, then `apply_estimates`.
5. **Dates and sprints.** Update due dates where real dates exist. Everything else goes into sprints sized to capacity (`create_sprint`, `sprint_report`). User adds more after.
6. **Recurring tasks audit.** They already exist. Check each one:
   - repeat rule right (weekly / monthly / etc), next due date right
   - in the right space (move it if not)
   - matches the Drive SOP / recurring list; add any missing
   - include full-time recurring work
   Report: OK / fixed / added / questions.
7. **Gantt from the financial model.** Wait for the user to share the updated model.
   - Build phases, milestones and dependencies so the Timeline view works.
   - Wrap in past work (October, November): mark done or carry over, ask when unclear.
   - Add the work the model implies but does not list (read between the lines, follow the SOPs, draft new SOPs where missing). Examples:
     - HR: when to start candidate search before each planned hire
     - Conferences: registration deadlines, booth/shipping setup, flights and hotels, materials
     - Fundraising: deck updates, data room, investor follow-ups ahead of each raise
     - Regulatory/QA: submission prep lead times
8. **All spaces rollup.** Create it last, once the spaces exist.
9. **Current priorities.** User updates with recent work and priorities; add those steps.

## Rules

- Never delete without listing what goes and getting a yes.
- Show proposed changes as tables before applying bulk changes.
- Ask when a mapping or date is a guess.
