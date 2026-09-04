import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

import {
  readColumns, readDate, readStaffSheet, readTracking, readYesNo, tallyOf,
} from '../src/lib/staff-import.js';
import { applyStaffImport, readStaffImport, staffTemplate } from '../src/routes/attendance-setup.js';

/**
 * The register, out of a spreadsheet.
 *
 * The one import in the app that creates people, so the whole safety of it is
 * in what happens before the button: every line worked out, every addition
 * named, and nothing written until somebody has read it.
 */

// ---------------------------------------------------------------------------
// Cells
// ---------------------------------------------------------------------------

test('a date is read however the spreadsheet wrote it', () => {
  assert.equal(readDate('2020-01-06'), '2020-01-06');
  assert.equal(readDate('06/01/2020'), '2020-01-06', 'day first, which is how it is written here');
  assert.equal(readDate('6 Jan 2020'), '2020-01-06');
  assert.equal(readDate('43836'), '2020-01-06', "Excel's own count of days");
  assert.equal(readDate(''), null);
  assert.ok(Number.isNaN(readDate('sometime in March')));
});

test('yes and no in the words people type', () => {
  for (const yes of ['Yes', 'y', 'TRUE', '1', 'x', '✓']) assert.equal(readYesNo(yes), true, yes);
  for (const no of ['No', 'n', 'false', '0', '-']) assert.equal(readYesNo(no), false, no);
  assert.equal(readYesNo(''), null, 'a column left alone is not a no');
  assert.ok(Number.isNaN(readYesNo('maybe')));
});

test('what somebody is here for, in the sheet’s own words', () => {
  assert.equal(readTracking('Payroll only'), 'payroll');
  assert.equal(readTracking('never rostered'), 'no-rota');
  assert.equal(readTracking('Rota'), 'full');
  assert.equal(readTracking(''), null);
  assert.ok(Number.isNaN(readTracking('sort of')));
});

test('a heading nobody knows is named back rather than dropped quietly', () => {
  const { columns, unknown } = readColumns(['Employee no', 'Name', 'Blood group']);
  assert.deepEqual(columns.map((c) => c.kind), ['employeeNo', 'name']);
  assert.deepEqual(unknown, ['Blood group']);
});

test('the same heading twice does not let the second overrule the first', () => {
  const { columns, unknown } = readColumns(['Employee no', 'Name', 'Full name']);
  assert.equal(columns.filter((c) => c.kind === 'name').length, 1);
  assert.deepEqual(unknown, ['Full name']);
});

// ---------------------------------------------------------------------------
// Reading a sheet
// ---------------------------------------------------------------------------

const HEAD = 'Employee no,Name,Department,Job title,Started,Phone,Basic salary,Here for';

const known = [
  { id: 1, employee_no: '1', name: 'Kofi Mensah', department: 'Kitchen', job_title: 'Cook',
    hired_on: '2020-01-06', active: 1, on_rota: 1, on_clock: 1, leave_days: null,
    days_per_week: null, note: null, left_on: null },
];

test('a number nobody here has is somebody new', () => {
  const read = readStaffSheet(`${HEAD}\n9,Ama Owusu,Reception,Receptionist,2026-02-01,024 123 4567,1500,Rota`,
    { staff: known });

  assert.equal(read.lines.length, 1);
  assert.equal(read.lines[0].adding, true);
  assert.equal(read.lines[0].name, 'Ama Owusu');
  assert.equal(tallyOf(read).adding, 1);
});

test('a number somebody here has is a change, not a second person', () => {
  const read = readStaffSheet(`${HEAD}\n1,Kofi Mensah,F&B,Cook,2020-01-06,,,Rota`,
    { staff: known });

  const [line] = read.lines;
  assert.equal(line.adding, false);
  assert.deepEqual(line.changes.map((c) => c.label), ['Department']);
  assert.equal(line.changes[0].from, 'Kitchen');
  assert.equal(line.changes[0].to, 'F&B');
});

