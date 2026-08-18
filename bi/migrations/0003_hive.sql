-- The attendance app is called HIVE.
--
-- It began as an attendance terminal and is not one any more: it runs the rota,
-- leave, the sign-off, personnel records, contracts and the letter register.
-- Naming it after the one thing it did first undersold it on this hub, where a
-- card's job is to tell somebody what is behind the button.
--
-- The *id* stays `attendance`, deliberately. It is the Worker's name, the
-- repository's name, and the systemId both ends of the sign-in hand-off agree
-- on. Renaming it would buy nothing anybody can see while costing a re-issued
-- shared secret and a broken hand-off — and the far end is in another
-- repository, so the two would be broken apart until somebody redeployed both.
--
-- Written as an UPDATE rather than by editing the seed in 0002: that seed is an
-- INSERT OR IGNORE, so on every database that already exists it does nothing at
-- all, and the rename would only ever reach a fresh install.
UPDATE systems
   SET label       = 'HIVE',
       description = 'Attendance, rota, leave, personnel records and letters.'
 WHERE id = 'attendance';
