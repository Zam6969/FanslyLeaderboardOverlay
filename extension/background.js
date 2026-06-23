const RANK_ENDPOINT = 'https://leaderboard.fansly.com/leaderboard/getActualUserRank/v1/';
const LOCAL_CAPTURE_URL = 'http://127.0.0.1:8787/api/capture-from-extension';
const pendingCaptures = new Map();

chrome.webRequest.onBeforeSendHeaders.addListener(
  details => {
    if (!isRankRequest(details.url)) {
      return;
    }

    pendingCaptures.set(details.requestId, {
      url: details.url,
      method: details.method,
      headers: details.requestHeaders || [],
      statusCode: null,
      responseHeaders: [],
      capturedAt: new Date().toISOString()
    });
  },
  { urls: [`${RANK_ENDPOINT}*`] },
  ['requestHeaders', 'extraHeaders']
);

chrome.webRequest.onHeadersReceived.addListener(
  details => {
    const capture = pendingCaptures.get(details.requestId);
    if (!capture) {
      return;
    }

    capture.statusCode = details.statusCode;
    capture.responseHeaders = details.responseHeaders || [];
    sendCapture(details.requestId, capture);
  },
  { urls: [`${RANK_ENDPOINT}*`] },
  ['responseHeaders', 'extraHeaders']
);

chrome.webRequest.onCompleted.addListener(
  details => {
    const capture = pendingCaptures.get(details.requestId);
    if (!capture) {
      return;
    }

    capture.statusCode = details.statusCode;
    sendCapture(details.requestId, capture);
  },
  { urls: [`${RANK_ENDPOINT}*`] }
);

chrome.webRequest.onErrorOccurred.addListener(
  details => {
    pendingCaptures.delete(details.requestId);
  },
  { urls: [`${RANK_ENDPOINT}*`] }
);

function isRankRequest(url) {
  return typeof url === 'string' && url.startsWith(RANK_ENDPOINT);
}

async function sendCapture(requestId, capture) {
  if (capture.sent) {
    return;
  }
  capture.sent = true;
  pendingCaptures.delete(requestId);

  try {
    await fetch(LOCAL_CAPTURE_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(capture)
    });
  } catch {
    capture.sent = false;
    pendingCaptures.set(requestId, capture);
    setTimeout(() => retryCapture(requestId), 1500);
  }
}

async function retryCapture(requestId) {
  const capture = pendingCaptures.get(requestId);
  if (!capture || capture.sent) {
    return;
  }
  await sendCapture(requestId, capture);
}
