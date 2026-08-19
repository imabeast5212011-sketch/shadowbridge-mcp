const MODULE_ID = "shadowbridge-mcp";
const ENCOUNTER_DIRECTOR_MODULE_ID = "cinematic-encounter-director";
const EXALTED_SCENES_MODULE_ID = "exalted-scenes";
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
    case "find_foundry_assets":
      return findFoundryAssets(args);
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
    case "manage_encounter_director":
      return manageEncounterDirector(args);
    case "manage_exalted_scenes":
      return manageExaltedScenes(args);
    case "setup_koczech_phase1":
      return setupKoczechPhase1(args);
    case "convert_koczech_phase1_to_director":
      return convertKoczechPhase1ToDirector(args);
    default:
      throw new Error(`Unknown Shadowbridge command: ${method}`);
  }
}

function assertGM() {
  if (!game.user?.isGM) throw new Error("Shadowbridge commands require an active GM client.");
}

async function manageEncounterDirector(args = {}) {
  switch (args.action) {
    case "inspect":
      return inspectEncounterDirector(args);
    case "open": {
      const api = requireEncounterDirectorMethod("openDirector");
      api.openDirector(args.options || {});
      return { opened: true, ...(await inspectEncounterDirector(args)) };
    }
    case "get_authoring_context":
      return requireEncounterDirectorMethod("getEncounterAuthoringContext").getEncounterAuthoringContext();
    case "read_action_catalog":
      return requireEncounterDirectorMethod("readActionTypeCatalog").readActionTypeCatalog();
    case "list_sequences": {
      const api = requireEncounterDirectorMethod("readSequenceMetadata");
      const scene = getDirectorScene(args);
      return {
        ...(await inspectEncounterDirector(args)),
        sequences: await api.readSequenceMetadata(scene ?? undefined),
      };
    }
    case "export": {
      const api = requireEncounterDirectorMethod("exportEncounterJson");
      const scene = getDirectorScene(args);
      const options = { ...(args.options || {}) };
      if (args.sequenceId) options.sequenceId = args.sequenceId;
      if (scene) options.scene = scene;
      return api.exportEncounterJson(options);
    }
    case "validate": {
      const input = getEncounterPackageInput(args);
      return requireEncounterDirectorMethod("validateEncounterJson").validateEncounterJson(input);
    }
    case "import": {
      const input = getEncounterPackageInput(args);
      const api = requireEncounterDirectorMethod("importEncounterJson");
      return api.importEncounterJson(input, {
        scene: requireDirectorScene(args),
        mode: args.mode || "duplicate",
      });
    }
    case "upsert_sequence": {
      if (!args.sequence || typeof args.sequence !== "object" || Array.isArray(args.sequence)) {
        throw new Error("manage_encounter_director upsert_sequence requires a sequence object.");
      }
      const api = requireEncounterDirectorMethod("upsertSequence");
      return api.upsertSequence(args.sequence, {
        scene: requireDirectorScene(args),
        replace: args.replace !== false,
      });
    }
    case "dry_run":
    case "run": {
      if (!args.sequenceId || !args.beatId) throw new Error(`${args.action} requires sequenceId and beatId.`);
      const api = requireEncounterDirectorMethod("requestExecution");
      return api.requestExecution({
        sequenceId: args.sequenceId,
        beatId: args.beatId,
        actionId: args.actionId || "",
        dryRun: args.action === "dry_run",
        scene: requireDirectorScene(args),
      });
    }
    case "evaluate_triggers":
      return requireEncounterDirectorMethod("evaluateTriggers").evaluateTriggers(getDirectorScene(args) ?? undefined);
    case "reset_trigger_state": {
      if (!args.sequenceId) throw new Error("reset_trigger_state requires sequenceId.");
      return requireEncounterDirectorMethod("resetTriggerState").resetTriggerState(args.sequenceId, requireDirectorScene(args));
    }
    default:
      throw new Error(`Unsupported manage_encounter_director action: ${args.action}`);
  }
}

async function inspectEncounterDirector(args = {}) {
  const module = game.modules?.get(ENCOUNTER_DIRECTOR_MODULE_ID);
  const api = module?.api || null;
  const scene = getDirectorScene(args);
  const result = {
    module: {
      id: ENCOUNTER_DIRECTOR_MODULE_ID,
      title: module?.title || "",
      installed: Boolean(module),
      active: module?.active === true,
      version: module?.version || "",
      apiDetected: Boolean(api),
      apiMethods: api ? publicApiMethodNames(api) : [],
    },
    activeScene: game.scenes?.active ? compactScene(game.scenes.active) : null,
    selectedScene: scene ? compactScene(scene) : null,
  };

  if (module?.active && api?.readSequenceMetadata && scene) {
    result.sequences = await api.readSequenceMetadata(scene);
  }

  return result;
}

function requireEncounterDirectorMethod(methodName) {
  const module = game.modules?.get(ENCOUNTER_DIRECTOR_MODULE_ID);
  if (!module) throw new Error("Cinematic Encounter Director is not installed.");
  if (!module.active) throw new Error("Cinematic Encounter Director is not active.");
  const api = module.api;
  if (!api) throw new Error("Cinematic Encounter Director public API was not detected. Refresh the Foundry browser after updating the module.");
  if (typeof api[methodName] !== "function") throw new Error(`Cinematic Encounter Director API is missing ${methodName}().`);
  return api;
}

function publicApiMethodNames(api) {
  return Object.entries(Object.getOwnPropertyDescriptors(api))
    .filter(([, descriptor]) => typeof descriptor.value === "function")
    .map(([name]) => name)
    .sort();
}

function getEncounterPackageInput(args = {}) {
  const input = args.packageJson ?? args.input ?? args.encounterJson;
  if (input === undefined) throw new Error("packageJson is required.");
  return input;
}

function getDirectorScene(args = {}) {
  if (args.sceneIdentifier) return findScene(args.sceneIdentifier);
  return game.scenes?.active || null;
}

function requireDirectorScene(args = {}) {
  const scene = getDirectorScene(args);
  if (!scene) throw new Error("No active scene. Provide sceneIdentifier or activate a scene first.");
  return scene;
}

