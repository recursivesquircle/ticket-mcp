# Ticket MCP Server

Local MCP server for the repo ticket system (file-backed).

## Features
- List/get/update/move/validate tickets in `tickets/`
- Create new tickets with strict frontmatter validation
- Agent helpers: `tickets_next_id`, `tickets_claim`, `tickets_append_worklog`, `tickets_reconcile`
- Strict schema enforcement (rejects invalid writes)
- HTTP MCP endpoint plus optional stdio proxy

## Directory Structure & State Machine

The MCP server expects a `tickets/` directory in the root of your project (configured via `TICKET_ROOT`), containing the following subfolders that directly map to the ticket's `status` field. The server will strictly enforce that tickets reside in the correct folder for their status:

- `tickets/pending/` → `status: pending` (Ready to be picked up)
- `tickets/in_progress/` → `status: in_progress` or `status: blocked` (Claimed and being worked)
- `tickets/awaiting_human_test/` → `status: awaiting_human_test` (AI work complete; needs human testing)
- `tickets/done/` → `status: done` (Human has verified and accepted)
- `tickets/archive/` → `status: archived` (Obsolete or old tickets)

### Strict Markdown Validation

To prevent AIs from deleting context or inventing their own ticket formats, the MCP server enforces that all tickets contain specific markdown headers in their body. These headers will be automatically injected when creating a ticket via `tickets_create`.

Required body headers:
- `## Overview`
- `## Approach (medium/high-level)`
- `## Tasks / Todos`
- `## Requirements (AI implementation)`
- `## Human Testing Steps`
- `## Key Files / Areas (notes)`
- `## Questions`
- `## Blockers`
- `## Implementation Notes`

## Usage

Build:

```
npm install
npm run build
```

Start HTTP server:

```
npm run start
```

Auto-rebuild on changes (dev watch):

```
npm run dev
```

Run integration tests:

```
npm run test
```

Start stdio proxy (for MCP clients expecting stdio):

```
npm run stdio
```

Auto-restart stdio proxy on changes:

```
npm run stdio:dev
```

Note: build output lands under `dist/ticket-mcp/src/` because the build
includes shared schema sources.

## Configuration
- `TICKET_ROOT` (default: repo root inferred from cwd)
- `TICKET_MCP_PORT` (default: 3334)
- `TICKET_MCP_PATH` (default: /mcp)
- `TICKET_STRICT` (default: true)

## `tickets_stats` response

The `tickets_stats` tool returns aggregate counts plus ticket numbering metadata:

```json
{
  "status": {
    "pending": 12,
    "in_progress": 3,
    "done": 25
  },
  "area": {
    "tooling": 10,
    "combat": 8
  },
  "epic": {
    "none": 15,
    "qa": 4
  },
  "highest_ticket_number": 42,
  "next_ticket_number": 43
}
```

- `highest_ticket_number`: highest numeric suffix parsed from existing ticket IDs (or `0` if none are numeric).
- `next_ticket_number`: convenience value equal to `highest_ticket_number + 1`.

## Agent helper tools

- `tickets_next_id`
  - Returns `highest_ticket_number`, `next_ticket_number`, and `suggested_id`.
  - Optional args: `prefix` (default `T`), `separator` (default `-`), `padding` (default `3`).

- `tickets_claim`
  - Claims a `pending` ticket, moves it to `in_progress`, sets claim metadata, and appends a `work_log` entry.
  - Requires `actor`; accepts `id` or `path`.

- `tickets_append_worklog`
  - Appends a validated `work_log` entry and updates `updated_at`.
  - Requires `entry`; accepts `id` or `path`.

- `tickets_reconcile`
  - Audits ticket invariants and optionally applies safe fixes.
  - Optional `apply_fixes: true` will fix common metadata/date issues and folder/status mismatches when possible.

## Recommended agent workflow

Use this sequence for normal implementation flow:

```javascript
// 1) Allocate a canonical new id
const next = tickets_next_id({ prefix: "T", separator: "-", padding: 3 })

// 2) Create the ticket with suggested id
tickets_create({
  id: next.suggested_id,
  title: "Example ticket",
  area: "tools",
  epic: "none",
  intent: "Why this work matters",
  requirements: ["Requirement A"],
  human_testing_steps: ["Do X"],
  constraints: ["Constraint Y"],
  key_files: ["tools/ticket-mcp/src/server.ts"],
  status: "pending"
})

// 3) Claim when work starts
tickets_claim({
  id: next.suggested_id,
  actor: "worker-ai:example",
  summary: "Starting implementation"
})

// 4) Add progress notes during execution
tickets_append_worklog({
  id: next.suggested_id,
  entry: {
    actor: "worker-ai:example",
    kind: "change",
    summary: "Implemented the core logic"
  }
})

// 5) Validate and reconcile before handoff
tickets_validate({ id: next.suggested_id })
tickets_reconcile({ id: next.suggested_id }) // preview only
```
