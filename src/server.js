import http from 'node:http';
import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.resolve(__dirname, '..');
const publicDir = path.join(appRoot, 'public');
const dataDir = path.join(appRoot, 'data');
const browserProfileDir = path.join(dataDir, 'chromium-profile');
const capturePath = path.join(dataDir, 'auth-capture.json');
const storageStatePath = path.join(dataDir, 'storage-state.json');
const historyPath = path.join(dataDir, 'rank-history.json');

const ENDPOINT =
  process.env.FANSLY_RANK_ENDPOINT ||
  'https://leaderboard.fansly.com/leaderboard/getActualUserRank/v1/?ngsw-bypass=true';
const LEADERBOARD_INFO_ENDPOINT =
  process.env.FANSLY_LEADERBOARD_INFO_ENDPOINT ||
  'https://leaderboard.fansly.com/leaderboard/getCurrentLeaderboard/v1/?v=1&ngsw-bypass=true';
const LOGIN_URL = process.env.FANSLY_LOGIN_URL || 'https://fansly.com/';
const HOST = process.env.HOST || '127.0.0.1';
const PORT = Number.parseInt(process.env.PORT || '8787', 10);
const POLL_MS = Number.parseInt(process.env.POLL_MS || '30000', 10);
const HISTORY_LIMIT = Number.parseInt(process.env.HISTORY_LIMIT || '30', 10);

const endpointUrl = new URL(ENDPOINT);

let browserContext;
let capturePage;
let captureState;
let pollTimer;
let pollInFlight = false;
const clients = new Set();

const appState = {
  status: 'starting',
  error: null,
  rank: null,
  movement: null,
  rankPath: null,
  testMode: false,
  testSnapshot: null,
  leaderboard: {
    key: null,
    description: null,
    startsAt: null,
    endsAt: null,
    contestRules: null,
    lastUpdatedAt: null,
    error: null
  },
  overlaySettings: {
    showHistory: true,
    showMovement: true,
    showCountdown: true
  },
  lastPollAt: null,
  nextPollAt: null,
  lastPayloadPreview: null,
  history: [],
  serverStartedAt: new Date().toISOString()
};

await ensureDataDir();
captureState = await readJson(capturePath, null);
appState.history = await readJson(historyPath, []);
if (Array.isArray(appState.history) && appState.history.length > 0) {
  const last = appState.history[appState.history.length - 1];
  appState.rank = last.rank;
  appState.movement = last.movement ?? null;
  appState.rankPath = last.rankPath ?? null;
}
appState.status = captureState ? 'ready' : 'needs-login';

const server = http.createServer(async (req, res) => {
  try {
    await handleRequest(req, res);
  } catch (error) {
    console.error(error);
    sendJson(res, 500, { ok: false, error: error.message || String(error) });
  }
});

server.listen(PORT, HOST, () => {
  const dashboardUrl = localDashboardUrl();
  console.log(`Fansly OBS overlay dashboard: ${dashboardUrl}`);
  console.log(`OBS browser source URL:        http://${HOST}:${PORT}/overlay`);
  openDashboardBrowser(dashboardUrl);
  scheduleNextPoll(POLL_MS);
  void refreshLeaderboardInfo('startup').then(broadcastState);
  broadcastState();
});

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

