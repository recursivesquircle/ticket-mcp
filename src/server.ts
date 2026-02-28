import "dotenv/config";
import http from "http";
import path from "path";
import fs from "fs";
import fg from "fast-glob";
import YAML from "yaml";
import type { AddressInfo } from "net";
import {
  TicketFrontmatter,
  TicketStatus,
  TicketStatusValues,
  WorkLogEntry,
  WorkLogKindValues,
} from "./schema";

type JsonRpcRequest = {
  jsonrpc: "2.0";
  id?: string | number | null;
  method: string;
  params?: any;
};

type JsonRpcResponse = {
  jsonrpc: "2.0";
  id: string | number | null;
  result?: any;
  error?: {
    code: number;
    message: string;
    data?: any;
  };
};

type TicketRecord = {
  path: string;
  frontmatter: Record<string, any>;
  body: string;
  parseError?: string;
};

type TicketSummary = {
  id: string;
  title: string;
  status: TicketStatus | string;
  area: string;
  epic: string;
  path: string;
  created_at?: string;
  updated_at?: string;
  intent?: string;
  issues?: string[];
};

type ServerConfig = {
  port?: number;
  host?: string;
  path?: string;
  strict?: boolean;
  repoRoot?: string;
};

let defaultPort = Number(process.env.TICKET_MCP_PORT ?? "3334");
let defaultHost = process.env.TICKET_MCP_HOST ?? "127.0.0.1";
let mcpPath = process.env.TICKET_MCP_PATH ?? "/mcp";
let strictMode =
  (process.env.TICKET_STRICT ?? "true").toLowerCase() !== "false";

let repoRoot = process.env.TICKET_ROOT ?? path.resolve(process.cwd(), "..", "..");
let ticketsRoot = path.join(repoRoot, "tickets");

function applyConfig(config: ServerConfig) {
  if (config.path) mcpPath = config.path;
  if (config.strict !== undefined) strictMode = config.strict;
  if (config.repoRoot) setRepoRoot(config.repoRoot);
}

function setRepoRoot(root: string) {
  repoRoot = root;
  ticketsRoot = path.join(repoRoot, "tickets");
}

const STATUS_TO_FOLDER: Record<TicketStatus, string> = {
  pending: "pending",
  in_progress: "in_progress",
  blocked: "in_progress",
  awaiting_human_test: "awaiting_human_test",
  done: "done",
  archived: "archive",
};

const FOLDER_TO_STATUS: Record<string, TicketStatus[]> = {
  pending: ["pending"],
  in_progress: ["in_progress", "blocked"],
  awaiting_human_test: ["awaiting_human_test"],
  done: ["done"],
  archive: ["archived"],
};

const REQUIRED_FIELDS: (keyof TicketFrontmatter)[] = [
  "id",
  "title",
  "status",
  "created_at",
  "updated_at",
  "area",
  "key_files",
  "intent",
  "requirements",
  "human_testing_steps",
  "constraints",
  "depends_on",
  "claimed_by",
  "claimed_at",
  "work_log",
  "review_notes",
];

function suggestStatus(value: string): TicketStatus | null {
  const normalized = value.trim().toLowerCase();
  if (!normalized) return null;
  for (const status of TicketStatusValues) {
    if (status === normalized) return status;
    if (status.startsWith(normalized) || normalized.startsWith(status)) {
      return status;
    }
  }
  return null;
}

function formatInvalidStatus(value: unknown): string {
  const raw = String(value);
  const suggestion = suggestStatus(raw);
  const valid = `Valid statuses: ${TicketStatusValues.join(", ")}`;
  if (suggestion && suggestion !== raw) {
    return `Invalid status: ${raw}. Did you mean ${suggestion}? ${valid}`;
  }
  return `Invalid status: ${raw}. ${valid}`;
}

const TOOL_ALIASES = [
  { alias: "tickets_list", canonical: "tickets.list" },
  { alias: "tickets_get", canonical: "tickets.get" },
  { alias: "tickets_update", canonical: "tickets.update" },
  { alias: "tickets_move", canonical: "tickets.move" },
  { alias: "tickets_validate", canonical: "tickets.validate" },
  { alias: "tickets_create", canonical: "tickets.create" },
  { alias: "tickets_stats", canonical: "tickets.stats" },
  { alias: "tickets_next_id", canonical: "tickets.next_id" },
  { alias: "tickets_claim", canonical: "tickets.claim" },
  { alias: "tickets_append_worklog", canonical: "tickets.append_worklog" },
  { alias: "tickets_reconcile", canonical: "tickets.reconcile" },
];

const TOOL_ALIAS_LOOKUP = new Map(
  TOOL_ALIASES.map(({ alias, canonical }) => [alias, canonical]),
);

