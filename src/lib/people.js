// What a hotel holds about the people who work in it.
//
// Everything here is pure. The fields are declared once and five things read
// that declaration: the form a manager fills in, the form the person fills in
// on their phone, the difference between what they sent and what is on file,
// the count of what is still missing, and the rule about which of it a
// supervisor is allowed to see.
//
// Declaring it once is the whole design. A field added to a list somewhere and
// forgotten in the other four is how a system ends up asking for a Ghana Card
// number it never shows, or showing a bank account to somebody who should not
// have it.

/**
 * A person's record, in the order somebody would actually ask for it.
 *
 * `self` marks a field the person can fill in themselves. Their job title and
 * their start date are not on that list: those are the property's answers, not
 * theirs, and a self-service form that lets somebody set their own start date
 * is a self-service form that will eventually be used to.
 *
 * `sensitive` marks a field that is masked for anybody who cannot manage
 * records. Not hidden — masked, so a supervisor can see that a bank account is
 * on file without being able to read it.
 */
export const SECTIONS = [
  {
    key: 'personal',
    label: 'Personal',
    fields: [
      { key: 'preferred_name', label: 'Known as', type: 'text', self: true, hint: 'What everybody actually calls them' },
      { key: 'date_of_birth', label: 'Date of birth', type: 'date', self: true, wanted: true },
      { key: 'gender', label: 'Gender', type: 'select', self: true, options: ['Female', 'Male', 'Prefer not to say'] },
      { key: 'marital_status', label: 'Marital status', type: 'select', self: true, options: ['Single', 'Married', 'Divorced', 'Widowed'] },
      { key: 'nationality', label: 'Nationality', type: 'text', self: true, placeholder: 'Ghanaian' },
    ],
  },
  {
    key: 'contact',
    label: 'Address & contact',
    fields: [
      { key: 'personal_phone', label: 'Mobile', type: 'tel', self: true, wanted: true, placeholder: '024 123 4567' },
      { key: 'alt_phone', label: 'Other number', type: 'tel', self: true, hint: 'Somebody who can pass a message on' },
      { key: 'personal_email', label: 'Email', type: 'email', self: true },
      { key: 'address_line', label: 'Address', type: 'textarea', self: true, wanted: true },
      { key: 'town', label: 'Town', type: 'text', self: true },
      { key: 'region', label: 'Region', type: 'select', self: true, options: REGIONS() },
      { key: 'digital_address', label: 'GhanaPost GPS', type: 'text', self: true, placeholder: 'GA-183-9271' },
      { key: 'landmark', label: 'Nearest landmark', type: 'text', self: true, hint: 'How a driver would find it' },
    ],
  },
  {
    key: 'identity',
    label: 'Identification',
    note: 'Held for the SSNIT and tax filings, and for the personnel file the Labour Department expects.',
    fields: [
      { key: 'id_type', label: 'ID document', type: 'select', self: true, wanted: true, options: ['Ghana Card', 'Passport', 'Voter ID', 'Driver’s Licence', 'NHIS Card'] },
      { key: 'id_number', label: 'ID number', type: 'text', self: true, wanted: true, sensitive: true, placeholder: 'GHA-123456789-0' },
      { key: 'id_expires_on', label: 'Expires', type: 'date', self: true },
      { key: 'ssnit_number', label: 'SSNIT number', type: 'text', self: true, sensitive: true },
      { key: 'tin_number', label: 'TIN', type: 'text', self: true, sensitive: true },
    ],
  },
  {
    key: 'pay',
    label: 'How they are paid',
    note: 'Only the account the wages go to. Nothing here says what anybody earns.',
    fields: [
      { key: 'pay_method', label: 'Paid by', type: 'select', self: true, options: ['Bank transfer', 'Mobile money', 'Cash'] },
      { key: 'bank_name', label: 'Bank', type: 'text', self: true },
      { key: 'bank_branch', label: 'Branch', type: 'text', self: true },
      { key: 'account_name', label: 'Account name', type: 'text', self: true },
      { key: 'account_number', label: 'Account number', type: 'text', self: true, sensitive: true, mask: 'tail4' },
      { key: 'momo_network', label: 'Mobile money', type: 'select', self: true, options: ['MTN MoMo', 'Telecel Cash', 'AT Money'] },
      { key: 'momo_number', label: 'Mobile money number', type: 'tel', self: true, sensitive: true, mask: 'tail4' },
    ],
  },
  {
    key: 'health',
    label: 'In an emergency',
    note: 'What a first-aider would need in the first minute. Nothing else belongs here.',
    fields: [
      { key: 'blood_group', label: 'Blood group', type: 'select', self: true, options: ['A+', 'A−', 'B+', 'B−', 'AB+', 'AB−', 'O+', 'O−'] },
      { key: 'allergies', label: 'Allergies', type: 'text', self: true },
      { key: 'medical_notes', label: 'Anything else', type: 'textarea', self: true, sensitive: true, hint: 'Only what somebody would need to act on' },
    ],
  },
];

