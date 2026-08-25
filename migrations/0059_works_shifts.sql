-- ---------------------------------------------------------------------------
-- Named shifts somebody may be put on
--
-- A department is the right unit for most people and too blunt for the rest.
-- A porter who does one night on security is not "Security"; ticking the
-- department puts them in the running for every shift in it, including the two
-- they have never worked and the one added next month.
--
-- Kept beside `works_in` rather than replacing it, because the two answer
-- different questions. A department says "anything in here, including whatever
-- is added later", which is what a supervisor covering the bar means. A list
-- of shifts says exactly these and nothing else.
-- ---------------------------------------------------------------------------

ALTER TABLE att_staff ADD COLUMN works_shifts TEXT;