const BASE_TOOL_DEFS = [
  {
    name: "tickets.list",
    description: "List tickets with optional filters",
    inputSchema: {
      type: "object",
      properties: {
        status: { type: "array", items: { type: "string" } },
        area: { type: "array", items: { type: "string" } },
        epic: { type: "array", items: { type: "string" } },
        text: { type: "string" },
      },
    },
  },
  {
    name: "tickets.get",
    description: "Get a ticket by id or path",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string" },
        path: { type: "string" },
      },
    },
  },
  {
    name: "tickets.update",
    description: "Update ticket frontmatter fields (strict mode enforced)",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string" },
        path: { type: "string" },
        patch: { type: "object" },
        work_log_entry: { type: "object" },
      },
      required: ["patch"],
    },
  },
  {
    name: "tickets.move",
    description: "Move a ticket to a new status folder and update status",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string" },
        path: { type: "string" },
        to_status: { type: "string" },
        work_log_entry: { type: "object" },
      },
      required: ["to_status"],
    },
  },
  {
    name: "tickets.validate",
    description: "Validate ticket frontmatter and folder invariants",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string" },
        path: { type: "string" },
      },
    },
  },
  {
    name: "tickets.create",
    description: "Create a new ticket with strict frontmatter validation",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string" },
        title: { type: "string" },
        area: { type: "string" },
        epic: { type: "string" },
        intent: { type: "string" },
        requirements: { type: "array", items: { type: "string" } },
        human_testing_steps: { type: "array", items: { type: "string" } },
        constraints: { type: "array", items: { type: "string" } },
        key_files: { type: "array", items: { type: "string" } },
        depends_on: { type: "array", items: { type: "string" } },
        status: { type: "string" },
        created_at: { type: "string" },
        body: { type: "string" },
        filename: { type: "string" },
      },
      required: [
        "id",
        "title",
        "area",
        "intent",
        "requirements",
        "human_testing_steps",
        "constraints",
        "key_files",
      ],
    },
  },
  {
    name: "tickets.stats",
    description: "Return counts plus highest/next ticket number",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "tickets.next_id",
    description: "Return highest/next ticket numbers and suggested id",
    inputSchema: {
      type: "object",
      properties: {
        prefix: { type: "string" },
        separator: { type: "string" },
        padding: { type: "number" },
      },
    },
  },
  {
    name: "tickets.claim",
    description: "Claim a pending ticket and move to in_progress",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string" },
        path: { type: "string" },
        actor: { type: "string" },
        summary: { type: "string" },
        details: { type: "object" },
      },
      required: ["actor"],
    },
  },
  {
    name: "tickets.append_worklog",
    description: "Append a validated work_log entry and update updated_at",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string" },
        path: { type: "string" },
        entry: { type: "object" },
      },
      required: ["entry"],
    },
  },
  {
    name: "tickets.reconcile",
    description: "Detect and optionally fix common ticket invariants",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string" },
        path: { type: "string" },
        apply_fixes: { type: "boolean" },
      },
    },
  },
];

const TOOL_DEFS = TOOL_ALIASES.map(({ alias, canonical }) => {
  const canonicalDef = BASE_TOOL_DEFS.find((def) => def.name === canonical);
  if (!canonicalDef) {
    throw new Error(`Unknown tool alias target: ${canonical}`);
  }
  return { ...canonicalDef, name: alias };
});

export function createServer(config: ServerConfig = {}) {
  applyConfig(config);
  const host = config.host ?? defaultHost;
  const port = config.port ?? defaultPort;

  const server = http.createServer(async (req, res) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");

    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    if (req.method !== "POST" || req.url !== mcpPath) {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Not found" }));
      return;
    }

    try {
      const body = await readRequestBody(req);
      const payload = JSON.parse(body);
      const response = await handleRpc(payload);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(response));
    } catch (err: any) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          jsonrpc: "2.0",
          id: null,
          error: { code: -32603, message: err.message ?? "Internal error" },
        }),
      );
    }
  });

  return { server, host, port, path: mcpPath };
}

export async function startServer(config: ServerConfig = {}) {
  const { server, host, port, path: serverPath } = createServer(config);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => resolve());
  });

  const address = server.address() as AddressInfo | string | null;
  const resolvedPort = typeof address === "object" && address ? address.port : port;

  return {
    server,
    host,
    port: resolvedPort,
    path: serverPath,
    url: `http://${host}:${resolvedPort}${serverPath}`,
  };
}

if (require.main === module) {
  startServer()
    .then(({ host, port, path: serverPath }) => {
      // eslint-disable-next-line no-console
      console.log(`ticket-mcp listening on http://${host}:${port}${serverPath}`);
    })
    .catch((err) => {
      // eslint-disable-next-line no-console
      console.error(err);
      process.exit(1);
    });
}

async function readRequestBody(req: http.IncomingMessage): Promise<string> {
  return await new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => {
      data += chunk;
    });
    req.on("end", () => resolve(data));
    req.on("error", (err) => reject(err));
  });
}

async function handleRpc(request: JsonRpcRequest): Promise<JsonRpcResponse> {
  if (!request || request.jsonrpc !== "2.0") {
    return {
      jsonrpc: "2.0",
      id: request?.id ?? null,
      error: { code: -32600, message: "Invalid JSON-RPC request" },
    };
  }

  try {
    switch (request.method) {
      case "initialize":
        return {
          jsonrpc: "2.0",
          id: request.id ?? null,
          result: {
            protocolVersion: "2024-11-05",
            serverInfo: { name: "ticket-mcp", version: "0.1.0" },
            capabilities: { tools: {} },
          },
        };
      case "tools/list":
        return {
          jsonrpc: "2.0",
          id: request.id ?? null,
          result: { tools: TOOL_DEFS },
        };
      case "tools/call":
        return {
          jsonrpc: "2.0",
          id: request.id ?? null,
          result: await handleToolsCall(request.params),
        };
      default:
        return {
          jsonrpc: "2.0",
          id: request.id ?? null,
          error: { code: -32601, message: "Method not found" },
        };
    }
  } catch (err: any) {
    return {
      jsonrpc: "2.0",
      id: request.id ?? null,
      error: { code: -32603, message: err.message ?? "Internal error" },
    };
  }
}