test('a blank cell leaves what is there alone', () => {
  const read = readStaffSheet(`${HEAD}\n1,Kofi Mensah,,,,,,`, { staff: known });
  assert.equal(read.lines.length, 0, 'nothing to do at all');
  assert.equal(tallyOf(read).nothing, true);
});

test('a line with no employee number is skipped and said so', () => {
  const read = readStaffSheet(`${HEAD}\n,Ama Owusu,Reception,,,,,`, { staff: known });
  assert.equal(read.lines.length, 0);
  assert.equal(read.skipped[0].why, 'no employee number');
  assert.equal(read.skipped[0].at, 2);
});

test('the same number twice in one file is caught', () => {
  const read = readStaffSheet(
    `${HEAD}\n9,Ama Owusu,Reception,,,,,\n9,Ama O,Reception,,,,,`, { staff: known },
  );
  assert.equal(read.lines.length, 1);
  assert.match(read.skipped[0].why, /earlier line/);
});

test('a cell that cannot be read is a note, and the rest of the line still counts', () => {
  const read = readStaffSheet(
    `${HEAD}\n1,Kofi Mensah,F&B,,not a date,,,`, { staff: known },
  );
  const [line] = read.lines;
  assert.deepEqual(line.changes.map((c) => c.label), ['Department']);
  assert.equal(line.notes[0].what, 'Started');
});

test('a sheet with no number column says what it needs', () => {
  const read = readStaffSheet('Name,Department\nAma,Reception', { staff: known });
  assert.deepEqual(read.missingColumns, ['an employee number column']);
});

test('an empty file is not a crash', () => {
  const read = readStaffSheet('', {});
  assert.deepEqual(read.missingColumns, ['a header row']);
  assert.equal(read.lines.length, 0);
});

// ---------------------------------------------------------------------------
// Writing it
// ---------------------------------------------------------------------------

function d1(db) {
  const st = (sql, binds = []) => ({
    bind(...a) { return st(sql, a); },
    async all() { return { results: db.prepare(sql).all(...binds) }; },
    async first() { return db.prepare(sql).get(...binds) ?? null; },
    async run() {
      const r = db.prepare(sql).run(...binds);
      return { success: true, meta: { changes: Number(r.changes ?? 0) } };
    },
  });
  return {
    prepare: (sql) => st(sql),
    async batch(l) { const o = []; for (const s of l) o.push(await s.run()); return o; },
  };
}

function setup() {
  const raw = new DatabaseSync(':memory:');
  raw.exec('PRAGMA foreign_keys = ON;');
  for (const f of readdirSync('migrations').filter((n) => n.endsWith('.sql')).sort()) {
    raw.exec(readFileSync(`migrations/${f}`, 'utf8'));
  }
  raw.exec(`DELETE FROM att_days; DELETE FROM att_punches; DELETE FROM att_roster;
            DELETE FROM att_patterns; DELETE FROM att_shifts; DELETE FROM att_staff;`);
  raw.exec("UPDATE settings SET value = 'UTC' WHERE key = 'timezone'");
  return { raw, db: d1(raw) };
}

const ADMIN = { user: { id: 1, name: 'Kwame', role: 'admin' }, permissions: ['att_setup'] };
// Somebody who can set the register up and cannot open an employee's record.
// The commonest shape in a property: the person who keeps the rota is not the
// person who keeps the bank accounts.
const PLANNER = {
  user: { id: 2, name: 'Yaa', role: 'manager' },
  permissions: ['att_setup'],
};
const ctx = (db, text, session = ADMIN) => ({
  db,
  env: {},
  url: new URL('https://x/api/att/staff/import'),
  session,
  executionContext: null,
  request: new Request('https://x/', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text }),
  }),
});

