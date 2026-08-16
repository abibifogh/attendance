-- The terminal on the wall, registered ahead of whoever sets this up.
--
-- Read off the device's own System Information screen rather than typed from
-- memory, because the serial is the one field nobody can guess and getting it
-- wrong is the kind of mistake that shows up a fortnight later as "no punches".
--
--   Model        DS-K1T321MFWX-B
--   Serial       GR5181125
--   Firmware     V3.9.20 build 20241227
--   MAC          88:de:39:70:9a:b1
--   Manufactured 10 March 2026
--
-- Deliberately registered WITHOUT a token. The token is the terminal's password
-- for posting punches, it is readable exactly once, and a value committed to a
-- git repository is readable forever — so it is not created here. Whoever sets
-- this up presses "New token" on the Terminals screen and is handed both the
-- token and the settings to type into the device, assembled and ready.
--
-- The name is a guess and meant to be changed. A property with one door calls
-- it whatever it likes; a property with three needs them told apart.
--
-- Safe to run more than once.

INSERT INTO att_devices (serial, name, location, model, mode, note)
VALUES (
  'GR5181125',
  'Staff entrance',
  NULL,
  'DS-K1T321MFWX-B',
  'push',
  'Firmware V3.9.20 build 20241227 · MAC 88:de:39:70:9a:b1 · manufactured 2026-03-10'
)
ON CONFLICT (serial) DO NOTHING;
