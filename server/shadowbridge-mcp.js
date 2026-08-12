#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, "..");
const TOKEN_FILE = path.join(ROOT_DIR, "shadowbridge-token.txt");
const HOST = process.env.SHADOWBRIDGE_HOST || "127.0.0.1";
const PORT = Number(process.env.SHADOWBRIDGE_PORT || 31777);
const TOKEN = loadToken();
const SERVER_INFO = { name: "shadowbridge-mcp", version: "0.1.0" };
const REQUEST_TIMEOUT_MS = Number(process.env.SHADOWBRIDGE_REQUEST_TIMEOUT_MS || 60000);
const POLL_TIMEOUT_MS = Number(process.env.SHADOWBRIDGE_POLL_TIMEOUT_MS || 25000);
const CLIENT_TTL_MS = Number(process.env.SHADOWBRIDGE_CLIENT_TTL_MS || 60000);

const clients = new Map();
const queues = new Map();
const waiters = new Map();
const pendingResults = new Map();

const tools = [
  {
    name: "list_connected_worlds",
    description: "List currently connected Shadowbridge Foundry browser sessions.",
    inputSchema: { type: "object", properties: {} },
    local: true,
  },
  {
    name: "get_world_info",
    description: "Get Foundry world, system, module, and connection information.",
    inputSchema: optionalWorldSchema(),
  },
  {
    name: "get_actor",
    description: "Get compact actor data with optional items, effects, and system data.",
    inputSchema: {
      type: "object",
      properties: {
        worldId: stringProp("Optional target Foundry world id."),
        actorIdentifier: stringProp("Actor name or id."),
        includeSystem: boolProp("Include actor system data.", false),
        includeItems: boolProp("Include actor items.", true),
        includeEffects: boolProp("Include actor active effects.", true),
      },
      required: ["actorIdentifier"],
    },
  },
  {
    name: "search_actor_items",
    description: "Search an actor's items by name, description, type, equipped, or attunement state.",
    inputSchema: {
      type: "object",
      properties: {
        worldId: stringProp("Optional target Foundry world id."),
        actorIdentifier: stringProp("Actor name or id."),
        query: stringProp("Case-insensitive name or description search text."),
        type: stringProp("Optional item type filter."),
        equipped: boolProp("Optional equipped filter."),
        attuned: boolProp("Optional attunement filter."),
        limit: numberProp("Maximum results.", 20),
      },
      required: ["actorIdentifier"],
    },
  },
  {
    name: "manage_actor_items",
    description: "List, create, update, or delete embedded Items on an Actor.",
    inputSchema: {
      type: "object",
      properties: {
        worldId: stringProp("Optional target Foundry world id."),
        action: enumProp(["list", "create", "update", "delete"]),
        actorIdentifier: stringProp("Actor name or id."),
        type: stringProp("Optional item type filter for list/delete-by-name."),
        query: stringProp("Optional name/description filter for list."),
        items: {
          type: "array",
          description: "Items to create. Supports name, type, img, system, flags, effects.",
          items: { type: "object", additionalProperties: true },
        },
        updates: {
          type: "array",
          description: "Item updates. Each needs id or name. Supports name, img, system, flags, effects.",
          items: { type: "object", additionalProperties: true },
        },
        itemIds: { type: "array", items: { type: "string" } },
        itemNames: { type: "array", items: { type: "string" } },
      },
      required: ["action", "actorIdentifier"],
    },
  },
  {
    name: "manage_actor_effects",
    description: "List, create, update, or delete Active Effects embedded directly on an Actor.",
    inputSchema: effectToolSchema("Actor name or id."),
  },
  {
    name: "manage_item_effects",
    description: "List, create, update, or delete Active Effects embedded on an actor item or world item.",
    inputSchema: {
      type: "object",
      properties: {
        worldId: stringProp("Optional target Foundry world id."),
        action: enumProp(["list", "create", "update", "delete"]),
        actorIdentifier: stringProp("Actor name or id for embedded actor items."),
        itemIdentifier: stringProp("Actor item name or id."),
        worldItemIdentifier: stringProp("World item name or id. Use instead of actorIdentifier/itemIdentifier."),
        effects: effectsProp(),
        updates: effectUpdatesProp(),
        effectIds: { type: "array", items: { type: "string" } },
        effectNames: { type: "array", items: { type: "string" } },
      },
      required: ["action"],
    },
  },
  {
    name: "manage_actor_flags",
    description: "Set or unset flags on an actor or one of its items.",
    inputSchema: {
      type: "object",
      properties: {
        worldId: stringProp("Optional target Foundry world id."),
        actorIdentifier: stringProp("Actor name or id."),
        itemIdentifier: stringProp("Optional actor item name or id. Omit to update actor flags."),
        set: { type: "object", additionalProperties: true, description: "Nested flags object to merge." },
        unset: {
          type: "array",
          description: "Flags to unset as {scope,key} objects.",
          items: {
            type: "object",
            properties: { scope: { type: "string" }, key: { type: "string" } },
            required: ["scope", "key"],
          },
        },
      },
      required: ["actorIdentifier"],
    },
  },
  {
    name: "update_token_image",
    description: "Update actor portrait, prototype token image, and/or placed scene token image.",
    inputSchema: {
      type: "object",
      properties: {
        worldId: stringProp("Optional target Foundry world id."),
        actorIdentifier: stringProp("Actor name or id."),
        tokenId: stringProp("Scene token id on the active scene."),
        imagePath: stringProp("Foundry-accessible image path or URL."),
        updateActorPortrait: boolProp("Update actor portrait image.", false),
        updatePrototypeToken: boolProp("Update actor prototype token texture.", true),
        updateActiveSceneTokens: boolProp("Update matching tokens on active scene.", true),
        updateAllSceneTokens: boolProp("Update matching tokens on all scenes.", false),
      },
      required: ["imagePath"],
    },
  },
  {
    name: "get_current_scene",
    description: "Get the current scene with optional token details.",
    inputSchema: {
      type: "object",
      properties: {
        worldId: stringProp("Optional target Foundry world id."),
        includeTokens: boolProp("Include scene tokens.", true),
        includeHidden: boolProp("Include hidden tokens.", false),
      },
    },
  },
];

