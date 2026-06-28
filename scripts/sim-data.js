// sim-data.js — feeds run-sim.js with real, context-aware data
// REBUILT: ERA blend, bullpen fatigue, starter innings, full park run factor, arsenal, better regression

const { simulate, LEAGUE } = require('./run-sim.js');

const MLB = 'https://statsapi.mlb.com/api/v1';
const SEASON_DEFAULT = new Date().getFullYear();
const EVENTS = ['bb', 'k', 's', 'd', 't', 'hr', 'out'];

// Regression weights — tuned to be less aggressive (preserve more signal)
const REG_PA = { bb: 200, k: 100, s: 450, d: 450, t: 600, hr: 280, out: 200 };

// Non-HR hit distribution for pitchers missing doubles/triples
const NONHR_HIT_SHARE = { s: 0.735, d: 0.243, t: 0.022 };

// Platoon adjustments
const PLATOON = {
  R: { R: 0.93, L: 1.07 },
  L: { R: 1.07, L: 0.93 },
  S: { R: 1.02, L: 1.02 },
};

// League-average ERA for scaling
const LEAGUE_AVG_ERA = 4.20;

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

// IMPROVEMENT 1: ERA blend for pitcher rates
// Uses season 60% / home-away split 20% / recent 20% — same as det engine
async function fetchPitcherRates(playerId, season = SEASON_DEFAULT, isPitcherHome = null, pitcherDetail = null) {
  const cached = global._statcastCache?.pitchers?.[String(playerId)];
  const data = await getJSON(`${MLB}/people/${playerId}/stats?stats=season&group=pitching&season=${season}&sportId=1&gameType=R`);
  const seasonStat = data?.stats?.[0]?.splits?.[0]?.stat || {};
  const conv = pitchingToRates(seasonStat);
  const baseRates = conv ? { ...regressVector(conv.rates, conv.pa), pa: conv.pa } : { ...LEAGUE, pa: 0 };

  const seasonERA = parseFloat(seasonStat.era) || LEAGUE_AVG_ERA;

  // ERA blend: season 60%, split 20%, recent 20%
  if (pitcherDetail) {
    const splitERA = isPitcherHome && pitcherDetail.homeERA
      ? parseFloat(pitcherDetail.homeERA)
      : !isPitcherHome && pitcherDetail.awayERA
      ? parseFloat(pitcherDetail.awayERA)
      : seasonERA;
    const rawRecent = parseFloat(pitcherDetail.recentERA || seasonERA);
    const recentERA = Math.min(rawRecent, Math.max(seasonERA * 3.0, 9.0));
    const blendedERA = (seasonERA * 0.60) + (splitERA * 0.20) + (recentERA * 0.20);
    const eraAdj = Math.min(Math.max(blendedERA / Math.max(seasonERA, 0.1), 0.65), 1.55);

    if (Math.abs(eraAdj - 1.0) > 0.02) {
      const adjusted = { ...baseRates };
      // Higher blended ERA = more hits/walks allowed
      for (const e of ['bb', 's', 'd', 'hr']) adjusted[e] = (adjusted[e] || 0) * (0.60 + 0.40 * eraAdj);
      adjusted.k = (adjusted.k || 0) * (0.60 + 0.40 * (2 - eraAdj));
      const sum = EVENTS.reduce((a, e) => a + (adjusted[e] || 0), 0);
      for (const e of EVENTS) adjusted[e] = (adjusted[e] || 0) / sum;
      return adjusted;
    }
  }

  // Apply Statcast whiff/barrel adjustments
  if (cached) {
    return applyStatcastToPitcher(baseRates, cached);
  }

  return baseRates;
}

