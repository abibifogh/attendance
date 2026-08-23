import { emptyBundle } from '../connectors/bundle.js';
import { daysBetween, dow } from '../lib/dates.js';

/**
 * A plausible group, for when the real one is not connected yet.
 *
 * A business intelligence tool with nothing in it is impossible to judge. You
 * cannot tell whether the charts are useful, whether the findings are worth
 * reading or whether the whole idea is worth the trouble, because there is
 * nothing on the screen. So the app ships knowing how to invent a hotel.
 *
 * Everything here is generated from a fixed seed, so the same day always
 * produces the same numbers and a screenshot taken today still matches the
 * screen tomorrow. It is arithmetic, not a recording: no real figure from any
 * property is in this file.
 *
 * The invented hotel has problems on purpose. Housekeeping that did not shrink
 * when the hotel emptied, a bar that costs more to staff than it earns, a
 * tomato supplier charging the restaurant half as much again as the kitchen,
 * laundry bills that are never collected, and one cashier whose till is short
 * more often than anybody else's. Each one is there so that the rules can be
 * seen finding something, and each is the kind of thing that is genuinely
 * invisible until these four systems are read together.
 *
 * Everything it produces is labelled as demonstration data, in the API and on
 * every screen, and connecting one real source switches the whole of it off.
 */

/** A small, fast, entirely deterministic generator. Same seed, same hotel. */
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A stable seed for a given day, so a day's figures never move. */
const daySeed = (day) => Number(day.replace(/-/g, '')) % 2147483647;

const STAFF = [
  ['E001', 'Ama Boateng',      'Front Office',  'Receptionist'],
  ['E002', 'Kofi Asare',       'Front Office',  'Receptionist'],
  ['E003', 'Yaw Darko',        'Front Office',  'Night Auditor'],
  ['E004', 'Akosua Frimpong',  'Housekeeping',  'Room Attendant'],
  ['E005', 'Abena Owusu',      'Housekeeping',  'Room Attendant'],
  ['E006', 'Esi Nyarko',       'Housekeeping',  'Room Attendant'],
  ['E007', 'Adwoa Sarpong',    'Housekeeping',  'Room Attendant'],
  ['E008', 'Afia Antwi',       'Housekeeping',  'Supervisor'],
  ['E009', 'Kwabena Osei',     'Housekeeping',  'Houseman'],
  ['E010', 'Kwame Mensah',     'Restaurant',    'Cashier'],
  ['E011', 'Efua Addo',        'Restaurant',    'Waitress'],
  ['E012', 'Kojo Amponsah',    'Restaurant',    'Waiter'],
  ['E013', 'Nana Ofori',       'Restaurant',    'Waiter'],
  ['E014', 'Serwaa Agyapong',  'Restaurant',    'Supervisor'],
  ['E015', 'Kwesi Bediako',    'Kitchen',       'Head Chef'],
  ['E016', 'Yaa Danso',        'Kitchen',       'Cook'],
  ['E017', 'Kwaku Appiah',     'Kitchen',       'Cook'],
  ['E018', 'Mansa Tetteh',     'Kitchen',       'Kitchen Assistant'],
  ['E019', 'Kojo Baffour',     'Bar',           'Bartender'],
  ['E020', 'Akua Gyamfi',      'Bar',           'Bartender'],
  ['E021', 'Fiifi Quaye',      'Maintenance',   'Technician'],
  ['E022', 'Kwadwo Larbi',     'Maintenance',   'Handyman'],
  ['E023', 'Adjoa Nkrumah',    'Laundry',       'Laundry Attendant'],
  ['E024', 'Comfort Ansah',    'Laundry',       'Laundry Attendant'],
  ['E025', 'Emmanuel Tetteh',  'Security',      'Security Officer'],
  ['E026', 'Grace Amoah',      'Admin',         'Accounts Officer'],
];

