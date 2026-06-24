const els = {
  root: document.querySelector('#overlayRoot'),
  card: document.querySelector('#rankCard'),
  arrowField: document.querySelector('#arrowField'),
  confettiField: document.querySelector('#confettiField'),
  title: document.querySelector('#overlayTitle'),
  rank: document.querySelector('#rankValue'),
  movement: document.querySelector('#movementPill'),
  countdown: document.querySelector('#overlayCountdown'),
  countdownPill: document.querySelector('#countdownPill'),
  history: document.querySelector('#historyStrip')
};

let previousRank = null;
let latestState = null;
let arrowClearTimer;
let confettiClearTimer;
let confettiInterval;
const confettiColors = ['#59e0aa', '#6bd3ff', '#ffd166', '#ff6f8d', '#fbfcff'];
const defaultTheme = {
  gradientA: '#59e0aa',
  gradientB: '#6bd3ff',
  shine: '#ffffff'
};
const defaultOverlayTitle = 'Fansly Leaderboard Rank';
const defaultAppearanceMode = 'classic';
const appearanceModes = new Set(['classic', 'pill', 'neon', 'logo', 'compact']);

const events = new EventSource('/events');
events.addEventListener('state', event => render(JSON.parse(event.data)));
events.onerror = () => {
  els.movement.textContent = 'Offline';
  els.movement.dataset.move = 'down';
};

fetch('/api/state')
  .then(response => response.json())
  .then(render)
  .catch(() => {});

window.setInterval(() => renderCountdown(latestState), 1000);

function render(state) {
  latestState = state;
  const nextRank = state.rank;
  if (nextRank != null && previousRank != null && nextRank !== previousRank) {
    const direction = state.movement > 0 ? 'up' : state.movement < 0 ? 'down' : 'same';
    if (direction !== 'same') {
      playRankChange(direction);
    }
  } else if (nextRank != null && previousRank == null && state.movement !== 0 && state.movement != null) {
    playRankChange(state.movement > 0 ? 'up' : 'down');
  }
  previousRank = nextRank;

  els.rank.textContent = nextRank == null ? '--' : nextRank;
  setTitle(state.overlaySettings?.title);
  setAppearanceMode(state.overlaySettings?.appearanceMode);
  applyTheme(state.overlaySettings?.theme);
  setMovement(state.movement, state.status);
  renderCountdown(state);
  els.root.classList.toggle('movement-hidden', state.overlaySettings?.showMovement === false);
  els.root.classList.toggle('countdown-hidden', state.overlaySettings?.showCountdown === false);
  els.root.classList.toggle('history-hidden', state.overlaySettings?.showHistory === false);
  setHistory(state.history || []);
}

function playRankChange(direction) {
  els.card.classList.remove('rank-pulse-up', 'rank-pulse-down');
  void els.card.offsetWidth;
  els.card.classList.add(direction === 'up' ? 'rank-pulse-up' : 'rank-pulse-down');
  spawnArrows(direction);
  if (direction === 'up') {
    spawnConfetti();
  } else {
    clearConfetti();
  }
}

function spawnArrows(direction) {
  window.clearTimeout(arrowClearTimer);
  els.arrowField.innerHTML = '';
  const count = direction === 'down' ? 28 : 10;
  for (let index = 0; index < count; index += 1) {
    const arrow = document.createElement('span');
    arrow.className = 'rank-arrow';
    arrow.dataset.direction = direction;
    arrow.textContent = direction === 'up' ? '\u2191' : '\u2193';
    arrow.style.left = `${randomBetween(5, 88)}%`;
    arrow.style.top = `${randomBetween(8, 74)}%`;
    arrow.style.animationDelay = `${randomBetween(0, direction === 'down' ? 4200 : 180)}ms`;
    arrow.style.animationDuration = `${randomBetween(direction === 'down' ? 1800 : 760, direction === 'down' ? 5000 : 1160)}ms`;
    arrow.style.fontSize = `${randomBetween(1.2, 2.4).toFixed(2)}rem`;
    els.arrowField.append(arrow);
  }

  arrowClearTimer = window.setTimeout(() => {
    els.arrowField.innerHTML = '';
  }, direction === 'down' ? 5600 : 1500);
}

function randomBetween(min, max) {
  return Math.random() * (max - min) + min;
}

function spawnConfetti() {
  clearConfetti();
  emitConfettiBurst(18);
  confettiInterval = window.setInterval(() => emitConfettiBurst(8), 850);
  confettiClearTimer = window.setTimeout(clearConfetti, 20000);
}