test('a whole register arrives in one go', async () => {
  const { raw, db } = setup();
  const sheet = `${HEAD}
1,Kofi Mensah,Kitchen,Cook,2020-01-06,024 123 4567,1800,Rota
2,Ama Owusu,Reception,Receptionist,06/02/2021,0551234567,1500,Rota
3,The Director,Office,Director,,,6000,Payroll only`;

  const out = await (await applyStaffImport(ctx(db, sheet))).json();
  assert.equal(out.added, 3);
  assert.deepEqual(out.failed, []);

  const people = raw.prepare('SELECT * FROM att_staff ORDER BY employee_no').all();
  assert.deepEqual(people.map((p) => p.name), ['Kofi Mensah', 'Ama Owusu', 'The Director']);
  assert.equal(people[1].hired_on, '2021-02-06', 'day first');

  const director = people[2];
  assert.equal(director.on_clock, 0);
  assert.equal(director.on_rota, 0, 'payroll only is off the rota too');

  const phones = raw.prepare(
    'SELECT personal_phone FROM hr_profile ORDER BY staff_id',
  ).all().map((r) => r.personal_phone);
  assert.deepEqual(phones, ['024 123 4567', '0551234567']);

  const pay = raw.prepare('SELECT staff_id, basic FROM pay_profile ORDER BY staff_id').all();
  assert.equal(pay.length, 3);
  assert.equal(pay[2].basic, 6000, 'a basic in a staff sheet puts them on the payroll');
});

test('running the same file twice adds nobody a second time', async () => {
  const { raw, db } = setup();
  const sheet = `${HEAD}\n1,Kofi Mensah,Kitchen,Cook,2020-01-06,,1800,Rota`;

  await applyStaffImport(ctx(db, sheet));
  const again = await (await applyStaffImport(ctx(db, sheet))).json();

  assert.equal(again.added, 0);
  assert.equal(again.changed, 0, 'nothing about them is different');
  assert.equal(raw.prepare('SELECT COUNT(*) n FROM att_staff').get().n, 1);
});

test('a change to somebody already here does not touch what the sheet left blank', async () => {
  const { raw, db } = setup();
  raw.prepare(
    `INSERT INTO att_staff (id, employee_no, name, department, job_title, hired_on, note)
     VALUES (1, '1', 'Kofi Mensah', 'Kitchen', 'Cook', '2020-01-06', 'Keyholder')`,
  ).run();

  const out = await (await applyStaffImport(
    ctx(db, `${HEAD}\n1,Kofi Mensah,F&B,,,,,`),
  )).json();

  assert.equal(out.changed, 1);
  const row = raw.prepare('SELECT * FROM att_staff WHERE id = 1').get();
  assert.equal(row.department, 'F&B');
  assert.equal(row.job_title, 'Cook', 'a blank cell is not an instruction to clear it');
  assert.equal(row.note, 'Keyholder');
});

test('taking somebody off the rota by spreadsheet clears the rota ahead of them', async () => {
  const { raw, db } = setup();
  raw.prepare(
    `INSERT INTO att_shifts (id, name, starts_at, ends_at, break_minutes,
                             grace_in_minutes, grace_out_minutes)
     VALUES (1, 'Morning', '06:00', '14:00', 0, 5, 5)`,
  ).run();
  raw.prepare(
    `INSERT INTO att_staff (id, employee_no, name, hired_on) VALUES (1, '1', 'Kofi', '2020-01-01')`,
  ).run();
  const soon = new Date(Date.now() + 4 * 86_400_000).toISOString().slice(0, 10);
  raw.prepare('INSERT INTO att_roster (staff_id, day, shift_id) VALUES (1, ?, 1)').run(soon);

  await applyStaffImport(ctx(db, `${HEAD}\n1,Kofi,,,,,,Payroll only`));

  assert.equal(raw.prepare('SELECT COUNT(*) n FROM att_roster').get().n, 0);
  assert.equal(raw.prepare('SELECT on_clock FROM att_staff WHERE id = 1').get().on_clock, 0);
});

test('a number invented for the payroll does not swallow somebody’s punches', async () => {
  const { raw, db } = setup();
  raw.prepare(
    `INSERT INTO att_punches
       (device_serial, employee_no, at_utc, at_local, day, direction, source, dedupe_key)
     VALUES ('T1', 'D1', '2026-06-02T06:00:00Z', '2026-06-02 06:00', '2026-06-02', 'in', 'device', 'k')`,
  ).run();

  await applyStaffImport(ctx(db, `${HEAD}\nD1,The Director,,,,,6000,Payroll only`));

  assert.equal(raw.prepare('SELECT staff_id FROM att_punches').get().staff_id, null);
});