// Name, unit, cost per unit in pesewas, and how much of it one guest eats at
// breakfast. The last column is what makes the food cost per head land in the
// GH₵12-16 range a hotel buffet actually runs at; getting it wrong is how a
// demonstration ends up claiming the kitchen spends nine hundred cedis a day
// on eggs.
const INGREDIENTS = [
  ['Eggs',            'crate',  4200, 0.06],
  ['Tomatoes',        'kg',     1200, 0.08],
  ['Onions',          'kg',      900, 0.05],
  ['Bread',           'loaf',    800, 0.25],
  ['Milk',            'litre',  1500, 0.15],
  ['Butter',          'kg',     4800, 0.02],
  ['Sausages',        'kg',     5200, 0.04],
  ['Cooking oil',     'litre',  2200, 0.03],
  ['Rice',            'kg',     1400, 0.05],
  ['Coffee',          'kg',    12000, 0.008],
  ['Tea bags',        'box',    2600, 0.01],
  ['Pineapple',       'kg',     1000, 0.12],
];

const SUPPLIERS = ['Adom Foods', 'Makola Fresh', 'Silver Star Distributors', 'Kaneshie Provisions'];

/** The invented hotel's shape: quieter midweek, fuller at the weekend. */
function guestsFor(day, index, total) {
  const r = rng(daySeed(day));
  const weekday = dow(day);
  const base = weekday >= 5 ? 38 : 27;
  // A slow emptying over the window. This is the fact that half the findings
  // hang off: demand fell and nothing else did.
  const drift = -10 * (index / Math.max(1, total - 1));
  const noise = Math.round((r() - 0.5) * 8);
  return Math.max(6, Math.round(base + drift + noise));
}

export function demoPull({ sourceId, from, to }) {
  const days = daysBetween(from, to);
  const guests = new Map();
  days.forEach((day, i) => guests.set(day, guestsFor(day, i, days.length)));

  if (sourceId === 'attendance') return attendance(days);
  if (sourceId === 'breakfast') return breakfast(days, guests);
  if (sourceId === 'pos') return pos(days, guests);
  if (sourceId === 'laundry') return laundry(days, guests);
  return emptyBundle();
}

// ------------------------------------------------------------- attendance --

/**
 * One day's roster, worked out once and used by two different "systems".
 *
 * The attendance connector and the housekeeping connector both need to agree
 * about who turned up, because the whole point of the demonstration is a
 * finding that joins the two. Generating them separately would give a
 * dashboard where the rounds are missed on days nobody was absent — which is
 * exactly the incoherence a real group's four systems do *not* have, and would
 * make the tool look as though it were inventing connections.
 */
function rosterFor(day) {
  const r = rng(daySeed(day) + 7);
  const weekday = dow(day);
  return STAFF.map(([employeeNo, name, department, jobTitle]) => {
    const restDay = 1 + (hash(employeeNo) % 7);
    if (weekday === restDay) {
      return { employeeNo, name, department, jobTitle, state: 'rest', late: 0, overtime: 0, worked: 0 };
    }
    const roll = r();
    // Housekeeping is short-handed more often than anywhere else. That is the
    // fact the missed-checks finding hangs on.
    const absenceChance = department === 'Housekeeping' ? 0.14 : 0.04;
    if (roll < absenceChance) {
      const onLeave = roll < absenceChance * 0.45;
      return {
        employeeNo, name, department, jobTitle,
        state: onLeave ? 'leave' : 'absent', late: 0, overtime: 0, worked: 0,
      };
    }
    const late = r() < 0.16 ? Math.round(5 + r() * 40) : 0;
    // The kitchen stays late on a Monday whatever the covers are. Nobody has
    // ever put those two facts on the same page.
    const overtime = department === 'Kitchen' && weekday === 1 ? Math.round(50 + r() * 70)
      : r() < 0.12 ? Math.round(20 + r() * 60) : 0;
    return {
      employeeNo, name, department, jobTitle,
      state: late > 5 ? 'late' : 'present',
      late, overtime, worked: 480 - Math.round(late * 0.6) + overtime,
    };
  });
}

