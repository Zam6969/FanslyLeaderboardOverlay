import http from 'node:http';
import { execFile, spawn } from 'node:child_process';
import {
  createCipheriv,
  createDecipheriv,
  pbkdf2Sync,
  randomBytes
} from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const execFileAsync = promisify(execFile);
const appRoot = path.resolve(__dirname, '..');
const publicDir = path.join(appRoot, 'public');
const dataDir = path.join(appRoot, 'data');
const browserProfileDir = path.join(dataDir, 'chromium-profile');
const capturePath = path.join(dataDir, 'auth-capture.json');
const storageStatePath = path.join(dataDir, 'storage-state.json');
const historyPath = path.join(dataDir, 'rank-history.json');
const overlaySettingsPath = path.join(dataDir, 'overlay-settings.json');
const encryptionKeyPath = path.join(dataDir, 'encryption-key.json');

const ENDPOINT =
  process.env.FANSLY_RANK_ENDPOINT ||
  'https://leaderboard.fansly.com/leaderboard/getActualUserRank/v1/?ngsw-bypass=true';
const LEADERBOARD_INFO_ENDPOINT =
  process.env.FANSLY_LEADERBOARD_INFO_ENDPOINT ||
  'https://leaderboard.fansly.com/leaderboard/getCurrentLeaderboard/v1/?v=1&ngsw-bypass=true';
const ACCOUNT_ME_ENDPOINT =
  process.env.FANSLY_ACCOUNT_ME_ENDPOINT ||
  'https://apiv3.fansly.com/api/v1/account/me?ngsw-bypass=true';
const STREAM_CHANNEL_ENDPOINT =
  process.env.FANSLY_STREAM_CHANNEL_ENDPOINT ||
  'https://apiv3.fansly.com/api/v1/streaming/channel/{ID}?ngsw-bypass=true';
const LOGIN_URL = process.env.FANSLY_LOGIN_URL || 'https://fansly.com/';
const HOST = process.env.HOST || '127.0.0.1';
const PORT = Number.parseInt(process.env.PORT || '8787', 10);
const POLL_MS = Number.parseInt(process.env.POLL_MS || '30000', 10);
const STREAM_POLL_MS = Number.parseInt(process.env.STREAM_POLL_MS || '180000', 10);
const HISTORY_LIMIT = Number.parseInt(process.env.HISTORY_LIMIT || '720', 10);
const ENCRYPTED_JSON_FORMAT = 'fansly-obs-overlay/encrypted-json-v1';
const ENCRYPTION_KEY_FORMAT = 'fansly-obs-overlay/encryption-key-v1';
const DATA_ENCRYPTION_ALGORITHM = 'aes-256-gcm';
const PASSPHRASE_KDF_ITERATIONS = 210000;
const SESSION_EXPIRED_MESSAGE = 'Fansly login expired. Click Start login capture and log in again.';
const OVERLAY_APPEARANCE_MODES = new Set(['classic', 'pill', 'neon', 'logo', 'compact', 'pop']);
const OVERLAY_MOVEMENT_RANGES = new Set(['last-change', 'last-hour', 'stream']);
const OVERLAY_POP_VARIANTS = new Set(['default', 'pill', 'logo']);

const endpointUrl = new URL(ENDPOINT);
const DEFAULT_OVERLAY_SETTINGS = Object.freeze({
  showHistory: true,
  showMovement: true,
  showCountdown: true,
  movementRange: 'stream',
  appearanceMode: 'classic',
  popVariant: 'default',
  widthScale: 1,
  title: 'Fansly Leaderboard Rank',
  theme: {
    gradientA: '#59e0aa',
    gradientB: '#6bd3ff',
    shine: '#ffffff'
  }
});

let browserContext;
let capturePage;
let captureState;
let pollTimer;
let streamTimer;
let pollInFlight = false;
let streamPollInFlight = false;
const clients = new Set();
let encryptionKeyPromise;

const appState = {
  status: 'starting',
  error: null,
  rank: null,
  movement: null,
  rankPath: null,
  testMode: false,
  testSnapshot: null,
  sessionExpiredAt: null,
  sessionExpiredReason: null,
  leaderboard: {
    key: null,
    description: null,
    startsAt: null,
    endsAt: null,
    contestRules: null,
    lastUpdatedAt: null,
    error: null
  },
  stream: createDefaultStreamState(),
  overlaySettings: createDefaultOverlaySettings(),
  lastPollAt: null,
  nextPollAt: null,
  lastPayloadPreview: null,
  history: [],
  serverStartedAt: new Date().toISOString()
};

