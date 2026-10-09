#!/usr/bin/env node
// Minimal stdio MCP test server for acceptance testing.
// Plain Node ESM, zero dependencies, no network.
// Speaks JSON-RPC 2.0 over stdin/stdout, newline-delimited JSON
// (one message per line, exactly like the MCP stdio transport).

import { createInterface } from "node:readline";

const DEFAULT_PROTOCOL_VERSION = "2025-06-18";

const TOOLS = [
  {
    name: "echo",
    description: "Echo back the given text",
    inputSchema: {
      type: "object",
      properties: { text: { type: "string" } },
      required: ["text"],
    },
  },
  {
    name: "add",
    description: "Add two numbers",
    inputSchema: {
      type: "object",
      properties: { a: { type: "number" }, b: { type: "number" } },
      required: ["a", "b"],
    },
  },
];

// Every outbound message: single-line JSON + trailing newline.
// Writes to pipes are synchronous on POSIX, so this flushes immediately.
function send(message) {
  process.stdout.write(JSON.stringify(message) + "\n");
}

function sendResult(id, result) {
  send({ jsonrpc: "2.0", id, result });
}

function sendError(id, code, message) {
  send({ jsonrpc: "2.0", id, error: { code, message } });
}

function isDateStyleVersion(v) {
  return typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v);
}

function handleRequest(msg) {
  const { id, method, params } = msg;
  switch (method) {
    case "initialize": {
      const requested = params?.protocolVersion;
      sendResult(id, {
        protocolVersion: isDateStyleVersion(requested)
          ? requested
          : DEFAULT_PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: "echo-test", version: "1.0.0" },
      });
      return;
    }
    case "ping":
      sendResult(id, {});
      return;
    case "tools/list":
      sendResult(id, { tools: TOOLS });
      return;
    case "tools/call": {
      const name = params?.name;
      const args = params?.arguments ?? {};
      if (name === "echo") {
        sendResult(id, {
          content: [{ type: "text", text: "echo: " + args.text }],
        });
      } else if (name === "add") {
        sendResult(id, {
          content: [{ type: "text", text: String(args.a + args.b) }],
        });
      } else {
        sendError(id, -32602, `Unknown tool: ${String(name)}`);
      }
      return;
    }
    default:
      sendError(id, -32601, `Method not found: ${String(method)}`);
  }
}

function handleMessage(msg) {
  if (typeof msg !== "object" || msg === null || Array.isArray(msg)) return;
  if (typeof msg.method !== "string") return; // Not a request/notification.
  if (msg.method === "notifications/initialized") return; // Notification: no response.
  if (!("id" in msg)) return; // Other notifications: no response.
  try {
    handleRequest(msg);
  } catch {
    // Never crash on unexpected input.
    sendError(msg.id, -32603, "Internal error");
  }
}

const rl = createInterface({ input: process.stdin });
rl.on("line", (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  let msg;
  try {
    msg = JSON.parse(trimmed);
  } catch {
    return; // Malformed lines are ignored, never crash.
  }
  handleMessage(msg);
});
rl.on("close", () => {
  process.exit(0);
});
