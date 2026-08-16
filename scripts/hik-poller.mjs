#!/usr/bin/env node
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

/**
 * The on-site attendance poller.
 *
 * Reads the access-control event log out of a Hikvision terminal over ISAPI and
 * posts it to the app. Runs on any always-on machine on the same network as the
 * terminal — a Raspberry Pi, the front desk PC, anything that can be left alone.
 *
 * Why this exists rather than the app fetching directly: the app is a Cloudflare
 * Worker and the terminal is on a private network with no public address, so
 * nothing in the cloud can reach it. The alternative is putting an access
 * control terminal on the open internet, which is a bad idea in general and a
 * worse one for a device family with the CVE history this one has.
 *
 * Deliberately dependency-free. This has to keep running on a machine nobody
 * maintains, and every package it does not have is a package that cannot break
 * it eighteen months from now.
 *
 *   Setup
 *   -----
 *   1. Register the terminal in the app: Attendance → Setup → Terminals. Copy
 *      the token it shows you — that is the only time it is readable.
 *   2. Copy .hik-poller.json.example to .hik-poller.json and fill it in, or set
 *      the environment variables below.
 *   3. Try it:      node scripts/hik-poller.mjs --once --verbose
 *   4. Backfill:    node scripts/hik-poller.mjs --from 2026-06-01 --to 2026-08-15
 *   5. Shifts:      node scripts/hik-poller.mjs --shifts --verbose
 *   6. Leave it on: node scripts/hik-poller.mjs        (polls every 5 minutes)
 *
 *   Configuration, in order of precedence: command line, environment, config file.
 *
 *     HIK_HOST         http://192.168.1.64      the terminal on the LAN
 *     HIK_USER         admin
 *     HIK_PASSWORD     ...
 *     APP_URL          https://breakfast.example.com
 *     APP_DEVICE       DS-K1T321MFWX20241227...  the serial registered in the app
 *     APP_TOKEN        ...                       from Attendance → Setup
 *     POLL_SECONDS     300
 *     LOOKBACK_MINUTES 120
 */

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const ARGS = parseArgs(process.argv.slice(2));
const CONFIG_PATH = ARGS.config || process.env.HIK_CONFIG || '.hik-poller.json';
const FILE = readConfigFile(CONFIG_PATH);

const CONFIG = {
  host: pick('host', 'HIK_HOST', 'http://192.168.1.64'),
  user: pick('user', 'HIK_USER', 'admin'),
  password: pick('password', 'HIK_PASSWORD', ''),
  appUrl: pick('appUrl', 'APP_URL', ''),
  device: pick('device', 'APP_DEVICE', ''),
  token: pick('token', 'APP_TOKEN', ''),
  pollSeconds: Number(pick('pollSeconds', 'POLL_SECONDS', 300)),
  // How far back each poll reaches. Generously more than the poll interval on
  // purpose — see the note on overlap below.
  lookbackMinutes: Number(pick('lookbackMinutes', 'LOOKBACK_MINUTES', 120)),
  statePath: pick('statePath', 'HIK_STATE', '.hik-poller-state.json'),
  insecure: Boolean(pick('insecure', 'HIK_INSECURE', false)),
  verbose: Boolean(ARGS.verbose || process.env.HIK_VERBOSE),
};

function pick(key, envKey, fallback) {
  if (ARGS[key] !== undefined) return ARGS[key];
  if (process.env[envKey] !== undefined && process.env[envKey] !== '') return process.env[envKey];
  if (FILE[key] !== undefined) return FILE[key];
  return fallback;
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--')) continue;
    const key = arg.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) out[key] = true;
    else { out[key] = next; i += 1; }
  }
  return out;
}

function readConfigFile(file) {
  try {
    return JSON.parse(fs.readFileSync(path.resolve(file), 'utf8'));
  } catch {
    return {};
  }
}

// ---------------------------------------------------------------------------
// Digest authentication
//
// Hikvision terminals default to HTTP digest and most firmware refuses basic
// outright. It is thirty lines and one dependency avoided.
// ---------------------------------------------------------------------------