async function handleToolsCall(params: any) {
  const name = params?.name as string | undefined;
  const args = params?.arguments ?? {};

  if (!name) {
    return toolResult({ error: "Missing tool name" });
  }

  const resolvedName = TOOL_ALIAS_LOOKUP.get(name) ?? name;

  switch (resolvedName) {
    case "tickets.list":
      return toolResult(await listTickets(args));
    case "tickets.get":
      return toolResult(await getTicket(args));
    case "tickets.update":
      return toolResult(await updateTicket(args));
    case "tickets.move":
      return toolResult(await moveTicket(args));
    case "tickets.validate":
      return toolResult(await validateTickets(args));
    case "tickets.stats":
      return toolResult(await ticketStats());
    case "tickets.next_id":
      return toolResult(await nextTicketId(args));
    case "tickets.create":
      return toolResult(await createTicket(args));
    case "tickets.claim":
      return toolResult(await claimTicket(args));
    case "tickets.append_worklog":
      return toolResult(await appendTicketWorklog(args));
    case "tickets.reconcile":
      return toolResult(await reconcileTickets(args));
    default:
      return toolResult({ error: `Unknown tool: ${name}` });
  }
}

function toolResult(data: any) {
  return {
    content: [{ type: "text", text: JSON.stringify(data) }],
    data,
  };
}

async function listTickets(filters: any): Promise<{ tickets: TicketSummary[] }> {
  const files = await listTicketFiles();
  const normalized = normalizeFilters(filters);

  const tickets = files
    .map((filePath) => readTicketSummary(filePath))
    .filter((summary) => summary !== null)
    .map((summary) => summary as TicketSummary)
    .filter((summary) => ticketMatchesFilters(summary, normalized))
    .sort((a, b) => (b.updated_at ?? "").localeCompare(a.updated_at ?? ""));

  return { tickets };
}

async function getTicket(params: any) {
  const filePath = resolveTicketPath(params);
  if (!filePath) {
    return { error: "Ticket not found" };
  }

  const record = readTicket(filePath);
  if (!record) {
    return { error: "Failed to read ticket" };
  }

  const issues = validateTicket(record.frontmatter, record.body, record.path);

  return {
    path: record.path,
    frontmatter: record.frontmatter,
    body: record.body,
    issues,
    parse_error: record.parseError,
  };
}

async function updateTicket(params: any) {
  const filePath = resolveTicketPath(params);
  if (!filePath) {
    return { error: "Ticket not found" };
  }

  const record = readTicket(filePath);
  if (!record) {
    return { error: "Failed to read ticket" };
  }
  if (record.parseError) {
    return { error: "Ticket frontmatter parse error", issues: [record.parseError] };
  }

  const patch = params?.patch ?? {};
  const updatedFrontmatter = applyFrontmatterPatch(record.frontmatter, patch);
  updatedFrontmatter.updated_at = new Date().toISOString();

  if (params?.work_log_entry) {
    updatedFrontmatter.work_log = appendWorkLog(
      updatedFrontmatter.work_log,
      params.work_log_entry,
    );
  }

  const issues = validateTicket(updatedFrontmatter, record.body, filePath);
  if (strictMode && issues.length > 0) {
    return { error: "Validation failed", issues };
  }

  writeTicket(filePath, updatedFrontmatter, record.body);
  regenerateIndex().catch(() => { });

  return { ok: true, path: filePath, issues };
}

async function moveTicket(params: any) {
  const filePath = resolveTicketPath(params);
  if (!filePath) {
    return { error: "Ticket not found" };
  }

  const targetStatus = params?.to_status as TicketStatus;
  if (!TicketStatusValues.includes(targetStatus)) {
    return { error: formatInvalidStatus(targetStatus) };
  }

  const record = readTicket(filePath);
  if (!record) {
    return { error: "Failed to read ticket" };
  }
  if (record.parseError) {
    return { error: "Ticket frontmatter parse error", issues: [record.parseError] };
  }

  const updatedFrontmatter = { ...record.frontmatter };
  updatedFrontmatter.status = targetStatus;
  updatedFrontmatter.updated_at = new Date().toISOString();

  if (params?.work_log_entry) {
    updatedFrontmatter.work_log = appendWorkLog(
      updatedFrontmatter.work_log,
      params.work_log_entry,
    );
  }

  const destination = resolvePathForStatus(filePath, targetStatus);
  if (!destination) {
    return { error: "Unable to resolve destination path" };
  }

  const issues = validateTicket(updatedFrontmatter, record.body, destination);
  if (strictMode && issues.length > 0) {
    return { error: "Validation failed", issues };
  }

  ensureDir(path.dirname(destination));
  writeTicket(destination, updatedFrontmatter, record.body);

  if (destination !== filePath) {
    fs.unlinkSync(filePath);
  }
  regenerateIndex().catch(() => { });

  return { ok: true, path: destination, issues };
}

async function validateTickets(params: any) {
  const filePath = resolveTicketPath(params);
  if (filePath) {
    const record = readTicket(filePath);
    if (!record) {
      return { error: "Failed to read ticket" };
    }
    const issues = validateTicket(record.frontmatter, record.body, filePath);
    if (record.parseError) {
      issues.push(record.parseError);
    }
    return { path: filePath, issues };
  }

  const files = await listTicketFiles();
  const results = files
    .map((candidate) => {
      const record = readTicket(candidate);
      if (!record) {
        return { path: candidate, issues: ["Failed to read ticket"] };
      }
      const issues = validateTicket(record.frontmatter, record.body, candidate);
      if (record.parseError) {
        issues.push(record.parseError);
      }
      return { path: candidate, issues };
    })
    .filter((entry) => entry.issues.length > 0);

  return { issues: results };
}