async function manageExaltedScenes(args = {}) {
  switch (args.action) {
    case "inspect":
      return inspectExaltedScenes();
    case "broadcast_scene":
      return callExaltedApi(["broadcast", "scene"], [requireString(args.sceneId, "sceneId")]);
    case "stop_broadcast":
      return callExaltedApi(["broadcast", "stop"], []);
    case "play_slideshow":
      return callExaltedApi(["slideshows", "play"], [requireString(args.slideshowId, "slideshowId")]);
    case "stop_slideshow":
      return callExaltedApi(["slideshows", "stop"], []);
    case "start_sequence":
      return callExaltedApi(["sequences", "start"], [requireString(args.sceneId, "sceneId"), args.options || {}]);
    case "stop_sequence":
      return callExaltedApi(["sequences", "stop"], []);
    case "next_sequence":
      return callExaltedApi(["sequences", "next"], []);
    case "previous_sequence":
      return callExaltedApi(["sequences", "previous"], []);
    case "go_to_sequence":
      return callExaltedApi(["sequences", "goTo"], [Number(args.index ?? 0)]);
    case "start_cast_only": {
      const characterIds = Array.isArray(args.characterIds) ? args.characterIds.map(String).filter(Boolean) : [];
      if (characterIds.length === 0) throw new Error("start_cast_only requires characterIds.");
      return callExaltedApi(["castOnly", "start"], [characterIds, args.layoutSettings || {}]);
    }
    case "stop_cast_only":
      return callExaltedApi(["castOnly", "stop"], []);
    case "play_scene_audio":
      return callExaltedApi(["audio", "playSceneAudio"], [requireString(args.sceneId, "sceneId")]);
    case "restore_scene_audio":
      return callExaltedApi(["audio", "restoreSceneAudio"], [requireString(args.sceneId, "sceneId"), args.options || {}]);
    case "stop_audio":
      return callExaltedApi(["audio", "stopAll"], [args.sceneId || undefined]);
    case "play_soundboard_sound":
      return callExaltedApi(["audio", "playSoundboardSound"], [requireString(args.soundId, "soundId")]);
    case "set_volume":
      return callExaltedApi(["audio", "setVolume"], [Number(args.volume ?? 1)]);
    default:
      throw new Error(`Unsupported manage_exalted_scenes action: ${args.action}`);
  }
}

function inspectExaltedScenes() {
  const module = game.modules?.get(EXALTED_SCENES_MODULE_ID);
  const detected = detectExaltedApi();
  const api = detected.api;
  const capabilities = api ? describeKnownExaltedCapabilities(api) : [];
  return {
    module: {
      id: EXALTED_SCENES_MODULE_ID,
      title: module?.title || "",
      installed: Boolean(module),
      active: module?.active === true,
      version: module?.version || "",
    },
    api: {
      detected: Boolean(api),
      source: detected.source,
      methods: api ? describeApiTree(api) : [],
      capabilities,
    },
  };
}

function callExaltedApi(path, callArgs) {
  const status = inspectExaltedScenes();
  if (!status.module.installed) throw new Error("Exalted Scenes is not installed.");
  if (!status.module.active) throw new Error("Exalted Scenes is not active.");
  const detected = detectExaltedApi();
  if (!detected.api) throw new Error("Exalted Scenes public API was not detected.");
  const owner = path.slice(0, -1).reduce((value, key) => value?.[key], detected.api);
  const fn = owner?.[path.at(-1)];
  const method = path.join(".");
  if (typeof fn !== "function") throw new Error(`Exalted Scenes API method is unavailable: ${method}`);
  return Promise.resolve(fn.apply(owner, callArgs)).then((result) => ({
    ok: true,
    method,
    args: summarizeCallArgs(callArgs),
    apiSource: detected.source,
    result,
  }));
}

function detectExaltedApi() {
  const moduleApi = game.modules?.get(EXALTED_SCENES_MODULE_ID)?.api;
  const candidates = [
    ["game.modules.get(\"exalted-scenes\").api", moduleApi],
    ["globalThis.ExaltedScenes.api", globalThis.ExaltedScenes?.api],
    ["globalThis.ExaltedScenes", globalThis.ExaltedScenes],
    ["globalThis.exaltedScenes.api", globalThis.exaltedScenes?.api],
    ["globalThis.exaltedScenes", globalThis.exaltedScenes],
    ["game.exaltedScenes.api", globalThis.game?.exaltedScenes?.api],
    ["game.exaltedScenes", globalThis.game?.exaltedScenes],
    ["game.exalted?.scenes?.api", globalThis.game?.exalted?.scenes?.api],
    ["game.exalted?.scenes", globalThis.game?.exalted?.scenes],
  ];
  const found = candidates.find(([, api]) => api && typeof api === "object");
  return { source: found?.[0] || "", api: found?.[1] || null };
}

function describeKnownExaltedCapabilities(api) {
  const checks = [
    ["broadcast.scene", ["broadcast", "scene"]],
    ["broadcast.stop", ["broadcast", "stop"]],
    ["slideshows.play", ["slideshows", "play"]],
    ["slideshows.stop", ["slideshows", "stop"]],
    ["sequences.start", ["sequences", "start"]],
    ["sequences.stop", ["sequences", "stop"]],
    ["sequences.next", ["sequences", "next"]],
    ["sequences.previous", ["sequences", "previous"]],
    ["sequences.goTo", ["sequences", "goTo"]],
    ["castOnly.start", ["castOnly", "start"]],
    ["castOnly.stop", ["castOnly", "stop"]],
    ["audio.playSceneAudio", ["audio", "playSceneAudio"]],
    ["audio.restoreSceneAudio", ["audio", "restoreSceneAudio"]],
    ["audio.stopAll", ["audio", "stopAll"]],
    ["audio.playSoundboardSound", ["audio", "playSoundboardSound"]],
    ["audio.setVolume", ["audio", "setVolume"]],
  ];
  return checks.filter(([, path]) => typeof path.reduce((value, key) => value?.[key], api) === "function").map(([capability]) => capability);
}

function describeApiTree(value, prefix = [], depth = 0, output = []) {
  if (!value || typeof value !== "object" || depth > 2) return output;
  for (const key of Object.keys(value).sort()) {
    if (key.startsWith("_")) continue;
    const entry = value[key];
    const path = [...prefix, key];
    if (typeof entry === "function") output.push(path.join("."));
    else if (entry && typeof entry === "object") describeApiTree(entry, path, depth + 1, output);
  }
  return output;
}

function summarizeCallArgs(callArgs = []) {
  return callArgs.map((value) => {
    if (Array.isArray(value)) return value;
    if (!value || typeof value !== "object") return value;
    return { keys: Object.keys(value).sort() };
  });
}

function requireString(value, label) {
  const text = String(value || "").trim();
  if (!text) throw new Error(`${label} is required.`);
  return text;
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
    if (update.backgroundLevel) await upsertSceneBackgroundLevel(scene, update.backgroundLevel);
    if (update.backgroundTile) await upsertSceneBackgroundTile(scene, update.backgroundTile);
    if (Array.isArray(update.deleteTileNames) && update.deleteTileNames.length > 0) {
      const names = new Set(update.deleteTileNames.map(String));
      const ids = Array.from(scene.tiles || []).filter((tile) => names.has(tile.name)).map((tile) => tile.id);
      if (ids.length > 0) await scene.deleteEmbeddedDocuments("Tile", ids);
    }
    if (Array.isArray(update.tiles) && update.tiles.length > 0) {
      await scene.createEmbeddedDocuments("Tile", update.tiles.map(prepareTileData));
    }
    updated.push(serializeScene(scene));
  }

  return { updated };
}

