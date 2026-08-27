import { mayHear } from './lib/live.js';

/**
 * The hub every signed-in device holds a socket to.
 *
 * A Worker cannot talk to another Worker's request: each one is its own
 * isolate, started for one request and gone after it. A Durable Object is the
 * one thing in this runtime that two requests can both be looking at, so it is
 * where the sockets live and where a change gets fanned out from.
 *
 * IT HIBERNATES. Sockets are accepted through `acceptWebSocket` rather than
 * held open in memory, which lets the runtime put this object to sleep while
 * two dozen phones sit connected doing nothing — which is what two dozen
 * phones do all night. It wakes to broadcast and goes back to sleep. Keeping
 * them in a `Set` would work and would bill for every one of those hours.
 *
 * Because it sleeps, nothing may be kept on `this`. What a socket is allowed
 * to hear is written onto the socket itself, and read back out after the
 * object wakes up somewhere else entirely.
 */
export class LiveHub {
  constructor(state) {
    this.state = state;

    // A keepalive answered inside the runtime without waking this object.
    // Without it, every ping from every phone every half minute is a wake-up,
    // and the hibernation above buys nothing.
    if (typeof WebSocketRequestResponsePair === 'function') {
      this.state.setWebSocketAutoResponse(
        new WebSocketRequestResponsePair(
          JSON.stringify({ type: 'ping' }),
          JSON.stringify({ type: 'pong' }),
        ),
      );
    }
  }

  async fetch(request) {
    const url = new URL(request.url);

    if (url.pathname === '/announce') {
      const message = await request.json().catch(() => null);
      const sent = message?.topic ? this.tell(message) : 0;
      return new Response(JSON.stringify({ sent }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }

    if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
      return new Response('Expected a websocket', { status: 426 });
    }

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);

    this.state.acceptWebSocket(server);
    // What this socket may be told, and which tab it belongs to. On the socket
    // rather than in a field, because the object it would be a field of is
    // about to go to sleep.
    server.serializeAttachment({
      permissions: url.searchParams.getAll('p'),
      by: url.searchParams.get('by') ?? null,
    });

    // So a tab knows the difference between "connected" and "the page loaded
    // and nothing has come back yet".
    try {
      server.send(JSON.stringify({ type: 'ready', at: Date.now() }));
    } catch { /* a socket that cannot be greeted will not be missed either */ }

    return new Response(null, { status: 101, webSocket: client });
  }

  /**
   * Say it to everybody entitled to hear it, except whoever did it.
   *
   * The tab that made the change has already redrawn itself off the answer to
   * its own save. Telling it again would be a second render for nothing, and
   * on a screen holding staged edits it is a second render that could take
   * them. Its other tabs, and everybody else's, are told.
   */
  tell({ topic, by = null, at = Date.now() }) {
    const payload = JSON.stringify({ type: 'changed', topic, at });
    let sent = 0;

    for (const socket of this.state.getWebSockets()) {
      let held = [];
      let mine = null;
      try {
        const attachment = socket.deserializeAttachment() ?? {};
        held = attachment.permissions ?? [];
        mine = attachment.by ?? null;
      } catch { /* an unreadable attachment hears the safe topics only */ }

      if (by && mine && by === mine) continue;
      if (!mayHear(topic, held)) continue;

      try {
        socket.send(payload);
        sent += 1;
      } catch {
        // A socket that has gone without saying so. Closing it is the whole
        // cleanup: the runtime drops it from getWebSockets after that.
        try { socket.close(1011, 'send failed'); } catch { /* already gone */ }
      }
    }

    return sent;
  }

  /**
   * Nothing a browser says here is acted on.
   *
   * The channel is one-way by design. A tab that wants something asks the API
   * for it, over HTTP, where the route table checks what it holds. Accepting
   * instructions down a socket would be a second front door with no lock on
   * it. Pings are the only traffic, and the runtime answers those itself.
   */
  webSocketMessage() {}

  webSocketClose(ws, code, reason, wasClean) {
    void code; void reason; void wasClean;
    try { ws.close(); } catch { /* already closed */ }
  }

  webSocketError(ws) {
    try { ws.close(1011, 'socket error'); } catch { /* already gone */ }
  }
}
