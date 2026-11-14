# Webhooks

Cadence talks to other systems in three ways:

1. **Outbound webhooks**: Cadence POSTs JSON to your URL when something happens.
2. **Automation rules**: "when X happens, call this URL" (the `webhook` action), plus triggers for dates, comments, AI review and inbound calls.
3. **Inbound webhooks**: your system POSTs to Cadence with an API token to create, change or trigger things.

## Outbound webhooks

### Where to set them up

- One space: the space's Settings, Integrations, Webhooks. Needs the Settings permission in that space.
- Every space at once: Team page, Workspace webhooks (admins). Private spaces are left out.
- Agents and scripts: `list_webhooks`, `set_webhooks`, `test_webhook` (MCP), or `GET /api/hooks?scope=<spaceId|workspace>`, `PUT /api/hooks` `{scope, webhooks, dueSoonDays?}`, `POST /api/hooks/test` `{scope, id}`, `GET /api/hooks/deliveries?scope=&hook=`.

An endpoint is `{id, name, url, secret?, events, active}`. `events` is a list of event names; an empty list means every event. `active: false` switches it off without deleting it. The secret is write-only: once saved it is never sent back (you see `hasSecret: true`). Send `secret: ""` to remove it.

Endpoints saved before this version (`{id, url, events}` with no events) keep receiving what they received before: `item.created`, `item.updated`, `item.completed`, `item.deleted`, `item.restored`.

### What is sent

`POST <url>` with `content-type: application/json` and these headers:

| Header | Value |
| --- | --- |
| `X-Cadence-Event` | The event name, like `item.completed` |
| `X-Cadence-Delivery` | The delivery id. The same on every retry, so use it to ignore repeats |
| `X-Cadence-Signature` | Only when the endpoint has a secret: `sha256=<hex HMAC-SHA256 of the raw body, keyed with the secret>` |

The body is one envelope:

```json
{
  "id": "0b0f4a1e-6d0c-4c1d-9a55-0f6f3a1f8f10",
  "event": "item.status_changed",
  "at": "2026-11-13T15:04:05.000Z",
  "workspace": "main",
  "project": {"id": "a1b2c3d4e5f6", "key": "OPS", "name": "Operations"},
  "item": {"id": "...", "number": 12, "title": "Renew COI", "status": "doing", "assignees": ["..."], "due": "2026-11-20", "fields": {}},
  "changes": {"before": {"status": "todo"}, "after": {"status": "doing"}},
  "actor": "person id, or null for the system",
  "from": "todo",
  "to": "doing"
}
```

- `project` is null for events that belong to no space (`person.added`, a workspace test).
- `item` is the whole item as it is after the change, or null for events without one (sprints, spaces, people).
- `changes` is there for item changes: only the fields that changed, before and after.
- Anything after `actor` is extra detail for that event (see the table).

### Checking the signature

Compute the HMAC over the raw request body, before any JSON parsing, and compare in constant time.

```js
import {createHmac, timingSafeEqual} from 'node:crypto';

function fromCadence(rawBody, header, secret) {
  const want = 'sha256=' + createHmac('sha256', secret).update(rawBody).digest('hex');
  return !!header && header.length === want.length && timingSafeEqual(Buffer.from(header), Buffer.from(want));
}
```

```python
import hmac, hashlib

def from_cadence(raw_body: bytes, header: str, secret: str) -> bool:
    want = 'sha256=' + hmac.new(secret.encode(), raw_body, hashlib.sha256).hexdigest()
    return hmac.compare_digest(header or '', want)
```

### Delivery, retries and the log

- Answer with any 2xx within 10 seconds. Anything else (or no answer) counts as failed.
- A failed delivery is sent again after 1 minute, then 5 minutes, then 30 minutes, with the same body and the same `X-Cadence-Delivery`. After the fourth failure it is marked `failed`.
- Every delivery is logged with its status (`pending`, `ok`, `failed`), the number of tries, the HTTP code and the error. The log is under "Recent deliveries" next to the endpoints and is kept for 14 days.
- Only public addresses are called. A URL that points at this machine or a private network is refused and not retried. Redirects are not followed.
- "Send test event" sends `webhook.test` to that one endpoint.
- Events can arrive out of order and, after a retry, more than once. Use `id` to ignore repeats and `at` to order.

### Events

