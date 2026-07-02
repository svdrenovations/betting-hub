// run-sim.js — Monte Carlo game simulator
// REBUILT: calibrated baserunning, game-level variance, walk-offs, extra innings

const LEAGUE = { bb: 0.090, k: 0.225, s: 0.140, d: 0.045, t: 0.004, hr: 0.030 };
LEAGUE.out = 1 - (LEAGUE.bb + LEAGUE.k + LEAGUE.s + LEAGUE.d + LEAGUE.t + LEAGUE.hr);
const EVENTS = ['bb', 'k', 's', 'd', 't', 'hr', 'out'];

const HOME_EDGE = 0.025;

function log5(b, p, l) {
  if (l <= 0 || l >= 1) return b;
  const x = (b * p) / l;
  const y = ((1 - b) * (1 - p)) / (1 - l);
  return x / (x + y);
}

function buildPAModel(batter, pitcher, ctx = {}) {
  const parkHR       = ctx.parkHR       ?? 1;
  const wxHR         = ctx.wxHR         ?? 1;
  const wxOff        = ctx.wxOff        ?? 1;
  const umpK         = ctx.umpK         ?? 1;
  const umpBB        = ctx.umpBB        ?? 1;
  const offMult      = ctx.offMult      ?? 1;
  const umpRunFactor = ctx.umpRunFactor ?? 1;
  const gameMult     = ctx.gameMult     ?? 1;   // per-game pitcher variance

  const raw = {};
  for (const e of EVENTS) {
    let v = log5(batter[e], pitcher[e], LEAGUE[e]);
    if (e === 'hr') v *= parkHR * wxHR * wxOff * gameMult;
    if (e === 'k')  v *= umpK / Math.max(gameMult, 0.5);     // bad pitcher day = fewer K
    if (e === 'bb') v *= umpBB * gameMult;
    if (e === 's' || e === 'd' || e === 't') v *= wxOff * gameMult;
    if (e !== 'k' && e !== 'out') v *= offMult * umpRunFactor;
    raw[e] = Math.max(0, v);
  }
  const sum = EVENTS.reduce((a, e) => a + raw[e], 0);
  const probs = {};
  for (const e of EVENTS) probs[e] = raw[e] / sum;
  return probs;
}

function samplePA(probs, rng) {
  let r = rng();
  for (const e of EVENTS) { r -= probs[e]; if (r <= 0) return e; }
  return 'out';
}

// Calibrated baserunning
function advance(bases, type, rng) {
  let [b1, b2, b3] = bases, runs = 0;
  if (type === 'hr') return { bases: [false, false, false], runs: 1 + (b1?1:0) + (b2?1:0) + (b3?1:0) };
  if (type === 't')  return { bases: [false, false, true],  runs: (b1?1:0) + (b2?1:0) + (b3?1:0) };
  if (type === 'd') {
    if (b3) runs++;
    if (b2) runs++;
    let occ3 = false;
    if (b1) { if (rng() < 0.50) runs++; else occ3 = true; }   // 50% (was 46%)
    return { bases: [false, true, occ3], runs };
  }
  // single
  if (b3) runs++;
  let occ3 = false;
  if (b2) { if (rng() < 0.70) runs++; else occ3 = true; }     // 70% (was 63%)
  let occ2 = false;
  if (b1) { if (!occ3 && rng() < 0.40) occ3 = true; else occ2 = true; }  // 40% (was 30%)
  return { bases: [true, occ2, occ3], runs };
}

function walk(bases) {
  let [b1, b2, b3] = bases, runs = 0;
  if (b1) { if (b2) { if (b3) runs++; b3 = true; } b2 = true; }
  b1 = true;
  return { bases: [b1, b2, b3], runs };
}

function simHalf(models, ptr, rng) {
  let outs = 0, runs = 0, bases = [false, false, false];
  while (outs < 3) {
    const o = samplePA(models[ptr % 9], rng);
    ptr++;
    if (o === 'k') { outs++; continue; }
    if (o === 'out') {
      // GDP: 8% of in-play outs with runner on 1st (was 12%)
      if (outs < 2 && bases[0] && rng() < 0.08) {
        outs += 2;
        bases[0] = false;
        if (bases[2]) { runs++; bases[2] = false; }
        continue;
      }
      if (outs < 2) {
        if (bases[2] && rng() < 0.55) { runs++; bases[2] = false; }
        if (bases[1] && !bases[2] && rng() < 0.28) { bases[2] = true; bases[1] = false; }
        if (bases[0] && !bases[1] && rng() < 0.22) { bases[1] = true; bases[0] = false; }
      }
      outs++; continue;
    }
    const res = (o === 'bb') ? walk(bases) : advance(bases, o, rng);
    bases = res.bases; runs += res.runs;
  }
  return { runs, ptr };
}