await ensureDataDir();
await migrateLegacyJsonFiles();
captureState = await readJson(capturePath, null);
appState.history = await readJson(historyPath, []);
appState.overlaySettings = mergeOverlaySettings(await readJson(overlaySettingsPath, null));
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
  scheduleNextStreamPoll(1500);
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

  if (url.pathname === '/api/open-browser-login' && req.method === 'POST') {
    const body = await readRequestJson(req);
    if (!body.openedFromDashboard) {
      openExternalBrowser(LOGIN_URL);
    }
    appState.status = captureState ? 'ready' : 'waiting-for-login';
    appState.error = null;
    broadcastState();
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
    appState.overlaySettings = mergeOverlaySettings(body, appState.overlaySettings);
    broadcastState();
    try {
      await writeJson(overlaySettingsPath, appState.overlaySettings);
    } catch (error) {
      console.warn(`Could not save overlay settings: ${error.message || error}`);
      return sendJson(res, 200, {
        ok: true,
        warning: 'Overlay settings applied for this session, but could not be saved locally.',
        state: publicState()
      });
    }
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
  const wasSessionExpired = isSessionExpired();
  clearSessionExpired();
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
  appState.status = captureState && !wasSessionExpired ? 'ready' : 'waiting-for-login';
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
    await writeJson(storageStatePath, await browserContext.storageState());
  }

  await writeJson(capturePath, captureState);

  const extracted = extractRank(payload);
  if (!appState.testMode && extracted.rank != null) {
    await recordRank(extracted.rank, extracted.path, payload, 'capture');
    appState.status = 'ready';
    clearSessionExpired();
  } else if (appState.testMode) {
    appState.status = 'test-mode';
  } else {
    appState.status = 'captured';
  }
  appState.error = null;
  broadcastState();
  await pollNow('capture');
  void refreshStreamStatus('capture').then(broadcastState);
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
  clearSessionExpired();
  broadcastState();
  await pollNow('extension-capture');
  void refreshStreamStatus('extension-capture').then(broadcastState);
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

    if (isSessionExpiredResponse(response.status, text, payload)) {
      markSessionExpired(sessionExpiredReason(response.status, text));
      return;
    }

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
    clearSessionExpired();
  } catch (error) {
    appState.status = 'poll-error';
    appState.error = error.message || String(error);
  } finally {
    appState.lastPollAt = new Date().toISOString();
    pollInFlight = false;
    if (appState.status === 'session-expired') {
      appState.nextPollAt = null;
      if (pollTimer) {
        clearTimeout(pollTimer);
        pollTimer = null;
      }
    } else {
      scheduleNextPoll(POLL_MS);
    }
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

async function refreshStreamStatus(reason = 'timer') {
  if (streamPollInFlight || appState.testMode) {
    if (reason === 'timer') {
      scheduleNextStreamPoll(STREAM_POLL_MS);
    }
    return;
  }

  if (!captureState) {
    appState.stream = {
      ...appState.stream,
      lastUpdatedAt: new Date().toISOString(),
      error: 'Waiting for captured Fansly auth.'
    };
    if (reason === 'timer') {
      scheduleNextStreamPoll(STREAM_POLL_MS);
    }
    return;
  }

  streamPollInFlight = true;
  try {
    const accountId = appState.stream.accountId || (await fetchAccountId());
    const streamPayload = await fetchFanslyJson(streamChannelUrl(accountId), 'Fansly stream status');
    appState.stream = preserveStreamMovementBaseline({
      ...extractStreamInfo(streamPayload, accountId),
      lastUpdatedAt: new Date().toISOString(),
      error: null
    });
    rememberStreamMovementBaseline();
  } catch (error) {
    appState.stream = {
      ...appState.stream,
      lastUpdatedAt: new Date().toISOString(),
      error: error.message || String(error)
    };
  } finally {
    streamPollInFlight = false;
    if (reason !== 'manual') {
      scheduleNextStreamPoll(STREAM_POLL_MS);
    }
  }
}

async function fetchAccountId() {
  const payload = await fetchFanslyJson(ACCOUNT_ME_ENDPOINT, 'Fansly account');
  const accountId = payload?.response?.account?.id || payload?.account?.id;
  if (typeof accountId !== 'string' || !accountId.trim()) {
    throw new Error('Could not find account.id in the Fansly account response.');
  }
  return accountId.trim();
}

async function fetchFanslyJson(url, label) {
  const response = await fetch(url, {
    method: 'GET',
    headers: await buildFanslyApiHeaders(url),
    cache: 'no-store',
    redirect: 'follow'
  });
  const text = await response.text();
  const payload = parseJson(text);

  if (isSessionExpiredResponse(response.status, text, payload)) {
    markSessionExpired(sessionExpiredReason(response.status, text));
    throw new Error(SESSION_EXPIRED_MESSAGE);
  }

  if (!response.ok) {
    throw new Error(`${label} returned HTTP ${response.status}. ${trimForUi(text)}`);
  }

  return payload;
}

function streamChannelUrl(accountId) {
  return STREAM_CHANNEL_ENDPOINT.replace('{ID}', encodeURIComponent(accountId)).replace('{id}', encodeURIComponent(accountId));
}

function isSessionExpired() {
  return appState.status === 'session-expired' || Boolean(appState.sessionExpiredAt);
}

function markSessionExpired(reason) {
  appState.status = 'session-expired';
  appState.error = SESSION_EXPIRED_MESSAGE;
  appState.sessionExpiredAt = new Date().toISOString();
  appState.sessionExpiredReason = trimForUi(reason || SESSION_EXPIRED_MESSAGE, 180);
}

function clearSessionExpired() {
  appState.sessionExpiredAt = null;
  appState.sessionExpiredReason = null;
}

function isSessionExpiredResponse(status, text, payload) {
  if ([401, 403, 419, 440].includes(status)) {
    return true;
  }

  const body = typeof text === 'string' ? text : JSON.stringify(payload || '');
  return bodyLooksLikeSessionExpired(body);
}

function sessionExpiredReason(status, text) {
  const detail = trimForUi(text, 220);
  if ([401, 403, 419, 440].includes(status)) {
    return detail ? `Fansly returned HTTP ${status}. ${detail}` : `Fansly returned HTTP ${status}.`;
  }
  return detail || SESSION_EXPIRED_MESSAGE;
}

function bodyLooksLikeSessionExpired(value) {
  const text = String(value || '').toLowerCase();
  if (!text) {
    return false;
  }

  const hasAuthWord =
    text.includes('unauthorized') ||
    text.includes('forbidden') ||
    text.includes('not authenticated') ||
    text.includes('authentication') ||
    text.includes('authorization') ||
    text.includes('login') ||
    text.includes('sign in') ||
    text.includes('session') ||
    text.includes('token');
  const hasExpiredWord =
    text.includes('expired') ||
    text.includes('invalid') ||
    text.includes('required') ||
    text.includes('missing') ||
    text.includes('denied');

  return hasAuthWord && hasExpiredWord;
}

async function buildReplayHeaders(targetUrl = ENDPOINT) {
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

  const hostname = safeHostname(targetUrl) || endpointUrl.hostname;
  if (!hasHeader(headers, 'cookie')) {
    const cookieHeader = await buildCookieHeader(hostname);
    if (cookieHeader) {
      headers.cookie = cookieHeader;
    }
  }

  headers['cache-control'] = 'no-cache';
  headers.pragma = 'no-cache';
  return headers;
}

async function buildLeaderboardInfoHeaders() {
  const headers = captureState ? await buildReplayHeaders(LEADERBOARD_INFO_ENDPOINT) : {};
  if (!hasHeader(headers, 'accept')) {
    headers.accept = 'application/json, text/plain, */*';
  }
  headers['cache-control'] = 'no-cache';
  headers.pragma = 'no-cache';
  return headers;
}

async function buildFanslyApiHeaders(url) {
  const headers = captureState ? await buildReplayHeaders(url) : {};
  if (!hasHeader(headers, 'accept')) {
    headers.accept = 'application/json, text/plain, */*';
  }
  headers['cache-control'] = 'no-cache';
  headers.pragma = 'no-cache';
  return headers;
}

async function buildCookieHeader(hostname = endpointUrl.hostname) {
  const state = await readJson(storageStatePath, null);
  if (!state || !Array.isArray(state.cookies)) {
    return '';
  }

  const nowSeconds = Math.floor(Date.now() / 1000);
  return state.cookies
    .filter(cookie => cookie.name && cookie.value)
    .filter(cookie => !cookie.expires || cookie.expires < 0 || cookie.expires > nowSeconds)
    .filter(cookie => cookieMatchesHost(cookie.domain, hostname))
    .map(cookie => `${cookie.name}=${cookie.value}`)
    .join('; ');
}

function safeHostname(value) {
  try {
    return new URL(value).hostname;
  } catch {
    return null;
  }
}

function cookieMatchesHost(cookieDomain = '', host = '') {
  const normalized = cookieDomain.replace(/^\./, '').toLowerCase();
  const normalizedHost = host.toLowerCase();
  return normalizedHost === normalized || normalizedHost.endsWith(`.${normalized}`);
}

function hasHeader(headers, target) {
  return Object.keys(headers).some(name => name.toLowerCase() === target.toLowerCase());
}

function createDefaultOverlaySettings() {
  return {
    ...DEFAULT_OVERLAY_SETTINGS,
    theme: { ...DEFAULT_OVERLAY_SETTINGS.theme }
  };
}

function createDefaultStreamState() {
  return {
    accountId: null,
    channelId: null,
    streamId: null,
    status: null,
    channelStatus: null,
    streamStatus: null,
    isLive: false,
    title: null,
    viewerCount: null,
    startedAt: null,
    createdAt: null,
    lastFetchedAt: null,
    movementBaselineStartedAt: null,
    movementBaselineRank: null,
    movementBaselineAt: null,
    lastUpdatedAt: null,
    error: null
  };
}

function mergeOverlaySettings(input, base = createDefaultOverlaySettings()) {
  const next = {
    ...createDefaultOverlaySettings(),
    ...(base && typeof base === 'object' ? base : {}),
    theme: {
      ...DEFAULT_OVERLAY_SETTINGS.theme,
      ...(base?.theme && typeof base.theme === 'object' ? base.theme : {})
    }
  };

  if (!input || typeof input !== 'object') {
    next.appearanceMode = sanitizeOverlayAppearanceMode(next.appearanceMode, DEFAULT_OVERLAY_SETTINGS.appearanceMode);
    next.movementRange = sanitizeOverlayMovementRange(next.movementRange, DEFAULT_OVERLAY_SETTINGS.movementRange);
    next.popVariant = sanitizeOverlayPopVariant(next.popVariant, DEFAULT_OVERLAY_SETTINGS.popVariant);
    next.widthScale = sanitizeOverlayWidthScale(next.widthScale, DEFAULT_OVERLAY_SETTINGS.widthScale);
    return next;
  }

  next.appearanceMode = sanitizeOverlayAppearanceMode(next.appearanceMode, DEFAULT_OVERLAY_SETTINGS.appearanceMode);
  next.movementRange = sanitizeOverlayMovementRange(next.movementRange, DEFAULT_OVERLAY_SETTINGS.movementRange);
  next.popVariant = sanitizeOverlayPopVariant(next.popVariant, DEFAULT_OVERLAY_SETTINGS.popVariant);
  next.widthScale = sanitizeOverlayWidthScale(next.widthScale, DEFAULT_OVERLAY_SETTINGS.widthScale);

  if (typeof input.showHistory === 'boolean') {
    next.showHistory = input.showHistory;
  }
  if (typeof input.showMovement === 'boolean') {
    next.showMovement = input.showMovement;
  }
  if (typeof input.showCountdown === 'boolean') {
    next.showCountdown = input.showCountdown;
  }
  if (typeof input.movementRange === 'string') {
    next.movementRange = sanitizeOverlayMovementRange(input.movementRange, next.movementRange);
  }
  if (typeof input.appearanceMode === 'string') {
    next.appearanceMode = sanitizeOverlayAppearanceMode(input.appearanceMode, next.appearanceMode);
  }
  if (typeof input.popVariant === 'string') {
    next.popVariant = sanitizeOverlayPopVariant(input.popVariant, next.popVariant);
  }
  if (input.widthScale != null) {
    next.widthScale = sanitizeOverlayWidthScale(input.widthScale, next.widthScale);
  }
  if (typeof input.title === 'string') {
    next.title = sanitizeOverlayTitle(input.title, next.title);
  }
  if (input.resetTheme === true) {
    next.theme = { ...DEFAULT_OVERLAY_SETTINGS.theme };
  }
  if (input.theme && typeof input.theme === 'object') {
    next.theme = {
      gradientA: sanitizeHexColor(input.theme.gradientA, next.theme.gradientA),
      gradientB: sanitizeHexColor(input.theme.gradientB, next.theme.gradientB),
      shine: sanitizeHexColor(input.theme.shine, next.theme.shine)
    };
  }

  return next;
}

function sanitizeHexColor(value, fallback) {
  if (typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value.trim())) {
    return value.trim().toLowerCase();
  }
  return fallback;
}

