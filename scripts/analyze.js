#!/usr/bin/env node

const ODDS_API_KEY = process.env.ODDS_API_KEY;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const WEATHER_API_KEY = process.env.WEATHER_API_KEY;
const RUN_TYPE = process.env.RUN_TYPE || '11am';

const PREFERRED_BOOKS = ['draftkings','fanduel','betmgm','caesars','betrivers','pointsbetus','williamhill_us'];
const STALE_MIN = 30;
const REFRESH_WINDOW_MIN = 30;
const { simulateGame } = require('./sim-data.js');
const TOTAL_SD = 5.5;
const MARGIN_SD = 4.0;
const SHADOW_STRENGTH = 0.35;
const VERDICT_BET = 10;
const VERDICT_LEAN = 6;
const MAXJUICE_EV = VERDICT_LEAN;
const SWEEP_FADE_UNTIL = '2026-08-01';

const PARK_COORDS = {
  'Arizona Diamondbacks': { lat: 33.4453, lon: -112.0667, dome: true },
  'Atlanta Braves': { lat: 33.8908, lon: -84.4681, dome: false, homeplateFacing: 15 },
  'Baltimore Orioles': { lat: 39.2838, lon: -76.6218, dome: false, homeplateFacing: 95 },
  'Boston Red Sox': { lat: 42.3467, lon: -71.0972, dome: false, homeplateFacing: 95 },
  'Chicago Cubs': { lat: 41.9484, lon: -87.6553, dome: false, homeplateFacing: 140 },
  'Chicago White Sox': { lat: 41.8300, lon: -87.6339, dome: false, homeplateFacing: 135 },
  'Cincinnati Reds': { lat: 39.0979, lon: -84.5082, dome: false, homeplateFacing: 0 },
  'Cleveland Guardians': { lat: 41.4962, lon: -81.6852, dome: false, homeplateFacing: 150 },
  'Colorado Rockies': { lat: 39.7559, lon: -104.9942, dome: false, homeplateFacing: 20 },
  'Detroit Tigers': { lat: 42.3390, lon: -83.0485, dome: false, homeplateFacing: 170 },
  'Houston Astros': { lat: 29.7573, lon: -95.3555, dome: true },
  'Kansas City Royals': { lat: 39.0517, lon: -94.4803, dome: false, homeplateFacing: 5 },
  'Los Angeles Angels': { lat: 33.8003, lon: -117.8827, dome: false, homeplateFacing: 180 },
  'Los Angeles Dodgers': { lat: 34.0739, lon: -118.2400, dome: false, homeplateFacing: 335 },
  'Miami Marlins': { lat: 25.7781, lon: -80.2197, dome: true },
  'Milwaukee Brewers': { lat: 43.0280, lon: -87.9712, dome: true },
  'Minnesota Twins': { lat: 44.9817, lon: -93.2777, dome: false, homeplateFacing: 100 },
  'New York Mets': { lat: 40.7571, lon: -73.8458, dome: false, homeplateFacing: 335 },
  'New York Yankees': { lat: 40.8296, lon: -73.9262, dome: false, homeplateFacing: 325 },
  'Athletics': { lat: 38.5803, lon: -121.5135, dome: false, homeplateFacing: 30 },
  'Philadelphia Phillies': { lat: 39.9061, lon: -75.1665, dome: false, homeplateFacing: 340 },
  'Pittsburgh Pirates': { lat: 40.4469, lon: -80.0057, dome: false, homeplateFacing: 30 },
  'San Diego Padres': { lat: 32.7076, lon: -117.1570, dome: false, homeplateFacing: 300 },
  'San Francisco Giants': { lat: 37.7786, lon: -122.3893, dome: false, homeplateFacing: 30 },
  'Seattle Mariners': { lat: 47.5914, lon: -122.3325, dome: true },
  'St. Louis Cardinals': { lat: 38.6226, lon: -90.1928, dome: false, homeplateFacing: 108 },
  'Tampa Bay Rays': { lat: 27.7683, lon: -82.6534, dome: true },
  'Texas Rangers': { lat: 32.7473, lon: -97.0845, dome: true },
  'Toronto Blue Jays': { lat: 43.6414, lon: -79.3894, dome: true },
  'Washington Nationals': { lat: 38.8730, lon: -77.0074, dome: false, homeplateFacing: 80 }
};

const PARK_FACTORS = {
  'Arizona Diamondbacks': { runFactor: 1.03, windFactor: 0,    shadowSusc: 0,    retractable: true  },
  'Atlanta Braves':       { runFactor: 1.02, windFactor: 1.0,  shadowSusc: 0.40, retractable: false },
  'Baltimore Orioles':    { runFactor: 0.99, windFactor: 1.05, shadowSusc: 0.40, retractable: false },
  'Boston Red Sox':       { runFactor: 1.04, windFactor: 1.0,  shadowSusc: 0.45, retractable: false },
  'Chicago Cubs':         { runFactor: 1.00, windFactor: 1.5,  shadowSusc: 0.50, retractable: false },
  'Chicago White Sox':    { runFactor: 1.01, windFactor: 1.1,  shadowSusc: 0.40, retractable: false },
  'Cincinnati Reds':      { runFactor: 1.06, windFactor: 1.0,  shadowSusc: 0.40, retractable: false },
  'Cleveland Guardians':  { runFactor: 0.98, windFactor: 1.0,  shadowSusc: 0.40, retractable: false },
  'Colorado Rockies':     { runFactor: 1.15, windFactor: 1.1,  shadowSusc: 0.45, retractable: false },
  'Detroit Tigers':       { runFactor: 0.97, windFactor: 0.9,  shadowSusc: 0.40, retractable: false },
  'Houston Astros':       { runFactor: 1.00, windFactor: 0,    shadowSusc: 0,    retractable: true  },
  'Kansas City Royals':   { runFactor: 0.99, windFactor: 1.0,  shadowSusc: 0.40, retractable: false },
  'Los Angeles Angels':   { runFactor: 0.98, windFactor: 0.95, shadowSusc: 0.40, retractable: false },
  'Los Angeles Dodgers':  { runFactor: 0.99, windFactor: 0.95, shadowSusc: 0.60, retractable: false },
  'Miami Marlins':        { runFactor: 0.97, windFactor: 0,    shadowSusc: 0,    retractable: true  },
  'Milwaukee Brewers':    { runFactor: 1.00, windFactor: 0,    shadowSusc: 0,    retractable: true  },
  'Minnesota Twins':      { runFactor: 0.99, windFactor: 1.0,  shadowSusc: 0.40, retractable: false },
  'New York Mets':        { runFactor: 0.96, windFactor: 1.0,  shadowSusc: 0.40, retractable: false },
  'New York Yankees':     { runFactor: 1.03, windFactor: 1.1,  shadowSusc: 0.45, retractable: false },
  'Athletics':            { runFactor: 1.09, windFactor: 1.0,  shadowSusc: 0.40, retractable: false },
  'Philadelphia Phillies':{ runFactor: 1.03, windFactor: 1.0,  shadowSusc: 0.40, retractable: false },
  'Pittsburgh Pirates':   { runFactor: 0.97, windFactor: 0.95, shadowSusc: 0.40, retractable: false },
  'San Diego Padres':     { runFactor: 0.94, windFactor: 0.95, shadowSusc: 0.45, retractable: false },
  'San Francisco Giants': { runFactor: 0.92, windFactor: 1.15, shadowSusc: 0.80, retractable: false },
  'Seattle Mariners':     { runFactor: 0.94, windFactor: 0,    shadowSusc: 0,    retractable: true  },
  'St. Louis Cardinals':  { runFactor: 0.99, windFactor: 1.0,  shadowSusc: 0.40, retractable: false },
  'Tampa Bay Rays':       { runFactor: 0.97, windFactor: 0,    shadowSusc: 0,    retractable: false },
  'Texas Rangers':        { runFactor: 1.00, windFactor: 0,    shadowSusc: 0,    retractable: true  },
  'Toronto Blue Jays':    { runFactor: 1.00, windFactor: 0,    shadowSusc: 0,    retractable: true  },
  'Washington Nationals': { runFactor: 1.00, windFactor: 1.0,  shadowSusc: 0.40, retractable: false }
};

const VENUE_PARKS = {
  'Las Vegas Ballpark': { lat: 36.1568, lon: -115.3289, dome: false, homeplateFacing: 30, runFactor: 1.12, windFactor: 1.05, shadowSusc: 0.40, retractable: false },
  'Sutter Health Park': { lat: 38.5803, lon: -121.5135, dome: false, homeplateFacing: 30, runFactor: 1.09, windFactor: 1.00, shadowSusc: 0.40, retractable: false }
};

function lookupCoords(team, venue) {
  if (venue && VENUE_PARKS[venue]) { const v = VENUE_PARKS[venue]; return { lat: v.lat, lon: v.lon, dome: v.dome, homeplateFacing: v.homeplateFacing }; }
  let park = PARK_COORDS[team];
  if (!park) { const key = Object.keys(PARK_COORDS).find(k => k.includes(team.split(' ').pop()) || team.includes(k.split(' ').pop())); if (key) park = PARK_COORDS[key]; }
  return park || null;
}

function getParkFactors(team, venue) {
  if (venue && VENUE_PARKS[venue]) { const v = VENUE_PARKS[venue]; return { runFactor: v.runFactor, windFactor: v.windFactor, shadowSusc: v.shadowSusc, retractable: v.retractable }; }
  let f = PARK_FACTORS[team];
  if (!f) { const key = Object.keys(PARK_FACTORS).find(k => k.includes(team.split(' ').pop()) || team.includes(k.split(' ').pop())); if (key) f = PARK_FACTORS[key]; }
  return f || { runFactor: 1.0, windFactor: 1.0, shadowSusc: 0.4, retractable: false };
}

function solarPosition(lat, lon, date) {
  const rad = Math.PI / 180, deg = 180 / Math.PI;
  const jd = date.getTime() / 86400000 + 2440587.5;
  const n = jd - 2451545.0;
  const L = (((280.460 + 0.9856474 * n) % 360) + 360) % 360;
  const g = ((((357.528 + 0.9856003 * n) % 360) + 360) % 360) * rad;
  const lambda = (L + 1.915 * Math.sin(g) + 0.020 * Math.sin(2 * g)) * rad;
  const epsilon = (23.439 - 0.0000004 * n) * rad;
  const decl = Math.asin(Math.sin(epsilon) * Math.sin(lambda));
  const RA = Math.atan2(Math.cos(epsilon) * Math.sin(lambda), Math.cos(lambda));
  const gmst = (((280.46061837 + 360.98564736629 * n) % 360) + 360) % 360;
  const lst = (gmst + lon) * rad;
  const ha = lst - RA;
  const latR = lat * rad;
  const elevation = Math.asin(Math.sin(latR) * Math.sin(decl) + Math.cos(latR) * Math.cos(decl) * Math.cos(ha)) * deg;
  let az = Math.atan2(-Math.sin(ha), Math.tan(decl) * Math.cos(latR) - Math.sin(latR) * Math.cos(ha)) * deg;
  az = (az + 360) % 360;
  return { elevation, azimuth: az };
}

function shadowProfile(homeTeam, gameTime, venue) {
  try {
    const park = lookupCoords(homeTeam, venue);
    const pf = getParkFactors(homeTeam, venue);
    if (!park || park.dome) return null;
    const susc = pf.shadowSusc || 0;
    if (susc <= 0) return null;
    const start = new Date(gameTime);
    const sun0 = solarPosition(park.lat, park.lon, start);
    if (sun0.elevation < 25) return null;
    const sun5 = solarPosition(park.lat, park.lon, new Date(start.getTime() + 90 * 60000));
    const sun8 = solarPosition(park.lat, park.lon, new Date(start.getTime() + 165 * 60000));
    if (sun8.elevation < 10) return null;
    const lateEl = sun8.elevation;
    let band;
    if (lateEl >= 15 && lateEl <= 45) band = 1;
    else if (lateEl < 15) band = 0.4;
    else if (lateEl <= 60) band = 0.5;
    else band = 0.2;
    const strength = SHADOW_STRENGTH * susc * band;
    if (strength < 0.02) return null;
    const earlyRuns = +(strength * 0.6).toFixed(2);
    const lateRuns = -+(strength * 0.9).toFixed(2);
    return { isDay: true, sun: { start: +sun0.elevation.toFixed(0), mid: +sun5.elevation.toFixed(0), late: +sun8.elevation.toFixed(0) }, earlyRuns, lateRuns, note: `Day game, sun ${sun0.elevation.toFixed(0)}deg->${sun8.elevation.toFixed(0)}deg (park shadow susc ${susc}). Mild front-load: F5 ~+${earlyRuns} run, innings 6-9 ~${lateRuns} run. APPROXIMATE.` };
  } catch(e) { return null; }
}

function payoutMult(odds) { const n = parseFloat(odds); if (isNaN(n)) return null; return n > 0 ? n / 100 : 100 / Math.abs(n); }
function evPct(p, odds) { const b = payoutMult(odds); if (b == null || !(p > 0)) return null; return +((p * b - (1 - p)) * 100).toFixed(1); }
function breakevenOdds(p, targetEvPct) { if (!(p > 0) || !(p < 1)) return null; const t = (targetEvPct == null ? MAXJUICE_EV : targetEvPct) / 100; const b = (t + 1 - p) / p; if (!(b > 0)) return null; const o = b >= 1 ? b * 100 : -100 / b; const r = Math.round(o); return r > 0 ? `+${r}` : `${r}`; }
function totalsProbOver(line, proj) { if (!(proj > 0)) return null; const z = (parseFloat(line) - proj) / TOTAL_SD; return 1 / (1 + Math.exp(1.7 * z)); }
function buildJuiceTable(proj, direction, steps) { steps = steps || 5; const half = Math.floor(steps / 2); const lines = []; for (let i = -half; i <= half; i++) { const line = +(Math.round((proj + i * 0.5) * 2) / 2).toFixed(1); const pOver = totalsProbOver(line, proj); const p = direction === 'Over' ? pOver : 1 - pOver; const be = breakevenOdds(p); lines.push({ line, direction, maxJuice: be != null ? parseInt(be, 10) : null, ev: evPct(p, -110) }); } return { description: 'max juice at each line where the bet still clears the 6% EV gate (derived from projection)', lines }; }
function pickSide(opts) { let best = null; for (const o of opts) { if (o.ev == null || isNaN(o.ev)) continue; if (!best || o.ev > best.ev) best = o; } return best; }
function verdictFor(ev, sideLabel) { if (ev == null || isNaN(ev) || ev < VERDICT_LEAN) return 'SKIP'; return `${ev >= VERDICT_BET ? 'BET' : 'LEAN'} ${sideLabel}`; }

