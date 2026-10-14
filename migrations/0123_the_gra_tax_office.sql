-- The GRA office the property files its PAYE with, for the heading of the
-- schedule: which kind (a tick against LTO or TSC on the form) and its name.
-- The name keeps what the schedule printed until now.
INSERT OR IGNORE INTO settings (key, value) VALUES ('gra_tax_office_kind', '');
INSERT OR IGNORE INTO settings (key, value) VALUES ('gra_tax_office', 'NIMA');
