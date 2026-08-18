const MODULE_ID = "shadowbridge-mcp";
const DEFAULT_SERVER_URL = "http://127.0.0.1:31777";
const DEFAULT_POLL_MS = 1000;

let runtime = null;
let startupError = null;

window.ShadowbridgeMCP = {
  status,
  restart,
};

Hooks.once("init", () => {
  registerSettings();
});

Hooks.once("ready", () => {
  restart();
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
    this.clientId = `${game.world.id}-${game.user.id}-${makeRandomId(8)}`;
    this.running = false;
    this.lastConnect = null;
    this.lastError = null;
  }

  start() {
    this.running = true;
    this.register()
      .then(() => {
        this.lastConnect = new Date().toISOString();
        this.lastError = null;
        console.info(`[${MODULE_ID}] Connected to ${this.serverUrl}`);
      })
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
    this.lastError = {
      context,
      message: error.message || String(error),
      at: new Date().toISOString(),
    };
    console.warn(`[${MODULE_ID}] ${context}: ${error.message || error}`);
  }
}

function restart() {
  startupError = null;
  try {
    if (!game.user?.isGM) {
      console.info(`[${MODULE_ID}] Not starting because this user is not a GM.`);
      return status();
    }

    const token = game.settings.get(MODULE_ID, "token");
    if (!token) {
      ui.notifications?.warn("Shadowbridge MCP is enabled, but no token is configured.");
      return status();
    }

    runtime?.stop();
    runtime = new ShadowbridgeRuntime();
    runtime.start();
    return status();
  } catch (error) {
    startupError = {
      message: error.message || String(error),
      stack: error.stack || "",
      at: new Date().toISOString(),
    };
    console.error(`[${MODULE_ID}] startup failed`, error);
    return status();
  }
}

function status() {
  const token = game.settings.get(MODULE_ID, "token") || "";
  const module = game.modules.get(MODULE_ID);
  return {
    user: game.user?.name,
    isGM: game.user?.isGM,
    moduleActive: module?.active,
    moduleVersion: module?.version,
    serverUrl: game.settings.get(MODULE_ID, "serverUrl"),
    tokenLength: token.length,
    tokenUniqueChars: token ? new Set(token).size : 0,
    runtimeStarted: Boolean(runtime?.running),
    clientId: runtime?.clientId || null,
    lastConnect: runtime?.lastConnect || null,
    lastError: runtime?.lastError || null,
    startupError,
  };
}

function makeRandomId(length) {
  if (globalThis.foundry?.utils?.randomID) return globalThis.foundry.utils.randomID(length);
  if (globalThis.randomID) return globalThis.randomID(length);
  const alphabet = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  const values = new Uint8Array(length);
  if (globalThis.crypto?.getRandomValues) {
    globalThis.crypto.getRandomValues(values);
    return Array.from(values, (value) => alphabet[value % alphabet.length]).join("");
  }
  return Array.from({ length }, () => alphabet[Math.floor(Math.random() * alphabet.length)]).join("");
}