async function ticketStats() {
  const files = await listTicketFiles();
  const summaries = files
    .map((filePath) => readTicketSummary(filePath))
    .filter((summary) => summary !== null) as TicketSummary[];

  const counts = {
    status: {} as Record<string, number>,
    area: {} as Record<string, number>,
    epic: {} as Record<string, number>,
  };

  for (const summary of summaries) {
    increment(counts.status, summary.status || "unknown");
    increment(counts.area, summary.area || "unknown");
    increment(counts.epic, summary.epic || "unassigned");
  }

  const ticketNumbers = summaries
    .map((summary) => extractTicketNumber(summary.id))
    .filter((value): value is number => value !== null);
  const highestTicketNumber =
    ticketNumbers.length > 0 ? Math.max(...ticketNumbers) : 0;

  return {
    ...counts,
    highest_ticket_number: highestTicketNumber,
    next_ticket_number: highestTicketNumber + 1,
  };
}

async function nextTicketId(params: any) {
  const files = await listTicketFiles();
  const summaries = files
    .map((filePath) => readTicketSummary(filePath))
    .filter((summary) => summary !== null) as TicketSummary[];

  const ticketNumbers = summaries
    .map((summary) => extractTicketNumber(summary.id))
    .filter((value): value is number => value !== null);
  const highestTicketNumber =
    ticketNumbers.length > 0 ? Math.max(...ticketNumbers) : 0;
  const nextTicketNumber = highestTicketNumber + 1;

  const prefix = typeof params?.prefix === "string" ? params.prefix : "T";
  const separator = typeof params?.separator === "string" ? params.separator : "-";
  const padding =
    typeof params?.padding === "number" && Number.isFinite(params.padding)
      ? Math.max(0, Math.floor(params.padding))
      : 3;

  const numericPart =
    padding > 0 ? String(nextTicketNumber).padStart(padding, "0") : String(nextTicketNumber);
  const suggestedId = prefix ? `${prefix}${separator}${numericPart}` : numericPart;

  return {
    highest_ticket_number: highestTicketNumber,
    next_ticket_number: nextTicketNumber,
    suggested_id: suggestedId,
  };
}

async function claimTicket(params: any) {
  const filePath = resolveTicketPath(params);
  if (!filePath) {
    return { error: "Ticket not found" };
  }

  const actor = String(params?.actor ?? "").trim();
  if (!actor) {
    return { error: "Missing actor" };
  }

  const record = readTicket(filePath);
  if (!record) {
    return { error: "Failed to read ticket" };
  }
  if (record.parseError) {
    return { error: "Ticket frontmatter parse error", issues: [record.parseError] };
  }

  if (record.frontmatter.status !== "pending") {
    return {
      error: `Ticket must be pending to claim (current status: ${String(record.frontmatter.status ?? "unknown")})`,
    };
  }

  const now = new Date().toISOString();
  const updatedFrontmatter = { ...record.frontmatter };
  updatedFrontmatter.status = "in_progress";
  updatedFrontmatter.claimed_by = actor;
  updatedFrontmatter.claimed_at = now;
  updatedFrontmatter.updated_at = now;
  updatedFrontmatter.work_log = appendWorkLog(updatedFrontmatter.work_log, {
    at: now,
    actor,
    kind: "claim",
    summary:
      typeof params?.summary === "string" && params.summary.trim().length > 0
        ? params.summary.trim()
        : "Claimed ticket for implementation",
    details: params?.details,
  });

  const destination = resolvePathForStatus(filePath, "in_progress");
  if (!destination) {
    return { error: "Unable to resolve destination path" };
  }

  const issues = validateTicket(updatedFrontmatter, record.body, destination);
  if (strictMode && issues.length > 0) {
    return { error: "Validation failed", issues };
  }

  ensureDir(path.dirname(destination));
  writeTicket(destination, updatedFrontmatter, record.body);
  if (destination !== filePath) {
    fs.unlinkSync(filePath);
  }
  regenerateIndex().catch(() => { });

  return { ok: true, path: destination, issues };
}

async function appendTicketWorklog(params: any) {
  const filePath = resolveTicketPath(params);
  if (!filePath) {
    return { error: "Ticket not found" };
  }

  const record = readTicket(filePath);
  if (!record) {
    return { error: "Failed to read ticket" };
  }
  if (record.parseError) {
    return { error: "Ticket frontmatter parse error", issues: [record.parseError] };
  }

  const rawEntry = params?.entry;
  if (!rawEntry || typeof rawEntry !== "object") {
    return { error: "entry must be an object" };
  }

  const entry: WorkLogEntry = {
    ...rawEntry,
    at:
      typeof rawEntry.at === "string" && rawEntry.at.trim().length > 0
        ? rawEntry.at
        : new Date().toISOString(),
  };

  const updatedFrontmatter = { ...record.frontmatter };
  updatedFrontmatter.updated_at = new Date().toISOString();
  updatedFrontmatter.work_log = appendWorkLog(updatedFrontmatter.work_log, entry);

  const issues = validateTicket(updatedFrontmatter, record.body, filePath);
  if (strictMode && issues.length > 0) {
    return { error: "Validation failed", issues };
  }

  writeTicket(filePath, updatedFrontmatter, record.body);
  regenerateIndex().catch(() => { });
  return { ok: true, path: filePath, issues };
}