const md5 = (value) => crypto.createHash('md5').update(value).digest('hex');

export function parseChallenge(header) {
  const out = {};
  const body = header.replace(/^Digest\s+/i, '');
  for (const match of body.matchAll(/(\w+)=(?:"([^"]*)"|([^,]*))/g)) {
    out[match[1]] = match[2] ?? match[3]?.trim();
  }
  return out;
}

let nonceCount = 0;

export function digestHeader(challenge, { method, uri, user, password }) {
  const cnonce = crypto.randomBytes(8).toString('hex');
  nonceCount += 1;
  const nc = String(nonceCount).padStart(8, '0');

  const ha1 = md5(`${user}:${challenge.realm}:${password}`);
  const ha2 = md5(`${method}:${uri}`);
  const qop = challenge.qop?.split(',')[0].trim();

  const response = qop
    ? md5(`${ha1}:${challenge.nonce}:${nc}:${cnonce}:${qop}:${ha2}`)
    : md5(`${ha1}:${challenge.nonce}:${ha2}`);

  const parts = [
    `username="${user}"`,
    `realm="${challenge.realm}"`,
    `nonce="${challenge.nonce}"`,
    `uri="${uri}"`,
    `response="${response}"`,
  ];
  if (qop) parts.push(`qop=${qop}`, `nc=${nc}`, `cnonce="${cnonce}"`);
  if (challenge.opaque) parts.push(`opaque="${challenge.opaque}"`);
  if (challenge.algorithm) parts.push(`algorithm=${challenge.algorithm}`);
  return `Digest ${parts.join(', ')}`;
}

/**
 * One ISAPI call, with the 401-then-retry that digest requires.
 *
 * The first request is expected to fail; that is how the challenge is obtained.
 * Anything other than a 401 on the first attempt means the device is not asking
 * for digest, and the response is returned as-is.
 */
async function isapi(pathname, { method = 'GET', body = null } = {}) {
  const url = new URL(pathname, CONFIG.host);
  const uri = url.pathname + url.search;
  const headers = { Accept: 'application/json' };
  if (body) headers['Content-Type'] = 'application/json';

  const first = await fetch(url, { method, headers, body });
  if (first.status !== 401) return first;

  const challenge = first.headers.get('www-authenticate');
  if (!challenge) throw new Error(`${url} refused the request and offered no way to authenticate.`);

  return fetch(url, {
    method,
    headers: {
      ...headers,
      Authorization: digestHeader(parseChallenge(challenge), {
        method, uri, user: CONFIG.user, password: CONFIG.password,
      }),
    },
    body,
  });
}

// ---------------------------------------------------------------------------
// The terminal
// ---------------------------------------------------------------------------

/** Serial, model and firmware — used to confirm the right box is answering. */
async function deviceInfo() {
  const response = await isapi('/ISAPI/System/deviceInfo?format=json');
  if (!response.ok) throw new Error(`The terminal answered ${response.status} to a device info request.`);
  const data = await response.json();
  const info = data.DeviceInfo ?? data;
  return {
    serial: info.serialNumber ?? null,
    model: info.model ?? null,
    firmware: info.firmwareVersion ?? null,
    name: info.deviceName ?? null,
  };
}

