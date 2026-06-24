// sim-data.js — feeds run-sim.js with real, context-aware data
// REBUILT: now feeds park factors, weather, platoon splits, Statcast adjustments,
// actual starter innings, and real bullpen (relievers only) into the engine.

const { simulate, LEAGUE } = require('./run-sim.js');

const MLB = 'https://statsapi.mlb.com/api/v1';
const SEASON_DEFAULT = new Date().getFullYear();
const EVENTS = ['bb', 'k', 's', 'd', 't', 'hr', 'out'];

// Regression weights — larger = regress faster toward league average
const REG_PA = { bb: 120, k: 60, s: 290, d: 290, t: 290, hr: 170, out: 120 };

// Non-HR hit distribution for pitchers missing doubles/triples in API
const NONHR_HIT_SHARE = { s: 0.735, d: 0.243, t: 0.022 };

// Platoon adjustments — how much to scale outcome rates when batter/pitcher handedness matches vs opposes
// Source: MLB career splits research. Same-hand matchup favors pitcher (reduce batter output)
const PLATOON = {
  // [batterHand][pitcherHand] = multiplier on batter offensive outcomes (bb, hits, hr)
  R: { R: 0.93, L: 1.07 },  // RHB vs RHP: slight pitcher advantage; RHB vs LHP: batter advantage
  L: { R: 1.07, L: 0.93 },  // LHB vs RHP: batter advantage; LHB vs LHP: pitcher advantage
  S: { R: 1.02, L: 1.02 },  // Switch hitter: slight advantage either way
};