// IMPROVEMENT 2: Bullpen rates with fatigue adjustment
// Taxed bullpens allow more runs — scale their rates accordingly
async function fetchBullpenRates(teamId, season = SEASON_DEFAULT, bullpenObj = null) {
  // If bullpenObj passed from analyze.js, use its weightedERA to scale rates
  const data = await getJSON(`${MLB}/teams/${teamId}/roster?rosterType=active&season=${season}`);
  if (!data?.roster) {
    return { ...LEAGUE, pa: 0 };
  }

  const pitchers = data.roster.filter(p => p.position?.code === '1').slice(0, 12);
  if (!pitchers.length) return { ...LEAGUE, pa: 0 };

  const stats = await Promise.all(
    pitchers.map(p => getJSON(`${MLB}/people/${p.person.id}/stats?stats=season&group=pitching&season=${season}&sportId=1&gameType=R`))
  );

  let totalBF = 0, agg = { bb: 0, k: 0, s: 0, d: 0, t: 0, hr: 0 };
  for (const s of stats) {
    const stat = s?.stats?.[0]?.splits?.[0]?.stat;
    if (!stat) continue;
    if ((stat.gamesStarted || 0) >= 3) continue;
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
  let penRates = { ...regressVector(rates, totalBF), pa: totalBF };

  // Apply fatigue adjustment if bullpen is taxed
  if (bullpenObj) {
    const bullpenERA = parseFloat(bullpenObj.weightedERA) || LEAGUE_AVG_ERA;
    const fatigueNote = (bullpenObj.fatigueNote || '').toLowerCase();
    let fatigueAdj = 1.0;
    if (fatigueNote.includes('taxed')) fatigueAdj = 1.12;      // Taxed bullpen: 12% worse
    else if (fatigueNote.includes('heavy')) fatigueAdj = 1.20; // Heavy usage: 20% worse

    // Also adjust by ERA vs league
    const eraAdj = Math.min(Math.max(bullpenERA / LEAGUE_AVG_ERA, 0.7), 1.6);
    const totalAdj = Math.min((eraAdj + fatigueAdj - 1.0), 1.5); // combine

    if (Math.abs(totalAdj - 1.0) > 0.02) {
      const adjusted = { ...penRates };
      for (const e of ['bb', 's', 'd', 'hr']) adjusted[e] = (adjusted[e] || 0) * totalAdj;
      adjusted.k = (adjusted.k || 0) / Math.max(totalAdj, 0.7);
      const sum = EVENTS.reduce((a, e) => a + (adjusted[e] || 0), 0);
      for (const e of EVENTS) adjusted[e] = (adjusted[e] || 0) / sum;
      penRates = adjusted;
    }
  }

  return penRates;
}

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

function platoonMultFromSummary(handedness, pitcherHand) {
  if (!handedness || !pitcherHand) return 1.0;
  const total = (handedness.L || 0) + (handedness.R || 0) + (handedness.S || 0);
  if (!total) return 1.0;
  const lMult = PLATOON['L']?.[pitcherHand] ?? 1.0;
  const rMult = PLATOON['R']?.[pitcherHand] ?? 1.0;
  const sMult = PLATOON['S']?.[pitcherHand] ?? 1.0;
  return ((handedness.L || 0) * lMult + (handedness.R || 0) * rMult + (handedness.S || 0) * sMult) / total;
}

function applyPlatoonToLineup(batters, handedness, pitcherHand) {
  if (!handedness || !pitcherHand) return batters;
  if (Array.isArray(handedness)) {
    return batters.map((b, i) => applyPlatoon(b, handedness[i], pitcherHand));
  }
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

function applyStatcastToPitcher(rates, statcast) {
  if (!statcast) return rates;
  const adjusted = { ...rates };
  if (statcast.whiffRate != null) {
    const whiff = parseFloat(statcast.whiffRate);
    const leagueWhiff = 25.0;
    if (!isNaN(whiff) && whiff > 0) {
      adjusted.k = (adjusted.k || 0) * Math.min(Math.max(whiff / leagueWhiff, 0.7), 1.4);
    }
  }
  if (statcast.barrelRate != null) {
    const barrel = parseFloat(statcast.barrelRate);
    if (!isNaN(barrel) && barrel > 0) {
      adjusted.hr = (adjusted.hr || 0) * Math.min(Math.max(barrel / 8.0, 0.6), 1.6);
    }
  }
  if (statcast.hardHitRate != null) {
    const hh = parseFloat(statcast.hardHitRate);
    if (!isNaN(hh) && hh > 0) {
      const hhMult = Math.min(Math.max(hh / 38.0, 0.8), 1.2);
      for (const e of ['s', 'd', 't']) adjusted[e] = (adjusted[e] || 0) * hhMult;
    }
  }
  if (statcast.veloTrend != null) {
    const trend = parseFloat(statcast.veloTrend);
    if (!isNaN(trend) && trend < -1.5) {
      const coldMult = 1 + Math.min(Math.abs(trend) * 0.02, 0.12);
      adjusted.k  = (adjusted.k  || 0) / coldMult;
      adjusted.bb = (adjusted.bb || 0) * coldMult;
      for (const e of ['s', 'd', 'hr']) adjusted[e] = (adjusted[e] || 0) * coldMult;
    }
  }
  const sum = EVENTS.reduce((a, e) => a + (adjusted[e] || 0), 0);
  for (const e of EVENTS) adjusted[e] = (adjusted[e] || 0) / sum;
  return adjusted;
}

// IMPROVEMENT 3: Starter innings — detects bullpen games
function estimateStarterInnings(pitcherInfo, statcast) {
  let base = 5.5; // conservative default

  // Use avgIP from pitcher detail if available
  if (pitcherInfo?.avgIP) {
    const avgIP = parseFloat(pitcherInfo.avgIP);
    if (!isNaN(avgIP) && avgIP > 0) base = Math.min(Math.max(avgIP, 3.0), 7.0);
  } else if (pitcherInfo?.inningsPitched && pitcherInfo?.gamesStarted > 0) {
    const avgIP = parseFloat(pitcherInfo.inningsPitched) / pitcherInfo.gamesStarted;
    if (!isNaN(avgIP) && avgIP > 0) base = Math.min(Math.max(avgIP, 3.0), 7.0);
  }

  // Bullpen game signals — shorten expected innings
  let adj = 0;

  // Signal 1: Very low avgIP (<4.5) = opener/bullpen game pattern
  if (base < 4.5) adj -= 0.5;

  // Signal 2: High recent ERA vs season ERA = getting pulled early
  if (pitcherInfo?.recentERA && pitcherInfo?.era) {
    const recentERA = parseFloat(pitcherInfo.recentERA);
    const seasonERA = parseFloat(pitcherInfo.era);
    if (!isNaN(recentERA) && !isNaN(seasonERA) && recentERA > seasonERA * 1.5 && recentERA > 6.0) {
      adj -= 0.75; // struggling recently = shorter leash
    }
  }

  // Signal 3: Cold/declining velocity = fatigue, shorter outing
  if (statcast?.veloTrend != null) {
    const trend = parseFloat(statcast.veloTrend);
    if (!isNaN(trend)) {
      if (trend < -2.0) adj -= 1.0;      // significant velo drop
      else if (trend < -1.0) adj -= 0.5;  // moderate velo drop
    }
  }

  // Signal 4: Note field from Odds API (e.g. "game time decision", debut)
  if (pitcherInfo?.note) {
    const note = (pitcherInfo.note || '').toLowerCase();
    if (note.includes('opener') || note.includes('bullpen')) adj -= 2.0;
    if (note.includes('debut')) adj -= 0.5; // unknown quantity
  }

  return Math.min(Math.max(base + adj, 2.0), 7.0);
}

// IMPROVEMENT 4: Apply park run factor to ALL offensive outcomes, not just HR
function applyParkFactor(rates, parkRunFactor) {
  if (!parkRunFactor || Math.abs(parkRunFactor - 1.0) < 0.01) return rates;
  const adjusted = { ...rates };
  // Scale all offensive outcomes (hits, walks, HRs) by run factor
  for (const e of ['bb', 's', 'd', 't', 'hr']) {
    adjusted[e] = (adjusted[e] || 0) * parkRunFactor;
  }
  const sum = EVENTS.reduce((a, e) => a + (adjusted[e] || 0), 0);
  for (const e of EVENTS) adjusted[e] = (adjusted[e] || 0) / sum;
  return adjusted;
}

// IMPROVEMENT 5: Arsenal matchup adjustments (from sim+)
const applyArsenalToBatter = (baterRates, pitcherArsenal, batterStatcast) => {
  if (!pitcherArsenal?.arsenal || !batterStatcast?.pitchTypeStats) return baterRates;
  let kMult = 1.0, contactMult = 1.0;
  let pitchesConsidered = 0;

  for (const [pt, pitchData] of Object.entries(pitcherArsenal.arsenal)) {
    const usage = parseFloat(pitchData.pct || 0) / 100;
    if (usage < 0.10) continue;
    const batterVsPitch = batterStatcast.pitchTypeStats[pt];
    if (!batterVsPitch) continue;

    const batterWhiff = parseFloat(batterVsPitch.whiffPct || 0);
    const pitcherWhiff = parseFloat(pitchData.whiffRate || 0);
    const whiffEdge = (pitcherWhiff - batterWhiff) / 25;
    kMult += whiffEdge * usage * 0.15;

    const batterHH = parseFloat(batterVsPitch.hardHitPct || 0);
    contactMult += ((batterHH - 38) / 38) * usage * 0.10;
    pitchesConsidered++;
  }

  if (!pitchesConsidered) return baterRates;
  const adjusted = { ...baterRates };
  kMult = Math.min(Math.max(kMult, 0.80), 1.25);
  contactMult = Math.min(Math.max(contactMult, 0.85), 1.20);
  adjusted.k = (adjusted.k || 0) * kMult;
  for (const e of ['s', 'd', 't', 'hr']) adjusted[e] = (adjusted[e] || 0) * contactMult;
  const sum = EVENTS.reduce((a, e) => a + (adjusted[e] || 0), 0);
  for (const e of EVENTS) adjusted[e] = (adjusted[e] || 0) / sum;
  return adjusted;
};

async function buildMatchup({
  awayLineupIds, homeLineupIds,
  awayStarterId, homeStarterId,
  awayTeamId, homeTeamId,
  awayStarterHand, homeStarterHand,
  awayStarterStatcast, homeStarterStatcast,
  awayStarterInfo, homeStarterInfo,
  awayLineupHandedness, homeLineupHandedness,
  awayBatterStatcast, homeBatterStatcast,
  awayArsenal, homeArsenal,
  awayPitcherDetail, homePitcherDetail,
  awayBullpenObj, homeBullpenObj,
  awayTeamStats, homeTeamStats,
  awayMatchups, homeMatchups,
  gameTime, umpire,                 // day/night split + umpire run factor
  parkFactors,
  weather,
  ctx = {},
  totalLine = null, f5Line = null,
  season = SEASON_DEFAULT,
}) {
  // IMPROVEMENT 4: use runFactor for all outcomes, not just HR
  const parkRunFactor = parkFactors?.runFactor ?? 1.0;
  const parkHR = parkFactors?.hrFactor ?? parkRunFactor;
  const wxHR = weather?.wxHR ?? 1.0;
  const baseCtx = { ...ctx, parkHR, wxHR, umpRunFactor };

  // IMPROVEMENT 1: Home/away OPS split adjustments
  // Teams play differently at home vs away — use split OPS to scale batter rates
  const awayOPSSplit = awayTeamStats?.awayOPS ? parseFloat(awayTeamStats.awayOPS) : null;
  const homeOPSSplit = homeTeamStats?.homeOPS ? parseFloat(homeTeamStats.homeOPS) : null;
  const awaySeasonOPS = awayTeamStats?.ops ? parseFloat(awayTeamStats.ops) : null;
  const homeSeasonOPS = homeTeamStats?.ops ? parseFloat(homeTeamStats.ops) : null;
  // Scale factor vs season avg OPS (capped at ±15%)
  const awaySplitMult = (awayOPSSplit && awaySeasonOPS && awaySeasonOPS > 0)
    ? Math.min(Math.max(awayOPSSplit / awaySeasonOPS, 0.85), 1.15) : 1.0;
  const homeSplitMult = (homeOPSSplit && homeSeasonOPS && homeSeasonOPS > 0)
    ? Math.min(Math.max(homeOPSSplit / homeSeasonOPS, 0.85), 1.15) : 1.0;

  // IMPROVEMENT 4: Recent form (last10 W-L) — struggling teams get slight offensive penalty
  function formMult(last10) {
    if (!last10) return 1.0;
    const [w, g] = last10.split('-').map(Number);
    if (isNaN(w) || isNaN(g) || g === 0) return 1.0;
    const winPct = w / g;
    if (winPct <= 0.20) return 0.94;  // 2-8 or worse
    if (winPct <= 0.30) return 0.97;  // 3-7
    if (winPct >= 0.80) return 1.04;  // 8-2 or better
    if (winPct >= 0.70) return 1.02;  // 7-3
    return 1.0;
  }
  const awayFormMult = formMult(awayTeamStats?.last10);
  const homeFormMult = formMult(homeTeamStats?.last10);

  // Day/night hitter split
  function dnHitterMult(teamStats, gameTime) {
    if (!teamStats || !gameTime) return 1.0;
    const hour = new Date(gameTime).getUTCHours() - 4;
    const isDay = hour < 17;
    const splitOPS = isDay ? parseFloat(teamStats.dayOPS || 0) : parseFloat(teamStats.nightOPS || 0);
    const seasonOPS = parseFloat(teamStats.ops || 0);
    if (!splitOPS || !seasonOPS) return 1.0;
    return Math.min(Math.max(splitOPS / seasonOPS, 0.88), 1.12);
  }
  const awayDNMult = dnHitterMult(awayTeamStats, gameTime);
  const homeDNMult = dnHitterMult(homeTeamStats, gameTime);

  // RISP adjustment — clutch hitting ability
  function ruspMult(teamStats) {
    if (!teamStats?.ruspOPS) return 1.0;
    const ruspOPS = parseFloat(teamStats.ruspOPS);
    const seasonOPS = parseFloat(teamStats.ops || 0.720);
    if (isNaN(ruspOPS) || ruspOPS <= 0) return 1.0;
    return Math.min(Math.max(ruspOPS / seasonOPS, 0.90), 1.10);
  }
  const awayRuspMult = ruspMult(awayTeamStats);
  const homeRuspMult = ruspMult(homeTeamStats);

  // Umpire run factor
  const umpRunFactor = umpire?.runFactor ?? 1.0;

  // IMPROVEMENT 3: Closer unavailability — if closer is LIKELY UNAVAILABLE, inflate bullpen ERA
  function bullpenCloserAdj(bullpenObj) {
    if (!bullpenObj) return 1.0;
    const closerInfo = (bullpenObj.closerInfo || '').toUpperCase();
    if (closerInfo.includes('LIKELY UNAVAILABLE')) return 1.15;
    if (closerInfo.includes('QUESTIONABLE')) return 1.06;
    return 1.0;
  }
  const awayCloserAdj = bullpenCloserAdj(awayBullpenObj);
  const homeCloserAdj = bullpenCloserAdj(homeBullpenObj);

  const [awayBats, homeBats, awaySP, homeSP, awayPen, homePen] = await Promise.all([
    Promise.all(awayLineupIds.slice(0, 9).map(id => fetchBatterRates(id, season))),
    Promise.all(homeLineupIds.slice(0, 9).map(id => fetchBatterRates(id, season))),
    fetchPitcherRates(awayStarterId, season, false, awayPitcherDetail),
    fetchPitcherRates(homeStarterId, season, true,  homePitcherDetail),
    fetchBullpenRates(awayTeamId, season, awayBullpenObj),   // IMPROVEMENT 2
    fetchBullpenRates(homeTeamId, season, homeBullpenObj),   // IMPROVEMENT 2
  ]);

  let awaySPAdj = applyStatcastToPitcher(awaySP, awayStarterStatcast);
  let homeSPAdj = applyStatcastToPitcher(homeSP, homeStarterStatcast);

  // Day/night pitcher ERA scaling
  function applyDNPitcher(rates, pitcherDetail, gameTime) {
    if (!pitcherDetail || !gameTime) return rates;
    const hour = new Date(gameTime).getUTCHours() - 4;
    const isDay = hour < 17;
    const splitERA = parseFloat(isDay ? (pitcherDetail.dayERA||0) : (pitcherDetail.nightERA||0));
    const seasonERA = parseFloat(pitcherDetail.era || LEAGUE_AVG_ERA);
    if (!splitERA || !seasonERA) return rates;
    const dnAdj = Math.min(Math.max(splitERA / seasonERA, 0.80), 1.25);
    if (Math.abs(dnAdj - 1.0) < 0.02) return rates;
    const adj = { ...rates };
    for (const e of ['bb','s','d','hr']) adj[e] = (adj[e]||0) * dnAdj;
    adj.k = (adj.k||0) / Math.max(dnAdj, 0.75);
    const sum = EVENTS.reduce((a,e) => a + (adj[e]||0), 0);
    for (const e of EVENTS) adj[e] = (adj[e]||0) / sum;
    return adj;
  }
  awaySPAdj = applyDNPitcher(awaySPAdj, awayStarterInfo, gameTime);
  homeSPAdj = applyDNPitcher(homeSPAdj, homeStarterInfo, gameTime);

  // Last start pitch count — shorten starter innings
  function applyPitchCountToIP(ip, pitcherDetail) {
    if (!pitcherDetail?.lastStartPitches) return ip;
    const pc = parseInt(pitcherDetail.lastStartPitches);
    if (isNaN(pc)) return ip;
    if (pc >= 115) return Math.max(ip - 0.5, 2.0);
    if (pc >= 100) return Math.max(ip - 0.25, 2.0);
    return ip;
  }

  // Apply platoon + arsenal to batters
  const awayBatsAdj = applyPlatoonToLineup(awayBats, awayLineupHandedness, homeStarterHand)
    .map((b, i) => applyArsenalToBatter(b, homeArsenal, awayBatterStatcast?.[i]));
  const homeBatsAdj = applyPlatoonToLineup(homeBats, homeLineupHandedness, awayStarterHand)
    .map((b, i) => applyArsenalToBatter(b, awayArsenal, homeBatterStatcast?.[i]));

  // IMPROVEMENT 2: Lineup matchup quality vs this specific pitcher
  function applyMatchupAdj(rates, matchups) {
    if (!matchups || matchups.meaningful < 3) return rates;
    const mOPS = parseFloat(matchups.avgOPS || 0);
    const leagueOPS = 0.720;
    if (isNaN(mOPS) || mOPS <= 0) return rates;
    const mult = Math.min(Math.max(1 + ((mOPS - leagueOPS) / leagueOPS) * 0.12, 0.88), 1.14);
    if (Math.abs(mult - 1.0) < 0.01) return rates;
    return rates.map(b => {
      const adj = { ...b };
      for (const e of ['bb','s','d','t','hr']) adj[e] = (adj[e]||0) * mult;
      const sum = EVENTS.reduce((a,e) => a + (adj[e]||0), 0);
      for (const e of EVENTS) adj[e] = (adj[e]||0) / sum;
      return adj;
    });
  }

  // Apply matchup, split, and form adjustments
  function applyTeamAdj(rates, splitMult, formMult) {
    if (Math.abs(splitMult - 1.0) < 0.01 && Math.abs(formMult - 1.0) < 0.01) return rates;
    const combined = splitMult * formMult;
    return rates.map(b => {
      const adj = { ...b };
      for (const e of ['bb','s','d','t','hr']) adj[e] = (adj[e]||0) * combined;
      const sum = EVENTS.reduce((a,e) => a + (adj[e]||0), 0);
      for (const e of EVENTS) adj[e] = (adj[e]||0) / sum;
      return adj;
    });
  }

  // IMPROVEMENT 4: Apply park run factor to batters
  const awayBatsPark = parkRunFactor !== 1.0 ? awayBatsAdj.map(b => applyParkFactor(b, parkRunFactor)) : awayBatsAdj;
  const homeBatsPark = parkRunFactor !== 1.0 ? homeBatsAdj.map(b => applyParkFactor(b, parkRunFactor)) : homeBatsAdj;

  // Apply matchup quality vs starter
  const awayBatsMatchup = applyMatchupAdj(awayBatsPark, awayMatchups);
  const homeBatsMatchup = applyMatchupAdj(homeBatsPark, homeMatchups);

  // Apply home/away OPS split + recent form + day/night + RISP
  function applyAllTeamAdj(rates, splitMult, formMult, dnMult, ruspMult) {
    const combined = splitMult * formMult * dnMult * ruspMult;
    if (Math.abs(combined - 1.0) < 0.01) return rates;
    return rates.map(b => {
      const adj = { ...b };
      for (const e of ['bb','s','d','t','hr']) adj[e] = (adj[e]||0) * combined;
      const sum = EVENTS.reduce((a,e) => a + (adj[e]||0), 0);
      for (const e of EVENTS) adj[e] = (adj[e]||0) / sum;
      return adj;
    });
  }
  const awayBatsFinal = applyAllTeamAdj(awayBatsMatchup, awaySplitMult, awayFormMult, awayDNMult, awayRuspMult);
  const homeBatsFinal = applyAllTeamAdj(homeBatsMatchup, homeSplitMult, homeFormMult, homeDNMult, homeRuspMult);

  // IMPROVEMENT 3: Estimate starter innings from real data
  const awayIP = applyPitchCountToIP(estimateStarterInnings(awayStarterInfo, awayStarterStatcast), awayStarterInfo);
  const homeIP = applyPitchCountToIP(estimateStarterInnings(homeStarterInfo, homeStarterStatcast), homeStarterInfo);

  // IMPROVEMENT 3: Apply closer unavailability to bullpen rates
  function applyCloserAdj(penRates, closerAdj) {
    if (Math.abs(closerAdj - 1.0) < 0.01) return penRates;
    const adj = { ...penRates };
    for (const e of ['bb','s','d','hr']) adj[e] = (adj[e]||0) * closerAdj;
    adj.k = (adj.k||0) / Math.max(closerAdj, 0.7);
    const sum = EVENTS.reduce((a,e) => a + (adj[e]||0), 0);
    for (const e of EVENTS) adj[e] = (adj[e]||0) / sum;
    return adj;
  }
  const awayPenFinal = applyCloserAdj(awayPen, awayCloserAdj);
  const homePenFinal = applyCloserAdj(homePen, homeCloserAdj);

  return {
    away: { lineup: awayBatsFinal, starter: awaySPAdj, pen: awayPenFinal, starterInnings: homeIP },
    home: { lineup: homeBatsFinal, starter: homeSPAdj, pen: homePenFinal, starterInnings: awayIP },
    ctx: baseCtx, totalLine, f5Line,
  };
}

async function simulateGame(args, N = 20000) {
  return simulate(await buildMatchup(args), N);
}

module.exports = { fetchBatterRates, fetchPitcherRates, fetchBullpenRates, buildMatchup, simulateGame };