async function reconcileTickets(params: any) {
  const applyFixes = params?.apply_fixes === true;
  const explicitPath = resolveTicketPath(params);
  const targets = explicitPath ? [explicitPath] : await listTicketFiles();

  const reports = targets.map((targetPath) => reconcileTicketAtPath(targetPath, applyFixes));
  const changed = reports.filter((report) => report.changed).length;
  const unresolved = reports.filter((report) => report.unresolved_issues.length > 0).length;

  if (applyFixes && changed > 0) {
    regenerateIndex().catch(() => { });
  }

  return {
    apply_fixes: applyFixes,
    scanned: reports.length,
    changed,
    unresolved,
    reports,
  };
}

async function createTicket(params: any) {
  const id = String(params?.id ?? "").trim();
  if (!id) return { error: "Missing id" };
  if (findTicketById(id)) return { error: `Ticket id already exists: ${id}` };

  const title = String(params?.title ?? "").trim();
  const area = String(params?.area ?? "").trim();
  const epic = String(params?.epic ?? "").trim() || "none";
  const intent = String(params?.intent ?? "").trim();

  const requirements = normalizeStringList(params?.requirements);
  const humanTesting = normalizeStringList(params?.human_testing_steps);
  const constraints = normalizeStringList(params?.constraints);
  const keyFiles = normalizeStringList(params?.key_files);
  const dependsOn = normalizeStringList(params?.depends_on ?? []);

  if (!title || !area || !intent) {
    return { error: "Missing required fields" };
  }
  if (!requirements.length || !humanTesting.length || !constraints.length) {
    return { error: "requirements, human_testing_steps, constraints must be non-empty" };
  }
  if (!keyFiles.length) {
    return { error: "key_files must be non-empty" };
  }

  const now = new Date().toISOString();
  const createdAt = String(params?.created_at ?? now);
  const status = (params?.status as TicketStatus) ?? "pending";

  const frontmatter: Record<string, any> = {
    id,
    title,
    status,
    created_at: createdAt,
    updated_at: createdAt,
    area,
    epic,
    key_files: keyFiles,
    intent,
    requirements,
    human_testing_steps: humanTesting,
    constraints,
    depends_on: dependsOn,
    claimed_by: null,
    claimed_at: null,
    work_log: [],
    review_notes: null,
  };

  const body =
    typeof params?.body === "string" && params.body.trim().length > 0
      ? params.body
      : defaultBody(title);

  const filename =
    typeof params?.filename === "string" && params.filename.trim().length > 0
      ? params.filename.trim()
      : defaultFilename(createdAt, id, title);

  const targetFolder = STATUS_TO_FOLDER[status];
  if (!targetFolder) return { error: formatInvalidStatus(status) };

  const filePath = path.join(ticketsRoot, targetFolder, filename);
  if (fs.existsSync(filePath)) {
    return { error: `Ticket file already exists: ${filePath}` };
  }

  const issues = validateTicket(frontmatter, body, filePath);
  if (strictMode && issues.length > 0) {
    return { error: "Validation failed", issues };
  }

  ensureDir(path.dirname(filePath));
  writeTicket(filePath, frontmatter, body);
  regenerateIndex().catch(() => { });
  return { ok: true, path: filePath };
}

function increment(target: Record<string, number>, key: string) {
  target[key] = (target[key] ?? 0) + 1;
}

function extractTicketNumber(ticketId: string): number | null {
  const match = ticketId.match(/(\d+)(?!.*\d)/);
  if (!match) return null;

  const value = Number.parseInt(match[1], 10);
  return Number.isNaN(value) ? null : value;
}