function deriveNumbers(a, lines, f5Lines, sweepSide, dateStr) {
  if (!a) return a;
  const pAway = (a.mlAwayProb != null ? a.mlAwayProb : (a.awayWinPct != null ? a.awayWinPct : 50)) / 100;
  const pHome = (a.mlHomeProb != null ? a.mlHomeProb : (a.homeWinPct != null ? a.homeWinPct : 50)) / 100;
  { const side = pickSide([{ ev: evPct(pAway, lines.awayML), label: 'AWAY', p: pAway }, { ev: evPct(pHome, lines.homeML), label: 'HOME', p: pHome }]); if (side) { a.mlEV = side.ev; a.mlBreakeven = breakevenOdds(side.p); a.ml = verdictFor(side.ev, side.label); } else { a.ml = 'SKIP'; } }
  const pAwayRL = a.rlAwayProb != null ? a.rlAwayProb / 100 : Math.max(0.02, pAway - 0.08);
  const pHomeRL = a.rlHomeProb != null ? a.rlHomeProb / 100 : Math.min(0.98, pHome + 0.08);
  { const side = pickSide([{ ev: evPct(pAwayRL, lines.awayRLOdds), label: 'AWAY', p: pAwayRL }, { ev: evPct(pHomeRL, lines.homeRLOdds), label: 'HOME', p: pHomeRL }]); if (side) { a.rlEV = side.ev; a.rlBreakeven = breakevenOdds(side.p); a.rl = verdictFor(side.ev, side.label); } else { a.rl = 'SKIP'; } }
  if (sweepSide && (!dateStr || dateStr < SWEEP_FADE_UNTIL)) {
    const faded = [];
    for (const mkt of ['ml', 'rl']) { const v = a[mkt]; if (typeof v === 'string' && v !== 'SKIP' && v.endsWith(` ${sweepSide}`)) { faded.push(`${mkt.toUpperCase()} ${v}`); a[mkt] = 'SKIP'; } }
    if (faded.length) a.sweepFade = `sweep fade (${sweepSide} in position to sweep) — stood down: ${faded.join(', ')}`;
  }
  const proj = parseFloat(a.projTotal);
  const postedTotal = parseFloat(a.totalLine != null ? a.totalLine : lines.total);
  if (proj > 0 && !isNaN(postedTotal)) {
    a.totalLine = postedTotal;
    const pOver = totalsProbOver(postedTotal, proj);
    const side = pickSide([{ ev: evPct(pOver, lines.overOdds), label: 'OVER', p: pOver, dir: 'Over' }, { ev: evPct(1 - pOver, lines.underOdds), label: 'UNDER', p: 1 - pOver, dir: 'Under' }]);
    if (side) { a.totalEV = side.ev; const be = breakevenOdds(side.p); a.totalBreakeven = be ? `${side.dir} ${postedTotal} @ ${be}` : null; a.totalJuiceSensitivity = buildJuiceTable(proj, side.dir); a.total = verdictFor(side.ev, side.label); }
    else { a.total = 'SKIP'; }
  } else { a.total = 'SKIP'; }
  const f5proj = parseFloat(a.f5ProjTotal);
  const f5line = parseFloat(a.f5Line != null ? a.f5Line : (f5Lines && f5Lines.f5Total));
  { const opts = []; if (f5proj > 0 && !isNaN(f5line)) { const pO = totalsProbOver(f5line, f5proj); opts.push({ ev: evPct(pO, f5Lines && f5Lines.f5OverOdds), label: 'OVER', p: pO, dir: 'Over' }); opts.push({ ev: evPct(1 - pO, f5Lines && f5Lines.f5UnderOdds), label: 'UNDER', p: 1 - pO, dir: 'Under' }); } opts.push({ ev: evPct(pAway, f5Lines && f5Lines.f5AwayML), label: 'AWAY' }); opts.push({ ev: evPct(pHome, f5Lines && f5Lines.f5HomeML), label: 'HOME' }); const side = pickSide(opts); if (side) { a.f5EV = side.ev; if (side.dir) { const be = breakevenOdds(side.p); a.f5Breakeven = be ? `${side.dir} ${f5line} @ ${be}` : null; a.f5JuiceSensitivity = buildJuiceTable(f5proj, side.dir, 3); } a.f5 = verdictFor(side.ev, side.label); } else { a.f5 = 'SKIP'; } }
  const evByMarket = { ml: a.mlEV, rl: a.rlEV, total: a.totalEV, f5: a.f5EV };
  let bestMkt = null, bestEv = -Infinity;
  for (const k of ['ml','rl','total','f5']) { if (a[k] === 'SKIP') continue; const e = evByMarket[k]; if (e != null && !isNaN(e) && e > bestEv) { bestEv = e; bestMkt = k; } }
  a.best = (bestMkt && bestEv >= VERDICT_LEAN) ? bestMkt : null;
  if (a.best) a.edgePct = evByMarket[a.best];
  return a;
}

function normCdf(x) { const t = 1 / (1 + 0.2316419 * Math.abs(x)); const d = 0.3989423 * Math.exp(-x * x / 2); const p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274)))); return x > 0 ? 1 - p : p; }

function deriveRunModel(a, lines) {
  if (!a) return a;
  const la = Math.max(3.0, parseFloat(a.projAwayRuns));
  const lb = Math.max(3.0, parseFloat(a.projHomeRuns));
  a.projAwayRuns = la; a.projHomeRuns = lb;
  if (!(la >= 0) || !(lb >= 0)) return a;
  const mu = la - lb;
  const pAwayRaw = 1 - normCdf((0.5 - mu) / MARGIN_SD);
  const pHomeRaw = normCdf((-0.5 - mu) / MARGIN_SD);
  const denom = (pAwayRaw + pHomeRaw) || 1;
  a.mlAwayProb = +((pAwayRaw / denom) * 100).toFixed(1);
  a.mlHomeProb = +((pHomeRaw / denom) * 100).toFixed(1);
  a.awayWinPct = a.mlAwayProb; a.homeWinPct = a.mlHomeProb;
  let awayRLpt = parseFloat(lines && lines.awayRL);
  let homeRLpt = parseFloat(lines && lines.homeRL);
  if (isNaN(awayRLpt)) awayRLpt = mu > 0 ? -1.5 : 1.5;
  if (isNaN(homeRLpt)) homeRLpt = mu > 0 ? 1.5 : -1.5;
  a.rlAwayProb = +((1 - normCdf((-awayRLpt - mu) / MARGIN_SD)) * 100).toFixed(1);
  a.rlHomeProb = +(normCdf((homeRLpt - mu) / MARGIN_SD) * 100).toFixed(1);
  if (a.projTotal == null || isNaN(parseFloat(a.projTotal))) a.projTotal = +(la + lb).toFixed(1);
  return a;
}

// ── DETERMINISTIC ENGINE (background only — never shown to LLM) ──────────────
const LEAGUE_AVG_ERA = 4.20;
const LEAGUE_AVG_OPS = 0.720;

function computeOffenseFactor(teamStats, lineupMatchups, isHome) {
  if (!teamStats) return 1.0;
  let teamOPS;
  if (isHome && teamStats.homeOPS) teamOPS = parseFloat(teamStats.homeOPS);
  else if (!isHome && teamStats.awayOPS) teamOPS = parseFloat(teamStats.awayOPS);
  else teamOPS = parseFloat(teamStats.ops || LEAGUE_AVG_OPS);
  let opsFactor = teamOPS / LEAGUE_AVG_OPS;
  if (lineupMatchups?.avgOPS) { const matchupOPS = parseFloat(lineupMatchups.avgOPS); opsFactor = ((matchupOPS * 0.50) + (teamOPS * 0.50)) / LEAGUE_AVG_OPS; }
  if (lineupMatchups?.kRate) { const kAdj = 1 - ((parseFloat(lineupMatchups.kRate) - 22.0) * 0.004); opsFactor *= Math.min(Math.max(kAdj, 0.90), 1.10); }
  return Math.min(Math.max(opsFactor, 0.55), 1.55);
}

function computeWeatherRunFactor(weather, parkFactors) {
  if (!weather || weather.dome || parkFactors?.dome) return 1.0;
  let mult = 1.0;
  const temp = weather.temp || 72, effWind = weather.effWind || 0, flags = weather.flags || [];
  if (temp >= 90) mult *= 1.05; else if (temp >= 80) mult *= 1.02; else if (temp <= 50) mult *= 0.95; else if (temp <= 40) mult *= 0.90;
  if (flags.some(f => (f||''). includes('OUT'))) mult *= 1 + Math.min(effWind * 0.006, 0.12);
  else if (flags.some(f => (f||'').includes('IN'))) mult *= 1 - Math.min(effWind * 0.005, 0.10);
  return Math.min(Math.max(mult, 0.88), 1.18);
}

function computePlatoonRunFactor(pitcherHand, lineupHandedness) {
  if (!pitcherHand || !lineupHandedness) return 1.0;
  const { L = 0, R = 0 } = lineupHandedness;
  const total = L + R + (lineupHandedness.S || 0);
  if (!total) return 1.0;
  const samePct = pitcherHand === 'R' ? R / total : L / total;
  const oppPct = pitcherHand === 'R' ? L / total : R / total;
  return Math.min(Math.max(1.0 - (samePct * 0.03) + (oppPct * 0.03), 0.94), 1.06);
}

function projectRuns({ offenseStats, offenseMatchups, offenseHandedness, isOffenseHome, defPitcher, defStatcast, defPitcherHand, isPitcherHome, defBullpen, parkFactors, weather }) {
  const avgIP = parseFloat(defPitcher?.avgIP || 6.0);
  const starterERA = (() => {
    if (!defPitcher) return LEAGUE_AVG_ERA;
    const seasonERA = parseFloat(defPitcher.era || LEAGUE_AVG_ERA);
    const rawRecent = parseFloat(defPitcher.recentERA || seasonERA);
    const recentERA = Math.min(rawRecent, Math.max(seasonERA * 3.0, 9.0));
    const splitERA = isPitcherHome && defPitcher.homeERA ? parseFloat(defPitcher.homeERA) : !isPitcherHome && defPitcher.awayERA ? parseFloat(defPitcher.awayERA) : seasonERA;
    return (seasonERA * 0.60) + (splitERA * 0.20) + (recentERA * 0.20);
  })();
  const starterRuns = (starterERA / 9) * avgIP;
  const bullpenIP = Math.max(0, 9 - avgIP);
  const bullpenERA = parseFloat(defBullpen?.weightedERA || LEAGUE_AVG_ERA);
  const bullpenRuns = (bullpenERA / 9) * bullpenIP;
  const baselineRuns = starterRuns + bullpenRuns;
  const of_ = computeOffenseFactor(offenseStats, offenseMatchups, isOffenseHome);
  const park = parseFloat(parkFactors?.runFactor || 1.0);
  const wx = computeWeatherRunFactor(weather, parkFactors);
  const plat = computePlatoonRunFactor(defPitcherHand, offenseHandedness);
  let statcastAdj = 1.0;
  if (defStatcast) {
    if (defStatcast.whiffRate != null) { const w = parseFloat(defStatcast.whiffRate); if (!isNaN(w)) statcastAdj *= Math.min(Math.max(1 - ((w - 25) * 0.010), 0.85), 1.15); }
    if (defStatcast.hardHitRate != null) { const hh = parseFloat(defStatcast.hardHitRate); if (!isNaN(hh)) statcastAdj *= Math.min(Math.max(1 + ((hh - 38) * 0.008), 0.88), 1.12); }
    if (defStatcast.veloTrend === 'DOWN') statcastAdj *= 1.06;
    else if (defStatcast.veloTrend === 'UP') statcastAdj *= 0.96;
  }
  const raw = baselineRuns * of_ * park * wx * plat * statcastAdj;
  return { runs: +Math.max(3.0, Math.min(raw, 9.5)).toFixed(2) };
}

// ── DET+ ENGINE ───────────────────────────────────────────────────────────────
// Adds: xERA blending, batter Statcast (barrel/hardHit), temperature park factor
function projectRunsPlus({ offenseStats, offenseMatchups, offenseHandedness, isOffenseHome, defPitcher, defStatcast, defPitcherHand, isPitcherHome, defBullpen, parkFactors, weather, batterStatcastList }) {

  // IMPROVEMENT 2 & 3: Starter innings with bullpen game detection
  const avgIPRaw = parseFloat(defPitcher?.avgIP || 6.0);
  let avgIP = Math.min(Math.max(avgIPRaw, 3.0), 7.0);
  let bullpenGameAdj = 0;
  if (defPitcher) {
    // Signal 1: Low avgIP = opener/bulk pattern
    if (avgIP < 4.5) bullpenGameAdj -= 0.5;
    // Signal 2: Recent ERA much worse than season ERA = short leash
    if (defPitcher.recentERA && defPitcher.era) {
      const recentERA = parseFloat(defPitcher.recentERA);
      const seasonERA = parseFloat(defPitcher.era);
      if (!isNaN(recentERA) && !isNaN(seasonERA) && recentERA > seasonERA * 1.5 && recentERA > 6.0) bullpenGameAdj -= 0.75;
    }
    // Signal 3: Velo drop magnitude
    if (defStatcast?.veloTrend != null) {
      const trend = parseFloat(defStatcast.veloTrend);
      if (!isNaN(trend)) { if (trend < -2.0) bullpenGameAdj -= 1.0; else if (trend < -1.0) bullpenGameAdj -= 0.5; }
    }
    // Signal 4: Odds API opener/bullpen note
    if (defPitcher.note) {
      const note = (defPitcher.note || '').toLowerCase();
      if (note.includes('opener') || note.includes('bullpen')) bullpenGameAdj -= 2.0;
    }
    avgIP = Math.min(Math.max(avgIP + bullpenGameAdj, 2.0), 7.0);
  }

  // ERA blend: xERA takes 40% weight when available
  const starterERA = (() => {
    if (!defPitcher) return LEAGUE_AVG_ERA;
    const seasonERA = parseFloat(defPitcher.era || LEAGUE_AVG_ERA);
    const rawRecent = parseFloat(defPitcher.recentERA || seasonERA);
    const recentERA = Math.min(rawRecent, Math.max(seasonERA * 3.0, 9.0));
    const splitERA = isPitcherHome && defPitcher.homeERA ? parseFloat(defPitcher.homeERA) : !isPitcherHome && defPitcher.awayERA ? parseFloat(defPitcher.awayERA) : seasonERA;
    const xERA = defStatcast?.xera ? parseFloat(defStatcast.xera) : null;
    if (xERA && !isNaN(xERA) && xERA > 1.0 && xERA < 8.0) {
      return (xERA * 0.40) + (seasonERA * 0.35) + (splitERA * 0.15) + (recentERA * 0.10);
    }
    return (seasonERA * 0.60) + (splitERA * 0.20) + (recentERA * 0.20);
  })();

  const starterRuns = (starterERA / 9) * avgIP;
  const bullpenIP = Math.max(0, 9 - avgIP);

  // IMPROVEMENT 1: Bullpen fatigue — taxed arms allow more runs
  const bullpenERA = parseFloat(defBullpen?.weightedERA || LEAGUE_AVG_ERA);
  const fatigueNote = (defBullpen?.fatigueNote || '').toLowerCase();
  let fatigueMultiplier = 1.0;
  if (fatigueNote.includes('taxed')) fatigueMultiplier = 1.12;
  else if (fatigueNote.includes('heavy')) fatigueMultiplier = 1.20;
  const adjustedBullpenERA = bullpenERA * fatigueMultiplier;

  // IMPROVEMENT 3: K-BB% as quality signal on top of ERA
  const kbbPct = parseFloat(defBullpen?.kbbPct || 0);
  let kbbAdj = 1.0;
  if (!isNaN(kbbPct)) {
    // League avg K-BB% ~14%. Higher = better bullpen (fewer runs), lower = worse
    kbbAdj = Math.min(Math.max(1 - ((kbbPct - 14) * 0.005), 0.92), 1.08);
  }

  const bullpenRuns = (adjustedBullpenERA / 9) * bullpenIP * kbbAdj;
  const baselineRuns = starterRuns + bullpenRuns;

  const of_ = computeOffenseFactor(offenseStats, offenseMatchups, isOffenseHome);
  const park = parseFloat(parkFactors?.runFactor || 1.0);
  const wx = computeWeatherRunFactor(weather, parkFactors);
  const plat = computePlatoonRunFactor(defPitcherHand, offenseHandedness);

  // Statcast pitcher adjustments
  let statcastAdj = 1.0;
  if (defStatcast) {
    if (defStatcast.whiffRate != null) { const w = parseFloat(defStatcast.whiffRate); if (!isNaN(w)) statcastAdj *= Math.min(Math.max(1 - ((w - 25) * 0.010), 0.85), 1.15); }
    if (defStatcast.hardHitRate != null) { const hh = parseFloat(defStatcast.hardHitRate); if (!isNaN(hh)) statcastAdj *= Math.min(Math.max(1 + ((hh - 38) * 0.008), 0.88), 1.12); }
    // IMPROVEMENT 5: Velo trend with magnitude instead of binary UP/DOWN
    if (defStatcast.veloTrend != null) {
      const trend = parseFloat(defStatcast.veloTrend);
      if (!isNaN(trend)) {
        if (trend < -2.0) statcastAdj *= 1.09;
        else if (trend < -1.0) statcastAdj *= 1.05;
        else if (trend < -0.5) statcastAdj *= 1.02;
        else if (trend > 2.0) statcastAdj *= 0.93;
        else if (trend > 1.0) statcastAdj *= 0.96;
        else if (trend > 0.5) statcastAdj *= 0.98;
      } else {
        if (defStatcast.veloTrend === 'DOWN') statcastAdj *= 1.06;
        else if (defStatcast.veloTrend === 'UP') statcastAdj *= 0.96;
      }
    }
  }

  // Batter Statcast adjustment
  let batterAdj = 1.0;
  if (batterStatcastList && batterStatcastList.length > 0) {
    const valid = batterStatcastList.filter(b => b && b.hardHitRate != null);
    if (valid.length >= 3) {
      const avgHH = valid.reduce((s, b) => s + parseFloat(b.hardHitRate || 0), 0) / valid.length;
      const avgBarrel = valid.reduce((s, b) => s + parseFloat(b.barrelRate || 0), 0) / valid.length;
      const leagueHH = 38.0, leagueBarrel = 8.0;
      const hhAdj = Math.min(Math.max(1 + ((avgHH - leagueHH) / leagueHH) * 0.12, 0.90), 1.12);
      const barrelAdj = Math.min(Math.max(1 + ((avgBarrel - leagueBarrel) / leagueBarrel) * 0.08, 0.92), 1.10);
      batterAdj = (hhAdj + barrelAdj) / 2;
    }
  }

  // IMPROVEMENT 4: Lineup matchup quality vs this specific pitcher
  let matchupAdj = 1.0;
  if (offenseMatchups && offenseMatchups.meaningful >= 3) {
    const matchupOPS = parseFloat(offenseMatchups.avgOPS || 0);
    const leagueOPS = 0.720;
    if (!isNaN(matchupOPS) && matchupOPS > 0) {
      matchupAdj = Math.min(Math.max(1 + ((matchupOPS - leagueOPS) / leagueOPS) * 0.15, 0.88), 1.14);
    }
  }

  // Temperature park factor
  let tempAdj = 1.0;
  if (weather && !weather.dome && weather.temp != null) {
    const temp = parseFloat(weather.temp);
    if (temp <= 45) tempAdj = 0.91;
    else if (temp <= 55) tempAdj = 0.95;
    else if (temp <= 65) tempAdj = 0.98;
    else if (temp >= 90) tempAdj = 1.06;
    else if (temp >= 82) tempAdj = 1.03;
  }

  const raw = baselineRuns * of_ * park * wx * plat * statcastAdj * batterAdj * matchupAdj * tempAdj;
  return { runs: +Math.max(3.0, Math.min(raw, 9.5)).toFixed(2) };
}
// ── END DET+ ENGINE ───────────────────────────────────────────────────────────