test('the preview writes nothing', async () => {
  const { raw, db } = setup();
  const out = await (await readStaffImport(
    ctx(db, `${HEAD}\n9,Ama Owusu,Reception,,,,,`),
  )).json();

  assert.equal(out.tally.adding, 1);
  assert.equal(raw.prepare('SELECT COUNT(*) n FROM att_staff').get().n, 0,
    'nothing until somebody presses the button');
});

test('an empty file is refused rather than run', async () => {
  const { db } = setup();
  await assert.rejects(() => applyStaffImport(ctx(db, '   ')), /nothing in that file/i);
});

test('a sheet with no number column is refused at the write, not just the preview', async () => {
  const { db } = setup();
  await assert.rejects(
    () => applyStaffImport(ctx(db, 'Name,Department\nAma,Reception')),
    /employee number/i,
  );
});

// ---------------------------------------------------------------------------
// The sheet that comes down
// ---------------------------------------------------------------------------

test('the template is the property’s own people, not a blank form', async () => {
  const { raw, db } = setup();
  raw.prepare(
    `INSERT INTO att_staff (id, employee_no, name, department, hired_on, on_clock, on_rota)
     VALUES (1, '1', 'Kofi', 'Kitchen', '2020-01-06', 1, 1)`,
  ).run();
  raw.prepare('INSERT INTO hr_profile (staff_id, personal_phone) VALUES (1, ?)')
    .run('024 123 4567');
  raw.prepare('INSERT INTO pay_profile (staff_id, basic) VALUES (1, 1800)').run();

  const body = await (await staffTemplate(ctx(db, ''))).text();
  const [head, row] = body.trim().split('\n');
  assert.match(head, /Employee no/);
  assert.match(row, /Kofi/);
  assert.match(row, /024 123 4567/);
  assert.match(row, /1800\.00/);
});

test('a property with nobody yet gets the columns shown, not described', async () => {
  const { db } = setup();
  const body = await (await staffTemplate(ctx(db, ''))).text();
  assert.equal(body.trim().split('\n').length, 2, 'a header and one example');
  assert.match(body, /example/i);
});

test('a round trip through the template changes nothing', async () => {
  const { raw, db } = setup();
  await applyStaffImport(ctx(db, `${HEAD}\n1,Kofi Mensah,Kitchen,Cook,2020-01-06,024 123 4567,1800,Rota`));

  const sheet = await (await staffTemplate(ctx(db, ''))).text();
  const read = await (await readStaffImport(ctx(db, sheet))).json();

  assert.equal(read.tally.nothing, true, 'what came down is what is already here');
  assert.equal(raw.prepare('SELECT COUNT(*) n FROM att_staff').get().n, 1);
});

// ---------------------------------------------------------------------------
// Everything else about somebody
// ---------------------------------------------------------------------------

test('the template carries the whole record, not just the register', async () => {
  const { raw, db } = setup();
  raw.prepare(
    `INSERT INTO att_staff (id, employee_no, name, department, hired_on)
     VALUES (1, '1', 'Kofi', 'Kitchen', '2020-01-06')`,
  ).run();
  raw.prepare(
    `INSERT INTO hr_profile (staff_id, preferred_name, personal_phone, alt_phone,
                             personal_email, date_of_birth, town, id_number, bank_name)
     VALUES (1, 'Kofi', '024 123 4567', '055 999 1111', 'kofi@example.com',
             '1996-07-14', 'Accra', 'GHA-123', 'Absa')`,
  ).run();
  raw.prepare(
    `INSERT INTO hr_contact (staff_id, kind, name, phone, relationship)
     VALUES (1, 'emergency', 'Adjoa', '020 987 6543', 'Sister')`,
  ).run();

  const body = await (await staffTemplate(ctx(db, ''))).text();
  for (const shown of ['Kofi', '024 123 4567', '055 999 1111', 'kofi@example.com',
    '1996-07-14', 'Accra', 'Adjoa', '020 987 6543', 'Sister', 'GHA-123', 'Absa']) {
    assert.match(body, new RegExp(shown.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), shown);
  }
});

