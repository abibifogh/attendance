-- Hours a week: what the rota measures somebody's plan against, so it can
-- say who is over and who is under. Blank works it out from their days a
-- week at eight hours a day.
ALTER TABLE att_staff ADD COLUMN weekly_hours REAL;