async function handleRequest(req, res) {
  const url = new URL(req.url || '/', `http://${req.headers.host || `${HOST}:${PORT}`}`);

  if (url.pathname === '/events') {
    return handleEvents(req, res);
  }

  if (url.pathname === '/api/state' && req.method === 'GET') {
    return sendJson(res, 200, publicState());
  }

  if (url.pathname === '/api/start-login' && req.method === 'POST') {
    await startLoginCapture();
    return sendJson(res, 200, { ok: true, state: publicState() });
  }

  if (url.pathname === '/api/poll-now' && req.method === 'POST') {
    await pollNow('manual');
    return sendJson(res, 200, { ok: true, state: publicState() });
  }

  if (url.pathname === '/api/capture-from-extension' && req.method === 'OPTIONS') {
    return sendJson(res, 204, {});
  }

  if (url.pathname === '/api/capture-from-extension' && req.method === 'POST') {
    const body = await readRequestJson(req);
    await rememberExtensionCapture(body);
    return sendJson(res, 200, { ok: true, state: publicState() });
  }

  if (url.pathname === '/api/test-mode' && req.method === 'POST') {
    const body = await readRequestJson(req);
    setTestMode(Boolean(body.enabled));
    return sendJson(res, 200, { ok: true, state: publicState() });
  }

  if (url.pathname === '/api/test-rank' && req.method === 'POST') {
    const body = await readRequestJson(req);
    const rank = Number.parseInt(body.rank, 10);
    if (!Number.isFinite(rank) || rank < 1) {
      return sendJson(res, 400, { ok: false, error: 'Rank must be a positive whole number.' });
    }
    if (!appState.testMode) {
      setTestMode(true, { broadcast: false });
    }
    recordTestRank(rank);
    broadcastState();
    return sendJson(res, 200, { ok: true, state: publicState() });
  }

  if (url.pathname === '/api/overlay-settings' && req.method === 'POST') {
    const body = await readRequestJson(req);
    if (typeof body.showHistory === 'boolean') {
      appState.overlaySettings.showHistory = body.showHistory;
    }
    if (typeof body.showMovement === 'boolean') {
      appState.overlaySettings.showMovement = body.showMovement;
    }
    if (typeof body.showCountdown === 'boolean') {
      appState.overlaySettings.showCountdown = body.showCountdown;
    }
    broadcastState();
    return sendJson(res, 200, { ok: true, state: publicState() });
  }

  if (url.pathname === '/api/clear-history' && req.method === 'POST') {
    await clearHistory();
    return sendJson(res, 200, { ok: true, state: publicState() });
  }

  if (url.pathname === '/api/reset-auth' && req.method === 'POST') {
    await resetAuth();
    return sendJson(res, 200, { ok: true, state: publicState() });
  }

  if (req.method === 'GET') {
    return serveStatic(url.pathname, res);
  }

  sendJson(res, 404, { ok: false, error: 'Not found' });
}

async function startLoginCapture() {
  appState.status = 'opening-login';
  appState.error = null;
  broadcastState();

  if (!browserContext) {
    browserContext = await chromium.launchPersistentContext(browserProfileDir, {
      headless: process.env.LOGIN_HEADLESS === '1',
      viewport: { width: 1280, height: 900 },
      locale: 'en-US'
    });
    attachCaptureListeners(browserContext);
  }

  capturePage = browserContext.pages()[0] || (await browserContext.newPage());
  await capturePage.goto(LOGIN_URL, { waitUntil: 'domcontentloaded' });
  appState.status = captureState ? 'ready' : 'waiting-for-login';
  broadcastState();
}

function attachCaptureListeners(context) {
  context.on('requestfinished', async request => {
    try {
      if (!isRankEndpoint(request.url())) {
        return;
      }
      await rememberAuthenticatedRequest(request);
    } catch (error) {
      appState.status = 'capture-error';
      appState.error = `Could not capture leaderboard headers: ${error.message || error}`;
      broadcastState();
    }
  });
}

async function rememberAuthenticatedRequest(request) {
  const response = await request.response();
  const requestHeaders = await request.allHeaders();
  const responseHeaders = response ? await response.allHeaders() : {};
  let payload = null;

  if (response) {
    try {
      payload = await response.json();
    } catch {
      payload = null;
    }
  }

  captureState = {
    source: 'playwright',
    capturedAt: new Date().toISOString(),
    url: request.url(),
    method: request.method(),
    headers: requestHeaders,
    responseHeaders,
    status: response?.status() ?? null,
    postData: request.method() === 'GET' ? null : request.postData()
  };

  if (browserContext) {
    await browserContext.storageState({ path: storageStatePath });
  }

  await writeJson(capturePath, captureState);

  const extracted = extractRank(payload);
  if (!appState.testMode && extracted.rank != null) {
    await recordRank(extracted.rank, extracted.path, payload, 'capture');
    appState.status = 'ready';
  } else if (appState.testMode) {
    appState.status = 'test-mode';
  } else {
    appState.status = 'captured';
  }
  appState.error = null;
  broadcastState();
  await pollNow('capture');
}