/**
 * What a job pays, in pesewas an hour.
 *
 * By title rather than by person, because that is how a property actually sets
 * wages, and because a demonstration where everybody costs the same would hide
 * the very thing per-person rates were added to reveal: that the expensive
 * hours and the busy hours are not the same hours.
 */
const HOURLY = [
  [/head chef|manager/i, 3_200],
  [/supervisor|auditor/i, 2_400],
  [/chef|cook/i, 1_900],
  [/receptionist|cashier/i, 1_700],
  [/waiter|waitress|attendant|houseman/i, 1_350],
];

function hourlyFor(jobTitle) {
  for (const [pattern, rate] of HOURLY) if (pattern.test(jobTitle)) return rate;
  return 1_500;
}

/**
 * How long a shift is, by the job.
 *
 * Not eight hours for everybody. A hotel runs six-hour breakfast shifts and
 * twelve-hour night cover, and a demonstration where every roster line is 480
 * minutes cannot tell a roll-up that sums the roster apart from one that
 * multiplies heads by a hard-coded day — which is exactly the bug the roster
 * figure was added to fix.
 */
const SHIFT_MINUTES = [
  [/night auditor/i, 720],
  [/head chef/i, 600],
  [/chef|cook/i, 540],
  [/supervisor/i, 540],
  [/attendant|houseman/i, 420],
];

function shiftMinutesFor(jobTitle) {
  for (const [pattern, minutes] of SHIFT_MINUTES) if (pattern.test(jobTitle)) return minutes;
  return 480;
}

function attendance(days) {
  const bundle = emptyBundle();
  for (const [employeeNo, name, department, jobTitle] of STAFF) {
    bundle.people.push({
      externalId: employeeNo, employeeNo, name, department, jobTitle, active: true,
      hourCost: hourlyFor(jobTitle),
    });
  }

  for (const day of days) {
    for (const person of rosterFor(day)) {
      const { employeeNo, department, jobTitle, state, late, overtime, worked } = person;
      const expected = shiftMinutesFor(jobTitle || '');
      if (state === 'rest') {
        bundle.personDays.push({
          day, externalId: employeeNo, department, status: 'rest', reasonCode: 'rest_day',
          reasonKind: 'rest', scheduled: false, expectedMinutes: 0, workedMinutes: 0,
          lateMinutes: 0, overtimeMinutes: 0, countsAsWorked: false,
        });
        continue;
      }
      if (state === 'absent' || state === 'leave') {
        bundle.personDays.push({
          day, externalId: employeeNo, department,
          status: state,
          reasonCode: state === 'leave' ? 'annual_leave' : 'absent',
          reasonKind: state === 'leave' ? 'leave' : 'absent',
          scheduled: true, expectedMinutes: expected, workedMinutes: 0,
          lateMinutes: 0, overtimeMinutes: 0, countsAsWorked: false,
        });
        continue;
      }
      bundle.personDays.push({
        day, externalId: employeeNo, department,
        status: state, reasonCode: state,
        reasonKind: 'worked', scheduled: true, countsAsWorked: true,
        expectedMinutes: expected, workedMinutes: worked,
        lateMinutes: late, overtimeMinutes: overtime,
        firstIn: late ? clock(7, late) : '06:58',
        lastOut: clock(15, overtime),
      });
    }
  }

  // A couple of Ghanaian public holidays, if they fall in the window.
  for (const day of days) {
    if (day.endsWith('-03-06')) bundle.holidays.push({ day, name: 'Independence Day' });
    if (day.endsWith('-07-01')) bundle.holidays.push({ day, name: 'Republic Day' });
  }

  // ------------------------------------------------------------ payroll --
  //
  // Built from the hours actually generated above rather than from a separate
  // random number, so the demonstration's payslips reconcile with its own
  // attendance. A payroll that disagreed with the clock would teach a reader
  // exactly the wrong lesson about what this comparison is for.
  //
  // Ghana's statutory rates: 5.5% employee pension, 13% employer, and PAYE
  // approximated with a flat band — the point of the fixture is the shape of
  // the arithmetic, not a tax calculation nobody should rely on.
  const monthly = new Map();
  for (const row of bundle.personDays) {
    const key = `${row.day.slice(0, 7)}|${row.externalId}`;
    const acc = monthly.get(key) || { minutes: 0, department: row.department };
    acc.minutes += row.workedMinutes || 0;
    monthly.set(key, acc);
  }

  for (const [key, acc] of monthly) {
    const [month, employeeNo] = key.split('|');
    const person = STAFF.find(([no]) => no === employeeNo);
    if (!person) continue;
    // A month only appears once its days are all in the window, the way a real
    // pay run only closes after the month has finished.
    const complete = days.includes(`${month}-28`);
    if (!complete) continue;

    const gross = Math.round((acc.minutes / 60) * hourlyFor(person[3]));
    const ssfEmployee = Math.round(gross * 0.055);
    const ssfEmployer = Math.round(gross * 0.13);
    const paye = Math.round(Math.max(0, gross - ssfEmployee - 40_000) * 0.175);
    bundle.payroll.push({
      month,
      externalId: employeeNo,
      department: acc.department,
      gross,
      bonusGross: 0,
      ssfEmployee,
      ssfEmployer,
      paye,
      loans: 0,
      net: gross - ssfEmployee - paye,
      cost: gross + ssfEmployer,
    });
  }

  bundle.notes.push('Demonstration data');
  return bundle;
}

