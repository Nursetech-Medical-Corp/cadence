# Connecting AI agents (MCP)

Cadence ships its own MCP server, so Claude (and any other MCP client) can read and run your spaces and projects: create and update work, plan sprints, replan schedules, run templates, review AI work, read history, and more. 89 tools in total. The full feature map is in [AI-GUIDE.md](AI-GUIDE.md) (served by `get_guide`).

There are three ways to connect. All act as one person in the workspace, and can do only what that person's role allows.

In the app, a workspace holds **spaces** (a team or area like Engineering, QA or Sales). The API and these tools call a space a *project* (`projectId`, `create_project`). Inside a space, work has levels; the default is Project > Phase > Task > Subtask.

## 1. Same computer (stdio)

No token needed. The agent acts as the person you name. Create a person for each agent first (Team and permissions, add a person, set them to AI agent), for example `secretary-bot-1`. The demo already has one.

**Claude Code**

```bash
claude mcp add cadence -- pnpm --dir /path/to/cadence mcp -- --as "secretary-bot-1"
```

Add `--workspace Personal` (a workspace name or id) to work in a workspace other than the first one:

```bash
claude mcp add cadence-personal -- pnpm --dir /path/to/cadence mcp -- --as "secretary-bot-1" --workspace Personal
```

**Claude Desktop** (Settings, Developer, Edit config):

```json
{"mcpServers": {"cadence": {"command": "pnpm", "args": ["--dir", "/path/to/cadence", "mcp", "--", "--as", "secretary-bot-1"]}}}
```

## 2. Claude (claude.ai, Cowork, Claude Desktop): sign in, no token

The easiest way. Needs `PUBLIC_URL` set on the server (the address people use, over HTTPS) and sign-in turned on.

1. In Claude, open Settings, Connectors, Add custom connector.
2. Name it Cadence and paste `https://<your-cadence-host>/mcp`. (Team page, Connect Claude shows the exact address. For a workspace other than the first, the address ends in `?ws=<workspace id>`.)
3. Click Connect. Sign in to Cadence if asked (password, Google or an emailed link), check the app and the workspace, and click Allow.

Claude then acts as you, with your role's permissions. See and disconnect connected apps on the Team page (My account), under Connect Claude. Deactivating a person cuts off the apps they connected.

Under the hood this is OAuth 2.1 as the MCP authorization spec describes: `/mcp` answers 401 with `WWW-Authenticate: Bearer resource_metadata=...`, metadata at `/.well-known/oauth-protected-resource` and `/.well-known/oauth-authorization-server`, dynamic client registration at `/oauth/register` (https redirect URIs, or http on localhost), `/oauth/authorize` with PKCE S256, `/oauth/token` (1 hour access tokens, rotating 30 day refresh tokens) and `/oauth/revoke`. Codes and tokens are stored hashed in `accounts.db`. See `server/oauth.ts`.

## 3. Over the network with a token (advanced)

1. Open Team and permissions. Under People, mark the agent as "AI agent" (or use your own person) and give it a role.
2. Under AI agents and tokens, create a token. It is shown once and starts with `tt_`.
3. Point the client at `http://<host>/mcp?ws=<workspace id>` with the token. The Team page shows the exact URL for the current workspace.

```bash
claude mcp add --transport http cadence "http://127.0.0.1:5190/mcp?ws=main" --header "Authorization: Bearer tt_your_token"
```

**Claude.ai / Cowork custom connector** (cannot send headers): Settings, Connectors, Add custom connector, and paste the URL with the token as `key`:

```
https://<your-cadence-host>/mcp?ws=<workspace id>&key=tt_your_token
```

Treat that URL like a password. Revoke the token on the Team page to cut it off.

Tokens are stored hashed, can be revoked at any time, and every tool call goes through the same permission checks as the app. Tokens cannot sign approvals and cannot change access rules.

## First call

Ask the agent to call `get_guide`, then `get_workspace`. The guide (also in [AI-GUIDE.md](AI-GUIDE.md) and at `/api/guide`) explains the data model, quick add syntax and the AI work loop.

## Tools

