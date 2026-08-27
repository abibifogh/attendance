-- Shifts that run together, and shifts that stand in for a pair.
--
-- The alternates column already says "when one of these runs, the others do
-- not". What it could not say is the other half of how this property splits a
-- service: Bistro shift 1 and Bistro shift 2 are one service cut in two, so
-- either both of them run or neither does — and the single Bistro shift is
-- what runs instead of the pair.
--
-- Putting all three in one alternates group would have said the wrong thing:
-- it would have made shift 1 and shift 2 rule each other out, which is exactly
-- backwards. So a shift can now say who it runs *with* as well as who it runs
-- *instead of*, and alternates deliberately ignores anybody in the same pair.
ALTER TABLE att_shifts ADD COLUMN pair_group TEXT;

CREATE INDEX IF NOT EXISTS idx_att_shifts_pair ON att_shifts (pair_group);

-- The three the rule was written about.
--
--   Bistro shift 1 running means Bistro shift 2 is on the day too.
--   The two of them running means Bistro does not.
--   Bistro running means neither of them does.
--
-- The first is the pair; the second and third are one alternates group holding
-- the pair and the single shift, which now reads correctly because the pair is
-- not an alternative to itself.
UPDATE att_shifts SET pair_group = 'bistro-split'
 WHERE name IN ('Bistro shift 1', 'Bistro shift 2');

UPDATE att_shifts SET alt_group = 'bistro'
 WHERE name IN ('Bistro', 'Bistro shift 1', 'Bistro shift 2');
