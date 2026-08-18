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
      sources.sources.map((source) => sourceCard(source))),

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
          h('p.small.muted', 'The key is a Worker secret, not a setting: ',
            h('code', `wrangler secret put ${source.id === 'pos' ? 'POS_REPORTS_KEY' : 'LAUNDRY_TOKEN'}`),
            '. It is never typed into this page, because a secret typed into a web form ends up in a browser history and a proxy log.'),
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