function emitConfettiBurst(count) {
  for (let index = 0; index < count; index += 1) {
    const piece = document.createElement('span');
    piece.className = 'confetti-piece';
    piece.style.left = `${randomBetween(4, 94)}%`;
    piece.style.top = `${randomBetween(4, 34)}%`;
    piece.style.width = `${randomBetween(5, 9).toFixed(1)}px`;
    piece.style.height = `${randomBetween(7, 12).toFixed(1)}px`;
    piece.style.background = confettiColors[index % confettiColors.length];
    piece.style.animationDelay = `${randomBetween(0, 140)}ms`;
    piece.style.animationDuration = `${randomBetween(920, 1380)}ms`;
    piece.style.setProperty('--drift', `${randomBetween(-46, 46).toFixed(1)}px`);
    piece.style.setProperty('--fall', `${randomBetween(42, 94).toFixed(1)}px`);
    piece.style.setProperty('--spin', `${randomBetween(160, 620).toFixed(1)}deg`);
    els.confettiField.append(piece);
    window.setTimeout(() => piece.remove(), 1800);
  }
}

function clearConfetti() {
  window.clearTimeout(confettiClearTimer);
  window.clearInterval(confettiInterval);
  els.confettiField.innerHTML = '';
}

function setMovement(movement, status) {
  els.movement.dataset.move = 'same';
  if (status === 'session-expired') {
    els.movement.textContent = 'Login expired';
    els.movement.dataset.move = 'down';
    return;
  }
  if (movement == null || status === 'needs-login') {
    els.movement.textContent = status === 'needs-login' ? 'Login needed' : 'Waiting';
    return;
  }
  if (movement > 0) {
    els.movement.textContent = `+${movement}`;
    els.movement.dataset.move = 'up';
    return;
  }
  if (movement < 0) {
    els.movement.textContent = `${movement}`;
    els.movement.dataset.move = 'down';
    return;
  }
  els.movement.textContent = 'No change';
}

function setHistory(history) {
  els.history.innerHTML = '';
  const recent = history.slice(-10).reverse();
  for (const entry of recent) {
    const item = document.createElement('div');
    item.className = 'history-item';
    item.dataset.move = entry.movement > 0 ? 'up' : entry.movement < 0 ? 'down' : 'same';
    item.innerHTML = `<span>#${entry.rank}</span><small>${movementText(entry.movement)}</small>`;
    els.history.append(item);
  }
}

function renderCountdown(state) {
  const endsAt = state?.leaderboard?.endsAt;
  const label = formatCountdown(endsAt);
  els.countdown.textContent = label;
  els.countdownPill.dataset.state = label === 'Ended' ? 'ended' : endsAt ? 'active' : 'waiting';
}

function setTitle(value) {
  els.title.textContent = typeof value === 'string' && value.trim() ? value.trim() : defaultOverlayTitle;
}

function setAppearanceMode(value) {
  const normalized = typeof value === 'string' ? value.toLowerCase() : '';
  els.root.dataset.appearance = appearanceModes.has(normalized) ? normalized : defaultAppearanceMode;
}

function applyTheme(theme) {
  const nextTheme = normalizedTheme(theme);
  els.root.style.setProperty('--overlay-gradient-a', hexToRgba(nextTheme.gradientA, 0.18));
  els.root.style.setProperty('--overlay-gradient-b', hexToRgba(nextTheme.gradientB, 0.16));
  els.root.style.setProperty('--overlay-shine', hexToRgba(nextTheme.shine, 0.28));
}

function normalizedTheme(theme) {
  return {
    gradientA: normalizeHex(theme?.gradientA, defaultTheme.gradientA),
    gradientB: normalizeHex(theme?.gradientB, defaultTheme.gradientB),
    shine: normalizeHex(theme?.shine, defaultTheme.shine)
  };
}

function normalizeHex(value, fallback) {
  return typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value) ? value.toLowerCase() : fallback;
}

function hexToRgba(value, alpha) {
  const hex = normalizeHex(value, '#ffffff').slice(1);
  const red = Number.parseInt(hex.slice(0, 2), 16);
  const green = Number.parseInt(hex.slice(2, 4), 16);
  const blue = Number.parseInt(hex.slice(4, 6), 16);
  return `rgba(${red}, ${green}, ${blue}, ${alpha})`;
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
    return `${days}d ${padded(hours)}h ${padded(minutes)}m`;
  }
  return `${padded(hours)}h ${padded(minutes)}m ${padded(seconds)}s`;
}

function movementText(movement) {
  if (movement > 0) return `+${movement}`;
  if (movement < 0) return `${movement}`;
  return '0';
}
