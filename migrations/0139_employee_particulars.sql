-- Which details of the employee a contract shows.
--
-- Each template keeps a list of the details it prints in an "Employee
-- particulars" box at the start of the contract (their ID, address, SSNIT
-- number and so on), and the office can change the list for one person when
-- it issues one. The box is written into the contract's words when it is
-- issued, so it is part of what is signed and fingerprinted; the list of what
-- went into it is kept beside the contract as well, for the office to read.
-- Empty is no box, which is what every template was before this.
ALTER TABLE hr_template ADD COLUMN particulars TEXT;
ALTER TABLE hr_contract ADD COLUMN particulars TEXT;
