import { CHANNELS_KEY, goesOut, readChannels } from './notice-kinds.js';
import { isMissingTable } from './http.js';

/**
 * Text messages.
 *
 * Every phone takes a text. That is the whole reason this exists: an iPhone 7
 * Plus stops at iOS 15, web push for a home-screen app needs 16.4, and no
 * amount of work in the app will ever make one of those handsets buzz. A text
 * costs a few pesewas and arrives on all of them.
 *
 * Kept to rota publishing. A property that texts about everything is a
 * property whose staff stop reading the texts, and it is real money each time.
 */

// ---------------------------------------------------------------------------
// Numbers
// ---------------------------------------------------------------------------

/**
 * A Ghanaian mobile number in the form a gateway will take.
 *
 * Numbers get typed into a record however the person happened to write them
 * down: `024 123 4567`, `+233 24 123 4567`, `00233241234567`. All three are
 * the same phone. Anything that does not come out as a ten-digit local number
 * beginning 02, 05 or 03 is handed back as null rather than guessed at, since
 * a text sent to a wrong number is worse than one not sent.
 */
export function ghanaNumber(value) {
  const digits = String(value ?? '').replace(/[^\d+]/g, '');
  if (!digits) return null;

  let local = digits.replace(/^\+/, '');
  if (local.startsWith('00233')) local = local.slice(5);
  else if (local.startsWith('233')) local = local.slice(3);
  else if (local.startsWith('0')) local = local.slice(1);
  else if (local.length === 9) { /* already bare, as in 241234567 */ }
  else return null;

  // Nine digits after the leading zero, and a network prefix that exists here.
  if (!/^[235]\d{8}$/.test(local)) return null;
  return `+233${local}`;
}

