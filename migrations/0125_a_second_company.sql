-- More than one employer.
--
-- The property's staff are employed by Sir Tobys Ghana LTD, and a second
-- company, Abibifo crafts and More, employs people of its own. Nobody works for
-- both. Each needs its own payroll, its own payslips and its own GRA and SSNIT
-- returns, under its own name and numbers.
--
-- Row 1 is the company the settings already describe. Its particulars stay in
-- the settings, where the Company form, the payslip and the emails have always
-- read them, so nothing about it moves; the row is here so a person and a
-- payroll can point at it. Every other company keeps its particulars here.
CREATE TABLE IF NOT EXISTS company (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  main            INTEGER NOT NULL DEFAULT 0,
  legal_name      TEXT    NOT NULL DEFAULT '',
  address         TEXT,
  phone           TEXT,
  email           TEXT,
  website         TEXT,
  tin             TEXT,
  ssnit           TEXT,
  tax_office_kind TEXT,
  tax_office      TEXT,
  -- The picture on its payslips. The main company's is in company_logo, which
  -- only ever holds one row.
  logo_mime       TEXT,
  logo_content    BLOB,
  logo_at         TEXT,
  created_by      TEXT,
  created_at      TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_by      TEXT,
  updated_at      TEXT
);

INSERT INTO company (id, main, legal_name, created_by)
  VALUES (1, 1, '', 'HIVE')
  ON CONFLICT (id) DO NOTHING;

INSERT INTO company (legal_name, created_by)
  SELECT 'Abibifo crafts and More', 'HIVE'
  WHERE NOT EXISTS (SELECT 1 FROM company WHERE main = 0);

-- Who employs each person. Empty is the main company, which is everybody
-- until somebody says otherwise.
ALTER TABLE att_staff ADD COLUMN company_id INTEGER REFERENCES company (id);

-- Whose payroll a month is. The month column stays unique, so a second
-- company's run is written as '2026-10@2' and read back by its first seven
-- characters; the main company's months keep the plain form they always had.
ALTER TABLE pay_run ADD COLUMN company_id INTEGER NOT NULL DEFAULT 1;
