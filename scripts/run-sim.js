// run-sim.js — Monte Carlo game simulator (minimal sketch)
//
// PURPOSE: replace the fixed-SD normal approximation in analyze.js (TOTAL_SD=5.5,
// MARGIN_SD=4.0) with a simulated run DISTRIBUTION. One simulation yields ML, Total,
// Run-line, and F5 probabilities from a single consistent engine — no more separate
// SD assumptions per market, and the tails (where total/RL value lives) come out
// shaped like real baseball instead of a bell curve.
//
// STATUS: the simulation logic is complete and runnable — `node run-sim.js` prints a
// sample distribution. The REAL remaining work is the data plumbing (see INPUT CONTRACT
// and WIRING below): feeding it true per-batter and per-pitcher rate stats.

// ---------------------------------------------------------------------------
// League-average outcome rates per plate appearance (approx — retune each season).
// Outcomes: bb (walk+HBP), k, s (single), d (double), t (triple), hr, out (in-play out).
// ---------------------------------------------------------------------------
const LEAGUE = { bb: 0.090, k: 0.225, s: 0.140, d: 0.045, t: 0.004, hr: 0.030 };
LEAGUE.out = 1 - (LEAGUE.bb + LEAGUE.k + LEAGUE.s + LEAGUE.d + LEAGUE.t + LEAGUE.hr);
const EVENTS = ['bb', 'k', 's', 'd', 't', 'hr', 'out'];

// Odds-ratio (log5) combination of a batter rate and a pitcher rate vs league baseline.
// This is the standard way to merge "how often does THIS hitter do X" with "how often
// does THIS pitcher allow X" into a matchup-specific rate.
function log5(b, p, l) {
  if (l <= 0 || l >= 1) return b;
  const x = (b * p) / l;
  const y = ((1 - b) * (1 - p)) / (1 - l);
  return x / (x + y);
}

// Build the per-PA outcome distribution for a batter vs a pitcher, with context
// multipliers (park HR factor, weather, umpire K/BB nudge). Returns normalized probs.
// NOTE: pass batter/pitcher objects whose rates are already PLATOON-correct
//   (i.e., the hitter's vs-RHP rates when facing a RHP). That's how arm-side and,
//   eventually, pitch-characteristic effects enter — see the matchup discussion.
function buildPAModel(batter, pitcher, ctx = {}) {
  const parkHR = ctx.parkHR ?? 1;   // >1 = hitter-friendly park
  const wxHR   = ctx.wxHR   ?? 1;   // weather HR multiplier (hot/wind out = >1)
  const umpK   = ctx.umpK   ?? 1;   // umpire zone -> K multiplier
  const umpBB  = ctx.umpBB  ?? 1;

  const raw = {};
  for (const e of EVENTS) {
    let v = log5(batter[e], pitcher[e], LEAGUE[e]);
    if (e === 'hr') v *= parkHR * wxHR;
    if (e === 'k')  v *= umpK;
    if (e === 'bb') v *= umpBB;
    raw[e] = v;
  }
  const sum = EVENTS.reduce((a, e) => a + raw[e], 0);
  const probs = {};
  for (const e of EVENTS) probs[e] = raw[e] / sum; // renormalize to 1
  return probs;
}

function samplePA(probs, rng = Math.random) {
  let r = rng();
  for (const e of EVENTS) { r -= probs[e]; if (r <= 0) return e; }
  return 'out';
}

// Advance existing runners by k bases (single=1, double=2, triple=3, HR=4). Returns runs.
// SIMPLIFICATION: runners advance exactly k bases. Real baserunning is more aggressive
// (runner from 2nd often scores on a single) — a tuning knob to add later.
function advance(bases, k) {
  let runs = 0;
  const nb = [false, false, false];
  for (let i = 0; i < 3; i++) {
    if (bases[i]) { const np = (i + 1) + k; if (np >= 4) runs++; else nb[np - 1] = true; }
  }
  if (k >= 4) runs++; else nb[k - 1] = true; // batter
  return { bases: nb, runs };
}

// Force-advance on a walk / HBP.
function walk(bases) {
  let [b1, b2, b3] = bases, runs = 0;
  if (b1) { if (b2) { if (b3) runs++; b3 = true; } b2 = true; }
  b1 = true;
  return { bases: [b1, b2, b3], runs };
}

// Simulate one half-inning. models[i] = PA distribution for lineup slot i vs the
// current pitcher. ptr carries the batting order across innings.
function simHalf(models, ptr, rng) {
  let outs = 0, runs = 0, bases = [false, false, false];
  while (outs < 3) {
    const o = samplePA(models[ptr % 9], rng);
    ptr++;
    if (o === 'k' || o === 'out') { outs++; continue; }   // (no DPs/productive outs yet)
    const res = (o === 'bb')
      ? walk(bases)
      : advance(bases, o === 's' ? 1 : o === 'd' ? 2 : o === 't' ? 3 : 4);
    bases = res.bases; runs += res.runs;
  }
  return { runs, ptr };
}

// Pre-build PA models for a 9-man lineup vs starter and vs bullpen (done once per sim run,
// not once per PA — this is the main perf lever).
function lineupModels(lineup, starter, pen, ctx) {
  return {
    vsStarter: lineup.map(b => buildPAModel(b, starter, ctx)),
    vsPen:     lineup.map(b => buildPAModel(b, pen, ctx)),
  };
}