async function rememberExtensionCapture(body) {
  if (!body || !isRankEndpoint(body.url || '')) {
    throw new Error('Extension capture did not include the Fansly rank endpoint.');
  }

  captureState = {
    source: 'browser-extension',
    capturedAt: new Date().toISOString(),
    url: body.url,
    method: body.method || 'GET',
    headers: normalizeHeaderInput(body.headers || body.requestHeaders || {}),
    responseHeaders: normalizeHeaderInput(body.responseHeaders || {}),
    status: body.statusCode ?? null,
    postData: body.postData || null
  };

  await writeJson(capturePath, captureState);
  appState.status = appState.testMode ? 'test-mode' : 'captured';
  appState.error = null;
  broadcastState();
  await pollNow('extension-capture');
}

async function pollNow(reason = 'timer') {
  if (pollInFlight) {
    return;
  }

  await refreshLeaderboardInfo(reason);

  if (appState.testMode) {
    appState.status = 'test-mode';
    appState.error = null;
    appState.nextPollAt = null;
    broadcastState();
    return;
  }

  if (!captureState) {
    appState.status = 'needs-login';
    appState.error = 'Click Start login capture, log in, then open the Fansly leaderboard so the app can capture the authenticated request.';
    scheduleNextPoll(POLL_MS);
    broadcastState();
    return;
  }

  pollInFlight = true;
  appState.status = reason === 'manual' ? 'manual-polling' : 'polling';
  appState.error = null;
  broadcastState();

  try {
    const headers = await buildReplayHeaders();
    const method = captureState.method && captureState.method !== 'GET' ? captureState.method : 'GET';
    const response = await fetch(ENDPOINT, {
      method,
      headers,
      body: method === 'GET' ? undefined : captureState.postData || undefined,
      cache: 'no-store',
      redirect: 'follow'
    });

    const text = await response.text();
    const payload = parseJson(text);
    appState.lastPayloadPreview = previewPayload(payload ?? text);

    if (!response.ok) {
      throw new Error(`Fansly rank request returned HTTP ${response.status}. ${trimForUi(text)}`);
    }

    const extracted = extractRank(payload);
    if (extracted.rank == null) {
      throw new Error('Could not find a rank value in the Fansly response. Check the payload preview in the dashboard.');
    }

    await recordRank(extracted.rank, extracted.path, payload, reason);
    appState.status = 'ready';
    appState.error = null;
  } catch (error) {
    appState.status = 'poll-error';
    appState.error = error.message || String(error);
  } finally {
    appState.lastPollAt = new Date().toISOString();
    pollInFlight = false;
    scheduleNextPoll(POLL_MS);
    broadcastState();
  }
}

async function refreshLeaderboardInfo() {
  try {
    const headers = await buildLeaderboardInfoHeaders();
    const response = await fetch(LEADERBOARD_INFO_ENDPOINT, {
      method: 'GET',
      headers,
      cache: 'no-store',
      redirect: 'follow'
    });
    const text = await response.text();
    const payload = parseJson(text);

    if (!response.ok) {
      throw new Error(`Fansly leaderboard info returned HTTP ${response.status}. ${trimForUi(text)}`);
    }

    const info = extractLeaderboardInfo(payload);
    if (!info.endsAt) {
      throw new Error('Could not find leaderboard ends_at in the Fansly response.');
    }

    appState.leaderboard = {
      ...appState.leaderboard,
      ...info,
      lastUpdatedAt: new Date().toISOString(),
      error: null
    };
  } catch (error) {
    appState.leaderboard = {
      ...appState.leaderboard,
      lastUpdatedAt: new Date().toISOString(),
      error: error.message || String(error)
    };
  }
}

