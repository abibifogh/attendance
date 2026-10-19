-- When each standard first-week step is due, in days from the start date,
-- for checklists already installed. A step somebody has given a date of their
-- own keeps it; steps written by the property get none until somebody sets one.
UPDATE ob_step SET due_days = CASE code
  WHEN 'details' THEN -1
  WHEN 'contract' THEN -1
  WHEN 'documents' THEN 0
  WHEN 'welcome_meeting' THEN 0
  WHEN 'tour' THEN 0
  WHEN 'team' THEN 0
  WHEN 'terminal' THEN 0
  WHEN 'app' THEN 0
  WHEN 'uniform' THEN 0
  WHEN 'keys' THEN 0
  WHEN 'fire_safety' THEN 1
  WHEN 'handbook' THEN 5
  WHEN 'food_hygiene' THEN 5
  WHEN 'shadow' THEN 5
  WHEN 'pay_explained' THEN 30
  WHEN 'first_month' THEN 30
END
WHERE due_days IS NULL
  AND code IN ('details','contract','documents','welcome_meeting','tour','team','terminal','app',
               'uniform','keys','fire_safety','handbook','food_hygiene','shadow','pay_explained','first_month');
