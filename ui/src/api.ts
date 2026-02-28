const MCP_URL =
  import.meta.env.VITE_TICKET_MCP_URL ?? "http://127.0.0.1:3334/mcp";

type RpcResponse = {
  result?: {
    content?: { type: string; text?: string }[];
    data?: any;
  };
  error?: { message: string };
};

let requestId = 1;

async function mcpRpc(method: string, params?: any) {
  const payload = {
    jsonrpc: "2.0",
    id: requestId++,
    method,
    params,
  };

  const response = await fetch(MCP_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  const json = (await response.json()) as RpcResponse;
  if (json.error) {
    throw new Error(json.error.message ?? "MCP error");
  }
  return json.result;
}

async function callTool(name: string, args?: any) {
  const result = await mcpRpc("tools/call", { name, arguments: args ?? {} });
  if (result?.data !== undefined) return result.data;
  const text = result?.content?.[0]?.text;
  if (!text) return null;
  return JSON.parse(text);
}

export async function listTickets(filters: any) {
  return await callTool("tickets.list", filters);
}

export async function getTicket(idOrPath: { id?: string; path?: string }) {
  return await callTool("tickets.get", idOrPath);
}

export async function updateTicket(args: any) {
  return await callTool("tickets.update", args);
}

export async function moveTicket(args: any) {
  return await callTool("tickets.move", args);
}

export async function validateTicket(args: any) {
  return await callTool("tickets.validate", args);
}