async function buildReplayHeaders() {
  const blocked = new Set([
    'accept-encoding',
    'connection',
    'content-length',
    'host',
    'keep-alive',
    'proxy-authenticate',
    'proxy-authorization',
    'te',
    'trailer',
    'transfer-encoding',
    'upgrade'
  ]);

  const headers = {};
  for (const [name, value] of Object.entries(captureState.headers || {})) {
    const lower = name.toLowerCase();
    if (lower.startsWith(':') || blocked.has(lower) || value == null) {
      continue;
    }
    headers[name] = String(value);
  }

  if (!hasHeader(headers, 'cookie')) {
    const cookieHeader = await buildCookieHeader();
    if (cookieHeader) {
      headers.cookie = cookieHeader;
    }
  }

  headers['cache-control'] = 'no-cache';
  headers.pragma = 'no-cache';
  return headers;
}

async function buildLeaderboardInfoHeaders() {
  const headers = captureState ? await buildReplayHeaders() : {};
  if (!hasHeader(headers, 'accept')) {
    headers.accept = 'application/json, text/plain, */*';
  }
  headers['cache-control'] = 'no-cache';
  headers.pragma = 'no-cache';
  return headers;
}

async function buildCookieHeader() {
  const state = await readJson(storageStatePath, null);
  if (!state || !Array.isArray(state.cookies)) {
    return '';
  }

  const nowSeconds = Math.floor(Date.now() / 1000);
  return state.cookies
    .filter(cookie => cookie.name && cookie.value)
    .filter(cookie => !cookie.expires || cookie.expires < 0 || cookie.expires > nowSeconds)
    .filter(cookie => cookieMatchesHost(cookie.domain, endpointUrl.hostname))
    .map(cookie => `${cookie.name}=${cookie.value}`)
    .join('; ');
}

function cookieMatchesHost(cookieDomain = '', host = '') {
  const normalized = cookieDomain.replace(/^\./, '').toLowerCase();
  const normalizedHost = host.toLowerCase();
  return normalizedHost === normalized || normalizedHost.endsWith(`.${normalized}`);
}

function hasHeader(headers, target) {
  return Object.keys(headers).some(name => name.toLowerCase() === target.toLowerCase());
}

async function recordRank(rank, rankPath, payload, source) {
  const normalizedRank = Number.parseInt(rank, 10);
  const previous = appState.history[appState.history.length - 1];
  const movement = previous ? previous.rank - normalizedRank : 0;
  const entry = {
    at: new Date().toISOString(),
    rank: normalizedRank,
    movement,
    rankPath,
    source
  };

  appState.rank = normalizedRank;
  appState.movement = movement;
  appState.rankPath = rankPath;
  appState.lastPayloadPreview = previewPayload(payload);
  appState.history = [...appState.history, entry].slice(-HISTORY_LIMIT);
  await writeJson(historyPath, appState.history);
}

function recordTestRank(rank) {
  const normalizedRank = Number.parseInt(rank, 10);
  const previous = appState.history[appState.history.length - 1];
  const movement = previous ? previous.rank - normalizedRank : 0;
  const entry = {
    at: new Date().toISOString(),
    rank: normalizedRank,
    movement,
    rankPath: 'test.rank',
    source: 'test'
  };

  appState.rank = normalizedRank;
  appState.movement = movement;
  appState.rankPath = 'test.rank';
  appState.lastPayloadPreview = JSON.stringify({ testRank: normalizedRank });
  appState.history = [...appState.history, entry].slice(-HISTORY_LIMIT);
  appState.status = 'test-mode';
  appState.error = null;
  appState.nextPollAt = null;
}