async function upsertSceneBackgroundLevel(scene, level = {}) {
  const flagScope = level.flagScope || MODULE_ID;
  const flagKey = level.flagKey || "backgroundLevel";
  const name = level.name || "Shadowbridge Background";
  const levels = getSceneLevels(scene);
  const matches = levels.filter((existing) => existing.getFlag?.(flagScope, flagKey) || existing.name === name);
  if (matches.length > 1) await scene.deleteEmbeddedDocuments("Level", matches.slice(1).map((existing) => existing.id));

  const data = prepareLevelData({
    ...level,
    name,
    flags: {
      ...(level.flags || {}),
      [flagScope]: {
        ...(level.flags?.[flagScope] || {}),
        [flagKey]: true,
      },
    },
  });

  if (!data.background?.src) throw new Error("backgroundLevel requires background.src, src, or img");
  if (matches[0]) {
    await scene.updateEmbeddedDocuments("Level", [{ ...data, _id: matches[0].id }]);
  } else {
    await scene.createEmbeddedDocuments("Level", [data]);
  }
}

function getSceneLevels(scene) {
  try {
    return Array.from(scene.getEmbeddedCollection?.("Level") || scene.levels || []);
  } catch {
    return Array.from(scene.levels || []);
  }
}

function prepareLevelData(level = {}) {
  const src = level.src || level.img || level.background?.src;
  const data = {};
  for (const key of ["name", "sort", "elevation", "textures", "visibility", "flags"]) {
    if (level[key] !== undefined) data[key] = level[key];
  }
  data.background = {
    src,
    tint: level.background?.tint || "#ffffff",
    alphaThreshold: level.background?.alphaThreshold ?? 0.75,
    color: level.background?.color ?? 0,
    ...(level.background || {}),
  };
  if (level.foreground !== undefined) data.foreground = level.foreground;
  if (level.fog !== undefined) data.fog = level.fog;
  return data;
}

async function upsertSceneBackgroundTile(scene, tile = {}) {
  const flagScope = tile.flagScope || MODULE_ID;
  const flagKey = tile.flagKey || "backgroundTile";
  const name = tile.name || "Shadowbridge Scene Art";
  const matches = Array.from(scene.tiles || []).filter((existing) => existing.getFlag?.(flagScope, flagKey) || existing.name === name);
  if (matches.length > 1) await scene.deleteEmbeddedDocuments("Tile", matches.slice(1).map((existing) => existing.id));

  const data = prepareTileData({
    name,
    x: tile.x ?? 0,
    y: tile.y ?? 0,
    width: tile.width ?? scene.width,
    height: tile.height ?? scene.height,
    src: tile.src || tile.img,
    alpha: tile.alpha ?? 1,
    hidden: tile.hidden ?? false,
    locked: tile.locked ?? true,
    elevation: tile.elevation ?? -100,
    sort: tile.sort ?? -100000,
    flags: {
      ...(tile.flags || {}),
      [flagScope]: {
        ...(tile.flags?.[flagScope] || {}),
        [flagKey]: true,
      },
    },
  });

  if (!data.texture?.src) throw new Error("backgroundTile requires src or img");
  if (matches[0]) {
    await scene.updateEmbeddedDocuments("Tile", [{ ...data, _id: matches[0].id }]);
  } else {
    await scene.createEmbeddedDocuments("Tile", [data]);
  }
}

function prepareTileData(tile = {}) {
  const data = {};
  for (const key of [
    "name",
    "x",
    "y",
    "width",
    "height",
    "alpha",
    "hidden",
    "locked",
    "elevation",
    "sort",
    "rotation",
    "anchorX",
    "anchorY",
    "occlusion",
    "restrictions",
    "video",
    "flags",
  ]) {
    if (tile[key] !== undefined) data[key] = tile[key];
  }
  if (tile.texture !== undefined) data.texture = tile.texture;
  if (tile.src !== undefined || tile.img !== undefined) data.texture = { ...(data.texture || {}), src: tile.src || tile.img };
  return data;
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
  if (lower.endsWith(".mp3")) return "audio/mpeg";
  if (lower.endsWith(".ogg")) return "audio/ogg";
  if (lower.endsWith(".wav")) return "audio/wav";
  return "application/octet-stream";
}

async function findFoundryAssets(args = {}) {
  const filenames = Array.isArray(args.filenames) ? args.filenames.map(String).filter(Boolean) : [];
  if (filenames.length === 0) throw new Error("filenames array is required");

  const source = args.source || "data";
  const bucket = args.bucket || null;
  const roots = Array.isArray(args.searchRoots) && args.searchRoots.length
    ? args.searchRoots.map(String)
    : [`worlds/${game.world?.id || ""}`, "assets", "uploads"];
  const maxDepth = Number.isFinite(args.maxDepth) ? Number(args.maxDepth) : 8;
  const wanted = new Map(filenames.map((filename) => [filename.toLocaleLowerCase(), filename]));
  const matches = Object.fromEntries(filenames.map((filename) => [filename, []]));
  const visited = new Set();
  const searched = [];
  const errors = [];

  async function browseDir(target, depth) {
    const normalizedTarget = String(target || "").replaceAll("\\", "/").replace(/\/+$/, "");
    if (depth > maxDepth || visited.has(normalizedTarget)) return;
    visited.add(normalizedTarget);
    let result = null;
    try {
      result = await FilePicker.browse(source, normalizedTarget, bucket ? { bucket } : {});
      searched.push(normalizedTarget);
    } catch (error) {
      errors.push({ target: normalizedTarget, message: error?.message || String(error) });
      return;
    }

    for (const filePath of result.files || []) {
      const base = decodeURIComponent(String(filePath).split("/").pop() || "");
      const requested = wanted.get(base.toLocaleLowerCase());
      if (requested && !matches[requested].includes(filePath)) matches[requested].push(filePath);
    }
    for (const dir of result.dirs || []) {
      await browseDir(dir, depth + 1);
    }
  }

  for (const root of roots) await browseDir(root, 0);

  const found = {};
  const missing = [];
  for (const filename of filenames) {
    if (matches[filename].length) found[filename] = matches[filename][0];
    else missing.push(filename);
  }
  return { source, roots, searched, found, matches, missing, errors };
}

const KOCZECH_PHASE1_FILES = Object.freeze([
  "Lerisure hall.png",
  "The wall.png",
  "ALU'VADIR (The Pens) Track 6 — _Green Pickle Sandwich_ Gruk — 2005.mp3",
  "Grukrul’A (Radio Fuck you Edit).mp3",
  "Klaxon Warning Siren.mp3",
  "Generic Solvekian Soldier(m).png",
  "Generic Solvekian Soldier(f).png",
  "sabatour.png",
  "Stalker.png",
  "Winged harvester.png",
]);

