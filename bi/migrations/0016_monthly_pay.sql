-- A salaried person's monthly pay, for estimating wages before payroll is run.
--
-- Until a month's pay run is finalised, a salaried person costs their monthly
-- pay divided by the days in that month, every day, worked or not: that is
-- what a salary is. When the payslips arrive they replace the estimate. People
-- paid by the day or the hour keep their rate times the time they worked.
--
-- Pesewas, from HIVE's hr_pay, the rate in force at the end of the window
-- read; `pay_from` is the day that rate began, before which the person is not
-- costed this way. NULL for anybody not paid monthly.
ALTER TABLE dim_person ADD COLUMN pay_monthly INTEGER;
ALTER TABLE dim_person ADD COLUMN pay_from TEXT;
