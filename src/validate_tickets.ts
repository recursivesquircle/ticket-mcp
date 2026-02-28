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

async function main() {
  const { startServer } = await import("./server");
  const { server, url } = await startServer({
    host: "127.0.0.1",
    port: 0,
    strict: true,
  });

  try {
    const result = await callTool(url, "tickets.validate", {});
    const issues = Array.isArray(result?.issues) ? result.issues : [];
    if (issues.length === 0) {
      console.log("All tickets valid.");
      return;
    }

    console.error("Ticket validation issues:");
    for (const entry of issues) {
      if (!entry) continue;
      const path = entry.path ? String(entry.path) : "<unknown>";
      console.error(`- ${path}`);
      const entryIssues = Array.isArray(entry.issues) ? entry.issues : [];
      for (const issue of entryIssues) {
        console.error(`  - ${issue}`);
      }
    }
    process.exitCode = 1;
  } finally {
    server.close();
  }
}

main().catch((err) => {
  console.error(err?.message ?? err);
  process.exit(1);
});