startHttpBridge();
startMcpStdio();

function loadToken() {
  if (process.env.SHADOWBRIDGE_TOKEN) return process.env.SHADOWBRIDGE_TOKEN;
  if (fs.existsSync(TOKEN_FILE)) return fs.readFileSync(TOKEN_FILE, "utf8").trim();
  const token = crypto.randomBytes(32).toString("hex");
  fs.mkdirSync(path.dirname(TOKEN_FILE), { recursive: true });
  fs.writeFileSync(TOKEN_FILE, token + "\n", { encoding: "utf8" });
  process.stderr.write(`[shadowbridge] Generated token file: ${TOKEN_FILE}\n`);
  return token;
}

function startHttpBridge() {
  const server = http.createServer(async (req, res) => {
    try {
      setCors(req, res);
      if (req.method === "OPTIONS") return endJson(res, 204, null);
      const url = new URL(req.url || "/", `http://${req.headers.host || `${HOST}:${PORT}`}`);

      if (url.pathname === "/health") {
        return endJson(res, 200, {
          ok: true,
          server: SERVER_INFO,
          clients: getActiveClients().length,
        });
      }

      if (!isAuthorized(req, url)) return endJson(res, 401, { ok: false, error: "Unauthorized" });

      if (req.method === "GET" && url.pathname === "/bridge/poll") return handlePoll(req, res, url);
      if (req.method === "POST" && url.pathname === "/bridge/result") return handleResult(req, res);
      if (req.method === "POST" && url.pathname === "/bridge/register") return handleRegister(req, res);

      return endJson(res, 404, { ok: false, error: "Not found" });
    } catch (error) {
      process.stderr.write(`[shadowbridge] HTTP error: ${error.stack || error.message}\n`);
      return endJson(res, 500, { ok: false, error: error.message || "Unknown error" });
    }
  });

  server.listen(PORT, HOST, () => {
    process.stderr.write(`[shadowbridge] HTTP bridge listening on http://${HOST}:${PORT}\n`);
  });
}

