# Working on Cadence

- Every feature ships with its agent surface in the same PR:
  1. REST route in `server/api.ts` (with role checks),
  2. MCP tool in `server/mcp.ts` (and `server/tokens.ts` checks/filters for guarded tokens, `server/agents.ts` WRITE_OPS if it changes data),
  3. docs: `docs/AI-GUIDE.md` (feature map row, how it works, REST line) and `docs/MCP.md` (tools table),
  4. tests in `tests/`.
- `tests/docs.test.ts` fails if any MCP tool is missing from the docs.
- Keep generic features generic: no company names or data in code. Company data (SOP links, spaces, items) lives in the running instance, not the repo.
- Writing style in docs and UI: short, plain, no em dashes.