| Area | Tools |
| --- | --- |
| Read | `get_guide`, `get_workspace`, `list_job_roles` (job roles, the spaces and levels each opens, who has them; names only for non-admins), `search_items`, `get_item`, `my_work`, `project_summary`, `changes_since`, `history` |
| Write | `create_item`, `quick_add`, `update_item`, `complete_item`, `delete_item`, `add_comment`, `resolve_comment`, `apply_to_subitems`, `revert_change` |
| Views | `list_views`, `create_view`, `update_view` (filters, sorts, grouping, columns, colors, lock), `delete_view`, `reorder_views` |
| Data | `export_items` (JSON or CSV), `import_items` (adds rows, reports bad ones), `export_workspace` (admins) |
| Time | `start_timer`, `stop_timer` (with an outcome note), `log_time`, `list_time`, `get_timesheet`, `set_day_time`, `delete_time_entry` |
| Inbox | `my_notifications`, `mark_notifications_read` |
| Spaces (named project in the tools) | `create_project`, `update_project`, `delete_project` (admins, confirm by name), `create_rollup`, `set_automations`, `trigger_automation` |
| Sprints | `list_sprints`, `create_sprint`, `update_sprint`, `rollover_sprint`, `sprint_report` |
| Planning | `estimate_missing`, `apply_estimates`, `replan`, `apply_plan`, `forecast` |
| Templates | `list_templates`, `get_template`, `create_template`, `update_template`, `delete_template`, `save_template`, `use_template`, `template_gallery`, `install_pack`, `export_pack` |
| AI work loop | `ai_queue`, `claim_task`, `log_step`, `attach_file`, `submit_work`, `get_feedback`, `confirm_cleanup`, `review_work` (approve, changes, redo, discard), `decide_claim` |
| Approvals | `request_approval`, `list_approvals` |
| Routines | `list_routines` (state: on, delayed, waiting, paused), `set_routine` (skip, delay, wait, pause, resume, end; one item, many, or a whole SOP by tag). Auto-job routines take AI agents only. The built-in Routines space (scope `routines`) shows them in every view |
| Archive and later | `archive_item` (idea, parked, rejected), `snooze_item`, `restore_item`, `list_parked`. The built-in Archive and later space (scope `parked`) shows them |
| SOP links | `list_sop_links`, `set_sop_links` (admins) |
| Sub-spaces | `create_subspace` (tasks, pipeline or contact list under a space); `update_project` takes `parent` and `records` |
| Day planner | `get_day_plan`, `update_day_plan` (top 3, brain dump, time boxes with reminders), `schedule_day` (fill the day from a time) |
| Whiteboards | `list_boards`, `get_board`, `create_board`, `update_board` (add, change, remove nodes and connections), `delete_board`, `board_from_items` (routines by SOP, a tag, a parent, items), `boards_by_sop` (one board per SOP), `board_to_tasks`, `run_board`, `list_board_runs`, `board_run_action` (cancel, retry, skip) |
| Meetings | `list_events`, `create_event`, `update_event`, `delete_event`, `find_free_time`, `timeblock_item` |
| Agents | `agent_inbox`, `suggest_work`, `my_proposals` |

Agents can run a board like a project manager: create and change anything their role allows, set up views,
import and export items, and track time. They cannot approve: accepting a claim, approving or sending back AI work,
and signing approvals are refused for AI workers, whatever their role. An agent's own work is timed automatically:
the clock starts at its first logged step once it is cleared to work and stops when it submits, with the outcome as the note.
A person's review time is kept as a "review" time entry.

| Area | Tools |
| --- | --- |
| Integrations | `upsert_external` (CRM or accounting records), `create_from_email`, `calendar_events`, `gmail_search` |
| Webhooks (docs/WEBHOOKS.md) | `list_webhooks`, `set_webhooks`, `test_webhook`; every tool here is also an inbound action at `POST /api/hooks/in/<tool>` |

`calendar_events` and `gmail_search` work after the person connects their Google account on the Team page.

## Things to ask an agent

- "Read my overdue work across projects and propose a new schedule that fits my hours. Do not apply it yet."
- "Make a task template for onboarding a vendor: 6 steps, the first starts on day 0, each after the one before, AI drafts and a person approves."
- "Create next sprint, pull in the top 10 backlog items by priority, and give me the capacity check."
- "Take the next AI task from the queue, do it, log your steps with links, and submit a report."

## REST API

Everything the app does is also a REST call under `/api/...` with the same Bearer token (send `content-type: application/json`). Routes are listed in `server/api.ts`. Pick the workspace with the `x-workspace` header or `?ws=`.

## New tools not showing in Claude?

Claude caches a connector's tool list. After an update, open Settings, Connectors, Cadence and reconnect (or remove and add it again) so new tools appear.