async function setupKoczechPhase1(args = {}) {
  const assetPaths = args.assetPaths || {};
  const missingFiles = KOCZECH_PHASE1_FILES.filter((filename) => !assetPaths[filename]);
  if (missingFiles.length) {
    return {
      ok: false,
      message: "No changes made. Missing required Phase 1 asset paths.",
      missingFiles,
    };
  }

  const sceneFolder = args.sceneFolder || "COTS/Memory One-Shot — Fall of FOB Koczech/Scenes";
  const actorFolder = args.actorFolder || "COTS/Memory One-Shot — Fall of FOB Koczech/Actors — Crowd";
  const report = {
    ok: true,
    scenes: {},
    playlists: {},
    macros: {},
    actors: {},
    crowdTokens: {},
    enemyImageUpdates: {},
    missingEnemyActors: [],
    manualSteps: [],
    excludedAssets: ["The Wall Falls.mp3"],
  };

  const leisure = await upsertKoczechScene({
    name: "Memory 01 — FOB Koczech Leisure Hall",
    background: assetPaths["Lerisure hall.png"],
    emergencyLighting: false,
    folder: sceneFolder,
  });
  report.scenes.leisureHall = leisure.summary;

  const wall = await upsertKoczechScene({
    name: "Memory 03 — Western Wall of FOB Koczech",
    background: assetPaths["The wall.png"],
    emergencyLighting: true,
    folder: sceneFolder,
  });
  report.scenes.westernWall = wall.summary;

  report.playlists.leisureMusic = await upsertKoczechPlaylist("Koczech Leisure Hall Music", [
    {
      name: "ALU'VADIR (The Pens) Track 6 — _Green Pickle Sandwich_ Gruk — 2005",
      filename: "ALU'VADIR (The Pens) Track 6 — _Green Pickle Sandwich_ Gruk — 2005.mp3",
      path: assetPaths["ALU'VADIR (The Pens) Track 6 — _Green Pickle Sandwich_ Gruk — 2005.mp3"],
      repeat: false,
    },
    {
      name: "Grukrul’A (Radio Fuck you Edit)",
      filename: "Grukrul’A (Radio Fuck you Edit).mp3",
      path: assetPaths["Grukrul’A (Radio Fuck you Edit).mp3"],
      repeat: false,
    },
  ], "sequential");
  report.playlists.klaxon = await upsertKoczechPlaylist("Koczech Alarm Klaxon", [
    {
      name: "Klaxon Warning Siren",
      filename: "Klaxon Warning Siren.mp3",
      path: assetPaths["Klaxon Warning Siren.mp3"],
      repeat: true,
    },
  ], "simultaneous");

  const male = await upsertGenericSolvekianSoldier("Generic Solvekian Soldier — Male", assetPaths["Generic Solvekian Soldier(m).png"], actorFolder);
  const female = await upsertGenericSolvekianSoldier("Generic Solvekian Soldier — Female", assetPaths["Generic Solvekian Soldier(f).png"], actorFolder);
  report.actors.male = male.summary;
  report.actors.female = female.summary;

  report.crowdTokens = await placeKoczechCrowdTokens(leisure.scene, male.actor, female.actor);

  report.enemyImageUpdates.saboteur = await updateEnemyActorImage("Turned Solvekian Saboteur", assetPaths["sabatour.png"], ["sabatour", "saboteur"]);
  report.enemyImageUpdates.stalker = await updateEnemyActorImage("Umbra Stalker", assetPaths["Stalker.png"], ["stalker"]);
  report.enemyImageUpdates.wingedHarvester = await updateEnemyActorImage("Umbra Winged Harvester", assetPaths["Winged harvester.png"], ["winged harvester", "harvester"]);
  for (const [key, value] of Object.entries(report.enemyImageUpdates)) {
    if (!value.updated) report.missingEnemyActors.push({ key, requestedName: value.requestedName, reason: value.reason });
  }

  report.macros.alarm = await upsertKoczechMacro("Koczech Phase 1 — Alarm Trigger", koczechAlarmMacroCommand());
  report.macros.wallTransition = await upsertKoczechMacro("Koczech Phase 1 — Transition to Wall", koczechWallTransitionMacroCommand());

  if (report.missingEnemyActors.length) report.manualSteps.push("Some enemy actors were not found by exact/loose name; image updates for those entries were skipped.");
  report.manualSteps.push("Journals were not created or revealed. Fire existing journals manually.");
  report.manualSteps.push("No enemies were spawned and combat was not started.");
  return report;
}

async function convertKoczechPhase1ToDirector(args = {}) {
  const leisure = game.scenes?.find((entry) => entry.name === "Memory 01 — FOB Koczech Leisure Hall");
  const wall = game.scenes?.find((entry) => entry.name === "Memory 03 — Western Wall of FOB Koczech");
  if (!leisure) throw new Error("Memory 01 — FOB Koczech Leisure Hall was not found.");
  if (!wall) throw new Error("Memory 03 — Western Wall of FOB Koczech was not found.");

  const music = game.playlists?.find((entry) => entry.name === "Koczech Leisure Hall Music");
  const klaxon = game.playlists?.find((entry) => entry.name === "Koczech Alarm Klaxon");
  if (!music) throw new Error("Koczech Leisure Hall Music playlist was not found.");
  if (!klaxon) throw new Error("Koczech Alarm Klaxon playlist was not found.");

  const klaxonSound = Array.from(klaxon.sounds || []).find((entry) => entry.name === "Klaxon Warning Siren" || String(entry.path || "").includes("Klaxon"));
  const leisureNormal = getKoczechLightUuids(leisure, ["normal"]);
  const leisureEmergency = getKoczechLightUuids(leisure, ["emergency"]);
  const wallNormal = getKoczechLightUuids(wall, ["normal"]);
  const wallEmergency = getKoczechLightUuids(wall, ["emergency", "searchlight"]);

  await setKoczechWallLightsSteady(wall);

  const sequence = buildKoczechPhase1DirectorSequence({
    leisure,
    wall,
    music,
    klaxon,
    klaxonSound,
    leisureNormal,
    leisureEmergency,
    wallNormal,
    wallEmergency,
  });

  const api = requireEncounterDirectorMethod("upsertSequence");
  const saved = await api.upsertSequence(sequence, { scene: leisure, replace: true });

  let deletedMacros = [];
  if (args.deleteTemporaryMacros !== false) {
    deletedMacros = await deleteKoczechTemporaryMacros();
  }

  return {
    ok: true,
    sequence: {
      id: saved.id,
      name: saved.name,
      sceneUuid: saved.sceneUuid,
      beatCount: saved.beats?.length ?? sequence.beats.length,
      actionCount: sequence.beats.reduce((total, beat) => total + beat.actions.length, 0),
    },
    scene: compactScene(leisure),
    wall: compactScene(wall),
    playlists: {
      music: { id: music.id, uuid: music.uuid, name: music.name },
      klaxon: { id: klaxon.id, uuid: klaxon.uuid, name: klaxon.name, soundId: klaxonSound?.id || "" },
    },
    lights: {
      leisureNormal: leisureNormal.length,
      leisureEmergency: leisureEmergency.length,
      wallNormal: wallNormal.length,
      wallEmergency: wallEmergency.length,
      wallFlashingRemoved: true,
    },
    deletedTemporaryMacros: deletedMacros,
    notes: [
      "Director sequence created on the Leisure Hall scene.",
      "No journal reveal actions were created.",
      "No enemy spawn or combat actions were created.",
      "Wall emergency/search lights were set to steady animation.",
    ],
  };
}

function getKoczechLightUuids(scene, roles = []) {
  const allowed = new Set(roles);
  return getSceneLights(scene)
    .filter((light) => {
      if (!light.getFlag?.(MODULE_ID, "koczechPhase1Light")) return false;
      return allowed.has(light.getFlag(MODULE_ID, "koczechRole"));
    })
    .map((light) => light.uuid || `Scene.${scene.id}.AmbientLight.${light.id}`);
}

