import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import WebSocket from "ws";

const GATEWAY_URL = "wss://gateway.discord.gg/?v=10&encoding=json";
const API_BASE = "https://discord.com/api/v10";
const PRESENCE_LIMIT = 4;
const PRESENCE_WINDOW_MS = 20_000;

const __dirname = dirname(fileURLToPath(import.meta.url));

function loadConfig() {
  const configPath = join(__dirname, "config.json");
  let raw;
  try {
    raw = readFileSync(configPath, "utf8");
  } catch {
    console.error("Error: config.json not found. Copy config.example.json to config.json.");
    process.exit(1);
  }

  let config;
  try {
    config = JSON.parse(raw);
  } catch {
    console.error("Error: config.json is not valid JSON.");
    process.exit(1);
  }

  if (!config.token || config.token === "YOUR_USER_TOKEN_HERE") {
    console.error("Error: Set a valid token in config.json.");
    process.exit(1);
  }

  if (!config.applicationId || config.applicationId === "YOUR_APPLICATION_ID_HERE") {
    console.error("Error: Set a valid applicationId in config.json.");
    process.exit(1);
  }

  if (!config.applicationName) {
    console.error("Error: Set applicationName in config.json.");
    process.exit(1);
  }

  if (!Array.isArray(config.presences) || config.presences.length === 0) {
    console.error("Error: config.presences must be a non-empty array.");
    process.exit(1);
  }

  const intervalMs = Number(config.intervalMs);
  if (!Number.isFinite(intervalMs) || intervalMs < 4000) {
    console.error("Error: config.intervalMs must be a number >= 4000.");
    process.exit(1);
  }

  if (intervalMs < 5000) {
    console.warn(
      `[config] intervalMs=${intervalMs} is aggressive; 5000+ recommended (gateway limit: 5 presence updates / 20s)`,
    );
  }

  const presenceType = Number(config.presenceType ?? 0);
  if (!Number.isInteger(presenceType) || presenceType < 0 || presenceType > 5) {
    console.error("Error: config.presenceType must be an integer between 0 and 5.");
    process.exit(1);
  }

  return {
    token: config.token,
    intervalMs,
    applicationId: String(config.applicationId),
    applicationName: String(config.applicationName),
    presenceType,
    buttons: normalizeButtons(config.buttons),
    presences: config.presences.map((entry) => ({
      details: entry.details != null ? String(entry.details) : undefined,
      state: entry.state != null ? String(entry.state) : undefined,
      assets: entry.assets ?? undefined,
      buttons: normalizeButtons(entry.buttons),
    })),
  };
}

function normalizeButtons(buttons) {
  if (!Array.isArray(buttons)) {
    return undefined;
  }

  return buttons
    .slice(0, 2)
    .map((button) => ({
      label: String(button.label),
      url: String(button.url),
    }))
    .filter((button) => button.label && button.url);
}

function isSnowflake(value) {
  return /^\d{17,20}$/.test(value);
}

async function fetchAssetMap(token, applicationId) {
  const response = await fetch(
    `${API_BASE}/oauth2/applications/${applicationId}/assets`,
    { headers: { Authorization: token } },
  );

  if (!response.ok) {
    return null;
  }

  const assets = await response.json();
  const byName = new Map();
  for (const asset of assets) {
    byName.set(asset.name, asset.id);
  }
  return byName;
}

function resolveAssetField(value, assetMap) {
  if (!value) {
    return value;
  }
  if (isSnowflake(value)) {
    return value;
  }
  return assetMap?.get(value) ?? value;
}

function resolvePresenceAssets(presences, assetMap) {
  return presences.map((presence) => {
    if (!presence.assets) {
      return presence;
    }

    const assets = { ...presence.assets };
    assets.large_image = resolveAssetField(assets.large_image, assetMap);
    assets.small_image = resolveAssetField(assets.small_image, assetMap);
    return { ...presence, assets };
  });
}

async function prepareConfig(config) {
  const assetMap = await fetchAssetMap(config.token, config.applicationId);
  if (assetMap) {
    config.presences = resolvePresenceAssets(config.presences, assetMap);
    console.log(`[assets] loaded ${assetMap.size} asset(s) from Developer Portal`);
  } else {
    console.warn("[assets] could not load assets — large_image keys may not resolve to images");
  }

  try {
    const response = await fetch(`${API_BASE}/applications/${config.applicationId}/rpc`, {
      headers: { Authorization: config.token },
    });
    if (response.ok) {
      const app = await response.json();
      if (app.name && app.name !== config.applicationName) {
        console.warn(
          `[config] applicationName is "${config.applicationName}" but Portal app name is "${app.name}" — using Portal name`,
        );
        config.applicationName = app.name;
      }
    }
  } catch {
    // optional metadata fetch
  }

  return config;
}

