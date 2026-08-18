# Signing in once

Five systems, one sign-in. Somebody signs in to Insight, clicks a system on the
hub, and arrives there already signed in — as themselves, with whatever that
system says they may do.

This document is the protocol, and then the thirty lines each system needs to
accept it. **Attendance already has them** (`src/lib/sso-consumer.js` in this
repository). The breakfast app, the POS and the laundry live in their own
repositories, so their handlers are written out below to be pasted in.

---

## What happens when somebody clicks

```
  browser                 Insight                    the far system
     │                       │                            │
     │  click "Restaurant POS"                            │
     ├──────────────────────►│                            │
     │                       │ checks the grant           │
     │                       │ mints 32 random bytes      │
     │                       │ stores their SHA-256       │
     │  302 …/sso?code=…     │                            │
     │◄──────────────────────┤                            │
     │                                                    │
     │  GET /sso?code=…                                   │
     ├───────────────────────────────────────────────────►│
     │                       │                            │
     │                       │  POST /api/sso/redeem      │
     │                       │  Bearer <its own secret>   │
     │                       │◄───────────────────────────┤
     │                       │                            │
     │                       │  { email, name, role }     │
     │                       ├───────────────────────────►│
     │                       │                            │ finds that email
     │                       │                            │ in its own users
     │  302 / + its own session cookie                    │
     │◄───────────────────────────────────────────────────┤
```

It is the authorization-code half of OAuth and nothing else. Four decisions in
it are the reason a simpler version would not be safe.

**The identity travels on the back channel, never in the URL.** The redirect
carries an opaque code and nothing else. A URL ends up in a browser history, a
server log, a `Referer` header and whatever somebody pastes into a chat; a code
that is single-use and ninety seconds old is worthless in all of them, and an
email address and a role are not.

**Single use is enforced at Insight, not at the far end.** There are four far
ends and one Insight, and a replay check is only as good as the system that
remembered to write one. One `UPDATE … WHERE redeemed_at IS NULL` is the whole
mechanism.

**Every system has its own secret and can only redeem its own codes.** A
compromised laundry cannot mint itself a session on the POS: the secret it holds
does not authenticate it as the POS, and a code issued for the POS is refused
from anybody else.

**The redirect target is configuration, never input.** `sso_url` is set by an
owner and read from the database. An identity provider that redirects wherever
the query string says is a phishing page on your own domain.

---

## The two endpoints

### `POST /api/sso/start` — browser to Insight

Needs a signed-in session. Body `{"systemId": "pos"}`.

```json
{ "url": "https://pos.example.com/sso?code=8Kp2…", "expiresIn": 90,
  "system": { "id": "pos", "label": "Restaurant POS" } }
```

### `POST /api/sso/redeem` — far system to Insight

No session. The caller proves what it is with its own shared secret.

```http
POST /api/sso/redeem
Authorization: Bearer <that system's shared secret>
Content-Type: application/json

{ "systemId": "pos", "code": "8Kp2…" }
```

```json
{ "sub": "4", "email": "ama@nice.test", "name": "Ama Boateng",
  "role": "manager", "issuer": "insight" }
```

Anything wrong — no such code, expired, already redeemed, issued for a different
system, the account switched off in between — comes back as the same `400`.
Telling a caller which of those it was tells them something about codes they do
not hold.

A `401` means the secret was wrong. That one is worth distinguishing, because it
is a configuration mistake somebody has to fix rather than an attack.

---

## What a consumer must do

Five rules. The first three are the ones that matter.

1. **Never trust the URL.** The code carries no identity. Call the back channel.
2. **Never create an account.** If Insight says `ama@example.com` and nobody
   with that address exists here, refuse and say so. Auto-provisioning means
   whoever controls the hub can mint themselves an account in *your* system, and
   the whole point of a grant per system is that reaching one is not reaching
   all of them.
3. **Never widen anybody.** The `role` Insight sends is context, not authority.
   What somebody may do here is what your own database says. The hand-off
   decides *whether* they get in, never *as what*.
4. Set `Referrer-Policy: no-referrer` on the response, so the address that
   carried the code goes no further.
5. Fail to a readable page, not a blank one. Whoever hits this is a person who
   followed a link, not a script.

---

## Cloudflare Worker — the breakfast app

Its auth already looks like attendance's. Add a route before the API router:

```js
// src/index.js, inside fetch(), before the /api/ dispatch
if (url.pathname === '/sso') return handleSsoArrival(request, env, env.DB);
```