/** The sixteen regions, so an address is a choice rather than a spelling test. */
function REGIONS() {
  return [
    'Ahafo', 'Ashanti', 'Bono', 'Bono East', 'Central', 'Eastern', 'Greater Accra',
    'North East', 'Northern', 'Oti', 'Savannah', 'Upper East', 'Upper West',
    'Volta', 'Western', 'Western North',
  ];
}

export const FIELDS = SECTIONS.flatMap((s) => s.fields.map((f) => ({ ...f, section: s.key })));
export const FIELD_MAP = new Map(FIELDS.map((f) => [f.key, f]));
export const SELF_FIELDS = FIELDS.filter((f) => f.self);
export const SENSITIVE_KEYS = new Set(FIELDS.filter((f) => f.sensitive).map((f) => f.key));

/** The child lists, which are lists rather than fields and behave differently. */
export const LISTS = [
  {
    key: 'contacts',
    table: 'hr_contact',
    label: 'Emergency contacts',
    self: true,
    wanted: true,
    columns: ['kind', 'name', 'relationship', 'phone', 'alt_phone', 'email', 'address'],
    describe: (row) => [row.name, row.relationship, row.phone].filter(Boolean).join(' · '),
  },
  {
    key: 'education',
    table: 'hr_education',
    label: 'Education',
    self: true,
    columns: ['level', 'institution', 'qualification', 'field', 'finished_on'],
    describe: (row) => [row.qualification || row.level, row.institution, row.finished_on].filter(Boolean).join(' · '),
  },
  {
    key: 'employment',
    table: 'hr_employment',
    label: 'Previous employment',
    self: true,
    columns: ['employer', 'job_title', 'from_on', 'to_on', 'reason_left'],
    describe: (row) => [row.job_title, row.employer, [row.from_on, row.to_on].filter(Boolean).join('–')].filter(Boolean).join(' · '),
  },
];

export const LIST_MAP = new Map(LISTS.map((l) => [l.key, l]));

// ---------------------------------------------------------------------------
// What this property actually asks for
// ---------------------------------------------------------------------------

/**
 * Ask for it, insist on it, or do not ask at all.
 *
 * Three answers rather than a tick box, because "optional" and "required" are
 * genuinely different requests and a property that has been caught out by an
 * emergency contact nobody filled in wants the second one.
 */
export const ASKS = [
  { key: 'ask', label: 'Ask for it', detail: 'Shown on the form. They can leave it blank' },
  { key: 'require', label: 'Insist on it', detail: 'The form will not send until it is filled in' },
  { key: 'skip', label: 'Do not ask', detail: 'Left off the form entirely' },
];

const ASK_KEYS = new Set(ASKS.map((a) => a.key));

/**
 * The plan, stored as only what somebody changed.
 *
 * Sparse on purpose, and it is the most important decision in this file. A
 * plan that listed every field would freeze the form at the moment it was
 * saved: a field added to the code next year would be absent from a plan
 * written this year, and — under any reading that treats the plan as complete —
 * silently never asked for again. Storing the exceptions means the default is
 * always whatever the code currently says, and a property only carries the
 * decisions it actually made.
 */
