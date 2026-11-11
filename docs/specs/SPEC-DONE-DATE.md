# Spec: Done date visible and editable

Cadence item: NT-213.

## Current state
- `items.completed` is set automatically when the status moves into a done-category status, kept when moving between done statuses, cleared on reopen (server/service.ts, `updateItem`). Recurring items in reopen mode clear it.
- Visible only as an added "Completed on" column (src/Fields.tsx) and in CSV export (src/DataPage.tsx). Not in the item panel. Cannot be edited, so work marked done late gets the wrong date.

## Requirements
1. Item panel: when done, show "Completed" with date and time (local) under Due.
2. People (not AI agents) can edit it: date-time picker. Server accepts `patch.completed` only when the item is done, value is not in the future and not before `created`. Write an activity entry ("completed date changed from X to Y").
3. Bulk action in list/table: "Mark done on..." sets status done and the chosen completed date for the selection.
4. List and table views: when the filter shows done items, show the Completed column by default and allow sort by it.
5. Reports (sprint_report, burndown, timesheet, estimate_missing history) use `completed` as is, so backdating corrects them.

## Acceptance checks
- Mark an item done today, set completed to last Tuesday: panel, column, export and burndown all show last Tuesday.
- Reopen it: completed clears. Done again: new timestamp.
- AI agent sending `completed` gets an error.
- Future date or date before creation is rejected.