async function getJSON(url) {
  try {
    const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    return res.ok ? await res.json() : null;
  } catch { return null; }
}

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
  if (s.doubles != null && s.triples != null) {
    dRate = (s.doubles || 0) / bf;
    tRate = (s.triples || 0) / bf;
    sRate = Math.max(0, (s.hits || 0) - (s.doubles || 0) - (s.triples || 0) - (s.homeRuns || 0)) / bf;
  } else {
    const nonHR = Math.max(0, (s.hits || 0) - (s.homeRuns || 0)) / bf;
    sRate = nonHR * NONHR_HIT_SHARE.s;
    dRate = nonHR * NONHR_HIT_SHARE.d;
    tRate = nonHR * NONHR_HIT_SHARE.t;
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

async function fetchBatterHandedness(playerId) {
  const data = await getJSON(`${MLB}/people/${playerId}`);
  return data?.people?.[0]?.batSide?.code || 'R'; // default R
}

async function fetchPitcherRates(playerId, season = SEASON_DEFAULT) {
  const data = await getJSON(`${MLB}/people/${playerId}/stats?stats=season&group=pitching&season=${season}&sportId=1&gameType=R`);
  const conv = pitchingToRates(data?.stats?.[0]?.splits?.[0]?.stat || {});
  return conv ? { ...regressVector(conv.rates, conv.pa), pa: conv.pa } : { ...LEAGUE, pa: 0 };
}

// Fetch true bullpen rates — relievers only, not whole staff
async function fetchBullpenRates(teamId, season = SEASON_DEFAULT) {
  // Get all pitchers with < 3 GS (relievers) for the team
  const data = await getJSON(`${MLB}/teams/${teamId}/roster?rosterType=active&season=${season}`);
  if (!data?.roster) {
    // Fallback: whole team pitching
    const teamData = await getJSON(`${MLB}/teams/${teamId}/stats?stats=season&group=pitching&season=${season}&sportId=1&gameType=R`);
    const conv = pitchingToRates(teamData?.stats?.[0]?.splits?.[0]?.stat || {});
    return conv ? { ...regressVector(conv.rates, conv.pa), pa: conv.pa } : { ...LEAGUE, pa: 0 };
  }

  // Filter to pitchers
  const pitchers = data.roster.filter(p => p.position?.code === '1').slice(0, 12);
  if (!pitchers.length) return { ...LEAGUE, pa: 0 };

  // Fetch stats for each pitcher and aggregate relievers
  const stats = await Promise.all(
    pitchers.map(p => getJSON(`${MLB}/people/${p.person.id}/stats?stats=season&group=pitching&season=${season}&sportId=1&gameType=R`))
  );

  // Aggregate only relievers (GS < 3)
  let totalBF = 0, agg = { bb: 0, k: 0, s: 0, d: 0, t: 0, hr: 0 };
  for (const s of stats) {
    const stat = s?.stats?.[0]?.splits?.[0]?.stat;
    if (!stat) continue;
    if ((stat.gamesStarted || 0) >= 3) continue; // skip starters
    const bf = stat.battersFaced || 0;
    if (!bf) continue;
    totalBF += bf;
    agg.bb += ((stat.baseOnBalls || 0) + (stat.hitByPitch || 0));
    agg.k  += (stat.strikeOuts || 0);
    agg.hr += (stat.homeRuns || 0);
    const nonHR = Math.max(0, (stat.hits || 0) - (stat.homeRuns || 0));
    agg.s  += nonHR * NONHR_HIT_SHARE.s;
    agg.d  += nonHR * NONHR_HIT_SHARE.d;
    agg.t  += nonHR * NONHR_HIT_SHARE.t;
  }

  if (!totalBF) return { ...LEAGUE, pa: 0 };
  const rates = {};
  for (const e of ['bb','k','s','d','t','hr']) rates[e] = agg[e] / totalBF;
  rates.out = Math.max(0, 1 - Object.values(rates).reduce((a,b) => a+b, 0));
  return { ...regressVector(rates, totalBF), pa: totalBF };
}

// Apply platoon adjustment to a single batter
function applyPlatoon(batterRates, batterHand, pitcherHand) {
  if (!batterHand || !pitcherHand) return batterRates;
  const mult = PLATOON[batterHand]?.[pitcherHand] ?? 1.0;
  if (Math.abs(mult - 1.0) < 0.01) return batterRates;
  const adjusted = { ...batterRates };
  for (const e of ['bb', 's', 'd', 't', 'hr']) adjusted[e] = (adjusted[e] || 0) * mult;
  const sum = EVENTS.reduce((a, e) => a + (adjusted[e] || 0), 0);
  for (const e of EVENTS) adjusted[e] = (adjusted[e] || 0) / sum;
  return adjusted;
}

// Derive effective platoon multiplier from handedness summary {L,R,S} vs pitcher hand
// Returns avg multiplier across the lineup composition
function platoonMultFromSummary(handedness, pitcherHand) {
  if (!handedness || !pitcherHand) return 1.0;
  const total = (handedness.L || 0) + (handedness.R || 0) + (handedness.S || 0);
  if (!total) return 1.0;
  const lMult = PLATOON['L']?.[pitcherHand] ?? 1.0;
  const rMult = PLATOON['R']?.[pitcherHand] ?? 1.0;
  const sMult = PLATOON['S']?.[pitcherHand] ?? 1.0;
  return ((handedness.L || 0) * lMult + (handedness.R || 0) * rMult + (handedness.S || 0) * sMult) / total;
}

// Apply platoon multiplier to all batters in a lineup
function applyPlatoonToLineup(batters, handedness, pitcherHand) {
  if (!handedness || !pitcherHand) return batters;
  // If per-batter array of hands
  if (Array.isArray(handedness)) {
    return batters.map((b, i) => applyPlatoon(b, handedness[i], pitcherHand));
  }
  // If summary object {L,R,S} — apply avg multiplier to all batters
  const mult = platoonMultFromSummary(handedness, pitcherHand);
  if (Math.abs(mult - 1.0) < 0.01) return batters;
  return batters.map(b => {
    const adjusted = { ...b };
    for (const e of ['bb', 's', 'd', 't', 'hr']) adjusted[e] = (adjusted[e] || 0) * mult;
    const sum = EVENTS.reduce((a, e) => a + (adjusted[e] || 0), 0);
    for (const e of EVENTS) adjusted[e] = (adjusted[e] || 0) / sum;
    return adjusted;
  });
}

// Apply Statcast adjustments to pitcher rates
// whiffRate high = more Ks; barrelRate high = more HRs allowed; hardHitRate high = more damage
function applyStatcastToPitcher(rates, statcast) {
  if (!statcast) return rates;
  const adjusted = { ...rates };

  // Whiff rate adjustment: league avg ~25%, adjust K rate proportionally
  if (statcast.whiffRate != null) {
    const whiff = parseFloat(statcast.whiffRate);
    const leagueWhiff = 25.0;
    if (!isNaN(whiff) && whiff > 0) {
      const whiffMult = whiff / leagueWhiff;
      adjusted.k = (adjusted.k || 0) * Math.min(Math.max(whiffMult, 0.7), 1.4);
    }
  }

  // Barrel rate adjustment: league avg ~8%, adjust HR rate
  if (statcast.barrelRate != null) {
    const barrel = parseFloat(statcast.barrelRate);
    const leagueBarrel = 8.0;
    if (!isNaN(barrel) && barrel > 0) {
      const barrelMult = barrel / leagueBarrel;
      adjusted.hr = (adjusted.hr || 0) * Math.min(Math.max(barrelMult, 0.6), 1.6);
    }
  }

  // Hard hit rate adjustment: league avg ~38%, affects hits generally
  if (statcast.hardHitRate != null) {
    const hh = parseFloat(statcast.hardHitRate);
    const leagueHH = 38.0;
    if (!isNaN(hh) && hh > 0) {
      const hhMult = hh / leagueHH;
      for (const e of ['s', 'd', 't']) {
        adjusted[e] = (adjusted[e] || 0) * Math.min(Math.max(hhMult, 0.8), 1.2);
      }
    }
  }

  // Velocity trend: cold arm = worse performance (reduce K rate, increase contact)
  if (statcast.veloTrend != null) {
    const trend = parseFloat(statcast.veloTrend);
    if (!isNaN(trend) && trend < -1.5) {
      // Velocity down significantly — pitcher less effective
      const coldMult = 1 + Math.min(Math.abs(trend) * 0.02, 0.12);
      adjusted.k  = (adjusted.k  || 0) / coldMult;
      adjusted.bb = (adjusted.bb || 0) * coldMult;
      for (const e of ['s', 'd', 'hr']) adjusted[e] = (adjusted[e] || 0) * coldMult;
    }
  }

  // Renormalize
  const sum = EVENTS.reduce((a, e) => a + (adjusted[e] || 0), 0);
  for (const e of EVENTS) adjusted[e] = (adjusted[e] || 0) / sum;
  return adjusted;
}

// Estimate starter innings from available data
function estimateStarterInnings(pitcherInfo, statcast) {
  // Use pitcher's average IP per start if available
  if (pitcherInfo?.inningsPitched && pitcherInfo?.gamesStarted > 0) {
    const avgIP = parseFloat(pitcherInfo.inningsPitched) / pitcherInfo.gamesStarted;
    if (!isNaN(avgIP) && avgIP > 0) return Math.min(Math.max(avgIP, 4), 7);
  }
  // Cold arm signal = shorter outing expected
  if (statcast?.veloTrend != null && parseFloat(statcast.veloTrend) < -2) return 5;
  return 6; // default
}

// Main entry point — accepts the full context from analyze.js
async function buildMatchup({
  awayLineupIds, homeLineupIds,
  awayStarterId, homeStarterId,
  awayTeamId, homeTeamId,
  // New context params
  awayStarterHand, homeStarterHand,     // 'L' or 'R'
  awayStarterStatcast, homeStarterStatcast,  // statcast objects from fetchStatcast
  awayStarterInfo, homeStarterInfo,     // pitcher info with gamesStarted, inningsPitched
  awayLineupHandedness, homeLineupHandedness, // array of 9 batter hands or handedness summary
  parkFactors,                          // { runFactor, hrFactor } from getParkFactors
  weather,                              // weather object from fetchWeather
  ctx = {},
  totalLine = null, f5Line = null,
  season = SEASON_DEFAULT,
}) {
  // Build park + weather context multipliers
  const parkHR = parkFactors?.hrFactor ?? parkFactors?.runFactor ?? 1.0;
  const wxHR = weather?.wxHR ?? 1.0;

  // Build context object for the engine
  const baseCtx = { ...ctx, parkHR, wxHR };

  // Fetch all batter and pitcher rates in parallel
  const [awayBats, homeBats, awaySP, homeSP, awayPen, homePen] = await Promise.all([
    Promise.all(awayLineupIds.slice(0, 9).map(id => fetchBatterRates(id, season))),
    Promise.all(homeLineupIds.slice(0, 9).map(id => fetchBatterRates(id, season))),
    fetchPitcherRates(awayStarterId, season),
    fetchPitcherRates(homeStarterId, season),
    fetchBullpenRates(awayTeamId, season),
    fetchBullpenRates(homeTeamId, season),
  ]);

  // Apply Statcast adjustments to starters
  const awaySPAdj = applyStatcastToPitcher(awaySP, awayStarterStatcast);
  const homeSPAdj = applyStatcastToPitcher(homeSP, homeStarterStatcast);

  // Apply platoon splits to each batter
  // Away batters face HOME starter; Home batters face AWAY starter
  const awayBatsAdj = applyPlatoonToLineup(awayBats, awayLineupHandedness, homeStarterHand);
  const homeBatsAdj = applyPlatoonToLineup(homeBats, homeLineupHandedness, awayStarterHand);

  // Estimate starter innings
  const awayIP = estimateStarterInnings(awayStarterInfo, awayStarterStatcast);
  const homeIP = estimateStarterInnings(homeStarterInfo, homeStarterStatcast);

  return {
    away: { lineup: awayBatsAdj, starter: awaySPAdj, pen: awayPen, starterInnings: homeIP },
    home: { lineup: homeBatsAdj, starter: homeSPAdj, pen: homePen, starterInnings: awayIP },
    ctx: baseCtx, totalLine, f5Line,
  };
}

async function simulateGame(args, N = 20000) {
  return simulate(await buildMatchup(args), N);
}

module.exports = { fetchBatterRates, fetchPitcherRates, fetchBullpenRates, buildMatchup, simulateGame };