// ── END DETERMINISTIC ENGINE ──────────────────────────────────────────────────

const ROOF_STATUS_URLS = { 'Arizona Diamondbacks': 'https://www.mlb.com/dbacks/ballpark/information/roof', 'Milwaukee Brewers': 'https://www.mlb.com/brewers/ballpark/roof-status' };
const ROOF_CLIMATE_DEFAULTS = { 'Houston Astros': (t,r) => t>82||r?'closed':'open', 'Texas Rangers': (t,r) => t>82||r?'closed':'open', 'Miami Marlins': (t,r) => t>75||r?'closed':'open', 'Toronto Blue Jays': (t,r) => r||t<50?'closed':'open', 'Seattle Mariners': (t,r) => r?'closed':'open' };

async function fetchRoofStatus(homeTeam, gameDate, temp, rainy) {
  const url = ROOF_STATUS_URLS[homeTeam];
  if (url) {
    try {
      const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
      if (res.ok) {
        const html = await res.text();
        const d = new Date(gameDate);
        const monthNames = ['January','February','March','April','May','June','July','August','September','October','November','December'];
        const monthShort = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
        const month = monthNames[d.getMonth()], monthS = monthShort[d.getMonth()], day = d.getDate();
        for (const pat of [`${month}\\s+${day}`, `${monthS}\\.?\\s+${day}`, `${d.getMonth()+1}\\/${day}`]) {
          const re = new RegExp(pat + '[^<]{0,200}?(open|closed)', 'i');
          const match = html.match(re);
          if (match) { console.log(`  Roof status for ${homeTeam} on ${gameDate}: ${match[1].toLowerCase()} (scraped)`); return match[1].toLowerCase(); }
        }
      }
    } catch(e) { console.log(`  Roof scrape error for ${homeTeam}:`, e.message); }
  }
  const defaultFn = ROOF_CLIMATE_DEFAULTS[homeTeam];
  if (defaultFn) { const status = defaultFn(temp, rainy); console.log(`  Roof status for ${homeTeam} on ${gameDate}: ${status} (climate default)`); return status; }
  return null;
}

async function fetchWeather(homeTeam, gameTime, venue) {
  try {
    const park = lookupCoords(homeTeam, venue);
    if (!park) { console.log(`  No park found for ${homeTeam}`); return null; }
    const pf = getParkFactors(homeTeam, venue);
    if (park.dome && !pf.retractable) return { dome: true, runFactor: pf.runFactor, description: 'Fixed-roof dome — weather not a factor' };
    const res = await fetch(`https://api.openweathermap.org/data/2.5/forecast?lat=${park.lat}&lon=${park.lon}&appid=${WEATHER_API_KEY}&units=imperial`);
    if (!res.ok) return null;
    const data = await res.json();
    const gameTs = new Date(gameTime).getTime();
    const closest = data.list.reduce((best, item) => { const diff = Math.abs(new Date(item.dt * 1000).getTime() - gameTs); return !best || diff < Math.abs(new Date(best.dt * 1000).getTime() - gameTs) ? item : best; }, null);
    if (!closest) return null;
    const wind = closest.wind, temp = Math.round(closest.main.temp), desc = closest.weather[0].description;
    const windSpeed = Math.round(wind.speed), windDeg = wind.deg;
    let roofOpenProb = 1, roofStatusSource = 'n/a';
    if (park.dome && pf.retractable) {
      const rainy = /rain|storm|snow|drizzle/.test(desc);
      const gameDate = new Date(gameTime).toISOString().slice(0, 10);
      const actualStatus = await fetchRoofStatus(homeTeam, gameDate, temp, rainy);
      if (actualStatus === 'closed') { roofOpenProb = 0; roofStatusSource = 'confirmed closed'; }
      else if (actualStatus === 'open') { roofOpenProb = 1; roofStatusSource = 'confirmed open'; }
      else { roofOpenProb = (!rainy && temp >= 68 && temp <= 85) ? 0.6 : 0.15; roofStatusSource = 'estimated'; }
    }
    const roofClosed = !!(park.dome && pf.retractable && roofOpenProb <= 0.1);
    const effWind = Math.round(windSpeed * (pf.windFactor || 1) * roofOpenProb);
    const homeplateFacing = park.homeplateFacing || 0;
    const windTo = (windDeg + 180) % 360;
    let relAngle = ((windTo - homeplateFacing) + 360) % 360;
    let fieldWindDir, windImpact, windArrow;
    if (relAngle <= 45 || relAngle >= 315) { fieldWindDir = 'OUT to CF'; windArrow = '↑'; windImpact = effWind >= 10 ? 'over' : 'neutral'; }
    else if (relAngle >= 135 && relAngle <= 225) { fieldWindDir = 'IN from CF'; windArrow = '↓'; windImpact = effWind >= 10 ? 'under' : 'neutral'; }
    else if (relAngle > 45 && relAngle < 135) { fieldWindDir = 'L to R'; windArrow = '→'; windImpact = 'neutral'; }
    else { fieldWindDir = 'R to L'; windArrow = '←'; windImpact = 'neutral'; }
    const windCard = windDeg < 22.5 || windDeg >= 337.5 ? 'N' : windDeg < 67.5 ? 'NE' : windDeg < 112.5 ? 'E' : windDeg < 157.5 ? 'SE' : windDeg < 202.5 ? 'S' : windDeg < 247.5 ? 'SW' : windDeg < 292.5 ? 'W' : 'NW';
    if (effWind >= 18 && windImpact === 'over') windImpact = 'significant over';
    if (effWind >= 18 && windImpact === 'under') windImpact = 'significant under';
    if (roofClosed) windImpact = 'neutral';
    const flags = [];
    if (!roofClosed) { if (effWind >= 15) flags.push(effWind >= 20 ? 'HIGH WIND' : 'WIND FACTOR'); if (temp <= 45) flags.push('COLD WEATHER'); if (temp >= 90) flags.push('HOT WEATHER'); if (desc.includes('rain') || desc.includes('storm')) flags.push('RAIN RISK'); if (effWind >= 10 && (fieldWindDir === 'OUT to CF' || fieldWindDir === 'IN from CF')) flags.push(windImpact.toUpperCase()); }
    if (park.dome && pf.retractable) { const statusLabel = roofStatusSource === 'confirmed closed' ? 'CLOSED' : roofStatusSource === 'confirmed open' ? 'OPEN' : `~${Math.round(roofOpenProb*100)}% open (est.)`; flags.push(`RETRACTABLE ROOF (${statusLabel})`); }
    return { dome: false, temp, desc, windSpeed, effWind, windCard, fieldWindDir, windArrow, windImpact, runFactor: pf.runFactor, windFactor: pf.windFactor, retractable: !!(park.dome && pf.retractable), roofOpenProb, weatherNeutralized: roofClosed, flags, summary: roofClosed ? `${temp}°F, ${desc} (roof ${roofStatusSource} — weather neutralized)` : `${temp}°F, ${desc}, wind ${windSpeed}mph ${windCard} (${windArrow} ${fieldWindDir})${flags.length ? ' — ' + flags.join(', ') : ''}` };
  } catch(e) { console.log(`  Weather error for ${homeTeam}:`, e.message); return null; }
}

async function fetchTeamStats(teamName) {
  try {
    const teamsRes = await fetch('https://statsapi.mlb.com/api/v1/teams?sportId=1&season=2026');
    if (!teamsRes.ok) return null;
    const teamsData = await teamsRes.json();
    const team = teamsData.teams?.find(t => t.name.toLowerCase().includes(teamName.toLowerCase().split(' ').pop().toLowerCase()) || teamName.toLowerCase().includes(t.name.toLowerCase().split(' ').pop().toLowerCase()));
    if (!team) return null;
    const [statsRes, splitRes, schedRes] = await Promise.all([
      fetch(`https://statsapi.mlb.com/api/v1/teams/${team.id}/stats?stats=season&group=hitting&season=2026`),
      fetch(`https://statsapi.mlb.com/api/v1/teams/${team.id}/stats?stats=statSplits&group=hitting&season=2026&sitCodes=h,a`),
      fetch(`https://statsapi.mlb.com/api/v1/schedule?teamId=${team.id}&sportId=1&season=2026&gameType=R&startDate=2026-01-01&endDate=${new Date().toISOString().split('T')[0]}`)
    ]);
    if (!statsRes.ok) return null;
    const statsData = await statsRes.json();
    const stats = statsData.stats?.[0]?.splits?.[0]?.stat;
    if (!stats) return null;
    // homeOPS/awayOPS fetched for deterministic engine only — NOT shown to LLM
    let homeOPS = null, awayOPS = null;
    if (splitRes.ok) { const sd = await splitRes.json(); const splits = sd.stats?.[0]?.splits || []; homeOPS = splits.find(s => s.split?.code === 'h')?.stat?.ops || null; awayOPS = splits.find(s => s.split?.code === 'a')?.stat?.ops || null; }
    let last10 = null;
    if (schedRes.ok) { const schedData = await schedRes.json(); const games = schedData.dates?.flatMap(d => d.games) || []; const completed = games.filter(g => g.status?.abstractGameState === 'Final').slice(-10); const wins = completed.filter(g => { const isHome = g.teams?.home?.team?.id === team.id; return isHome ? g.teams?.home?.isWinner : g.teams?.away?.isWinner; }).length; last10 = `${wins}-${completed.length - wins}`; }
    return { teamId: team.id, teamName: team.name, avg: stats.avg, ops: stats.ops, runs: stats.runs, hr: stats.homeRuns, obp: stats.obp, slg: stats.slg, homeOPS, awayOPS, last10 };
  } catch(e) { return null; }
}

async function fetchProbablePitchers(gameDate) {
  try {
    const res = await fetch(`https://statsapi.mlb.com/api/v1/schedule?sportId=1&date=${gameDate}&gameType=R&hydrate=probablePitcher(note),team`);
    if (!res.ok) return { pitcherMap: {}, venueMap: {}, scheduleGames: [] };
    const data = await res.json();
    const pitcherMap = {}, venueMap = {}, scheduleGames = [];
    for (const date of (data.dates || [])) {
      for (const game of (date.games || [])) {
        const awayId = game.teams?.away?.team?.id, homeId = game.teams?.home?.team?.id;
        const venueName = game.venue?.name || null;
        if (homeId) venueMap[`home_${homeId}`] = venueName;
        const awayPitcher = game.teams?.away?.probablePitcher, homePitcher = game.teams?.home?.probablePitcher;
        const awayP = awayPitcher ? { id: awayPitcher.id, name: awayPitcher.fullName, note: awayPitcher.note || null, vs: homeId, gamePk: game.gamePk, venue: venueName } : null;
        const homeP = homePitcher ? { id: homePitcher.id, name: homePitcher.fullName, note: homePitcher.note || null, vs: awayId, gamePk: game.gamePk, venue: venueName } : null;
        if (awayP) pitcherMap[`away_${awayId}`] = awayP;
        if (homeP) pitcherMap[`home_${homeId}`] = homeP;
        scheduleGames.push({ gamePk: game.gamePk, awayId, homeId, gameDate: game.gameDate, venue: venueName, venueId: game.venue?.id || null, awayPitcher: awayP, homePitcher: homeP, seriesGameNumber: game.seriesGameNumber, gamesInSeries: game.gamesInSeries });
      }
    }
    console.log(`Probable pitchers found: ${Object.keys(pitcherMap).length}`);
    return { pitcherMap, venueMap, scheduleGames };
  } catch(e) { console.log('Pitcher lookup failed:', e.message); return { pitcherMap: {}, venueMap: {}, scheduleGames: [] }; }
}

async function fetchSeriesSweepSide(awayId, homeId, dateStr, seriesGameNumber, currentGamePk = null) {
  const priorNeeded = (seriesGameNumber || 0) - 1;
  if (priorNeeded < 2) return null;
  try {
    const start = new Date(new Date(dateStr + 'T12:00:00Z').getTime() - 8 * 86400000).toISOString().slice(0, 10);
    const res = await fetch(`https://statsapi.mlb.com/api/v1/schedule?sportId=1&startDate=${start}&endDate=${dateStr}&teamId=${awayId}&opponentId=${homeId}&gameType=R&hydrate=linescore`);
    if (!res.ok) return null;
    const data = await res.json();
    const h2h = [];
    for (const d of (data.dates || [])) for (const g of (d.games || [])) {
      const aId = g.teams?.away?.team?.id, hId = g.teams?.home?.team?.id;
      const pair = (aId === awayId && hId === homeId) || (aId === homeId && hId === awayId);
      if (!pair || (currentGamePk && g.gamePk === currentGamePk) || g.status?.abstractGameState !== 'Final') continue;
      const od = g.officialDate || (g.gameDate || '').slice(0, 10);
      if (!od || od > dateStr) continue;
      const aS = g.teams?.away?.score, hS = g.teams?.home?.score;
      if (aS == null || hS == null) continue;
      h2h.push({ date: od, winnerId: aS > hS ? aId : hId });
    }
    h2h.sort((x, y) => (x.date < y.date ? 1 : -1));
    const series = h2h.slice(0, priorNeeded);
    if (series.length < priorNeeded) return null;
    const wins = {};
    for (const g of series) wins[g.winnerId] = (wins[g.winnerId] || 0) + 1;
    if (wins[awayId] === series.length) return 'AWAY';
    if (wins[homeId] === series.length) return 'HOME';
    return null;
  } catch (e) { return null; }
}

async function checkMLBDebut(pitcherId) {
  try {
    if (!pitcherId) return false;
    const res = await fetch(`https://statsapi.mlb.com/api/v1/people/${pitcherId}/stats?stats=career&group=pitching`);
    if (!res.ok) return false;
    const data = await res.json();
    const career = data.stats?.[0]?.splits?.[0]?.stat;
    if (!career || parseInt(career.gamesStarted || 0) === 0) return true;
    return false;
  } catch(e) { return false; }
}

async function getTeamId(teamName) {
  try {
    const res = await fetch('https://statsapi.mlb.com/api/v1/teams?sportId=1&season=2026');
    if (!res.ok) return null;
    const data = await res.json();
    const teams = data.teams || [];
    const norm = s => (s || '').toLowerCase().replace(/[^a-z ]/g, '').trim();
    const target = norm(teamName);
    let team = teams.find(t => norm(t.name) === target);
    if (!team) team = teams.find(t => { const tn = norm(t.name); return target.includes(tn) || tn.includes(target); });
    if (!team && target.includes('athletics')) team = teams.find(t => norm(t.name).includes('athletics'));
    if (!team) console.log(`  ⚠ Could not resolve team id for "${teamName}"`);
    return team?.id || null;
  } catch(e) { return null; }
}

