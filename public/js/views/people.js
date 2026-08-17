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
  const [data, pending] = await Promise.all([
    api.hrPeople(),
    api.hrSubmissions().catch(() => ({ rows: [] })),
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
          h('button.btn-sm', { onclick: () => navigate('people-templates') }, 'Templates'),
        )
        : null,
    ),

    h('div.grid.grid-4',
      tile('On the books', data.rows.filter((r) => r.active).length, 'people'),
      tile('Records incomplete', withGaps, withGaps ? 'something missing' : 'all complete',
        withGaps ? 'var(--warn)' : 'var(--good)'),
      tile('Contracts out', unsigned, unsigned ? 'sent, not signed' : 'none waiting',
        unsigned ? 'var(--warn)' : null),
      tile('Sent in by staff', pending.rows.length, pending.rows.length ? 'waiting for you' : 'nothing new',
        pending.rows.length ? 'var(--accent)' : null),
    ),

    inbox(pending.rows, data.canManage, reload),

    card('Everybody', { note: `${data.rows.length} records`, wide: true },
      table([
        {
          key: 'name',
          label: 'Name',
          format: (v, r) => h('a.link-button', {
            href: `#/person?id=${r.id}`,
          }, h('div',
            h('div', v),
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
      ], data.rows, {
        rowClass: (r) => (r.active ? '' : 'row-muted'),
        groupBy: (r) => r.department || null,
        groupNoun: ['person', 'people'],
        empty: 'Nobody yet.',
      })),
  );

  return host;
}

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
