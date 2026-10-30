import { h, mount } from '../util.js';
import { api } from '../api.js';

/**
 * Search: Ctrl K (⌘K on a Mac) or the box at the top, from any screen.
 *
 * Every page this person can open, a few things they do often, and the
 * suppliers by name. Arrows move, Enter opens, Escape closes. The list is
 * what they may reach already; nothing here opens a door the menu would not.
 */
let open = null;
let suppliers = null;

export function openPalette({ pages, actions, suppliers: openSupplier }) {
  if (open) return;
  const input = h('input', { type: 'search', placeholder: 'Jump to a page, a supplier, or something to do…', 'aria-label': 'Search Insight', autocomplete: 'off' });
  const list = h('div.pal-res', { role: 'listbox' });
  const box = h('div.pal', { role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Search' }, h('div.pal-box', input, list));
  let hits = [];
  let at = 0;

  const close = () => { box.remove(); open = null; document.removeEventListener('keydown', keys, true); };
  const choose = (hit) => { close(); hit.go(); };

  function draw() {
    const q = input.value.trim().toLowerCase();
    const has = (s) => !q || s.toLowerCase().includes(q);
    const groups = [
      ['Pages', pages.filter((p) => has(`${p.section} ${p.label}`)).map((p) => ({ ...p, hint: p.section }))],
      ['Do', actions.filter((a) => has(a.label))],
      ['Suppliers', q.length >= 2 && suppliers && openSupplier ? suppliers.filter((s) => has(s.name)).slice(0, 6).map((s) => ({
        label: s.name, hint: s.group || '', go: () => { try { sessionStorage.setItem('insight-supplier-open', String(s.id)); } catch { /* private mode */ } openSupplier(); },
      })) : []],
    ].filter(([, items]) => items.length);
    hits = groups.flatMap(([, items]) => items);
    at = Math.min(at, Math.max(0, hits.length - 1));
    let n = 0;
    mount(list, hits.length ? groups.map(([name, items]) => [
      h('div.pal-grp', name),
      items.map((hit) => {
        const i = n++;
        return h('button', { type: 'button', role: 'option', class: i === at ? 'on' : '', 'aria-selected': String(i === at), onclick: () => choose(hit), onmousemove: () => { if (at !== i) { at = i; draw(); } } },
          h('span', hit.label), hit.hint ? h('small', hit.hint) : null);
      }),
    ]) : h('p.pal-none', 'Nothing by that name.'));
  }

  function keys(e) {
    if (e.key === 'Escape') { e.preventDefault(); close(); }
    else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      at = (at + (e.key === 'ArrowDown' ? 1 : hits.length - 1)) % Math.max(1, hits.length);
      draw();
      list.querySelector('.on')?.scrollIntoView({ block: 'nearest' });
    } else if (e.key === 'Enter' && hits[at]) { e.preventDefault(); choose(hits[at]); }
  }

  input.addEventListener('input', () => { at = 0; draw(); });
  box.addEventListener('click', (e) => { if (e.target === box) close(); });
  document.addEventListener('keydown', keys, true);
  document.body.append(box);
  open = box;
  draw();
  input.focus();
  // The suppliers once, the first time search opens.
  if (openSupplier && !suppliers) {
    api('/suppliers/book').then((d) => { suppliers = (d.suppliers || []).filter((s) => !s.hidden); if (open === box) draw(); }).catch(() => { suppliers = []; });
  }
}