export function planFor(stored) {
  const raw = typeof stored === 'string' ? safeParse(stored) : stored;
  const out = { fields: {}, lists: {}, documents: {} };
  if (!raw || typeof raw !== 'object') return out;

  for (const group of ['fields', 'lists', 'documents']) {
    const from = raw[group];
    if (!from || typeof from !== 'object') continue;
    for (const [key, value] of Object.entries(from)) {
      if (ASK_KEYS.has(value)) out[group][key] = value;
    }
  }
  return out;
}

function safeParse(text) {
  try {
    return JSON.parse(text);
  } catch {
    // A plan nobody can read is a plan that does not exist. Falling back to
    // the standard set asks for slightly too much, which is recoverable; the
    // alternative is a form with nothing on it.
    return null;
  }
}

/** What the plan says about one thing, with the code's own default behind it. */
export function askFor(plan, group, key, fallback = 'ask') {
  return plan?.[group]?.[key] ?? fallback;
}

/**
 * The form this property asks for, resolved.
 *
 * One function, used by the page somebody fills in on their phone and by the
 * screen an administrator sets it up on, so the second cannot drift from the
 * first — which is the same argument that made the fields declarative in the
 * first place.
 */
export function formPlan(plan, { documents = [] } = {}) {
  const sections = SECTIONS.map((section) => ({
    key: section.key,
    label: section.label,
    note: section.note ?? null,
    fields: section.fields
      .filter((f) => f.self)
      .map((f) => ({ ...f, ask: askFor(plan, 'fields', f.key) }))
      .filter((f) => f.ask !== 'skip'),
  })).filter((section) => section.fields.length);

  const lists = LISTS
    .filter((l) => l.self)
    .map(({ key, label, columns }) => ({
      key, label, columns, ask: askFor(plan, 'lists', key),
    }))
    .filter((l) => l.ask !== 'skip');

  const files = documents
    .filter((d) => d.self)
    .map((d) => ({
      code: d.code,
      label: d.label,
      detail: d.detail ?? null,
      ask: askFor(plan, 'documents', d.code),
    }))
    .filter((d) => d.ask !== 'skip');

  return { sections, lists, files };
}

/**
 * What a form was insisted on and did not get.
 *
 * Checked against the record as well as the submission, not instead of it. The
 * page never reads anybody's record back — a form showing what the property
 * already holds is a form that leaks it to whoever is holding the phone — so a
 * person filling in the second link of their first week would otherwise be made
 * to retype an address the office already has.
 */
export function unanswered(plan, { profile = {}, lists = {}, files = [] } = {}, onFile = {}) {
  const gaps = [];

  for (const field of SELF_FIELDS) {
    if (askFor(plan, 'fields', field.key) !== 'require') continue;
    if (!blank(profile[field.key])) continue;
    if (!blank(onFile.profile?.[field.key])) continue;
    gaps.push({ kind: 'field', key: field.key, label: field.label });
  }

  for (const list of LISTS) {
    if (!list.self) continue;
    if (askFor(plan, 'lists', list.key) !== 'require') continue;
    if (lists[list.key]?.length) continue;
    if (onFile.lists?.[list.key]?.length) continue;
    gaps.push({ kind: 'list', key: list.key, label: list.label });
  }

  for (const file of files) {
    if (file.ask !== 'require') continue;
    if (file.attached?.length) continue;
    if (onFile.documents?.includes(file.code)) continue;
    gaps.push({ kind: 'file', key: file.code, label: file.label });
  }

  return gaps;
}

// ---------------------------------------------------------------------------
// What is still missing
// ---------------------------------------------------------------------------

/**
 * The handful of things a personnel file is no use without.
 *
 * Deliberately short. A completeness score counting forty fields is a number
 * nobody can act on; five things somebody can go and ask for is a list.
 */
export function missingFor(profile, lists = {}) {
  const gaps = [];

  for (const field of FIELDS) {
    if (!field.wanted) continue;
    if (blank(profile?.[field.key])) gaps.push({ key: field.key, label: field.label });
  }

  for (const list of LISTS) {
    if (!list.wanted) continue;
    if (!(lists[list.key]?.length)) gaps.push({ key: list.key, label: list.label });
  }

  return gaps;
}

const blank = (v) => v == null || String(v).trim() === '';

// ---------------------------------------------------------------------------
// Who may read what
// ---------------------------------------------------------------------------