function extractRank(value) {
  const candidates = [];
  const seen = new Set();

  function walk(node, pathParts = []) {
    if (node == null || seen.has(node)) {
      return;
    }

    if (typeof node === 'object') {
      seen.add(node);
    }

    if (Array.isArray(node)) {
      node.slice(0, 50).forEach((item, index) => walk(item, [...pathParts, `[${index}]`]));
      return;
    }

    if (typeof node !== 'object') {
      return;
    }

    for (const [key, child] of Object.entries(node)) {
      const path = [...pathParts, key];
      const valueNumber = numberFromRankField(key, child);
      if (valueNumber != null) {
        candidates.push({
          rank: valueNumber,
          path: path.join('.').replace(/\.\[/g, '['),
          score: rankKeyScore(key)
        });
      }
      walk(child, path);
    }
  }

  walk(value);
  candidates.sort((a, b) => b.score - a.score || a.path.length - b.path.length);
  return candidates[0] || { rank: null, path: null };
}

function extractLeaderboardInfo(value) {
  const leaderboard = value?.response?.leaderboard || value?.leaderboard || {};
  return {
    key: typeof leaderboard.key === 'string' ? leaderboard.key : null,
    description: typeof leaderboard.description === 'string' ? leaderboard.description : null,
    startsAt: normalizeFanslyDate(leaderboard.start_at),
    endsAt: normalizeFanslyDate(leaderboard.ends_at),
    contestRules: typeof leaderboard.contest_rules === 'string' ? leaderboard.contest_rules : null
  };
}

function normalizeFanslyDate(value) {
  if (typeof value !== 'string' || !value.trim()) {
    return null;
  }

  const normalized = value.includes('T') ? value.trim() : value.trim().replace(' ', 'T');
  const date = new Date(normalized);
  if (Number.isNaN(date.getTime())) {
    return null;
  }
  return date.toISOString();
}

function numberFromRankField(key, value) {
  if (!isRankLikeKey(key)) {
    return null;
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    return Math.trunc(value);
  }
  if (typeof value === 'string' && /^\s*\d+\s*$/.test(value)) {
    return Number.parseInt(value, 10);
  }
  return null;
}

function isRankLikeKey(key) {
  const lower = key.toLowerCase();
  return (
    lower === 'rank' ||
    lower === 'actualrank' ||
    lower === 'userrank' ||
    lower === 'currentrank' ||
    lower === 'position' ||
    lower === 'place' ||
    lower.endsWith('rank')
  );
}

function rankKeyScore(key) {
  const lower = key.toLowerCase();
  if (lower === 'actualrank') return 100;
  if (lower === 'userrank') return 95;
  if (lower === 'currentrank') return 90;
  if (lower === 'rank') return 85;
  if (lower.endsWith('rank')) return 75;
  if (lower === 'position') return 55;
  if (lower === 'place') return 50;
  return 10;
}

function isRankEndpoint(url) {
  try {
    const parsed = new URL(url);
    return parsed.hostname === endpointUrl.hostname && parsed.pathname === endpointUrl.pathname;
  } catch {
    return false;
  }
}

function scheduleNextPoll(delay) {
  if (pollTimer) {
    clearTimeout(pollTimer);
  }
  appState.nextPollAt = new Date(Date.now() + delay).toISOString();
  pollTimer = setTimeout(() => pollNow('timer'), delay);
}

async function resetAuth() {
  if (browserContext) {
    await browserContext.close();
    browserContext = null;
    capturePage = null;
  }

  captureState = null;
  appState.testMode = false;
  appState.testSnapshot = null;
  await removeIfExists(capturePath);
  await removeIfExists(storageStatePath);
  appState.status = 'needs-login';
  appState.error = null;
  appState.rank = null;
  appState.movement = null;
  appState.rankPath = null;
  appState.lastPollAt = null;
  appState.lastPayloadPreview = null;
  appState.history = [];
  await writeJson(historyPath, appState.history);
  scheduleNextPoll(POLL_MS);
  broadcastState();
}

async function clearHistory() {
  if (appState.testMode) {
    appState.rank = null;
    appState.movement = null;
    appState.rankPath = null;
    appState.lastPayloadPreview = null;
    appState.history = [];
    appState.status = 'test-mode';
    appState.error = null;
    appState.nextPollAt = null;
    broadcastState();
    return;
  }

  appState.rank = null;
  appState.movement = null;
  appState.rankPath = null;
  appState.lastPayloadPreview = null;
  appState.history = [];
  await writeJson(historyPath, appState.history);
  appState.status = captureState ? 'ready' : 'needs-login';
  appState.error = captureState
    ? null
    : 'Click Start login capture, log in, then open the Fansly leaderboard so the app can capture the authenticated request.';
  broadcastState();
}

function handleEvents(req, res) {
  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no'
  });
  res.write(`event: state\ndata: ${JSON.stringify(publicState())}\n\n`);
  clients.add(res);
  req.on('close', () => clients.delete(res));
}

