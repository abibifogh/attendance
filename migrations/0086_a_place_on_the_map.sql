-- Where an interview is, precisely enough for somebody to find it.
--
-- The place was a line of text, which is fine for whoever wrote it and no use
-- at all to a candidate reading it on a phone at the other end of Accra.
-- "The office, main building" is not somewhere anybody can navigate to.
--
-- So a place picked off Google's map keeps what makes it findable: which place
-- it was, and where on the earth it is. Those turn into a directions link on
-- the candidate's own page, which is the whole reason for asking Google at all
-- rather than only autocompleting a box.
--
-- All three are optional. A property with no key set, or somebody who would
-- rather just type "the office", carries on exactly as before: the text is the
-- text, and there is no link.
ALTER TABLE rec_slot ADD COLUMN place_id  TEXT;
ALTER TABLE rec_slot ADD COLUMN place_lat REAL;
ALTER TABLE rec_slot ADD COLUMN place_lng REAL;

-- The default that fills the publish form, kept the same way so a property
-- that picks its own front desk once never picks it again.
INSERT OR IGNORE INTO settings (key, value) VALUES ('rec_place_id', '');
INSERT OR IGNORE INTO settings (key, value) VALUES ('rec_place_lat', '');
INSERT OR IGNORE INTO settings (key, value) VALUES ('rec_place_lng', '');

-- The key, if the property is pasting one in rather than setting a Worker
-- secret. Never sent to a browser: the bootstrap only carries settings whose
-- names begin att_, wl_ or company_, and this is deliberately none of those.
INSERT OR IGNORE INTO settings (key, value) VALUES ('maps_key', '');

-- Which country's places to offer first. Seeded to Ghana because that is where
-- this property is, and a setting rather than a constant because the next one
-- may not be.
INSERT OR IGNORE INTO settings (key, value) VALUES ('maps_region', 'gh');
