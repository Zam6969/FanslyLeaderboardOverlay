const stateUrl = `${location.origin}/api/state`;
const overlayUrl = `${location.origin}/overlay`;
const defaultTheme = {
  gradientA: '#59e0aa',
  gradientB: '#6bd3ff',
  shine: '#ffffff'
};
const defaultOverlayTitle = 'Fansly Leaderboard Rank';
const defaultAppearanceMode = 'classic';
const appearanceModes = new Set(['classic', 'pill', 'neon', 'compact']);

const els = {
  statusPill: document.querySelector('#statusPill'),
  rankNumber: document.querySelector('#rankNumber'),
  movementBadge: document.querySelector('#movementBadge'),
  historyTimeline: document.querySelector('#historyTimeline'),
  countdownValue: document.querySelector('#countdownValue'),
  leaderboardMeta: document.querySelector('#leaderboardMeta'),
  captureHint: document.querySelector('#captureHint'),
  sessionWarning: document.querySelector('#sessionWarning'),
  overlayUrl: document.querySelector('#overlayUrl'),
  capturedAt: document.querySelector('#capturedAt'),
  capturedMethod: document.querySelector('#capturedMethod'),
  capturedStatus: document.querySelector('#capturedStatus'),
  rankPath: document.querySelector('#rankPath'),
  requestHeaderChips: document.querySelector('#requestHeaderChips'),
  lastPollAt: document.querySelector('#lastPollAt'),
  nextPollAt: document.querySelector('#nextPollAt'),
  pollInterval: document.querySelector('#pollInterval'),
  errorText: document.querySelector('#errorText'),
  payloadPreview: document.querySelector('#payloadPreview'),
  openBrowserBtn: document.querySelector('#openBrowserBtn'),
  startLoginBtn: document.querySelector('#startLoginBtn'),
  pollNowBtn: document.querySelector('#pollNowBtn'),
  clearHistoryBtn: document.querySelector('#clearHistoryBtn'),
  resetBtn: document.querySelector('#resetBtn'),
  copyUrlBtn: document.querySelector('#copyUrlBtn'),
  testForm: document.querySelector('#testForm'),
  testModeToggle: document.querySelector('#testModeToggle'),
  testRank: document.querySelector('#testRank'),
  testRankBtn: document.querySelector('#testRankBtn'),
  movementToggle: document.querySelector('#movementToggle'),
  countdownToggle: document.querySelector('#countdownToggle'),
  historyToggle: document.querySelector('#historyToggle'),
  appearanceModes: [...document.querySelectorAll('input[name="appearanceMode"]')],
  overlayTitleInput: document.querySelector('#overlayTitleInput'),
  gradientAColor: document.querySelector('#gradientAColor'),
  gradientBColor: document.querySelector('#gradientBColor'),
  shineColor: document.querySelector('#shineColor'),
  resetThemeBtn: document.querySelector('#resetThemeBtn'),
  captureSource: document.querySelector('#captureSource')
};

els.overlayUrl.textContent = overlayUrl;

let latestState = null;
let busy = false;
let titleSaveTimer;
let titleSaveInFlight = false;
let titleSaveQueued = false;
let titleSaveLastValue = null;