function broadcastState() {
  const payload = `event: state\ndata: ${JSON.stringify(publicState())}\n\n`;
  for (const client of clients) {
    client.write(payload);
  }
}

function publicState() {
  return {
    ok: true,
    endpoint: ENDPOINT,
    leaderboardInfoEndpoint: LEADERBOARD_INFO_ENDPOINT,
    loginUrl: LOGIN_URL,
    pollMs: POLL_MS,
    status: appState.status,
    error: appState.error,
    testMode: appState.testMode,
    leaderboard: appState.leaderboard,
    overlaySettings: appState.overlaySettings,
    rank: appState.rank,
    movement: appState.movement,
    rankPath: appState.rankPath,
    lastPollAt: appState.lastPollAt,
    nextPollAt: appState.nextPollAt,
    lastPayloadPreview: appState.lastPayloadPreview,
    history: appState.history,
    serverStartedAt: appState.serverStartedAt,
    capture: captureState
      ? {
          source: captureState.source || 'unknown',
          capturedAt: captureState.capturedAt,
          url: captureState.url,
          method: captureState.method,
          status: captureState.status,
          requestHeaderNames: Object.keys(captureState.headers || {}).sort(),
          responseHeaderNames: Object.keys(captureState.responseHeaders || {}).sort()
        }
      : null
  };
}

function setTestMode(enabled, options = {}) {
  const shouldBroadcast = options.broadcast !== false;

  if (enabled && !appState.testMode) {
    appState.testSnapshot = snapshotDisplayState();
    appState.testMode = true;
    appState.status = 'test-mode';
    appState.error = null;
    appState.nextPollAt = null;
    if (pollTimer) {
      clearTimeout(pollTimer);
      pollTimer = null;
    }
  }

  if (!enabled && appState.testMode) {
    const snapshot = appState.testSnapshot;
    appState.testMode = false;
    appState.testSnapshot = null;
    if (snapshot) {
      restoreDisplayState(snapshot);
    }
    appState.status = captureState ? 'ready' : 'needs-login';
    appState.error = captureState
      ? null
      : 'Click Start login capture, log in, then open the Fansly leaderboard so the app can capture the authenticated request.';
    scheduleNextPoll(POLL_MS);
  }

  if (shouldBroadcast) {
    broadcastState();
  }
}

function snapshotDisplayState() {
  return {
    rank: appState.rank,
    movement: appState.movement,
    rankPath: appState.rankPath,
    lastPayloadPreview: appState.lastPayloadPreview,
    history: [...appState.history]
  };
}

function restoreDisplayState(snapshot) {
  appState.rank = snapshot.rank ?? null;
  appState.movement = snapshot.movement ?? null;
  appState.rankPath = snapshot.rankPath ?? null;
  appState.lastPayloadPreview = snapshot.lastPayloadPreview ?? null;
  appState.history = Array.isArray(snapshot.history) ? snapshot.history : [];
}

