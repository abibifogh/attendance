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
      h('h2', 'The four systems'),
      h('p.sub', 'Attendance and the breakfast app are Cloudflare databases in this account, bound straight to this Worker: no key, no network, nothing to expire. The POS and the laundry are read over their own read-only APIs.'),
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