els.openBrowserBtn.addEventListener('click', () => post('/api/open-browser-login'));
els.startLoginBtn.addEventListener('click', () => post('/api/start-login'));
els.pollNowBtn.addEventListener('click', () => post('/api/poll-now'));
els.clearHistoryBtn.addEventListener('click', async () => {
  if (confirm('Clear rank history and the current displayed rank?')) {
    await post('/api/clear-history');
  }
});
els.resetBtn.addEventListener('click', async () => {
  if (confirm('Reset captured auth and local rank history?')) {
    await post('/api/reset-auth');
  }
});
els.testModeToggle.addEventListener('change', () => {
  post('/api/test-mode', { enabled: els.testModeToggle.checked });
});
els.historyToggle.addEventListener('change', () => {
  post('/api/overlay-settings', { showHistory: els.historyToggle.checked });
});
els.movementToggle.addEventListener('change', () => {
  post('/api/overlay-settings', { showMovement: els.movementToggle.checked });
});
els.countdownToggle.addEventListener('change', () => {
  post('/api/overlay-settings', { showCountdown: els.countdownToggle.checked });
});
for (const input of els.appearanceModes) {
  input.addEventListener('change', () => {
    if (input.checked) {
      post('/api/overlay-settings', { appearanceMode: input.value });
    }
  });
}
els.overlayTitleInput.addEventListener('input', () => {
  window.clearTimeout(titleSaveTimer);
  titleSaveTimer = window.setTimeout(() => postTitle(), 350);
});
els.overlayTitleInput.addEventListener('change', () => {
  window.clearTimeout(titleSaveTimer);
  postTitle();
});
els.gradientAColor.addEventListener('change', () => postTheme());
els.gradientBColor.addEventListener('change', () => postTheme());
els.shineColor.addEventListener('change', () => postTheme());
els.resetThemeBtn.addEventListener('click', () => {
  post('/api/overlay-settings', { resetTheme: true });
});
els.testForm.addEventListener('submit', async event => {
  event.preventDefault();
  const rank = Number.parseInt(els.testRank.value, 10);
  if (!Number.isFinite(rank) || rank < 1) {
    els.errorText.textContent = 'Enter a positive whole number to test the overlay rank.';
    return;
  }
  await post('/api/test-rank', { rank });
});
els.copyUrlBtn.addEventListener('click', async () => {
  await navigator.clipboard.writeText(overlayUrl);
  els.copyUrlBtn.textContent = 'Copied';
  setTimeout(() => {
    els.copyUrlBtn.textContent = 'Copy URL';
  }, 1100);
});

const source = new EventSource('/events');
source.addEventListener('state', event => render(JSON.parse(event.data)));
source.onerror = () => {
  els.statusPill.textContent = 'Disconnected';
  els.statusPill.dataset.state = 'error';
};

fetch(stateUrl)
  .then(response => response.json())
  .then(render)
  .catch(() => {});

window.setInterval(() => renderCountdown(latestState), 1000);

async function post(path, requestBody, options = {}) {
  const showBusy = options.showBusy !== false;
  if (showBusy) {
    setBusy(true);
  }
  try {
    const response = await fetch(path, {
      method: 'POST',
      headers: requestBody ? { 'content-type': 'application/json' } : undefined,
      body: requestBody ? JSON.stringify(requestBody) : undefined
    });
    const responseBody = await response.json();
    if (!response.ok) {
      throw new Error(responseBody.error || 'Request failed');
    }
    render(responseBody.state || responseBody);
  } catch (error) {
    els.errorText.textContent = error.message || String(error);
  } finally {
    if (showBusy) {
      setBusy(false);
    }
  }
}

function render(state) {
  latestState = state;
  const sessionExpired = isSessionExpired(state);
  els.statusPill.textContent = labelStatus(state.status);
  els.statusPill.dataset.state = sessionExpired ? 'session-expired' : state.error ? 'error' : state.status;
  els.rankNumber.textContent = state.rank == null ? '--' : `#${state.rank}`;
  renderMovement(els.movementBadge, state.movement);
  renderHistory(state.history || []);
  renderCountdown(state);
  renderSessionWarning(state);

  if (sessionExpired) {
    els.captureHint.textContent = 'Your saved Fansly login expired. Use the browser extension flow or Controlled Chromium capture again, then open the leaderboard to refresh it.';
  } else {
    els.captureHint.textContent = state.capture
      ? `Authenticated headers are encrypted locally from ${labelCaptureSource(state.capture.source).toLowerCase()}. The server polls Fansly every 30 seconds with the replayable request headers.`
      : 'Browser tab capture uses the included extension: click Open Fansly in browser, log in if needed, then open the leaderboard in that browser. Controlled Chromium capture is available as a fallback.';
  }

  els.capturedAt.textContent = formatTime(state.capture?.capturedAt);
  els.captureSource.textContent = labelCaptureSource(state.capture?.source);
  els.capturedMethod.textContent = state.capture?.method || '--';
  els.capturedStatus.textContent = state.capture?.status || '--';
  els.rankPath.textContent = state.rankPath || '--';
  els.lastPollAt.textContent = formatTime(state.lastPollAt);
  els.nextPollAt.textContent = formatTime(state.nextPollAt);
  els.pollInterval.textContent = `${Math.round((state.pollMs || 30000) / 1000)} seconds`;
  els.errorText.textContent = state.error || '';
  els.payloadPreview.textContent = state.lastPayloadPreview || '';
  renderHeaderChips(state.capture?.requestHeaderNames || []);
  renderTestControls(state);
  renderOverlayControls(state);
}