let _statcastCache = null;
async function loadStatcastCache() {
  if (_statcastCache) return _statcastCache;
  try {
    const url = `${process.env.SUPABASE_URL}/rest/v1/statcast_cache?select=player_id,player_type,name,data&updated_at=gte.${new Date(Date.now() - 24*60*60*1000).toISOString()}`;
    const res = await fetch(url, { headers: { 'apikey': process.env.SUPABASE_SERVICE_KEY, 'Authorization': `Bearer ${process.env.SUPABASE_SERVICE_KEY}` } });
    if (!res.ok) throw new Error(`Supabase error: ${res.status}`);
    const rows = await res.json();
    _statcastCache = { pitchers: {}, batters: {} };
    for (const row of rows) { const data = typeof row.data === 'string' ? JSON.parse(row.data) : row.data; const bucket = row.player_type === 'pitcher' ? 'pitchers' : 'batters'; _statcastCache[bucket][String(row.player_id)] = { name: row.name, ...data }; }
    console.log(`  Loaded Statcast cache: ${Object.keys(_statcastCache.pitchers).length} pitchers, ${Object.keys(_statcastCache.batters).length} batters`);
  } catch(e) {
    console.log('  Statcast cache load error:', e.message);
    try { const fs = require('fs'); if (fs.existsSync('/tmp/statcast_cache.json')) { const raw = JSON.parse(fs.readFileSync('/tmp/statcast_cache.json', 'utf8')); _statcastCache = { pitchers: raw.pitchers || raw, batters: raw.batters || {} }; console.log(`  Fallback: loaded from /tmp cache`); } else { _statcastCache = { pitchers: {}, batters: {} }; } } catch(fe) { _statcastCache = { pitchers: {}, batters: {} }; }
  }
  return _statcastCache;
}

async function fetchStatcast(pitcherName, pitcherId) {
  try {
    if (!pitcherId) return null;
    const cache = await loadStatcastCache();
    const cached = cache.pitchers?.[String(pitcherId)];
    if (cached) { console.log(`  Statcast ${pitcherName} (cache): velo ${cached.avgVelo}mph (${cached.veloTrend}), whiff ${cached.whiffRate}%, barrel ${cached.barrelRate}%`); return cached; }
    console.log(`  Statcast ${pitcherName}: not in cache — using MLB Stats API fallback`);
    const [saberRes, gameLogRes] = await Promise.all([
      fetch(`https://statsapi.mlb.com/api/v1/people/${pitcherId}/stats?stats=sabermetrics&group=pitching&season=2026`),
      fetch(`https://statsapi.mlb.com/api/v1/people/${pitcherId}/stats?stats=gameLog&group=pitching&season=2026`)
    ]);
    let avgVelo = null, whiffRate = null, hardHitRate = null, barrelRate = null, veloTrend = 'UNKNOWN', lastStartVelo = null, last3Rates = [];
    if (saberRes.ok) { const sd = await saberRes.json(); const s = sd.stats?.[0]?.splits?.[0]?.stat; if (s) { whiffRate = s.whiffPercent != null ? parseFloat(s.whiffPercent).toFixed(1) : null; hardHitRate = s.hardHitPercent != null ? parseFloat(s.hardHitPercent).toFixed(1) : null; barrelRate = s.barrelPercent != null ? parseFloat(s.barrelPercent).toFixed(1) : null; } }
    if (gameLogRes.ok) { const gd = await gameLogRes.json(); const games = gd.stats?.[0]?.splits || []; last3Rates = games.slice(-3).map(g => ({ date: g.date, ip: g.stat?.inningsPitched, er: g.stat?.earnedRuns })); veloTrend = 'STABLE'; }
    console.log(`  Statcast ${pitcherName} (API fallback): whiff ${whiffRate}%, hardHit ${hardHitRate}%, barrel ${barrelRate}%`);
    return { avgVelo, lastStartVelo, veloTrend, whiffRate, hardHitRate, barrelRate, pitches: null, last3Rates };
  } catch(e) { console.log(`  Statcast error for ${pitcherName}:`, e.message); return null; }
}

async function fetchLineup(teamId, gameDate) {
  try {
    if (!teamId) return null;
    const res = await fetch(`https://statsapi.mlb.com/api/v1/schedule?sportId=1&date=${gameDate}&teamId=${teamId}&gameType=R&hydrate=lineups`);
    if (!res.ok) return null;
    const data = await res.json();
    const game = data.dates?.[0]?.games?.[0];
    if (!game) return null;
    const isHome = game.teams?.home?.team?.id === teamId;
    const lineup = isHome ? game.lineups?.homePlayers : game.lineups?.awayPlayers;
    if (!lineup || !lineup.length) return null;
    return lineup.map(p => ({ id: p.id, name: p.fullName, position: p.primaryPosition?.abbreviation }));
  } catch(e) { return null; }
}

async function fetchMatchupStats(batterId, pitcherId) {
  try {
    if (!batterId || !pitcherId) return null;
    const res = await fetch(`https://statsapi.mlb.com/api/v1/people/${batterId}/stats?stats=vsPlayer&opposingPlayerId=${pitcherId}&group=hitting&sportId=1`);
    if (!res.ok) return null;
    const data = await res.json();
    const allSplits = (data.stats || []).flatMap(s => s.splits || []);
    const stat = allSplits.find(s => (s.stat?.atBats || 0) > 0)?.stat;
    if (!stat || !stat.atBats) return null;
    return { ab: stat.atBats || 0, avg: stat.avg || '.000', ops: stat.ops || '.000', hr: stat.homeRuns || 0, so: stat.strikeOuts || 0, bb: stat.baseOnBalls || 0, obp: stat.obp || '.000', slg: stat.slg || '.000' };
  } catch(e) { return null; }
}

async function lineupHandedness(lineup) {
  try {
    if (!lineup || !lineup.length) return null;
    const ids = lineup.map(p => p.id).filter(Boolean).join(',');
    if (!ids) return null;
    const res = await fetch(`https://statsapi.mlb.com/api/v1/people?personIds=${ids}`);
    if (!res.ok) return null;
    const d = await res.json();
    const sides = (d.people || []).map(p => p.batSide?.code);
    return { L: sides.filter(s => s === 'L').length, R: sides.filter(s => s === 'R').length, S: sides.filter(s => s === 'S').length };
  } catch(e) { return null; }
}

async function fetchLineupMatchups(teamId, pitcherId, gameDate) {
  try {
    const lineup = await fetchLineup(teamId, gameDate);
    if (!lineup || !lineup.length) return null;
    const handedness = await lineupHandedness(lineup.slice(0, 9));
    const matchups = await Promise.all(lineup.slice(0, 9).map(batter => fetchMatchupStats(batter.id, pitcherId)));
    const meaningful = matchups.filter(m => m && m.ab >= 10);
    if (!meaningful.length) return { lineup: lineup.slice(0,9), matchups, meaningful: 0, handedness, note: 'Insufficient sample vs this pitcher' };
    const avgOPS = meaningful.reduce((sum, m) => sum + parseFloat(m.ops || 0), 0) / meaningful.length;
    const avgAVG = meaningful.reduce((sum, m) => sum + parseFloat(m.avg || 0), 0) / meaningful.length;
    const totalK = meaningful.reduce((sum, m) => sum + m.so, 0);
    const totalAB = meaningful.reduce((sum, m) => sum + m.ab, 0);
    const kRate = totalAB > 0 ? ((totalK / totalAB) * 100).toFixed(1) : null;
    const hotBatters = meaningful.filter(m => parseFloat(m.ops) > .900).length;
    const coldBatters = meaningful.filter(m => parseFloat(m.ops) < .550).length;
    return { lineup: lineup.slice(0, 9), meaningful: meaningful.length, avgOPS: avgOPS.toFixed(3), avgAVG: avgAVG.toFixed(3), kRate, hotBatters, coldBatters, handedness, sample: `${meaningful.length} of 9 batters with 10+ AB vs this pitcher` };
  } catch(e) { console.log('  Lineup matchup error:', e.message); return null; }
}

async function fetchPitcherDetail(pitcherId, venueId = null) {
  try {
    if (!pitcherId) return null;
    const [statsRes, personRes, splitRes] = await Promise.all([
      fetch(`https://statsapi.mlb.com/api/v1/people/${pitcherId}/stats?stats=season,gameLog&group=pitching&season=2026`),
      fetch(`https://statsapi.mlb.com/api/v1/people/${pitcherId}`),
      fetch(`https://statsapi.mlb.com/api/v1/people/${pitcherId}/stats?stats=statSplits&group=pitching&season=2026&sitCodes=h,a`)
    ]);
    let throwHand = null;
    if (personRes.ok) { const p = await personRes.json(); throwHand = p.people?.[0]?.pitchHand?.code || null; }
    let homeERA = null, awayERA = null;
    if (splitRes.ok) { const sd = await splitRes.json(); const splits = sd.stats?.[0]?.splits || []; homeERA = splits.find(s => s.split?.code === 'h')?.stat?.era || null; awayERA = splits.find(s => s.split?.code === 'a')?.stat?.era || null; }
    if (!statsRes.ok) return throwHand ? { throwHand, homeERA, awayERA } : null;
    const d = await statsRes.json();
    const season = d.stats?.find(s => s.type?.displayName === 'season')?.splits?.[0]?.stat;
    const gameLog = d.stats?.find(s => s.type?.displayName === 'gameLog')?.splits || [];
    if (!season) return throwHand ? { throwHand, homeERA, awayERA } : null;
    const starts = gameLog.filter(g => parseInt(g.stat?.gamesStarted || 0) > 0 || parseFloat(g.stat?.inningsPitched || 0) >= 3).slice(-5);
    const avgIP = starts.length ? (starts.reduce((s, g) => s + parseFloat(g.stat?.inningsPitched || 0), 0) / starts.length).toFixed(1) : null;
    const last3 = gameLog.slice(-3).map(g => ({ ip: g.stat?.inningsPitched, er: g.stat?.earnedRuns, date: g.date }));
    const recentERA = last3.length ? (last3.reduce((s, g) => s + parseFloat(g.er || 0), 0) / Math.max(0.1, last3.reduce((s, g) => s + parseFloat(g.ip || 0), 0)) * 9).toFixed(2) : null;
    const trending = recentERA && season.era ? (parseFloat(recentERA) < parseFloat(season.era) - 0.5 ? 'HOT' : parseFloat(recentERA) > parseFloat(season.era) + 0.5 ? 'COLD' : 'NEUTRAL') : 'UNKNOWN';
    return { era: season.era, whip: season.whip, wins: season.wins, losses: season.losses, ip: season.inningsPitched, recentERA, trending, avgIP, throwHand, last3, homeERA, awayERA };
  } catch(e) { return null; }
}

async function fetchBullpen(teamId) {
  try {
    if (!teamId) return null;
    const rosRes = await fetch(`https://statsapi.mlb.com/api/v1/teams/${teamId}/roster?rosterType=active`);
    if (!rosRes.ok) return null;
    const ros = await rosRes.json();
    const pitchers = (ros.roster || []).filter(p => p.position?.abbreviation === 'P' || p.position?.code === '1');
    if (!pitchers.length) return null;
    const ids = pitchers.map(p => p.person.id);
    const statsList = await Promise.all(ids.map(id => fetch(`https://statsapi.mlb.com/api/v1/people/${id}/stats?stats=season&group=pitching&season=2026`).then(r => r.ok ? r.json() : null).catch(() => null)));
    const relievers = [];
    statsList.forEach((d, i) => { const st = d?.stats?.[0]?.splits?.[0]?.stat; if (!st) return; const gp = parseInt(st.gamesPitched || 0), gs = parseInt(st.gamesStarted || 0); if (gp >= 3 && gs / Math.max(1, gp) < 0.4) { relievers.push({ id: ids[i], name: pitchers[i].person.fullName, era: parseFloat(st.era) || 99, ip: parseFloat(st.inningsPitched) || 0, k: parseInt(st.strikeOuts || 0), bb: parseInt(st.baseOnBalls || 0), bf: parseInt(st.battersFaced || st.atBats || 0), saves: parseInt(st.saves || 0), holds: parseInt(st.holds || 0), blownSaves: parseInt(st.saveOpportunities || 0) - parseInt(st.saves || 0), gp }); } });
    if (!relievers.length) return null;
    relievers.sort((a, b) => (b.saves + b.holds) - (a.saves + a.holds));
    const closer = relievers[0], setupMan = relievers[1] || null;
    const totIP = relievers.reduce((s, r) => s + r.ip, 0) || 1;
    const wERA = relievers.reduce((s, r) => s + (isNaN(r.era) ? 4.5 : r.era) * r.ip, 0) / totIP;
    const totK = relievers.reduce((s, r) => s + r.k, 0), totBB = relievers.reduce((s, r) => s + r.bb, 0), totBF = relievers.reduce((s, r) => s + r.bf, 0) || 1;
    const kbbPct = (((totK - totBB) / totBF) * 100).toFixed(1);
    const fatigue = await bullpenFatigue(teamId, relievers);
    const closerIP = fatigue?.ipByName?.[closer?.name] || 0;
    let closerStatus = 'AVAILABLE';
    if (closerIP >= 1.0 && closerIP < 2.0) closerStatus = 'QUESTIONABLE (pitched recently)';
    else if (closerIP >= 2.0) closerStatus = 'LIKELY UNAVAILABLE (heavy usage last 3d)';
    let fillInCloser = null;
    if (closerStatus !== 'AVAILABLE' && setupMan) { const setupIP = fatigue?.ipByName?.[setupMan?.name] || 0; fillInCloser = { name: setupMan.name, era: setupMan.era, status: setupIP >= 2.0 ? 'also tired' : 'available' }; }
    const closerInfo = closer ? `Closer: ${closer.name} (ERA ${closer.era}, ${closer.saves}SV, ${closer.blownSaves > 0 ? closer.blownSaves+'BS' : '0BS'}) — ${closerStatus}` + (fillInCloser ? ` | Fill-in: ${fillInCloser.name} (ERA ${fillInCloser.era}, ${fillInCloser.status})` : '') : 'Closer: unknown';
    return { count: relievers.length, weightedERA: wERA.toFixed(2), kbbPct, fatigueNote: fatigue?.note || 'fresh', tired: fatigue?.tired || [], closerInfo, closer, fillInCloser, summary: `${relievers.length} arms, pen ERA ${wERA.toFixed(2)}, K-BB% ${kbbPct} — ${fatigue?.note || 'fresh'} | ${closerInfo}` };
  } catch(e) { console.log('  Bullpen error:', e.message); return null; }
}

async function bullpenFatigue(teamId, relievers) {
  try {
    const end = new Date().toISOString().split('T')[0];
    const start = new Date(Date.now() - 4 * 864e5).toISOString().split('T')[0];
    const schedRes = await fetch(`https://statsapi.mlb.com/api/v1/schedule?sportId=1&teamId=${teamId}&startDate=${start}&endDate=${end}&gameType=R`);
    if (!schedRes.ok) return null;
    const sched = await schedRes.json();
    const games = (sched.dates || []).flatMap(d => d.games || []).filter(g => g.status?.abstractGameState === 'Final').slice(-3);
    const ipById = {}, ipByName = {};
    for (const g of games) { const box = await fetch(`https://statsapi.mlb.com/api/v1/game/${g.gamePk}/boxscore`).then(r => r.ok ? r.json() : null).catch(() => null); if (!box) continue; const side = box.teams?.home?.team?.id === teamId ? 'home' : 'away'; const players = box.teams?.[side]?.players || {}; Object.values(players).forEach(pl => { const ip = parseFloat(pl.stats?.pitching?.inningsPitched || 0); if (ip > 0) { ipById[pl.person.id] = (ipById[pl.person.id] || 0) + ip; ipByName[pl.person.fullName] = (ipByName[pl.person.fullName] || 0) + ip; } }); }
    const tired = relievers.filter(r => (ipById[r.id] || 0) >= 2.0).map(r => r.name);
    const usedCount = relievers.filter(r => (ipById[r.id] || 0) > 0).length;
    let note = 'fresh';
    if (tired.length >= 2) note = `TAXED (${tired.length} arms heavy last 3d)`;
    else if (tired.length === 1) note = `${tired[0]} taxed`;
    else if (usedCount >= 4) note = 'worked recently';
    return { note, tired, ipById, ipByName };
  } catch(e) { return null; }
}