// Lognormal game-level pitcher variance — sigma=0.18 means ~68% of games within ±18% of projected
function drawGameMult(rng, sigma = 0.40) {  // wider variance = more realistic game-to-game spread
  const u1 = Math.max(rng(), 1e-10);
  const u2 = rng();
  const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  return Math.min(Math.max(Math.exp(sigma * z - (sigma * sigma) / 2), 0.55), 2.0);
}

function simGame(matchup, rng) {
  const { away, home } = matchup;

  // Draw independent per-game pitcher variance for each team's starter
  const awayStarterMult = drawGameMult(rng); // away team's starter variance
  const homeStarterMult = drawGameMult(rng); // home team's starter variance

  // Away batters face HOME team's starter (with home starter's random day)
  const awayVsStarter = away.lineupRaw.map(b =>
    buildPAModel(b, home.starterPitcher, { ...away.ctx, gameMult: homeStarterMult })
  );
  // Away batters face HOME pen (no per-game variance for bullpen)
  const awayVsPen = away.lineupRaw.map(b =>
    buildPAModel(b, home.penPitcher, away.ctx)
  );

  // Home batters face AWAY team's starter (with away starter's random day)
  const homeVsStarter = home.lineupRaw.map(b =>
    buildPAModel(b, away.starterPitcher, { ...home.ctx, gameMult: awayStarterMult })
  );
  // Home batters face AWAY pen
  const homeVsPen = home.lineupRaw.map(b =>
    buildPAModel(b, away.penPitcher, home.ctx)
  );

  const awayModels = (inn) => inn <= home.starterInnings ? awayVsStarter : awayVsPen;
  const homeModels = (inn) => inn <= away.starterInnings ? homeVsStarter : homeVsPen;

  let aR = 0, hR = 0, aF5 = 0, hF5 = 0, aPtr = 0, hPtr = 0;

  for (let inn = 1; inn <= 9; inn++) {
    // Away half
    let r = simHalf(awayModels(inn), aPtr, rng);
    aR += r.runs; aPtr = r.ptr;
    if (inn <= 5) aF5 += r.runs;

    // Home half — walk-off in bottom 9
    if (inn === 9) {
      // Play home 9th but stop if they take the lead
      let outs = 0, hExtra = 0, bases = [false, false, false];
      const hMods = homeModels(9);
      let walkOff = false;
      while (outs < 3) {
        const o = samplePA(hMods[hPtr % 9], rng); hPtr++;
        if (o === 'k') { outs++; continue; }
        if (o === 'out') { outs++; continue; }
        const res = (o === 'bb') ? walk(bases) : advance(bases, o, rng);
        bases = res.bases; hExtra += res.runs;
        if (hR + hExtra > aR) { walkOff = true; break; }
      }
      hR += hExtra;
      if (inn <= 5) hF5 += hExtra;
    } else {
      r = simHalf(homeModels(inn), hPtr, rng);
      hR += r.runs; hPtr = r.ptr;
      if (inn <= 5) hF5 += r.runs;
    }
  }

  // Extra innings (up to 3) with runner on 2nd rule
  if (aR === hR) {
    for (let xi = 0; xi < 3; xi++) {
      const penA = awayVsPen, penH = homeVsPen;

      // Away extra half
      let exBases = [false, true, false], exOuts = 0, exRuns = 0;
      while (exOuts < 3) {
        const o = samplePA(penA[aPtr % 9], rng); aPtr++;
        if (o === 'k') { exOuts++; continue; }
        if (o === 'out') { exOuts++; continue; }
        const res = o === 'bb' ? walk(exBases) : advance(exBases, o, rng);
        exBases = res.bases; exRuns += res.runs;
      }
      aR += exRuns;

      // Home extra half
      exBases = [false, true, false]; exOuts = 0; exRuns = 0;
      let walkOff = false;
      while (exOuts < 3) {
        const o = samplePA(penH[hPtr % 9], rng); hPtr++;
        if (o === 'k') { exOuts++; continue; }
        if (o === 'out') { exOuts++; continue; }
        const res = o === 'bb' ? walk(exBases) : advance(exBases, o, rng);
        exBases = res.bases; exRuns += res.runs;
        if (hR + exRuns > aR) { walkOff = true; break; }
      }
      hR += exRuns;
      if (aR !== hR) break;
    }
    // Still tied: coin flip
    if (aR === hR) { if (rng() < 0.5) aR++; else hR++; }
  }

  return { aR, hR, aF5, hF5 };
}