/** ISAPI wants local time with an explicit offset. */
export function isapiTime(date) {
  const pad = (n) => String(n).padStart(2, '0');
  const offset = -date.getTimezoneOffset();
  const sign = offset >= 0 ? '+' : '-';
  const abs = Math.abs(offset);
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
    + `T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
    + `${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}

const PAGE = 30;

/**
 * Every access-control event between two times.
 *
 * The search is stateful on the device: a `searchID` is held for the duration
 * and `searchResultPosition` walks through the matches, with
 * `responseStatusStrg` saying whether there is MORE to come. Page size is kept
 * at thirty because larger pages make some firmware return an empty list
 * instead of an error, which is a very annoying failure to debug.
 *
 * `major: 5` is the access-control event class. The minor codes vary between
 * models and firmware, so nothing is filtered on them here — every event
 * carrying an employee number is sent on, and the app decides what counts.
 * Filtering at this end would mean a firmware update silently dropping punches.
 */
async function fetchEvents(from, to) {
  const searchID = crypto.randomUUID();
  const events = [];
  let position = 0;

  for (let page = 0; page < 400; page++) {
    const response = await isapi('/ISAPI/AccessControl/AcsEvent?format=json', {
      method: 'POST',
      body: JSON.stringify({
        AcsEventCond: {
          searchID,
          searchResultPosition: position,
          maxResults: PAGE,
          major: 5,
          minor: 0,
          startTime: isapiTime(from),
          endTime: isapiTime(to),
        },
      }),
    });

    if (!response.ok) {
      throw new Error(`The terminal answered ${response.status} to an event search. `
        + `${response.status === 401 ? 'Check the username and password.' : ''}`);
    }

    const data = await response.json();
    const result = data.AcsEvent ?? {};
    const list = result.InfoList ?? [];
    events.push(...list.filter((e) => e.employeeNoString || e.employeeNo));

    const status = String(result.responseStatusStrg ?? '').toUpperCase();
    if (status !== 'MORE' || !list.length) break;
    position += list.length;
  }

  return events;
}

// ---------------------------------------------------------------------------
// What the terminal knows about its own shifts
// ---------------------------------------------------------------------------

/**
 * The endpoints worth asking for attendance configuration.
 *
 * A device in automatic attendance mode carries the time bands that decide
 * whether a tap is a check-in or a check-out, and those bands come down from
 * wherever the shifts were set up — Hik-Connect, the device menus, iVMS. Reading
 * them is what saves somebody typing their shifts in twice.
 *
 * Every one of these is probed rather than assumed. ISAPI's surface differs
 * between models and firmware, a 404 here is ordinary rather than a fault, and
 * the app is built to take whatever shape comes back. Being wrong about an
 * endpoint should cost a line in the log, not the run.
 */
const CONFIG_PROBES = [
  { kind: 'attendanceMode', path: '/ISAPI/AccessControl/attendanceStatusModeCfg?format=json' },
  { kind: 'attendanceRules', path: '/ISAPI/AccessControl/attendanceStatusRuleCfg?format=json' },
  { kind: 'attendanceRuleCaps', path: '/ISAPI/AccessControl/attendanceStatusRuleCfg/capabilities?format=json' },
  // Some firmware answers the list endpoint above with nothing useful and only
  // serves one status at a time.
  ...['checkIn', 'checkOut', 'breakOff', 'breakIn', 'overtimeIn', 'overtimeOut'].map((status) => ({
    kind: `attendanceRule:${status}`,
    path: `/ISAPI/AccessControl/attendanceStatusRuleCfg?attendanceStatus=${status}&format=json`,
  })),
];

/**
 * Ask the terminal for each of them, and keep whatever answers.
 *
 * Nothing is parsed here. The poller's job is to fetch and forward; deciding
 * what a band means is the app's, where it can be changed without going back to
 * every machine running one of these.
 */
async function probeConfig() {
  const found = [];

  for (const probe of CONFIG_PROBES) {
    try {
      const response = await isapi(probe.path);
      if (!response.ok) {
        debug(`${probe.kind}: ${response.status}`);
        found.push({ ...probe, status: 'unsupported', raw: null });
        continue;
      }

      const text = await response.text();
      let raw;
      try {
        raw = JSON.parse(text);
      } catch {
        // XML, or an error page wearing a 200. Forwarded as a string so the app
        // can show somebody what actually came back.
        raw = { _text: text.slice(0, 4000) };
      }

      debug(`${probe.kind}: ok`);
      found.push({ ...probe, status: 'ok', raw });
    } catch (err) {
      debug(`${probe.kind}: ${err.message}`);
      found.push({ ...probe, status: 'failed', raw: null });
    }
  }

  return found;
}

async function sendConfig(config) {
  const url = new URL('/api/att/device-config', CONFIG.appUrl);
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Device-Token': CONFIG.token },
    body: JSON.stringify({
      serial: CONFIG.device,
      token: CONFIG.token,
      config: config.map(({ kind, path, raw, status }) => ({ kind, path, raw, status })),
    }),
  });

  const text = await response.text();
  if (!response.ok) throw new Error(`The app answered ${response.status}: ${text.slice(0, 300)}`);
  return JSON.parse(text);
}

