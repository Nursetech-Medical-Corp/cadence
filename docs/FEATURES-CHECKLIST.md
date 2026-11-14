# Feature checklist

What people do in Cadence, per feature. Before shipping a change, every row that the change touches must still work.
Rows marked (e2e) are checked by a browser script in `tests/e2e/`; the rest by unit tests in `tests/` or by hand.
Found a bug? Add a row here and a scenario to the matching script, so it stays fixed.

## Everywhere
- Ctrl+Z undoes the last change, also right after typing in a box that is now empty.
- Clicking outside a side panel or editor closes it; it never also creates something.
- Every title is editable where it is shown.
- New things land where you can see them and never on top of each other.
- Drag and drop always shows where the drop will land before you let go.
- Changes made by another tab, an agent or MCP show up without a reload, and never undo a newer local change.

## Day planner
- Three views with the same features: Focus (default), Three columns, Timeline across. Each keeps the week row, day arrows and Today in view while the hours scroll, and opens at now. (e2e)
- Box edges show a small grab line only when the pointer is on that edge.
- Brain dump: Enter adds a line; pasting many lines adds them all. (e2e)
- Match on shows at most 3 close tasks under each line as chips, never a full list. (e2e)
- Tying a line to a task links it, adds you to the task, and sets due today if it had no date. (e2e)
- Create tasks asks first, names the space, and links every copy of the line (top 3, boxes). (e2e)
- Ctrl+Z after Create tasks removes the tasks and unlinks the lines. (e2e)
- Top 3 and Brain dump reorder by drag with a drop line; Top 3 shows a drop zone; it holds 3. (e2e)
- Drag a line or task onto the day: a preview shows the snapped time; the box lands there. (e2e)
- Press and drag on an empty time makes a box (like a calendar); with an editor or task panel open, a click only closes it. (e2e)
- Every box has a play button; on a plain box it makes a task first, then times it. (e2e)
- Clicking a task box opens the task (notes, status, people); the clock opens the time slot editor (time, length, reminder, agenda, tied tasks, calendar); a plain box opens the slot editor. (e2e)
- Drag a box's top edge to move its start (the end stays), its bottom edge to change its length. (e2e)
- The week strip shows 7 days with planned time, calendar events and tasks due; click a day to open it. (e2e)
- The timesheet for the day lists every timer and logged entry in time order with totals. (e2e)
- Each day is planned in one time zone (a new day takes the computer's); box times are wall-clock times there; reminders follow; a note offers to switch when the computer is elsewhere. (e2e)
- Plan my day: today starts now; another day starts at the planning start (working hours from calendar settings), never 6am by default; meetings stay free.
- Task boxes show status, priority, due, estimate, space, SOP and people; done boxes turn green and struck through.
- The day runs midnight to midnight; 12am to 6am folds open; a red line marks now. (e2e)
- Plan my day from now: top 3, then due and overdue, then the dump; lines with a time ("2PM meeting") go at that time.
- Calendar events show on the day in their color; clicking one opens the full calendar editor (guests, Meet link, repeats, color, visibility, Open in Google Calendar); + makes one a box to tie tasks to. (e2e)
- A box's Add to calendar opens the same editor prefilled (title, time, agenda, tied tasks); saving ties the box to the event. (e2e)
- Event colors are Google Calendar colors and sync both ways.
- Fit to my time (up to now, or whole day): boxes move to logged time, sessions of one task split into boxes, logged work with no box gets one, the plan shows as a dashed outline, Back to plan in the editor, Ctrl+Z undoes. (e2e)
- Reminders fire once at the start of a box, again after a move.
- List spaces (records) never show in Assigned.

## Whiteboards
- Left drag on the board box-selects; middle drag, Space+drag or the hand tool pans; Shift+wheel scrolls sideways; Ctrl+wheel zooms. (e2e)
- Drag from any of a card's four dots; the card it is near lights up and the arrow snaps to it on release. (e2e)
- Arrows out of a decision are labeled Yes, then No. (e2e)
- Tables: double-click a cell to type, Tab moves on, Enter on the last row adds one. (e2e)
- Flow tools (start/stop, task, decision, trigger, webhook, end) and note tools (title, text, sticky, info, table, shape, frame, link). (e2e)
- New boards open with a title; boards drawn from work have a title, a summary line and the SOP document.
- One board per SOP; SOPs that have a board keep it; the Routines page links each SOP to its board.
- Create tasks turns unlinked cards into tasks; arrows become dependencies; running it again makes nothing new.
- Runs: tasks in order, webhooks fire after the steps before them, retry and skip, run log; triggers by hand, webhook, schedule, finished tag.

## Sub-spaces and list spaces
- A sub-space nests under its parent in the sidebar, one level deep.
- Pipeline and contact lists hold records: kept out of All spaces, My work, the day planner and reminders.
- The parent gets a relation column so its tasks can point at the records.

## Routines
- Skip, delay, wait, pause, resume and end; one live copy each; SOP links open the document.