async function fetchOddsAPI() {
  console.log('Fetching from The Odds API...');
  const url = `https://api.the-odds-api.com/v4/sports/baseball_mlb/odds/?apiKey=${ODDS_API_KEY}&regions=us&markets=h2h,spreads,totals&oddsFormat=american&dateFormat=iso`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Odds API: ${res.status}`);
  const data = await res.json();
  console.log(`Found ${data.length} games`);
  return data;
}

async function fetchF5Lines() {
  try {
    const url = `https://api.the-odds-api.com/v4/sports/baseball_mlb/odds/?apiKey=${ODDS_API_KEY}&regions=us&markets=h2h_h1,totals_h1&oddsFormat=american&dateFormat=iso`;
    const res = await fetch(url);
    if (!res.ok) return {};
    const data = await res.json();
    const map = {};
    for (const game of data) { const lines = {}; for (const bm of (game.bookmakers || [])) { for (const mkt of (bm.markets || [])) { if (mkt.key === 'h2h_h1' && !lines.f5AwayML) { for (const o of mkt.outcomes) { if (o.name === game.away_team) lines.f5AwayML = o.price > 0 ? `+${o.price}` : `${o.price}`; if (o.name === game.home_team) lines.f5HomeML = o.price > 0 ? `+${o.price}` : `${o.price}`; } } if (mkt.key === 'totals_h1' && !lines.f5Total) { const over = mkt.outcomes.find(o => o.name === 'Over'); const under = mkt.outcomes.find(o => o.name === 'Under'); if (over) { lines.f5Total = `${over.point}`; lines.f5OverOdds = over.price > 0 ? `+${over.price}` : `${over.price}`; lines.f5UnderOdds = under ? (under.price > 0 ? `+${under.price}` : `${under.price}`) : null; } } } if (lines.f5AwayML && lines.f5Total) break; } map[game.id] = lines; }
    return map;
  } catch(e) { return {}; }
}

async function fetchActionNetwork(awayTeam, homeTeam, gameDate) {
  try {
    const dateStr = gameDate.split('T')[0];
    const url = `https://api.actionnetwork.com/web/v1/games?sport=baseball&date=${dateStr}&league=mlb`;
    const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' } });
    if (!res.ok) return null;
    const data = await res.json();
    const games = data.games || [];
    const match = games.find(g => { const at = (g.away_team?.full_name || '').toLowerCase(); const ht = (g.home_team?.full_name || '').toLowerCase(); return (at.includes(awayTeam.toLowerCase().split(' ').pop()) || awayTeam.toLowerCase().includes(at.split(' ').pop())) && (ht.includes(homeTeam.toLowerCase().split(' ').pop()) || homeTeam.toLowerCase().includes(ht.split(' ').pop())); });
    if (!match) return null;
    return { total: match.total || null, awayML: match.away_ml || null, homeML: match.home_ml || null, awayMLPct: match.away_ml_pct || null, homeMLPct: match.home_ml_pct || null, overPct: match.over_pct || null, underPct: match.under_pct || null, awayMoneyPct: match.away_money_pct || null, homeMoneyPct: match.home_money_pct || null };
  } catch(e) { return null; }
}

function americanToProb(o){ o=parseFloat(o); if(isNaN(o)) return null; return o>0 ? 100/(o+100) : (-o)/((-o)+100); }

function parseOddsData(game, opts = {}) {
  let awayML=null,homeML=null,total=null,overOdds=null,underOdds=null,awayRL=null,homeRL=null,awayRLOdds=null,homeRLOdds=null;
  const commence = opts.commenceTime ? new Date(opts.commenceTime) : (game.commence_time ? new Date(game.commence_time) : null);
  const now = opts.now ? new Date(opts.now) : new Date();
  let bookUsed = null, lastUpdate = null, inPlaySkipped = false;
  const books = [...(game.bookmakers||[])].sort((a,b) => { const ia = PREFERRED_BOOKS.indexOf(a.key); const ib = PREFERRED_BOOKS.indexOf(b.key); return (ia<0?999:ia) - (ib<0?999:ib); });
  for (const bm of books) {
    const lu = bm.last_update ? new Date(bm.last_update) : null;
    if (commence && lu && lu.getTime() > commence.getTime()) { inPlaySkipped = true; continue; }
    let bmAwayML=null,bmHomeML=null,bmTotal=null,bmOverOdds=null,bmUnderOdds=null,bmAwayRL=null,bmHomeRL=null,bmAwayRLOdds=null,bmHomeRLOdds=null;
    for (const mkt of (bm.markets||[])) {
      if (mkt.key==='h2h') { for (const o of mkt.outcomes) { if (o.name===game.away_team) bmAwayML=o.price>0?`+${o.price}`:`${o.price}`; if (o.name===game.home_team) bmHomeML=o.price>0?`+${o.price}`:`${o.price}`; } }
      if (mkt.key==='totals') { const over=mkt.outcomes.find(o=>o.name==='Over'); const under=mkt.outcomes.find(o=>o.name==='Under'); if (over) { const pt = parseFloat(over.point); if (pt >= 6.5 && pt <= 13.5) { bmTotal=`${over.point}`; bmOverOdds=over.price>0?`+${over.price}`:`${over.price}`; bmUnderOdds=under?(under.price>0?`+${under.price}`:`${under.price}`):null; } } }
      if (mkt.key==='spreads') { for (const o of mkt.outcomes) { if (o.name===game.away_team) { bmAwayRL=o.point>0?`+${o.point}`:`${o.point}`; bmAwayRLOdds=o.price>0?`+${o.price}`:`${o.price}`; } if (o.name===game.home_team) { bmHomeRL=o.point>0?`+${o.point}`:`${o.point}`; bmHomeRLOdds=o.price>0?`+${o.price}`:`${o.price}`; } } }
    }
    if (!bmAwayML || !bmHomeML) continue;
    if (!awayML) { awayML=bmAwayML; homeML=bmHomeML; bookUsed=bm.title||bm.key; lastUpdate=lu?lu.toISOString():null; }
    if (bookUsed===(bm.title||bm.key)) { if (!total && bmTotal) { total=bmTotal; overOdds=bmOverOdds; underOdds=bmUnderOdds; } if (!awayRL && bmAwayRL) { awayRL=bmAwayRL; homeRL=bmHomeRL; awayRLOdds=bmAwayRLOdds; homeRLOdds=bmHomeRLOdds; } }
    if (awayML&&homeML&&total&&awayRL) break;
  }
  const aProb = americanToProb(awayML), hProb = americanToProb(homeML);
  const aRLpt = parseFloat(awayRL), hRLpt = parseFloat(homeRL);
  if (aProb != null && hProb != null && aProb !== hProb && !isNaN(aRLpt) && !isNaN(hRLpt) && (aRLpt < 0) !== (hRLpt < 0)) { const awayIsFav = aProb > hProb; if (awayIsFav !== (aRLpt < 0)) { [awayRL, homeRL] = [homeRL, awayRL]; [awayRLOdds, homeRLOdds] = [homeRLOdds, awayRLOdds]; } }
  const lineAgeMin = lastUpdate ? Math.round((now - new Date(lastUpdate)) / 60000) : null;
  const stale = lineAgeMin != null && lineAgeMin > STALE_MIN;
  return {awayML,homeML,total,overOdds,underOdds,awayRL,homeRL,awayRLOdds,homeRLOdds,bookUsed,lastUpdate,lineAgeMin,stale,inPlaySkipped};
}

function validateTotal(oddsTotal, anTotal) {
  const ot=parseFloat(oddsTotal), at=parseFloat(anTotal);
  if (anTotal&&!isNaN(at)&&at>=6.5&&at<=13.5) return `${at}`;
  if (!isNaN(ot)&&ot>=6.5&&ot<=13.5) return `${ot}`;
  console.log(`  Warning: unusual total ${oddsTotal} - may be alt market`);
  return oddsTotal;
}

// ── ANALYZE GAME — clean pre-June 23 prompt, LLM projects freely ─────────────
async function analyzeGame(game, lines, anData, f5Lines, weather, awayStats, homeStats, awayPitcher, homePitcher, awayStatcast, homeStatcast, awayMatchups, homeMatchups, awayBullpen, homeBullpen, venueName) {
  console.log(`  Analyzing ${game.away_team} @ ${game.home_team}...`);

  // ── SITUATIONS (deterministic) ────────────────────────────────────────────
  const situations = [];
  const fadeReason = [];

  if (weather && !weather.dome && (weather.flags||[]).some(f => f && (f.includes('WIND')||f.includes('COLD')||f.includes('HOT')||f.includes('RAIN'))))
    situations.push('weather');

  const awayMoneyPct = parseFloat(anData?.awayMoneyPct||0);
  const homeMoneyPct = parseFloat(anData?.homeMoneyPct||0);
  const awayMLPct = parseFloat(anData?.awayMLPct||0);
  const homeMLPct = parseFloat(anData?.homeMLPct||0);
  let lineSharp = false, sharpSide = 'NONE';
  if (awayMoneyPct && awayMLPct && awayMoneyPct > awayMLPct + 15) { situations.push('sharp'); lineSharp = true; sharpSide = game.away_team; }
  else if (homeMoneyPct && homeMLPct && homeMoneyPct > homeMLPct + 15) { situations.push('sharp'); lineSharp = true; sharpSide = game.home_team; }

  let hasFade = false;
  if (awayStatcast && String(awayStatcast.veloTrend||'').toUpperCase() === 'DOWN') { fadeReason.push('velo'); hasFade = true; }
  if (homeStatcast && String(homeStatcast.veloTrend||'').toUpperCase() === 'DOWN') { fadeReason.push('velo'); hasFade = true; }
  if (awayPitcher?.recentERA && awayPitcher?.era && parseFloat(awayPitcher.recentERA) > parseFloat(awayPitcher.era) + 1.0) { fadeReason.push('coldarm'); hasFade = true; }
  if (homePitcher?.recentERA && homePitcher?.era && parseFloat(homePitcher.recentERA) > parseFloat(homePitcher.era) + 1.0) { fadeReason.push('coldarm'); hasFade = true; }
  if (awayStatcast && parseFloat(awayStatcast.hardHitRate||0) >= 42) { fadeReason.push('contact'); hasFade = true; }
  if (homeStatcast && parseFloat(homeStatcast.hardHitRate||0) >= 42) { fadeReason.push('contact'); hasFade = true; }
  if (hasFade) situations.push('fade');
  if (awayPitcher?.debut || homePitcher?.debut) situations.push('debut');

  // ── LINE ANALYSIS ─────────────────────────────────────────────────────────
  const lineNote = anData ? `${Math.round(awayMLPct||0)}% tickets away, ${Math.round(homeMLPct||0)}% home` : '';

  // ── WEATHER IMPACT ────────────────────────────────────────────────────────
  const weatherImpact = (() => {
    if (!weather || weather.dome) return 'none';
    const flags = weather.flags || [];
    if (flags.some(f => f && f.includes('significant over'))) return 'significant over';
    if (flags.some(f => f && f.includes('significant under'))) return 'significant under';
    if (flags.some(f => f && (f.includes('OVER') || f.includes('OUT to CF')))) return 'over';
    if (flags.some(f => f && (f.includes('UNDER') || f.includes('IN from CF')))) return 'under';
    return 'none';
  })();

  // ── PITCHER EDGE ──────────────────────────────────────────────────────────
  const pitcherEdge = (() => {
    const diff = parseFloat(homePitcher?.era||4.5) - parseFloat(awayPitcher?.era||4.5);
    if (diff > 0.75) return game.away_team;
    if (diff < -0.75) return game.home_team;
    return 'EVEN';
  })();

  return {
    situations: [...new Set(situations)],
    fadeReason: [...new Set(fadeReason)],
    projAwayRuns: null, projHomeRuns: null, projTotal: null, f5ProjTotal: null,
    ml: 'SKIP', mlEV: null, mlAwayProb: null, mlHomeProb: null, mlBreakeven: null,
    rl: 'SKIP', rlEV: null, rlAwayProb: null, rlHomeProb: null, rlBreakeven: null,
    total: 'SKIP', totalEV: null, totalLine: lines.total, totalBreakeven: null, totalJuiceSensitivity: null,
    f5: 'SKIP', f5EV: null, f5Line: f5Lines?.f5Total||null, f5Breakeven: null, f5JuiceSensitivity: null,
    best: null, bestPlay: null,
    lineSharp, sharpSide, lineNote, weatherImpact, pitcherEdge,
    awayWinPct: null, homeWinPct: null, edgePct: null,
    situation: `${awayPitcher?.name||'Away'} vs ${homePitcher?.name||'Home'}. ${weather?.summary||''}`.trim(),
    factors: `Away ERA ${awayPitcher?.era||'N/A'}, Home ERA ${homePitcher?.era||'N/A'}. Away pen ERA ${awayBullpen?.weightedERA||'N/A'}, Home pen ERA ${homeBullpen?.weightedERA||'N/A'}.`,
    risks: situations.length ? `Key flags: ${[...new Set(situations)].join(', ')}.` : 'No major situational flags.',
    sweepFade: null,
    simAwayRuns: null, simHomeRuns: null,
    simMl: null, simMlEV: null, simRl: null, simRlEV: null, simTotal: null, simTotalEV: null,
  };
}


async function upsertGame(game, lines, analysis, anData, f5Lines, weather, awayPitcherData, homePitcherData, awayStatcastData, homeStatcastData, awayMatchupData, homeMatchupData, pitcherStatus, gamePk, detProj, detPlusProj, detPlusVerdicts) {
  const row = {
    id: game.id, game_pk: gamePk || null,
    game_date: new Date(game.commence_time).toLocaleDateString('en-CA', {timeZone: 'America/New_York'}),
    away_team: game.away_team, home_team: game.home_team, commence_time: game.commence_time,
    away_pitcher: awayPitcherData?.name || 'TBD', home_pitcher: homePitcherData?.name || 'TBD',
    away_pitcher_hand: awayPitcherData?.throwHand || null, home_pitcher_hand: homePitcherData?.throwHand || null,
    pitcher_status: pitcherStatus || 'tbd', away_pitcher_debut: awayPitcherData?.debut || false, home_pitcher_debut: homePitcherData?.debut || false,
    away_ml: lines.awayML, home_ml: lines.homeML, total: lines.total, over_odds: lines.overOdds, under_odds: lines.underOdds,
    away_rl: lines.awayRL, home_rl: lines.homeRL, away_rl_odds: lines.awayRLOdds, home_rl_odds: lines.homeRLOdds,
    f5_away_ml: f5Lines?.f5AwayML||null, f5_home_ml: f5Lines?.f5HomeML||null, f5_total: f5Lines?.f5Total||null, f5_over_odds: f5Lines?.f5OverOdds||null, f5_under_odds: f5Lines?.f5UnderOdds||null,
    away_ml_pct: anData?.awayMLPct||null, home_ml_pct: anData?.homeMLPct||null, over_pct: anData?.overPct||null, under_pct: anData?.underPct||null,
    weather_summary: weather?.summary||null, weather_temp: weather?.temp||null, weather_wind_speed: weather?.windSpeed||null, weather_wind_dir: weather?.windCard||null,
    weather_field_wind_dir: weather?.fieldWindDir||null, weather_wind_arrow: weather?.windArrow||null, weather_flags: weather?.flags||[], weather_dome: weather?.dome||false,
    run_type: RUN_TYPE, updated_at: new Date().toISOString(),
    away_velo: awayStatcastData?.avgVelo || null, away_velo_trend: awayStatcastData?.veloTrend || null, away_whiff_rate: awayStatcastData?.whiffRate || null, away_barrel_rate: awayStatcastData?.barrelRate || null, away_hard_hit: awayStatcastData?.hardHitRate || null,
    home_velo: homeStatcastData?.avgVelo || null, home_velo_trend: homeStatcastData?.veloTrend || null, home_whiff_rate: homeStatcastData?.whiffRate || null, home_barrel_rate: homeStatcastData?.barrelRate || null, home_hard_hit: homeStatcastData?.hardHitRate || null,
    away_lineup_ops: awayMatchupData?.avgOPS || null, away_lineup_k_rate: awayMatchupData?.kRate || null, home_lineup_ops: homeMatchupData?.avgOPS || null, home_lineup_k_rate: homeMatchupData?.kRate || null,
    lineup_status: (awayMatchupData && homeMatchupData) ? 'confirmed' : (awayMatchupData || homeMatchupData) ? 'partial' : 'projected'
  };

  if (analysis) {
    Object.assign(row, {
      analyzed: true, analyzed_at: new Date().toISOString(),
      situations: (analysis.situations||[])
        .filter(s => ['revenge','travel','sharp','weather','rest','series','fade','mustwin','debut'].includes((s||'').toLowerCase().trim()))
        .filter(s => !(weather?.weatherNeutralized && (s||'').toLowerCase().trim() === 'weather')),
      fade_reason: (() => {
        const faded = (analysis.situations||[]).map(s => (s||'').toLowerCase().trim()).includes('fade');
        if (!faded) return '';
        const reasons = new Set((analysis.fadeReason||[]).map(r => (r||'').toLowerCase().trim()).filter(r => ['velo','coldarm','contact','form'].includes(r)));
        if (awayStatcastData && String(awayStatcastData.veloTrend||'').toUpperCase() === 'DOWN' || homeStatcastData && String(homeStatcastData.veloTrend||'').toUpperCase() === 'DOWN') reasons.add('velo');
        if (awayStatcastData && parseFloat(awayStatcastData.hardHitRate) >= 42 || homeStatcastData && parseFloat(homeStatcastData.hardHitRate) >= 42) reasons.add('contact');
        if (awayPitcherData && String(awayPitcherData.trending||'').toUpperCase() === 'COLD' || homePitcherData && String(homePitcherData.trending||'').toUpperCase() === 'COLD') reasons.add('coldarm');
        return [...reasons].join(',');
      })(),
      ml_verdict: analysis.ml, ml_ev: analysis.mlEV, rl_verdict: analysis.rl, rl_ev: analysis.rlEV,
      sweep_fade: analysis.sweepFade || null,
      total_verdict: analysis.total, total_ev: analysis.totalEV, total_line: analysis.totalLine,
      proj_total: analysis.projTotal,
      proj_away_runs: analysis.projAwayRuns != null ? Math.max(3.0, parseFloat(analysis.projAwayRuns)).toFixed(1) : null,
      proj_home_runs: analysis.projHomeRuns != null ? Math.max(3.0, parseFloat(analysis.projHomeRuns)).toFixed(1) : null,
      sim_away_runs: analysis.simAwayRuns ?? null, sim_home_runs: analysis.simHomeRuns ?? null,
      det_proj_away: detProj?.awayRuns ?? null, det_proj_home: detProj?.homeRuns ?? null,
      sim_ml_verdict: analysis.simMl ?? null, sim_ml_ev: analysis.simMlEV ?? null,
      sim_rl_verdict: analysis.simRl ?? null, sim_rl_ev: analysis.simRlEV ?? null,
      sim_total_verdict: analysis.simTotal ?? null, sim_total_ev: analysis.simTotalEV ?? null,
      det_plus_proj_away: detPlusProj?.awayRuns ?? null, det_plus_proj_home: detPlusProj?.homeRuns ?? null,
      det_plus_ml_verdict: detPlusVerdicts?.ml ?? null, det_plus_ml_ev: detPlusVerdicts?.mlEV ?? null,
      det_plus_rl_verdict: detPlusVerdicts?.rl ?? null, det_plus_rl_ev: detPlusVerdicts?.rlEV ?? null,
      det_plus_total_verdict: detPlusVerdicts?.total ?? null, det_plus_total_ev: detPlusVerdicts?.totalEV ?? null,
      rl_away_prob: analysis.rlAwayProb ?? null, rl_home_prob: analysis.rlHomeProb ?? null,
      f5_verdict: analysis.f5, f5_ev: analysis.f5EV, f5_line: analysis.f5Line, f5_proj_total: analysis.f5ProjTotal,
      best_market: analysis.best, best_play: analysis.bestPlay,
      ml_breakeven: analysis.mlBreakeven, ml_away_prob: analysis.mlAwayProb, ml_home_prob: analysis.mlHomeProb,
      rl_breakeven: analysis.rlBreakeven, total_breakeven: analysis.totalBreakeven,
      total_juice_sensitivity: analysis.totalJuiceSensitivity ? JSON.stringify(analysis.totalJuiceSensitivity) : null,
      f5_juice_sensitivity: analysis.f5JuiceSensitivity ? JSON.stringify(analysis.f5JuiceSensitivity) : null,
      f5_breakeven: analysis.f5Breakeven,
      away_win_pct: analysis.awayWinPct, home_win_pct: analysis.homeWinPct,
      edge_pct: analysis.edgePct, confidence: computeConfidence(analysis, lines),
      line_sharp: analysis.lineSharp, sharp_side: analysis.sharpSide, line_note: analysis.lineNote,
      weather_impact: (weather?.weatherNeutralized ? 'none' : analysis.weatherImpact),
      pitcher_edge: analysis.pitcherEdge, situation_text: analysis.situation, factors_text: analysis.factors, risks_text: analysis.risks
    });
  }

  const res = await fetch(`${SUPABASE_URL}/rest/v1/mlb_games`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'apikey': SUPABASE_SERVICE_KEY, 'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`, 'Prefer': 'resolution=merge-duplicates' },
    body: JSON.stringify(row)
  });
  if (!res.ok) console.error(`Supabase error:`, await res.text());
}

