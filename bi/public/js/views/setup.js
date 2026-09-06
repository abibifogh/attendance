import { add, h, money, num } from '../util.js';
import { api } from '../api.js';
import { table, banner } from './components.js';
import { state } from '../app.js';

/**
 * Where the four systems are connected.
 *
 * Two of them are Cloudflare databases in the same account as this Worker and
 * are bound directly in `wrangler.toml` — there is nothing to type here and no
 * key to rotate. The other two are read over HTTP and need an address, which
 * is configuration, and a key, which is a secret and is not accepted by this
 * screen at any price.
 */
export async function renderSetup(root) {
  const [sources, runs] = await Promise.all([api('/sources'), api('/runs')]);
  const boot = state.boot || {};

  add(root, 
    sources.demoMode ? banner('demo',
      h('strong', 'Demonstration mode is on. '),
      'Every screen is showing invented figures and the connectors below are not being called at all. Switch it off once a real source is reading.',
      h('div', { style: { marginTop: '.5rem' } },
        h('button.btn.primary', { onclick: leaveDemo }, 'Switch demonstration mode off'))) : null,

    h('div.card',
      h('h2', 'Databases you have mapped yourself'),
      h('p.sub', 'A Supabase database is somebody\'s own Postgres, so this app cannot know its tables — you say which table means what, once, and it reads them every night after that. Nothing needs to be in GitHub: this reads the database over its own API.'),
      sources.sources.filter((s) => s.kind === 'supabase_rest').map((source) => supabaseCard(source)),
      h('button.btn.primary', { onclick: addSupabase }, 'Add a Supabase database')),

    h('div.card',
      h('h2', 'The four systems'),
      h('p.sub', 'HIVE and the breakfast app are Cloudflare databases in this account, bound straight to this Worker: no key, no network, nothing to expire. The POS and the laundry are read over their own read-only APIs.'),
      sources.sources.map((source) => (source.kind === 'odoo_json2' ? odooCard(source) : sourceCard(source)))),

    h('div.card',
      h('h2', 'Loads'),
      h('p.sub', 'Every run, and what each source said. When a figure looks wrong, this is the first place to look: usually the day was never loaded.'),
      h('div.rangebar',
        h('button.btn.primary', { onclick: refresh }, 'Load and re-read now')),
      table([
        { label: 'Run', get: (r) => `#${r.id}` },
        { label: 'Window', get: (r) => `${r.from} → ${r.to}` },
        { label: 'Started', get: (r) => (r.startedAt || '').replace('T', ' ') },
        { label: 'Trigger', get: (r) => r.trigger },
        { label: 'Status', get: (r) => r.status },
        { label: 'Rows', num: true, get: (r) => num(r.rows) },
        { label: 'Per source', get: (r) => r.sources.map((s) => `${s.id}: ${s.status}`).join(' · ') },
      ], runs.runs)),

    h('div.card',
      h('h2', 'The cost no system records'),
      h('p.sub',
        'Rent, power, water, licences, depreciation. None of these is in the tills, the clock, the '
        + 'laundry, the kitchen or the books, because none of those is where a lease lives — and '
        + 'without it the Yardstick screen understates what a day has to take by exactly that '
        + 'amount. One number, in cedis a month, and it can be a rough one: a break-even that is '
        + 'approximately right beats one that is precisely wrong by the whole rent.'),
      standingCostForm(boot)),

    h('div.card',
      h('h2', 'Take the data away'),
      h('p.sub', 'One row per day per part of the business, with revenue, purchases, wages and contribution side by side. The point of a warehouse is that somebody can do something with it that nobody here thought of.'),
      h('a.btn', { href: `/api/export?from=${state.range.from}&to=${state.range.to}` }, 'Download CSV')),
  );

  function sourceCard(source) {
    const check = source.check || {};
    return h('div.card', { style: { marginBottom: '.7rem' } },
      h('h3', source.label, ' ', h(`span.pill.${check.ok ? 'good' : 'warning'}`,
        h('span.dot'), check.ok ? '✓ reading' : `! ${check.detail || 'not reading'}`)),
      h('p.small.muted', source.describes),
      source.transport === 'binding'
        ? h('p.small', 'Bound as ', h('code', source.config.binding || '—'),
          ' in wrangler.toml. To change it, change the binding and deploy.')
        : h('div',
          h('label.field', 'Address',
            h('input', {
              type: 'url', placeholder: 'https://reports.example.com',
              value: source.config.base || '', id: `base-${source.id}`,
            })),
          secretNote(source),
          h('button.btn', {
            onclick: async (event) => {
              const base = document.getElementById(`base-${source.id}`).value;
              event.target.disabled = true;
              try {
                await api(`/sources/${source.id}`, { method: 'POST', body: { base, enabled: true } });
                state.reload();
              } catch (err) {
                alert(err.message);
                event.target.disabled = false;
              }
            },
          }, 'Save address')),
      source.lastError ? h('p.small', { style: { color: 'var(--critical)' } },
        `Last error (${source.lastErrorAt}): ${source.lastError}`) : null);
  }

  /**
   * One mapped Supabase database.
   *
   * The mapping is edited as JSON. That is a deliberate choice rather than a
   * missing form: the shape is a list of tables with a handful of column names
   * each, it is set up once and touched about twice a year, and a form with
   * every field of every fact on it would be far harder to read than the six
   * lines of JSON it would produce. What the screen does owe is telling you
   * exactly what is wrong with what you typed, which it does, before saving.
   */
  function supabaseCard(source) {
    const problems = source.mappingProblems || [];
    const editor = h('textarea', {
      rows: 14,
      spellcheck: false,
      style: { width: '100%', fontFamily: 'ui-monospace, monospace', fontSize: '.8rem' },
      value: JSON.stringify({ schema: source.config.schema || 'public', tables: source.config.tables || [] }, null, 2),
    });

    return h('div.card', { style: { marginBottom: '.7rem' } },
      h('h3', source.label, ' ',
        source.check?.ok
          ? h('span.pill.good', h('span.dot'), '✓ reading')
          : h('span.pill.warning', h('span.dot'), `! ${source.check?.detail || 'not reading'}`)),
      h('p.small.muted', source.config.base || 'no address'),

      source.secretSet
        ? null
        : h('p.small', { style: { color: 'var(--critical)' } },
          'Its key is not set. Run ', h('code', `wrangler secret put ${source.secretName}`),
          ' with the project\'s service-role key, then deploy.'),

      problems.length
        ? h('div', h('p.small', { style: { color: 'var(--critical)', marginBottom: '.2rem' } }, 'This mapping will not load yet:'),
          h('ul.caveats', problems.map((p) => h('li', p))))
        : null,

      h('details.tableview', { open: problems.length > 0 },
        h('summary', 'Edit the mapping'),
        h('p.small.muted', 'One entry per table. ',
          h('code', 'fact'), ' is what it becomes here, ', h('code', 'from'), ' is the table or view, ',
          h('code', 'day'), ' is the column holding the date, and ', h('code', 'money'),
          ' must say whether the amounts are ', h('code', '"major"'), ' (12.50) or ', h('code', '"minor"'), ' (1250).'),
        editor,
        h('div', { style: { display: 'flex', gap: '.4rem', marginTop: '.5rem' } },
          h('button.btn.primary', {
            onclick: async (event) => {
              let parsed;
              try { parsed = JSON.parse(editor.value); }
              catch (err) { alert(`That is not valid JSON: ${err.message}`); return; }
              event.target.disabled = true;
              try {
                await api(`/sources/${source.id}/mapping`, { method: 'POST', body: parsed });
                state.reload();
              } catch (err) { alert(err.message); event.target.disabled = false; }
            },
          }, 'Save mapping'),
          h('button.btn', {
            onclick: async () => {
              if (!confirm(`Remove ${source.label}? Its rows stay in the warehouse until the next load replaces them.`)) return;
              try { await api(`/sources/${source.id}/remove`, { method: 'POST' }); state.reload(); }
              catch (err) { alert(err.message); }
            },
          }, 'Remove'))),
    );
  }

  async function addSupabase() {
    const id = prompt('A short name for this database, letters and numbers — it becomes part of its key\'s name.\n\ne.g. rooms');
    if (!id) return;
    const label = prompt('What is it, in words?', id) || id;
    const base = prompt('Its address\n\ne.g. https://abcdefgh.supabase.co');
    if (!base) return;
    try {
      const result = await api('/sources', { method: 'POST', body: { id, label, base } });
      const added = result.sources.find((s) => s.label === label || s.id === id);
      alert(`Added. Now set its key:\n\n  wrangler secret put ${added?.secretName ?? 'SUPABASE_KEY_…'}\n\nthen map its tables below.`);
      state.reload();
    } catch (err) { alert(err.message); }
  }

  async function refresh(event) {
    event.target.disabled = true;
    event.target.textContent = 'Loading…';
    try {
      const result = await api('/refresh', { method: 'POST', body: {} });
      alert(`Loaded ${result.etl.rows} rows for ${result.etl.from} → ${result.etl.to}, and found ${result.analysed.findings} things worth saying.`);
      state.reload();
    } catch (err) {
      alert(err.message);
      event.target.disabled = false;
      event.target.textContent = 'Load and re-read now';
    }
  }

  async function leaveDemo() {
    await api('/settings', { method: 'POST', body: { demo_mode: false } });
    await api('/refresh', { method: 'POST', body: {} });
    state.reload();
  }
}

