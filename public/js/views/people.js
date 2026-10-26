import { api } from '../api.js';
import { fmtDay, h, mount, toast } from '../util.js';
import { card, emptyState, table } from './components.js';
import { navigate } from '../app.js';
import { field, formDialog } from './att-shared.js';

/**
 * Everybody who works here, and the one thing worth knowing about each.
 *
 * Not a completeness percentage. A bar reading 78% is a number nobody can do
 * anything with; "no emergency contact, no ID" is a list somebody can walk
 * round the building with on a Tuesday morning and finish.
 *
 * What waits for a decision comes first, because a form somebody filled in on
 * their phone last night and nobody has looked at is worth more attention than
 * a list that has been incomplete for a month.
 */
export async function renderPeople() {
  const host = h('div');
  const [data, pending, files] = await Promise.all([
    api.hrPeople(),
    api.hrSubmissions().catch(() => ({ rows: [] })),
    // Paper photographed on a phone waits exactly as a filled-in form waits,
    // and counting only one of them is how the other sits for a fortnight.
    api.hrWaitingDocuments().catch(() => ({ documents: [] })),
  ]);

  const reload = async () => mount(host, await renderPeople());

  if (!data.rows.length) {
    mount(host,
      h('div.page-head', h('h1', 'People')),
      emptyState('Nobody yet', 'Add people under Attendance setup and their records appear here.'),
    );
    return host;
  }

  const withGaps = data.rows.filter((r) => r.active && r.missing.length).length;
  const unsigned = data.rows.filter((r) => r.waitingContracts).length;

  mount(host,
    h('div.page-head',
      h('div',
        h('h1', 'People'),
        h('div.sub', 'Personal details, emergency contacts, documents and contracts.'),
      ),
      data.canManage
        ? h('div.btn-row',
          h('button.btn-sm', { onclick: () => navigate('people-form') }, 'What to ask for'),
          h('button.btn-sm', { onclick: () => navigate('people-templates') }, 'Templates'),
          h('button.btn.btn-primary', { onclick: () => sendToMany(data.rows, reload) }, 'Send a document to several'),
        )
        : null,
    ),

    h('div.grid.grid-4',
      tile('On the books', data.rows.filter((r) => r.active).length, 'people'),
      tile('Records incomplete', withGaps, withGaps ? 'something missing' : 'all complete',
        withGaps ? 'var(--warn)' : 'var(--good)'),
      tile('Contracts out', unsigned, unsigned ? 'sent, not signed' : 'none waiting',
        unsigned ? 'var(--warn)' : null),
      tile('Sent in by staff',
        pending.rows.length + files.documents.length,
        pending.rows.length + files.documents.length
          ? [pending.rows.length ? `${pending.rows.length} form${pending.rows.length === 1 ? '' : 's'}` : null,
            files.documents.length ? `${files.documents.length} file${files.documents.length === 1 ? '' : 's'}` : null]
            .filter(Boolean).join(', ')
          : 'nothing new',
        pending.rows.length + files.documents.length ? 'var(--accent)' : null),
    ),

    inbox(pending.rows, data.canManage, reload),

    peopleList(data.rows),
  );

  return host;
}

/**
 * Everybody, folded under their departments, with a way to find one person.
 *
 * THE LIST GOT LONGER THAN THE SCREEN. Twenty-odd names was a list; a property
 * with two sites and a year of history is a page somebody scrolls past to get
 * to the housekeeper they came for. So three things: the departments fold,
 * there is a box to type a name into, and the filters are the two questions
 * anybody actually arrives with — which department, and what state is the
 * record in.
 *
 * CLOSED UNTIL SOMEBODY LOOKS. With nothing typed the screen is a short list of
 * departments and how many people are in each, which is a better first sight of
 * a workforce than the first fifteen names alphabetically. The moment a filter
 * or a search is on, every group opens: a search that finds three people and
 * hides them behind three lids has not found anybody.
 *
 * Filtering happens here rather than at the server. Every record is already in
 * the browser, and a list that redraws as somebody types is worth more than one
 * that is exactly right a quarter of a second later.
 */
