import { all, run } from '../lib/db.js';

/**
 * Making one person out of three spellings.
 *
 * Attendance calls her "Akosua Frimpong" with employee number E004. The POS
 * knows a cashier called "akosua frimpong". The laundry has "Akosua F.". None
 * of the three systems shares an identifier with either of the others, and
 * every interesting question in this application — who was on site when the
 * till was short, whose department is carrying the overtime — needs them to be
 * the same person.
 *
 * This does the joining, and is careful about how sure it is.
 *
 * An employee number matching is `exact`. A normalised name matching is
 * `name`, which is good enough to aggregate on and *not* good enough to put
 * somebody's name next to the word "shortage" without saying so. Every finding
 * that names a person carries the confidence of the link that named them, and
 * the screen prints it.
 *
 * What this deliberately does not do is fuzzy matching. No edit distance, no
 * nicknames, no "Kofi ≈ Kofy". A near-match that quietly merges two real
 * people is far worse than two rows that should have been one: the first
 * accuses somebody of another person's shortfall, the second is a tidy-up job
 * somebody can do in the setup screen.
 */

/** Strip a name to the thing two systems can be expected to agree on. */
export function nameKey(name) {
  return String(name || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    // Titles and honorifics. People add them in one system and not another.
    .replace(/\b(mr|mrs|ms|miss|dr|prof|madam|master)\.?\b/g, ' ')
    .replace(/[^a-z0-9 ]+/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
    // Sorted, so "Frimpong Akosua" and "Akosua Frimpong" are one person. Given
    // name first is a convention, not a rule, and the rota is full of both.
    .sort()
    .join(' ');
}

/**
 * Suppliers and items, normalised harder than people.
 *
 * A supplier's name is typed fresh into every system by whoever is holding the
 * invoice, so "Adom Foods Ltd.", "ADOM FOODS" and "Adom foods limited" are one
 * account. Dropping the company suffixes is safe in a way that dropping part
 * of a person's name would not be.
 */
export function orgKey(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\b(ltd|limited|co|company|ent|enterprise|enterprises|and|the|gh|ghana)\b/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .join(' ');
}

/**
 * An item's name, reduced to the thing being bought.
 *
 * Pack sizes and grades come off, because the question this key exists to
 * answer is "are two systems buying the same thing at different prices" and
 * "Tomatoes (5kg crate)" and "tomatoes" are the same thing. The unit is kept
 * separately on the row, so a price comparison can still refuse to compare a
 * kilo with a crate.
 */
export function itemKey(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/\(.*?\)/g, ' ')
    .replace(/\b\d+(\.\d+)?\s*(kg|g|ml|l|litre|liters?|pcs|pieces?|packs?|boxes?|crates?|bags?|tins?)\b/g, ' ')
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\b(fresh|local|imported|premium|grade|large|small|medium)\b/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
    // Singular-ish: 'tomatoes' and 'tomato' should meet.
    .map((word) => (word.length > 4 && word.endsWith('es') ? word.slice(0, -2) : word.length > 3 && word.endsWith('s') ? word.slice(0, -1) : word))
    .sort()
    .join(' ');
}

/**
 * A register that resolves names to warehouse ids, in memory, writing back
 * only what is new.
 *
 * An ETL run resolves the same forty names a few thousand times. Doing that as
 * a query each time is the difference between a run that finishes and a run
 * that times out, so the whole of each dimension is read once at the start.
 */
export class Register {
  constructor(db) {
    this.db = db;
    this.people = new Map();      // match_key -> row
    this.personLinks = new Map(); // 'source|external' -> person_id
    this.suppliers = new Map();
    this.items = new Map();
    this.newLinks = [];
  }

  async load() {
    for (const row of await all(this.db, 'SELECT * FROM dim_person')) this.people.set(row.match_key, row);
    for (const row of await all(this.db, 'SELECT source_id, external_id, person_id FROM person_link')) {
      this.personLinks.set(`${row.source_id}|${row.external_id}`, row.person_id);
    }
    for (const row of await all(this.db, 'SELECT * FROM dim_supplier')) this.suppliers.set(row.match_key, row);
    for (const row of await all(this.db, 'SELECT * FROM dim_item')) this.items.set(row.match_key, row);
  }

  /**
   * Record a person as one system knows them, and give back the group's id.
   *
   * Attendance is allowed to fill in the details it alone holds — the employee
   * number, the department, the line. Other systems may create a person who is
   * not on the rota (a contractor, somebody who left before the terminal was
   * installed) but may never overwrite attendance's version of somebody, which
   * is why the update below only ever fills blanks.
   */
  async person(sourceId, { externalId, name, employeeNo, department, jobTitle, line, hourCost, active }) {
    const linkKey = `${sourceId}|${externalId}`;
    if (this.personLinks.has(linkKey)) return this.personLinks.get(linkKey);

    const key = employeeNo ? `emp:${String(employeeNo).toLowerCase()}` : nameKey(name);
    if (!key) return null;

    let person = this.people.get(key);

    // The two halves of the join, and the one place a mistake here would be
    // expensive.
    //
    // Somebody arriving with an employee number may already exist because
    // another system met them first, under their name and nothing else. In
    // that case the number is attached to the row that is already there
    // rather than starting a second one — but *only* if that row has no
    // employee number of its own. Two people who really are both called Kofi
    // Asare have two numbers, and merging them would put one man's till
    // shortages on the other's record. A duplicate row is a tidy-up job; a
    // wrong merge is an accusation.
    if (!person) {
      const wanted = nameKey(name);
      person = [...this.people.values()].find((p) => nameKey(p.display_name) === wanted
        && (!employeeNo || !p.employee_no || String(p.employee_no).toLowerCase() === String(employeeNo).toLowerCase()));
    }

    if (!person) {
      await run(this.db, `
        INSERT INTO dim_person (match_key, display_name, employee_no, department, job_title, line_id, hour_cost, active)
        VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`,
        key, name || externalId, employeeNo || null, department || null, jobTitle || null,
        line || null, hourCost ?? null, active === false ? 0 : 1);
      const created = await this.db.prepare('SELECT * FROM dim_person WHERE match_key = ?1').bind(key).first();
      person = created;
      this.people.set(key, person);
    } else if (employeeNo || department || line || hourCost != null) {
      // Everything but the rate fills a blank and leaves what is already
      // there: a department typed one way here and another way there should
      // not flip on every run.
      //
      // The rate is the exception, and has to be. It is the only field that
      // legitimately changes — somebody gets a rise, and COALESCE would keep
      // costing them at last year's wage for ever, quietly, with the new
      // figure sitting unused in HIVE. A null is still ignored, so a source
      // that does not know a rate cannot erase one that does.
      await run(this.db, `
        UPDATE dim_person
           SET employee_no = COALESCE(employee_no, ?2),
               department  = COALESCE(department,  ?3),
               job_title   = COALESCE(job_title,   ?4),
               line_id     = COALESCE(line_id,     ?5),
               hour_cost   = COALESCE(?6, hour_cost)
         WHERE id = ?1`,
        person.id, employeeNo || null, department || null, jobTitle || null, line || null,
        hourCost ?? null);
      Object.assign(person, {
        employee_no: person.employee_no || employeeNo || null,
        department: person.department || department || null,
        line_id: person.line_id || line || null,
        hour_cost: hourCost ?? person.hour_cost,
      });
    }

    this.personLinks.set(linkKey, person.id);
    this.newLinks.push({
      sourceId, externalId, personId: person.id, rawName: name || null,
      confidence: employeeNo ? 'exact' : 'name',
    });
    return person.id;
  }

  /** Resolve by name alone, for systems that only ever hand over a name. */
  async personByName(sourceId, name) {
    if (!name) return null;
    return this.person(sourceId, { externalId: `name:${nameKey(name)}`, name });
  }

  async supplier(name) {
    const key = orgKey(name);
    if (!key) return 0;
    if (this.suppliers.has(key)) return this.suppliers.get(key).id;
    await run(this.db, 'INSERT OR IGNORE INTO dim_supplier (match_key, name) VALUES (?1, ?2)', key, String(name).trim());
    const row = await this.db.prepare('SELECT * FROM dim_supplier WHERE match_key = ?1').bind(key).first();
    this.suppliers.set(key, row);
    return row.id;
  }

  async item(name, unit) {
    const key = itemKey(name);
    if (!key) return null;
    if (this.items.has(key)) return this.items.get(key).id;
    await run(this.db, 'INSERT OR IGNORE INTO dim_item (match_key, name, unit) VALUES (?1, ?2, ?3)',
      key, String(name).trim(), unit || null);
    const row = await this.db.prepare('SELECT * FROM dim_item WHERE match_key = ?1').bind(key).first();
    this.items.set(key, row);
    return row.id;
  }

  /** Write the links discovered during a run. */
  async flush() {
    for (const link of this.newLinks) {
      await run(this.db, `
        INSERT INTO person_link (source_id, external_id, person_id, raw_name, confidence)
        VALUES (?1, ?2, ?3, ?4, ?5)
        ON CONFLICT (source_id, external_id) DO UPDATE SET person_id = ?3, raw_name = ?4, confidence = ?5`,
        link.sourceId, link.externalId, link.personId, link.rawName, link.confidence);
    }
    const written = this.newLinks.length;
    this.newLinks = [];
    return written;
  }
}
