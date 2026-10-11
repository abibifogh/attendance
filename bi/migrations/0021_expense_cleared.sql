-- Expense form entries no drawer paid that an admin has looked at and
-- cleared from the Advances list. Kept by PO, so a cleared one stays cleared.
CREATE TABLE IF NOT EXISTS expense_cleared (
  po      TEXT PRIMARY KEY,
  by_name TEXT,
  at      TEXT NOT NULL DEFAULT (datetime('now'))
);
