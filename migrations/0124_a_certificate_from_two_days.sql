-- The handbook asked for a medical certificate after more than three days off
-- sick; the HR answers and the property's own rule say two. The words are
-- changed in the draft only. What staff read is the published copy, and
-- publishing the change is what records a new version and asks them again,
-- so that stays a press somebody makes.
UPDATE hb_chapter
   SET body = replace(body,
         'For an absence of more than three days, bring a medical certificate.',
         'For an absence of two days or more, bring a medical certificate.'),
       updated_by = 'HIVE (the certificate rule)',
       updated_at = datetime('now')
 WHERE body LIKE '%For an absence of more than three days, bring a medical certificate.%';
