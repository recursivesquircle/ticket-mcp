#!/usr/bin/env node

import * as http from "http";
import * as readline from "readline";
import * as fs from "fs";

const SERVER_HOST = process.env.TICKET_MCP_HOST ?? "127.0.0.1";
const SERVER_PORT = Number(process.env.TICKET_MCP_PORT ?? "3334");
const SERVER_PATH = process.env.TICKET_MCP_PATH ?? "/mcp";

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
  terminal: false,
});

rl.on("line", (line: string) => {
  const trimmed = line.trim();
  if (!trimmed) return;

  try {
    const request = JSON.parse(trimmed);
    const options: http.RequestOptions = {
      hostname: SERVER_HOST,
      port: SERVER_PORT,
      path: SERVER_PATH,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(trimmed),
      },
    };

    const req = http.request(options, (res) => {
      let data = "";

      res.on("data", (chunk) => {
        data += chunk;
      });

      res.on("end", () => {
        if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
          if (request.id !== undefined && request.id !== null) {
            process.stdout.write(data + "\n");
          }
        } else if (request.id !== undefined && request.id !== null) {
          const errMsg = `HTTP Error: ${res.statusCode} - ${data}`;
          sendError(request.id, -32603, errMsg);
        }
      });
    });

    req.on("error", (e) => {
      const errMsg = `Internal proxy error: ${e.message}`;
      sendError(request.id, -32603, errMsg);
      fs.appendFileSync(
        "/tmp/ticket_mcp_proxy.log",
        `[REQ ERR] ${errMsg}\n`,
      );
    });

    req.write(trimmed);
    req.end();
  } catch (err: any) {
    fs.appendFileSync(
      "/tmp/ticket_mcp_proxy.log",
      `[JSON ERR] ${err.message}\n`,
    );
  }
});

function sendError(id: number | string | null, code: number, message: string) {
  const errorResponse = {
    jsonrpc: "2.0",
    id,
    error: {
      code,
      message,
    },
  };
  process.stdout.write(JSON.stringify(errorResponse) + "\n");
}

process.on("SIGINT", () => {
  process.exit(0);
});
