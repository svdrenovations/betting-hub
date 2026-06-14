// sim-data.js — feeds run-sim.js with real, regressed player rates from the MLB Stats API.
//
// This is the data plumbing for the simulator: pull each hitter's and pitcher's season
// line, convert to per-PA outcome fractions, regress small samples toward league average,
// assemble the matchup object, and hand it to the engine. The MLB Stats API is free and
// keyless — same source analyze.js already uses for lineups.
//
// NOTE: I can't reach statsapi.mlb.com from where this was written, so the fetch/field
// mapping is built against the documented API shape (and matches the fields analyze.js
// already reads: atBats, ops, homeRuns, strikeOuts). VALIDATE it once in your environment
// with the self-test at the bottom: `node sim-data.js <batterId> <pitcherId>`.

const { simulate, LEAGUE } = require('./run-sim.js');

const MLB = 'https://statsapi.mlb.com/api/v1';
const SEASON_DEFAULT = new Date().getFullYear();
const EVENTS = ['bb', 'k', 's', 'd', 't', 'hr', 'out'];

// Regression weights: "ghost" PAs of league-average added to each rate. Larger = more
// regression / slower to trust the player. Roughly tracks each stat's stabilization point.
const REG_PA = { bb: 120, k: 60, s: 290, d: 290, t: 290, hr: 170, out: 120 };

// League share of NON-HR hits that are 1B/2B/3B — used to split a pitcher's allowed hits
// when the API doesn't expose doubles/triples allowed (and as a fallback).
const NONHR_HIT_SHARE = { s: 0.735, d: 0.243, t: 0.022 };

async function getJSON(url) {
  try { const res = await fetch(url); return res.ok ? await res.json() : null; }
  catch { return null; }
}

// Regress a per-PA rate vector toward league average by sample size, then renormalize to 1.
function regressVector(rates, pa) {
  const out = {};
  for (const e of EVENTS) {
    const r = REG_PA[e];
    out[e] = ((rates[e] ?? 0) * pa + LEAGUE[e] * r) / (pa + r);
  }
  const sum = EVENTS.reduce((a, e) => a + out[e], 0);
  for (const e of EVENTS) out[e] /= sum;
  return out;
}

function hittingToRates(s) {
  const pa = s.plateAppearances || 0;
  if (!pa) return null;
  const ev = {
    bb: ((s.baseOnBalls || 0) + (s.hitByPitch || 0)) / pa,
    k:  (s.strikeOuts || 0) / pa,
    s:  Math.max(0, (s.hits || 0) - (s.doubles || 0) - (s.triples || 0) - (s.homeRuns || 0)) / pa,
    d:  (s.doubles || 0) / pa,
    t:  (s.triples || 0) / pa,
    hr: (s.homeRuns || 0) / pa,
  };
  ev.out = Math.max(0, 1 - (ev.bb + ev.k + ev.s + ev.d + ev.t + ev.hr));
  return { rates: ev, pa };
}

function pitchingToRates(s) {
  const bf = s.battersFaced || 0;
  if (!bf) return null;
  const hr = (s.homeRuns || 0) / bf;
  let sRate, dRate, tRate;
  if (s.doubles != null && s.triples != null) {                 // use exact if exposed
    dRate = (s.doubles || 0) / bf;
    tRate = (s.triples || 0) / bf;
    sRate = Math.max(0, (s.hits || 0) - (s.doubles || 0) - (s.triples || 0) - (s.homeRuns || 0)) / bf;
  } else {                                                       // else split non-HR hits by league shares
    const nonHR = Math.max(0, (s.hits || 0) - (s.homeRuns || 0)) / bf;
    sRate = nonHR * NONHR_HIT_SHARE.s; dRate = nonHR * NONHR_HIT_SHARE.d; tRate = nonHR * NONHR_HIT_SHARE.t;
  }
  const ev = {
    bb: ((s.baseOnBalls || 0) + (s.hitByPitch || 0)) / bf,
    k:  (s.strikeOuts || 0) / bf,
    s: sRate, d: dRate, t: tRate, hr,
  };
  ev.out = Math.max(0, 1 - (ev.bb + ev.k + ev.s + ev.d + ev.t + ev.hr));
  return { rates: ev, pa: bf };
}

async function fetchBatterRates(playerId, season = SEASON_DEFAULT) {
  const data = await getJSON(`${MLB}/people/${playerId}/stats?stats=season&group=hitting&season=${season}&sportId=1&gameType=R`);
  const conv = hittingToRates(data?.stats?.[0]?.splits?.[0]?.stat || {});
  return conv ? { ...regressVector(conv.rates, conv.pa), pa: conv.pa } : { ...LEAGUE, pa: 0 };
}

async function fetchPitcherRates(playerId, season = SEASON_DEFAULT) {
  const data = await getJSON(`${MLB}/people/${playerId}/stats?stats=season&group=pitching&season=${season}&sportId=1&gameType=R`);
  const conv = pitchingToRates(data?.stats?.[0]?.splits?.[0]?.stat || {});
  return conv ? { ...regressVector(conv.rates, conv.pa), pa: conv.pa } : { ...LEAGUE, pa: 0 };
}