/**
 * The monthly standing cost, in cedis, stored in pesewas.
 *
 * The conversion happens here and only here. Everything behind this box is
 * whole pesewas, and the one place a human types cedis is the one place they
 * have to be multiplied.
 */
function standingCostForm(boot) {
  const current = boot.assumptions?.standingCostMonthly ?? 0;
  const input = h('input', {
    type: 'number', min: '0', step: '1', value: String(current / 100),
    'aria-label': 'Standing cost a month, in cedis',
  });
  const said = h('span.muted.small');

  return h('div.rangebar',
    h('label', { style: { marginRight: '.5rem' } }, 'Standing cost a month'),
    input,
    h('button.btn.primary', {
      onclick: async () => {
        const cedis = Number(input.value);
        if (!Number.isFinite(cedis) || cedis < 0) { said.textContent = 'That is not an amount.'; return; }
        said.textContent = 'Saving…';
        try {
          await api('/settings', { method: 'POST', body: { standing_cost_monthly: Math.round(cedis * 100) } });
          said.textContent = `Saved. Break-even now includes ${money(Math.round(cedis * 100))} a month.`;
        } catch (e) { said.textContent = e.message || 'That did not save.'; }
      },
    }, 'Save'),
    said);
}

/**
 * How the key gets in — which is never through this page.
 *
 * A secret typed into a web form ends up in a browser history, a proxy log and
 * whatever restores that browser's tabs. It goes in as a repository secret and
 * reaches the Worker through the Actions workflow, and this says so in the
 * words of the buttons somebody actually presses rather than a terminal
 * command nobody here runs.
 */