async function setKoczechWallLightsSteady(scene) {
  const updates = getSceneLights(scene)
    .filter((light) => light.getFlag?.(MODULE_ID, "koczechPhase1Light"))
    .map((light) => ({
      _id: light.id,
      "config.animation.type": "",
      "config.animation.speed": 0,
      "config.animation.intensity": 0,
    }));
  if (updates.length) await scene.updateEmbeddedDocuments("AmbientLight", updates);
  return updates.length;
}

async function deleteKoczechTemporaryMacros() {
  const names = new Set(["Koczech Phase 1 — Alarm Trigger", "Koczech Phase 1 — Transition to Wall"]);
  const macros = game.macros?.filter((macro) => names.has(macro.name)) || [];
  if (macros.length) await Macro.deleteDocuments(macros.map((macro) => macro.id));
  return macros.map((macro) => ({ id: macro.id, name: macro.name }));
}

function buildKoczechPhase1DirectorSequence({
  leisure,
  wall,
  music,
  klaxon,
  klaxonSound,
  leisureNormal,
  leisureEmergency,
  wallNormal,
  wallEmergency,
}) {
  const beats = [
    {
      id: "beat-koczech-phase1-start-state",
      name: "Leisure Hall Start State",
      description: "Normal leisure hall state: cool white/blue light, subtle grid, music running. No red alarm yet.",
      actions: [
        directorAction("action-koczech-start-activate-leisure", "native.activateScene", "Activate Leisure Hall", { sceneUuid: leisure.uuid }),
        directorAction("action-koczech-start-darkness", "native.setSceneDarkness", "Normal leisure hall lighting", { sceneUuid: leisure.uuid, darkness: 0.18 }),
        directorAction("action-koczech-start-normal-lights", "native.updateAmbientLights", "Enable cool hall lights", { lightUuids: leisureNormal, updates: { hidden: false } }),
        directorAction("action-koczech-start-hide-red", "native.updateAmbientLights", "Hide emergency red lights", { lightUuids: leisureEmergency, updates: { hidden: true } }),
        directorAction("action-koczech-start-music", "native.playlistCue", "Start Leisure Hall music", { playlistUuid: music.uuid, operation: "play" }),
        directorAction("action-koczech-start-note", "native.note", "GM note: no journals", { message: "Phase 1 start state. Journals are manual; no combat or enemies." }),
      ],
    },
    {
      id: "beat-koczech-phase1-alarm",
      name: "Koczech Phase 1 — Alarm Trigger",
      description: "Stop leisure music, cut normal lights, flash red alarm lights, start klaxon, and post PA warning. No journals, enemies, or combat.",
      actions: [
        directorAction("action-koczech-alarm-stop-music", "native.playlistCue", "Stop Leisure Hall music", { playlistUuid: music.uuid, operation: "stop" }),
        directorAction("action-koczech-alarm-dim-scene", "native.setSceneDarkness", "Dim Leisure Hall", { sceneUuid: leisure.uuid, darkness: 0.65 }),
        directorAction("action-koczech-alarm-cut-normal", "native.updateAmbientLights", "Cut normal hall lights", { lightUuids: leisureNormal, updates: { hidden: true } }),
        directorAction("action-koczech-alarm-red-lights", "native.updateAmbientLights", "Flash red emergency lights", {
          lightUuids: leisureEmergency,
          updates: {
            hidden: false,
            "config.animation.type": "pulse",
            "config.animation.speed": 4,
            "config.animation.intensity": 6,
          },
        }),
        directorAction("action-koczech-alarm-klaxon", "native.playlistCue", "Start Klaxon Warning Siren", { playlistUuid: klaxon.uuid, soundId: klaxonSound?.id || "", operation: "play" }),
        directorAction("action-koczech-alarm-pa", "native.chatMessage", "PA warning", {
          whisperGmOnly: false,
          message: "PA: Attention. Enemy inbound. Report to combat stations. Western perimeter, report to defensive stations. Medical personnel to triage. This is not a drill.",
        }),
      ],
    },
    {
      id: "beat-koczech-phase1-wall-transition",
      name: "Koczech Phase 1 — Transition to Wall",
      description: "Move to the Western Wall scene, keep klaxon looping, use steady red/search lighting, and do not start wall combat.",
      actions: [
        directorAction("action-koczech-wall-activate", "native.activateScene", "Activate Western Wall", { sceneUuid: wall.uuid }),
        directorAction("action-koczech-wall-darkness", "native.setSceneDarkness", "Emergency wall darkness", { sceneUuid: wall.uuid, darkness: 0.72 }),
        directorAction("action-koczech-wall-hide-normal", "native.updateAmbientLights", "Hide normal wall lights", { lightUuids: wallNormal, updates: { hidden: true, "config.animation.type": "", "config.animation.speed": 0, "config.animation.intensity": 0 } }),
        directorAction("action-koczech-wall-steady-emergency", "native.updateAmbientLights", "Steady red/search lighting", { lightUuids: wallEmergency, updates: { hidden: false, "config.animation.type": "", "config.animation.speed": 0, "config.animation.intensity": 0 } }),
        directorAction("action-koczech-wall-klaxon", "native.playlistCue", "Keep Klaxon Warning Siren running", { playlistUuid: klaxon.uuid, soundId: klaxonSound?.id || "", operation: "play" }),
        directorAction("action-koczech-wall-note", "native.note", "GM note: hold combat", { message: "Transition only. Do not spawn enemies, reveal journals, start combat, or play The Wall Falls.mp3." }),
      ],
    },
  ].map((beat, index) => ({
    ...beat,
    order: index,
    actionIds: beat.actions.map((action) => action.id),
    stopPointAfter: true,
    continueOnActionFailure: false,
    dangerLevel: "changesScene",
  }));

  return {
    id: "sequence-koczech-phase1",
    name: "Koczech Phase 1 — Leisure Hall Alarm",
    description: "Click-through Phase 1 control sequence for FOB Koczech: start state, alarm, wall transition. Journals remain manual.",
    sceneUuid: leisure.uuid,
    startingBeatId: beats[0].id,
    beatIds: beats.map((beat) => beat.id),
    beats,
    tags: ["koczech", "phase-1", "memory"],
    gmNotes: "No journal reveal, no enemy spawn, no combat start. The Wall Falls.mp3 is intentionally unused.",
    enabled: true,
    archived: false,
  };
}

function directorAction(id, type, name, config) {
  return {
    id,
    type,
    name,
    adapter: "foundry-native",
    config,
    enabled: true,
    requiresConfirmation: false,
    failurePolicy: "stop",
    executionMode: "sequential",
    rollbackSupported: type === "native.setSceneDarkness" || type === "native.updateAmbientLights" || type === "native.playlistCue",
  };
}