// -------------------------------------------------------------- breakfast --

function breakfast(days, guests) {
  const bundle = emptyBundle();
  const total = days.length;

  days.forEach((day, index) => {
    const r = rng(daySeed(day) + 31);
    const inhouse = guests.get(day);
    const outside = Math.round(r() * 6);
    const fee = 3500;

    bundle.demand.push({ day, inhouseGuests: inhouse, outsideGuests: outside });
    if (outside) {
      const amount = outside * fee;
      bundle.revenue.push({
        day, line: 'breakfast', gross: amount, net: amount, collected: amount,
        cash: amount, orders: outside, covers: outside,
      });
    }

    // Food costs. The last third of the window carries a real price rise on
    // eggs and tomatoes, which is the thing the cost-per-guest rule should
    // notice and separate from the hotel simply being fuller or emptier.
    const lateWindow = index > total * 0.66;
    let purchaseSeq = 0;
    for (const [name, unit, baseCost, perGuest] of INGREDIENTS) {
      const used = Math.max(0, perGuest * (inhouse + outside) * (0.85 + r() * 0.3));
      const risen = lateWindow && (name === 'Eggs' || name === 'Tomatoes');
      const unitCost = Math.round(baseCost * (risen ? 1.62 : 1) * (0.97 + r() * 0.06));
      bundle.usage.push({
        day, line: 'breakfast', itemName: name, unit,
        qty: round2(used), value: Math.round(unitCost * used),
      });
      // Deliveries arrive twice a week, not daily.
      if (dow(day) === 2 || dow(day) === 5) {
        const qty = round2(used * 3.4);
        purchaseSeq += 1;
        bundle.purchaseLines.push({
          day, externalId: `demo-bfast:${day}:${purchaseSeq}`,
          line: 'breakfast', itemName: name, unit,
          supplierName: name === 'Tomatoes' || name === 'Onions' ? 'Adom Foods'
            : SUPPLIERS[hash(name) % SUPPLIERS.length],
          qty, unitCost, amount: Math.round(unitCost * qty),
        });
      }
    }

    // Housekeeping rounds. The beds are always due; how many get reached
    // depends on how many attendants turned up — read from the very same
    // roster the attendance system will report. That is the join this whole
    // application exists to make, and the demonstration would be dishonest if
    // the two sides were generated independently.
    const beds = 34;
    const team = rosterFor(day).filter((p) => p.department === 'Housekeeping');
    const onDuty = team.filter((p) => p.state === 'present' || p.state === 'late').length;
    const expectedOnDuty = team.filter((p) => p.state !== 'rest').length;
    const missing = Math.max(0, expectedOnDuty - onDuty);
    const checked = missing === 0
      ? beds
      : Math.max(6, Math.round(beds * (1 - missing * (0.22 + r() * 0.08))));
    bundle.service.push({
      day, line: 'housekeeping',
      checksDue: beds, checksDone: checked,
      faultsFound: Math.round(r() * 3),
    });
    bundle.demand.push({ day, roomsCleaned: checked, roomsTracked: beds });

    // Maintenance: parts issued, and the occasional purchase.
    const issues = Math.round(r() * 4);
    if (issues) {
      bundle.costs.push({
        day, line: 'maintenance', category: 'parts issued',
        amount: Math.round(issues * (2500 + r() * 6000)),
      });
      bundle.service.push({ day, line: 'maintenance', issuesOpened: issues });
    }
    if (dow(day) === 3 && r() < 0.5) {
      const qty = round2(1 + r() * 6);
      const unitCost = Math.round(3000 + r() * 12000);
      bundle.purchaseLines.push({
        day, externalId: `demo-mx:${day}`, line: 'maintenance',
        itemName: ['Light bulbs', 'Tap washers', 'Paint', 'Door locks'][hash(day) % 4],
        unit: 'pcs', supplierName: 'Silver Star Distributors',
        qty, unitCost, amount: Math.round(unitCost * qty),
      });
    }
  });

  bundle.notes.push('Demonstration data');
  return bundle;
}

