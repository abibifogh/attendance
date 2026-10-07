/**
 * The days somebody asked about, the way they would say them.
 *
 * Runs of consecutive days read as a run and separate days are listed, so two
 * Saturdays a month apart read as "Sat 18 Oct and Sat 15 Nov" rather than
 * "18 Oct to 15 Nov", which is a month off nobody asked for. The screen says
 * the same thing from `public/js/availability-rules.js`; a test keeps them
 * together, because the worker cannot load the browser's module.
 */
export function sayAskedDays(days) {
  const sorted = [...new Set((days ?? []).map(String))].sort();
  const runs = [];
  for (const day of sorted) {
    const last = runs[runs.length - 1];
    if (last && dayAfter(last.to) === day) last.to = day;
    else runs.push({ from: day, to: day });
  }
  const say = (day) => new Date(`${day}T12:00:00Z`).toLocaleDateString('en-GB', {
    weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC',
  });
  const parts = runs.map((r) => (r.from === r.to ? say(r.from) : `${say(r.from)} to ${say(r.to)}`));
  if (parts.length <= 1) return parts[0] ?? '';
  return `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
}

function dayAfter(day) {
  const at = new Date(`${day}T12:00:00Z`);
  at.setUTCDate(at.getUTCDate() + 1);
  return at.toISOString().slice(0, 10);
}