function applyButtons(activity, buttons) {
  if (!buttons?.length) {
    return;
  }

  // Gateway: labels in buttons[], URLs in metadata.button_urls (discord.js-selfbot convention).
  activity.buttons = buttons.map((button) => button.label);
  activity.metadata = {
    button_urls: buttons.map((button) => button.url),
  };
}

function buildActivity(presence, config) {
  const activity = {
    name: config.applicationName,
    type: config.presenceType,
    application_id: config.applicationId,
    created_at: Date.now(),
  };

  if (presence.details) {
    activity.details = presence.details;
  }

  if (presence.state) {
    activity.state = presence.state;
  }

  if (presence.assets && Object.keys(presence.assets).length > 0) {
    activity.assets = presence.assets;
  }

  applyButtons(activity, presence.buttons ?? config.buttons);
  return activity;
}

function formatPresenceLog(presence) {
  const parts = [presence.details, presence.state].filter(Boolean);
  return parts.join(" | ") || "(empty)";
}

class PresenceRateLimiter {
  constructor(limit = PRESENCE_LIMIT, windowMs = PRESENCE_WINDOW_MS) {
    this.limit = limit;
    this.windowMs = windowMs;
    this.timestamps = [];
  }

  canSend() {
    this.prune();
    return this.timestamps.length < this.limit;
  }

  record() {
    this.prune();
    this.timestamps.push(Date.now());
  }

  msUntilAvailable() {
    this.prune();
    if (this.timestamps.length < this.limit) {
      return 0;
    }
    const oldest = this.timestamps[0];
    return Math.max(0, this.windowMs - (Date.now() - oldest));
  }

  prune() {
    const cutoff = Date.now() - this.windowMs;
    this.timestamps = this.timestamps.filter((ts) => ts > cutoff);
  }
}

