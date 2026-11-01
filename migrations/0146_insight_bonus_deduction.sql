-- A deduction Insight asked for (a management report sent late) carries the
-- key Insight gave it, so asking twice (a retry after a timeout, or the same
-- hour run again) takes the money once.
ALTER TABLE pay_penalty ADD COLUMN link_key TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_pay_penalty_link_key ON pay_penalty (link_key) WHERE link_key IS NOT NULL;