function closingForBet(typeRaw, g){ const type=(typeRaw||'').toLowerCase(), f5=type.includes('f5'); if(type.includes('over')) return { odds: f5?g.f5_over_odds:g.over_odds, line: f5?g.f5_total:g.total }; if(type.includes('under')) return { odds: f5?g.f5_under_odds:g.under_odds, line: f5?g.f5_total:g.total }; if(type.includes('(away')) return { odds: f5?g.f5_away_ml:(type.includes('run line')?g.away_rl_odds:g.away_ml), line: type.includes('run line')?g.away_rl:null }; if(type.includes('(home')) return { odds: f5?g.f5_home_ml:(type.includes('run line')?g.home_rl_odds:g.home_ml), line: type.includes('run line')?g.home_rl:null }; if(type.includes('rl -1.5')) return { odds: g.away_rl_odds, line: g.away_rl }; if(type.includes('rl +1.5')) return { odds: g.home_rl_odds, line: g.home_rl }; return { odds:null, line:null }; }

const _fmtAm = (p) => (p == null ? null : (p > 0 ? `+${p}` : `${p}`));
const BOOK_ALIASES = { dk:'draftkings', fd:'fanduel', mgm:'betmgm', czr:'caesars', wh:'williamhill_us', williamhill:'williamhill_us', caesars:'williamhill_us', br:'betrivers', pb:'pointsbetus', pointsbet:'pointsbetus', espn:'espnbet', hardrock:'hardrockbet' };
function normalizeBook(s){ return (s||'').toLowerCase().replace(/[^a-z0-9]/g,''); }
function resolveBookKey(userBook, closingLines){ if(!userBook || !closingLines) return null; const n = normalizeBook(userBook), alias = BOOK_ALIASES[n] || n; for (const k of Object.keys(closingLines)){ const nk = normalizeBook(k), nt = normalizeBook(closingLines[k]?.title); if (nk === n || nk === alias || nt === n || nt === alias) return k; } return null; }
function rlInvariant(rec){ const aProb = americanToProb(rec.away_ml), hProb = americanToProb(rec.home_ml); const aRLpt = parseFloat(rec.away_rl), hRLpt = parseFloat(rec.home_rl); if (aProb != null && hProb != null && aProb !== hProb && !isNaN(aRLpt) && !isNaN(hRLpt) && (aRLpt < 0) !== (hRLpt < 0)) { if ((aProb > hProb) !== (aRLpt < 0)) { [rec.away_rl, rec.home_rl] = [rec.home_rl, rec.away_rl]; [rec.away_rl_odds, rec.home_rl_odds] = [rec.home_rl_odds, rec.away_rl_odds]; } } }

function buildClosingLines(game, f5game, commence){ const out = {}; const commenceT = commence ? new Date(commence) : null; const inPlay = (bm) => { const lu = bm.last_update ? new Date(bm.last_update) : null; return commenceT && lu && lu.getTime() > commenceT.getTime(); }; const rec = (bm) => out[bm.key] || (out[bm.key] = { title: bm.title || bm.key, last_update: bm.last_update || null }); for (const bm of (game.bookmakers||[])) { if (inPlay(bm)) continue; const r = rec(bm); for (const mkt of (bm.markets||[])) { if (mkt.key==='h2h') for (const o of mkt.outcomes){ if(o.name===game.away_team) r.away_ml=_fmtAm(o.price); if(o.name===game.home_team) r.home_ml=_fmtAm(o.price); } else if (mkt.key==='totals'){ const ov=mkt.outcomes.find(o=>o.name==='Over'), un=mkt.outcomes.find(o=>o.name==='Under'); if(ov && parseFloat(ov.point)>=6.5 && parseFloat(ov.point)<=13.5){ r.total=String(ov.point); r.over_odds=_fmtAm(ov.price); r.under_odds=un?_fmtAm(un.price):null; } } else if (mkt.key==='spreads') for (const o of mkt.outcomes){ if(o.name===game.away_team){ r.away_rl=_fmtAm(o.point); r.away_rl_odds=_fmtAm(o.price);} if(o.name===game.home_team){ r.home_rl=_fmtAm(o.point); r.home_rl_odds=_fmtAm(o.price);} } } } if (f5game) for (const bm of (f5game.bookmakers||[])) { if (inPlay(bm)) continue; const r = rec(bm); for (const mkt of (bm.markets||[])) { if (mkt.key==='h2h_h1') for (const o of mkt.outcomes){ if(o.name===f5game.away_team) r.f5_away_ml=_fmtAm(o.price); if(o.name===f5game.home_team) r.f5_home_ml=_fmtAm(o.price); } else if (mkt.key==='totals_h1'){ const ov=mkt.outcomes.find(o=>o.name==='Over'), un=mkt.outcomes.find(o=>o.name==='Under'); if(ov){ r.f5_total=String(ov.point); r.f5_over_odds=_fmtAm(ov.price); r.f5_under_odds=un?_fmtAm(un.price):null; } } } } for (const k in out) rlInvariant(out[k]); return out; }

async function fetchF5Raw(){ try{ const url = `https://api.the-odds-api.com/v4/sports/baseball_mlb/odds/?apiKey=${ODDS_API_KEY}&regions=us&markets=h2h_h1,totals_h1&oddsFormat=american&dateFormat=iso`; const res = await fetch(url); if(!res.ok) return {}; const data = await res.json(); const map = {}; for (const g of data) map[g.id] = g; return map; }catch(e){ return {}; } }

async function computeClvFromBooks(){ try{ const recentCutoff = new Date(Date.now() - 2*86400000).toLocaleDateString('en-CA',{timeZone:'America/New_York'}); const res = await fetch(`${SUPABASE_URL}/rest/v1/mlb_bets?book=not.is.null&or=(clv.is.null,game_date.gte.${recentCutoff})&order=game_date.desc&limit=400`, { headers: { 'apikey': SUPABASE_SERVICE_KEY, 'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}` } }); if(!res.ok){ console.error(`  CLV pass query failed: ${res.status}`); return; } const bets = await res.json(); if(!bets.length){ console.log('  CLV pass: nothing to resolve.'); return; } console.log(`\nResolving CLV for ${bets.length} candidate bets...`); const cache = new Map(); let filled=0, refreshed=0, frozen=0, unchanged=0, noSnap=0, noBook=0, noOdds=0; for (const bet of bets){ try{ if(!bet.book || !String(bet.book).trim()){ noBook++; continue; } const aw=(bet.matchup||'').split(' @ ')[0]||'', hm=(bet.matchup||'').split(' @ ')[1]||''; if(!cache.has(bet.game_date)){ const gRes = await fetch(`${SUPABASE_URL}/rest/v1/mlb_games?game_date=eq.${bet.game_date}&select=away_team,home_team,closing_lines,commence_time`, { headers:{ 'apikey':SUPABASE_SERVICE_KEY, 'Authorization':`Bearer ${SUPABASE_SERVICE_KEY}` }}); cache.set(bet.game_date, gRes.ok ? await gRes.json() : []); } const rows = cache.get(bet.game_date)||[]; const g = rows.find(r=>{ const at=r.away_team||'',ht=r.home_team||''; return (at.includes(aw.split(' ').pop())||aw.includes(at.split(' ').pop())) && (ht.includes(hm.split(' ').pop())||hm.includes(ht.split(' ').pop())); }); if(!g || !g.closing_lines){ noSnap++; continue; } const notStarted = g.commence_time ? (Date.now() < new Date(g.commence_time).getTime()) : false; const isFirstFill = (bet.clv == null); if(!isFirstFill && !notStarted){ frozen++; continue; } const key = resolveBookKey(bet.book, g.closing_lines); if(!key){ noBook++; continue; } const c = closingForBet(bet.bet_type, g.closing_lines[key]); const pc = americanToProb(c.odds), pb = americanToProb(bet.odds); if(pc==null || pb==null){ noOdds++; continue; } if(!isFirstFill && String(bet.closing_odds??'') === String(c.odds??'')){ unchanged++; continue; } const clv = +(((pc-pb)*100).toFixed(1)); const r = await fetch(`${SUPABASE_URL}/rest/v1/mlb_bets?id=eq.${bet.id}`, { method:'PATCH', headers:{ 'Content-Type':'application/json','apikey':SUPABASE_SERVICE_KEY,'Authorization':`Bearer ${SUPABASE_SERVICE_KEY}`,'Prefer':'return=minimal' }, body: JSON.stringify({ closing_odds: c.odds||null, closing_line:(c.line!=null&&c.line!=='')?String(c.line):null, clv }) }); if(r.ok){ if(isFirstFill) filled++; else refreshed++; const tag = !notStarted ? 'finalized' : (isFirstFill ? 'set' : '↻ updated'); console.log(`  ✓ CLV ${clv>=0?'+':''}${clv}% ${tag} — ${bet.matchup} @ ${g.closing_lines[key].title||key} (closed ${c.odds||'?'})`); } await new Promise(rr=>setTimeout(rr,150)); }catch(e){ /* skip */ } } console.log(`  CLV done — ${filled} set, ${refreshed} refreshed, ${unchanged} unchanged, ${frozen} frozen(started); no snap ${noSnap}, book miss ${noBook}, no odds ${noOdds}`); }catch(e){ console.error('CLV pass error:', e.message); } }

function pickScheduleGame(games, awayName, homeName, targetTimeMs) { const matches = (games || []).filter(g => { const at = g.teams?.away?.team?.name || '', ht = g.teams?.home?.team?.name || ''; return (at.includes(String(awayName).split(' ').pop()) || String(awayName).includes(at.split(' ').pop())) && (ht.includes(String(homeName).split(' ').pop()) || String(homeName).includes(ht.split(' ').pop())); }); if (matches.length <= 1) return matches[0] || null; if (targetTimeMs == null) return matches[0]; return matches.reduce((best, g) => Math.abs(new Date(g.gameDate).getTime() - targetTimeMs) < Math.abs(new Date(best.gameDate).getTime() - targetTimeMs) ? g : best); }

async function settlePendingBets() {
  console.log('\nChecking pending bets for settlement...');
  try {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/mlb_bets?result=eq.pending&order=game_date.desc`, { headers: { 'apikey': SUPABASE_SERVICE_KEY, 'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}` } });
    if (!res.ok) return;
    const bets = await res.json();
    if (!bets.length) { console.log('  No pending bets to settle'); return; }
    console.log(`  Found ${bets.length} pending bets`);
    const gameTimeCache = new Map();
    for (const bet of bets) {
      try {
        const schedRes = await fetch(`https://statsapi.mlb.com/api/v1/schedule?sportId=1&date=${bet.game_date}&gameType=R&hydrate=linescore`);
        if (!schedRes.ok) continue;
        const schedData = await schedRes.json();
        const games = schedData.dates?.[0]?.games || [];
        const matchup = bet.matchup || '';
        const awayName = matchup.split(' @ ')[0], homeName = matchup.split(' @ ')[1];
        if (!gameTimeCache.has(bet.game_date)) { const gr = await fetch(`${SUPABASE_URL}/rest/v1/mlb_games?game_date=eq.${bet.game_date}&select=away_team,home_team,commence_time`, { headers:{ 'apikey':SUPABASE_SERVICE_KEY, 'Authorization':`Bearer ${SUPABASE_SERVICE_KEY}` }}); gameTimeCache.set(bet.game_date, gr.ok ? await gr.json() : []); }
        const grow = (gameTimeCache.get(bet.game_date)||[]).find(r => { const at=r.away_team||'', ht=r.home_team||''; return (at.includes(awayName.split(' ').pop()) || awayName.includes(at.split(' ').pop())) && (ht.includes(homeName?.split(' ').pop()) || homeName?.includes(ht.split(' ').pop())); });
        const targetMs = grow?.commence_time ? new Date(grow.commence_time).getTime() : null;
        const game = pickScheduleGame(games, awayName, homeName, targetMs);
        if (!game || game.status?.abstractGameState !== 'Final') continue;
        const awayScore = game.teams?.away?.score, homeScore = game.teams?.home?.score;
        if (awayScore === undefined || homeScore === undefined) continue;
        const totalScore = awayScore + homeScore;
        const type = (bet.bet_type || '').toLowerCase();
        const betLine = parseFloat(bet.bet_line) || 0;
        let result = 'pending';
        if (type.includes('total over') || type.includes('over')) { if (totalScore > betLine) result = 'win'; else if (totalScore < betLine) result = 'loss'; else result = 'push'; }
        else if (type.includes('total under') || type.includes('under')) { if (totalScore < betLine) result = 'win'; else if (totalScore > betLine) result = 'loss'; else result = 'push'; }
        else if (type.includes('moneyline (away)') || type.includes('f5 moneyline (away)')) { if (awayScore > homeScore) result = 'win'; else if (awayScore < homeScore) result = 'loss'; else result = 'push'; }
        else if (type.includes('moneyline (home)') || type.includes('f5 moneyline (home)')) { if (homeScore > awayScore) result = 'win'; else if (homeScore < awayScore) result = 'loss'; else result = 'push'; }
        else if (type.includes('rl -1.5') || type.includes('run line (away')) { const sp = parseFloat(bet.bet_line); const d = (awayScore - homeScore) + (isNaN(sp) ? -1.5 : sp); result = d > 0 ? 'win' : d < 0 ? 'loss' : 'push'; }
        else if (type.includes('rl +1.5') || type.includes('run line (home')) { const sp = parseFloat(bet.bet_line); const d = (homeScore - awayScore) + (isNaN(sp) ? 1.5 : sp); result = d > 0 ? 'win' : d < 0 ? 'loss' : 'push'; }
        if (result === 'pending') continue;
        const updateRes = await fetch(`${SUPABASE_URL}/rest/v1/mlb_bets?id=eq.${bet.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json', 'apikey': SUPABASE_SERVICE_KEY, 'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`, 'Prefer': 'return=minimal' }, body: JSON.stringify({ result, away_score: awayScore, home_score: homeScore, settled_at: new Date().toISOString() }) });
        if (updateRes.ok) console.log(`  ✓ Settled: ${bet.matchup} — ${result.toUpperCase()} (${awayScore}-${homeScore})`);
        await new Promise(r => setTimeout(r, 500));
      } catch(e) { console.error(`  Error settling ${bet.matchup}:`, e.message); }
    }
  } catch(e) { console.error('Settlement error:', e.message); }
}