One change can send more than one event: finishing an item sends `item.updated`, `item.status_changed` and `item.completed`. Subscribe to the narrow ones you need.

| Event | When | Extra fields |
| --- | --- | --- |
| **Items** | | |
| `item.created` | An item is created | |
| `item.updated` | Any field of an item changes | `changes` |
| `item.completed` | An item moves to a Done status | `changes` |
| `item.reopened` | A done item is opened again (also a routine that reopens itself) | `changes` |
| `item.deleted` | An item is deleted (with its subitems) | |
| `item.restored` | Deleted items are brought back from history | `restored` (count) |
| `item.status_changed` | The status changes | `from`, `to` |
| `item.assigned` | People are added as assignees | `people` |
| `item.unassigned` | People are removed as assignees | `people` |
| `item.due_changed` | The due date changes | `from`, `to` |
| `item.priority_changed` | The priority changes | `from`, `to` |
| `item.moved` | The item moves to another space or another parent | `fromProject`, `fromParent` |
| `item.archived` | The item is archived (parked, idea, rejected) | |
| `item.unarchived` | The item is brought back from the archive | |
| **Dates** (checked hourly, once per item and date) | | |
| `item.due_soon` | The due date is near: 3 days and 1 day before by default (workspace setting `dueSoonDays`) | `days`, `daysLeft` |
| `item.due_today` | The item is due today | |
| `item.overdue` | The due date has passed and the item is open | `daysOverdue` |
| `item.start_reached` | The start date is today or earlier | |
| `sprint.started` | A sprint's first day | `sprint` |
| `sprint.ending_soon` | A sprint ends within 2 days | `sprint`, `daysLeft` |
| `sprint.ended` | A sprint's last day has passed | `sprint` |
| `sprint.rolled_over` | Unfinished work moved to the next sprint | `sprint`, `to`, `moved` |
| **Collaboration** | | |
| `comment.created` | A comment is added | `comment` |
| `comment.resolved` | A comment is marked resolved | `comment` |
| `mention.created` | Someone is mentioned in a comment | `comment`, `person` |
| `time.logged` | Time is logged, or a timer is stopped | `entry` |
| `timer.started` | A timer starts | `entry` |
| `timer.stopped` | A timer stops | `entry` |
| `approval.requested` | Approval is requested from people | `approvals` |
| `approval.signed` | An approver signs | `approval`, `decision` (`approved`, `changes`, `rejected`) |
| **AI work** | | |
| `ai.claimed` | An agent asks to take a task | `review` |
| `ai.accepted` | A person accepts the claim | `review` |
| `ai.declined` | A person declines the claim | `review` |
| `ai.submitted` | The agent hands in its work | `review`, `report`, `missed`, `artifacts` |
| `ai.approved` | The work is approved | `review`, `decision`, `comment` |
| `ai.changes_requested` | The work is sent back | `review`, `decision`, `comment` |
| `ai.redo_requested` | The reviewer asks for a fresh start | `review`, `decision`, `comment`, `cleanup` |
| `ai.discarded` | The work is rejected and the attempt closed | `review`, `decision`, `comment`, `cleanup` |
| `ai.step_logged` | An entry is written to the work log | `entry` |
| **Routines** | | |
| `routine.spawned` | Finishing a routine made its next occurrence (a new item, or the same one reopened) | `reopened`, `from` or `previousDue` |
| `routine.waiting` | A routine is set to wait for other work | `waitingOn` |
| `routine.resumed` | A waiting routine starts because its wait is over, or a waiting or paused one is resumed by hand | `reason` (`wait-over`, `wait-ended-by-hand`, `resumed`), `releasedBy` |
| `routine.skipped` | An occurrence is skipped | `from`, `to` |
| `routine.ended` | A routine stops repeating (ended by hand, or its count or end date is reached) | `reason` |
| **Other** | | |
| `notification.created` | A person gets a notification | `notification` (`person`, `kind`, `text`) |
| `automation.ran` | An automation rule ran | `rule`, `trigger` |
| `project.created` | A space is created | |
| `project.updated` | A space's settings change | `changed` |
| `project.deleted` | A space is deleted | |
| `person.added` | A person is added | `person` |
| `person.updated` | A person's details change | `person` (`id`, `changed`) |
| `webhook.test` | "Send test event" was pressed | `message`, `hook` |