async function serveStatic(requestPath, res) {
  const aliases = {
    '/': '/dashboard.html',
    '/dashboard': '/dashboard.html',
    '/overlay': '/overlay.html',
    '/obs': '/overlay.html',
    '/preview': '/overlay.html'
  };
  const normalizedPath = aliases[requestPath] || requestPath;
  const resolved = path.normalize(path.join(publicDir, normalizedPath));

  if (!resolved.startsWith(publicDir)) {
    res.writeHead(403);
    return res.end('Forbidden');
  }

  try {
    const stats = await fs.stat(resolved);
    const filePath = stats.isDirectory() ? path.join(resolved, 'index.html') : resolved;
    const file = await fs.readFile(filePath);
    res.writeHead(200, {
      'content-type': contentType(filePath),
      'cache-control': 'no-cache'
    });
    res.end(file);
  } catch {
    res.writeHead(404);
    res.end('Not found');
  }
}

function contentType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  return (
    {
      '.html': 'text/html; charset=utf-8',
      '.css': 'text/css; charset=utf-8',
      '.js': 'text/javascript; charset=utf-8',
      '.json': 'application/json; charset=utf-8',
      '.svg': 'image/svg+xml'
    }[ext] || 'application/octet-stream'
  );
}

function sendJson(res, status, body) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-cache',
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'GET, POST, OPTIONS',
    'access-control-allow-headers': 'content-type'
  });
  res.end(JSON.stringify(body));
}

async function readRequestJson(req) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(chunk);
  }

  const text = Buffer.concat(chunks).toString('utf8').trim();
  if (!text) {
    return {};
  }

  try {
    return JSON.parse(text);
  } catch {
    return {};
  }
}

function normalizeHeaderInput(input) {
  if (Array.isArray(input)) {
    const headers = {};
    for (const item of input) {
      if (!item || !item.name || item.value == null) {
        continue;
      }
      headers[item.name] = String(item.value);
    }
    return headers;
  }

  if (input && typeof input === 'object') {
    const headers = {};
    for (const [name, value] of Object.entries(input)) {
      if (value == null) {
        continue;
      }
      headers[name] = Array.isArray(value) ? value.join('; ') : String(value);
    }
    return headers;
  }

  return {};
}

async function ensureDataDir() {
  await fs.mkdir(dataDir, { recursive: true });
}

async function readJson(filePath, fallback) {
  try {
    return JSON.parse(await fs.readFile(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

async function writeJson(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

async function removeIfExists(filePath) {
  try {
    await fs.rm(filePath, { force: true });
  } catch {
    // Ignore missing local app state.
  }
}

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function previewPayload(payload) {
  if (payload == null) {
    return null;
  }
  return trimForUi(JSON.stringify(payload));
}

function trimForUi(value) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  return text.length > 700 ? `${text.slice(0, 700)}...` : text;
}

async function shutdown() {
  if (pollTimer) {
    clearTimeout(pollTimer);
  }
  for (const client of clients) {
    client.end();
  }
  if (browserContext) {
    await browserContext.close();
  }
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1000).unref();
}

function localDashboardUrl() {
  const localHost = HOST === '0.0.0.0' || HOST === '::' ? '127.0.0.1' : HOST;
  return `http://${localHost}:${PORT}/`;
}

function openDashboardBrowser(url) {
  if (process.env.NO_OPEN === '1' || process.env.OPEN_DASHBOARD === '0') {
    return;
  }

  try {
    const command =
      process.platform === 'win32'
        ? { file: 'cmd', args: ['/c', 'start', '', url] }
        : process.platform === 'darwin'
          ? { file: 'open', args: [url] }
          : { file: 'xdg-open', args: [url] };

    const child = spawn(command.file, command.args, {
      detached: true,
      stdio: 'ignore',
      windowsHide: true
    });
    child.unref();
  } catch (error) {
    console.warn(`Could not open dashboard automatically: ${error.message || error}`);
  }
}
