const MODULE_ID = "shadowbridge-mcp";
const DEFAULT_SERVER_URL = "http://127.0.0.1:31777";
const DEFAULT_POLL_MS = 1000;

let runtime = null;

Hooks.once("init", () => {
  registerSettings();
});

Hooks.once("ready", () => {
  if (!game.user?.isGM) return;

  const token = game.settings.get(MODULE_ID, "token");
  if (!token) {
    ui.notifications?.warn("Shadowbridge MCP is enabled, but no token is configured.");
    return;
  }

  runtime = new ShadowbridgeRuntime();
  runtime.start();
});

function registerSettings() {
  game.settings.register(MODULE_ID, "enabled", {
    name: "Enable Shadowbridge MCP",
    hint: "Legacy setting. Shadowbridge now connects whenever the module is active in the world and a token is configured.",
    scope: "world",
    config: false,
    type: Boolean,
    default: true,
  });

  game.settings.register(MODULE_ID, "serverUrl", {
    name: "Shadowbridge Server URL",
    hint: "Local MCP bridge HTTP URL. Usually http://127.0.0.1:31777",
    scope: "world",
    config: true,
    type: String,
    default: DEFAULT_SERVER_URL,
  });

  game.settings.register(MODULE_ID, "token", {
    name: "Shadowbridge Token",
    hint: "Must match the token used by the local Shadowbridge MCP server.",
    scope: "world",
    config: true,
    type: String,
    default: "",
  });

  game.settings.register(MODULE_ID, "pollMs", {
    name: "Reconnect Delay",
    hint: "Delay in milliseconds between failed polls.",
    scope: "world",
    config: true,
    type: Number,
    default: DEFAULT_POLL_MS,
  });
}

class ShadowbridgeRuntime {
  constructor() {
    this.serverUrl = String(game.settings.get(MODULE_ID, "serverUrl") || DEFAULT_SERVER_URL).replace(/\/+$/, "");
    this.token = String(game.settings.get(MODULE_ID, "token") || "");
    this.pollMs = Number(game.settings.get(MODULE_ID, "pollMs") || DEFAULT_POLL_MS);
    this.clientId = `${game.world.id}-${game.user.id}-${randomID(8)}`;
    this.running = false;
  }

  start() {
    this.running = true;
    this.register()
      .then(() => console.info(`[${MODULE_ID}] Connected to ${this.serverUrl}`))
      .catch((error) => this.logError("register", error));
    this.poll();
  }

  stop() {
    this.running = false;
  }

  async register() {
    await this.fetchJson("/bridge/register", {
      method: "POST",
      body: this.clientInfoBody(),
    });
  }

  async poll() {
    while (this.running) {
      try {
        const params = new URLSearchParams(this.clientInfoBody());
        const data = await this.fetchJson(`/bridge/poll?${params.toString()}`);
        if (data?.type === "command" && data.command) {
          await this.handleCommand(data.command);
        }
      } catch (error) {
        this.logError("poll", error);
        await sleep(this.pollMs);
      }
    }
  }

  async handleCommand(command) {
    try {
      const result = await dispatchCommand(command.method, command.args || {});
      await this.postResult(command.id, true, result);
    } catch (error) {
      console.error(`[${MODULE_ID}] Command failed`, command, error);
      await this.postResult(command.id, false, null, error.message || String(error));
    }
  }

  async postResult(commandId, ok, result, error) {
    await this.fetchJson("/bridge/result", {
      method: "POST",
      body: { clientId: this.clientId, commandId, ok, result, error },
    });
  }

  clientInfoBody() {
    return {
      clientId: this.clientId,
      worldId: game.world?.id || "",
      worldTitle: game.world?.title || "",
      systemId: game.system?.id || "",
      systemVersion: game.system?.version || "",
      foundryVersion: game.version || game.release?.version || "",
      userName: game.user?.name || "",
    };
  }

