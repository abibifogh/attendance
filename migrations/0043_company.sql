-- Who the employer is, on paper.
--
-- The property already had a name and an address, because a contract needs
-- them. A payslip needs more: somebody handed one has to be able to tell which
-- company paid them, ring the office about a figure they do not recognise, and
-- quote the employer's SSNIT number when they walk into a SSNIT branch. All of
-- that lives on the printed slip in every payroll worth the name, and none of
-- it was anywhere in this app.
--
-- The text fields are settings, because that is where the property's own
-- particulars already live and there is one of each. The logo is not: it is
-- bytes, it is one image, and a picture sitting in a key/value table would be
-- fetched every time anything read a setting.

CREATE TABLE IF NOT EXISTS company_logo (
  -- One row, ever. The check is the whole point of the column.
  id      INTEGER PRIMARY KEY CHECK (id = 1),
  mime    TEXT    NOT NULL,
  bytes   INTEGER NOT NULL,
  content BLOB    NOT NULL,

  uploaded_by TEXT,
  uploaded_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Blank until somebody fills them in, and a payslip simply leaves out the
-- lines that are still blank rather than printing an empty label.
INSERT INTO settings (key, value) VALUES
  ('company_legal_name', ''),
  ('company_phone', ''),
  ('company_email', ''),
  ('company_website', ''),
  ('company_tin', ''),
  ('company_ssnit', ''),
  -- When the logo last changed, so a browser holding an old one asks again.
  ('company_logo_at', '')
ON CONFLICT (key) DO NOTHING;