function setCors(req, res) {
  const origin = req.headers.origin || "*";
  res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "content-type,x-shadowbridge-token");
  res.setHeader("Access-Control-Allow-Private-Network", "true");
  res.setHeader("Access-Control-Max-Age", "86400");
}

function isAuthorized(req, url) {
  const header = req.headers["x-shadowbridge-token"];
  const queryToken = url.searchParams.get("token");
  return header === TOKEN || queryToken === TOKEN;
}

async function handleRegister(req, res) {
  const body = await readJson(req);
  const client = registerClient(body);
  return endJson(res, 200, { ok: true, client });
}

function handlePoll(_req, res, url) {
  const client = registerClient(Object.fromEntries(url.searchParams.entries()));
  const queue = getQueue(client.clientId);
  if (queue.length > 0) {
    return endJson(res, 200, { type: "command", command: queue.shift() });
  }

  const timeout = setTimeout(() => {
    waiters.delete(client.clientId);
    endJson(res, 200, { type: "noop" });
  }, POLL_TIMEOUT_MS);

  waiters.set(client.clientId, { res, timeout });
}

async function handleResult(req, res) {
  const body = await readJson(req);
  const pending = pendingResults.get(body.commandId);
  if (!pending) return endJson(res, 404, { ok: false, error: "Unknown or expired command id" });

  clearTimeout(pending.timeout);
  pendingResults.delete(body.commandId);

  if (body.ok) pending.resolve(body.result);
  else pending.reject(new Error(body.error || "Foundry command failed"));

  return endJson(res, 200, { ok: true });
}

function registerClient(raw) {
  const clientId = String(raw.clientId || crypto.randomUUID());
  const client = {
    clientId,
    worldId: raw.worldId || "",
    worldTitle: raw.worldTitle || "",
    systemId: raw.systemId || "",
    systemVersion: raw.systemVersion || "",
    foundryVersion: raw.foundryVersion || "",
    userName: raw.userName || "",
    lastSeen: Date.now(),
  };
  clients.set(clientId, client);
  if (!queues.has(clientId)) queues.set(clientId, []);
  return client;
}

async function readJson(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw) return {};
  return JSON.parse(raw);
}

function endJson(res, status, data) {
  res.statusCode = status;
  if (data === null) return res.end();
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(data));
}

function getQueue(clientId) {
  if (!queues.has(clientId)) queues.set(clientId, []);
  return queues.get(clientId);
}

function getActiveClients() {
  const now = Date.now();
  for (const [id, client] of clients) {
    if (now - client.lastSeen > CLIENT_TTL_MS) clients.delete(id);
  }
  return Array.from(clients.values()).sort((a, b) => b.lastSeen - a.lastSeen);
}

function chooseClient(worldId) {
  const active = getActiveClients();
  if (worldId) {
    const match = active.find((client) => client.worldId === worldId || client.worldTitle === worldId);
    if (match) return match;
  }
  return active[0] || null;
}

function dispatchToFoundry(method, args = {}) {
  const client = chooseClient(args.worldId);
  if (!client) throw new Error("No connected Shadowbridge Foundry browser session.");

  const commandId = crypto.randomUUID();
  const command = { id: commandId, method, args };
  const queue = getQueue(client.clientId);
  queue.push(command);
  flushWaiter(client.clientId);

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      pendingResults.delete(commandId);
      reject(new Error(`Timed out waiting for Foundry response to ${method}`));
    }, REQUEST_TIMEOUT_MS);
    pendingResults.set(commandId, { resolve, reject, timeout });
  });
}