function secretNote(source) {
  const name = source.secretName || '—';
  return h('p.small.muted',
    source.secretSet
      ? h('span', 'The key is set on the Worker. ')
      : h('strong', 'No key is set on the Worker yet. '),
    'It is never typed into this page. Put it in GitHub under ',
    h('strong', 'Settings → Secrets and variables → Actions'), ', then run ',
    h('strong', 'Actions → Set Insight’s secrets'), '. The Worker knows it as ',
    h('code', name), '.');
}

/**
 * Odoo, which needs more than an address.
 *
 * The generic card offers one box, because three of the five sources need one
 * box. Odoo needs four, and the last of them — how Odoo says which part of the
 * business a cost belongs to — decides whether any of this is worth reading.
 * Everything unmapped lands in admin, so a half-filled map does not break: it
 * produces a large admin figure that is itself the prompt to finish it.
 */
function odooCard(source) {
  const check = source.check || {};
  const config = source.config || {};
  const lines = (state.boot?.lines || []).map((l) => l.id);

  const address = h('input', {
    type: 'url', placeholder: 'https://yourcompany.odoo.com',
    value: config.base || '', id: 'odoo-base',
  });
  const database = h('input', {
    type: 'text', placeholder: 'usually blank', value: config.db || '', id: 'odoo-db',
  });
  const lineBy = h('select', { id: 'odoo-lineby' },
    ...[['analytic', 'Analytic account'], ['category', 'Product category'], ['journal', 'Journal']]
      .map(([value, label]) => h('option',
        { value, ...((config.lineBy || 'analytic') === value ? { selected: 'selected' } : {}) }, label)));
  const mapText = Object.entries(config.lineMap || {})
    .map(([from, to]) => `${from} = ${to}`).join('\n');
  const map = h('textarea', {
    id: 'odoo-map', rows: '7', spellcheck: 'false',
    placeholder: 'Kitchen = restaurant\nBar = bar\nLaundry = laundry',
  });
  map.value = mapText;

  const said = h('p.small');

  return h('div.card', { style: { marginBottom: '.7rem' } },
    h('h3', source.label, ' ', h(`span.pill.${check.ok ? 'good' : 'warning'}`,
      h('span.dot'), check.ok ? '✓ reading' : `! ${check.detail || 'not reading'}`)),
    h('p.small.muted', source.describes),

    h('label.field', 'Address',
      address,
      h('span.small.muted', 'Just the address, nothing after it. A custom domain is fine. '
        + 'Anything on the end is discarded rather than rejected.')),

    h('label.field', 'Database',
      database,
      h('span.small.muted', 'Leave this blank unless Check complains about it. Odoo needs it only '
        + 'where one address serves several databases — and with a custom domain it is not the '
        + 'subdomain, so guessing it is worse than leaving it empty.')),

    secretNote(source),

    h('label.field', 'How Odoo says which part of the business a cost belongs to',
      lineBy,
      h('span.small.muted', 'Open a recent vendor bill and look at a line. Whichever of these '
        + 'distinguishes a restaurant purchase from a laundry one is the answer.')),

    h('label.field', 'What each value means',
      map,
      h('span.small.muted', 'One per line, as ', h('code', 'Odoo value = part of the business'),
        '. The parts are: ', h('code', lines.join(', ') || 'none loaded'),
        '. Anything not listed here lands in admin on purpose — an unexplained lump of admin cost '
        + 'is a prompt to finish this box, where spreading it quietly across the lines that earn '
        + 'would flatter every one of them.')),

    h('div.rangebar',
      h('button.btn.primary', {
        id: 'odoo-save',
        onclick: async (event) => {
          event.target.disabled = true;
          said.textContent = 'Saving, then asking Odoo…';
          try {
            const lineMap = {};
            for (const row of map.value.split('\n')) {
              const at = row.indexOf('=');
              if (at < 0) continue;
              const from = row.slice(0, at).trim();
              const to = row.slice(at + 1).trim();
              if (from && to) lineMap[from] = to;
            }
            // Saving and checking are one button on purpose. They were two
            // steps in the instructions and nobody would press the second.
            const after = await api(`/sources/${source.id}`, {
              method: 'POST',
              body: {
                base: address.value.trim(), db: database.value.trim(),
                lineBy: lineBy.value, lineMap, enabled: true,
              },
            });
            const mine = after.sources.find((x) => x.id === source.id);
            said.textContent = mine?.check?.ok
              ? `Saved. ${mine.check.detail}`
              : `Saved, but Odoo did not answer: ${mine?.check?.detail || 'no reason given'}`;
            said.style.color = mine?.check?.ok ? 'var(--good-text)' : 'var(--critical)';
          } catch (err) {
            said.textContent = err.message || 'That did not save.';
            said.style.color = 'var(--critical)';
          }
          event.target.disabled = false;
        },
      }, 'Save and check'),
      said),

    source.lastError ? h('p.small', { style: { color: 'var(--critical)' } },
      `Last error (${source.lastErrorAt}): ${source.lastError}`) : null);
}