function reconcileTicketAtPath(filePath: string, applyFixes: boolean) {
  const record = readTicket(filePath);
  if (!record) {
    return {
      path: filePath,
      changed: false,
      fixes_applied: [] as string[],
      before_issues: ["Failed to read ticket"],
      after_issues: ["Failed to read ticket"],
      unresolved_issues: ["Failed to read ticket"],
    };
  }

  const beforeIssues = validateTicket(record.frontmatter, record.body, filePath);
  if (record.parseError) {
    beforeIssues.push(record.parseError);
  }

  if (!applyFixes || record.parseError) {
    return {
      path: filePath,
      changed: false,
      fixes_applied: [] as string[],
      before_issues: beforeIssues,
      after_issues: beforeIssues,
      unresolved_issues: beforeIssues,
    };
  }

  const fixesApplied: string[] = [];
  const now = new Date().toISOString();
  const frontmatter = { ...record.frontmatter };
  let changed = false;

  const setDefault = (field: string, value: any, note: string) => {
    if (frontmatter[field] === undefined) {
      frontmatter[field] = value;
      fixesApplied.push(note);
      changed = true;
    }
  };

  setDefault("epic", "none", "Set missing epic to 'none'");
  setDefault("key_files", [], "Set missing key_files to []");
  setDefault("requirements", [], "Set missing requirements to []");
  setDefault("human_testing_steps", [], "Set missing human_testing_steps to []");
  setDefault("constraints", [], "Set missing constraints to []");
  setDefault("depends_on", [], "Set missing depends_on to []");
  setDefault("claimed_by", null, "Set missing claimed_by to null");
  setDefault("claimed_at", null, "Set missing claimed_at to null");
  setDefault("work_log", [], "Set missing work_log to []");
  setDefault("review_notes", null, "Set missing review_notes to null");

  if (frontmatter.created_at === undefined || !isValidDate(frontmatter.created_at)) {
    frontmatter.created_at = now;
    fixesApplied.push("Set invalid or missing created_at to current timestamp");
    changed = true;
  }

  if (frontmatter.updated_at === undefined || !isValidDate(frontmatter.updated_at)) {
    frontmatter.updated_at = now;
    fixesApplied.push("Set invalid or missing updated_at to current timestamp");
    changed = true;
  }

  if (
    frontmatter.claimed_at !== undefined &&
    frontmatter.claimed_at !== null &&
    !isValidDate(frontmatter.claimed_at)
  ) {
    frontmatter.claimed_at = null;
    fixesApplied.push("Set invalid claimed_at to null");
    changed = true;
  }

  if (!TicketStatusValues.includes(frontmatter.status)) {
    const inferredStatus = inferStatusFromPath(filePath);
    if (inferredStatus) {
      frontmatter.status = inferredStatus;
      fixesApplied.push(`Set invalid or missing status to ${inferredStatus}`);
      changed = true;
    }
  }

  let destinationPath = filePath;
  if (TicketStatusValues.includes(frontmatter.status)) {
    const resolved = resolvePathForStatus(filePath, frontmatter.status as TicketStatus);
    if (resolved && resolved !== filePath) {
      destinationPath = resolved;
      fixesApplied.push(`Moved ticket to ${getStatusFolder(resolved)} folder`);
      changed = true;
    }
  }

  if (changed) {
    frontmatter.updated_at = now;
    ensureDir(path.dirname(destinationPath));
    writeTicket(destinationPath, frontmatter, record.body);
    if (destinationPath !== filePath && fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
  }

  const afterIssues = validateTicket(frontmatter, record.body, destinationPath);

  return {
    path: destinationPath,
    changed,
    fixes_applied: fixesApplied,
    before_issues: beforeIssues,
    after_issues: afterIssues,
    unresolved_issues: afterIssues,
  };
}

function inferStatusFromPath(filePath: string): TicketStatus | null {
  const folder = getStatusFolder(filePath);
  if (!folder) return null;

  if (folder === "in_progress") {
    return "in_progress";
  }

  const statuses = FOLDER_TO_STATUS[folder];
  if (!statuses || statuses.length === 0) return null;
  return statuses[0];
}

function normalizeFilters(filters: any) {
  return {
    status: normalizeFilter(filters?.status),
    area: normalizeFilter(filters?.area),
    epic: normalizeFilter(filters?.epic ?? filters?.feature),
    text: typeof filters?.text === "string" ? filters.text.toLowerCase() : null,
  };
}

function normalizeFilter(value: any): string[] | null {
  if (!value) return null;
  if (Array.isArray(value)) return value.map(String);
  return [String(value)];
}

function normalizeStringList(value: any): string[] {
  if (!value) return [];
  if (Array.isArray(value)) return value.map(String).filter(Boolean);
  return [String(value)].filter(Boolean);
}

function ticketMatchesFilters(summary: TicketSummary, filters: any): boolean {
  if (filters.status && !filters.status.includes(summary.status)) return false;
  if (filters.area && !filters.area.includes(summary.area)) return false;
  if (filters.epic && !filters.epic.includes(summary.epic)) return false;
  if (filters.text) {
    const haystack = `${summary.id} ${summary.title} ${summary.intent ?? ""}`.toLowerCase();
    if (!haystack.includes(filters.text)) return false;
  }
  return true;
}

function resolveTicketPath(params: any): string | null {
  if (params?.path) {
    const absolute = path.isAbsolute(params.path)
      ? params.path
      : path.join(repoRoot, params.path);
    return fs.existsSync(absolute) ? absolute : null;
  }

  if (params?.id) {
    const candidate = findTicketById(String(params.id));
    return candidate;
  }

  return null;
}

function listTicketFiles(): Promise<string[]> {
  const patterns = [
    "tickets/pending/**/*.md",
    "tickets/in_progress/**/*.md",
    "tickets/awaiting_human_test/**/*.md",
    "tickets/done/**/*.md",
    "tickets/archive/**/*.md",
  ];

  return fg(patterns, { cwd: repoRoot, absolute: true });
}

function readTicketSummary(filePath: string): TicketSummary | null {
  const record = readTicket(filePath);
  if (!record) return null;

  const frontmatter = normalizeFrontmatter(record.frontmatter);
  const issues = validateTicket(frontmatter, record.body, filePath);
  if (record.parseError) {
    issues.push(record.parseError);
  }

  return {
    id: String(frontmatter.id ?? ""),
    title: String(frontmatter.title ?? ""),
    status: frontmatter.status ?? "",
    area: String(frontmatter.area ?? ""),
    epic: String(frontmatter.epic ?? ""),
    path: filePath,
    created_at: frontmatter.created_at,
    updated_at: frontmatter.updated_at,
    intent: frontmatter.intent,
    issues: issues.length > 0 ? issues : undefined,
  };
}

function readTicket(filePath: string): TicketRecord | null {
  if (!fs.existsSync(filePath)) return null;

  const raw = fs.readFileSync(filePath, "utf8");
  const parsed = parseFrontmatter(raw);
  return {
    path: filePath,
    frontmatter: normalizeFrontmatter(parsed.frontmatter),
    body: parsed.body,
    parseError: parsed.error,
  };
}

function parseFrontmatter(raw: string): {
  frontmatter: Record<string, any>;
  body: string;
  error?: string;
} {
  const match = raw.match(/^---\s*\n([\s\S]*?)\n---\s*\n?/);
  if (!match) {
    return { frontmatter: {}, body: raw };
  }

  const yamlContent = match[1];
  let data: Record<string, any> = {};
  let error: string | undefined;
  try {
    data = (YAML.parse(yamlContent) ?? {}) as Record<string, any>;
  } catch (err: any) {
    error = `YAML parse error: ${err.message ?? "unknown"}`;
  }
  const body = raw.slice(match[0].length);
  return { frontmatter: data, body, error };
}

function normalizeFrontmatter(frontmatter: Record<string, any>) {
  const normalized = { ...frontmatter };
  if (!normalized.epic && normalized.feature) {
    normalized.epic = normalized.feature;
  }
  return normalized;
}

function applyFrontmatterPatch(
  frontmatter: Record<string, any>,
  patch: Record<string, any>,
) {
  const merged = { ...frontmatter, ...patch };
  if (merged.feature && !merged.epic) {
    merged.epic = merged.feature;
  }
  return merged;
}

function appendWorkLog(
  workLog: WorkLogEntry[] | unknown,
  entry: WorkLogEntry,
): WorkLogEntry[] {
  const list = Array.isArray(workLog) ? workLog.slice() : [];
  list.push(entry);
  return list;
}

function writeTicket(
  filePath: string,
  frontmatter: Record<string, any>,
  body: string,
) {
  const ordered = orderFrontmatter(frontmatter);
  const yaml = YAML.stringify(ordered).trimEnd();
  const content = `---\n${yaml}\n---\n\n${body.trimStart()}`;
  fs.writeFileSync(filePath, content, "utf8");
}

// ---------------------------------------------------------------------------
// INDEX.md auto-generation
// ---------------------------------------------------------------------------

function formatStatusHeading(status: string): string {
  return status
    .split("_")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

function escapeMarkdownPipe(text: string): string {
  return text.replace(/\|/g, "\\|");
}

async function regenerateIndex(): Promise<void> {
  const files = await listTicketFiles();
  const summaries = files
    .map((f) => readTicketSummary(f))
    .filter((s): s is TicketSummary => s !== null);

  const groups = new Map<string, TicketSummary[]>();
  for (const s of summaries) {
    const key = s.status || "unknown";
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(s);
  }
  for (const list of groups.values()) {
    list.sort((a, b) => (b.updated_at ?? "").localeCompare(a.updated_at ?? ""));
  }

  const ACTIVE = ["in_progress", "blocked", "pending", "awaiting_human_test"];
  const TERMINAL = ["done", "archived"];
  const lines: string[] = [
    "# Ticket Index",
    "",
    "*Auto-generated by ticket-mcp — do not edit by hand.*",
    "",
    `**Total: ${summaries.length}**`,
    "",
  ];

  for (const status of [...ACTIVE, ...TERMINAL]) {
    const tickets = groups.get(status);
    if (!tickets || tickets.length === 0) continue;

    const isTerminal = TERMINAL.includes(status);
    lines.push(`## ${formatStatusHeading(status)} (${tickets.length})`);
    lines.push("");

    if (isTerminal) {
      lines.push("<details>");
      lines.push(`<summary>Show ${tickets.length} ${status} tickets</summary>`);
      lines.push("");
    }

    lines.push("| ID | Title | Area | Epic | Updated |");
    lines.push("|-----|-------|------|------|---------|");
    for (const t of tickets) {
      const updated = t.updated_at ? t.updated_at.slice(0, 10) : "—";
      lines.push(
        `| ${t.id} | ${escapeMarkdownPipe(t.title)} | ${t.area} | ${t.epic || "—"} | ${updated} |`,
      );
    }

    if (isTerminal) {
      lines.push("");
      lines.push("</details>");
    }
    lines.push("");
  }

  const indexPath = path.join(ticketsRoot, "INDEX.md");
  fs.writeFileSync(indexPath, lines.join("\n"), "utf8");
}

function orderFrontmatter(frontmatter: Record<string, any>) {
  const {
    id,
    title,
    status,
    created_at,
    updated_at,
    area,
    epic,
    key_files,
    intent,
    requirements,
    human_testing_steps,
    constraints,
    depends_on,
    claimed_by,
    claimed_at,
    work_log,
    review_notes,
    ...rest
  } = frontmatter;

  return {
    id,
    title,
    status,
    created_at,
    updated_at,
    area,
    epic,
    key_files,
    intent,
    requirements,
    human_testing_steps,
    constraints,
    depends_on,
    claimed_by,
    claimed_at,
    work_log,
    review_notes,
    ...rest,
  };
}

function validateTicket(frontmatter: Record<string, any>, body: string, filePath: string): string[] {
  const issues: string[] = [];

  for (const field of REQUIRED_FIELDS) {
    if (frontmatter[field] === undefined) {
      issues.push(`Missing required field: ${field}`);
    }
  }

  for (const header of REQUIRED_BODY_HEADERS) {
    if (!body.includes(header)) {
      issues.push(`Missing required markdown section: ${header}`);
    }
  }

  if (frontmatter.status && !TicketStatusValues.includes(frontmatter.status)) {
    issues.push(formatInvalidStatus(frontmatter.status));
  }

  if (frontmatter.work_log) {
    const invalid = validateWorkLog(frontmatter.work_log);
    issues.push(...invalid);
  }

  const statusIssue = validateFolderStatus(frontmatter.status, filePath);
  if (statusIssue) {
    issues.push(statusIssue);
  }

  if (frontmatter.created_at && !isValidDate(frontmatter.created_at)) {
    issues.push("Invalid created_at timestamp");
  }

  if (frontmatter.updated_at && !isValidDate(frontmatter.updated_at)) {
    issues.push("Invalid updated_at timestamp");
  }

  if (frontmatter.claimed_at && !isValidDate(frontmatter.claimed_at)) {
    issues.push("Invalid claimed_at timestamp");
  }

  if (frontmatter.key_files && !Array.isArray(frontmatter.key_files)) {
    issues.push("key_files must be a list");
  }

  if (
    frontmatter.epic !== undefined &&
    frontmatter.epic !== null &&
    typeof frontmatter.epic !== "string"
  ) {
    issues.push("epic must be a string when provided");
  }

  if (frontmatter.requirements && !Array.isArray(frontmatter.requirements)) {
    issues.push("requirements must be a list");
  }

  if (
    frontmatter.human_testing_steps &&
    !Array.isArray(frontmatter.human_testing_steps)
  ) {
    issues.push("human_testing_steps must be a list");
  }

  if (frontmatter.constraints && !Array.isArray(frontmatter.constraints)) {
    issues.push("constraints must be a list");
  }

  if (frontmatter.depends_on && !Array.isArray(frontmatter.depends_on)) {
    issues.push("depends_on must be a list");
  }

  if (
    frontmatter.claimed_by !== null &&
    frontmatter.claimed_by !== undefined &&
    typeof frontmatter.claimed_by !== "string"
  ) {
    issues.push("claimed_by must be string or null");
  }

  if (
    frontmatter.review_notes !== null &&
    frontmatter.review_notes !== undefined &&
    typeof frontmatter.review_notes !== "string"
  ) {
    issues.push("review_notes must be string or null");
  }

  return issues;
}

function validateWorkLog(workLog: unknown): string[] {
  if (!Array.isArray(workLog)) {
    return ["work_log must be a list"];
  }

  const issues: string[] = [];
  for (const entry of workLog) {
    if (!entry || typeof entry !== "object") {
      issues.push("work_log entries must be objects");
      continue;
    }
    const record = entry as WorkLogEntry;
    if (!record.at) issues.push("work_log entry missing at");
    if (!record.actor) issues.push("work_log entry missing actor");
    if (!record.kind) issues.push("work_log entry missing kind");
    if (!record.summary) issues.push("work_log entry missing summary");
    if (record.kind && !WorkLogKindValues.includes(record.kind)) {
      issues.push(
        `Invalid work_log kind: ${record.kind}. Allowed: ${WorkLogKindValues.join(", ")}`,
      );
    }
  }
  return issues;
}

function validateFolderStatus(
  status: TicketStatus | string,
  filePath: string,
): string | null {
  if (!status) return null;
  const folder = getStatusFolder(filePath);
  if (!folder) return null;
  const allowed = FOLDER_TO_STATUS[folder];
  if (!allowed) return null;
  if (!allowed.includes(status as TicketStatus)) {
    return `Folder/status mismatch: ${folder} vs ${status}`;
  }
  return null;
}

function getStatusFolder(filePath: string): string | null {
  const candidates = Object.keys(FOLDER_TO_STATUS);
  for (const folder of candidates) {
    const base = path.join(ticketsRoot, folder) + path.sep;
    if (filePath.startsWith(base)) return folder;
  }
  return null;
}

function resolvePathForStatus(filePath: string, status: TicketStatus): string | null {
  const folder = STATUS_TO_FOLDER[status];
  if (!folder) return null;
  const relative = ticketRelativePath(filePath);
  if (!relative) return null;
  return path.join(ticketsRoot, folder, relative);
}

function ticketRelativePath(filePath: string): string | null {
  const folder = getStatusFolder(filePath);
  if (!folder) return null;
  const base = path.join(ticketsRoot, folder);
  const relative = path.relative(base, filePath);
  if (relative.startsWith("..")) return null;
  return relative;
}

function findTicketById(id: string): string | null {
  const files = fg.sync(
    [
      "tickets/pending/**/*.md",
      "tickets/in_progress/**/*.md",
      "tickets/awaiting_human_test/**/*.md",
      "tickets/done/**/*.md",
      "tickets/archive/**/*.md",
    ],
    { cwd: repoRoot, absolute: true },
  );

  for (const filePath of files) {
    const record = readTicket(filePath);
    if (!record) continue;
    if (String(record.frontmatter.id) === id) return filePath;
  }

  return null;
}

function isValidDate(value: string): boolean {
  return !Number.isNaN(Date.parse(value));
}

function defaultFilename(createdAt: string, id: string, title: string): string {
  const date = isValidDate(createdAt)
    ? createdAt.slice(0, 10)
    : new Date().toISOString().slice(0, 10);
  const slug = slugify(title);
  return `${date}__${id}__${slug}.md`;
}

function slugify(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

export const REQUIRED_BODY_HEADERS = [
  "## Overview",
  "## Approach (medium/high-level)",
  "## Tasks / Todos",
  "## Requirements (AI implementation)",
  "## Human Testing Steps",
  "## Key Files / Areas (notes)",
  "## Questions",
  "## Blockers",
  "## Implementation Notes"
];

function defaultBody(title: string): string {
  const headers = REQUIRED_BODY_HEADERS.join("\n\n");
  return `# ${title}\n\n${headers}\n`;
}

function ensureDir(dirPath: string) {
  fs.mkdirSync(dirPath, { recursive: true });
}
