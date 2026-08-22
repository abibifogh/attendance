-- Why the advance was asked for, and the paper behind it.
--
-- The property lends for three reasons and treats them differently. School
-- fees and rent are the big, predictable ones: they come with a bill or a
-- tenancy agreement, they go up to five thousand, and they are paid back over
-- ten months. Anything else is the small emergency — a thousand at most, back
-- out of the next pay packet.
--
-- WHY THE RULE LIVES IN THE APP AND NOT IN SOMEBODY'S HEAD. Every one of these
-- limits was already the property's policy. What was missing was anywhere for
-- it to be written down, so it was applied from memory and differently
-- depending on who was asked. A rule the app states the same way every time is
-- also a rule somebody can point at when the answer is no.
--
-- The paper is a document like any other, so it goes where the scans and the
-- contracts go rather than into a column here.
ALTER TABLE hr_advance ADD COLUMN purpose TEXT;
ALTER TABLE hr_advance ADD COLUMN document_id INTEGER REFERENCES hr_document (id) ON DELETE SET NULL;