function sanitizeOverlayAppearanceMode(value, fallback) {
  if (typeof value !== 'string') {
    return fallback;
  }
  const normalized = value.trim().toLowerCase();
  return OVERLAY_APPEARANCE_MODES.has(normalized) ? normalized : fallback;
}

function sanitizeOverlayMovementRange(value, fallback) {
  if (typeof value !== 'string') {
    return fallback;
  }
  const normalized = value.trim().toLowerCase();
  return OVERLAY_MOVEMENT_RANGES.has(normalized) ? normalized : fallback;
}

function sanitizeOverlayPopVariant(value, fallback) {
  if (typeof value !== 'string') {
    return fallback;
  }
  const normalized = value.trim().toLowerCase();
  return OVERLAY_POP_VARIANTS.has(normalized) ? normalized : fallback;
}

function sanitizeOverlayWidthScale(value, fallback) {
  const number = Number.parseFloat(value);
  if (!Number.isFinite(number)) {
    return fallback;
  }
  return Math.min(1.15, Math.max(0.65, Math.round(number * 20) / 20));
}

function sanitizeOverlayTitle(value, fallback) {
  const normalized = value.replace(/\s+/g, ' ').trim();
  if (!normalized) {
    return fallback;
  }
  return normalized.slice(0, 48);
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
  rememberStreamMovementBaseline(entry);
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

function extractStreamInfo(value, accountId) {
  const channel = value?.response || value?.channel || {};
  const stream = channel.stream || {};
  const streamStatus = numberOrNull(stream.status);
  const channelStatus = numberOrNull(channel.status);
  const effectiveStatus = streamStatus ?? channelStatus;
  const isLive = streamStatus != null ? streamStatus === 2 : channelStatus === 2;

  return {
    accountId,
    channelId: stringOrNull(channel.id),
    streamId: stringOrNull(stream.id),
    status: effectiveStatus,
    channelStatus,
    streamStatus,
    isLive,
    title: stringOrNull(stream.title),
    viewerCount: numberOrNull(stream.viewerCount),
    startedAt: normalizeFanslyTimestamp(stream.startedAt ?? stream.createdAt ?? channel.createdAt),
    createdAt: normalizeFanslyTimestamp(stream.createdAt ?? channel.createdAt),
    lastFetchedAt: normalizeFanslyTimestamp(stream.lastFetchedAt)
  };
}

function computeMovementSummary() {
  const range = sanitizeOverlayMovementRange(appState.overlaySettings.movementRange, DEFAULT_OVERLAY_SETTINGS.movementRange);
  if (range === 'last-hour') {
    return computeMovementSince(Date.now() - 60 * 60 * 1000, {
      range,
      label: 'Last hour',
      shortLabel: '1h',
      includePreviousBaseline: true
    });
  }

  if (range === 'stream') {
    if (!appState.stream.isLive || !appState.stream.startedAt) {
      return {
        range,
        value: null,
        label: appState.stream.isLive ? 'Waiting for stream rank' : 'Stream offline',
        shortLabel: appState.stream.isLive ? 'Live' : 'Offline',
        isLive: appState.stream.isLive,
        startedAt: appState.stream.startedAt,
        sampleCount: 0
      };
    }

    return computeMovementSince(new Date(appState.stream.startedAt).getTime(), {
      range,
      label: 'Since stream start',
      shortLabel: 'Live',
      includePreviousBaseline: false,
      baseline: streamMovementBaseline(),
      startedAt: appState.stream.startedAt,
      isLive: true
    });
  }

  return {
    range: 'last-change',
    value: appState.movement,
    label: 'Last change',
    shortLabel: '',
    sampleCount: appState.movement == null ? 0 : 1
  };
}

function computeMovementSince(startMs, options) {
  const history = normalizedHistoryEntries();
  const latest = history[history.length - 1];
  if (!latest || appState.rank == null || !Number.isFinite(startMs)) {
    return {
      range: options.range,
      value: null,
      label: options.label,
      shortLabel: options.shortLabel,
      sampleCount: 0,
      startedAt: options.startedAt || null,
      isLive: Boolean(options.isLive)
    };
  }

  const inWindow = history.filter(entry => entry.time >= startMs);
  const previousBaseline = options.includePreviousBaseline
    ? history.filter(entry => entry.time <= startMs).at(-1)
    : null;
  const baseline = options.baseline || previousBaseline || inWindow[0] || latest;
  const value = baseline.rank - latest.rank;

  return {
    range: options.range,
    value,
    label: options.label,
    shortLabel: options.shortLabel,
    since: new Date(startMs).toISOString(),
    baselineAt: baseline.at,
    baselineRank: baseline.rank,
    currentRank: latest.rank,
    sampleCount: inWindow.length || (baseline === latest ? 1 : 0),
    startedAt: options.startedAt || null,
    isLive: Boolean(options.isLive)
  };
}

function preserveStreamMovementBaseline(nextStream) {
  const previous = appState.stream || {};
  if (
    nextStream.isLive &&
    nextStream.startedAt &&
    previous.movementBaselineStartedAt === nextStream.startedAt &&
    previous.movementBaselineRank != null
  ) {
    return {
      ...nextStream,
      movementBaselineStartedAt: previous.movementBaselineStartedAt,
      movementBaselineRank: previous.movementBaselineRank,
      movementBaselineAt: previous.movementBaselineAt
    };
  }

  return {
    ...nextStream,
    movementBaselineStartedAt: nextStream.isLive ? nextStream.startedAt : null,
    movementBaselineRank: null,
    movementBaselineAt: null
  };
}

function rememberStreamMovementBaseline(entry = null) {
  if (!appState.stream?.isLive || !appState.stream.startedAt) {
    return;
  }

  const streamStartedAt = appState.stream.startedAt;
  if (
    appState.stream.movementBaselineStartedAt === streamStartedAt &&
    appState.stream.movementBaselineRank != null
  ) {
    return;
  }

  const startMs = new Date(streamStartedAt).getTime();
  if (!Number.isFinite(startMs)) {
    return;
  }

  const candidate =
    normalizeRankHistoryEntry(entry) ||
    normalizedHistoryEntries().find(historyEntry => historyEntry.time >= startMs);

  if (!candidate || candidate.time < startMs) {
    return;
  }

  appState.stream = {
    ...appState.stream,
    movementBaselineStartedAt: streamStartedAt,
    movementBaselineRank: candidate.rank,
    movementBaselineAt: candidate.at
  };
}

function streamMovementBaseline() {
  const rank = Number.parseInt(appState.stream?.movementBaselineRank, 10);
  const at = appState.stream?.movementBaselineAt;
  const time = new Date(at).getTime();
  if (!Number.isFinite(rank) || !Number.isFinite(time)) {
    return null;
  }
  return { rank, at, time };
}

function normalizedHistoryEntries() {
  return (Array.isArray(appState.history) ? appState.history : [])
    .map(normalizeRankHistoryEntry)
    .filter(Boolean)
    .sort((a, b) => a.time - b.time);
}

function normalizeRankHistoryEntry(entry) {
  if (!entry || typeof entry !== 'object') {
    return null;
  }
  const time = new Date(entry.at).getTime();
  const rank = Number.parseInt(entry.rank, 10);
  if (!Number.isFinite(time) || !Number.isFinite(rank)) {
    return null;
  }
  return { ...entry, rank, time };
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

function normalizeFanslyTimestamp(value) {
  if (value == null || value === '') {
    return null;
  }

  if (typeof value === 'number' && Number.isFinite(value)) {
    const millis = value > 100000000000 ? value : value * 1000;
    const date = new Date(millis);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
  }

  if (typeof value === 'string' && /^\d+$/.test(value.trim())) {
    return normalizeFanslyTimestamp(Number.parseInt(value, 10));
  }

  if (typeof value === 'string') {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
  }

  return null;
}

function stringOrNull(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function numberOrNull(value) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return Math.trunc(value);
  }
  if (typeof value === 'string' && /^-?\d+$/.test(value.trim())) {
    return Number.parseInt(value, 10);
  }
  return null;
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

function scheduleNextStreamPoll(delay) {
  if (streamTimer) {
    clearTimeout(streamTimer);
  }
  streamTimer = setTimeout(async () => {
    await refreshStreamStatus('timer');
    broadcastState();
  }, delay);
}

async function resetAuth() {
  if (browserContext) {
    await browserContext.close();
    browserContext = null;
    capturePage = null;
  }

  captureState = null;
  clearSessionExpired();
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
  appState.stream = createDefaultStreamState();
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
  appState.status = isSessionExpired() ? 'session-expired' : captureState ? 'ready' : 'needs-login';
  appState.error =
    appState.status === 'session-expired'
      ? SESSION_EXPIRED_MESSAGE
      : captureState
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
    accountEndpoint: ACCOUNT_ME_ENDPOINT,
    streamChannelEndpoint: STREAM_CHANNEL_ENDPOINT,
    loginUrl: LOGIN_URL,
    pollMs: POLL_MS,
    streamPollMs: STREAM_POLL_MS,
    status: appState.status,
    error: appState.error,
    testMode: appState.testMode,
    sessionExpiredAt: appState.sessionExpiredAt,
    sessionExpiredReason: appState.sessionExpiredReason,
    leaderboard: appState.leaderboard,
    stream: appState.stream,
    overlaySettings: appState.overlaySettings,
    rank: appState.rank,
    movement: appState.movement,
    movementSummary: computeMovementSummary(),
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
    appState.status = isSessionExpired() ? 'session-expired' : captureState ? 'ready' : 'needs-login';
    appState.error =
      appState.status === 'session-expired'
        ? SESSION_EXPIRED_MESSAGE
        : captureState
          ? null
          : 'Click Start login capture, log in, then open the Fansly leaderboard so the app can capture the authenticated request.';
    if (appState.status === 'session-expired') {
      appState.nextPollAt = null;
    } else {
      scheduleNextPoll(POLL_MS);
    }
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
      '.svg': 'image/svg+xml',
      '.webp': 'image/webp'
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
    const text = await fs.readFile(filePath, 'utf8');
    return await parseStoredJson(text);
  } catch (error) {
    if (error.code !== 'ENOENT') {
      console.warn(`Could not read local app data at ${path.basename(filePath)}: ${error.message || error}`);
    }
    return fallback;
  }
}

async function writeJson(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const encrypted = await encryptJsonValue(value);
  await fs.writeFile(filePath, `${JSON.stringify(encrypted, null, 2)}\n`, 'utf8');
}

async function removeIfExists(filePath) {
  try {
    await fs.rm(filePath, { force: true });
  } catch {
    // Ignore missing local app state.
  }
}

async function migrateLegacyJsonFiles() {
  await Promise.all([
    migrateLegacyJsonFile(capturePath),
    migrateLegacyJsonFile(storageStatePath),
    migrateLegacyJsonFile(historyPath),
    migrateLegacyJsonFile(overlaySettingsPath)
  ]);
}

async function migrateLegacyJsonFile(filePath) {
  try {
    const text = await fs.readFile(filePath, 'utf8');
    const parsed = JSON.parse(text);
    if (isEncryptedJsonEnvelope(parsed)) {
      return;
    }
    await writeJson(filePath, parsed);
  } catch (error) {
    if (error.code !== 'ENOENT') {
      console.warn(`Could not migrate local app data at ${path.basename(filePath)}: ${error.message || error}`);
    }
  }
}

async function parseStoredJson(text) {
  const parsed = JSON.parse(text);
  if (!isEncryptedJsonEnvelope(parsed)) {
    return parsed;
  }
  return decryptJsonValue(parsed);
}

function isEncryptedJsonEnvelope(value) {
  return (
    value &&
    typeof value === 'object' &&
    value.format === ENCRYPTED_JSON_FORMAT &&
    value.version === 1 &&
    value.algorithm === DATA_ENCRYPTION_ALGORITHM
  );
}

async function encryptJsonValue(value) {
  const key = await getEncryptionKey();
  const iv = randomBytes(12);
  const cipher = createCipheriv(DATA_ENCRYPTION_ALGORITHM, key, iv);
  const plaintext = Buffer.from(JSON.stringify(value, null, 2), 'utf8');
  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);

  return {
    format: ENCRYPTED_JSON_FORMAT,
    version: 1,
    algorithm: DATA_ENCRYPTION_ALGORITHM,
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    data: encrypted.toString('base64')
  };
}

