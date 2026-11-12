# Routines: on/off, skip, end, previews

## Problem
- 125+ SOP routines landed at once. About 42h/week of a 50h week.
- No way to switch a routine (or a whole SOP) off without deleting it.
- No way to see future dates of a routine on the Timeline or Calendar.

## How it works
- One live copy per routine. The next is made when the current one is finished. No stacking.
- `recur.paused = true` switches a routine off:
  - Hidden from every project view, My work, sprints, the planner and `open` item queries.
  - Stays on the Routines page with its history.
  - Turning it back on moves the due date to the next occurrence from today.
- Skip moves the live copy to its next date (start moves with it). Refused on the last occurrence.
- End clears the rule; the copy stays as a normal task.

## Routines page
- Totals: on, paused, hours per week (estimate x times per week), split by mode.
- Group by SOP (default) or by how often. SOP switch pauses or resumes every routine in it.
- Mode chip from tags: auto-job (a job runs it, a person approves), hybrid (job drafts, person finishes), manual.
- Row: switch, title, mode, rule, key, owner, estimate, next date, skip, end.

## Previews
- Timeline: faded dashed bars on the next dates within the visible range.
- Calendar: faded chips on the next dates, for routines that repeat weekly or less often. Toggle "Upcoming repeats".

## API
- REST: `GET /api/routines`, `POST /api/routines/act {ids, action}`.
- MCP: `list_routines {tag?, paused?}`, `set_routine {items? | tag?, action}`.
- AI agents on review: actions are held as proposals.
