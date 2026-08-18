#!/usr/bin/env node
//
// One command instead of four fiddly ones.
//
// Creating a database, copying its id into a config file by hand, remembering
// to apply the migrations and then working out which secrets are still missing
// is four chances to make a typo that surfaces as an unhelpful error a day
// later. This does all of it, is safe to run twice, and finishes by printing
// exactly what is left for a person to do.
//
//   npm run setup
//
// It changes nothing outside this directory and asks Cloudflare for nothing it
// does not need. Every step says what it is doing before it does it.

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { setBinding, disableBinding } from './wrangler-config.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const CONFIG = join(here, '..', 'wrangler.toml');

const say = (message) => process.stdout.write(`${message}\n`);
const step = (message) => say(`\n\x1b[1m${message}\x1b[0m`);
const ok = (message) => say(`  \x1b[32m✓\x1b[0m ${message}`);
const note = (message) => say(`  \x1b[2m${message}\x1b[0m`);
const warn = (message) => say(`  \x1b[33m!\x1b[0m ${message}`);

function wrangler(args, { allowFail = false } = {}) {
  try {
    return execFileSync('npx', ['wrangler', ...args], {
      encoding: 'utf8',
      stdio: ['inherit', 'pipe', 'pipe'],
      cwd: join(here, '..'),
    });
  } catch (err) {
    if (allowFail) return null;
    const detail = `${err.stdout ?? ''}${err.stderr ?? ''}`.trim();
    throw new Error(`\`wrangler ${args.join(' ')}\` failed.\n\n${detail}`);
  }
}

/** Every D1 database on this account, by name. */
function listDatabases() {
  const raw = wrangler(['d1', 'list', '--json'], { allowFail: true });
  if (!raw) return null;
  try {
    // Wrangler prints its own banner above the JSON, so take from the first
    // bracket rather than assuming the whole of stdout is the document.
    const start = raw.indexOf('[');
    return start === -1 ? [] : JSON.parse(raw.slice(start));
  } catch {
    return [];
  }
}

const idOf = (databases, name) => {
  const row = databases?.find((d) => d.name === name);
  return row?.uuid ?? row?.database_id ?? null;
};

// ---------------------------------------------------------------------------

say('\n\x1b[1mSetting up Insight\x1b[0m');
note('Creating the warehouse, wiring the databases it reads, and applying the migrations.');

step('1. Checking you are signed in to Cloudflare');
const who = wrangler(['whoami'], { allowFail: true });

// Three different failures with three different fixes, and telling them apart
// is most of what makes a setup script worth running: "it did not work" sends
// somebody to a search engine, "run npx wrangler login" sends them to a prompt.
if (who === null) {
  warn('Could not run wrangler at all.');
  note('Run `npm install` in this directory first, then try again.');
  process.exit(1);
}
if (/not authenticated|you are not logged in|not logged in/i.test(who)) {
  warn('Wrangler ran, but you are not signed in to Cloudflare.');
  note('Run `npx wrangler login` — or set CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID — and try again.');
  process.exit(1);
}
ok(who.match(/([^\s@]+@[^\s@]+\.[^\s@.]+)/)?.[1] ?? 'signed in');

step('2. The warehouse database');
let databases = listDatabases();
let insightId = idOf(databases, 'insight');

if (insightId) {
  ok(`insight already exists — ${insightId}`);
  note('Nothing created. This script is safe to run again.');
} else {
  note('Creating a D1 database called "insight"…');
  wrangler(['d1', 'create', 'insight']);
  databases = listDatabases();
  insightId = idOf(databases, 'insight');
  if (!insightId) {
    warn('Created it, but could not read its id back.');
    note('Run `npx wrangler d1 list` and paste the id into wrangler.toml under the DB binding.');
    process.exit(1);
  }
  ok(`created — ${insightId}`);
}

step('3. Wiring up wrangler.toml');
let config = readFileSync(CONFIG, 'utf8');

const warehouse = setBinding(config, 'DB', insightId);
config = warehouse.config;
ok(`DB → insight (${insightId})`);

// The two databases this app reads. Both optional: it copes with either
// missing, and says on every screen what it could not see.
for (const [binding, name, what] of [
  ['ATT_DB', 'attendance', 'attendance'],
  ['BREAKFAST_DB', 'breakfast', 'breakfast, housekeeping and maintenance'],
]) {
  const id = idOf(databases, name);
  if (id) {
    config = setBinding(config, binding, id).config;
    ok(`${binding} → ${name} (${id})`);
  } else {
    config = disableBinding(config, binding).config;
    warn(`no database called "${name}" on this account — ${binding} left switched off`);
    note(`Insight will run without it and say so; it just will not see ${what}.`);
  }
}

writeFileSync(CONFIG, config);
ok('wrangler.toml written');

step('4. Creating the tables');
wrangler(['d1', 'migrations', 'apply', 'insight', '--remote']);
ok('migrations applied');

step('5. What is left for you');
const secrets = [
  ['SESSION_SECRET', 'signs session cookies', true],
  ['DASHBOARD_PASSWORD', 'the password you will type the first time', true],
  ['POS_REPORTS_KEY', 'reads the restaurant POS, when you have its key', false],
  ['LAUNDRY_TOKEN', 'reads the laundry, when you have its token', false],
  ['SSO_SECRET_ATTENDANCE', 'hands people over to attendance without a second sign-in', false],
];

say('');
say('  Required — it will not sign anybody in without these two:');
for (const [name, why, required] of secrets.filter((s) => s[2])) {
  say(`    npx wrangler secret put ${name}`.padEnd(48) + `\x1b[2m# ${why}\x1b[0m`);
}
say('');
say('  Optional, add them whenever you like:');
for (const [name, why] of secrets.filter((s) => !s[2])) {
  say(`    npx wrangler secret put ${name}`.padEnd(48) + `\x1b[2m# ${why}\x1b[0m`);
}
say('');
note('For SESSION_SECRET and any SSO_SECRET_*, paste the output of:  openssl rand -base64 32');
note('Use a different value for every SSO_SECRET_*, or a compromised system can mint sessions on the others.');

say('\n  Then:');
say('    npm run deploy');
say('\n  Open the site, sign in with DASHBOARD_PASSWORD, and go to Setup → Load and re-read now.');
say('  It starts in demonstration mode, so there will be something on every screen immediately.\n');
