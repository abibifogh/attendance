-- Nobody is locked out for a short PIN after all.
--
-- The first go at this gave a short PIN three sign-ins and then switched the
-- login off, which meant a cook who kept pressing past the screen ended up
-- unable to clock in for a shift they were standing in the building for, and
-- an administrator hunting for the reason. The screen asking for a longer PIN
-- was doing the work; the lock was only adding a way for it to go wrong.
--
-- So the screen now stands in front of the app for as long as the PIN is
-- short, every single sign-in, and nothing is ever switched off. There is no
-- allowance left to count and no locked state to record, and these two
-- columns from 0092 have nothing left to hold.
ALTER TABLE users DROP COLUMN pin_grace_left;
ALTER TABLE users DROP COLUMN pin_locked_at;