```js
// src/lib/sso-consumer.js
import { createToken, sessionCookie, tokenTtl } from './auth.js';

export async function handleSsoArrival(request, env, db) {
  const url = new URL(request.url);
  const code = url.searchParams.get('code');
  try {
    if (!code) throw new Error('That link is missing its sign-in code.');
    if (!env.INSIGHT_SSO_URL || !env.INSIGHT_SSO_SECRET) {
      throw new Error('This site has not been connected to the group hub yet.');
    }

    const response = await fetch(env.INSIGHT_SSO_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${env.INSIGHT_SSO_SECRET}`,
      },
      body: JSON.stringify({ systemId: 'breakfast', code }),
    });
    if (response.status === 401) throw new Error('The group hub did not recognise this site.');
    if (!response.ok) throw new Error('That sign-in link has expired or has already been used.');

    const identity = await response.json();

    // Your own users table. No account here means no.
    const user = await db.prepare(
      'SELECT id, name, role, active FROM users WHERE email = ?',
    ).bind(String(identity.email).trim().toLowerCase()).first();

    if (!user) throw new Error(`The hub signed you in as ${identity.email}, but nobody with that address has an account on this site.`);
    if (!user.active) throw new Error(`The account for ${identity.email} here has been switched off.`);

    const ttl = tokenTtl(user.role);
    const token = await createToken(
      { uid: user.id, role: user.role, exp: Math.floor(Date.now() / 1000) + ttl },
      env.SESSION_SECRET,
    );
    return new Response(null, {
      status: 302,
      headers: {
        Location: '/',
        'Set-Cookie': sessionCookie(token, user.role),
        'Cache-Control': 'no-store',
        'Referrer-Policy': 'no-referrer',
      },
    });
  } catch (err) {
    return new Response(`<!doctype html><meta charset="utf-8">
      <title>Could not sign you in</title>
      <p style="font-family:system-ui;max-width:34rem;margin:4rem auto">${
        String(err.message).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]))
      }</p><p style="font-family:system-ui;max-width:34rem;margin:1rem auto"><a href="/">Sign in here instead</a></p>`,
      { status: 400, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Referrer-Policy': 'no-referrer' } });
  }
}
```

Then:

```bash
wrangler secret put INSIGHT_SSO_URL      # https://insight.example.com/api/sso/redeem
wrangler secret put INSIGHT_SSO_SECRET   # the same value as SSO_SECRET_BREAKFAST on Insight
```

---

## Netlify Function — the laundry

The laundry signs people in by PIN and hands back a JWT that the front end keeps.
So its `/sso` cannot set a cookie and be done; it has to land on a page that
stores the token, exactly as its PIN pad does.

```js
// netlify/functions/sso.js
import { signToken } from './lib/auth.js';
import * as L from './lib/logic.js';

export async function handler(event) {
  const code = event.queryStringParameters?.code;
  const fail = (message) => ({
    statusCode: 400,
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Referrer-Policy': 'no-referrer' },
    body: `<!doctype html><meta charset="utf-8"><title>Could not sign you in</title>
           <p style="font-family:system-ui;max-width:34rem;margin:4rem auto">${message}</p>
           <p style="font-family:system-ui;max-width:34rem;margin:1rem auto"><a href="/app.html">Sign in here instead</a></p>`,
  });

  try {
    if (!code) return fail('That link is missing its sign-in code.');

    const response = await fetch(process.env.INSIGHT_SSO_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${process.env.INSIGHT_SSO_SECRET}`,
      },
      body: JSON.stringify({ systemId: 'laundry', code }),
    });
    if (response.status === 401) return fail('The group hub did not recognise this site.');
    if (!response.ok) return fail('That sign-in link has expired or has already been used.');

    const identity = await response.json();
    const email = String(identity.email).trim().toLowerCase();

    // The laundry's own cashiers. Matched on email; no match is a refusal.
    const cashiers = await L.listCashiers();
    const user = cashiers.find((c) => String(c.email || '').toLowerCase() === email);
    if (!user) return fail(`The hub signed you in as ${email}, but no cashier here uses that address.`);
    if (!user.active) return fail(`The account for ${email} here has been switched off.`);

    // Its own token, with its own claims. The hub's role is not used.
    const token = signToken({ id: user.id, role: user.role });

    // The front end keeps its token in localStorage, so hand it over on a page
    // rather than in a cookie, and replace the entry so the code never stays
    // in the browser's history.
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'text/html; charset=utf-8', 'Referrer-Policy': 'no-referrer', 'Cache-Control': 'no-store' },
      body: `<!doctype html><meta charset="utf-8"><title>Signing you in…</title>
        <script>
          localStorage.setItem('token', ${JSON.stringify(token)});
          location.replace('/app.html');
        </script>
        <noscript><a href="/app.html">Continue</a></noscript>`,
    };
  } catch {
    return fail('The group hub could not be reached.');
  }
}
```

`netlify.toml`:

```toml
[[redirects]]
  from = "/sso"
  to = "/.netlify/functions/sso"
  status = 200
```

Set `INSIGHT_SSO_URL` and `INSIGHT_SSO_SECRET` under **Site settings →
Environment variables**.

> The token is written into the page here, which is safe only because the page
> is served once, is never cached, and immediately replaces its own history
> entry. Do not add anything else to it, and do not make it cacheable.

---

## Appwrite Function — the POS

Appwrite owns its own sessions, so the POS cannot mint one from outside. What it
*can* do, with a server API key, is create a session on the user's behalf with a
custom token — the flow Appwrite provides for exactly this.

```js
// functions/sso/src/main.js
import { Client, Users, Query } from 'node-appwrite';

export default async ({ req, res, log }) => {
  const code = req.query?.code;
  const fail = (message) => res.send(
    `<!doctype html><meta charset="utf-8"><title>Could not sign you in</title>
     <p style="font-family:system-ui;max-width:34rem;margin:4rem auto">${message}</p>`,
    400, { 'Content-Type': 'text/html; charset=utf-8', 'Referrer-Policy': 'no-referrer' },
  );

  if (!code) return fail('That link is missing its sign-in code.');

  const response = await fetch(process.env.INSIGHT_SSO_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${process.env.INSIGHT_SSO_SECRET}`,
    },
    body: JSON.stringify({ systemId: 'pos', code }),
  });
  if (response.status === 401) return fail('The group hub did not recognise this site.');
  if (!response.ok) return fail('That sign-in link has expired or has already been used.');

  const identity = await response.json();

  const client = new Client()
    .setEndpoint(process.env.APPWRITE_FUNCTION_API_ENDPOINT)
    .setProject(process.env.APPWRITE_FUNCTION_PROJECT_ID)
    .setKey(req.headers['x-appwrite-key']);
  const users = new Users(client);

  // The POS's own users. No account here means no — this must not create one.
  const found = await users.list([Query.equal('email', identity.email)]);
  if (!found.total) return fail(`The hub signed you in as ${identity.email}, but nobody with that address has an account on the POS.`);
  const user = found.users[0];
  if (!user.status) return fail(`The account for ${identity.email} on the POS has been switched off.`);

  // Appwrite's own hand-off: a one-shot token the browser exchanges for a real
  // session against the POS's own domain.
  const token = await users.createToken(user.$id, 64, 60);

  const target = new URL('/', process.env.POS_APP_URL);
  target.searchParams.set('userId', user.$id);
  target.searchParams.set('secret', token.secret);
  return res.redirect(target.toString(), 302, { 'Referrer-Policy': 'no-referrer' });
};
```

The POS front end already has to finish the exchange:

```js
// wherever the app boots
const params = new URLSearchParams(location.search);
if (params.has('userId') && params.has('secret')) {
  await account.createSession(params.get('userId'), params.get('secret'));
  history.replaceState({}, '', location.pathname);   // drop the secret from the address
}
```

In `appwrite.json`, give the function `"execute": ["any"]` and a domain, and set
`INSIGHT_SSO_URL`, `INSIGHT_SSO_SECRET` and `POS_APP_URL` as function variables.

---

## Setting it up

On Insight, one secret per system:

```bash
wrangler secret put SSO_SECRET_ATTENDANCE
wrangler secret put SSO_SECRET_BREAKFAST
wrangler secret put SSO_SECRET_POS
wrangler secret put SSO_SECRET_LAUNDRY
```

Generate each one with `openssl rand -base64 32`. **Different values.** Sharing
one across systems throws away the property that a compromised system cannot
mint sessions on the others.

Then in **Accounts → Where each system lives**, set each system's sign-in
address (its `/sso`) and switch the hand-off on. The hub says plainly which
systems can hand over and which will ask for a password again, so a half-finished
setup is visible rather than mysterious.

## When something does not work

| What you see | What it means |
|---|---|
| "The group hub did not recognise this site" | The two ends have different secrets. |
| "expired or has already been used" | Someone refreshed the landing page, or a bookmarked `/sso?code=…` was reopened. Working as intended — go back to the hub. |
| "nobody with that address has an account" | Create them in that system first. Insight will not do it for you. |
| The hub shows "Single sign-on is switched off" | Set the sign-in address and tick the box under Accounts. |
| The hub shows "SSO_SECRET_… is not set" | The secret is missing on Insight. |

Every hand-off, and every refusal, is in **Accounts → recent hand-offs** and in
the `sso_log` table.
