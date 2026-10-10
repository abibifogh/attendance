-- The Service screen and its three findings (housekeeping checks against
-- absence, beds in a state nobody expected, maintenance load) are gone from
-- Insight. Their old findings would otherwise sit on the brief for ever.
DELETE FROM findings WHERE rule_id IN ('absence-to-missed-work', 'unbilled-occupancy', 'maintenance-load');