/** One configuration sync, reported plainly enough to debug a terminal with. */
async function configPass() {
  const config = await probeConfig();
  const ok = config.filter((c) => c.status === 'ok');

  if (!ok.length) {
    warn('the terminal answered none of the attendance configuration endpoints.');
    warn('that is normal for a device not in automatic attendance mode — the app will work the '
      + 'shifts out from the punches instead. Nothing is broken.');
  } else {
    log(`${ok.length} of ${config.length} configuration endpoint(s) answered`);
  }

  await sendConfig(config);
  return { probed: config.length, answered: ok.length };
}

// ---------------------------------------------------------------------------
// The app
// ---------------------------------------------------------------------------

const BATCH = 200;

async function send(events) {
  const url = new URL('/api/att/ingest', CONFIG.appUrl);
  const totals = { received: 0, stored: 0, duplicates: 0, unknown: new Set() };

  for (let i = 0; i < events.length; i += BATCH) {
    const slice = events.slice(i, i + BATCH);
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Device-Token': CONFIG.token },
      body: JSON.stringify({ serial: CONFIG.device, token: CONFIG.token, source: 'poller', events: slice }),
    });

    const text = await response.text();
    if (!response.ok) {
      throw new Error(`The app answered ${response.status}: ${text.slice(0, 300)}`);
    }

    const result = JSON.parse(text);
    totals.received += result.received ?? 0;
    totals.stored += result.stored ?? 0;
    totals.duplicates += result.duplicates ?? 0;
    for (const employee of result.unknownEmployees ?? []) totals.unknown.add(employee);
  }

  return totals;
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

function readState() {
  try {
    return JSON.parse(fs.readFileSync(path.resolve(CONFIG.statePath), 'utf8'));
  } catch {
    return {};
  }
}

function writeState(state) {
  try {
    fs.writeFileSync(path.resolve(CONFIG.statePath), `${JSON.stringify(state, null, 2)}\n`);
  } catch (err) {
    warn(`Could not write ${CONFIG.statePath}: ${err.message}`);
  }
}

// ---------------------------------------------------------------------------
// Running
// ---------------------------------------------------------------------------

const log = (message) => console.log(`${new Date().toISOString().slice(0, 19)}  ${message}`);
const warn = (message) => console.warn(`${new Date().toISOString().slice(0, 19)}  ! ${message}`);
const debug = (message) => { if (CONFIG.verbose) log(`  ${message}`); };

/**
 * One pass.
 *
 * The window always overlaps the last one. A poller that asked only for "since
 * I last looked" would lose any punch that landed during the second the request
 * was in flight, and would lose an hour of them if the machine slept. Re-sending
 * events the app already holds costs nothing — they are deduplicated on arrival
 * by the device's own event serial.
 */
/** Twelve hours. A shift definition does not change hourly. */
const CONFIG_INTERVAL_MS = 12 * 60 * 60 * 1000;

