-- The lunch list settles down.
--
-- Three things were being decided every week that a kitchen decides once.
--
-- THE MENU REPEATS. Monday is the same thing every Monday. It was stored
-- against calendar dates, so somebody had to type the same seven meals in
-- again every week and a week nobody got round to had no menu at all. It is
-- now a standing week of seven, and the date it lands on is arithmetic.
--
-- THE LINK STAYS. The address on the noticeboard was tied to whether the list
-- was taking answers: closing it and opening it again meant making a new link,
-- which meant a new address on the noticeboard every week. The link is now
-- just the link, and whether answers are being taken is a separate question.
--
-- THE WINDOW HAS TIMES IN IT. "Open on Thursday" leaves the kitchen and the
-- staff disagreeing about whether that includes Thursday evening. It now opens
-- at a time on a day and shuts at a time on a day, the same two moments every
-- week, without anybody pressing anything.
CREATE TABLE IF NOT EXISTS lunch_menu_week (
  dow    INTEGER PRIMARY KEY CHECK (dow BETWEEN 1 AND 7),
  meal   TEXT    NOT NULL,
  note   TEXT,
  set_by TEXT,
  set_at TEXT    NOT NULL DEFAULT (datetime('now'))
);

-- Whatever was last set for each weekday carries over, so a property that had
-- filled a week in does not open on Monday to an empty menu.
INSERT INTO lunch_menu_week (dow, meal, note, set_by, set_at)
SELECT dow, meal, note, set_by, set_at FROM (
  SELECT
    CAST(STRFTIME('%w', day) AS INTEGER)
      + CASE STRFTIME('%w', day) WHEN '0' THEN 7 ELSE 0 END AS dow,
    meal, note, set_by, set_at,
    -- The latest one wins, said as a rule rather than left to the order rows
    -- happen to come back in.
    ROW_NUMBER() OVER (
      PARTITION BY STRFTIME('%w', day) ORDER BY day DESC
    ) AS newest
  FROM lunch_menu
  WHERE meal IS NOT NULL AND TRIM(meal) <> ''
)
WHERE newest = 1;

DROP TABLE IF EXISTS lunch_menu;

-- The window, out of the old list of open days. The first day it was open on
-- at the beginning of that day, through to the beginning of the day after the
-- last, which is exactly what "open Thursday to Sunday" meant before.
INSERT INTO settings (key, value) VALUES
  ('lunch_opens_dow', '4'),
  ('lunch_opens_at', '00:00'),
  ('lunch_closes_dow', '1'),
  ('lunch_closes_at', '00:00')
ON CONFLICT (key) DO NOTHING;

UPDATE settings SET value = (
  SELECT CAST(SUBSTR(value, 1, 1) AS TEXT) FROM settings WHERE key = 'lunch_open_days'
)
WHERE key = 'lunch_opens_dow'
  AND EXISTS (SELECT 1 FROM settings WHERE key = 'lunch_open_days' AND value <> '');

UPDATE settings SET value = (
  SELECT CAST(
    CASE WHEN CAST(SUBSTR(value, -1) AS INTEGER) = 7 THEN 1
         ELSE CAST(SUBSTR(value, -1) AS INTEGER) + 1 END AS TEXT)
  FROM settings WHERE key = 'lunch_open_days'
)
WHERE key = 'lunch_closes_dow'
  AND EXISTS (SELECT 1 FROM settings WHERE key = 'lunch_open_days' AND value <> '');

DELETE FROM settings WHERE key = 'lunch_open_days';