// -------------------------------------------------------------------- POS --

function pos(days, guests) {
  const bundle = emptyBundle();
  for (const [employeeNo, name, department, jobTitle] of STAFF) {
    if (department === 'Restaurant' || department === 'Bar') {
      bundle.people.push({ externalId: `pos-${employeeNo}`, name, jobTitle, line: 'restaurant', active: true });
    }
  }

  for (const day of days) {
    const r = rng(daySeed(day) + 101);
    const inhouse = guests.get(day);
    const weekday = dow(day);

    // Restaurant. Roughly half the house eats in, plus walk-ins, more at the
    // weekend. Average spend drifts up gently with nothing behind it but
    // menu prices.
    const covers = Math.round(inhouse * (0.75 + r() * 0.25)) + Math.round(r() * (weekday >= 5 ? 34 : 16));
    const avgSpend = Math.round(7600 + r() * 3400);
    const gross = covers * avgSpend;
    const discounts = Math.round(gross * (r() < 0.3 ? 0.04 + r() * 0.05 : 0));
    const net = gross - discounts;
    const cash = Math.round(net * (0.38 + r() * 0.12));
    const card = Math.round(net * (0.3 + r() * 0.1));
    const other = Math.max(0, net - cash - card);
    bundle.revenue.push({
      day, line: 'restaurant', gross, discounts, net,
      collected: net, outstanding: 0, cash, card, other,
      orders: Math.round(covers / 1.8), covers, units: covers,
    });
    bundle.demand.push({ day, covers });

    // The bar. Small takings, and it is staffed every single night whether
    // anybody drinks or not — which is the point of it being here.
    const barCovers = Math.round(6 + r() * (weekday >= 5 ? 22 : 9));
    const barNet = barCovers * Math.round(2600 + r() * 1800);
    bundle.revenue.push({
      day, line: 'bar', gross: barNet, discounts: 0, net: barNet,
      collected: barNet, outstanding: 0,
      cash: Math.round(barNet * 0.7), card: Math.round(barNet * 0.3), other: 0,
      orders: barCovers, covers: barCovers, units: barCovers,
    });

    bundle.costs.push({
      day, line: 'restaurant', category: 'shift expenses',
      amount: Math.round(r() * 9000),
    });

    // Till closes. Most are out by small change. One cashier is not.
    const cashiers = ['Kwame Mensah', 'Efua Addo', 'Serwaa Agyapong'];
    for (const shiftName of ['Lunch', 'Dinner']) {
      const who = cashiers[Math.floor(r() * cashiers.length)];
      const expected = Math.round(cash / 2);
      const suspicious = who === 'Kwame Mensah' && r() < 0.42;
      const variance = suspicious
        ? -Math.round(2000 + r() * 9000)
        : Math.round((r() - 0.5) * 900);
      bundle.cashControl.push({
        day, externalId: `demo-shift:${day}:${shiftName}`,
        line: shiftName === 'Lunch' ? 'restaurant' : 'restaurant',
        shift: shiftName, personName: who,
        expected, counted: expected + variance, variance,
      });
    }

    // Restaurant purchases, with the tomato price the kitchen would recognise
    // and would not believe.
    if (dow(day) === 2 || dow(day) === 6) {
      for (const [name, unit, baseCost] of [['Tomatoes', 'kg', 1750], ['Rice', 'kg', 1450], ['Cooking oil', 'litre', 2250]]) {
        const qty = round2(4 + r() * 18);
        const unitCost = Math.round(baseCost * (0.98 + r() * 0.05));
        bundle.purchaseLines.push({
          day, externalId: `demo-pos-buy:${day}:${name}`,
          line: 'restaurant', itemName: name, unit,
          supplierName: name === 'Tomatoes' ? 'Adom Foods' : 'Kaneshie Provisions',
          qty, unitCost, amount: Math.round(unitCost * qty),
        });
      }
    }
  }

  bundle.notes.push('Demonstration data');
  return bundle;
}