  async fetchJson(path, options = {}) {
    const response = await fetch(`${this.serverUrl}${path}`, {
      method: options.method || "GET",
      headers: {
        "Content-Type": "application/json",
        "x-shadowbridge-token": this.token,
      },
      body: options.body ? JSON.stringify(options.body) : undefined,
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${await response.text()}`);
    }
    return response.status === 204 ? null : response.json();
  }

  logError(context, error) {
    console.warn(`[${MODULE_ID}] ${context}: ${error.message || error}`);
  }
}

async function dispatchCommand(method, args) {
  assertGM();
  switch (method) {
    case "get_world_info":
      return getWorldInfo();
    case "get_actor":
      return getActor(args);
    case "search_actor_items":
      return searchActorItems(args);
    case "manage_actor_items":
      return manageActorItems(args);
    case "manage_actor_effects":
      return manageActorEffects(args);
    case "manage_item_effects":
      return manageItemEffects(args);
    case "manage_actor_flags":
      return manageActorFlags(args);
    case "update_token_image":
      return updateTokenImage(args);
    case "get_current_scene":
      return getCurrentScene(args);
    default:
      throw new Error(`Unknown Shadowbridge command: ${method}`);
  }
}

function assertGM() {
  if (!game.user?.isGM) throw new Error("Shadowbridge commands require an active GM client.");
}

function getWorldInfo() {
  return {
    id: game.world?.id,
    title: game.world?.title,
    system: { id: game.system?.id, version: game.system?.version },
    foundry: { version: game.version || game.release?.version },
    users: game.users?.map((user) => ({
      id: user.id,
      name: user.name,
      active: user.active,
      isGM: user.isGM,
    })),
    modules: Array.from(game.modules?.values() || []).map((module) => ({
      id: module.id,
      title: module.title,
      active: module.active,
      version: module.version,
    })),
  };
}

function getActor(args) {
  const actor = findActor(args.actorIdentifier);
  return serializeActor(actor, args);
}

function searchActorItems(args) {
  const actor = findActor(args.actorIdentifier);
  const query = String(args.query || "").toLowerCase();
  const type = args.type ? String(args.type) : null;
  const limit = Number(args.limit || 20);
  const matches = [];

  for (const item of actor.items || []) {
    if (type && item.type !== type) continue;
    if (args.equipped !== undefined && Boolean(item.system?.equipped) !== Boolean(args.equipped)) continue;
    if (args.attuned !== undefined && !matchesAttunement(item, Boolean(args.attuned))) continue;

    const description = String(item.system?.description?.value || item.system?.description || "");
    const haystack = `${item.name || ""}\n${description}`.toLowerCase();
    if (query && !haystack.includes(query)) continue;

    matches.push(serializeItem(item, { includeSystem: true, includeEffects: true }));
    if (matches.length >= limit) break;
  }

  return {
    actor: compactActor(actor),
    matches,
    totalMatches: matches.length,
  };
}

async function manageActorItems(args) {
  const actor = findActor(args.actorIdentifier);
  switch (args.action) {
    case "list":
      return {
        actor: compactActor(actor),
        items: actor.items
          .filter((item) => {
            if (args.type && item.type !== args.type) return false;
            if (!args.query) return true;
            const needle = String(args.query).toLowerCase();
            const description = String(item.system?.description?.value || item.system?.description || "");
            return `${item.name}\n${description}`.toLowerCase().includes(needle);
          })
          .map((item) => serializeItem(item, { includeSystem: false, includeEffects: true })),
      };
    case "create":
      return createActorItems(actor, args.items || []);
    case "update":
      return updateActorItems(actor, args.updates || []);
    case "delete":
      return deleteActorItems(actor, args);
    default:
      throw new Error(`Unsupported manage_actor_items action: ${args.action}`);
  }
}

async function createActorItems(actor, items) {
  if (!Array.isArray(items) || items.length === 0) throw new Error("items array is required");
  const docs = items.map((item) => {
    if (!item.name || !item.type) throw new Error("Each item requires name and type");
    const doc = {
      name: item.name,
      type: item.type,
      ...(item.img ? { img: item.img } : {}),
      ...(item.system ? { system: item.system } : {}),
      ...(item.flags ? { flags: item.flags } : {}),
      ...(Array.isArray(item.effects) ? { effects: item.effects.map(prepareEffectData) } : {}),
    };
    return doc;
  });
  const created = await actor.createEmbeddedDocuments("Item", docs);
  return {
    actor: compactActor(actor),
    created: created.map((item) => serializeItem(item, { includeEffects: true })),
  };
}

async function updateActorItems(actor, updates) {
  if (!Array.isArray(updates) || updates.length === 0) throw new Error("updates array is required");
  const updated = [];
  for (const update of updates) {
    const item = findItem(actor, update.id || update.name || update.itemIdentifier);
    const patch = {};
    for (const key of ["name", "img", "system", "flags"]) {
      if (update[key] !== undefined) patch[key] = update[key];
    }
    if (Object.keys(patch).length > 0) await item.update(patch);
    const effects = update.effects ? await applyEffectCommands(item, update.effects) : undefined;
    updated.push({ ...serializeItem(item, { includeEffects: true }), ...(effects ? { effectChanges: effects } : {}) });
  }
  return { actor: compactActor(actor), updated };
}

async function deleteActorItems(actor, args) {
  const toDelete = collectItems(actor, args);
  if (toDelete.length === 0) return { actor: compactActor(actor), deleted: [], notFound: args.itemIds || args.itemNames || [] };
  await actor.deleteEmbeddedDocuments("Item", toDelete.map((item) => item.id));
  return {
    actor: compactActor(actor),
    deleted: toDelete.map((item) => ({ id: item.id, name: item.name, type: item.type })),
  };
}

async function manageActorEffects(args) {
  const actor = findActor(args.actorIdentifier);
  return manageEffectsOnDocument(actor, args);
}

async function manageItemEffects(args) {
  const item = args.worldItemIdentifier
    ? findWorldItem(args.worldItemIdentifier)
    : findItem(findActor(args.actorIdentifier), args.itemIdentifier);
  return manageEffectsOnDocument(item, args);
}

async function manageEffectsOnDocument(document, args) {
  switch (args.action) {
    case "list":
      return {
        document: compactDocument(document),
        effects: Array.from(document.effects || []).map(serializeEffect),
      };
    case "create": {
      const created = await document.createEmbeddedDocuments("ActiveEffect", (args.effects || []).map(prepareEffectData));
      return { document: compactDocument(document), created: created.map(serializeEffect) };
    }
    case "update": {
      const updated = [];
      for (const patch of args.updates || []) {
        const effect = findEffect(document, patch.id || patch.name || patch.effectIdentifier);
        const data = prepareEffectData(patch);
        delete data._id;
        await effect.update(data);
        updated.push(serializeEffect(effect));
      }
      return { document: compactDocument(document), updated };
    }
    case "delete": {
      const effects = collectEffects(document, args);
      await document.deleteEmbeddedDocuments("ActiveEffect", effects.map((effect) => effect.id));
      return { document: compactDocument(document), deleted: effects.map(serializeEffect) };
    }
    default:
      throw new Error(`Unsupported effects action: ${args.action}`);
  }
}

async function manageActorFlags(args) {
  const actor = findActor(args.actorIdentifier);
  const document = args.itemIdentifier ? findItem(actor, args.itemIdentifier) : actor;
  const setScopes = args.set ? Object.keys(args.set) : [];
  if (args.set) await document.update({ flags: args.set });
  for (const unset of args.unset || []) {
    await document.unsetFlag(unset.scope, unset.key);
  }
  return {
    document: compactDocument(document),
    setScopes,
    unset: args.unset || [],
    flags: document.flags,
  };
}

async function updateTokenImage(args) {
  const imagePath = args.imagePath;
  const actor = args.actorIdentifier ? findActor(args.actorIdentifier) : null;
  const updated = { actor: null, prototypeToken: false, sceneTokens: [] };

  if (actor && args.updateActorPortrait) {
    await actor.update({ img: imagePath });
    updated.actor = compactActor(actor);
  }

  if (actor && args.updatePrototypeToken !== false) {
    await actor.update({ "prototypeToken.texture.src": imagePath });
    updated.prototypeToken = true;
  }

  if (args.tokenId) {
    const token = getActiveSceneToken(args.tokenId);
    await token.update({ "texture.src": imagePath });
    updated.sceneTokens.push(compactToken(token));
  }

  if (actor && args.updateActiveSceneTokens !== false) {
    for (const token of getMatchingTokens(game.scenes?.active, actor)) {
      await token.update({ "texture.src": imagePath });
      updated.sceneTokens.push(compactToken(token));
    }
  }

  if (actor && args.updateAllSceneTokens) {
    for (const scene of game.scenes || []) {
      if (scene.id === game.scenes?.active?.id) continue;
      for (const token of getMatchingTokens(scene, actor)) {
        await token.update({ "texture.src": imagePath });
        updated.sceneTokens.push(compactToken(token));
      }
    }
  }

  return updated;
}

function getCurrentScene(args) {
  const scene = game.scenes?.active;
  if (!scene) return { scene: null };
  return {
    id: scene.id,
    name: scene.name,
    active: scene.active,
    width: scene.width,
    height: scene.height,
    grid: scene.grid,
    tokens: args.includeTokens === false
      ? undefined
      : scene.tokens
        .filter((token) => args.includeHidden || !token.hidden)
        .map(compactToken),
  };
}

function findActor(identifier) {
  if (!identifier) throw new Error("actorIdentifier is required");
  const normalized = String(identifier).toLowerCase();
  const actor = game.actors?.get(identifier) || game.actors?.find((entry) => entry.name?.toLowerCase() === normalized);
  if (!actor) throw new Error(`Actor not found: ${identifier}`);
  return actor;
}

function findWorldItem(identifier) {
  if (!identifier) throw new Error("worldItemIdentifier is required");
  const normalized = String(identifier).toLowerCase();
  const item = game.items?.get(identifier) || game.items?.find((entry) => entry.name?.toLowerCase() === normalized);
  if (!item) throw new Error(`World item not found: ${identifier}`);
  return item;
}

function findItem(actor, identifier) {
  if (!identifier) throw new Error("itemIdentifier is required");
  const normalized = String(identifier).toLowerCase();
  const item = actor.items?.get(identifier) || actor.items?.find((entry) => entry.name?.toLowerCase() === normalized);
  if (!item) throw new Error(`Item not found on ${actor.name}: ${identifier}`);
  return item;
}

function findEffect(document, identifier) {
  if (!identifier) throw new Error("effect id or name is required");
  const normalized = String(identifier).toLowerCase();
  const effect = document.effects?.get(identifier) || document.effects?.find((entry) => {
    return entry.name?.toLowerCase() === normalized || entry.label?.toLowerCase() === normalized;
  });
  if (!effect) throw new Error(`Effect not found on ${document.name}: ${identifier}`);
  return effect;
}

function collectItems(actor, args) {
  const found = new Map();
  for (const id of args.itemIds || []) {
    const item = actor.items?.get(id);
    if (item) found.set(item.id, item);
  }
  for (const name of args.itemNames || []) {
    const normalized = String(name).toLowerCase();
    const item = actor.items?.find((entry) => {
      return entry.name?.toLowerCase() === normalized && (!args.type || entry.type === args.type);
    });
    if (item) found.set(item.id, item);
  }
  return Array.from(found.values());
}

function collectEffects(document, args) {
  const found = new Map();
  for (const id of args.effectIds || []) {
    const effect = document.effects?.get(id);
    if (effect) found.set(effect.id, effect);
  }
  for (const name of args.effectNames || []) {
    const normalized = String(name).toLowerCase();
    const effect = document.effects?.find((entry) => entry.name?.toLowerCase() === normalized || entry.label?.toLowerCase() === normalized);
    if (effect) found.set(effect.id, effect);
  }
  return Array.from(found.values());
}

async function applyEffectCommands(document, commands) {
  const result = {};
  if (Array.isArray(commands.create) && commands.create.length > 0) {
    const created = await document.createEmbeddedDocuments("ActiveEffect", commands.create.map(prepareEffectData));
    result.created = created.map(serializeEffect);
  }
  if (Array.isArray(commands.update) && commands.update.length > 0) {
    result.updated = [];
    for (const patch of commands.update) {
      const effect = findEffect(document, patch.id || patch.name);
      const data = prepareEffectData(patch);
      delete data._id;
      await effect.update(data);
      result.updated.push(serializeEffect(effect));
    }
  }
  if (Array.isArray(commands.delete) && commands.delete.length > 0) {
    const effects = commands.delete.map((entry) => {
      const identifier = typeof entry === "string" ? entry : entry.id || entry.name;
      return findEffect(document, identifier);
    });
    await document.deleteEmbeddedDocuments("ActiveEffect", effects.map((effect) => effect.id));
    result.deleted = effects.map(serializeEffect);
  }
  return result;
}

function prepareEffectData(effect) {
  const data = {};
  for (const key of ["name", "label", "icon", "img", "type", "description", "disabled", "transfer", "origin", "duration", "changes", "flags", "statuses"]) {
    if (effect?.[key] !== undefined) data[key] = effect[key];
  }
  if (effect?.id !== undefined) data._id = effect.id;
  if (effect?._id !== undefined) data._id = effect._id;
  return data;
}

function matchesAttunement(item, wanted) {
  const value = item.system?.attunement;
  if (typeof value === "number") return wanted ? value === 2 : value !== 2;
  if (typeof value === "string") return wanted ? value.toLowerCase().includes("attuned") : !value.toLowerCase().includes("attuned");
  return !wanted;
}

function serializeActor(actor, options = {}) {
  return {
    ...compactActor(actor),
    img: actor.img,
    system: options.includeSystem ? actor.system : undefined,
    items: options.includeItems === false ? undefined : actor.items?.map((item) => serializeItem(item, { includeEffects: true })),
    effects: options.includeEffects === false ? undefined : actor.effects?.map(serializeEffect),
  };
}

function serializeItem(item, options = {}) {
  return {
    id: item.id,
    name: item.name,
    type: item.type,
    img: item.img,
    quantity: item.system?.quantity,
    equipped: item.system?.equipped,
    attunement: item.system?.attunement,
    system: options.includeSystem ? item.system : undefined,
    flags: item.flags,
    effects: options.includeEffects ? item.effects?.map(serializeEffect) : undefined,
  };
}

function serializeEffect(effect) {
  return {
    id: effect.id,
    name: effect.name || effect.label || "Unknown Effect",
    icon: effect.icon,
    disabled: effect.disabled,
    transfer: effect.transfer,
    origin: effect.origin,
    duration: effect.duration,
    changes: effect.changes,
    flags: effect.flags,
    statuses: Array.from(effect.statuses || []),
  };
}

function compactActor(actor) {
  return { id: actor.id, name: actor.name, type: actor.type, img: actor.img };
}

function compactDocument(document) {
  return { id: document.id, name: document.name, type: document.documentName || document.type };
}

function compactToken(token) {
  return {
    id: token.id,
    name: token.name,
    sceneId: token.parent?.id,
    actorId: token.actor?.id || token.actorId,
    x: token.x,
    y: token.y,
    width: token.width,
    height: token.height,
    hidden: token.hidden,
    img: token.texture?.src,
  };
}

function getActiveSceneToken(tokenId) {
  const scene = game.scenes?.active;
  if (!scene) throw new Error("No active scene");
  const token = scene.tokens?.get(tokenId);
  if (!token) throw new Error(`Token not found on active scene: ${tokenId}`);
  return token;
}

function getMatchingTokens(scene, actor) {
  if (!scene) return [];
  return scene.tokens?.filter((token) => token.actor?.id === actor.id || token.actorId === actor.id) || [];
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
