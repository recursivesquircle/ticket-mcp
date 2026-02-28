import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

type RpcResponse = {
  result?: {
    content?: { type: string; text?: string }[];
    data?: any;
  };
  error?: { message?: string };
};

async function rpc(url: string, method: string, params: any) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });

  const json = (await response.json()) as RpcResponse;
  if (json.error) {
    throw new Error(json.error.message ?? "RPC error");
  }
  return json.result;
}

async function callTool(url: string, name: string, args?: any) {
  const result = await rpc(url, "tools/call", {
    name,
    arguments: args ?? {},
  });
  if (result?.data !== undefined) return result.data;
  const text = result?.content?.[0]?.text;
  return text ? JSON.parse(text) : null;
}

function writeFixtureTicket(root: string) {
  const ticketsDir = path.join(root, "tickets", "pending");
  fs.mkdirSync(ticketsDir, { recursive: true });
  const baseTicket = `---
id: T-BASE-001
title: "Fixture Ticket"
status: pending

created_at: "2026-01-01T00:00:00Z"
updated_at: "2026-01-01T00:00:00Z"

area: "tooling"
epic: "none"
key_files:
  - "tools/ticket-mcp/src/server.ts"

intent: "Baseline ticket used for MCP integration tests."
requirements:
  - "Must be discoverable via tickets_list."
human_testing_steps:
  - "Run integration tests and ensure fixture is indexed."
constraints:
  - "No production files should be modified by this fixture."
depends_on: []

claimed_by: null
claimed_at: null
work_log: []
review_notes: null
---
# Fixture Ticket

## Overview

## Approach (medium/high-level)

## Tasks / Todos

## Requirements (AI implementation)

## Human Testing Steps

## Key Files / Areas (notes)

## Questions

## Blockers

## Implementation Notes
`;
  fs.writeFileSync(
    path.join(ticketsDir, "2026-01-01__T-BASE-001__fixture-ticket.md"),
    baseTicket,
    "utf8",
  );

  const higherNumberTicket = `---
id: T-BASE-042
title: "Seed Ticket"
status: pending

created_at: "2026-01-02T00:00:00Z"
updated_at: "2026-01-02T00:00:00Z"

area: "tooling"
epic: "none"
key_files:
  - "tools/ticket-mcp/src/server.ts"

intent: "Provide a higher ticket number for stats tests."
requirements:
  - "Must be valid and indexed."
human_testing_steps:
  - "Run integration tests and ensure stats include this ticket."
constraints:
  - "No production files should be modified by this fixture."
depends_on: []

claimed_by: null
claimed_at: null
work_log: []
review_notes: null
---
# Seed Ticket

## Overview

## Approach (medium/high-level)

## Tasks / Todos

## Requirements (AI implementation)

## Human Testing Steps

## Key Files / Areas (notes)

## Questions

## Blockers

## Implementation Notes
`;
  fs.writeFileSync(
    path.join(ticketsDir, "2026-01-02__T-BASE-042__seed-ticket.md"),
    higherNumberTicket,
    "utf8",
  );

  const mismatchedTicket = `---
id: T-BASE-100
title: "Mismatch Ticket"
status: done

created_at: "not-a-date"
updated_at: "still-not-a-date"

area: "tooling"
epic: "none"
key_files: []

intent: "Fixture ticket for reconcile tests."
requirements: []
human_testing_steps: []
constraints: []
---

# Mismatch Ticket

## Overview

## Approach (medium/high-level)

## Tasks / Todos

## Requirements (AI implementation)

## Human Testing Steps

## Key Files / Areas (notes)

## Questions

## Blockers

## Implementation Notes
`;
  fs.writeFileSync(
    path.join(ticketsDir, "2026-01-03__T-BASE-100__mismatch-ticket.md"),
    mismatchedTicket,
    "utf8",
  );
}

