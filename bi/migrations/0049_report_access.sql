-- Which report pages each person who is not an admin may open: a supervisor,
-- an uploader, or somebody with Insight as "Reports only". An admin ticks
-- them under Admin › Who sees which reports. Admins and owners see every
-- report and have no rows here.
CREATE TABLE IF NOT EXISTS report_access (
  account_id INTEGER NOT NULL,
  report     TEXT    NOT NULL,
  granted_by TEXT,
  at         TEXT    NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (account_id, report)
);