function peopleList(rows) {
  const host = h('div');
  const departments = [...new Set(rows.map((r) => r.department).filter(Boolean))].sort();

  const SHOW = [
    ['on', 'On the books'],
    ['all', 'Everybody, including people who have left'],
    ['gaps', 'Records with something missing'],
    ['contracts', 'Contracts sent and not signed'],
    ['left', 'People who have left'],
  ];

  let query = '';
  let department = '';
  let show = 'on';
  // Only ever set by the button. A search opens the groups without turning the
  // button into a lie about what it will do next.
  let openAll = false;
  // Set only by the search box. Redrawing replaces every element on the
  // screen, so the caret has to be put back - but only for the control that
  // caused the redraw, or changing the department would snatch it away from
  // the select somebody just used.
  let typing = false;

  const matches = (row) => {
    if (department && (row.department || '') !== department) return false;
    if (show === 'on' && !row.active) return false;
    if (show === 'left' && row.active) return false;
    if (show === 'gaps' && !(row.active && row.missing.length)) return false;
    if (show === 'contracts' && !row.waitingContracts) return false;

    if (!query) return true;
    const needle = query.trim().toLowerCase();
    return [row.name, row.employeeNo, row.jobTitle, row.department]
      .some((field) => String(field ?? '').toLowerCase().includes(needle));
  };

  const draw = () => {
    const shown = rows.filter(matches);
    const filtered = Boolean(query.trim() || department || show !== 'on');

    const search = h('input', {
      type: 'search',
      placeholder: 'Name, number or job title…',
      value: query,
      // Wide enough to type a name into, not so wide it pushes the two
      // filters onto a line of their own.
      style: { width: 'auto', flex: '1 1 14rem', maxWidth: '22rem' },
      // On input rather than on change: somebody looking for one person out of
      // a hundred wants the list to shrink as they type, not when they leave
      // the box.
      oninput: (e) => { query = e.target.value; typing = true; draw(); },
    });

    mount(host,
      h('div.toolbar',
        search,
        h('select', { onchange: (e) => { department = e.target.value; draw(); } },
          h('option', { value: '', selected: !department }, 'Every department'),
          departments.map((name) =>
            h('option', { value: name, selected: department === name }, name))),
        h('select', { onchange: (e) => { show = e.target.value; draw(); } },
          SHOW.map(([key, label]) =>
            h('option', { value: key, selected: show === key }, label))),
        h('div', { style: { flex: 1 } }),
        filtered
          ? h('button.btn-sm', {
            onclick: () => { query = ''; department = ''; show = 'on'; draw(); },
          }, 'Clear')
          : null,
      ),

      card('Everybody', {
        note: filtered
          ? `${shown.length} of ${rows.length}`
          : `${shown.length} record${shown.length === 1 ? '' : 's'}`,
        wide: true,
        actions: shown.length && !filtered
          ? h('button.btn-sm', {
            onclick: () => { openAll = !openAll; draw(); },
          }, openAll ? 'Fold them up' : 'Open them all')
          : null,
      },
      shown.length
        ? table(PEOPLE_COLUMNS, shown, {
          rowClass: (r) => (r.active ? '' : 'row-muted'),
          groupBy: (r) => r.department || null,
          groupNoun: ['person', 'people'],
          // Open while somebody is looking for one person, shut while they
          // are looking at the shape of the place.
          fold: (filtered || openAll) ? true : 'closed',
          empty: 'Nobody yet.',
        })
        : emptyState('Nobody matches that',
          'Try a shorter search, another department, or clear the filters.')),
    );

    // Typing then redrawing loses the caret, which makes the box unusable.
    if (typing) {
      typing = false;
      search.focus();
      search.setSelectionRange(query.length, query.length);
    }
  };

  draw();
  return host;
}

const PEOPLE_COLUMNS = [
  {
    key: 'name',
    label: 'Name',
    format: (v, r) => h('a.link-button', {
      href: `#/person?id=${r.id}`,
    }, h('div',
      h('div', v,
        r.payrollOnly
          ? h('span.pill', { style: { marginLeft: '.4rem' } }, 'payroll only')
          : null),
      h('small.muted', `${r.jobTitle || 'No job title'} · ${r.employeeNo}`),
    )),
  },
  {
    key: 'hiredOn',
    label: 'Started',
    format: (v) => (v ? h('small', fmtDay(v, { withYear: true })) : h('span.muted', '—')),
  },
  {
    key: 'missing',
    label: 'Still needed',
    format: (v) => (v.length
      ? h('div.chip-row', v.map((label) => h('span.pill.warn', label)))
      : h('span.pill.good', 'Complete')),
  },
  {
    key: 'signedContracts',
    label: 'Contracts',
    format: (v, r) => h('div',
      v ? h('span.pill.good', `${v} signed`) : h('span.muted', 'none signed'),
      r.waitingContracts ? h('span.pill.warn', `${r.waitingContracts} waiting`) : null,
    ),
  },
  {
    key: 'pendingSubmissions',
    label: '',
    format: (v) => (v ? h('span.pill', `${v} to review`) : ''),
  },
];