function renderSessionWarning(state) {
  const sessionExpired = isSessionExpired(state);
  els.sessionWarning.hidden = !sessionExpired;
  if (!sessionExpired) {
    return;
  }

  const detail = state.sessionExpiredReason ? ` Last response: ${trimForUi(state.sessionExpiredReason, 120)}` : '';
  els.sessionWarning.querySelector('span').textContent =
    `Fansly rejected the saved session. Start login capture and log in again to refresh it.${detail}`;
}

function renderMovement(target, movement) {
  target.className = 'movement';
  if (movement == null) {
    target.textContent = 'No movement yet';
    return;
  }
  if (movement > 0) {
    target.textContent = `Up ${movement} place${movement === 1 ? '' : 's'}`;
    target.classList.add('up');
    return;
  }
  if (movement < 0) {
    const places = Math.abs(movement);
    target.textContent = `Down ${places} place${places === 1 ? '' : 's'}`;
    target.classList.add('down');
    return;
  }
  target.textContent = 'No change';
  target.classList.add('same');
}

function renderHistory(history) {
  els.historyTimeline.innerHTML = '';
  const recent = history.slice(-14).reverse();
  for (const entry of recent) {
    const item = document.createElement('div');
    item.className = 'history-dot';
    item.dataset.move = entry.movement > 0 ? 'up' : entry.movement < 0 ? 'down' : 'same';
    item.title = `${formatTime(entry.at)} - rank #${entry.rank}`;
    item.textContent = entry.rank;
    els.historyTimeline.append(item);
  }
}

function renderCountdown(state) {
  const leaderboard = state?.leaderboard;
  els.countdownValue.textContent = formatCountdown(leaderboard?.endsAt);

  if (leaderboard?.endsAt) {
    const label = leaderboard.description || leaderboard.key || 'Current leaderboard';
    els.leaderboardMeta.textContent = `${label} ends ${formatDateTime(leaderboard.endsAt)}`;
    return;
  }

  els.leaderboardMeta.textContent = leaderboard?.error
    ? `Leaderboard info unavailable: ${trimForUi(leaderboard.error, 120)}`
    : 'Waiting for leaderboard info';
}

function renderHeaderChips(headers) {
  els.requestHeaderChips.innerHTML = '';
  if (headers.length === 0) {
    els.requestHeaderChips.textContent = 'No captured request headers yet.';
    return;
  }
  for (const header of headers) {
    const chip = document.createElement('span');
    chip.className = 'chip';
    chip.textContent = header;
    els.requestHeaderChips.append(chip);
  }
}

function setBusy(isBusy) {
  busy = isBusy;
  for (const button of [els.openBrowserBtn, els.startLoginBtn, els.pollNowBtn, els.clearHistoryBtn, els.resetBtn]) {
    button.disabled = isBusy;
  }
  els.movementToggle.disabled = isBusy;
  els.countdownToggle.disabled = isBusy;
  els.historyToggle.disabled = isBusy;
  for (const input of els.appearanceModes) {
    input.disabled = isBusy;
  }
  els.overlayTitleInput.disabled = isBusy;
  els.gradientAColor.disabled = isBusy;
  els.gradientBColor.disabled = isBusy;
  els.shineColor.disabled = isBusy;
  els.resetThemeBtn.disabled = isBusy;
  renderTestControls(latestState);
}

function renderTestControls(state) {
  const testMode = Boolean(state?.testMode);
  els.testModeToggle.checked = testMode;
  els.testModeToggle.disabled = busy;
  els.testRank.disabled = busy || !testMode;
  els.testRankBtn.disabled = busy || !testMode;

  if (testMode) {
    els.captureHint.textContent = 'Test mode is on. Live polling is paused, and entered ranks only drive the local overlay preview.';
  }
}

