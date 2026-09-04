-- A code of their own on payslips.
--
-- Signing in is one question, answered once in the morning: is this their
-- phone. Opening a payslip is a different one, asked at the moment somebody is
-- standing over your shoulder in a corridor, and a phone that is already
-- unlocked answers it for you.
--
-- So My payslips can be given a short code of its own. Four digits, set by the
-- person whose pay it is and by nobody else, and separate from the six they
-- sign in with: the whole point is that handing somebody your phone, already
-- signed in, does not hand them last month's net pay.
--
-- WHAT IT IS NOT. It is not a second login and it does not protect the payslip
-- from the property. Payroll and an administrator read what they have always
-- read, because a hotel cannot answer a query about somebody's tax on a
-- document it is locked out of. This guards the copy on their phone.
--
--   payslip_pin_hash      The code, hashed with the installation's own pepper
--                         and a prefix of its own, so a login PIN and a
--                         payslip code of the same digits do not hash alike.
--                         NULL is the ordinary state: nobody has to set one.
--   payslip_pin_set_at    When they set it. Shown back to them, and the only
--                         thing an administrator can see about it.
--   payslip_open_until    While this is in the future the tab opens without
--                         asking again. It slides while they are reading and
--                         is dropped the moment they leave the screen.
--   payslip_tries         Wrong tries since the last right one.
--   payslip_locked_until  Guessing stops being free until this passes.
ALTER TABLE users ADD COLUMN payslip_pin_hash     TEXT;
ALTER TABLE users ADD COLUMN payslip_pin_set_at   TEXT;
ALTER TABLE users ADD COLUMN payslip_open_until   TEXT;
ALTER TABLE users ADD COLUMN payslip_tries        INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN payslip_locked_until TEXT;