function tile(label, value, sub, accent) {
  return h('div.stat',
    h('div.stat-label', label),
    h('div.stat-value', { style: accent ? { color: accent } : null }, String(value)),
    h('div.stat-sub', h('span', sub)),
  );
}

/**
 * What people have sent in, waiting to be looked at.
 *
 * Every difference is one line with a tick, and the ticks start on. Accepting
 * everything is one press, which it should be — most of the time a form is
 * simply right — and disagreeing with one line of it is one more.
 */
function inbox(rows, canManage, reload) {
  if (!rows.length) return null;

  const review = async (row) => {
    const chosen = new Set(row.changes.map((c) => c.key));

    const done = await formDialog({
      title: `${row.name} sent their details`,
      submitLabel: 'Accept the ticked ones',
      body: h('div',
        h('p.muted', `Sent ${fmtDay(String(row.submittedAt).slice(0, 10), { withYear: true })}. `
          + 'Nothing has been written to their record yet. Untick anything you do not want.'),

        h('div.diff', row.changes.map((change) => h('label.diff-row',
          h('input', {
            type: 'checkbox',
            checked: true,
            onchange: (e) => (e.target.checked ? chosen.add(change.key) : chosen.delete(change.key)),
          }),
          h('div',
            h('div.diff-label',
              change.label,
              change.isNew ? h('span.pill.good', 'new') : null,
              change.sensitive ? h('span.pill', 'private') : null,
            ),
            change.kind === 'list'
              ? h('div.diff-values',
                change.from.length
                  ? h('div', h('span.muted', 'now: '), change.from.join(' | '))
                  : null,
                h('div', h('span.muted', 'sent: '), h('strong', change.to.join(' | '))),
              )
              : h('div.diff-values',
                change.from ? h('span.diff-old', change.from) : h('span.muted', 'blank'),
                h('span.diff-arrow', '→'),
                h('strong', change.to),
              ),
          ),
        ))),

        h('p.muted', { style: { fontSize: '.82rem', marginBottom: 0 } },
          'A question they left blank is never a request to delete what is already on file, '
          + 'so blanks do not appear here at all.'),
      ),
      onSubmit: async () => api.hrAcceptSubmission(row.id, [...chosen]),
    });

    if (done) { toast(`${done.applied} change${done.applied === 1 ? '' : 's'} saved.`, 'good'); await reload(); }
  };

  const reject = async (row) => {
    const done = await formDialog({
      title: `Turn down what ${row.name} sent?`,
      submitLabel: 'Turn it down',
      body: h('div',
        h('p.muted', 'Nothing is written to their record. Say why, for the record — they '
          + 'will not see this, so it is a note to whoever looks next.'),
        field('Why', h('input', { type: 'text', name: 'note', maxlength: 300 })),
      ),
      onSubmit: async (form) => api.hrRejectSubmission(row.id, form.get('note')),
    });
    if (done) { toast('Turned down.'); await reload(); }
  };

  return card('Sent in by staff', {
    note: `${rows.length} waiting`,
    wide: true,
  },
    rows.map((row) => h('div.alert.info',
      h('span.alert-icon', '📥'),
      h('div', { style: { flex: 1 } },
        h('div.alert-title', row.name),
        h('div.alert-detail', row.changes.length
          ? `${row.changes.length} thing${row.changes.length === 1 ? '' : 's'} to look at — `
            + row.changes.slice(0, 4).map((c) => c.label).join(', ')
            + (row.changes.length > 4 ? '…' : '')
          : 'Nothing in it differs from what you already have.'),
      ),
      canManage
        ? h('div.btn-row',
          h('button.btn-sm', { onclick: () => reject(row) }, 'Turn down'),
          h('button.btn-sm.btn-primary', {
            onclick: () => review(row),
            disabled: !row.changes.length,
          }, 'Review'),
        )
        : null,
    )),
  );
}


/**
 * One document to several people at once: each gets their own copy, filled in
 * with their own particulars, on their own link, sent by email and text and
 * reminded until signed.
 */