/** The first of a person's numbers that a gateway would accept. */
export function firstUsableNumber(...values) {
  for (const value of values) {
    const number = ghanaNumber(value);
    if (number) return number;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Gateways
// ---------------------------------------------------------------------------

export const PROVIDERS = ['arkesel', 'mnotify', 'hubtel'];

/**
 * One message, through whichever gateway the property signed up with.
 *
 * All three are Ghanaian, all three speak HTTP, and none of them agrees with
 * the others about anything else. Hubtel wants two credentials, so the secret
 * is read as well as the key.
 */
async function handOver({ provider, apiKey, apiSecret, senderId, to, text }) {
  if (provider === 'arkesel') {
    const response = await fetch('https://sms.arkesel.com/api/v2/sms/send', {
      method: 'POST',
      headers: { 'api-key': apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ sender: senderId, message: text, recipients: [to] }),
    });
    return response;
  }

  if (provider === 'mnotify') {
    const response = await fetch(
      `https://api.mnotify.com/api/sms/quick?key=${encodeURIComponent(apiKey)}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          recipient: [to],
          sender: senderId,
          message: text,
          is_schedule: false,
          schedule_date: '',
        }),
      },
    );
    return response;
  }

  if (provider === 'hubtel') {
    const auth = btoa(`${apiKey}:${apiSecret}`);
    const response = await fetch('https://sms.hubtel.com/v1/messages/send', {
      method: 'POST',
      headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ From: senderId, To: to, Content: text }),
    });
    return response;
  }

  throw new Error(`No such SMS gateway: ${provider}`);
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

/**
 * What is set up, and whether it is enough to send with.
 *
 * The credentials come from Worker secrets rather than the settings table, the
 * same way the email key does. Everything else is typed into Setup.
 */
export function smsSetup(settings = {}, env = {}) {
  const provider = PROVIDERS.includes(settings.sms_provider) ? settings.sms_provider : 'arkesel';
  const senderId = String(settings.sms_sender ?? '').trim();
  const apiKey = String(env?.SMS_API_KEY ?? '').trim();
  const apiSecret = String(env?.SMS_API_SECRET ?? '').trim();

  const missing = [];
  if (!apiKey) missing.push('SMS_API_KEY');
  if (provider === 'hubtel' && !apiSecret) missing.push('SMS_API_SECRET');
  if (!senderId) missing.push('a sender name');

  return {
    provider,
    senderId,
    apiKey,
    apiSecret,
    on: settings.sms_enabled === '1',
    // Who gets a text: everybody whose week changed, or only the ones whose
    // phone cannot show an alert. The second is the default because it is the
    // reason this was built and it is the cheaper of the two.
    reach: settings.sms_reach === 'all' ? 'all' : 'gap',
    ready: missing.length === 0,
    missing,
  };
}

/** A sender name a gateway will register: letters and digits, eleven at most. */
export function senderId(value) {
  return String(value ?? '').replace(/[^A-Za-z0-9 ]/g, '').trim().slice(0, 11);
}

// ---------------------------------------------------------------------------
// Sending
// ---------------------------------------------------------------------------

/**
 * A text costs money and a run of them can cost a lot of it, so a single
 * publish is capped. Nobody rosters two hundred people in one go; a number
 * that high means something has gone wrong upstream and should stop rather
 * than spend.
 */
export const MOST_IN_ONE_GO = 200;

/**
 * Send, and write down what happened.
 *
 * Never throws. A gateway being down is not a reason for a rota to fail to
 * publish, and the log is there for when somebody says they were not told.
 *
 * A message may carry a `ref` of the caller's own choosing, and the answer
 * says what became of each one. Totals answer "did the run work"; the refs
 * answer "did it work for her", which is the question actually asked when
 * somebody says they heard nothing.
 */
export async function sendTexts(db, env, { messages, kind, day = null }) {
  const list = (messages ?? []).filter((m) => m && m.to && m.text);
  if (!list.length) return { sent: 0, failed: 0, reason: 'nobody to text', each: new Map() };

  let settings = {};
  try {
    const rows = await db.prepare('SELECT key, value FROM settings').all();
    settings = Object.fromEntries((rows.results ?? []).map((r) => [r.key, r.value]));
  } catch {
    return { sent: 0, failed: 0, reason: 'settings unreadable', each: new Map() };
  }

  // Switched off for this kind under Notifications. A text costs money, so
  // this one is worth being able to turn off on its own.
  if (!goesOut(readChannels(settings[CHANNELS_KEY]), kind, 'text')) {
    return { sent: 0, failed: 0, reason: 'switched off for this kind', each: new Map() };
  }

  const setup = smsSetup(settings, env);
  if (!setup.on) return { sent: 0, failed: 0, reason: 'switched off', each: new Map() };
  if (!setup.ready) {
    return {
      sent: 0, failed: 0, reason: `not set up: ${setup.missing.join(', ')}`, each: new Map(),
    };
  }

  const going = list.slice(0, MOST_IN_ONE_GO);
  let sent = 0;
  let failed = 0;
  let firstFault = null;
  // What became of each message, keyed by whatever the caller put on it.
  const each = new Map();

  for (const one of going) {
    try {
      const response = await handOver({
        provider: setup.provider,
        apiKey: setup.apiKey,
        apiSecret: setup.apiSecret,
        senderId: senderId(setup.senderId),
        to: one.to,
        text: one.text,
      });
      if (!response.ok) {
        const detail = await response.text().catch(() => '');
        throw new Error(`${response.status}: ${detail.slice(0, 160)}`);
      }
      sent += 1;
      if (one.ref != null) each.set(one.ref, true);
    } catch (err) {
      failed += 1;
      if (one.ref != null) each.set(one.ref, false);
      if (!firstFault) firstFault = String(err.message ?? err).slice(0, 300);
    }
  }

  const skipped = list.length - going.length;
  const status = failed && !sent ? 'failed' : failed ? 'part sent' : 'sent';
  const detail = [
    firstFault,
    skipped ? `${skipped} not attempted, over the ${MOST_IN_ONE_GO} cap` : null,
  ].filter(Boolean).join('; ') || null;

  await note(db, {
    kind, day, recipients: going.map((m) => m.to).join(', '), sent, status, detail,
  });

  return { sent, failed, skipped, status, detail, each };
}

/** One line in the log, and never a reason to fail whatever called it. */
async function note(db, { kind, day, recipients, sent, status, detail }) {
  try {
    await db.prepare(
      `INSERT INTO sms_log (kind, day, recipients, sent, status, detail)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6)`,
    ).bind(
      String(kind).slice(0, 40),
      day ?? null,
      String(recipients ?? '').slice(0, 2000) || null,
      Number(sent) || 0,
      status,
      detail == null ? null : String(detail).slice(0, 500),
    ).run();
  } catch (err) {
    if (!isMissingTable(err)) console.error('sms not logged', err);
  }
}