async function upsertKoczechScene({ name, background, emergencyLighting, folder }) {
  let scene = game.scenes?.find((entry) => entry.name === name);
  const folderDoc = await resolveSceneFolder(folder);
  const dimensions = await imageDimensions(background);
  const data = {
    name,
    ...(folderDoc ? { folder: folderDoc.id } : {}),
    "background.src": background,
    thumb: background,
    padding: 0,
    tokenVision: false,
    backgroundColor: "#000000",
    darkness: emergencyLighting ? 0.72 : 0.18,
    "grid.type": globalThis.CONST?.GRID_TYPES?.SQUARE ?? 1,
    "grid.size": 100,
    "grid.color": "#88a2bf",
    "grid.alpha": 0.06,
    initial: {
      x: Math.round((dimensions.width || scene?.width || 1448) / 2),
      y: Math.round((dimensions.height || scene?.height || 1086) / 2),
      scale: 0.6,
    },
    flags: {
      ...(scene?.flags || {}),
      cotsMemory: {
        sequence: "Memory One-Shot — Fall of FOB Koczech",
        purpose: name.includes("Leisure") ? "Opening roleplay, false normalcy, rumors, player soldier assignment." : "Phase 1 wall transition staging. No wall combat starts here.",
        lighting: emergencyLighting ? "Emergency red lighting and searchlights. Klaxon continues." : "Cool blue/white military leisure hall lighting. No emergency red yet.",
        grid: "usable but visually subtle",
      },
    },
  };
  if (dimensions.width && dimensions.height) {
    data.width = dimensions.width;
    data.height = dimensions.height;
  }

  if (scene) {
    await scene.update(data);
  } else {
    const created = await Scene.createDocuments([undotCreateData(data)]);
    scene = created[0];
  }

  await upsertSceneBackgroundLevel(scene, {
    name: "Level",
    src: background,
    flagScope: MODULE_ID,
    flagKey: "backgroundLevel",
    background: { src: background, tint: "#ffffff", alphaThreshold: 0.75, color: "#000000" },
    textures: { fit: "fill", anchorX: 0.5, anchorY: 0.5, offsetX: 0, offsetY: 0, scaleX: 1, scaleY: 1, rotation: 0 },
    elevation: { bottom: 0, top: 20 },
    visibility: { levels: [] },
    flags: {
      cotsMemory: {
        sequence: "Memory One-Shot — Fall of FOB Koczech",
        sceneBackground: true,
      },
    },
  });
  await upsertKoczechSceneLights(scene, emergencyLighting);
  return { scene, summary: compactScene(scene) };
}

function undotCreateData(data) {
  const output = {};
  for (const [key, value] of Object.entries(data)) {
    if (!key.includes(".")) {
      output[key] = value;
      continue;
    }
    const parts = key.split(".");
    let target = output;
    while (parts.length > 1) {
      const part = parts.shift();
      target[part] ||= {};
      target = target[part];
    }
    target[parts[0]] = value;
  }
  return output;
}

async function imageDimensions(src) {
  try {
    const texture = await globalThis.loadTexture?.(src);
    const width = Math.round(texture?.baseTexture?.realWidth || texture?.width || 0);
    const height = Math.round(texture?.baseTexture?.realHeight || texture?.height || 0);
    return { width, height };
  } catch {
    return { width: 0, height: 0 };
  }
}

async function upsertKoczechSceneLights(scene, emergencyLighting) {
  const width = scene.width || 1448;
  const height = scene.height || 1086;
  const normalHidden = emergencyLighting;
  const emergencyHidden = !emergencyLighting;
  const specs = [
    lightSpec("Koczech Cool Hall Light NW", "normal", 0.25, 0.28, "#b8dcff", 0.42, 620, 180, normalHidden, "none"),
    lightSpec("Koczech Cool Hall Light NE", "normal", 0.72, 0.30, "#c7e7ff", 0.38, 660, 190, normalHidden, "none"),
    lightSpec("Koczech Cool Hall Light SW", "normal", 0.30, 0.70, "#b5d7ff", 0.32, 520, 150, normalHidden, "none"),
    lightSpec("Koczech Cool Hall Light SE", "normal", 0.70, 0.68, "#cdeaff", 0.32, 520, 150, normalHidden, "none"),
    lightSpec("Koczech Emergency Red West", "emergency", 0.16, 0.42, "#ff1f24", 0.76, 720, 120, emergencyHidden, "pulse"),
    lightSpec("Koczech Emergency Red East", "emergency", 0.84, 0.45, "#ff1f24", 0.76, 720, 120, emergencyHidden, "pulse"),
    lightSpec("Koczech Emergency Red Center", "emergency", 0.50, 0.58, "#ff2b30", 0.62, 640, 100, emergencyHidden, "pulse"),
  ];
  if (emergencyLighting) {
    specs.push(
      lightSpec("Koczech Wall Searchlight Left", "searchlight", 0.28, 0.34, "#e8f6ff", 0.62, 820, 260, false, "siren"),
      lightSpec("Koczech Wall Searchlight Right", "searchlight", 0.72, 0.34, "#e8f6ff", 0.62, 820, 260, false, "siren"),
    );
  }

  const existing = getSceneLights(scene);
  const creates = [];
  const updates = [];
  const seenIds = new Set();
  for (const spec of specs) {
    const data = {
      name: spec.name,
      x: Math.round(width * spec.rx),
      y: Math.round(height * spec.ry),
      hidden: spec.hidden,
      config: {
        dim: spec.dim,
        bright: spec.bright,
        color: spec.color,
        alpha: spec.alpha,
        angle: 360,
        luminosity: 0.5,
        coloration: 1,
        animation: spec.animation === "none" ? { type: "" } : { type: spec.animation, speed: 4, intensity: 6 },
      },
      flags: {
        [MODULE_ID]: {
          koczechPhase1Light: true,
          koczechRole: spec.role,
        },
      },
    };
    const matches = existing.filter((light) => light.name === spec.name || (light.getFlag?.(MODULE_ID, "koczechPhase1Light") && light.getFlag?.(MODULE_ID, "koczechRole") === spec.role && !seenIds.has(light.id)));
    if (matches[0]) {
      seenIds.add(matches[0].id);
      updates.push({ ...data, _id: matches[0].id });
      if (matches.length > 1) {
        await scene.deleteEmbeddedDocuments("AmbientLight", matches.slice(1).map((light) => light.id));
      }
    } else {
      creates.push(data);
    }
  }
  if (updates.length) await scene.updateEmbeddedDocuments("AmbientLight", updates);
  if (creates.length) await scene.createEmbeddedDocuments("AmbientLight", creates);
}

function lightSpec(name, role, rx, ry, color, alpha, dim, bright, hidden, animation) {
  return { name, role, rx, ry, color, alpha, dim, bright, hidden, animation };
}

function getSceneLights(scene) {
  try {
    return Array.from(scene.getEmbeddedCollection?.("AmbientLight") || scene.lights || []);
  } catch {
    return Array.from(scene.lights || []);
  }
}