async function pass({ from = null, to = null } = {}) {
  const now = new Date();
  const state = readState();

  const start = from
    ? new Date(`${from}T00:00:00`)
    : new Date(now.getTime() - CONFIG.lookbackMinutes * 60_000);
  const end = to ? new Date(`${to}T23:59:59`) : now;

  debug(`asking the terminal for ${isapiTime(start)} to ${isapiTime(end)}`);
  const events = await fetchEvents(start, end);

  if (!events.length) {
    debug('nothing in that window');
    writeState({ ...state, lastRunAt: now.toISOString(), lastEventCount: 0 });
    return { events: 0 };
  }

  const result = await send(events);
  log(`${events.length} event(s) read, ${result.stored} new, ${result.duplicates} already held`);

  if (result.unknown.size) {
    warn(`the terminal is sending employee numbers nobody here recognises: ${[...result.unknown].join(', ')}`);
    warn('add them in Attendance → Setup → Staff. Their punches are being kept and will be attached.');
  }

  writeState({
    ...state,
    lastRunAt: now.toISOString(),
    lastEventCount: events.length,
    lastStored: result.stored,
  });

  return { events: events.length, ...result };
}

/**
 * Re-read the terminal's shift configuration, but rarely.
 *
 * Twice a day is plenty for something that changes when a manager sits down and
 * rearranges the rota, and it keeps a dozen extra requests off a device whose
 * real job is recognising faces at the door.
 */
async function maybeSyncConfig() {
  const state = readState();
  const last = state.lastConfigAt ? Date.parse(state.lastConfigAt) : 0;
  if (Number.isFinite(last) && Date.now() - last < CONFIG_INTERVAL_MS) return;

  try {
    const result = await configPass();
    writeState({ ...readState(), lastConfigAt: new Date().toISOString(), lastConfig: result });
  } catch (err) {
    // Never fatal. The punches are the job; the shifts are a convenience.
    warn(`configuration sync failed: ${err.message}`);
  }
}

async function main() {
  if (CONFIG.insecure) {
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
    warn('TLS verification is off. Acceptable on a LAN with the terminal\'s self-signed certificate, '
      + 'and not acceptable for anything else.');
  }

  const missing = ['host', 'password', 'appUrl', 'device', 'token'].filter((key) => !CONFIG[key]);
  if (missing.length) {
    console.error(`Missing configuration: ${missing.join(', ')}.`);
    console.error(`Set them in ${CONFIG_PATH}, or as environment variables. See the top of this file.`);
    process.exit(1);
  }

  // Confirm the box answering is the one registered, before sending anything.
  // A serial mismatch means either the wrong address or the wrong registration,
  // and both produce attendance data quietly attributed to the wrong terminal.
  let info = null;
  try {
    info = await deviceInfo();
    log(`terminal: ${info.model ?? 'unknown model'} ${info.firmware ?? ''} serial ${info.serial ?? 'unknown'}`);
    if (info.serial && CONFIG.device && info.serial !== CONFIG.device) {
      warn(`the terminal reports serial ${info.serial} but this poller is configured for ${CONFIG.device}.`);
      warn('punches will be filed under the configured serial. Fix one or the other.');
    }
  } catch (err) {
    warn(`could not read device info: ${err.message}`);
  }

  // Named --shifts rather than --config, which already means "the config file".
  if (ARGS.shifts) {
    const result = await configPass();
    log(`${result.answered} of ${result.probed} endpoint(s) answered — see Attendance → Setup → Shifts`);
    return;
  }

  if (ARGS.from || ARGS.to) {
    const from = ARGS.from === true ? null : ARGS.from;
    const to = ARGS.to === true ? null : ARGS.to;
    log(`backfilling ${from ?? 'the lookback window'} to ${to ?? 'now'}`);
    await pass({ from, to });
    return;
  }

  if (ARGS.once) {
    await pass();
    await maybeSyncConfig();
    return;
  }

  log(`polling every ${CONFIG.pollSeconds}s, looking back ${CONFIG.lookbackMinutes} minutes each time`);
  for (;;) {
    try {
      await pass();
      await maybeSyncConfig();
    } catch (err) {
      // Never exit on a failed pass. The terminal reboots, the network drops,
      // the app is redeployed — all of them are ordinary, and all of them are
      // survivable because the next pass asks for an overlapping window.
      warn(err.message);
    }
    await new Promise((resolve) => setTimeout(resolve, CONFIG.pollSeconds * 1000));
  }
}

// Only when run, not when imported — the helpers above are unit tested, and a
// test run must not start polling a terminal.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}