async function decryptJsonValue(envelope) {
  const key = await getEncryptionKey({ create: false });
  const decipher = createDecipheriv(
    envelope.algorithm,
    key,
    Buffer.from(envelope.iv || '', 'base64')
  );
  decipher.setAuthTag(Buffer.from(envelope.tag || '', 'base64'));
  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(envelope.data || '', 'base64')),
    decipher.final()
  ]);
  return JSON.parse(decrypted.toString('utf8'));
}

async function getEncryptionKey(options = {}) {
  if (encryptionKeyPromise) {
    return encryptionKeyPromise;
  }

  const create = options.create !== false;
  const pendingKey = loadOrCreateEncryptionKey({ create });
  if (create) {
    encryptionKeyPromise = pendingKey.catch(error => {
      encryptionKeyPromise = null;
      throw error;
    });
    return encryptionKeyPromise;
  }

  const key = await pendingKey;
  encryptionKeyPromise = Promise.resolve(key);
  return key;
}

async function loadOrCreateEncryptionKey({ create }) {
  const record = await readEncryptionKeyRecord();
  if (record) {
    const key = await unwrapEncryptionKey(record);
    await maybeUpgradeEncryptionKeyRecord(record, key);
    return key;
  }

  if (!create) {
    throw new Error('Missing local encryption key. Reset auth or restore data/encryption-key.json.');
  }

  const key = randomBytes(32);
  const nextRecord = await wrapEncryptionKey(key);
  await writeEncryptionKeyRecord(nextRecord);
  return key;
}

