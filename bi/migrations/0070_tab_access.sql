-- Settings › People & access › Who sees what: each tab in Insight, and how far
-- somebody who is not an admin may go with it: 0 hidden, 1 see, 2 do.
--
-- Written for a person the first time an admin saves them in that table, and
-- then for every tab, hidden ones included, so a person with rows here has an
-- answer for every tab. Somebody with no rows still gets what their role and
-- the Shifts areas and shared reports give them (routes/tabaccess.js).
CREATE TABLE IF NOT EXISTS tab_access (
  account_id INTEGER NOT NULL,
  tab        TEXT    NOT NULL,
  level      INTEGER NOT NULL DEFAULT 0,
  set_by     TEXT,
  at         TEXT    NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (account_id, tab)
);