test('the numbers are left off the sheet of somebody who cannot see them', async () => {
  const { raw, db } = setup();
  raw.prepare(
    `INSERT INTO att_staff (id, employee_no, name, hired_on) VALUES (1, '1', 'Kofi', '2020-01-06')`,
  ).run();
  raw.prepare('INSERT INTO hr_profile (staff_id, id_number, account_number) VALUES (1, ?, ?)')
    .run('GHA-123', '9988776655');

  const mine = await (await staffTemplate(ctx(db, '', PLANNER))).text();
  assert.ok(!mine.includes('GHA-123'), 'an ID number is not theirs to read');
  assert.ok(!mine.includes('9988776655'));
  assert.ok(!mine.includes('Account number'), 'and the column is not there to fill in');

  // And it is on the sheet of somebody who could have opened the record.
  const theirs = await (await staffTemplate(ctx(db, ''))).text();
  assert.match(theirs, /GHA-123/);
  assert.match(theirs, /Account number/);
});

test('a sheet fills in contact details, and a blank cell leaves what is there', async () => {
  const { raw, db } = setup();
  await applyStaffImport(ctx(db, 'Employee no,Name\n1,Kofi Mensah'));
  const id = raw.prepare("SELECT id FROM att_staff WHERE employee_no = '1'").get().id;
  raw.prepare('INSERT OR IGNORE INTO hr_profile (staff_id) VALUES (?)').run(id);
  raw.prepare('UPDATE hr_profile SET personal_email = ? WHERE staff_id = ?')
    .run('old@example.com', id);

  const sheet = [
    'Employee no,Phone,Other phone,Email,Town,Next of kin,Next of kin phone',
    '1,024 111 2222,055 333 4444,,Accra,Adjoa Mensah,020 987 6543',
  ].join('\n');
  const out = await (await applyStaffImport(ctx(db, sheet))).json();
  assert.equal(out.changed, 1);

  const profile = raw.prepare('SELECT * FROM hr_profile WHERE staff_id = ?').get(id);
  assert.equal(profile.personal_phone, '024 111 2222');
  assert.equal(profile.alt_phone, '055 333 4444');
  assert.equal(profile.town, 'Accra');
  assert.equal(profile.personal_email, 'old@example.com', 'a blank cell is not an instruction');

  const kin = raw.prepare('SELECT * FROM hr_contact WHERE staff_id = ?').get(id);
  assert.equal(kin.name, 'Adjoa Mensah');
  assert.equal(kin.phone, '020 987 6543');
});

test('next of kin already on file is changed rather than doubled', async () => {
  const { raw, db } = setup();
  await applyStaffImport(ctx(db, 'Employee no,Name\n1,Kofi Mensah'));
  const id = raw.prepare("SELECT id FROM att_staff WHERE employee_no = '1'").get().id;
  raw.prepare(
    `INSERT INTO hr_contact (staff_id, kind, name, phone) VALUES (?, 'emergency', 'Adjoa', '020 1')`,
  ).run(id);

  await applyStaffImport(ctx(db, 'Employee no,Next of kin phone\n1,020 987 6543'));

  const rows = raw.prepare('SELECT * FROM hr_contact WHERE staff_id = ?').all(id);
  assert.equal(rows.length, 1, 'one person to ring, not two');
  assert.equal(rows[0].name, 'Adjoa', 'their name is left alone');
  assert.equal(rows[0].phone, '020 987 6543');
});