async function maybeUpgradeEncryptionKeyRecord(record, key) {
  if (record.provider !== 'local-file') {
    return;
  }

  const upgradedRecord = await wrapEncryptionKey(key);
  if (upgradedRecord.provider !== record.provider) {
    await writeEncryptionKeyRecord(upgradedRecord);
  }
}

async function readEncryptionKeyRecord() {
  try {
    const record = JSON.parse(await fs.readFile(encryptionKeyPath, 'utf8'));
    if (record?.format !== ENCRYPTION_KEY_FORMAT || record.version !== 1) {
      throw new Error('Unsupported encryption key format.');
    }
    return record;
  } catch (error) {
    if (error.code === 'ENOENT') {
      return null;
    }
    throw error;
  }
}

async function writeEncryptionKeyRecord(record) {
  await fs.mkdir(path.dirname(encryptionKeyPath), { recursive: true });
  await fs.writeFile(encryptionKeyPath, `${JSON.stringify(record, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600
  });
  try {
    await fs.chmod(encryptionKeyPath, 0o600);
  } catch {
    // Windows may ignore POSIX file modes; DPAPI still protects the key there.
  }
}

async function wrapEncryptionKey(key) {
  const configuredSecret = configuredEncryptionSecret();
  if (configuredSecret) {
    return {
      format: ENCRYPTION_KEY_FORMAT,
      version: 1,
      provider: 'passphrase',
      createdAt: new Date().toISOString(),
      ...encryptKeyWithSecret(key, configuredSecret)
    };
  }

  if (process.platform === 'win32') {
    try {
      return {
        format: ENCRYPTION_KEY_FORMAT,
        version: 1,
        provider: 'windows-dpapi',
        createdAt: new Date().toISOString(),
        protectedKey: (await dpapiTransform('protect', key)).toString('base64')
      };
    } catch (error) {
      console.warn(`Windows key protection failed; using local-file key fallback: ${error.message || error}`);
    }
  }

  return {
    format: ENCRYPTION_KEY_FORMAT,
    version: 1,
    provider: 'local-file',
    createdAt: new Date().toISOString(),
    key: key.toString('base64')
  };
}

async function unwrapEncryptionKey(record) {
  let key;
  if (record.provider === 'passphrase') {
    const configuredSecret = configuredEncryptionSecret();
    if (!configuredSecret) {
      throw new Error('FANSLY_OVERLAY_SECRET is required to unlock this app data.');
    }
    key = decryptKeyWithSecret(record, configuredSecret);
  } else if (record.provider === 'windows-dpapi') {
    key = await dpapiTransform('unprotect', Buffer.from(record.protectedKey || '', 'base64'));
  } else if (record.provider === 'local-file') {
    key = Buffer.from(record.key || '', 'base64');
  } else {
    throw new Error(`Unsupported encryption key provider: ${record.provider || 'unknown'}`);
  }

  if (key.length !== 32) {
    throw new Error('Local encryption key is invalid.');
  }
  return key;
}

function configuredEncryptionSecret() {
  return process.env.FANSLY_OVERLAY_SECRET || process.env.FANSLY_OVERLAY_ENCRYPTION_KEY || '';
}

function encryptKeyWithSecret(key, secret) {
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const wrappingKey = deriveKeyWrappingKey(secret, salt);
  const cipher = createCipheriv(DATA_ENCRYPTION_ALGORITHM, wrappingKey, iv);
  const encrypted = Buffer.concat([cipher.update(key), cipher.final()]);
  return {
    algorithm: DATA_ENCRYPTION_ALGORITHM,
    kdf: 'pbkdf2-sha256',
    iterations: PASSPHRASE_KDF_ITERATIONS,
    salt: salt.toString('base64'),
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    protectedKey: encrypted.toString('base64')
  };
}

function decryptKeyWithSecret(record, secret) {
  const wrappingKey = deriveKeyWrappingKey(secret, Buffer.from(record.salt || '', 'base64'));
  const decipher = createDecipheriv(
    record.algorithm || DATA_ENCRYPTION_ALGORITHM,
    wrappingKey,
    Buffer.from(record.iv || '', 'base64')
  );
  decipher.setAuthTag(Buffer.from(record.tag || '', 'base64'));
  return Buffer.concat([
    decipher.update(Buffer.from(record.protectedKey || '', 'base64')),
    decipher.final()
  ]);
}

function deriveKeyWrappingKey(secret, salt) {
  return pbkdf2Sync(secret, salt, PASSPHRASE_KDF_ITERATIONS, 32, 'sha256');
}

async function dpapiTransform(action, input) {
  const script = [
    '& { param([string]$InputBase64, [string]$Action)',
    "$ErrorActionPreference = 'Stop'",
    'Add-Type -AssemblyName System.Security',
    '$bytes = [Convert]::FromBase64String($InputBase64)',
    '$scope = [Security.Cryptography.DataProtectionScope]::CurrentUser',
    "if ($Action -eq 'protect') {",
    '  $output = [Security.Cryptography.ProtectedData]::Protect($bytes, $null, $scope)',
    '} else {',
    '  $output = [Security.Cryptography.ProtectedData]::Unprotect($bytes, $null, $scope)',
    '}',
    '[Convert]::ToBase64String($output)',
    '}'
  ].join('; ');
  const { stdout } = await execFileAsync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script, input.toString('base64'), action],
    { windowsHide: true, timeout: 10000, maxBuffer: 1024 * 1024 }
  );
  return Buffer.from(stdout.trim(), 'base64');
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
  if (streamTimer) {
    clearTimeout(streamTimer);
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

  openExternalBrowser(url);
}

function openExternalBrowser(url) {
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
    console.warn(`Could not open browser automatically: ${error.message || error}`);
  }
}