function flushWaiter(clientId) {
  const waiter = waiters.get(clientId);
  if (!waiter) return;
  const queue = getQueue(clientId);
  if (queue.length === 0) return;
  clearTimeout(waiter.timeout);
  waiters.delete(clientId);
  endJson(waiter.res, 200, { type: "command", command: queue.shift() });
}

function startMcpStdio() {
  let buffer = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => {
    buffer += chunk;
    let index;
    while ((index = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (line) handleMcpLine(line);
    }
  });
}

async function handleMcpLine(line) {
  let message;
  try {
    message = JSON.parse(line);
  } catch (error) {
    return writeMcp({ jsonrpc: "2.0", id: 0, error: { code: -32700, message: error.message } });
  }

  if (Array.isArray(message)) {
    for (const entry of message) await handleMcpMessage(entry);
    return;
  }

  await handleMcpMessage(message);
}

async function handleMcpMessage(message) {
  if (!message || typeof message !== "object") return;
  if (!("id" in message)) return;

  try {
    const result = await routeMcpRequest(message.method, message.params || {});
    writeMcp({ jsonrpc: "2.0", id: message.id, result });
  } catch (error) {
    writeMcp({
      jsonrpc: "2.0",
      id: message.id,
      error: { code: -32000, message: error.message || "Unknown error" },
    });
  }
}

async function routeMcpRequest(method, params) {
  if (method === "initialize") {
    return {
      protocolVersion: params.protocolVersion || "2025-06-18",
      capabilities: { tools: {} },
      serverInfo: SERVER_INFO,
    };
  }

  if (method === "ping") return {};

  if (method === "tools/list") {
    return {
      tools: tools.map(({ local, ...tool }) => tool),
    };
  }

  if (method === "tools/call") {
    const toolName = params.name;
    const tool = tools.find((entry) => entry.name === toolName);
    if (!tool) throw new Error(`Unknown tool: ${toolName}`);
    const result = tool.local
      ? handleLocalTool(toolName, params.arguments || {})
      : await dispatchToFoundry(toolName, params.arguments || {});

    return {
      content: [{ type: "text", text: JSON.stringify(result) }],
      structuredContent: result,
    };
  }

  if (method === "resources/list") return { resources: [] };
  if (method === "prompts/list") return { prompts: [] };

  throw new Error(`Unsupported MCP method: ${method}`);
}

function handleLocalTool(name) {
  if (name === "list_connected_worlds") {
    return { clients: getActiveClients() };
  }
  throw new Error(`Unknown local tool: ${name}`);
}

function writeMcp(message) {
  process.stdout.write(JSON.stringify(message) + "\n");
}

function optionalWorldSchema() {
  return { type: "object", properties: { worldId: stringProp("Optional target Foundry world id.") } };
}

function effectToolSchema(actorDescription) {
  return {
    type: "object",
    properties: {
      worldId: stringProp("Optional target Foundry world id."),
      action: enumProp(["list", "create", "update", "delete"]),
      actorIdentifier: stringProp(actorDescription),
      effects: effectsProp(),
      updates: effectUpdatesProp(),
      effectIds: { type: "array", items: { type: "string" } },
      effectNames: { type: "array", items: { type: "string" } },
    },
    required: ["action", "actorIdentifier"],
  };
}

function effectsProp() {
  return {
    type: "array",
    description: "Active Effect data objects. Supports name, icon, disabled, transfer, changes, duration, flags, statuses.",
    items: { type: "object", additionalProperties: true },
  };
}

function effectUpdatesProp() {
  return {
    type: "array",
    description: "Active Effect patches. Each needs id or name.",
    items: { type: "object", additionalProperties: true },
  };
}

function enumProp(values) {
  return { type: "string", enum: values };
}

function stringProp(description) {
  return { type: "string", description };
}

function boolProp(description, defaultValue) {
  return { type: "boolean", description, default: defaultValue };
}

function numberProp(description, defaultValue) {
  return { type: "number", description, default: defaultValue };
}