async function settleGameScores() {
  console.log('\nCapturing final scores into mlb_games...');
  try {
    const todayET = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
    const res = await fetch(`${SUPABASE_URL}/rest/v1/mlb_games?actual_total=is.null&game_date=lte.${todayET}&select=id,game_date,away_team,home_team,commence_time&order=game_date.desc`, { headers: { 'apikey': SUPABASE_SERVICE_KEY, 'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}` } });
    if (!res.ok) { console.log('  (could not read unscored games)'); return; }
    const rows = await res.json();
    if (!rows.length) { console.log('  No unscored finished games.'); return; }
    const byDate = {};
    for (const r of rows) (byDate[r.game_date] ||= []).push(r);
    let scored = 0;
    for (const date of Object.keys(byDate)) {
      let games = [];
      try { const sres = await fetch(`https://statsapi.mlb.com/api/v1/schedule?sportId=1&date=${date}&gameType=R&hydrate=linescore`); if (!sres.ok) continue; const sdata = await sres.json(); games = sdata.dates?.[0]?.games || []; } catch { continue; }
      for (const row of byDate[date]) {
        const targetMs = row.commence_time ? new Date(row.commence_time).getTime() : null;
        const game = pickScheduleGame(games, row.away_team || '', row.home_team || '', targetMs);
        if (!game || game.status?.abstractGameState !== 'Final') continue;
        const a = game.teams?.away?.score, h = game.teams?.home?.score;
        if (a === undefined || h === undefined) continue;
        const up = await fetch(`${SUPABASE_URL}/rest/v1/mlb_games?id=eq.${row.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json', 'apikey': SUPABASE_SERVICE_KEY, 'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`, 'Prefer': 'return=minimal' }, body: JSON.stringify({ away_final: a, home_final: h, actual_total: a + h }) });
        if (up.ok) { scored++; console.log(`  ✓ Scored: ${row.away_team} @ ${row.home_team} (${date}) — ${a}-${h}, total ${a + h}`); }
        await new Promise(r => setTimeout(r, 250));
      }
    }
    console.log(`  Final-score capture done — ${scored} game(s) scored.`);
  } catch (e) { console.error('  Game-score capture error:', e.message); }
}

async function snapshotGameClose(g, f5Map, f5Raw, today, now) {
  const minutesSinceStart = (now - new Date(g.commence_time)) / 60000;
  if (minutesSinceStart > 5) return 'started';
  const lines = parseOddsData(g, { commenceTime: g.commence_time, now });
  const awayML = parseFloat(lines.awayML), homeML = parseFloat(lines.homeML);
  if (!isNaN(awayML) && !isNaN(homeML) && (Math.abs(awayML) > 600 || Math.abs(homeML) > 600)) return 'inplay';
  if (!lines.awayML) { console.log(`  ⊘ ${g.away_team} @ ${g.home_team} — no pre-game line, keeping prior close`); return 'inplay'; }
  const f5 = f5Map[g.id] || null;
  const closing_lines = buildClosingLines(g, f5Raw[g.id] || null, g.commence_time);
  const payload = { away_ml: lines.awayML, home_ml: lines.homeML, total: lines.total, over_odds: lines.overOdds, under_odds: lines.underOdds, away_rl: lines.awayRL, home_rl: lines.homeRL, away_rl_odds: lines.awayRLOdds, home_rl_odds: lines.homeRLOdds, f5_away_ml: f5?.f5AwayML || null, f5_home_ml: f5?.f5HomeML || null, f5_total: f5?.f5Total || null, f5_over_odds: f5?.f5OverOdds || null, f5_under_odds: f5?.f5UnderOdds || null, closing_lines };
  const url = g.id ? `${SUPABASE_URL}/rest/v1/mlb_games?id=eq.${encodeURIComponent(g.id)}` : `${SUPABASE_URL}/rest/v1/mlb_games?game_date=eq.${today}&away_team=eq.${encodeURIComponent(g.away_team)}&home_team=eq.${encodeURIComponent(g.home_team)}`;
  const newCount = closing_lines ? Object.keys(closing_lines).length : 0;
  if (newCount === 0) { console.log(`  ⊘ ${g.away_team} @ ${g.home_team} — empty snapshot, keeping prior`); delete payload.closing_lines; }
  try { const res = await fetch(url, { method:'PATCH', headers:{ 'Content-Type':'application/json','apikey':SUPABASE_SERVICE_KEY,'Authorization':`Bearer ${SUPABASE_SERVICE_KEY}`,'Prefer':'return=minimal' }, body: JSON.stringify(payload) }); if (res.ok) { console.log(`  ✓ Close refreshed: ${g.away_team} @ ${g.home_team} | ML ${lines.awayML}/${lines.homeML} | ${lines.total} | ${lines.bookUsed||'?'} | ${Object.keys(closing_lines).length} books`); return 'updated'; } console.error(`  ✗ ${g.away_team} @ ${g.home_team}: ${await res.text()}`); return 'error'; } catch(e) { console.error(`  ✗ ${g.away_team} @ ${g.home_team}:`, e.message); return 'error'; }
}

async function refreshClosingOdds() {
  console.log('\n=== Closing-line refresh ===');
  console.log(`${new Date().toLocaleString('en-US',{timeZone:'America/New_York'})} ET\n`);
  const etDate = new Date().toLocaleDateString('en-US', {timeZone:'America/New_York', year:'numeric', month:'2-digit', day:'2-digit'});
  const [etMonth, etDay, etYear] = etDate.split('/');
  const today = etYear + '-' + etMonth + '-' + etDay;
  const [games, f5Map, f5Raw] = await Promise.all([fetchOddsAPI(), fetchF5Lines(), fetchF5Raw()]);
  const now = new Date();
  let updated = 0;
  for (const g of games) {
    if (new Date(g.commence_time).toLocaleDateString('en-CA', {timeZone:'America/New_York'}) !== today) continue;
    const minsToStart = (new Date(g.commence_time) - now) / 60000;
    if (minsToStart > 30) { console.log(`  ⏭  ${g.away_team} @ ${g.home_team} — ${Math.round(minsToStart)}m to first pitch, skipping`); continue; }
    const st = await snapshotGameClose(g, f5Map, f5Raw, today, now);
    if (st === 'updated') updated++;
    await new Promise(r => setTimeout(r, 300));
  }
  console.log(`\n✅ Closing refresh done — ${updated} games updated`);
  await settlePendingBets();
  await settleGameScores();
  await computeClvFromBooks();
}

async function countReadyGames(today, doneSet) {
  try {
    const res = await fetch(`https://statsapi.mlb.com/api/v1/schedule?sportId=1&date=${today}&gameType=R&hydrate=probablePitcher,lineups,team`);
    if (!res.ok) return { ready: -1, refresh: -1 };
    const data = await res.json();
    const games = data.dates?.[0]?.games || [];
    const now = Date.now();
    let ready = 0, refresh = 0, waiting = 0, started = 0;
    for (const g of games) {
      const away = g.teams?.away?.team?.name || '', home = g.teams?.home?.team?.name || '';
      const minsToStart = (new Date(g.gameDate).getTime() - now) / 60000;
      if (minsToStart < -5) { started++; continue; }
      if (doneSet.has(`gp:${g.gamePk}`) || doneSet.has(`nm:${away}@${home}`)) { if (minsToStart <= REFRESH_WINDOW_MIN) refresh++; continue; }
      const probOk = !!(g.teams?.away?.probablePitcher?.id && g.teams?.home?.probablePitcher?.id);
      const lineupOk = (g.lineups?.awayPlayers?.length >= 9) && (g.lineups?.homePlayers?.length >= 9);
      if (probOk && lineupOk) ready++; else waiting++;
    }
    console.log(`Readiness pre-check (free): ${ready} ready, ${refresh} need close-refresh, ${waiting} waiting, ${doneSet.size} done, ${started} started.`);
    return { ready, refresh };
  } catch(e) { console.log('  readiness pre-check error:', e.message); return { ready: -1, refresh: -1 }; }
}

async function main() {
  if (RUN_TYPE === 'closing') { await refreshClosingOdds(); return; }
  console.log(`\n=== MLB Analysis: ${RUN_TYPE} ===`);
  console.log(`${new Date().toLocaleString('en-US',{timeZone:'America/New_York'})} ET\n`);

  await loadStatcastCache();
  global._statcastCache = _statcastCache;

  const etDate = new Date().toLocaleDateString('en-US', {timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit'});
  const [etMonth, etDay, etYear] = etDate.split('/');
  const today = etYear + '-' + etMonth + '-' + etDay;

  const doneSet = new Set();
  try {
    const dRes = await fetch(`${SUPABASE_URL}/rest/v1/mlb_games?game_date=eq.${today}&select=id,game_pk,away_team,home_team,pitcher_status,lineup_status`, { headers:{ 'apikey':SUPABASE_SERVICE_KEY, 'Authorization':`Bearer ${SUPABASE_SERVICE_KEY}` }});
    if (dRes.ok) for (const r of await dRes.json()) { if (r.pitcher_status === 'confirmed' && r.lineup_status === 'confirmed') { if (r.id) doneSet.add(String(r.id)); if (r.game_pk) doneSet.add(`gp:${r.game_pk}`); doneSet.add(`nm:${r.away_team}@${r.home_team}`); } }
    if (doneSet.size) console.log(`Already analyzed: ${doneSet.size} — will skip.`);
  } catch(e) { /* not fatal */ }

  const { ready, refresh } = await countReadyGames(today, doneSet);
  if (ready === 0 && refresh === 0) {
    console.log('Nothing to analyze and no closes to snapshot — skipping the Odds API pull this tick.');
    await settlePendingBets(); await settleGameScores(); await computeClvFromBooks();
    console.log('✅ Tick done — nothing to do.'); return;
  }

  const [games, f5Map, f5Raw, probables] = await Promise.all([fetchOddsAPI(), fetchF5Lines(), fetchF5Raw(), fetchProbablePitchers(today)]);
  const pitcherMap = probables.pitcherMap, venueMap = probables.venueMap, scheduleGames = probables.scheduleGames || [];
  const now = new Date();
  const todayGames = games.filter(g => {
    const gameEtDate = new Date(g.commence_time).toLocaleDateString('en-CA', {timeZone: 'America/New_York'});
    if (gameEtDate !== today) return false;
    const minutesSinceStart = (now - new Date(g.commence_time)) / 60000;
    if (minutesSinceStart > 5 && doneSet.has(String(g.id))) { console.log(`  Skipping ${g.away_team} @ ${g.home_team} — game already started`); return false; }
    const lines = parseOddsData(g, { commenceTime: g.commence_time, now });
    const awayML = parseFloat(lines.awayML), homeML = parseFloat(lines.homeML);
    if (!isNaN(awayML) && !isNaN(homeML) && (Math.abs(awayML) > 600 || Math.abs(homeML) > 600)) { console.log(`  Skipping ${g.away_team} @ ${g.home_team} — extreme live odds detected`); return false; }
    return true;
  });
  console.log(`Today: ${todayGames.length} games\n`);

  for (const game of todayGames) {
    try {
      if (doneSet.has(String(game.id))) {
        const minsToStart = (new Date(game.commence_time) - now) / 60000;
        if (minsToStart > REFRESH_WINDOW_MIN) { console.log(`  ⏭  ${game.away_team} @ ${game.home_team} — analyzed; close window not open (${Math.round(minsToStart)}m)`); }
        else { await snapshotGameClose(game, f5Map, f5Raw, today, now); await new Promise(r => setTimeout(r, 300)); }
        continue;
      }
      const lines = parseOddsData(game, { commenceTime: game.commence_time });
      if (lines.stale) console.log(`  ⚠ ${game.away_team} @ ${game.home_team} — line is ${lines.lineAgeMin}m old (${lines.bookUsed||'?'}), may be stale`);

      const [awayTeamId, homeTeamId] = await Promise.all([getTeamId(game.away_team), getTeamId(game.home_team)]);

      let sg = null;
      const sgMatches = scheduleGames.filter(s => s.awayId === awayTeamId && s.homeId === homeTeamId);
      if (sgMatches.length === 1) sg = sgMatches[0];
      else if (sgMatches.length > 1) { const t = new Date(game.commence_time).getTime(); sg = sgMatches.reduce((b, s) => Math.abs(new Date(s.gameDate).getTime() - t) < Math.abs(new Date(b.gameDate).getTime() - t) ? s : b); }

      const awayPitcherInfo = sg?.awayPitcher || (awayTeamId ? pitcherMap[`away_${awayTeamId}`] : null);
      const homePitcherInfo = sg?.homePitcher || (homeTeamId ? pitcherMap[`home_${homeTeamId}`] : null);
      const resolvedGamePk = sg?.gamePk || awayPitcherInfo?.gamePk || homePitcherInfo?.gamePk || null;
      const venueName = sg?.venue || (homeTeamId && venueMap[`home_${homeTeamId}`]) || homePitcherInfo?.venue || awayPitcherInfo?.venue || null;

      let pitcherStatus = 'tbd';
      if (awayPitcherInfo && homePitcherInfo) {
        const sameGame = awayPitcherInfo.gamePk && awayPitcherInfo.gamePk === homePitcherInfo.gamePk;
        const opponentsMatch = awayPitcherInfo.vs === homeTeamId && homePitcherInfo.vs === awayTeamId;
        if (sameGame && opponentsMatch) pitcherStatus = 'confirmed';
        else { pitcherStatus = 'mismatch'; console.log(`  ⚠ PITCHER MATCHUP UNVERIFIED for ${game.away_team} @ ${game.home_team}`); }
      } else if (awayPitcherInfo || homePitcherInfo) { pitcherStatus = 'partial'; }
      if (pitcherStatus === 'confirmed') console.log(`  ✓ Pitchers confirmed: ${awayPitcherInfo.name} @ ${homePitcherInfo.name} (gamePk ${awayPitcherInfo.gamePk})`);
      if (pitcherStatus !== 'confirmed') { console.log(`  ⏳ ${game.away_team} @ ${game.home_team} — pitchers not confirmed (${pitcherStatus}); skipping`); continue; }

      const [awayDebut, homeDebut] = await Promise.all([awayPitcherInfo ? checkMLBDebut(awayPitcherInfo.id) : Promise.resolve(false), homePitcherInfo ? checkMLBDebut(homePitcherInfo.id) : Promise.resolve(false)]);
      if (awayPitcherInfo) awayPitcherInfo.debut = awayDebut;
      if (homePitcherInfo) homePitcherInfo.debut = homeDebut;
      if (awayDebut) console.log(`  🚨 MLB DEBUT: ${awayPitcherInfo.name} (${game.away_team})`);
      if (homeDebut) console.log(`  🚨 MLB DEBUT: ${homePitcherInfo.name} (${game.home_team})`);

      const [awayStatcast, homeStatcast, awayMatchups, homeMatchups] = await Promise.all([
        awayPitcherInfo?.id ? fetchStatcast(awayPitcherInfo.name, awayPitcherInfo.id) : Promise.resolve(null),
        homePitcherInfo?.id ? fetchStatcast(homePitcherInfo.name, homePitcherInfo.id) : Promise.resolve(null),
        homePitcherInfo?.id && awayTeamId ? fetchLineupMatchups(awayTeamId, homePitcherInfo.id, today) : Promise.resolve(null),
        awayPitcherInfo?.id && homeTeamId ? fetchLineupMatchups(homeTeamId, awayPitcherInfo.id, today) : Promise.resolve(null)
      ]);

      if (awayStatcast) console.log(`  Statcast ${awayPitcherInfo.name}: velo ${awayStatcast.avgVelo} (${awayStatcast.veloTrend}), whiff ${awayStatcast.whiffRate}%, barrel ${awayStatcast.barrelRate}%`);

      // GATE 2 — both lineups must be confirmed
      const lineupsReady = (awayMatchups?.lineup?.length >= 9) && (homeMatchups?.lineup?.length >= 9);
      if (!lineupsReady) { console.log(`  ⏳ ${game.away_team} @ ${game.home_team} — lineups not posted yet; skipping`); continue; }
      if (homeStatcast) console.log(`  Statcast ${homePitcherInfo.name}: velo ${homeStatcast.avgVelo} (${homeStatcast.veloTrend}), whiff ${homeStatcast.whiffRate}%, barrel ${homeStatcast.barrelRate}%`);
      if (awayMatchups?.avgOPS != null) console.log(`  Away lineup vs ${homePitcherInfo?.name}: OPS ${awayMatchups.avgOPS}, K% ${awayMatchups.kRate}`);
      else if (awayMatchups) console.log(`  Away lineup vs ${homePitcherInfo?.name}: no batter-vs-pitcher sample`);
      if (homeMatchups?.avgOPS != null) console.log(`  Home lineup vs ${awayPitcherInfo?.name}: OPS ${homeMatchups.avgOPS}, K% ${homeMatchups.kRate}`);
      else if (homeMatchups) console.log(`  Home lineup vs ${awayPitcherInfo?.name}: no batter-vs-pitcher sample`);

      const venueId = sg?.venueId || null;
      const [awayDetail, homeDetail, awayBullpen, homeBullpen] = await Promise.all([
        awayPitcherInfo?.id ? fetchPitcherDetail(awayPitcherInfo.id, venueId) : Promise.resolve(null),
        homePitcherInfo?.id ? fetchPitcherDetail(homePitcherInfo.id, venueId) : Promise.resolve(null),
        awayTeamId ? fetchBullpen(awayTeamId) : Promise.resolve(null),
        homeTeamId ? fetchBullpen(homeTeamId) : Promise.resolve(null)
      ]);
      if (awayPitcherInfo && awayDetail) Object.assign(awayPitcherInfo, awayDetail);
      if (homePitcherInfo && homeDetail) Object.assign(homePitcherInfo, homeDetail);
      if (awayBullpen) console.log(`  ${game.away_team} pen: ${awayBullpen.summary}`);
      if (homeBullpen) console.log(`  ${game.home_team} pen: ${homeBullpen.summary}`);

      const [anData, weather, awayStats, homeStats] = await Promise.all([
        fetchActionNetwork(game.away_team, game.home_team, game.commence_time),
        fetchWeather(game.home_team, game.commence_time, venueName),
        fetchTeamStats(game.away_team),
        fetchTeamStats(game.home_team)
      ]);

      if (anData?.total) lines.total = validateTotal(lines.total, anData.total);

      const f5Lines = f5Map[game.id] || null;

      // ── LLM ANALYSIS — clean pre-June 23 prompt ──────────────────────────
            const awayRunProj = projectRuns({ offenseStats: awayStats, offenseMatchups: awayMatchups, offenseHandedness: awayMatchups?.handedness, isOffenseHome: false, defPitcher: homePitcherInfo, defStatcast: homeStatcast, defPitcherHand: homePitcherInfo?.throwHand, isPitcherHome: true, defBullpen: homeBullpen, parkFactors, weather });
      const homeRunProj = projectRuns({ offenseStats: homeStats, offenseMatchups: homeMatchups, offenseHandedness: homeMatchups?.handedness, isOffenseHome: true, defPitcher: awayPitcherInfo, defStatcast: awayStatcast, defPitcherHand: awayPitcherInfo?.throwHand, isPitcherHome: false, defBullpen: awayBullpen, parkFactors, weather });
      const detProj = { awayRuns: awayRunProj.runs, homeRuns: homeRunProj.runs };
      console.log(`  DET (background): ${game.away_team} ${detProj.awayRuns} - ${game.home_team} ${detProj.homeRuns} (tot ${+(parseFloat(detProj.awayRuns)+parseFloat(detProj.homeRuns)).toFixed(2)}`);


      const analysis = await analyzeGame(game, lines, anData, f5Lines, weather, awayStats, homeStats, awayPitcherInfo, homePitcherInfo, awayStatcast, homeStatcast, awayMatchups, homeMatchups, awayBullpen, homeBullpen, venueName);
      if (analysis && detProj) {
        analysis.projAwayRuns = detProj.awayRuns;
        analysis.projHomeRuns = detProj.homeRuns;
        analysis.projTotal = +(parseFloat(detProj.awayRuns) + parseFloat(detProj.homeRuns)).toFixed(2);
      }

      if (!analysis) { console.error(`  ✗ ${game.away_team} @ ${game.home_team}: analysis parse failed — keeping previous row`); continue; }

      // ── DETERMINISTIC PROJECTION (background reference — never shown to LLM) ──
      const parkFactors = getParkFactors(game.home_team, venueName);

      // ── DET+ (enhanced det with xERA + batter Statcast + temp adjustment) ─
      const awayBatStatcast = awayMatchups?.lineup?.slice(0,9).map(b => _statcastCache?.batters?.[String(b.id)] || null) || [];
      const homeBatStatcast = homeMatchups?.lineup?.slice(0,9).map(b => _statcastCache?.batters?.[String(b.id)] || null) || [];
      const awayRunProjPlus = projectRunsPlus({ offenseStats: awayStats, offenseMatchups: awayMatchups, offenseHandedness: awayMatchups?.handedness, isOffenseHome: false, defPitcher: homePitcherInfo, defStatcast: homeStatcast, defPitcherHand: homePitcherInfo?.throwHand, isPitcherHome: true, defBullpen: homeBullpen, parkFactors, weather, batterStatcastList: awayBatStatcast });
      const homeRunProjPlus = projectRunsPlus({ offenseStats: homeStats, offenseMatchups: homeMatchups, offenseHandedness: homeMatchups?.handedness, isOffenseHome: true, defPitcher: awayPitcherInfo, defStatcast: awayStatcast, defPitcherHand: awayPitcherInfo?.throwHand, isPitcherHome: false, defBullpen: awayBullpen, parkFactors, weather, batterStatcastList: homeBatStatcast });
      const detPlusProj = { awayRuns: awayRunProjPlus.runs, homeRuns: homeRunProjPlus.runs };
      console.log(`  DET+ ${game.away_team} ${detPlusProj.awayRuns} - ${game.home_team} ${detPlusProj.homeRuns} (tot ${+(parseFloat(detPlusProj.awayRuns)+parseFloat(detPlusProj.homeRuns)).toFixed(2)})`);
      // Derive det+ verdicts using same ncdf math as client scoreboard
      const detPlusVerdicts = (() => {
        const da = parseFloat(detPlusProj.awayRuns), dh = parseFloat(detPlusProj.homeRuns);
        if (isNaN(da) || isNaN(dh)) return {};
        const mu = da - dh, MSD = 4.0, TSD = 5.5;
        const ncdf = x => { const t=1/(1+0.2316419*Math.abs(x)),d2=0.3989423*Math.exp(-x*x/2),p=d2*t*(0.3193815+t*(-0.3565638+t*(1.781478+t*(-1.821256+t*1.330274)))); return x>0?1-p:p; };
        const pA=(1-ncdf((0.5-mu)/MSD)),pH=ncdf((-0.5-mu)/MSD),den=(pA+pH)||1;
        const paMl=pA/den, phMl=pH/den;
        const mlAway = evPct(paMl, lines.awayML), mlHome = evPct(phMl, lines.homeML);
        const mlSide = pickSide([{ev:mlAway,label:'AWAY'},{ev:mlHome,label:'HOME'}]);
        let aRL=parseFloat(lines.awayRL),hRL=parseFloat(lines.homeRL);
        if(isNaN(aRL))aRL=mu>0?-1.5:1.5; if(isNaN(hRL))hRL=mu>0?1.5:-1.5;
        const pArl=1-ncdf((-aRL-mu)/MSD), pHrl=ncdf((hRL-mu)/MSD);
        const rlAway=evPct(pArl,lines.awayRLOdds), rlHome=evPct(pHrl,lines.homeRLOdds);
        const rlSide=pickSide([{ev:rlAway,label:'AWAY'},{ev:rlHome,label:'HOME'}]);
        const proj=da+dh, totalLine=parseFloat(lines.total)||NaN;
        let totSide=null;
        if(!isNaN(totalLine)){const pO=1/(1+Math.exp(1.7*(totalLine-proj)/TSD));const ovEV=evPct(pO,lines.overOdds),unEV=evPct(1-pO,lines.underOdds);totSide=pickSide([{ev:ovEV,label:'OVER'},{ev:unEV,label:'UNDER'}]);}
        return {
          ml: mlSide?verdictFor(mlSide.ev,mlSide.label):'SKIP', mlEV: mlSide?mlSide.ev:null,
          rl: rlSide?verdictFor(rlSide.ev,rlSide.label):'SKIP', rlEV: rlSide?rlSide.ev:null,
          total: totSide?verdictFor(totSide.ev,totSide.label):'SKIP', totalEV: totSide?totSide.ev:null,
        };
      })();

      // ── SIM (shadow mode) ─────────────────────────────────────────────────
      try {
        if (awayMatchups?.lineup?.length >= 9 && homeMatchups?.lineup?.length >= 9 && awayPitcherInfo?.id && homePitcherInfo?.id && awayTeamId && homeTeamId) {
          const simProbs = await simulateGame({
            awayLineupIds: awayMatchups.lineup.map(p => p.id), homeLineupIds: homeMatchups.lineup.map(p => p.id),
            awayStarterId: awayPitcherInfo.id, homeStarterId: homePitcherInfo.id,
            awayTeamId, homeTeamId,
            awayStarterHand: awayPitcherInfo?.throwHand || 'R', homeStarterHand: homePitcherInfo?.throwHand || 'R',
            awayStarterStatcast: awayStatcast || null, homeStarterStatcast: homeStatcast || null,
            awayStarterInfo: awayPitcherInfo || null, homeStarterInfo: homePitcherInfo || null,
            awayLineupHandedness: awayMatchups.handedness || null, homeLineupHandedness: homeMatchups.handedness || null,
            awayPitcherDetail: awayPitcherInfo || null, homePitcherDetail: homePitcherInfo || null,
            awayBatterStatcast: awayMatchups.lineup.slice(0,9).map(b => _statcastCache?.batters?.[String(b.id)] || null),
            homeBatterStatcast: homeMatchups.lineup.slice(0,9).map(b => _statcastCache?.batters?.[String(b.id)] || null),
            awayArsenal: _statcastCache?.pitchers?.[String(awayPitcherInfo.id)]?.arsenal ? { arsenal: _statcastCache.pitchers[String(awayPitcherInfo.id)].arsenal } : null,
            homeArsenal: _statcastCache?.pitchers?.[String(homePitcherInfo.id)]?.arsenal ? { arsenal: _statcastCache.pitchers[String(homePitcherInfo.id)].arsenal } : null,
            awayBullpenObj: awayBullpen || null, homeBullpenObj: homeBullpen || null,
            parkFactors: getParkFactors(game.home_team, venueName),
            weather: weather ? { wxHR: (() => { if (!weather || weather.dome) return 1.0; let mult = 1.0; const temp = weather.temp || 72; const effWind = weather.effWind || 0; const flags = weather.flags || []; if (temp >= 90) mult *= 1.07; else if (temp >= 82) mult *= 1.04; else if (temp <= 45) mult *= 0.88; else if (temp <= 55) mult *= 0.93; if (flags.some(f => (f||'').includes('OUT to CF'))) mult *= 1 + Math.min(effWind * 0.009, 0.16); if (flags.some(f => (f||'').includes('IN from CF'))) mult *= 1 - Math.min(effWind * 0.009, 0.13); return mult; })() } : null,
            totalLine: parseFloat(lines.total) || null, f5Line: f5Lines?.f5Total || null,
          });
          analysis.simAwayRuns = +simProbs.meanAway.toFixed(2);
          analysis.simHomeRuns = +simProbs.meanHome.toFixed(2);
          const simMl = pickSide([{ ev: evPct(simProbs.pAwayML, lines.awayML), label: 'AWAY' }, { ev: evPct(simProbs.pHomeML, lines.homeML), label: 'HOME' }]);
          analysis.simMl = simMl ? verdictFor(simMl.ev, simMl.label) : 'SKIP';
          analysis.simMlEV = simMl ? simMl.ev : null;
          const aRLpt = parseFloat(lines.awayRL);
          const awayIsFav = !isNaN(aRLpt) ? aRLpt < 0 : (parseFloat(lines.awayML) < parseFloat(lines.homeML));
          let simPAwayRL, simPHomeRL;
          if (simProbs.pAwayBy2 != null && simProbs.pHomeBy2 != null) { simPAwayRL = awayIsFav ? simProbs.pAwayBy2 : (1 - simProbs.pHomeBy2); simPHomeRL = awayIsFav ? (1 - simProbs.pAwayBy2) : simProbs.pHomeBy2; }
          else { simPAwayRL = simProbs.pAwayRL; simPHomeRL = simProbs.pHomeRL; }
          const simRl = pickSide([{ ev: evPct(simPAwayRL, lines.awayRLOdds), label: 'AWAY' }, { ev: evPct(simPHomeRL, lines.homeRLOdds), label: 'HOME' }]);
          analysis.simRl = simRl ? verdictFor(simRl.ev, simRl.label) : 'SKIP';
          analysis.simRlEV = simRl ? simRl.ev : null;
          const simTot = pickSide([{ ev: evPct(simProbs.pOver, lines.overOdds), label: 'OVER' }, { ev: evPct(simProbs.pUnder, lines.underOdds), label: 'UNDER' }]);
          analysis.simTotal = simTot ? verdictFor(simTot.ev, simTot.label) : 'SKIP';
          analysis.simTotalEV = simTot ? simTot.ev : null;
          console.log(`  SIM ${game.away_team} ${analysis.simAwayRuns} - ${analysis.simHomeRuns} ${game.home_team} | ML:${analysis.simMl} RL:${analysis.simRl} TOT:${analysis.simTotal}`);
        }
      } catch (e) { console.log(`  sim shadow error: ${e.message}`); }

      // ── SWEEP FADE ────────────────────────────────────────────────────────
      const _gd = new Date(game.commence_time).toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
      let sweepSide = null;
      const sgn = sg?.seriesGameNumber || 0;
      if (sgn >= 3 && awayTeamId && homeTeamId) { try { sweepSide = await fetchSeriesSweepSide(awayTeamId, homeTeamId, _gd, sgn, sg?.gamePk || null); } catch(e) { /* best-effort */ } if (sweepSide) console.log(`  ⚑ sweep spot: ${sweepSide} in position to sweep (series G${sgn}) — fading their +EV ML/RL`); }

      deriveRunModel(analysis, lines);
      deriveNumbers(analysis, lines, f5Lines, sweepSide, _gd);

      await upsertGame(game, lines, analysis, anData, f5Lines, weather, awayPitcherInfo, homePitcherInfo, awayStatcast, homeStatcast, awayMatchups, homeMatchups, pitcherStatus, resolvedGamePk, detProj, detPlusProj, detPlusVerdicts);

      const ap = awayPitcherInfo?.name || 'TBD', hp = homePitcherInfo?.name || 'TBD';
      console.log(`  ✓ ${game.away_team} @ ${game.home_team} | ${ap} vs ${hp} | ${lines.total} | ${weather?.summary||'dome/no weather'}`);
      await new Promise(r => setTimeout(r, 2500));
    } catch(err) { console.error(`  ✗ ${game.away_team} @ ${game.home_team}:`, err.message); }
  }

  console.log(`\n✅ Done — ${todayGames.length} games`);
  await settlePendingBets();
  await settleGameScores();
  await computeClvFromBooks();
}

main();