test('a number a sheet may not set is refused with a reason, not dropped', async () => {
  const { raw, db } = setup();
  await applyStaffImport(ctx(db, 'Employee no,Name\n1,Kofi Mensah'));
  const sheet = 'Employee no,Account number,Town\n1,9988776655,Accra';

  const read = await (await readStaffImport(ctx(db, sheet, PLANNER))).json();
  const [line] = read.lines;
  assert.ok(line.notes.some((n) => /manage employee records/i.test(n.why)),
    JSON.stringify(line.notes));
  // And the rest of the line still goes in: one column they may not touch does
  // not throw away the eight they may.
  assert.ok(line.changes.some((c) => c.label === 'Town'));

  await applyStaffImport(ctx(db, sheet, PLANNER));
  const id = raw.prepare("SELECT id FROM att_staff WHERE employee_no = '1'").get().id;
  const profile = raw.prepare('SELECT * FROM hr_profile WHERE staff_id = ?').get(id);
  assert.equal(profile.account_number, null, 'nothing was written');
  assert.equal(profile.town, 'Accra');
});

test('a date of birth is read the same four ways a start date is', async () => {
  const { raw, db } = setup();
  await applyStaffImport(ctx(db, 'Employee no,Name\n1,Kofi Mensah'));
  await applyStaffImport(ctx(db, 'Employee no,Date of birth\n1,14/07/1996'));

  const id = raw.prepare("SELECT id FROM att_staff WHERE employee_no = '1'").get().id;
  assert.equal(
    raw.prepare('SELECT date_of_birth d FROM hr_profile WHERE staff_id = ?').get(id).d,
    '1996-07-14',
  );
});

test('the round trip still changes nothing with every column on it', async () => {
  const { raw, db } = setup();
  raw.prepare(
    `INSERT INTO att_staff (id, employee_no, name, department, hired_on)
     VALUES (1, '1', 'Kofi', 'Kitchen', '2020-01-06')`,
  ).run();
  raw.prepare(
    `INSERT INTO hr_profile (staff_id, preferred_name, personal_phone, alt_phone, personal_email,
                             date_of_birth, gender, address_line, town, region, digital_address,
                             id_type, id_number, ssnit_number, tin_number, pay_method,
                             bank_name, bank_branch, account_name, account_number,
                             momo_network, momo_number)
     VALUES (1, 'Kofi', '024 1', '055 2', 'k@x.test', '1996-07-14', 'Male', '12 High St',
             'Accra', 'Greater Accra', 'GA-183-9271', 'Ghana Card', 'GHA-123', 'C123', 'T456',
             'bank', 'Absa', 'Osu', 'Kofi Mensah', '9988', 'MTN', '024 1')`,
  ).run();
  raw.prepare(
    `INSERT INTO hr_contact (staff_id, kind, name, phone, relationship)
     VALUES (1, 'emergency', 'Adjoa', '020 9', 'Sister')`,
  ).run();

  const sheet = await (await staffTemplate(ctx(db, ''))).text();
  const read = await (await readStaffImport(ctx(db, sheet))).json();
  assert.equal(read.tally.nothing, true, JSON.stringify(read.lines));
});

test('a sheet of nothing but phone numbers needs no name column', async () => {
  const { raw, db } = setup();
  await applyStaffImport(ctx(db, 'Employee no,Name\n1,Kofi Mensah\n2,Ama Boateng'));

  const out = await (await applyStaffImport(ctx(db,
    'Employee no,Phone\n1,024 111 2222\n2,055 333 4444'))).json();
  assert.equal(out.changed, 2);
  assert.deepEqual(out.failed, []);

  const numbers = raw.prepare(
    'SELECT personal_phone p FROM hr_profile ORDER BY staff_id',
  ).all().map((r) => r.p);
  assert.deepEqual(numbers, ['024 111 2222', '055 333 4444']);
});

test('but a number nobody has still needs one, and says how many', async () => {
  const { db } = setup();
  await applyStaffImport(ctx(db, 'Employee no,Name\n1,Kofi Mensah'));

  await assert.rejects(
    () => applyStaffImport(ctx(db, 'Employee no,Phone\n1,024 1\n99,024 2\n98,024 3')),
    /a name column, for the 2 numbers on it that nobody here has/,
  );
});