async function upsertKoczechPlaylist(name, sounds, modeName) {
  const modes = globalThis.CONST?.PLAYLIST_MODES || {};
  const mode = modeName === "simultaneous" ? (modes.SIMULTANEOUS ?? 3) : (modes.SEQUENTIAL ?? 1);
  let playlist = game.playlists?.find((entry) => entry.name === name);
  if (!playlist) playlist = await Playlist.create({ name, mode, flags: { [MODULE_ID]: { koczechPhase1: true } } });
  else await playlist.update({ mode, flags: { ...(playlist.flags || {}), [MODULE_ID]: { ...(playlist.flags?.[MODULE_ID] || {}), koczechPhase1: true } } });

  const changed = [];
  for (const sound of sounds) {
    const existing = Array.from(playlist.sounds || []).find((entry) => entry.path === sound.path || entry.name === sound.name || entry.name === sound.filename);
    const data = {
      name: sound.name,
      path: sound.path,
      repeat: sound.repeat,
      volume: 0.8,
      playing: false,
      flags: {
        [MODULE_ID]: {
          koczechPhase1: true,
          exactFilename: sound.filename,
          loopPlaylist: name === "Koczech Leisure Hall Music",
        },
      },
    };
    if (existing) {
      await playlist.updateEmbeddedDocuments("PlaylistSound", [{ ...data, _id: existing.id }]);
      changed.push({ id: existing.id, name: data.name, path: data.path, updated: true });
    } else {
      const created = await playlist.createEmbeddedDocuments("PlaylistSound", [data]);
      changed.push({ id: created[0]?.id, name: data.name, path: data.path, created: true });
    }
  }
  return { id: playlist.id, name: playlist.name, mode, sounds: changed };
}

async function upsertKoczechMacro(name, command) {
  let macro = game.macros?.find((entry) => entry.name === name);
  const data = {
    name,
    type: "script",
    scope: "global",
    command,
    ownership: { default: 0, [game.user?.id]: 3 },
    flags: { [MODULE_ID]: { koczechPhase1: true } },
  };
  if (macro) {
    await macro.update(data);
    return { id: macro.id, name: macro.name, updated: true };
  }
  macro = await Macro.create(data);
  return { id: macro.id, name: macro.name, created: true };
}

function koczechAlarmMacroCommand() {
  return `(async () => {
  if (!game.user?.isGM) return ui.notifications?.warn("GM only.");
  const SCOPE = "shadowbridge-mcp";
  const scene = canvas.scene || game.scenes.active;
  const music = game.playlists.find((p) => p.name === "Koczech Leisure Hall Music");
  if (music?.stopAll) await music.stopAll();
  if (scene) {
    const updates = Array.from(scene.lights || []).filter((light) => light.getFlag?.(SCOPE, "koczechPhase1Light")).map((light) => {
      const role = light.getFlag(SCOPE, "koczechRole");
      return { _id: light.id, hidden: role === "normal" };
    });
    if (updates.length) await scene.updateEmbeddedDocuments("AmbientLight", updates);
    await scene.update({ darkness: 0.65 });
  }
  const klaxon = game.playlists.find((p) => p.name === "Koczech Alarm Klaxon");
  if (klaxon) {
    if (klaxon.stopAll) await klaxon.stopAll();
    const sound = Array.from(klaxon.sounds || []).find((entry) => entry.name === "Klaxon Warning Siren" || String(entry.path || "").includes("Klaxon"));
    if (sound && klaxon.playSound) await klaxon.playSound(sound);
    else if (klaxon.playAll) await klaxon.playAll();
  }
  await ChatMessage.create({ content: "<strong>PA:</strong> Attention. Enemy inbound. Report to combat stations.<br><strong>PA:</strong> Western perimeter, report to defensive stations. Medical personnel to triage. This is not a drill." });
})();`;
}

function koczechWallTransitionMacroCommand() {
  return `(async () => {
  if (!game.user?.isGM) return ui.notifications?.warn("GM only.");
  const scene = game.scenes.find((entry) => entry.name === "Memory 03 — Western Wall of FOB Koczech");
  if (!scene) return ui.notifications?.error("Memory 03 — Western Wall of FOB Koczech was not found.");
  const SCOPE = "shadowbridge-mcp";
  const updates = Array.from(scene.lights || []).filter((light) => light.getFlag?.(SCOPE, "koczechPhase1Light")).map((light) => {
    const role = light.getFlag(SCOPE, "koczechRole");
    return { _id: light.id, hidden: role === "normal" ? true : false };
  });
  if (updates.length) await scene.updateEmbeddedDocuments("AmbientLight", updates);
  await scene.update({ darkness: 0.72 });
  await scene.activate();
  const klaxon = game.playlists.find((p) => p.name === "Koczech Alarm Klaxon");
  if (klaxon) {
    const sound = Array.from(klaxon.sounds || []).find((entry) => entry.name === "Klaxon Warning Siren" || String(entry.path || "").includes("Klaxon"));
    if (sound && klaxon.playSound) await klaxon.playSound(sound);
    else if (klaxon.playAll) await klaxon.playAll();
  }
})();`;
}

async function upsertGenericSolvekianSoldier(name, imagePath, folderPath) {
  const folder = await resolveActorFolder(folderPath);
  let actor = game.actors?.find((entry) => entry.name === name);
  const data = genericSolvekianSoldierData(name, imagePath, folder);
  if (actor) {
    await actor.update({
      img: data.img,
      folder: data.folder,
      system: data.system,
      prototypeToken: data.prototypeToken,
      ownership: data.ownership,
      flags: data.flags,
    });
  } else {
    actor = (await Actor.createDocuments([data]))[0];
  }
  await ensureSoldierItems(actor);
  return { actor, summary: serializeActor(actor, { includeItems: true, includeEffects: true }) };
}

function genericSolvekianSoldierData(name, imagePath, folder) {
  return {
    name,
    type: "npc",
    img: imagePath,
    ...(folder ? { folder: folder.id } : {}),
    ownership: { default: 0, [game.user?.id]: 3 },
    prototypeToken: {
      name,
      actorLink: false,
      disposition: globalThis.CONST?.TOKEN_DISPOSITIONS?.FRIENDLY ?? 1,
      texture: { src: imagePath },
      width: 1,
      height: 1,
    },
    flags: { [MODULE_ID]: { koczechPhase1: true, commonSoldier: true } },
    system: {
      abilities: {
        str: { value: 11 },
        dex: { value: 14 },
        con: { value: 12 },
        int: { value: 10 },
        wis: { value: 11 },
        cha: { value: 10 },
      },
      attributes: {
        ac: { calc: "flat", flat: 14 },
        hp: { value: 12, max: 12 },
        movement: { walk: 30, units: "ft" },
      },
      details: {
        type: { value: "humanoid", subtype: "Solvekian", custom: "Medium humanoid" },
        alignment: "Friendly/Neutral",
      },
      traits: {
        size: "med",
        languages: { value: [], custom: "Solvekian" },
      },
      skills: {
        prc: { value: 0, ability: "wis", prof: 1 },
        ath: { value: 0, ability: "str", prof: 1 },
      },
    },
  };
}

