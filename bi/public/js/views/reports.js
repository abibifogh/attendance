import { add, h, mount, num } from '../util.js';
import { api } from '../api.js';
import { table, banner } from './components.js';

/**
 * Reports made elsewhere, published here behind a PIN.
 *
 * Two lists and two forms. The report is a set of files uploaded exactly as
 * they are; the readers are people, each with a PIN of their own. The PIN is
 * shown once, when it is made, and never again — it is kept only as a hash —
 * so this screen is where it gets written down or read out.
 */
export async function renderReports(root) {
  const view = h('div');
  add(root, view);
  paint(await api('/reports'));

  function paint(data, notice = null) {
    mount(view,
      notice,

      h('div.card',
        h('h2', 'Published reports'),
        h('p.sub',
          'A page and whatever it needs beside it — a chart library, images — uploaded as they are '
          + 'and served back byte for byte. Each one lives at its own address on this site and opens '
          + 'only to a PIN from the list below. The files are kept in this app’s database, not in '
          + 'the code: the code is public, and a PIN on a page anybody could read on GitHub would '
          + 'be theatre.'),
        data.reports.length
          ? table([
            { label: 'Report', get: (r) => r.title },
            { label: 'Address', get: (r) => h('a', { href: `/${r.slug}`, target: '_blank', rel: 'noopener' }, `${location.origin}/${r.slug}`) },
            { label: 'Published', get: (r) => (r.publishedAt || '').replace('T', ' ').slice(0, 16) },
            { label: 'Files', get: (r) => r.files.map((f) => `${f.name} (${Math.round(f.bytes / 1024)} KB)`).join(', ') },
            { label: '', get: (r) => h('button.btn', {
              onclick: async () => {
                if (!confirm(`Take "${r.title}" down? Anybody with the link will get nothing.`)) return;
                try { paint(await api(`/reports/${r.slug}/remove`, { method: 'POST' })); } catch (e) { alert(e.message); }
              },
            }, 'Take down') },
          ], data.reports)
          : h('p.muted.small', 'Nothing published yet.'),
        publishForm()),

      h('div.card',
        h('h2', 'Who can read them'),
        h('p.sub',
          'One PIN per person, so it can be taken away from one person without taking it from '
          + 'everybody. Four digits is ten thousand guesses, which is why the door locks for fifteen '
          + 'minutes after five wrong ones from the same place — and for everybody after forty. '
          + 'Taking a PIN away works on that person’s very next click, not when their session runs out.'),
        data.pins.length
          ? table([
            { label: 'Name', get: (p) => p.label },
            { label: 'Made', get: (p) => (p.createdAt || '').slice(0, 10) },
            { label: 'Last opened', get: (p) => (p.lastUsedAt ? p.lastUsedAt.replace('T', ' ').slice(0, 16) : 'never') },
            { label: 'Times', num: true, get: (p) => num(p.uses) },
            { label: 'Status', get: (p) => (p.revokedAt ? `taken away ${p.revokedAt.slice(0, 10)}` : 'active') },
            { label: '', get: (p) => (p.revokedAt ? '' : h('button.btn', {
              onclick: async () => {
                if (!confirm(`Take ${p.label}’s PIN away?`)) return;
                try { paint(await api(`/report-pins/${p.id}/revoke`, { method: 'POST' })); } catch (e) { alert(e.message); }
              },
            }, 'Take away')) },
          ], data.pins)
          : h('p.muted.small', 'Nobody has a PIN yet.'),
        pinForm()));
  }

  function publishForm() {
    const title = h('input', { type: 'text', placeholder: 'Sir Tobys Money Map', maxlength: '160' });
    const slug = h('input', { type: 'text', placeholder: '2025v2024analysis', maxlength: '64', pattern: '[a-z0-9][a-z0-9-]{1,63}' });
    const files = h('input', { type: 'file', multiple: 'multiple', accept: '.html,.htm,.js,.css,.png,.jpg,.jpeg,.svg,.webp,.json,.csv,.woff2,.woff' });
    const said = h('p.small');

    return h('div', { style: { marginTop: '1rem' } },
      h('h3', 'Publish a report'),
      h('label.field', 'Title', title),
      h('label.field', 'Address',
        slug,
        h('span.small.muted', 'Letters, digits and hyphens. The report opens at ', h('code', `${location.origin}/…`))),
      h('label.field', 'Files',
        files,
        h('span.small.muted', 'The page must be an .html file — one called index.html, or the first one. '
          + 'Choose the chart library and anything else it needs at the same time. Publishing to an '
          + 'address that already exists replaces files of the same name and keeps the rest.')),
      h('div.rangebar',
        h('button.btn.primary', {
          onclick: async (event) => {
            if (!files.files.length) { said.textContent = 'Choose the report file first.'; return; }
            event.target.disabled = true;
            said.style.color = '';
            said.textContent = 'Uploading…';
            const body = new FormData();
            body.append('title', title.value.trim());
            body.append('slug', slug.value.trim());
            for (const f of files.files) body.append('files', f, f.name);
            try {
              const response = await fetch('/api/reports', { method: 'POST', body });
              const data = await response.json();
              if (!response.ok) throw new Error(data.error || `The server answered ${response.status}`);
              paint(data, banner('good',
                h('strong', 'Published. '),
                'It is at ', h('a', { href: `/${data.published.slug}`, target: '_blank', rel: 'noopener' },
                  `${location.origin}/${data.published.slug}`),
                ` — ${data.published.files.join(', ')}. Anybody opening it needs a PIN from the list below.`));
            } catch (err) {
              said.textContent = err.message;
              said.style.color = 'var(--critical)';
              event.target.disabled = false;
            }
          },
        }, 'Publish'),
        said));
  }

  function pinForm() {
    const label = h('input', { type: 'text', placeholder: 'Who this PIN is for', maxlength: '80' });
    const pin = h('input', { type: 'text', inputmode: 'numeric', pattern: '[0-9]{4}', maxlength: '4', placeholder: 'blank = random' });
    const said = h('p.small');

    return h('div', { style: { marginTop: '1rem' } },
      h('h3', 'Give somebody a PIN'),
      h('div.rangebar',
        h('label.field', 'Name', label),
        h('label.field', 'PIN', pin),
        h('button.btn.primary', {
          onclick: async (event) => {
            event.target.disabled = true;
            try {
              const data = await api('/report-pins', { method: 'POST', body: { label: label.value.trim(), pin: pin.value.trim() } });
              paint(data, banner('good',
                h('strong', `${data.made.label}’s PIN is `),
                h('code', { style: { fontSize: '1.3rem', letterSpacing: '.2em' } }, data.made.pin),
                '. Write it down or read it out now — it is not shown again anywhere.'));
            } catch (err) {
              said.textContent = err.message;
              said.style.color = 'var(--critical)';
              event.target.disabled = false;
            }
          },
        }, 'Make a PIN'),
        said));
  }
}
