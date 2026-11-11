# Spec: Meetings and two-way Google Calendar

Owner: David. Cadence items: NT-205, NT-206. Extends roadmap item 8 in docs/ROADMAP-NEXT.md.

## Why

- Weekly meetings, standups, investor calls and board meetings need real time slots with attendees, not tasks.
- Today Cadence is a weak one-way calendar. Plans built in Cadence never reach people's real calendars on time.

## Current state (from the code)

| Piece | File | What it does | Gap |
|---|---|---|---|
| Google connect per person | server/googlelinks.ts | Scopes `calendar.readonly` + `calendar.events`. Refresh token stored per link. | Fine to build on. |
| Read events | `events()` in googlelinks.ts, `/google/events`, MCP `calendar_events` | Shows Google events read-only next to tasks (Everything view), primary calendar unless picked. | Not stored, no sync token, re-fetched every view. |
| Write events | `addEvent()` | Creates one **all-day** event. | No times, no attendees, no Meet link, no update or delete, nothing linked back. |
| ICS feed | `calendarFeed()` in server/integrations.ts | Items with dates as all-day events. | Google refreshes subscribed feeds on its own schedule (slow, often hours). Read-only in Google. All-day only. |

So: Cadence to Google = slow ICS or manual all-day adds. Google to Cadence = read-only display. No meetings, no invites, no sync.

## Scope

1. Meetings (timed events) as their own record, separate from items.
2. Invite people (Cadence people and outside emails), optional Google Meet link.
3. Two-way sync with each person's chosen Google calendar.
4. Time-block a task (put a task on the calendar for a slot), linked both ways.
5. Meeting hours count against capacity in sprint planning and replan.
6. Find a free time across attendees.

Out of scope: Outlook/Microsoft 365 (keep the code provider-shaped so it can be added), room booking.

## Data model (new tables)

```
events (
  id text pk, project_id text null, item_id text null,          -- optional space; optional linked task (prep or time-block)
  kind text not null,                                           -- 'meeting' | 'timeblock' | 'deadline'
  title text, body text, location text, meet_url text,
  start text not null, end text not null, all_day int, tz text, -- ISO with offset; tz = IANA name of organizer
  rrule text null, recurring_id text null, original_start text null,  -- recurring master and exceptions
  organizer text not null,                                      -- person id
  visibility text default 'space',                              -- 'space' | 'attendees' | 'private'
  created text, updated text, deleted text null
)
event_attendees (event_id, person text null, email text null, response text default 'needsAction', optional int)
event_links (event_id, link_id, calendar_id, google_event_id, etag, google_updated)   -- one row per synced copy
gcal_sync (link_id, calendar_id, sync_token, channel_id, resource_id, channel_expires, last_full_sync)
```

- `people.settings.calendar = {linkId, calendarId, pushTasks: 'none'|'due'|'timeblocks', tasksCalendarId}`.

## Behaviour

### Create and edit meetings
- Calendar view gets **Week** and **Day** modes with an hour grid (keep Month). Drag on the grid to create. Click to edit.
- Fields: title, time, duration, repeat, attendees (people picker plus free email), Meet link toggle, space, linked item, notes.
- Save writes the Cadence event, then pushes to the organizer's chosen Google calendar:
  - `events.insert` with `attendees`, `sendUpdates=all`, `conferenceDataVersion=1` + `conferenceData.createRequest` when Meet is on.
  - Store returned id, etag, updated in `event_links`.
- Edit: `events.patch` with `If-Match: etag`. On 412, fetch, show "changed in Google" and let the user choose.
- Delete: `events.delete`, `sendUpdates=all`. Soft-delete locally.

### Google to Cadence (incremental)
- First sync per calendar: `events.list` for now-30d .. now+180d, `singleEvents=false`, store `nextSyncToken`.
- Then `events.list?syncToken=` on each tick. On HTTP 410, drop the token and do a full sync.
- Ticks: push notifications via `events.watch` to `POST /api/google/push` (needs the public HTTPS URL; renew channels before `expiration`), and a poll every 5 min as fallback.
- Google events become `events` rows (kind 'meeting'), never items. "Make task from this" button creates a linked item (prep or follow-up).
- Private events of other people show as "Busy" only.

### Tasks on the calendar
- Time-block: drag a task onto the Week grid, or MCP `timeblock_item`. Creates an `events` row kind 'timeblock' with `item_id`. Moving the block updates the event, never the task's due date unless the block ends after due (then ask).
- `pushTasks = 'due'`: due dates as all-day events in a **dedicated "Cadence" calendar** (create with `calendars.insert`, needs the full `calendar` scope; ask on connect). Keep in sync on due change, completion (prefix "[Done]" or delete, setting), and item delete. This replaces the ICS feed for people who connect Google. Keep ICS for everyone else.

### Capacity
- `planner.ts` replan and `sprint_report` subtract meeting and time-block hours (attendee responses not 'declined') from each person's weekly hours.

### Find a time
- `freeBusy.query` across attendees with connected Google accounts plus Cadence events. Returns the first N slots in working hours (person setting, default 9 to 5 local, Mon to Fri).

## MCP and API

| Tool | Args | Notes |
|---|---|---|
| `list_events` | from, to, person?, project? | Cadence events plus synced Google events. Replaces `calendar_events` (keep as alias). |
| `create_event` | title, start, end or duration, attendees[], meet?, project?, item?, rrule? | AI agents: create as proposal (see SPEC-AI-AGENTS) unless the owner allows. |
| `update_event` / `delete_event` | event, patch | Same rule. |
| `find_free_time` | attendees[], duration_min, from, to | freeBusy. |
| `timeblock_item` | item, start, end | Person's own calendar. |

REST mirrors these under `/api/meetings` (`/api/events` is the app's live update stream).

## Permissions and safety
- Only the organizer (or admin) edits a meeting. Attendees change only their own response.
- An AI agent never sends invites to outside emails without its owner's approval.
- Tokens stay server-side. Webhook endpoint validates `X-Goog-Channel-ID` and `X-Goog-Resource-ID` against `gcal_sync`.

## Build order
1. Events table, Week/Day grid, create/edit/delete locally. MCP tools.
2. Push to Google with attendees and Meet (Cadence to Google). Recurring meetings.
3. Incremental Google to Cadence sync (sync token, watch channel, poll fallback).
4. Dedicated "Cadence" calendar for due dates, time-blocks.
5. Capacity math and find-a-time.

## Acceptance checks
- Create a weekly 30-min standup with 2 people and Meet on: both get Google invites with a Meet link; editing the time in Cadence moves it in Google within 10 s.
- Move that meeting in Google: Cadence shows the new time within 5 min (poll) or 10 s (push).
- Delete one instance in Google: only that instance disappears in Cadence.
- A task's due date change moves its all-day event in the "Cadence" calendar; completing it applies the chosen rule.
- 410 on sync token triggers a full resync with no duplicate events.
- Replan for a week with 6 h of meetings gives the person 44 h, not 50 h.
- An AI agent's `create_event` with an outside attendee lands in its owner's approval queue.
