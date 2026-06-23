const stateUrl = `${location.origin}/api/state`;
const overlayUrl = `${location.origin}/overlay`;

const els = {
  statusPill: document.querySelector('#statusPill'),
  rankNumber: document.querySelector('#rankNumber'),
  movementBadge: document.querySelector('#movementBadge'),
  historyTimeline: document.querySelector('#historyTimeline'),
  countdownValue: document.querySelector('#countdownValue'),
  leaderboardMeta: document.querySelector('#leaderboardMeta'),
  captureHint: document.querySelector('#captureHint'),
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
  captureSource: document.querySelector('#captureSource')
};

els.overlayUrl.textContent = overlayUrl;

let latestState = null;
let busy = false;

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

async function post(path, requestBody) {
  setBusy(true);
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
    setBusy(false);
  }
}

function render(state) {
  latestState = state;
  els.statusPill.textContent = labelStatus(state.status);
  els.statusPill.dataset.state = state.error ? 'error' : state.status;
  els.rankNumber.textContent = state.rank == null ? '--' : `#${state.rank}`;
  renderMovement(els.movementBadge, state.movement);
  renderHistory(state.history || []);
  renderCountdown(state);

  els.captureHint.textContent = state.capture
    ? `Authenticated headers are captured locally from ${labelCaptureSource(state.capture.source).toLowerCase()}. The server polls Fansly every 30 seconds with the replayable request headers.`
    : 'Click Start login capture, log in on fansly.com, then open the leaderboard inside that Chromium window so the authenticated rank request can be captured.';

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
  for (const button of [els.startLoginBtn, els.pollNowBtn, els.clearHistoryBtn, els.resetBtn]) {
    button.disabled = isBusy;
  }
  els.movementToggle.disabled = isBusy;
  els.countdownToggle.disabled = isBusy;
  els.historyToggle.disabled = isBusy;
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

function labelStatus(status = '') {
  return status
    .split('-')
    .map(part => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

function labelCaptureSource(source) {
  if (source === 'browser-extension') return 'Browser tab';
  if (source === 'playwright') return 'Controlled Chromium';
  if (source) return labelStatus(source);
  return '--';
}
