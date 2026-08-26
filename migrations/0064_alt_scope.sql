-- ---------------------------------------------------------------------------
-- Whether alternatives clash by the day or by the week
--
-- Two breakfasts that differ by half an hour clash on a day: run one this
-- morning and the other is not wanted this morning, but tomorrow is a fresh
-- question. Two shifts that each run once a week clash by the week: hold the
-- linen run on Tuesday and the deep clean is not wanted at all until next
-- Monday, whichever day it might otherwise have landed on.
--
-- 'day' is the ordinary answer and what every group meant before this column
-- existed. Weeks run Monday to Sunday, like everything else here.
-- ---------------------------------------------------------------------------

ALTER TABLE att_shifts ADD COLUMN alt_scope TEXT NOT NULL DEFAULT 'day';
