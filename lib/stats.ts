// Statistics primitives. No external deps — normal approximations, which are
// appropriate at the sample sizes split tests run at.

// Standard normal CDF (Abramowitz & Stegun 7.1.26 via erf).
export function normalCdf(x: number): number {
  const t = 1 / (1 + 0.2316419 * Math.abs(x));
  const d = 0.3989422804014327 * Math.exp(-(x * x) / 2);
  const p =
    d * t * (0.319381530 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  return x >= 0 ? 1 - p : p;
}

// Wilson score interval for a proportion (better than normal at small n / extreme p).
export function wilson(k: number, n: number, z = 1.96): { lo: number; hi: number } {
  if (n === 0) return { lo: 0, hi: 0 };
  const p = k / n;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const center = (p + z2 / (2 * n)) / denom;
  const half = (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / denom;
  return { lo: Math.max(0, center - half), hi: Math.min(1, center + half) };
}

// Two-proportion z-test (control vs variant). Returns two-sided p-value.
export function twoPropP(kC: number, nC: number, kV: number, nV: number): number {
  if (!nC || !nV) return 1;
  const pPool = (kC + kV) / (nC + nV);
  const se = Math.sqrt(pPool * (1 - pPool) * (1 / nC + 1 / nV));
  if (se === 0) return 1;
  const z = (kV / nV - kC / nC) / se;
  return 2 * (1 - normalCdf(Math.abs(z)));
}

// Continuous per-visitor metric (e.g. revenue/visitor, incl. zeros) from
// sum and sum-of-squares. Welch's unequal-variance test + normal-approx CI.
export type ContStat = { mean: number; ciLo: number; ciHi: number; plusMinus: number; n: number; variance: number };
export function contStat(n: number, sum: number, sqsum: number, z = 1.96): ContStat {
  if (n <= 1) return { mean: n ? sum / n : 0, ciLo: 0, ciHi: 0, plusMinus: 0, n, variance: 0 };
  const mean = sum / n;
  const variance = Math.max(0, (sqsum - (sum * sum) / n) / (n - 1));
  const se = Math.sqrt(variance / n);
  const pm = z * se;
  return { mean, ciLo: mean - pm, ciHi: mean + pm, plusMinus: pm, n, variance };
}
export function welchP(a: ContStat, b: ContStat): number {
  if (a.n < 1 || b.n < 1) return 1;
  const se = Math.sqrt(a.variance / a.n + b.variance / b.n);
  if (!(se > 0)) return 1;
  const t = (b.mean - a.mean) / se;
  return 2 * (1 - normalCdf(Math.abs(t))); // normal approx to t at these df
}

// Bayesian probability that variant beats control on a continuous metric,
// under a normal approximation of each arm's sampling distribution of the mean.
// Takes Arms ({mean, se}) — the SAME shape upliftCI/probBest receive. Previously
// typed as ContStat and called with Arms via `as any`: an Arm has no .variance/.n,
// so se computed to NaN and the function collapsed to a 1/0 boolean (probBeat bug).
// Mathematically identical to the old form since se² = variance / n.
export function probToBeat(control: Arm, variant: Arm): number {
  const diff = variant.mean - control.mean;
  const se = Math.sqrt(control.se * control.se + variant.se * variant.se);
  if (!(se > 0)) return diff > 0 ? 1 : diff < 0 ? 0 : 0.5;
  return normalCdf(diff / se);
}

// An "arm" for Bayesian comparison: the sampling distribution of its mean.
export type Arm = { mean: number; se: number };

// Gaussian draw (Box-Muller). Node runtime — Math.random is available here.
function gauss(mean: number, sd: number): number {
  let u = 0, v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  return mean + sd * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

// Probability each arm is the best (highest mean). Monte Carlo over normal
// posteriors — general for any number of variations (2-way or n-way).
export function probBest(arms: Arm[], draws = 20000): number[] {
  const k = arms.length;
  const wins = new Array(k).fill(0);
  const degenerate = arms.some((a) => !(a.se > 0));
  if (degenerate) {
    let bi = 0;
    for (let i = 1; i < k; i++) if (arms[i].mean > arms[bi].mean) bi = i;
    wins[bi] = draws;
  } else {
    for (let d = 0; d < draws; d++) {
      let bi = 0, bv = -Infinity;
      for (let i = 0; i < k; i++) {
        const s = gauss(arms[i].mean, arms[i].se);
        if (s > bv) { bv = s; bi = i; }
      }
      wins[bi]++;
    }
  }
  return wins.map((w) => w / draws);
}

// Relative uplift of variant vs control, with a 90% interval (the "−38% to +178%"
// range IG shows). Built from the difference-of-means distribution.
export function upliftCI(control: Arm, variant: Arm, z = 1.645): { uplift: number; lo: number; hi: number } | null {
  if (!(control.mean > 0)) return null;
  const diff = variant.mean - control.mean;
  const se = Math.sqrt(control.se * control.se + variant.se * variant.se);
  return { uplift: diff / control.mean, lo: (diff - z * se) / control.mean, hi: (diff + z * se) / control.mean };
}

// Verdict, mirroring IG's testResult. Guards on minimum runtime + orders so we
// never flash false confidence on an under-powered test (see RECON-FINDINGS §B).
export type Verdict =
  | "not_ready" | "strong_win" | "directional_win" | "flat" | "directional_loss" | "strong_loss";
export function verdict(opts: {
  daysLive: number;
  ordersControl: number;
  ordersVariant: number;
  relLift: number;   // variant vs control on primary metric
  probBeat: number;  // P(variant > control)
}): Verdict {
  const { daysLive, ordersControl, ordersVariant, probBeat } = opts;
  if (daysLive < 7 || ordersControl < 300 || ordersVariant < 300) return "not_ready";
  // Direction comes from probBeat = P(variant > control), NOT relLift. relLift
  // is null (-> coerced to 0) whenever the control mean is <= 0 (e.g. a negative
  // profit/visitor baseline), which previously mislabeled a clearly winning
  // variant as strong_loss. probBeat >= 0.95 already means we're 95% sure the
  // variant beats control, so it IS a win; <= 0.05 IS a loss. relLift stays for
  // display only.
  if (probBeat >= 0.95) return "strong_win";
  if (probBeat >= 0.80) return "directional_win";
  if (probBeat <= 0.05) return "strong_loss";
  if (probBeat <= 0.20) return "directional_loss";
  return "flat";
}
