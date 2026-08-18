/**
 * The small amount of statistics this application is entitled to.
 *
 * A hotel with thirty rooms produces about thirty numbers a day. That is not
 * enough data for anything clever, and pretending otherwise is how a dashboard
 * ends up confidently reporting that Tuesdays are significant. So everything
 * here is deliberately blunt and hard to fool: medians rather than means,
 * absolute deviation rather than standard deviation, and a stated minimum
 * number of observations below which a rule is simply not allowed to speak.
 *
 * The bar throughout is: would a sensible person, shown this evidence, agree
 * that something is going on? Not: is p below 0.05.
 */

export function median(values) {
  const nums = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (!nums.length) return null;
  const mid = Math.floor(nums.length / 2);
  return nums.length % 2 ? nums[mid] : (nums[mid - 1] + nums[mid]) / 2;
}

export function mean(values) {
  const nums = values.filter((v) => Number.isFinite(v));
  if (!nums.length) return null;
  return nums.reduce((a, b) => a + b, 0) / nums.length;
}

export function sum(values) {
  return values.reduce((a, b) => a + (Number.isFinite(b) ? b : 0), 0);
}

/**
 * Median absolute deviation, scaled to be comparable with a standard
 * deviation.
 *
 * Used instead of a standard deviation because one catastrophic day — a
 * generator failure, a wedding — otherwise widens the spread so far that
 * nothing is ever unusual again. The MAD does not care about the size of an
 * outlier, only that it is one.
 */
export function mad(values) {
  const m = median(values);
  if (m == null) return null;
  const deviations = values.filter((v) => Number.isFinite(v)).map((v) => Math.abs(v - m));
  const d = median(deviations);
  return d == null ? null : d * 1.4826;
}

/** How unusual a value is, in robust standard deviations. */
export function robustZ(value, values) {
  const m = median(values);
  const spread = mad(values);
  if (m == null || !spread) return null;
  return (value - m) / spread;
}

/**
 * The slope of a series, per step, by Theil–Sen.
 *
 * The median of every pairwise slope. Slower than a least-squares line and
 * immune to the two or three wild days every small business has, which a
 * least-squares line would happily rotate itself around.
 */
export function trendSlope(values) {
  const points = values.map((v, i) => [i, v]).filter(([, v]) => Number.isFinite(v));
  if (points.length < 4) return null;
  const slopes = [];
  for (let i = 0; i < points.length; i += 1) {
    for (let j = i + 1; j < points.length; j += 1) {
      const dx = points[j][0] - points[i][0];
      if (!dx) continue;
      slopes.push((points[j][1] - points[i][1]) / dx);
    }
  }
  return median(slopes);
}

/**
 * Split a series into an earlier and a later half and compare their medians.
 *
 * Most of what a manager wants to know is "is this getting worse", and over
 * thirty or ninety days that question is answered well enough by comparing the
 * first half with the second. Returns null when either half is too thin to
 * mean anything, which is the whole point of returning null.
 */
export function halves(values, minPerHalf = 5) {
  const nums = values.filter((v) => Number.isFinite(v));
  if (nums.length < minPerHalf * 2) return null;
  const cut = Math.floor(nums.length / 2);
  const before = median(nums.slice(0, cut));
  const after = median(nums.slice(cut));
  if (before == null || after == null) return null;
  const changePct = before === 0 ? null : Math.round(((after - before) / Math.abs(before)) * 1000) / 10;
  return { before, after, changePct, n: nums.length };
}

/** Pearson correlation, for saying "these two move together" and little else. */
export function correlation(xs, ys) {
  const pairs = xs.map((x, i) => [x, ys[i]]).filter(([x, y]) => Number.isFinite(x) && Number.isFinite(y));
  if (pairs.length < 6) return null;
  const mx = mean(pairs.map(([x]) => x));
  const my = mean(pairs.map(([, y]) => y));
  let num = 0; let dx = 0; let dy = 0;
  for (const [x, y] of pairs) {
    num += (x - mx) * (y - my);
    dx += (x - mx) ** 2;
    dy += (y - my) ** 2;
  }
  const den = Math.sqrt(dx * dy);
  return den === 0 ? null : Math.round((num / den) * 100) / 100;
}

/** Group rows into a Map, keyed by whatever the picker returns. */
export function groupBy(rows, pick) {
  const out = new Map();
  for (const row of rows) {
    const key = pick(row);
    if (key == null) continue;
    if (!out.has(key)) out.set(key, []);
    out.get(key).push(row);
  }
  return out;
}