test("ticket MCP tool integration", async (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ticket-mcp-"));
  writeFixtureTicket(tempRoot);

  process.env.TICKET_ROOT = tempRoot;
  const { startServer } = await import("../src/server");
  const { server, url } = await startServer({
    host: "127.0.0.1",
    port: 0,
    strict: true,
    repoRoot: tempRoot,
  });

  t.after(() => server.close());
  t.after(() => fs.rmSync(tempRoot, { recursive: true, force: true }));

  const listResult = await callTool(url, "tickets_list", {
    status: ["pending"],
    text: "fixture",
  });
  assert.equal(listResult.tickets.length, 1);

  const createResult = await callTool(url, "tickets_create", {
    id: "T-TEST-INT-1",
    title: "Integration Test Ticket",
    area: "tooling",
    epic: "none",
    intent: "Exercise ticket MCP create/update/move tools.",
    requirements: ["Create ticket through MCP."],
    human_testing_steps: ["Run MCP integration tests."],
    constraints: ["Do not modify production tickets."],
    key_files: ["tools/ticket-mcp/src/server.ts"],
    created_at: "2026-01-31T00:00:00Z",
  });
  assert.ok(createResult.ok);

  const updateResult = await callTool(url, "tickets_update", {
    path: createResult.path,
    patch: { area: "tools", epic: "qa" },
  });
  assert.ok(updateResult.ok);

  const getResult = await callTool(url, "tickets_get", {
    path: createResult.path,
  });
  assert.equal(getResult.frontmatter.area, "tools");
  assert.equal(getResult.frontmatter.epic, "qa");

  const moveResult = await callTool(url, "tickets_move", {
    path: createResult.path,
    to_status: "archived",
  });
  assert.ok(moveResult.path.includes(path.join("tickets", "archive")));

  const statsResult = await callTool(url, "tickets_stats", {});
  assert.equal(statsResult.highest_ticket_number, 100);
  assert.equal(statsResult.next_ticket_number, 101);

  const nextIdResult = await callTool(url, "tickets_next_id", {});
  assert.equal(nextIdResult.highest_ticket_number, 100);
  assert.equal(nextIdResult.next_ticket_number, 101);
  assert.equal(nextIdResult.suggested_id, "T-101");

  const claimResult = await callTool(url, "tickets_claim", {
    id: "T-BASE-001",
    actor: "worker-ai:test",
    summary: "Claiming fixture ticket",
  });
  assert.ok(claimResult.ok);
  assert.ok(claimResult.path.includes(path.join("tickets", "in_progress")));

  const appendWorklogResult = await callTool(url, "tickets_append_worklog", {
    path: claimResult.path,
    entry: {
      actor: "worker-ai:test",
      kind: "note",
      summary: "Added integration test note",
      details: { notes: ["log entry appended"] },
    },
  });
  assert.ok(appendWorklogResult.ok);

  const claimedTicket = await callTool(url, "tickets_get", {
    path: claimResult.path,
  });
  assert.equal(claimedTicket.frontmatter.claimed_by, "worker-ai:test");
  assert.equal(claimedTicket.frontmatter.status, "in_progress");
  assert.equal(
    claimedTicket.frontmatter.work_log[claimedTicket.frontmatter.work_log.length - 1].kind,
    "note",
  );

  const reconcilePreview = await callTool(url, "tickets_reconcile", {
    id: "T-BASE-100",
  });
  assert.equal(reconcilePreview.changed, 0);
  assert.equal(reconcilePreview.reports.length, 1);
  assert.ok(reconcilePreview.reports[0].before_issues.length > 0);

  const reconcileApply = await callTool(url, "tickets_reconcile", {
    id: "T-BASE-100",
    apply_fixes: true,
  });
  assert.equal(reconcileApply.changed, 1);
  assert.equal(reconcileApply.unresolved, 0);

  const reconciledTicket = await callTool(url, "tickets_get", {
    id: "T-BASE-100",
  });
  assert.ok(reconciledTicket.path.includes(path.join("tickets", "done")));
  assert.equal(reconciledTicket.issues.length, 0);

  const validateResult = await callTool(url, "tickets_validate", {});
  assert.equal(validateResult.issues.length, 0);

  const invalidCreate = await callTool(url, "tickets_create", {
    id: "T-TEST-INT-2",
    title: "Invalid Ticket",
    area: "tooling",
    epic: "none",
    intent: "",
    requirements: [],
    human_testing_steps: ["N/A"],
    constraints: ["N/A"],
    key_files: ["tools/ticket-mcp/src/server.ts"],
  });
  assert.ok(invalidCreate.error);
});
