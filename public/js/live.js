/**
 * Being told, rather than asking.
 *
 * The app used to bring itself up to date on a timer: every minute, on every
 * screen, whether or not anything had happened. That is late by design and
 * busy for nothing, and it is the wrong shape for a rota two people are
 * building at the same time. So the timer is gone. A socket stays open for as
 * long as the tab does, and the server says when something changed.
 *
 * WHAT ARRIVES IS A TOPIC NAME AND A TIME. Nothing else — no rows, no names,
 * no numbers. The screen that hears it re-asks the API exactly as it always
 * did, through the same endpoints that check what the asker holds. So this
 * channel cannot become a way of learning something a person was not allowed
 * to fetch, however far the app grows around it.
 *
 * THREE THINGS MAKE IT SURVIVABLE ON A SCREEN SOMEBODY IS WORKING IN:
 *
 *   It reconnects on its own, backing off so a site that is down is not being
 *   hammered by every phone in the building, and it says when it came back
 *   after being away — the moment a screen has to catch up on what it missed.
 *
 *   It settles. A planner saving a fortnight of cells is one change as far as
 *   everybody else's screen is concerned, so a burst is collected and told
 *   once rather than fourteen times.
 *
 *   It does nothing while the tab is hidden beyond staying connected. A phone
 *   in a pocket is not reading anything.
 */

const RETRY_MIN = 1000;
const RETRY_MAX = 30000;
const PING_MS = 25000;
const SETTLE_MS = 700;

/**
 * Which tab this is.
 *
 * Sent up with every change this tab makes, so the server can leave it out of
 * the announcement. The tab that pressed Save has already redrawn itself off
 * the answer, and a second redraw on top of staged edits is how somebody loses
 * work they were in the middle of. Other tabs of the same login are told, on
 * purpose: a rota open on the office computer and on a phone are two screens.
 */
const TAB = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

export function tabId() { return TAB; }

const listeners = new Set();

/**
 * Hear about changes.
 *
 * The callback is given `{ topic }` for a change, or `{ open, missed }` when
 * the connection comes up or goes down — because "the socket has been down for
 * four minutes" is itself something a screen has to react to.
 */
export function onLive(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function say(event) {
  for (const fn of [...listeners]) {
    try { fn(event); } catch { /* one deaf listener is not the others' problem */ }
  }
}

let socket = null;
let retryAt = RETRY_MIN;
let retryTimer = null;
let pingTimer = null;
let settleTimer = null;
let waiting = new Set();
let wanted = false;
let everConnected = false;
let downSince = null;

export function liveUp() { return socket?.readyState === 1; }

function flush() {
  const topics = [...waiting];
  waiting = new Set();
  if (topics.length) say({ topics });
}

function heard(topic) {
  waiting.add(topic || 'other');
  clearTimeout(settleTimer);
  settleTimer = setTimeout(flush, SETTLE_MS);
}

function stopTimers() {
  clearInterval(pingTimer);
  clearTimeout(retryTimer);
  pingTimer = null;
  retryTimer = null;
}

function scheduleRetry() {
  if (!wanted || retryTimer) return;
  // A little scatter, so two dozen phones that lost the site together do not
  // all come back at the same instant and knock it over again.
  const jitter = Math.round(retryAt * 0.3 * Math.random());
  retryTimer = setTimeout(() => {
    retryTimer = null;
    open();
  }, retryAt + jitter);
  retryAt = Math.min(retryAt * 2, RETRY_MAX);
}

function open() {
  if (!wanted || socket) return;
  if (typeof WebSocket !== 'function') return;

  const url = new URL('/api/live', location.href);
  url.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  url.searchParams.set('by', TAB);

  let ws;
  try {
    ws = new WebSocket(url);
  } catch {
    scheduleRetry();
    return;
  }
  socket = ws;

  ws.addEventListener('open', () => {
    if (socket !== ws) return;
    retryAt = RETRY_MIN;
    // How long this screen was on its own. A tab that has been disconnected
    // has missed every change made in the meantime and has to ask once;
    // a first connection has missed nothing, because the page just loaded.
    const missed = everConnected && downSince != null;
    everConnected = true;
    downSince = null;
    clearInterval(pingTimer);
    pingTimer = setInterval(() => {
      // Answered by the runtime without waking the hub. Its only job is to
      // keep whatever sits between this browser and the site from deciding an
      // idle socket is a dead one.
      try { ws.send(JSON.stringify({ type: 'ping' })); } catch { /* the close handler has it */ }
    }, PING_MS);
    say({ open: true, missed });
  });

  ws.addEventListener('message', (event) => {
    if (socket !== ws) return;
    let data = null;
    try { data = JSON.parse(event.data); } catch { return; }
    if (data?.type === 'changed') heard(data.topic);
  });

  const gone = () => {
    if (socket !== ws) return;
    socket = null;
    stopTimers();
    if (downSince == null) downSince = Date.now();
    say({ open: false });
    scheduleRetry();
  };

  ws.addEventListener('close', gone);
  ws.addEventListener('error', gone);
}

/** Start listening. Safe to call again; the second call does nothing. */
export function startLive() {
  wanted = true;
  open();
}

/** Stop, and stay stopped — signing out rather than losing signal. */
export function stopLive() {
  wanted = false;
  stopTimers();
  const ws = socket;
  socket = null;
  everConnected = false;
  downSince = null;
  try { ws?.close(1000, 'signed out'); } catch { /* already gone */ }
}

// Coming back to a tab that was in a pocket is the moment to make sure the
// socket is still there. A browser that suspended the tab may have closed it
// without ever running the close handler.
if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', () => {
    if (document.hidden || !wanted) return;
    if (!liveUp()) {
      // Back at once rather than at the end of whatever backoff was running:
      // somebody is looking at the screen now.
      retryAt = RETRY_MIN;
      clearTimeout(retryTimer);
      retryTimer = null;
      socket = null;
      open();
    }
  });
}