async function ensureSoldierItems(actor) {
  const itemData = [
    soldierWeapon("Laser Carbine", "rwak", "dex", 70, 210, "1d10", "radiant", "Ranged Weapon Attack: +4 to hit, range 70/210 ft., one target. Hit: 1d10 radiant damage."),
    soldierWeapon("Sidearm", "rwak", "dex", 40, 120, "1d8", "radiant", "Ranged Weapon Attack: +4 to hit, range 40/120 ft., one target. Hit: 1d8 radiant damage."),
    soldierWeapon("Rifle Butt", "mwak", "str", 5, null, "1d6", "bludgeoning", "Melee Weapon Attack: +2 to hit, reach 5 ft., one target. Hit: 1d6 bludgeoning damage."),
    soldierFeature("Base Training", "The soldier has advantage on ability checks made to follow simple battlefield orders, carry supplies, or hold formation with other Solvekian soldiers."),
    soldierFeature("First Contact Panic", "The first time this soldier sees an Umbra creature or a turned Solvekian soldier attack an ally, it must succeed on a DC 12 Wisdom saving throw or become frightened until the end of its next turn."),
  ];
  for (const item of itemData) {
    const existing = actor.items?.find((entry) => entry.name === item.name);
    if (existing) await actor.updateEmbeddedDocuments("Item", [{ ...item, _id: existing.id }]);
    else await actor.createEmbeddedDocuments("Item", [item]);
  }
}

function soldierWeapon(name, actionType, ability, range, longRange, damageDie, damageType, description) {
  return {
    name,
    type: "weapon",
    system: {
      description: { value: `<p>${description}</p>` },
      activation: { type: "action", cost: 1 },
      target: { value: 1, type: "creature" },
      range: { value: range, long: longRange ?? null, units: "ft" },
      ability,
      actionType,
      proficient: true,
      equipped: true,
      damage: { parts: [[damageDie, damageType]], versatile: "" },
    },
  };
}

function soldierFeature(name, description) {
  return {
    name,
    type: "feat",
    system: {
      description: { value: `<p>${description}</p>` },
      activation: { type: "special", cost: 0 },
    },
  };
}

async function placeKoczechCrowdTokens(scene, maleActor, femaleActor) {
  const existing = Array.from(scene.tokens || []).filter((token) => token.getFlag?.(MODULE_ID, "koczechCrowd"));
  if (existing.length) await scene.deleteEmbeddedDocuments("Token", existing.map((token) => token.id));
  const width = scene.width || 1448;
  const height = scene.height || 1086;
  const spots = [
    ["tables", 0.26, 0.45, maleActor],
    ["tables", 0.34, 0.53, femaleActor],
    ["tables", 0.53, 0.46, maleActor],
    ["tables", 0.61, 0.56, femaleActor],
    ["bar/serving area", 0.78, 0.34, maleActor],
    ["bar/serving area", 0.84, 0.48, femaleActor],
    ["lounge corner", 0.18, 0.72, maleActor],
    ["lounge corner", 0.38, 0.78, femaleActor],
    ["wall consoles", 0.72, 0.70, maleActor],
    ["entry/exit area", 0.90, 0.62, femaleActor],
  ];
  const tokens = spots.map(([area, rx, ry, actor], index) => ({
    name: `${actor.name} ${index + 1}`,
    actorId: actor.id,
    actorLink: false,
    x: Math.round(width * rx),
    y: Math.round(height * ry),
    width: 1,
    height: 1,
    disposition: globalThis.CONST?.TOKEN_DISPOSITIONS?.FRIENDLY ?? 1,
    texture: { src: actor.prototypeToken?.texture?.src || actor.img },
    flags: {
      [MODULE_ID]: {
        koczechCrowd: true,
        koczechPhase1: true,
        area,
      },
    },
  }));
  const created = await scene.createEmbeddedDocuments("Token", tokens);
  return {
    scene: compactScene(scene),
    deletedExisting: existing.length,
    placed: created.length,
    male: created.filter((token) => token.actorId === maleActor.id).length,
    female: created.filter((token) => token.actorId === femaleActor.id).length,
    areas: spots.map(([area]) => area),
  };
}

async function updateEnemyActorImage(requestedName, imagePath, looseTerms = []) {
  const actor = findActorLoose(requestedName, looseTerms);
  if (!actor) return { requestedName, updated: false, reason: "not found" };
  await actor.update({ img: imagePath, "prototypeToken.texture.src": imagePath });
  const sceneTokenUpdates = [];
  for (const scene of game.scenes || []) {
    const matching = getMatchingTokens(scene, actor);
    if (!matching.length) continue;
    await scene.updateEmbeddedDocuments("Token", matching.map((token) => ({ _id: token.id, "texture.src": imagePath })));
    sceneTokenUpdates.push({ scene: scene.name, tokens: matching.length });
  }
  return { requestedName, updated: true, actor: compactActor(actor), imagePath, sceneTokenUpdates };
}

function findActorLoose(requestedName, looseTerms = []) {
  const normalized = requestedName.toLocaleLowerCase();
  const exact = game.actors?.find((entry) => entry.name?.toLocaleLowerCase() === normalized);
  if (exact) return exact;
  const terms = [normalized, ...looseTerms.map((term) => String(term).toLocaleLowerCase())];
  for (const term of terms) {
    const matches = game.actors?.filter((entry) => entry.name?.toLocaleLowerCase().includes(term)) || [];
    if (matches.length === 1) return matches[0];
  }
  return null;
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
    "foreground",
    "fog",
    "thumb",
    "backgroundColor",
    "width",
    "height",
    "padding",
    "grid",
    "initial",
    "shiftX",
    "shiftY",
    "darkness",
    "globalLight",
    "tokenVision",
    "weather",
    "transition",
    "notes",
    "flags",
  ]) {
    if (scene?.[key] !== undefined) data[key] = scene[key];
  }
  if (scene.background !== undefined) {
    for (const [key, value] of Object.entries(scene.background || {})) {
      data[`background.${key}`] = value;
    }
  }
  if (scene.img !== undefined) data["background.src"] = scene.img;
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
    backgroundColor: scene.backgroundColor ?? data.backgroundColor,
    foreground: data.foreground || scene.foreground,
    thumb: scene.thumb || data.thumb,
    width: scene.width,
    height: scene.height,
    padding: scene.padding,
    grid: scene.grid,
    initial: data.initial || scene.initial,
    shiftX: scene.shiftX ?? data.shiftX,
    shiftY: scene.shiftY ?? data.shiftY,
    darkness: scene.darkness,
    tokenVision: scene.tokenVision,
    weather: scene.weather,
    flags: scene.flags,
    levels: getSceneLevels(scene).map(serializeLevel),
    tiles: Array.from(scene.tiles || []).map(serializeTile),
  };
}

function serializeLevel(level) {
  const data = level.toObject ? level.toObject() : {};
  return {
    id: level.id,
    name: level.name,
    sort: level.sort,
    background: data.background || level.background,
    foreground: data.foreground || level.foreground,
    fog: data.fog || level.fog,
    textures: data.textures || level.textures,
    elevation: data.elevation || level.elevation,
    visibility: data.visibility || level.visibility,
    flags: level.flags,
  };
}

function serializeTile(tile) {
  const data = tile.toObject ? tile.toObject() : {};
  return {
    id: tile.id,
    name: tile.name,
    x: tile.x,
    y: tile.y,
    width: tile.width,
    height: tile.height,
    alpha: tile.alpha,
    hidden: tile.hidden,
    locked: tile.locked,
    elevation: tile.elevation,
    sort: tile.sort,
    texture: data.texture || tile.texture,
    flags: tile.flags,
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

function compactScene(scene) {
  return { id: scene.id, name: scene.name, uuid: scene.uuid, active: scene.active };
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
