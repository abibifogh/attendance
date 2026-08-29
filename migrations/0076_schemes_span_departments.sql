-- A bonus scheme can belong to more than one department.
--
-- A scheme said which department it was under, one of them, because that was
-- how the list is grouped. But a property runs schemes that genuinely cover
-- two: the kitchen and the bistro share a service bonus, front office and
-- reservations share an upsell one. There was no way to say so. The choices
-- were to file it under one department and have the other half of the staff
-- ticked in as strays, or to make it General and have a property-wide scheme
-- that most of the property is not on.
--
-- Stored the same way a member of staff's departments are: a JSON array of
-- names, with null meaning the whole property rather than a gap somebody
-- forgot to fill in.
ALTER TABLE pay_scheme ADD COLUMN departments TEXT;

UPDATE pay_scheme
   SET departments = json_array(department)
 WHERE department IS NOT NULL AND TRIM(department) <> '';