Routine timing: a routine set to wait starts the moment the last item it waits for is finished. `routine.resumed` (and any rule with the trigger "A waiting or paused routine starts again") fires inside that same change. The routine's due date is then its next date on schedule from that day, not that day itself. To start a waiting routine before its wait is over, call `set_routine` with `action: "resume"` (inbound: `POST /api/hooks/in/set_routine`), or use the `routine-resume` rule action.

## Automations

Rules live in a space (Settings, Automations) and are `{id, name, enabled, trigger, conditions, actions}`. Rules are checked when saved; a bad rule is refused with the reason.

### Triggers

| Trigger | Fires when |
| --- | --- |
| `created` | An item is created |
| `status` `{to}` | The status changes to `to` |
| `completed` | An item is completed |
| `assigned` | Someone is added as assignee |
| `unassigned` | Someone is removed as assignee |
| `comment-added` | A comment is added |
| `review` `{to}` | AI review reaches a state: `claimed`, `accepted`, `submitted`, `changes`, `redo`, `approved`, `declined`, `discarded` |
| `routine-resumed` | A waiting or paused routine starts again |
| `webhook-received` `{key}` | An inbound call to `trigger` arrives with this key (see Inbound) |
| `due-soon` `{days}` | The due date is `days` away or less (and not yet today) |
| `due-today` | The item is due today |
| `due-passed` | The due date has passed |
| `overdue-by` `{days}` | The item is `days` or more past due |
| `start-reached` | The start date is today or earlier |

The five date triggers are checked hourly on open items. Each runs once per rule, item and date: when the date changes, the rule is armed again.

### Actions

`status`, `assign`, `priority`, `tag`, `sprint`, `due`, `notify`, `template`, `parent-status` change things in Cadence. Two more reach outside or act on routines:

- `{kind: "webhook", value: "<url>", secret?: "<secret>"}` sends the envelope above with `event: "automation.webhook"`, plus `rule` `{id, name}`, `trigger`, and for `webhook-received` the `data` that came in. It goes through the same delivery log, signature and retries. The secret is write-only.
- `{kind: "routine-resume"}` starts a waiting or paused routine now.

Example: tell a CRM when work is done.

```json
{"id": "r1", "name": "Done to CRM", "enabled": true, "trigger": {"kind": "completed"}, "conditions": [{"field": "tag", "value": "crm"}],
 "actions": [{"kind": "webhook", "value": "https://example.com/hooks/cadence", "secret": "s3cret"}]}
```

## Inbound webhooks

`POST /api/hooks/in/<action>` with `Authorization: Bearer tt_...` (an API token from the Team page) and a JSON body. The token is only accepted in the header, never in the URL. The call runs as the token's person with that person's permissions, exactly like the MCP tools.

Every MCP tool is an action with the same arguments: `create_item`, `update_item`, `complete_item`, `add_comment`, `upsert_external`, `log_time`, `start_timer`, `stop_timer`, `review_work`, `submit_work`, `set_routine`, `search_items` and the rest (see docs/MCP.md). One more, `trigger`, runs the automation rules that wait for a key.

```sh
curl -X POST https://cadence.example.com/api/hooks/in/create_item \
  -H "Authorization: Bearer tt_your_token" -H "content-type: application/json" \
  -d '{"project": "OPS", "title": "Call the vendor back", "due": "2026-11-20", "assignees": ["Sam"]}'
```

```sh
curl -X POST https://cadence.example.com/api/hooks/in/trigger \
  -H "Authorization: Bearer tt_your_token" -H "content-type: application/json" \
  -d '{"project": "OPS", "key": "deploy-finished", "item": "OPS-12", "version": "1.4.2"}'
```

`trigger` takes `project`, `key`, an optional `item` (the rules then act on it; without one only `webhook`, `template` and notify-a-person actions run) and anything else you send. The whole body is passed to `webhook` actions as `data` (or send `data` yourself). It answers `{ran: [{id, name}]}`.

Answers:

| Status | Meaning |
| --- | --- |
| 200 | Done. The body is the tool's result |
| 400 | Bad input. `problems` says what is wrong and `fields` lists the action's fields with `required` |
| 401 | No token, or a bad or revoked one |
| 403 | The token's person may not do this |
| 404 | Unknown action (the body lists every action), or the item or space was not found |

With more than one workspace, add `?ws=<workspace id>` to the URL. An AI agent set to "Wait for my approval" gets `{proposal, state: "pending"}` for changes, as it does over MCP.
