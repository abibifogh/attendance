-- The one cost no connected system records.
--
-- Rent, power, water, licences and depreciation are in neither the tills, the
-- clock, the laundry, the kitchen nor the books, because none of those is
-- where a lease lives. Without it every break-even in this app is understated
-- by exactly the rent, and the Yardstick screen says as much until it is set.
--
-- Whole pesewas a month, like every other money figure here.
INSERT INTO settings (key, value) VALUES ('standing_cost_monthly', '0')
  ON CONFLICT (key) DO NOTHING;