/**
 * A record as a particular person is allowed to see it.
 *
 * Masked, not removed. "Account number: •••• 4321" tells a supervisor that the
 * wages have somewhere to go without telling them where, and an empty space
 * would have them chasing a field that is already filled in.
 */
export function maskProfile(profile, { full = false } = {}) {
  if (!profile) return null;
  if (full) return { ...profile };

  const out = { ...profile };
  for (const key of SENSITIVE_KEYS) {
    if (blank(out[key])) continue;
    out[key] = mask(out[key], FIELD_MAP.get(key)?.mask);
    out[`${key}__masked`] = true;
  }
  return out;
}

export function mask(value, style) {
  const text = String(value).trim();
  if (style === 'tail4' && text.length > 4) return `•••• ${text.slice(-4)}`;
  if (text.length <= 4) return '••••';
  return `${'•'.repeat(Math.min(8, text.length - 3))}${text.slice(-3)}`;
}

// ---------------------------------------------------------------------------
// A submission, against what is already on file
// ---------------------------------------------------------------------------

/**
 * What accepting somebody's form would actually change.
 *
 * Every difference is one row, and every row is a decision. A form arriving
 * with thirty fields of which two are new should present two things to look
 * at, not thirty — and it must never present a field the person left blank as
 * a proposal to erase what is on file, which is the single most destructive
 * thing a self-service form can do.
 */
export function diffSubmission(payload, { profile, lists = {} }) {
  const changes = [];

  for (const field of SELF_FIELDS) {
    if (!(field.key in (payload?.profile ?? {}))) continue;

    const next = clean(payload.profile[field.key]);
    const current = clean(profile?.[field.key]);

    // Silence is not an instruction. Somebody who skipped a question is not
    // asking for the answer already on file to be deleted.
    if (blank(next)) continue;
    if (next === current) continue;

    changes.push({
      kind: 'field',
      key: field.key,
      label: field.label,
      section: field.section,
      sensitive: Boolean(field.sensitive),
      from: current || null,
      to: next,
      isNew: blank(current),
    });
  }

  for (const list of LISTS) {
    if (!(list.key in (payload?.lists ?? {}))) continue;

    const next = (payload.lists[list.key] ?? [])
      .map((row) => pick(row, list.columns))
      .filter((row) => Object.values(row).some((v) => !blank(v)));
    const current = (lists[list.key] ?? []).map((row) => pick(row, list.columns));

    if (!next.length) continue;
    if (sameList(current, next)) continue;

    changes.push({
      kind: 'list',
      key: list.key,
      label: list.label,
      // A list is accepted or refused whole. Merging two versions of "who to
      // ring in an emergency" by hand is how you end up ringing a number that
      // was replaced for a reason.
      from: current.map((r) => list.describe(r)).filter(Boolean),
      to: next.map((r) => list.describe(r)).filter(Boolean),
      rows: next,
      isNew: !current.length,
    });
  }

  return changes;
}

const clean = (v) => (v == null ? '' : String(v).trim());

function pick(row, columns) {
  const out = {};
  for (const c of columns) out[c] = clean(row?.[c]);
  return out;
}

function sameList(a, b) {
  if (a.length !== b.length) return false;
  return a.every((row, i) => JSON.stringify(row) === JSON.stringify(b[i]));
}

/**
 * Everything a self-service form is allowed to carry, and nothing else.
 *
 * Applied before a submission is stored, not after. A payload naming
 * `job_title` or `hired_on` is not an error to report — it is a field the form
 * never offered, so it is dropped on the way in and the rest is kept.
 */
export function cleanSubmission(payload, plan = null) {
  const profile = {};
  for (const field of SELF_FIELDS) {
    // A field this property does not ask for is dropped exactly as a field
    // nobody may fill in is dropped. The form not showing it is a courtesy;
    // this is the gate.
    if (askFor(plan, 'fields', field.key) === 'skip') continue;
    const value = payload?.profile?.[field.key];
    if (value === undefined) continue;
    profile[field.key] = clean(value).slice(0, field.type === 'textarea' ? 600 : 200);
  }

  const lists = {};
  for (const list of LISTS) {
    if (!list.self) continue;
    if (askFor(plan, 'lists', list.key) === 'skip') continue;
    const rows = payload?.lists?.[list.key];
    if (!Array.isArray(rows)) continue;
    lists[list.key] = rows.slice(0, 12).map((row) => {
      const out = {};
      for (const c of list.columns) out[c] = clean(row?.[c]).slice(0, 200);
      return out;
    }).filter((row) => Object.values(row).some((v) => v !== ''));
  }

  return { profile, lists };
}

