# Spec: AI agents as owned teammates

Owner: David. Cadence items: NT-207 to NT-212, NT-214.

## Goal

- Each person can add their own AI agents (Claude, ChatGPT, Meta, others) as Cadence teammates.
- Agents find work they can do, suggest it, do it, and log it. **The agent's owner approves** before anything changes or closes, unless the work follows an AI SOP the owner approved.
- No custom API client needed: agents connect over MCP (Claude connector, OAuth or `?key=` token) and run on a schedule or on a trigger.

## Current state (from the code)

| Piece | Where | Today | Gap |
|---|---|---|---|
| AI people | `people.kind` 'human' or 'ai' (server/aiwork.ts migration); admin sets kind on Team page | Works | No owner. Only admins create them. |
| Login | Tokens per person (server/tokens.ts, Bearer or `?key=`); OAuth acts as the signed-in account | Works | Agent needs its own login email or a token. |
| Who does it | `fields.worker` human / ai / either | Works | |
| Review loop | claim, accept, submit, approve or send back (aiwork.ts) | Works | Any person can accept or approve, not the owner. |
| Done gate | AI cannot mark done unless `settings.aiMayComplete` (service.ts) | Works | Other writes (edit, move, reassign, create, delete) go straight through. |
| AI work tab | src/AIWork.tsx, `aiQueue()` | Filter by space only, all agents | Not per person. |
| Who is told | `humansToTell` = reviewer, creator, human assignees | Works | Owner not included. |
| Triggers | notifications table, `my_notifications`, `changes_since`, project webhooks | Polling works | No per-agent trigger on assignment. |

## Requirements

### A. Agent ownership
- `people.owner text null` (AI only) and `people.agent text null` JSON for settings (section F).
- Team page: **Add my AI agent** for any signed-in person. Owner = creator. Admin can reassign owner or remove.
- Owner can create and revoke tokens for their own agents only. Agents still cannot create tokens, people, roles or settings (keep `Tokens cannot create tokens`).
- Connect guide on the agent card: Claude connector URL with `?key=`, or REST base URL plus Bearer.

### B. Per-person AI work tab
- Default view **My agents**: items where `review.agent` is one of my agents, plus pending proposals (section C) from my agents.
- Tabs: Needs my OK (claims, submissions, proposals), In progress, Done (last 30 days), My agents' log.
- **All agents** toggle for admins only.
- Server enforces it: `decide()`, `reviewWork()` and proposal approval allowed for the agent's owner, a human assignee on the item, or an admin. Anyone else gets 403.
- Owner is added to `humansToTell`.

### C. Agent writes go to the owner for approval
- Setting per agent: `writePolicy: 'review' | 'direct'` (default `review`). Workspace admin can force `review`.
- When `review`, any data-changing call by an AI actor (create, update, move, reassign, delete, dates, status, create_event, templates, automations) is stored as a **proposal**, not applied:
  ```
  proposals (id, agent, owner, item_id null, project_id, op, payload json, reason text, created, state, decided_by, decided_at)
  ```
  The MCP call returns `{proposal: id, state: 'pending'}` so the agent knows to wait.
- Always allowed without approval (they do not change item data): `log_step`, comments, attach file, `claim_task`, `submit_work`, reads.
- **Approved AI SOPs bypass review**: `agent.autoApprove = ['SOP-07.26', ...]`. A write passes when the target item, its parent, or the template it came from carries an `sop` field or tag in that list. Log the bypass in activity with the SOP id.
- AI work tab shows each proposal as a diff (before vs after), with Approve, Edit then approve, Reject. Bulk approve by agent or by SOP.
- Approving applies the payload as the agent (activity actor = agent, `approved_by` = owner) so history stays true.

### D. Suggestion flow (agent finds work)
- New MCP tool `suggest_work {title or item, project, for_person, reason, sop?}`:
  - New work: creates a proposal to create the item with assignees `[for_person, that person's agent(s) chosen in settings]`, review state `claimed` by the agent.
  - Existing item: adds the agent and claims it.
- Rule for every AI-made assignment: if an agent is assigned, its **owner is added too**. An agent can never be the only assignee.
- If `sop` is in the owner's `autoApprove` list, the claim is auto-accepted. Otherwise it goes to Needs my OK.

### E. Triggers (no code needed on the agent side)
- On assignment change, for each newly assigned human, for each of their agents with `watchAssignments: true`:
  1. Notification to the agent person, kind `assigned` (readable via `my_notifications`).
  2. If `agent.webhook` is set, POST `{event: 'assigned', item, person, agent}` (use `safeTarget()` like project webhooks). Lets Zapier/n8n or a Claude trigger start a run right away.
- New MCP tool `agent_inbox {since}`: new assignments for the owner, open AI-eligible items in allowed spaces, sent-back work, and decided proposals. One call per run.
- Reference schedule (documented, not built): a Claude scheduled task per agent, hourly in work hours, prompt: "Call agent_inbox. For each item decide if you can do it within your settings. If yes, claim_task or suggest_work with a reason. If assigned and accepted, do it, log_step as you go, submit_work. Never mark done."

### F. Per-agent settings (agent card)
| Setting | Type | Default |
|---|---|---|
| Owner | person | creator |
| Provider | claude / chatgpt / meta / other | claude |
| Spaces allowed | list | owner's spaces |
| Work types | worker = ai only, or ai + either | ai + either |
| watchAssignments | bool | true |
| Check frequency | text (shown on card, used in the reference prompt) | hourly, work hours |
| Max open claims | int | 5 |
| writePolicy | review / direct | review |
| autoApprove SOPs | list of SOP ids | empty |
| Can create items | bool | true (as proposals) |
| Can email or invite outside people | bool | false |
| webhook | url | none |

### G. Outside bots
- ChatGPT, Meta or any other client: same AI person plus token, over MCP (if the client supports remote MCP) or the REST API. Settings and approval rules are identical.

## Build order
1. Owner field, Add my AI agent, owner-only approvals, per-person AI work tab (A, B).
2. Assignment rule (owner always added) and `suggest_work` (D).
3. Proposals with diff UI and SOP bypass (C).
4. `agent_inbox`, assignment notifications and agent webhooks (E). Settings card (F).

## Acceptance checks
- David adds "David's Claude", Collin adds "Collin's Claude". Each sees only their own agent's items and proposals; David cannot approve Collin's agent's work unless he is admin or a human assignee.
- With `review`, an agent's `update_item` changing a due date returns a proposal id and the item is unchanged until the owner approves.
- With `autoApprove: ['SOP-07.26']`, an agent's update to an item tagged SOP-07.26 applies directly and the activity log says so.
- `suggest_work` for Collin assigns Collin and Collin's agent, never the agent alone.
- Assigning a task to David fires a notification and the webhook for David's agent within 5 s.
- An agent cannot create tokens, people, change roles, or mark work done (existing rules still hold).