async function dispatchCommand(method, args) {
  assertGM();
  switch (method) {
    case "get_world_info":
      return getWorldInfo();
    case "get_actor":
      return getActor(args);
    case "manage_actors":
      return manageActors(args);
    case "manage_journals":
      return manageJournals(args);
    case "manage_scenes":
      return manageScenes(args);
    case "upload_assets":
      return uploadAssets(args);
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

async function manageActors(args = {}) {
  switch (args.action) {
    case "list":
      return listActors(args);
    case "create":
      return createActors(args);
    case "update":
      return updateActors(args);
    default:
      throw new Error(`Unsupported manage_actors action: ${args.action}`);
  }
}

async function manageJournals(args = {}) {
  switch (args.action) {
    case "list":
      return listJournals(args);
    case "create":
      return createJournals(args);
    case "update":
      return updateJournals(args);
    case "delete":
      return deleteJournals(args);
    default:
      throw new Error(`Unsupported manage_journals action: ${args.action}`);
  }
}

function listJournals(args = {}) {
  const query = String(args.query || "").toLowerCase();
  const folderName = args.folder ? String(args.folder).toLowerCase() : null;
  const limit = Number.isFinite(args.limit) ? Number(args.limit) : 50;

  const matches = game.journal
    .filter((journal) => {
      if (folderName && journal.folder?.name?.toLowerCase() !== folderName) return false;
      if (!query) return true;
      const pageText = args.searchPages
        ? Array.from(journal.pages || []).map((page) => journalPageText(page)).join("\n").toLowerCase()
        : "";
      return journal.name?.toLowerCase().includes(query) || pageText.includes(query);
    })
    .slice(0, limit)
    .map((journal) => serializeJournal(journal, { includePages: args.includePages === true }));

  return { journals: matches, totalMatches: matches.length };
}

async function createJournals(args = {}) {
  const journals = args.journals || [];
  if (!Array.isArray(journals) || journals.length === 0) throw new Error("journals array is required");

  const folder = await resolveJournalFolder(args.folder);
  const docs = journals.map((journal) => prepareJournalData(journal, folder));
  const created = await JournalEntry.createDocuments(docs);

  return {
    created: created.map((journal) => serializeJournal(journal, { includePages: true })),
  };
}

async function updateJournals(args = {}) {
  const updates = args.updates || [];
  if (!Array.isArray(updates) || updates.length === 0) throw new Error("updates array is required");

  const updated = [];
  for (const update of updates) {
    const journal = findJournal(update.id || update.name || update.journalIdentifier);
    const patch = {};
    for (const key of ["name", "img", "flags", "ownership"]) {
      if (update[key] !== undefined) patch[key] = update[key];
    }
    if (update.folder !== undefined) {
      const folder = await resolveJournalFolder(update.folder);
      patch.folder = folder?.id || null;
    }
    if (Object.keys(patch).length > 0) await journal.update(patch);

    if (Array.isArray(update.deletePageIds) && update.deletePageIds.length > 0) {
      await journal.deleteEmbeddedDocuments("JournalEntryPage", update.deletePageIds);
    }
    if (Array.isArray(update.deletePageNames) && update.deletePageNames.length > 0) {
      const ids = update.deletePageNames.map((name) => findJournalPage(journal, name).id);
      await journal.deleteEmbeddedDocuments("JournalEntryPage", ids);
    }
    if (Array.isArray(update.replacePages)) {
      const pageIds = Array.from(journal.pages || []).map((page) => page.id);
      if (pageIds.length > 0) await journal.deleteEmbeddedDocuments("JournalEntryPage", pageIds);
      if (update.replacePages.length > 0) {
        await journal.createEmbeddedDocuments("JournalEntryPage", update.replacePages.map(prepareJournalPageData));
      }
    }
    if (Array.isArray(update.pages) && update.pages.length > 0) {
      const pageCreates = [];
      const pageUpdates = [];
      for (const page of update.pages) {
        if (page.id || page.pageIdentifier) {
          pageUpdates.push({ ...prepareJournalPageData(page), _id: findJournalPage(journal, page.id || page.pageIdentifier).id });
        } else if (page.name && Array.from(journal.pages || []).some((entry) => entry.name === page.name)) {
          pageUpdates.push({ ...prepareJournalPageData(page), _id: findJournalPage(journal, page.name).id });
        } else {
          pageCreates.push(prepareJournalPageData(page));
        }
      }
      if (pageUpdates.length > 0) await journal.updateEmbeddedDocuments("JournalEntryPage", pageUpdates);
      if (pageCreates.length > 0) await journal.createEmbeddedDocuments("JournalEntryPage", pageCreates);
    }

    updated.push(serializeJournal(journal, { includePages: true }));
  }

  return { updated };
}

async function deleteJournals(args = {}) {
  const ids = args.ids || [];
  if (!Array.isArray(ids) || ids.length === 0) throw new Error("ids array is required");
  const docs = ids.map((id) => findJournal(id));
  await JournalEntry.deleteDocuments(docs.map((doc) => doc.id));
  return { deleted: docs.map((doc) => ({ id: doc.id, name: doc.name })) };
}

async function manageScenes(args = {}) {
  switch (args.action) {
    case "list":
      return listScenes(args);
    case "create":
      return createScenes(args);
    case "update":
      return updateScenes(args);
    case "delete":
      return deleteScenes(args);
    default:
      throw new Error(`Unsupported manage_scenes action: ${args.action}`);
  }
}

function listScenes(args = {}) {
  const query = String(args.query || "").toLowerCase();
  const folderName = args.folder ? String(args.folder).toLowerCase() : null;
  const limit = Number.isFinite(args.limit) ? Number(args.limit) : 50;

  const matches = game.scenes
    .filter((scene) => {
      if (folderName && scene.folder?.name?.toLowerCase() !== folderName) return false;
      if (!query) return true;
      return scene.name?.toLowerCase().includes(query);
    })
    .slice(0, limit)
    .map(serializeScene);

  return { scenes: matches, totalMatches: matches.length };
}

async function createScenes(args = {}) {
  const scenes = args.scenes || [];
  if (!Array.isArray(scenes) || scenes.length === 0) throw new Error("scenes array is required");

  const folder = await resolveSceneFolder(args.folder);
  const docs = scenes.map((scene) => prepareSceneData(scene, folder));
  const created = await Scene.createDocuments(docs);

  return { created: created.map(serializeScene) };
}

async function updateScenes(args = {}) {
  const updates = args.updates || [];
  if (!Array.isArray(updates) || updates.length === 0) throw new Error("updates array is required");

  const updated = [];
  for (const update of updates) {
    const scene = findScene(update.id || update.name || update.sceneIdentifier);
    const patch = prepareSceneData(update, null);
    delete patch.name;
    if (update.name !== undefined) patch.name = update.name;
    if (update.folder !== undefined) {
      const folder = await resolveSceneFolder(update.folder);
      patch.folder = folder?.id || null;
    }
    if (Object.keys(patch).length > 0) await scene.update(patch);
    updated.push(serializeScene(scene));
  }

  return { updated };
}

async function deleteScenes(args = {}) {
  const ids = args.ids || [];
  if (!Array.isArray(ids) || ids.length === 0) throw new Error("ids array is required");
  const docs = ids.map((id) => findScene(id));
  await Scene.deleteDocuments(docs.map((doc) => doc.id));
  return { deleted: docs.map((doc) => ({ id: doc.id, name: doc.name })) };
}

async function uploadAssets(args = {}) {
  const source = args.source || "data";
  const targetDir = String(args.targetDir || "").replaceAll("\\", "/").replace(/\/+$/, "");
  const assets = args.assets || [];
  if (!targetDir) throw new Error("targetDir is required");
  if (!Array.isArray(assets) || assets.length === 0) throw new Error("assets array is required");

  await ensureDirectoryPath(source, targetDir);

  const uploaded = [];
  for (const asset of assets) {
    if (!asset.filename) throw new Error("Each asset requires filename");
    if (!asset.dataBase64) throw new Error(`Asset ${asset.filename} requires dataBase64`);

    const bytes = base64ToUint8Array(asset.dataBase64);
    const file = new File([bytes], asset.filename, { type: asset.mimeType || guessMimeType(asset.filename) });
    const result = await FilePicker.upload(source, targetDir, file, { bucket: args.bucket || null }, { notify: false });
    uploaded.push({
      filename: asset.filename,
      path: result.path || `${targetDir}/${asset.filename}`,
      source,
      targetDir,
      result,
    });
  }

  return { uploaded };
}

async function ensureDirectoryPath(source, targetDir) {
  const parts = targetDir.split("/").map((part) => part.trim()).filter(Boolean);
  let current = "";

  for (const part of parts) {
    current = current ? `${current}/${part}` : part;
    try {
      await FilePicker.createDirectory(source, current, { notify: false });
    } catch (error) {
      const message = String(error?.message || error || "");
      if (!/exist|EEXIST|already/i.test(message)) {
        throw error;
      }
    }
  }
}

function base64ToUint8Array(dataBase64) {
  const binary = atob(dataBase64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function guessMimeType(filename) {
  const lower = String(filename).toLowerCase();
  if (lower.endsWith(".png")) return "image/png";
  if (lower.endsWith(".webp")) return "image/webp";
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
  return "application/octet-stream";
}

function listActors(args = {}) {
  const query = String(args.query || "").toLowerCase();
  const type = args.type ? String(args.type) : null;
  const folderName = args.folder ? String(args.folder).toLowerCase() : null;
  const limit = Number.isFinite(args.limit) ? Number(args.limit) : 50;

  const matches = game.actors
    .filter((actor) => {
      if (type && actor.type !== type) return false;
      if (folderName && actor.folder?.name?.toLowerCase() !== folderName) return false;
      if (!query) return true;
      return actor.name?.toLowerCase().includes(query);
    })
    .slice(0, limit)
    .map((actor) => serializeActor(actor, {
      includeSystem: args.includeSystem === true,
      includeItems: args.includeItems === true,
      includeEffects: args.includeEffects === true,
    }));

  return { actors: matches, totalMatches: matches.length };
}

async function createActors(args = {}) {
  const actors = args.actors || [];
  if (!Array.isArray(actors) || actors.length === 0) throw new Error("actors array is required");

  const folder = await resolveActorFolder(args.folder);
  const docs = actors.map((actor) => prepareActorData(actor, folder));
  const created = await Actor.createDocuments(docs);

  return {
    created: created.map((actor) => serializeActor(actor, {
      includeSystem: true,
      includeItems: true,
      includeEffects: true,
    })),
  };
}

async function updateActors(args = {}) {
  const updates = args.updates || [];
  if (!Array.isArray(updates) || updates.length === 0) throw new Error("updates array is required");

  const updated = [];
  for (const update of updates) {
    const actor = findActor(update.id || update.name || update.actorIdentifier);
    const patch = {};
    for (const key of ["name", "img", "system", "prototypeToken", "flags", "ownership"]) {
      if (update[key] !== undefined) patch[key] = update[key];
    }
    if (update.folder !== undefined) {
      const folder = await resolveActorFolder(update.folder);
      patch.folder = folder?.id || null;
    }
    if (Object.keys(patch).length > 0) await actor.update(patch);
    updated.push(serializeActor(actor, {
      includeSystem: true,
      includeItems: args.includeItems === true,
      includeEffects: true,
    }));
  }

  return { updated };
}

function prepareActorData(actor, folder) {
  if (!actor.name) throw new Error("Each actor requires name");

  return {
    name: actor.name,
    type: actor.type || "npc",
    ...(actor.img ? { img: actor.img } : {}),
    ...(folder ? { folder: folder.id } : {}),
    ...(actor.system ? { system: actor.system } : {}),
    ...(actor.prototypeToken ? { prototypeToken: actor.prototypeToken } : {}),
    ...(actor.flags ? { flags: actor.flags } : {}),
    ...(actor.ownership ? { ownership: actor.ownership } : {}),
    ...(Array.isArray(actor.items) ? { items: actor.items.map(prepareItemData) } : {}),
    ...(Array.isArray(actor.effects) ? { effects: actor.effects.map(prepareEffectData) } : {}),
  };
}

function prepareItemData(item) {
  if (!item.name || !item.type) throw new Error("Each embedded item requires name and type");
  return {
    name: item.name,
    type: item.type,
    ...(item.img ? { img: item.img } : {}),
    ...(item.system ? { system: item.system } : {}),
    ...(item.flags ? { flags: item.flags } : {}),
    ...(Array.isArray(item.effects) ? { effects: item.effects.map(prepareEffectData) } : {}),
  };
}

function prepareJournalData(journal, folder) {
  if (!journal.name) throw new Error("Each journal requires name");
  return {
    name: journal.name,
    ...(journal.img ? { img: journal.img } : {}),
    ...(folder ? { folder: folder.id } : {}),
    ...(journal.flags ? { flags: journal.flags } : {}),
    ...(journal.ownership ? { ownership: journal.ownership } : {}),
    ...(Array.isArray(journal.pages) ? { pages: journal.pages.map(prepareJournalPageData) } : {}),
  };
}

function prepareJournalPageData(page) {
  if (!page.name) throw new Error("Each journal page requires name");
  const data = {};
  for (const key of ["name", "type", "sort", "img", "title", "text", "image", "video", "src", "system", "flags"]) {
    if (page?.[key] !== undefined) data[key] = page[key];
  }
  if (!data.type) data.type = "text";
  if (page?.id !== undefined) data._id = page.id;
  if (page?._id !== undefined) data._id = page._id;
  return data;
}

function prepareSceneData(scene, folder) {
  if (!scene.name && !scene.id && !scene.sceneIdentifier) throw new Error("Each scene requires name");
  const data = {};
  for (const key of [
    "name",
    "active",
    "navigation",
    "navName",
    "navOrder",
    "background",
    "foreground",
    "fog",
    "thumb",
    "width",
    "height",
    "padding",
    "grid",
    "darkness",
    "globalLight",
    "tokenVision",
    "notes",
    "flags",
  ]) {
    if (scene?.[key] !== undefined) data[key] = scene[key];
  }
  if (scene.img !== undefined) data.background = { ...(data.background || {}), src: scene.img };
  if (folder) data.folder = folder.id;
  return data;
}

async function resolveActorFolder(folderName) {
  if (!folderName) return null;
  return resolveFolderPath(String(folderName), "Actor");
}

async function resolveJournalFolder(folderName) {
  if (!folderName) return null;
  return resolveFolderPath(String(folderName), "JournalEntry");
}

async function resolveSceneFolder(folderName) {
  if (!folderName) return null;
  return resolveFolderPath(String(folderName), "Scene");
}

async function resolveFolderPath(folderPath, type) {
  const parts = folderPath.split("/").map((part) => part.trim()).filter(Boolean);
  let parent = null;

  for (const name of parts) {
    let folder = game.folders?.find((entry) => {
      const parentId = entry.folder?.id || entry.parent?.id || entry.folder || null;
      return entry.type === type && entry.name === name && parentId === (parent?.id || null);
    });
    if (!folder) {
      folder = await Folder.create({
        name,
        type,
        folder: parent?.id || null,
        sorting: "a",
      });
    }
    parent = folder;
  }

  return parent;
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

function findJournal(identifier) {
  if (!identifier) throw new Error("journalIdentifier is required");
  const normalized = String(identifier).toLowerCase();
  const byId = game.journal?.get(identifier);
  if (byId) return byId;
  const exact = game.journal?.find((entry) => entry.name?.toLowerCase() === normalized);
  if (exact) return exact;
  const partial = game.journal?.filter((entry) => entry.name?.toLowerCase().includes(normalized)) || [];
  if (partial.length === 1) return partial[0];
  if (partial.length > 1) throw new Error(`Journal identifier is ambiguous: ${identifier}`);
  throw new Error(`Journal not found: ${identifier}`);
}

function findJournalPage(journal, identifier) {
  if (!identifier) throw new Error("page id or name is required");
  const normalized = String(identifier).toLowerCase();
  const byId = journal.pages?.get(identifier);
  if (byId) return byId;
  const exact = Array.from(journal.pages || []).find((entry) => entry.name?.toLowerCase() === normalized);
  if (exact) return exact;
  const partial = Array.from(journal.pages || []).filter((entry) => entry.name?.toLowerCase().includes(normalized));
  if (partial.length === 1) return partial[0];
  if (partial.length > 1) throw new Error(`Journal page identifier is ambiguous on ${journal.name}: ${identifier}`);
  throw new Error(`Journal page not found on ${journal.name}: ${identifier}`);
}

function findScene(identifier) {
  if (!identifier) throw new Error("sceneIdentifier is required");
  const normalized = String(identifier).toLowerCase();
  const byId = game.scenes?.get(identifier);
  if (byId) return byId;
  const exact = game.scenes?.find((entry) => entry.name?.toLowerCase() === normalized);
  if (exact) return exact;
  const partial = game.scenes?.filter((entry) => entry.name?.toLowerCase().includes(normalized)) || [];
  if (partial.length === 1) return partial[0];
  if (partial.length > 1) throw new Error(`Scene identifier is ambiguous: ${identifier}`);
  throw new Error(`Scene not found: ${identifier}`);
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
  for (const key of ["name", "label", "icon", "img", "type", "description", "disabled", "transfer", "origin", "duration", "changes", "flags", "statuses", "system"]) {
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
    ownership: actor.ownership,
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

function serializeJournal(journal, options = {}) {
  return {
    id: journal.id,
    name: journal.name,
    img: journal.img,
    folder: journal.folder ? { id: journal.folder.id, name: journal.folder.name } : null,
    ownership: journal.ownership,
    flags: journal.flags,
    pages: options.includePages
      ? Array.from(journal.pages || []).map(serializeJournalPage)
      : Array.from(journal.pages || []).map((page) => ({ id: page.id, name: page.name, type: page.type, sort: page.sort })),
  };
}

function serializeJournalPage(page) {
  const data = page.toObject ? page.toObject() : {};
  return {
    id: page.id,
    name: page.name,
    type: page.type,
    sort: page.sort,
    img: page.img,
    title: data.title || page.title,
    text: data.text || page.text,
    image: data.image || page.image,
    video: data.video || page.video,
    src: data.src || page.src,
    system: data.system || page.system,
    flags: page.flags,
  };
}

function serializeScene(scene) {
  const data = scene.toObject ? scene.toObject() : {};
  return {
    id: scene.id,
    name: scene.name,
    active: scene.active,
    navigation: scene.navigation,
    navName: scene.navName,
    folder: scene.folder ? { id: scene.folder.id, name: scene.folder.name } : null,
    background: data.background || scene.background,
    foreground: data.foreground || scene.foreground,
    thumb: scene.thumb || data.thumb,
    width: scene.width,
    height: scene.height,
    padding: scene.padding,
    grid: scene.grid,
    darkness: scene.darkness,
    tokenVision: scene.tokenVision,
    flags: scene.flags,
  };
}

function journalPageText(page) {
  const data = page.toObject ? page.toObject() : {};
  return [
    page.name,
    data.text?.content,
    data.src,
    data.image?.caption,
    data.system ? JSON.stringify(data.system) : "",
  ].filter(Boolean).join("\n");
}

function serializeEffect(effect) {
  return {
    id: effect.id,
    name: effect.name || effect.label || "Unknown Effect",
    icon: effect.icon,
    type: effect.type,
    disabled: effect.disabled,
    transfer: effect.transfer,
    origin: effect.origin,
    duration: effect.duration,
    changes: effect.changes,
    system: effect.system,
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