async function sendToMany(rows, reload) {
  const { rows: templates, placeholders, companies = [] } = await api.hrTemplates();
  const usable = (templates ?? []).filter((t) => t.active !== 0);
  const companyName = new Map(companies.map((c) => [c.id, c.name]));
  if (!usable.length) { toast('Write a template first, under Templates.', 'bad'); return; }
  const people = rows.filter((r) => r.active).sort((a, b) => String(a.department ?? '').localeCompare(String(b.department ?? '')) || a.name.localeCompare(b.name));
  const departments = [...new Set(people.map((p) => p.department).filter(Boolean))].sort();
  const chosen = new Set();
  const asked = (placeholders ?? []).filter((p) => p.ask);

  const template = h('select', { name: 'templateId', required: true },
    usable.map((t) => h('option', { value: t.id },
      t.company_id && companies.length > 1 ? `${t.name} (${companyName.get(t.company_id) ?? 'one company'} only)` : t.name)));
  const valuesBox = h('div');
  const drawValues = () => {
    const t = usable.find((x) => String(x.id) === template.value);
    const needs = asked.filter((p) => (t?.uses ?? []).includes(p.key));
    mount(valuesBox, needs.length
      ? h('div',
        h('p.muted', { style: { fontSize: '.82rem' } }, 'The same for everybody. Anything that differs per person, like a salary, '
          + 'is better issued one at a time from their record.'),
        needs.map((p) => field(p.label, h('input', { type: 'text', name: `v_${p.key}`, value: p.fallback ?? '' }))))
      : null);
  };
  template.addEventListener('change', drawValues);
  drawValues();

  const count = h('strong', '0 chosen');
  const boxes = people.map((p) => {
    const box = h('input', {
      type: 'checkbox', value: p.id,
      onchange: (e) => { if (e.target.checked) chosen.add(p.id); else chosen.delete(p.id); count.textContent = `${chosen.size} chosen`; },
    });
    return { p, box, row: h('label.tickline.many-row', box, h('span', p.name, h('small.muted', ` ${p.department ?? ''}`))) };
  });
  // A template for one company only goes to the people that company employs.
  const fits = (p) => {
    const t = usable.find((x) => String(x.id) === template.value);
    return !t?.company_id || t.company_id === p.companyId;
  };
  const pickDept = (dept) => {
    for (const b of boxes) {
      const on = (dept === '*' || b.p.department === dept) && fits(b.p);
      if (on) { b.box.checked = true; chosen.add(b.p.id); }
    }
    count.textContent = `${chosen.size} chosen`;
  };
  const showFitting = () => {
    for (const b of boxes) {
      const ok = fits(b.p);
      b.row.hidden = !ok;
      if (!ok && b.box.checked) { b.box.checked = false; chosen.delete(b.p.id); }
    }
    count.textContent = `${chosen.size} chosen`;
  };
  template.addEventListener('change', showFitting);
  showFitting();

  const done = await formDialog({
    title: 'Send a document to several people',
    wide: true,
    submitLabel: 'Send to everybody chosen',
    body: h('div',
      field('Document', template),
      valuesBox,
      h('div.field',
        h('span', 'Who it goes to'),
        h('div.chips',
          h('button.chip', { type: 'button', onclick: () => pickDept('*') }, 'Everybody'),
          departments.map((d) => h('button.chip', { type: 'button', onclick: () => pickDept(d) }, d))),
        h('div.many-list', boxes.map((b) => b.row)),
        count),
      h('label.tickline', h('input', { type: 'checkbox', name: 'sendEmail', checked: true }), h('span', 'Email each their own link')),
      h('label.tickline', h('input', { type: 'checkbox', name: 'sendText', checked: true }), h('span', 'And text it to their phone')),
      field('A line to them', h('input', { type: 'text', name: 'message', maxlength: 400, placeholder: 'Please read and sign by Friday' }))),
    onSubmit: async (form) => {
      if (!chosen.size) throw new Error('Choose who it goes to.');
      const values = {};
      for (const p of asked) if (form.get(`v_${p.key}`) != null) values[p.key] = form.get(`v_${p.key}`);
      return api.hrIssueToMany({
        templateId: Number(form.get('templateId')),
        staffIds: [...chosen],
        values,
        sendEmail: form.get('sendEmail') === 'on',
        sendText: form.get('sendText') === 'on',
        message: form.get('message') || null,
      });
    },
  });
  if (!done) return;

  const unsent = done.results.filter((r) => r.ok && !r.sent);
  const failed = done.results.filter((r) => !r.ok);
  await formDialog({
    title: `Sent to ${done.sent} of ${done.results.length}`,
    submitLabel: 'Done',
    body: h('div.welcome-sum',
      h('p.welcome-line.is-good', h('span', '✓'), `${done.issued} issued, ${done.sent} sent by HIVE. HIVE reminds them until they sign.`),
      unsent.length
        ? h('div',
          h('p.welcome-line.is-warn', h('span', '!'), `${unsent.length} could not be sent: copy their links below.`),
          unsent.map((r) => h('div.welcome-copy',
            h('strong', r.name),
            h('textarea', { readonly: true, rows: 3 }, r.message))))
        : null,
      failed.map((r) => h('p.welcome-line.is-warn', h('span', '!'), `${r.name ?? r.staffId}: ${r.error}`))),
    onSubmit: async () => true,
  });
  await reload();
}