function renderOverlayControls(state) {
  els.movementToggle.checked = state?.overlaySettings?.showMovement !== false;
  els.movementToggle.disabled = busy;
  els.countdownToggle.checked = state?.overlaySettings?.showCountdown !== false;
  els.countdownToggle.disabled = busy;
  els.historyToggle.checked = state?.overlaySettings?.showHistory !== false;
  els.historyToggle.disabled = busy;
  const appearanceMode = normalizedAppearanceMode(state?.overlaySettings?.appearanceMode);
  for (const input of els.appearanceModes) {
    input.checked = input.value === appearanceMode;
    input.disabled = busy;
  }
  const title = normalizedTitle(state?.overlaySettings?.title);
  if (document.activeElement !== els.overlayTitleInput) {
    els.overlayTitleInput.value = title;
  }
  els.overlayTitleInput.disabled = busy;
  const theme = normalizedTheme(state?.overlaySettings?.theme);
  els.gradientAColor.value = theme.gradientA;
  els.gradientBColor.value = theme.gradientB;
  els.shineColor.value = theme.shine;
  els.gradientAColor.disabled = busy;
  els.gradientBColor.disabled = busy;
  els.shineColor.disabled = busy;
  els.resetThemeBtn.disabled = busy;
}

function postTitle() {
  if (titleSaveInFlight) {
    titleSaveQueued = true;
    return Promise.resolve();
  }

  titleSaveInFlight = true;
  titleSaveQueued = false;
  return flushTitleSave().finally(() => {
    titleSaveInFlight = false;
    if (titleSaveQueued || els.overlayTitleInput.value !== titleSaveLastValue) {
      postTitle();
    }
  });
}

async function flushTitleSave() {
  do {
    titleSaveQueued = false;
    const title = els.overlayTitleInput.value;
    await post('/api/overlay-settings', { title }, { showBusy: false });
    titleSaveLastValue = title;
  } while (titleSaveQueued);
}

function postTheme() {
  return post('/api/overlay-settings', {
    theme: {
      gradientA: els.gradientAColor.value,
      gradientB: els.gradientBColor.value,
      shine: els.shineColor.value
    }
  });
}

function formatTime(value) {
  if (!value) return '--';
  return new Intl.DateTimeFormat(undefined, {
    hour: 'numeric',
    minute: '2-digit',
    second: '2-digit'
  }).format(new Date(value));
}

function formatDateTime(value) {
  if (!value) return '--';
  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit'
  }).format(new Date(value));
}

function formatCountdown(value) {
  if (!value) return '--';
  const diff = new Date(value).getTime() - Date.now();
  if (!Number.isFinite(diff)) return '--';
  if (diff <= 0) return 'Ended';

  const secondsTotal = Math.floor(diff / 1000);
  const days = Math.floor(secondsTotal / 86400);
  const hours = Math.floor((secondsTotal % 86400) / 3600);
  const minutes = Math.floor((secondsTotal % 3600) / 60);
  const seconds = secondsTotal % 60;
  const padded = value => String(value).padStart(2, '0');

  if (days > 0) {
    return `${days}d ${padded(hours)}h ${padded(minutes)}m ${padded(seconds)}s`;
  }
  return `${padded(hours)}h ${padded(minutes)}m ${padded(seconds)}s`;
}

function trimForUi(value, maxLength = 700) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  return text.length > maxLength ? `${text.slice(0, maxLength)}...` : text;
}

function normalizedTheme(theme) {
  return {
    gradientA: normalizeHex(theme?.gradientA, defaultTheme.gradientA),
    gradientB: normalizeHex(theme?.gradientB, defaultTheme.gradientB),
    shine: normalizeHex(theme?.shine, defaultTheme.shine)
  };
}

function normalizedTitle(value) {
  return typeof value === 'string' && value.trim() ? value : defaultOverlayTitle;
}

function normalizedAppearanceMode(value) {
  const normalized = typeof value === 'string' ? value.toLowerCase() : '';
  return appearanceModes.has(normalized) ? normalized : defaultAppearanceMode;
}

function normalizeHex(value, fallback) {
  return typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value) ? value.toLowerCase() : fallback;
}

function labelStatus(status = '') {
  if (status === 'session-expired') {
    return 'Login expired';
  }
  return status
    .split('-')
    .map(part => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

function isSessionExpired(state) {
  return state?.status === 'session-expired' || Boolean(state?.sessionExpiredAt);
}

function labelCaptureSource(source) {
  if (source === 'browser-extension') return 'Browser tab';
  if (source === 'playwright') return 'Controlled Chromium';
  if (source) return labelStatus(source);
  return '--';
}