// ---------------------------------------------------------------------------
// Contracts
// ---------------------------------------------------------------------------

/**
 * What a template may refer to.
 *
 * A short list on purpose. Every placeholder is something the property already
 * knows for certain, so issuing a contract cannot silently produce the words
 * "salary of {{salary}}" in something somebody then signs.
 */
export const PLACEHOLDERS = [
  // Known for certain, straight out of the record or the settings.
  { key: 'name', label: 'Full name' },
  { key: 'first_name', label: 'First name' },
  { key: 'employee_no', label: 'Employee number' },
  { key: 'job_title', label: 'Job title' },
  { key: 'department', label: 'Department' },
  { key: 'start_date', label: 'Start date' },
  { key: 'address', label: 'Home address' },
  { key: 'id_type', label: 'ID document' },
  { key: 'property', label: 'Property name' },
  { key: 'property_address', label: 'Property address' },
  { key: 'leave_days', label: 'Annual leave' },
  { key: 'today', label: 'Today’s date' },

  // Typed in when the contract is issued, because they differ per person and
  // the property is the only one who knows them. Each has a fallback that is
  // lawful and conservative, so a contract issued in a hurry with the boxes
  // left empty still says something true.
  { key: 'salary', label: 'Remuneration', ask: true },
  {
    key: 'hours',
    label: 'Hours of work',
    ask: true,
    fallback: 'Hours are as set out in the published rota.',
  },
  { key: 'workplace', label: 'Place of work', ask: true, fallback: 'At the property.' },
  { key: 'probation', label: 'Probation', ask: true, fallback: 'six months' },
  { key: 'notice', label: 'Notice period', ask: true, fallback: 'one month' },
  { key: 'end_date', label: 'End date (fixed term)', ask: true },
  { key: 'effective_date', label: 'Effective from', ask: true },
  {
    key: 'collective_agreement',
    label: 'Collective agreement',
    ask: true,
    fallback: 'None applies to this employment.',
  },
  { key: 'note', label: 'A line of your own', ask: true, fallback: '' },
];

export const ASKED_PLACEHOLDERS = PLACEHOLDERS.filter((p) => p.ask);

/**
 * A template with its placeholders filled in.
 *
 * A placeholder with nothing to put in it is left visibly unfilled rather than
 * replaced with an empty space. A contract that reads "a notice period of"
 * followed by nothing is obviously wrong; one that reads "a notice period of
 * ⟨notice⟩" says which word is missing and who has to supply it.
 */
export function renderTemplate(body, values) {
  return String(body ?? '').replace(/\{\{\s*([a-z_]+)\s*\}\}/gi, (whole, key) => {
    const value = values?.[key.toLowerCase()];
    if (value == null || String(value).trim() === '') {
      const known = PLACEHOLDERS.find((p) => p.key === key.toLowerCase());
      return known ? `⟨${known.label.toLowerCase()}⟩` : whole;
    }
    return String(value);
  });
}

/** Which placeholders a template actually uses. */
export function placeholdersIn(body) {
  const found = new Set();
  for (const m of String(body ?? '').matchAll(/\{\{\s*([a-z_]+)\s*\}\}/gi)) {
    found.add(m[1].toLowerCase());
  }
  return PLACEHOLDERS.filter((p) => found.has(p.key));
}

/**
 * The fingerprint of the words somebody signed.
 *
 * Recorded at the moment of signing and never recomputed from the stored text.
 * If the two ever disagree, the text has been altered since — which is exactly
 * the thing a signature is supposed to be able to prove.
 */
export async function hashBody(body) {
  const bytes = new TextEncoder().encode(String(body ?? ''));
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** A hash as a person can read it back over the phone. */
export function shortHash(hash) {
  return String(hash ?? '').slice(0, 16).replace(/(.{4})(?=.)/g, '$1 ').toUpperCase();
}
