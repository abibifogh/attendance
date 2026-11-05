-- Contracts name the identity document by its number as well as its kind:
-- "holder of Ghana Card number GHA-000000000-0". Templates on file gain the
-- number wherever they name the document; contracts already issued keep
-- their words.
UPDATE hr_template
   SET body = replace(body, '{{id_type}}', '{{id_type}} number {{id_number}}'),
       version = COALESCE(version, 1) + 1,
       updated_at = datetime('now')
 WHERE instr(body, '{{id_type}}') > 0
   AND instr(body, '{{id_number}}') = 0;
