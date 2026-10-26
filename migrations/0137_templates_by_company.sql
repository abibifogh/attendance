-- A template can belong to one company.
--
-- The second company employs people of its own, under its own name, and its
-- contracts say so. A template left without a company is for every company,
-- which is what every template was before this. One given a company is only
-- offered for, and only issued to, the people that company employs; on a job
-- offer, it is that company that makes the offer and becomes the employer.
ALTER TABLE hr_template ADD COLUMN company_id INTEGER REFERENCES company (id);

-- And the company an offer was made for, fixed when it was made, so taking
-- them on puts them on that company's books whatever happens to the template.
ALTER TABLE rec_offer ADD COLUMN company_id INTEGER;