// Simulate one full 9-inning game. Returns away/home total runs and first-5 runs.
function simGame(away, home, rng) {
  let aR = 0, hR = 0, aF5 = 0, hF5 = 0, aPtr = 0, hPtr = 0;
  for (let inn = 1; inn <= 9; inn++) {
    const aModels = inn <= away.starterInnings ? away.vsStarter : away.vsPen;
    let r = simHalf(aModels, aPtr, rng); aR += r.runs; aPtr = r.ptr; if (inn <= 5) aF5 += r.runs;
    const hModels = inn <= home.starterInnings ? home.vsStarter : home.vsPen;
    r = simHalf(hModels, hPtr, rng); hR += r.runs; hPtr = r.ptr; if (inn <= 5) hF5 += r.runs;
  }
  return { aR, hR, aF5, hF5 }; // (9 innings for both; walk-off truncation & extra innings = refinements)
}

// Run N sims and derive every market probability from the one distribution.
function simulate(matchup, N = 20000, rng = Math.random) {
  const ctx = matchup.ctx || {};
  const away = {
    ...lineupModels(matchup.away.lineup, matchup.home.starter, matchup.home.pen, ctx),
    starterInnings: matchup.home.starterInnings ?? 6,
  };
  const home = {
    ...lineupModels(matchup.home.lineup, matchup.away.starter, matchup.away.pen, ctx),
    starterInnings: matchup.away.starterInnings ?? 6,
  };

  const T = matchup.totalLine, F = matchup.f5Line; // e.g. 8.5, 4.5
  let aWin = 0, tie = 0, aCoverRL = 0, aSum = 0, hSum = 0;
  let over = 0, under = 0, push = 0;
  let f5Over = 0, f5Under = 0, f5AwayWin = 0, f5Tie = 0;

  for (let i = 0; i < N; i++) {
    const g = simGame(away, home, rng);
    aSum += g.aR; hSum += g.hR;
    if (g.aR > g.hR) aWin++; else if (g.aR === g.hR) tie++;
    if (g.aR - g.hR >= 2) aCoverRL++;                     // away -1.5
    const tot = g.aR + g.hR;
    if (T != null) { if (tot > T) over++; else if (tot < T) under++; else push++; }
    const f5 = g.aF5 + g.hF5;
    if (F != null) { if (f5 > F) f5Over++; else if (f5 < F) f5Under++; }
    if (g.aF5 > g.hF5) f5AwayWin++; else if (g.aF5 === g.hF5) f5Tie++;
  }

  const p = (x) => x / N;
  return {
    meanAway: +(aSum / N).toFixed(2), meanHome: +(hSum / N).toFixed(2),
    meanTotal: +((aSum + hSum) / N).toFixed(2),
    pAwayML: p(aWin + tie / 2),            // ties split 50/50 (placeholder for extra innings)
    pHomeML: p((N - aWin - tie) + tie / 2),
    pAwayRL: p(aCoverRL),                  // away -1.5
    pHomeRL: 1 - p(aCoverRL),              // home +1.5 (no push at the 1.5 hook)
    pOver: p(over), pUnder: p(under), pTotalPush: p(push),
    pF5Over: p(f5Over), pF5Under: p(f5Under), pF5AwayML: p(f5AwayWin + f5Tie / 2),
  };
}

module.exports = { simulate, buildPAModel, LEAGUE };

// ===========================================================================
// INPUT CONTRACT (the data plumbing that's the real work):
//   Each BATTER object needs per-PA rates: { bb, k, s, d, t, hr, out } summing to ~1,
//     ideally PROJECTED + REGRESSED and PLATOON-correct (vs the starter's hand).
//   Each PITCHER (starter + a bullpen composite) needs the same allowed-rate shape.
//   ctx: { parkHR, wxHR, umpK, umpBB }.
//   You already fetch lineups, pitcher stats, park, and weather — the new fetch is each
//   hitter's rate line (MLB Stats API season hitting, or a projection feed), converted to
//   per-PA fractions. That conversion + a vs-LHP/vs-RHP split is ~80% of the effort.
//
// WIRING INTO analyze.js:
//   In deriveNumbers, instead of projRuns + SD -> normal CDF, call simulate(matchup) and
//   read pAwayML / pOver / pAwayRL / pF5* straight off the result, then feed those into
//   your EXISTING EV / pickSide / verdictFor machinery unchanged. Keep the LLM run
//   projection as a CROSS-CHECK at first: if sim mean and LLM mean diverge a lot, flag the
//   game rather than trusting either blindly.
//
// REFINEMENT KNOBS (add once the base is calibrated):
//   double plays & productive outs, smarter baserunning, extra-innings + walk-off
//   truncation, pitch-characteristic matchup adjustments, reliever leverage/usage,
//   defense. Calibrate sim mean runs vs actual (RMSE) and tune.
// ===========================================================================

if (require.main === module) {
  // Demo with synthetic rates so you can watch it run: node run-sim.js
  const mk = (o) => { o.out = 1 - (o.bb + o.k + o.s + o.d + o.t + o.hr); return o; };
  const avgBat  = mk({ ...LEAGUE });
  const goodBat = mk({ bb: .10, k: .18, s: .15, d: .055, t: .005, hr: .045 });
  const ace     = mk({ bb: .06, k: .29, s: .12, d: .038, t: .003, hr: .022 });
  const avgPit  = mk({ ...LEAGUE });
  const nine = (b) => Array.from({ length: 9 }, () => b);

  const matchup = {
    away: { lineup: nine(avgBat),  starter: avgPit, pen: avgPit, starterInnings: 6 },
    home: { lineup: nine(goodBat), starter: ace,    pen: avgPit, starterInnings: 6 },
    ctx: { parkHR: 1.05 }, totalLine: 8.5, f5Line: 4.5,
  };
  console.log(simulate(matchup, 20000));
}
