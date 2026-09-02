-- Wrong sign-in attempts, counted somewhere that survives.
--
-- Login is by PIN alone, and a PIN is a handful of digits. The brake on
-- guessing lived in the memory of whichever Worker isolate took the request,
-- and there are many of those, each starting from nothing, so a guesser
-- spread across them was never really slowed. This table is one counter per
-- address and one for the whole property, and it is the same table whichever
-- isolate answers.
--
-- `first_at` is seconds since the epoch, when the current window opened. A
-- window is ten minutes; rows older than that are swept as new ones arrive,
-- so the table never holds more than the last ten minutes of bad guesses.
CREATE TABLE IF NOT EXISTS login_attempts (
  key      TEXT    PRIMARY KEY,
  first_at INTEGER NOT NULL,
  count    INTEGER NOT NULL DEFAULT 0
);