function simulate(matchup, N = 20000, rng = Math.random) {
  const ctx = matchup.ctx || {};
  const homeCtx = { ...ctx, offMult: (ctx.offMult ?? 1) * (1 + HOME_EDGE) };
  const awayCtx = { ...ctx, offMult: (ctx.offMult ?? 1) * (1 - HOME_EDGE) };

  // Package everything simGame needs
  const prepared = {
    away: {
      lineupRaw: matchup.away.lineup,
      starterPitcher: matchup.away.starter,  // away team's starter (home batters face this)
      penPitcher: matchup.away.pen,
      ctx: awayCtx,
      starterInnings: matchup.away.starterInnings ?? 6,
    },
    home: {
      lineupRaw: matchup.home.lineup,
      starterPitcher: matchup.home.starter,  // home team's starter (away batters face this)
      penPitcher: matchup.home.pen,
      ctx: homeCtx,
      starterInnings: matchup.home.starterInnings ?? 6,
    },
  };

  const T = matchup.totalLine, F = matchup.f5Line;
  let aWin = 0, tie = 0, aCoverRL = 0, hCoverRL = 0, aSum = 0, hSum = 0;
  let over = 0, under = 0, push = 0;
  let f5Over = 0, f5Under = 0, f5AwayWin = 0, f5Tie = 0;

  for (let i = 0; i < N; i++) {
    const g = simGame(prepared, rng);
    aSum += g.aR; hSum += g.hR;
    if (g.aR > g.hR) aWin++; else if (g.aR === g.hR) tie++;
    if (g.aR - g.hR >= 2) aCoverRL++;
    if (g.hR - g.aR >= 2) hCoverRL++;
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
    pAwayML: p(aWin + tie / 2),
    pHomeML: p((N - aWin - tie) + tie / 2),
    pAwayRL: p(aCoverRL),
    pHomeRL: 1 - p(aCoverRL),
    pAwayBy2: p(aCoverRL),
    pHomeBy2: p(hCoverRL),
    pOver: p(over), pUnder: p(under), pTotalPush: p(push),
    pF5Over: p(f5Over), pF5Under: p(f5Under), pF5AwayML: p(f5AwayWin + f5Tie / 2),
  };
}

module.exports = { simulate, buildPAModel, LEAGUE };

if (require.main === module) {
  const mk = (o) => { o.out = 1 - (o.bb + o.k + o.s + o.d + o.t + o.hr); return o; };
  const avgBat = mk({ ...LEAGUE });
  const avgPit = mk({ ...LEAGUE });
  const acePit = mk({ bb: 0.060, k: 0.280, s: 0.110, d: 0.033, t: 0.003, hr: 0.022 });
  const badPit = mk({ bb: 0.110, k: 0.170, s: 0.160, d: 0.053, t: 0.005, hr: 0.040 });
  const goodBat = mk({ bb: 0.105, k: 0.195, s: 0.155, d: 0.055, t: 0.005, hr: 0.040 });
  const nine = (b) => Array.from({ length: 9 }, () => b);

  console.log('Test 1: League avg vs league avg (expect ~4.5 each, ~9 total, ~53% home win)');
  console.log(simulate({ away: { lineup: nine(avgBat), starter: avgPit, pen: avgPit, starterInnings: 6 },
    home: { lineup: nine(avgBat), starter: avgPit, pen: avgPit, starterInnings: 6 },
    ctx: {}, totalLine: 9, f5Line: 4.5 }, 50000));

  console.log('\nTest 2: Avg batter vs ace pitcher both sides (expect ~3 each)');
  console.log(simulate({ away: { lineup: nine(avgBat), starter: acePit, pen: avgPit, starterInnings: 7 },
    home: { lineup: nine(avgBat), starter: acePit, pen: avgPit, starterInnings: 7 },
    ctx: {}, totalLine: 6, f5Line: 3 }, 50000));

  console.log('\nTest 3: Good batter vs bad pitcher both sides (expect ~7 each)');
  console.log(simulate({ away: { lineup: nine(goodBat), starter: badPit, pen: badPit, starterInnings: 5 },
    home: { lineup: nine(goodBat), starter: badPit, pen: badPit, starterInnings: 5 },
    ctx: {}, totalLine: 14, f5Line: 7 }, 50000));

  console.log('\nTest 4: Ace pitcher (away) vs bad pitcher (home) — home should be heavy fav');
  console.log(simulate({ away: { lineup: nine(avgBat), starter: badPit, pen: avgPit, starterInnings: 5 },
    home: { lineup: nine(avgBat), starter: acePit, pen: avgPit, starterInnings: 7 },
    ctx: {}, totalLine: 7, f5Line: 3.5 }, 50000));
}