function createGatewayClient(config, onReady) {
  let ws = null;
  let heartbeatTimer = null;
  let heartbeatDelayTimer = null;
  let rotatorTimer = null;
  let lastSequence = null;
  let sessionId = null;
  let resumeGatewayUrl = GATEWAY_URL;
  let shuttingDown = false;
  let ready = false;
  let presenceSendCount = 0;
  let presenceConfirmed = false;
  const rateLimiter = new PresenceRateLimiter();

  function send(op, data) {
    if (ws?.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ op, d: data }));
    }
  }

  function clearTimers() {
    if (heartbeatDelayTimer) {
      clearTimeout(heartbeatDelayTimer);
      heartbeatDelayTimer = null;
    }
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }
    if (rotatorTimer) {
      clearInterval(rotatorTimer);
      rotatorTimer = null;
    }
  }

  function sendPresenceUpdate(activities) {
    send(3, {
      since: 0,
      status: "online",
      afk: false,
      activities,
    });
  }

  function clearPresence() {
    sendPresenceUpdate([]);
  }

  function updatePresence(presence) {
    if (!rateLimiter.canSend()) {
      const waitMs = rateLimiter.msUntilAvailable();
      console.warn(`[presence] rate limit — waiting ${Math.ceil(waitMs / 1000)}s`);
      return false;
    }

    const activity = buildActivity(presence, config);
    sendPresenceUpdate([activity]);
    rateLimiter.record();
    presenceSendCount += 1;
    console.log(`[presence] ${formatPresenceLog(presence)}`);
    return true;
  }

  function tick() {
    if (!ready) {
      return;
    }

    updatePresence(config.presences[0]);
  }

  function startPresence() {
    if (rotatorTimer) {
      return;
    }

    tick();
  }

  function identify() {
    send(2, {
      token: config.token,
      capabilities: 1734653,
      properties: {
        $os: "Windows",
        $browser: "Discord Client",
        $device: "Discord Client",
      },
      compress: false,
      client_state: {
        guild_versions: {},
        api_code_version: 0,
      },
      presence: {
        status: "online",
        since: 0,
        afk: false,
        activities: [],
      },
    });
  }

  function resume() {
    send(6, {
      token: config.token,
      session_id: sessionId,
      seq: lastSequence,
    });
  }

  function startHeartbeat(intervalMs) {
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer);
    }
    if (heartbeatDelayTimer) {
      clearTimeout(heartbeatDelayTimer);
    }

    const jitter = Math.random();
    heartbeatDelayTimer = setTimeout(() => {
      heartbeatDelayTimer = null;
      send(1, lastSequence);
      heartbeatTimer = setInterval(() => {
        send(1, lastSequence);
      }, intervalMs);
    }, intervalMs * jitter);
  }

  function handleMessage(payload) {
    const { op, d, s, t } = payload;

    if (typeof s === "number") {
      lastSequence = s;
    }

    switch (op) {
      case 10: {
        startHeartbeat(d.heartbeat_interval);
        if (sessionId) {
          resume();
        } else {
          identify();
        }
        break;
      }
      case 11:
        break;
      case 0: {
        if (t === "READY") {
          sessionId = d.session_id;
          resumeGatewayUrl = `${d.resume_gateway_url}/?v=10&encoding=json`;
          ready = true;
          console.log(`Logged in as ${d.user.username}`);
          const sessions = Array.isArray(d.sessions) ? d.sessions : [];
          const desktopSessions = sessions.filter(
            (session) => session.client_info?.client === "desktop",
          );
          if (desktopSessions.length > 0) {
            console.warn(
              `[sessions] Discord desktop is open (${desktopSessions.length} desktop session(s)) — profile may show desktop activity instead of this script`,
            );
          }
          onReady?.();
          startPresence();
        } else if (t === "RESUMED") {
          ready = true;
          console.log("Session resumed.");
          startPresence();
        } else if (t === "SESSIONS_REPLACE") {
          const mine = d.find((session) => session.session_id === sessionId);
          if (!mine || !ready || presenceSendCount === 0) {
            break;
          }

          const count = mine.activities?.length ?? 0;
          if (count > 0) {
            if (!presenceConfirmed) {
              presenceConfirmed = true;
              console.log("[presence] confirmed on gateway session");
            }
          } else if (presenceConfirmed) {
            console.warn(
              "[presence] Discord cleared activities on this session — payload may be invalid",
            );
          }
        }
        break;
      }
      case 7: {
        console.log("Reconnect requested by gateway.");
        reconnect(resumeGatewayUrl);
        break;
      }
      case 9: {
        const resumable = d === true;
        console.log(resumable ? "Session interrupted, resuming..." : "Session invalid, re-identifying...");
        ready = false;
        if (rotatorTimer) {
          clearInterval(rotatorTimer);
          rotatorTimer = null;
        }
        if (!resumable) {
          sessionId = null;
          lastSequence = null;
          reconnect(GATEWAY_URL);
        } else {
          reconnect(resumeGatewayUrl);
        }
        break;
      }
      default:
        break;
    }
  }

  function connect(url) {
    ws = new WebSocket(url);

    ws.on("open", () => {
      console.log("Connected to Discord gateway.");
    });

    ws.on("message", (data) => {
      try {
        handleMessage(JSON.parse(data.toString()));
      } catch (err) {
        console.error("Failed to parse gateway message:", err.message);
      }
    });

    ws.on("close", (code, reason) => {
      clearTimers();
      ready = false;
      if (shuttingDown) {
        return;
      }
      console.log(`Disconnected (${code}${reason ? `: ${reason}` : ""}). Reconnecting in 5s...`);
      setTimeout(() => reconnect(resumeGatewayUrl), 5000);
    });

    ws.on("error", (err) => {
      console.error("WebSocket error:", err.message);
    });
  }

  function reconnect(url) {
    clearTimers();
    if (ws) {
      ws.removeAllListeners();
      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
        ws.close();
      }
      ws = null;
    }
    if (!shuttingDown) {
      connect(url);
    }
  }

  function shutdown() {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    console.log("\nClearing presence...");
    clearPresence();
    clearTimers();
    setTimeout(() => {
      if (ws) {
        ws.removeAllListeners();
        ws.close();
        ws = null;
      }
      process.exit(0);
    }, 750);
  }

  return {
    start() {
      process.on("SIGINT", shutdown);
      connect(GATEWAY_URL);
    },
  };
}

async function validateAssets(config) {
  const entriesWithAssets = config.presences.filter((p) => p.assets?.large_image || p.assets?.small_image);
  if (entriesWithAssets.length === 0) {
    return;
  }

  const assetMap = await fetchAssetMap(config.token, config.applicationId);
  if (!assetMap) {
    console.warn("[assets] could not fetch asset list — verify keys manually in Developer Portal");
    return;
  }

  for (const presence of entriesWithAssets) {
    for (const field of ["large_image", "small_image"]) {
      const key = presence.assets?.[field];
      if (!key) {
        continue;
      }
      if (isSnowflake(key)) {
        continue;
      }
      if (!assetMap.has(key)) {
        console.warn(`[assets] unknown asset key "${key}" — not found in Developer Portal`);
      }
    }
  }
}

let config = loadConfig();
config = await prepareConfig(config);
await validateAssets(config);

console.log(
  `[config] fixed presence, type=${config.presenceType}`,
);
console.log("[tip] Close Discord desktop/web client while this script runs, or presence will not show");
console.log("[tip] Rich Presence buttons do not open on your own profile — test from another account");

const client = createGatewayClient(config);
client.start();