// ---------------------------------------------------------------- laundry --

function laundry(days, guests) {
  const bundle = emptyBundle();
  for (const name of ['Adjoa Nkrumah', 'Comfort Ansah', 'Ama Boateng']) {
    bundle.people.push({ externalId: name.toLowerCase(), name, line: 'laundry', active: true });
  }

  days.forEach((day, index) => {
    const r = rng(daySeed(day) + 211);
    const inhouse = guests.get(day);
    // Roughly one guest in six sends laundry. That attach rate is flat, which
    // means the laundry shrinks with the hotel and never with its own effort.
    const orders = Math.max(0, Math.round(inhouse * 0.17 + (r() - 0.5) * 3));
    if (!orders) return;
    const loads = round2(orders * (1.1 + r() * 0.5));
    const net = Math.round(loads * 3800);
    // Collection gets worse across the window. Guests leave owing, and the
    // laundry has no way of seeing that it is happening.
    const collectionRate = Math.max(0.55, 0.95 - 0.3 * (index / Math.max(1, days.length - 1)));
    const collected = Math.round(net * collectionRate);
    const cash = Math.round(collected * 0.75);
    bundle.revenue.push({
      day, line: 'laundry', gross: net, discounts: 0, net,
      collected, outstanding: net - collected,
      cash, card: collected - cash, other: 0,
      orders, covers: 0, units: loads,
    });
    bundle.demand.push({ day, laundryOrders: orders, laundryLoads: loads });
  });

  bundle.notes.push('Demonstration data');
  return bundle;
}

// ----------------------------------------------------------------- odds ----

function hash(text) {
  let h = 0;
  for (let i = 0; i < text.length; i += 1) h = (h * 31 + text.charCodeAt(i)) >>> 0;
  return h;
}

const round2 = (n) => Math.round(n * 100) / 100;

function clock(hour, extraMinutes) {
  const total = hour * 60 + extraMinutes;
  return `${String(Math.floor(total / 60) % 24).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
}