// Bullpen proxy: team overall pitching for now (whole staff, not pen-only). Good enough as
// a back-third estimate to start; refinement = aggregate only relievers.
async function fetchBullpenRates(teamId, season = SEASON_DEFAULT) {
  const data = await getJSON(`${MLB}/teams/${teamId}/stats?stats=season&group=pitching&season=${season}&sportId=1&gameType=R`);
  const conv = pitchingToRates(data?.stats?.[0]?.splits?.[0]?.stat || {});
  return conv ? { ...regressVector(conv.rates, conv.pa), pa: conv.pa } : { ...LEAGUE, pa: 0 };
}

// Assemble the matchup object run-sim.js expects from confirmed lineup + pitcher IDs.
// away/homeLineupIds: arrays of 9 batter personIds in batting order.
async function buildMatchup({
  awayLineupIds, homeLineupIds, awayStarterId, homeStarterId, awayTeamId, homeTeamId,
  ctx = {}, totalLine = null, f5Line = null,
  starterInningsAway = 6, starterInningsHome = 6, season = SEASON_DEFAULT,
}) {
  const [awayBats, homeBats, awaySP, homeSP, awayPen, homePen] = await Promise.all([
    Promise.all(awayLineupIds.slice(0, 9).map(id => fetchBatterRates(id, season))),
    Promise.all(homeLineupIds.slice(0, 9).map(id => fetchBatterRates(id, season))),
    fetchPitcherRates(awayStarterId, season),
    fetchPitcherRates(homeStarterId, season),
    fetchBullpenRates(awayTeamId, season),
    fetchBullpenRates(homeTeamId, season),
  ]);
  return {
    // away lineup faces the HOME starter/pen; starterInnings on each side = that starter's IP
    away: { lineup: awayBats, starter: awaySP, pen: awayPen, starterInnings: starterInningsHome },
    home: { lineup: homeBats, starter: homeSP, pen: homePen, starterInnings: starterInningsAway },
    ctx, totalLine, f5Line,
  };
}

// One call: build the matchup from IDs, simulate, return market probabilities.
async function simulateGame(args, N = 20000) {
  return simulate(await buildMatchup(args), N);
}

module.exports = { fetchBatterRates, fetchPitcherRates, fetchBullpenRates, buildMatchup, simulateGame };

// ===========================================================================
// WIRING INTO analyze.js (deriveNumbers):
//   You already resolve confirmed lineups and starters. Pass their personIds + team IDs:
//     const probs = await simulateGame({
//       awayLineupIds, homeLineupIds, awayStarterId, homeStarterId, awayTeamId, homeTeamId,
//       ctx: { parkHR, wxHR },            // from your existing park + weather factors
//       totalLine: lines.total, f5Line: f5Lines?.f5Total,
//       starterInningsAway: 6, starterInningsHome: 6,
//     });
//   Then feed probs.pAwayML / pOver / pAwayRL / pF5* into your EXISTING EV / pickSide /
//   verdictFor logic, REPLACING the TOTAL_SD / MARGIN_SD normal approximation. Keep the
//   LLM run projection as a cross-check at first (flag big sim-vs-LLM divergences).
//
// NEXT REFINEMENTS (in priority order), once the base is validated end-to-end:
//   1. PLATOON: pass each batter's hand + pitcher's hand and adjust rates by handedness
//      (the engine's buildPAModel already has a hook). Biggest accuracy gain.
//   2. PITCH-CHARACTERISTIC matchups (arm angle / spin) layered on the platoon step.
//   3. TRUE BULLPEN: aggregate only relievers instead of whole-staff team pitching.
//   4. Multi-season / projection-blended rates instead of current-season-only.
//   Then calibrate sim mean runs vs actual (RMSE) and tune REG_PA.
// ===========================================================================

// --- self-test: validate the live MLB API fetch IN YOUR ENVIRONMENT ---
// node sim-data.js                      (uses example IDs)
// node sim-data.js 592450 543037        (a real batter, a real pitcher from a lineup)
if (require.main === module) {
  (async () => {
    const batterId = process.argv[2] || 592450;   // example IDs — replace with real ones
    const pitcherId = process.argv[3] || 543037;
    const b = await fetchBatterRates(batterId);
    const p = await fetchPitcherRates(pitcherId);
    console.log(`Batter ${batterId} (PA ${b.pa}):`, b);
    console.log(`Pitcher ${pitcherId} (BF ${p.pa}):`, p);
    if (b.pa === 0) console.log('  ⚠ batter returned league-average — check the ID / API shape');
    if (p.pa === 0) console.log('  ⚠ pitcher returned league-average — check the ID / API shape');
  })().catch(e => { console.error('self-test failed:', e); process.exit(1); });
}
