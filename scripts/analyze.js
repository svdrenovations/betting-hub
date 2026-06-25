#!/usr/bin/env node

const ODDS_API_KEY = process.env.ODDS_API_KEY;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const WEATHER_API_KEY = process.env.WEATHER_API_KEY;
const RUN_TYPE = process.env.RUN_TYPE || '11am';

// ── LINE FEED INTEGRITY ────────────────────────────────────────────────────
// Bookmaker priority for picking which book's price we read. The OLD code took
// the first book in the API's array (effectively random, and NOT the book you
// bet at) — that's why a pulled line could read -104 while real DraftKings was
// +108. Pinning to ONE book does two things: (1) the pulled price matches what
// you actually see in your app, and (2) the bet price and the closing price come
// from the SAME book, which is the only way CLV is apples-to-apples.
//   >>> PUT THE BOOK YOU ACTUALLY BET AT FIRST. <<<  Everything after it is a
//   fallback used only when your book has no usable PRE-GAME line for a game.
const PREFERRED_BOOKS = ['draftkings','fanduel','betmgm','caesars','betrivers','pointsbetus','williamhill_us'];

// A pre-game line whose book hasn't updated in this many minutes gets FLAGGED as
// stale (still usable, but you'll see it in the log). The hard reject is in-play,
// handled separately: any book whose last_update is AFTER first pitch is a live
// price, not a closing line, and is skipped entirely.
const STALE_MIN = 30;
// ────────────────────────────────────────────────────────────────────────────

// Once a game is analyzed, the heartbeat re-snapshots its closing line only inside this many
// minutes before first pitch (each tick re-captures; the last pre-pitch one becomes the close).
// Outside this window an already-analyzed game costs nothing — no odds pull. Tune vs cadence:
// a game analyzed closer to pitch than this still gets caught on the next tick before start.
const REFRESH_WINDOW_MIN = 30;

const { simulateGame } = require('./sim-data.js'); // Monte Carlo run sim (shadow mode)

// Standard deviation of MLB game total runs, used to convert a projected total
// into a win probability. ~4.5 reflects real game variance + projection error.
// TUNE THIS from your own settled-bet results during calibration — lower = more
// confident (bigger edges/EV), higher = more conservative. Keep it identical to
// the TOTAL_SD in index.html or the card and modal will disagree.
const TOTAL_SD = 5.5;

// Standard deviation of the run differential (away runs - home runs). Converts a
// projected run margin into ML / RL win probabilities. ~4.0 matches real MLB
// single-game margin variance. TUNE from your ML/RL results — higher pulls
// probabilities toward 50% (more conservative). Lives only here; the frontend
// reads the stored probabilities, so no need to mirror it in index.html.
const MARGIN_SD = 4.0;

// Overall strength of the day-game shadow / scoring-distribution effect. Small and
// conservative on purpose — this is an APPROXIMATION (we can't ray-trace the shadow
// line without per-park structure heights), so it should nudge, not swing. Raise it
// only if a backtest of day-game inning splits (e.g. Oracle F5 vs innings 6-9)
// shows a real, unpriced front-load.
const SHADOW_STRENGTH = 0.35;

// Action-label thresholds, in EV percentage points. The verdict word (BET / LEAN /
// SKIP) is now derived from each market's recomputed EV — NOT from the model's gut —
// so the label can never contradict the number. A "BET" should clear the noise floor
// of model error; "LEAN" is a real-but-thin edge; below that is a pass. TUNE these as
// CLV and settled-bet ROI come in: if "BET"-labeled plays aren't beating the close,
// raise VERDICT_BET; if you're passing on profitable thin edges, lower VERDICT_LEAN.
// Calibration (Jun 2026): plays below ~6% claimed EV realized a coin flip / net loss — the
// model overstates EV at the low end — so the floor was raised from 2% to 6%. Above 6% the
// realized rate was ~67%. Revisit once a probability calibration is fit on more settled plays.
const VERDICT_BET = 10;  // EV% ≥ this → BET (high conviction)
const VERDICT_LEAN = 6;  // EV% in [VERDICT_LEAN, VERDICT_BET) → LEAN; below 6% → SKIP (not flagged)
// Max-juice floor: the worst price a play's "max:" will show. Tied to the play gate so the
// line-shopping range never drops you below a flagged bet — shop down only while EV stays ≥ 6%.
const MAXJUICE_EV = VERDICT_LEAN;

// Sweep-spot fade (situational overlay — domain knowledge layered on the model's math). In a series
// where one team has won every game so far, fade the team in position to complete the sweep when the
// model's +EV play is on them; the side facing the sweep is motivated in a way the price misses.
// Off from this date onward — late-season buyer/seller splits and motivation divergence break the
// angle. It's a knob: tune the cutoff from how the flagged plays actually resolve.
const SWEEP_FADE_UNTIL = '2026-08-01';

// MLB park coordinates and orientation
// homeplateFacing = compass direction home plate faces (degrees)
// Wind blowing FROM opposite direction = blowing OUT to CF
const PARK_COORDS = {
  'Arizona Diamondbacks': { lat: 33.4453, lon: -112.0667, dome: true },
  'Atlanta Braves': { lat: 33.8908, lon: -84.4681, dome: false , homeplateFacing: 15},
  'Baltimore Orioles': { lat: 39.2838, lon: -76.6218, dome: false , homeplateFacing: 95},
  'Boston Red Sox': { lat: 42.3467, lon: -71.0972, dome: false , homeplateFacing: 95},
  'Chicago Cubs': { lat: 41.9484, lon: -87.6553, dome: false , homeplateFacing: 140},
  'Chicago White Sox': { lat: 41.8300, lon: -87.6339, dome: false , homeplateFacing: 135},
  'Cincinnati Reds': { lat: 39.0979, lon: -84.5082, dome: false , homeplateFacing: 0},
  'Cleveland Guardians': { lat: 41.4962, lon: -81.6852, dome: false , homeplateFacing: 150},
  'Colorado Rockies': { lat: 39.7559, lon: -104.9942, dome: false , homeplateFacing: 20},
  'Detroit Tigers': { lat: 42.3390, lon: -83.0485, dome: false , homeplateFacing: 170},
  'Houston Astros': { lat: 29.7573, lon: -95.3555, dome: true },
  'Kansas City Royals': { lat: 39.0517, lon: -94.4803, dome: false , homeplateFacing: 5},
  'Los Angeles Angels': { lat: 33.8003, lon: -117.8827, dome: false , homeplateFacing: 180},
  'Los Angeles Dodgers': { lat: 34.0739, lon: -118.2400, dome: false , homeplateFacing: 335},
  'Miami Marlins': { lat: 25.7781, lon: -80.2197, dome: true },
  'Milwaukee Brewers': { lat: 43.0280, lon: -87.9712, dome: true },
  'Minnesota Twins': { lat: 44.9817, lon: -93.2777, dome: false , homeplateFacing: 100},
  'New York Mets': { lat: 40.7571, lon: -73.8458, dome: false , homeplateFacing: 335},
  'New York Yankees': { lat: 40.8296, lon: -73.9262, dome: false , homeplateFacing: 325},
  'Athletics': { lat: 38.5803, lon: -121.5135, dome: false , homeplateFacing: 30},
  'Philadelphia Phillies': { lat: 39.9061, lon: -75.1665, dome: false , homeplateFacing: 340},
  'Pittsburgh Pirates': { lat: 40.4469, lon: -80.0057, dome: false , homeplateFacing: 30},
  'San Diego Padres': { lat: 32.7076, lon: -117.1570, dome: false , homeplateFacing: 300},
  'San Francisco Giants': { lat: 37.7786, lon: -122.3893, dome: false , homeplateFacing: 30},
  'Seattle Mariners': { lat: 47.5914, lon: -122.3325, dome: true },
  'St. Louis Cardinals': { lat: 38.6226, lon: -90.1928, dome: false , homeplateFacing: 108},
  'Tampa Bay Rays': { lat: 27.7683, lon: -82.6534, dome: true },
  'Texas Rangers': { lat: 32.7473, lon: -97.0845, dome: true },
  'Toronto Blue Jays': { lat: 43.6414, lon: -79.3894, dome: true },
  'Washington Nationals': { lat: 38.8730, lon: -77.0074, dome: false , homeplateFacing: 80}
};

// Per-park factors — starting estimates, all meant to be TUNED from your own results.
//   runFactor:   run-environment multiplier (1.0 neutral; >1 hitter-friendly)
//   windFactor:  how much the park actually plays the wind (Wrigley high, shielded low; 0 = roofed)
//   shadowSusc:  0-1 day-game shadow susceptibility (Oracle/Dodger high)
//   retractable: roof that can be open or closed game-to-game (vs fixed dome)
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

// Non-standard / neutral-site venues, resolved by the schedule's actual venue name
// rather than the team's usual home park. Handles the A's 2026 Las Vegas homestand,
// future international/neutral-site series, etc. Values are tunable estimates.
const VENUE_PARKS = {
  'Las Vegas Ballpark': { lat: 36.1568, lon: -115.3289, dome: false, homeplateFacing: 30, runFactor: 1.12, windFactor: 1.05, shadowSusc: 0.40, retractable: false },
  'Sutter Health Park': { lat: 38.5803, lon: -121.5135, dome: false, homeplateFacing: 30, runFactor: 1.09, windFactor: 1.00, shadowSusc: 0.40, retractable: false }
};

function lookupCoords(team, venue) {
  if (venue && VENUE_PARKS[venue]) { const v = VENUE_PARKS[venue]; return { lat: v.lat, lon: v.lon, dome: v.dome, homeplateFacing: v.homeplateFacing }; }
  let park = PARK_COORDS[team];
  if (!park) {
    const key = Object.keys(PARK_COORDS).find(k => k.includes(team.split(' ').pop()) || team.includes(k.split(' ').pop()));
    if (key) park = PARK_COORDS[key];
  }
  return park || null;
}

function getParkFactors(team, venue) {
  if (venue && VENUE_PARKS[venue]) { const v = VENUE_PARKS[venue]; return { runFactor: v.runFactor, windFactor: v.windFactor, shadowSusc: v.shadowSusc, retractable: v.retractable }; }
  let f = PARK_FACTORS[team];
  if (!f) {
    const key = Object.keys(PARK_FACTORS).find(k => k.includes(team.split(' ').pop()) || team.includes(k.split(' ').pop()));
    if (key) f = PARK_FACTORS[key];
  }
  return f || { runFactor: 1.0, windFactor: 1.0, shadowSusc: 0.4, retractable: false };
}

// Sun elevation + azimuth (degrees) for a lat/lon at a given UTC Date. NOAA-style approximation.
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

// Day-game shadow / scoring-distribution profile. Returns a SMALL, tunable front-load:
// early innings slightly up (high sun, warm, no shadow line), mid-late innings down
// (shadow transition + cooling). APPROXIMATE — magnitude = SHADOW_STRENGTH x park
// susceptibility x how far the sun falls. Tune from a backtest, do not trust as-is.
function shadowProfile(homeTeam, gameTime, venue) {
  try {
    const park = lookupCoords(homeTeam, venue);
    const pf = getParkFactors(homeTeam, venue);
    if (!park || park.dome) return null;          // roofed -> no shadows
    const susc = pf.shadowSusc || 0;
    if (susc <= 0) return null;
    const start = new Date(gameTime);
    const sun0 = solarPosition(park.lat, park.lon, start);
    if (sun0.elevation < 25) return null;         // evening start / sun too low -> no clean day-game front-load
    const sun5 = solarPosition(park.lat, park.lon, new Date(start.getTime() + 90 * 60000));  // ~inning 5
    const sun8 = solarPosition(park.lat, park.lon, new Date(start.getTime() + 165 * 60000)); // ~inning 8
    if (sun8.elevation < 10) return null;         // sun setting / under lights by late innings -> no differential
    // Differential is worst when the LATE sun sits in the long-forward-shadow band (~15-45 deg).
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
    return {
      isDay: true,
      sun: { start: +sun0.elevation.toFixed(0), mid: +sun5.elevation.toFixed(0), late: +sun8.elevation.toFixed(0) },
      earlyRuns, lateRuns,
      note: `Day game, sun ${sun0.elevation.toFixed(0)}deg->${sun8.elevation.toFixed(0)}deg (park shadow susc ${susc}). Mild front-load: F5 ~+${earlyRuns} run, innings 6-9 ~${lateRuns} run. APPROXIMATE — tune from backtest.`
    };
  } catch(e) { return null; }
}

/* =============================================================================
   EV / BREAKEVEN / JUICE — SINGLE SOURCE OF TRUTH = PROBABILITY
   All EV / breakeven / juice numbers are recomputed from the probabilities +
   projections the model returns, using the real book odds. Card and modal agree
   because both derive from the same probability. Juice table is built
   structurally so the direction is always correct.
   ============================================================================= */

function payoutMult(odds) {
  const n = parseFloat(odds);
  if (isNaN(n)) return null;
  return n > 0 ? n / 100 : 100 / Math.abs(n);
}

// ─── DETERMINISTIC RUN PROJECTION ENGINE ────────────────────────────────────
const LEAGUE_AVG_RUNS = 4.40;
const LEAGUE_AVG_ERA  = 4.20;
const LEAGUE_AVG_OPS  = 0.720;

function computePitcherFactor(pitcherDetail, statcast, lineupMatchups, arsenalMatchup, isPitcherHome, offenseHandedness) {
  if (!pitcherDetail) return 1.0;

  // ── ERA component — use home/away split when available ────────────────────
  const seasonERA = parseFloat(pitcherDetail.era || LEAGUE_AVG_ERA);
  const rawRecentERA = parseFloat(pitcherDetail.recentERA || seasonERA);
  // Cap recent ERA at 3x season ERA — prevents 1-2 bad starts from dominating projection
  const recentERA = Math.min(rawRecentERA, Math.max(seasonERA * 3.0, 9.0));

  // Home/away ERA split: pitcher at home vs on road
  let splitERA = seasonERA;
  if (isPitcherHome && pitcherDetail.homeERA) {
    splitERA = parseFloat(pitcherDetail.homeERA);
  } else if (!isPitcherHome && pitcherDetail.awayERA) {
    splitERA = parseFloat(pitcherDetail.awayERA);
  }

  // Venue-specific ERA if available
  if (pitcherDetail.venueERA) {
    splitERA = (splitERA + parseFloat(pitcherDetail.venueERA)) / 2;
  }

  // Three-way blend: season (60%) + split (20%) + recent (20%)
  // Recent ERA is a small signal only — arsenal vs lineup matchup does the heavy lifting
  const blendedERA = (seasonERA * 0.60) + (splitERA * 0.20) + (recentERA * 0.20);
  let eraFactor = Math.min(Math.max(blendedERA / LEAGUE_AVG_ERA, 0.65), 1.65);

  // ── vs Batter handedness split ────────────────────────────────────────────
  let handednessFactor = 1.0;
  if (offenseHandedness && (pitcherDetail.vsLHB || pitcherDetail.vsRHB)) {
    const { L = 0, R = 0, S = 0 } = offenseHandedness;
    const total = L + R + S;
    if (total > 0) {
      let blendedOPS = 0;
      if (pitcherDetail.vsLHB && L > 0) blendedOPS += (parseFloat(pitcherDetail.vsLHB.ops || LEAGUE_AVG_OPS) * L);
      if (pitcherDetail.vsRHB && R > 0) blendedOPS += (parseFloat(pitcherDetail.vsRHB.ops || LEAGUE_AVG_OPS) * R);
      if (S > 0) blendedOPS += (LEAGUE_AVG_OPS * S); // switch hitters: league avg
      blendedOPS /= total;
      handednessFactor = Math.min(Math.max(blendedOPS / LEAGUE_AVG_OPS, 0.85), 1.15);
    }
  }

  // ── Statcast component ─────────────────────────────────────────────────────
  let statcastAdj = 1.0;
  if (statcast) {
    if (statcast.whiffRate != null) {
      const w = parseFloat(statcast.whiffRate);
      if (!isNaN(w)) statcastAdj *= Math.min(Math.max(1 - ((w - 25) * 0.010), 0.82), 1.18);
    }
    if (statcast.hardHitRate != null) {
      const hh = parseFloat(statcast.hardHitRate);
      if (!isNaN(hh)) statcastAdj *= Math.min(Math.max(1 + ((hh - 38) * 0.008), 0.86), 1.14);
    }
    if (statcast.barrelRate != null) {
      const br = parseFloat(statcast.barrelRate);
      if (!isNaN(br)) statcastAdj *= Math.min(Math.max(1 + ((br - 8) * 0.012), 0.88), 1.12);
    }
    if (statcast.veloTrend === 'DOWN') statcastAdj *= 1.09;
    else if (statcast.veloTrend === 'UP') statcastAdj *= 0.95;
  }

  // ── Pitcher vs this specific lineup history ───────────────────────────────
  let matchupAdj = 1.0;
  if (lineupMatchups?.avgOPS != null) {
    const matchupOPS = parseFloat(lineupMatchups.avgOPS);
    if (!isNaN(matchupOPS) && matchupOPS > 0) {
      matchupAdj = Math.min(Math.max(matchupOPS / LEAGUE_AVG_OPS, 0.70), 1.40);
    }
    if (lineupMatchups.kRate != null) {
      const k = parseFloat(lineupMatchups.kRate);
      if (!isNaN(k)) matchupAdj *= Math.min(Math.max(1 - ((k - 22) * 0.005), 0.90), 1.10);
    }
  }

  // ── Arsenal vs swing path ─────────────────────────────────────────────────
  let arsenalAdj = 1.0;
  if (arsenalMatchup?.overallEdge === 'PITCHER DOMINATES') arsenalAdj = 0.92;
  else if (arsenalMatchup?.overallEdge === 'LINEUP ADVANTAGE') arsenalAdj = 1.08;

  // ── Innings / bullpen exposure ────────────────────────────────────────────
  const avgIP = parseFloat(pitcherDetail.avgIP || 6.0);
  const inningsFactor = avgIP < 4.5 ? 1.10 : avgIP < 5.0 ? 1.06 : avgIP < 5.5 ? 1.03 : 1.0;

  return eraFactor * handednessFactor * statcastAdj * matchupAdj * arsenalAdj * inningsFactor;
}

function computeOffenseFactor(teamStats, lineupMatchups, lineupOrder, isHome) {
  if (!teamStats) return 1.0;

  // Use home/away split OPS when available — more predictive than season average
  let teamOPS;
  if (isHome && teamStats.homeOPS) {
    teamOPS = parseFloat(teamStats.homeOPS);
  } else if (!isHome && teamStats.awayOPS) {
    teamOPS = parseFloat(teamStats.awayOPS);
  } else {
    teamOPS = parseFloat(teamStats.ops || LEAGUE_AVG_OPS);
  }

  let opsFactor = teamOPS / LEAGUE_AVG_OPS;

  // If we have specific lineup vs pitcher matchup data, blend it in
  if (lineupMatchups?.avgOPS) {
    const matchupOPS = parseFloat(lineupMatchups.avgOPS);
    // Matchup-specific OPS weighted 50%, split OPS weighted 50%
    opsFactor = ((matchupOPS * 0.50) + (teamOPS * 0.50)) / LEAGUE_AVG_OPS;
  }

  // K rate adjustment
  if (lineupMatchups?.kRate) {
    const kAdj = 1 - ((parseFloat(lineupMatchups.kRate) - 22.0) * 0.004);
    opsFactor *= Math.min(Math.max(kAdj, 0.90), 1.10);
  }

  // Lineup order quality
  if (lineupOrder?.length >= 4) {
    const top4 = lineupOrder.slice(0, 4).map(b => parseFloat(b.ops || 0)).filter(o => !isNaN(o) && o > 0);
    if (top4.length >= 3) {
      const top4Avg = top4.reduce((s, o) => s + o, 0) / top4.length;
      opsFactor = opsFactor * 0.70 + (top4Avg / LEAGUE_AVG_OPS) * 0.30;
    }
  }

  return Math.min(Math.max(opsFactor, 0.55), 1.55);
}

function computeWeatherRunFactor(weather, parkFactors) {
  if (!weather || weather.dome || parkFactors?.dome) return 1.0;
  let mult = 1.0;
  const temp = weather.temp || 72;
  const effWind = weather.effWind || 0;
  const flags = weather.flags || [];
  if (temp >= 90) mult *= 1.05; else if (temp >= 80) mult *= 1.02;
  else if (temp <= 50) mult *= 0.95; else if (temp <= 40) mult *= 0.90;
  if (flags.some(f => (f||'').includes('OUT'))) mult *= 1 + Math.min(effWind * 0.006, 0.12);
  else if (flags.some(f => (f||'').includes('IN'))) mult *= 1 - Math.min(effWind * 0.005, 0.10);
  return Math.min(Math.max(mult, 0.88), 1.18);
}

function computeUmpireRunFactor(umpire) {
  if (!umpire?.runsPerGame) return 1.0;
  const rpg = parseFloat(umpire.runsPerGame);
  return isNaN(rpg) ? 1.0 : Math.min(Math.max(rpg / 8.8, 0.93), 1.07);
}

function computeBullpenRunFactor(bullpen, pitcherDetail) {
  const avgIP = parseFloat(pitcherDetail?.avgIP || 6.0);
  if (avgIP >= 5.5 || !bullpen) return 1.0;
  const bullpenERA = parseFloat(bullpen.weightedERA || LEAGUE_AVG_ERA);
  const penWeight = Math.max(0, 9 - avgIP) / 9;
  return 1 + (bullpenERA / LEAGUE_AVG_ERA - 1) * penWeight * 0.5;
}

function computePlatoonRunFactor(pitcherHand, lineupHandedness) {
  if (!pitcherHand || !lineupHandedness) return 1.0;
  const { L = 0, R = 0 } = lineupHandedness;
  const total = L + R + (lineupHandedness.S || 0);
  if (!total) return 1.0;
  const samePct = pitcherHand === 'R' ? R / total : L / total;
  const oppPct  = pitcherHand === 'R' ? L / total : R / total;
  return Math.min(Math.max(1.0 - (samePct * 0.03) + (oppPct * 0.03), 0.94), 1.06);
}

function projectRuns({ offenseStats, offenseMatchups, offenseOrder, offenseHandedness, isOffenseHome, defPitcher, defStatcast, defPitcherHand, isPitcherHome, defBullpen, parkFactors, weather, umpire, arsenalMatchup }) {
  // ── Starter expected runs ─────────────────────────────────────────────────
  // ERA per 9 × expected IP / 9 = starter runs allowed
  const avgIP   = parseFloat(defPitcher?.avgIP || 6.0);
  const starterERA = (() => {
    if (!defPitcher) return LEAGUE_AVG_ERA;
    const seasonERA = parseFloat(defPitcher.era || LEAGUE_AVG_ERA);
    const rawRecent = parseFloat(defPitcher.recentERA || seasonERA);
    const recentERA = Math.min(rawRecent, Math.max(seasonERA * 3.0, 9.0));
    const splitERA  = isPitcherHome && defPitcher.homeERA ? parseFloat(defPitcher.homeERA)
                    : !isPitcherHome && defPitcher.awayERA ? parseFloat(defPitcher.awayERA)
                    : seasonERA;
    return (seasonERA * 0.60) + (splitERA * 0.20) + (recentERA * 0.20);
  })();
  const starterRuns = (starterERA / 9) * avgIP;

  // ── Bullpen expected runs ─────────────────────────────────────────────────
  const bullpenIP   = Math.max(0, 9 - avgIP);
  const bullpenERA  = parseFloat(defBullpen?.weightedERA || LEAGUE_AVG_ERA);
  const bullpenRuns = (bullpenERA / 9) * bullpenIP;

  // ── Total baseline runs allowed ───────────────────────────────────────────
  const baselineRuns = starterRuns + bullpenRuns;

  // ── Offense factor ────────────────────────────────────────────────────────
  const of_  = computeOffenseFactor(offenseStats, offenseMatchups, offenseOrder, isOffenseHome);

  // ── Context factors ───────────────────────────────────────────────────────
  const park = parseFloat(parkFactors?.runFactor || 1.0);
  const wx   = computeWeatherRunFactor(weather, parkFactors);
  const ump  = computeUmpireRunFactor(umpire);
  const plat = computePlatoonRunFactor(defPitcherHand, offenseHandedness);

  // ── Statcast adjustments on starter ──────────────────────────────────────
  let statcastAdj = 1.0;
  if (defStatcast) {
    if (defStatcast.whiffRate != null) {
      const w = parseFloat(defStatcast.whiffRate);
      if (!isNaN(w)) statcastAdj *= Math.min(Math.max(1 - ((w - 25) * 0.010), 0.85), 1.15);
    }
    if (defStatcast.hardHitRate != null) {
      const hh = parseFloat(defStatcast.hardHitRate);
      if (!isNaN(hh)) statcastAdj *= Math.min(Math.max(1 + ((hh - 38) * 0.008), 0.88), 1.12);
    }
    if (defStatcast.veloTrend === 'DOWN') statcastAdj *= 1.06;
    else if (defStatcast.veloTrend === 'UP') statcastAdj *= 0.96;
  }

  // ── Arsenal matchup adjustment ────────────────────────────────────────────
  let arsenalAdj = 1.0;
  if (arsenalMatchup?.overallEdge === 'PITCHER DOMINATES') arsenalAdj = 0.92;
  else if (arsenalMatchup?.overallEdge === 'LINEUP ADVANTAGE') arsenalAdj = 1.08;

  // ── Final projection ──────────────────────────────────────────────────────
  const raw = baselineRuns * of_ * park * wx * ump * plat * statcastAdj * arsenalAdj;

  const factors = {
    starterERA: +starterERA.toFixed(2),
    starterRuns: +starterRuns.toFixed(2),
    bullpenRuns: +bullpenRuns.toFixed(2),
    avgIP: +avgIP.toFixed(1),
    offense: +of_.toFixed(3),
    park: +park.toFixed(3),
    weather: +wx.toFixed(3),
    statcast: +statcastAdj.toFixed(3),
    arsenal: +arsenalAdj.toFixed(3),
    platoon: +plat.toFixed(3)
  };

  return {
    runs: +Math.max(3.0, Math.min(raw, 9.5)).toFixed(2),
    factors
  };
}
// ─── END DETERMINISTIC PROJECTION ENGINE ─────────────────────────────────────

// EV% of a 1-unit bet at American `odds` given win probability `p` (0..1)
function evPct(p, odds) {
  const b = payoutMult(odds);
  if (b == null || !(p > 0)) return null;
  return +((p * b - (1 - p)) * 100).toFixed(1);
}

// Max-juice American odds for probability p — the WORST price at which EV still clears the
// MAXJUICE_EV gate (6%), not 0%. This is the line-shopping floor shown as "max:" on each play.
// Pass targetEvPct to override (e.g. 0 for the true mathematical breakeven).
function breakevenOdds(p, targetEvPct) {
  if (!(p > 0) || !(p < 1)) return null;
  const t = (targetEvPct == null ? MAXJUICE_EV : targetEvPct) / 100;  // EV% → fraction
  const b = (t + 1 - p) / p;          // net decimal payout needed so that EV = target
  if (!(b > 0)) return null;          // p so high no finite price reaches the target
  const o = b >= 1 ? b * 100 : -100 / b;
  const r = Math.round(o);
  return r > 0 ? `+${r}` : `${r}`;
}

// P(total goes OVER `line`) given a projected total. Same logistic the modal uses.
function totalsProbOver(line, proj) {
  if (!(proj > 0)) return null;
  const z = (parseFloat(line) - proj) / TOTAL_SD;
  return 1 / (1 + Math.exp(1.7 * z));
}

// Line-shopping table around the projection. Direction fixed to the verdict.
function buildJuiceTable(proj, direction, steps) {
  steps = steps || 5;
  const half = Math.floor(steps / 2);
  const lines = [];
  for (let i = -half; i <= half; i++) {
    const line = +(Math.round((proj + i * 0.5) * 2) / 2).toFixed(1);
    const pOver = totalsProbOver(line, proj);
    const p = direction === 'Over' ? pOver : 1 - pOver;
    const be = breakevenOdds(p);
    lines.push({
      line,
      direction,
      maxJuice: be != null ? parseInt(be, 10) : null,
      ev: evPct(p, -110)
    });
  }
  return { description: 'max juice at each line where the bet still clears the 6% EV gate (derived from projection)', lines };
}

// Overwrite every EV / breakeven / juice field from probabilities + real odds.
// From a list of {ev, label, ...} candidates, the one whose price the model's
// probability beats by the most. Skips candidates with no usable EV (missing odds).
function pickSide(opts) {
  let best = null;
  for (const o of opts) {
    if (o.ev == null || isNaN(o.ev)) continue;
    if (!best || o.ev > best.ev) best = o;
  }
  return best;
}
// EV (in %) → action word. Side is appended only when it's an actual play.
function verdictFor(ev, sideLabel) {
  if (ev == null || isNaN(ev) || ev < VERDICT_LEAN) return 'SKIP';
  return `${ev >= VERDICT_BET ? 'BET' : 'LEAN'} ${sideLabel}`;
}

// Overwrite every EV / breakeven / juice / verdict field from probabilities + real
// odds. The verdict is chosen by EV, not by the model's text, so "BET" always means
// the math found real edge — and the strongest-priced side is the one taken.
function deriveNumbers(a, lines, f5Lines, sweepSide, dateStr) {
  if (!a) return a;

  // Win probabilities from the run model (fall back to 50/50 if absent).
  const pAway = (a.mlAwayProb != null ? a.mlAwayProb : (a.awayWinPct != null ? a.awayWinPct : 50)) / 100;
  const pHome = (a.mlHomeProb != null ? a.mlHomeProb : (a.homeWinPct != null ? a.homeWinPct : 50)) / 100;

  // ── Moneyline: take whichever side the price misprices most ──
  {
    const side = pickSide([
      { ev: evPct(pAway, lines.awayML), label: 'AWAY', p: pAway },
      { ev: evPct(pHome, lines.homeML), label: 'HOME', p: pHome }
    ]);
    if (side) { a.mlEV = side.ev; a.mlBreakeven = breakevenOdds(side.p); a.ml = verdictFor(side.ev, side.label); }
    else { a.ml = 'SKIP'; }
  }

  // ── Run line: use run-model cover probs if present, else ±8 pts ──
  const pAwayRL = a.rlAwayProb != null ? a.rlAwayProb / 100 : Math.max(0.02, pAway - 0.08);
  const pHomeRL = a.rlHomeProb != null ? a.rlHomeProb / 100 : Math.min(0.98, pHome + 0.08);
  {
    const side = pickSide([
      { ev: evPct(pAwayRL, lines.awayRLOdds), label: 'AWAY', p: pAwayRL },
      { ev: evPct(pHomeRL, lines.homeRLOdds), label: 'HOME', p: pHomeRL }
    ]);
    if (side) { a.rlEV = side.ev; a.rlBreakeven = breakevenOdds(side.p); a.rl = verdictFor(side.ev, side.label); }
    else { a.rl = 'SKIP'; }
  }

  // ── Sweep-spot fade ─────────────────────────────────────────────────────────
  // If a team is in position to complete a series sweep and the model's +EV play is ON that team,
  // stand down (ML/RL only — totals untouched). Records what the play would have been so the rule
  // can be measured later. Seasonally gated off near the deadline.
  if (sweepSide && (!dateStr || dateStr < SWEEP_FADE_UNTIL)) {
    const faded = [];
    for (const mkt of ['ml', 'rl']) {
      const v = a[mkt];
      if (typeof v === 'string' && v !== 'SKIP' && v.endsWith(` ${sweepSide}`)) {
        faded.push(`${mkt.toUpperCase()} ${v}`);
        a[mkt] = 'SKIP';
      }
    }
    if (faded.length) a.sweepFade = `sweep fade (${sweepSide} in position to sweep) — stood down: ${faded.join(', ')}`;
  }

  // ── Full-game total ──
  const proj = parseFloat(a.projTotal);
  const postedTotal = parseFloat(a.totalLine != null ? a.totalLine : lines.total);
  if (proj > 0 && !isNaN(postedTotal)) {
    a.totalLine = postedTotal; // store the line the verdict was actually graded against (model may have omitted it)
    const pOver = totalsProbOver(postedTotal, proj);
    const side = pickSide([
      { ev: evPct(pOver, lines.overOdds), label: 'OVER', p: pOver, dir: 'Over' },
      { ev: evPct(1 - pOver, lines.underOdds), label: 'UNDER', p: 1 - pOver, dir: 'Under' }
    ]);
    if (side) {
      a.totalEV = side.ev;
      const be = breakevenOdds(side.p);
      a.totalBreakeven = be ? `${side.dir} ${postedTotal} @ ${be}` : null;
      a.totalJuiceSensitivity = buildJuiceTable(proj, side.dir);
      a.total = verdictFor(side.ev, side.label);
    } else { a.total = 'SKIP'; }
  } else { a.total = 'SKIP'; }

  // ── F5: compare F5 total over/under AND F5 ML away/home, take the best ──
  const f5proj = parseFloat(a.f5ProjTotal);
  const f5line = parseFloat(a.f5Line != null ? a.f5Line : (f5Lines && f5Lines.f5Total));
  {
    const opts = [];
    if (f5proj > 0 && !isNaN(f5line)) {
      const pO = totalsProbOver(f5line, f5proj);
      opts.push({ ev: evPct(pO, f5Lines && f5Lines.f5OverOdds), label: 'OVER', p: pO, dir: 'Over' });
      opts.push({ ev: evPct(1 - pO, f5Lines && f5Lines.f5UnderOdds), label: 'UNDER', p: 1 - pO, dir: 'Under' });
    }
    opts.push({ ev: evPct(pAway, f5Lines && f5Lines.f5AwayML), label: 'AWAY' });
    opts.push({ ev: evPct(pHome, f5Lines && f5Lines.f5HomeML), label: 'HOME' });
    const side = pickSide(opts);
    if (side) {
      a.f5EV = side.ev;
      if (side.dir) {
        const be = breakevenOdds(side.p);
        a.f5Breakeven = be ? `${side.dir} ${f5line} @ ${be}` : null;
        a.f5JuiceSensitivity = buildJuiceTable(f5proj, side.dir, 3);
      }
      a.f5 = verdictFor(side.ev, side.label);
    } else { a.f5 = 'SKIP'; }
  }

  // ── Best market = highest-EV market that clears the LEAN floor ──
  const evByMarket = { ml: a.mlEV, rl: a.rlEV, total: a.totalEV, f5: a.f5EV };
  let bestMkt = null, bestEv = -Infinity;
  for (const k of ['ml','rl','total','f5']) {
    if (a[k] === 'SKIP') continue;          // a faded or sub-threshold market can't be the best play
    const e = evByMarket[k];
    if (e != null && !isNaN(e) && e > bestEv) { bestEv = e; bestMkt = k; }
  }
  a.best = (bestMkt && bestEv >= VERDICT_LEAN) ? bestMkt : null;
  if (a.best) a.edgePct = evByMarket[a.best];

  return a;
}

// Standard normal CDF (Abramowitz-Stegun 26.2.17), good to ~1e-7.
function normCdf(x) {
  const t = 1 / (1 + 0.2316419 * Math.abs(x));
  const d = 0.3989423 * Math.exp(-x * x / 2);
  const p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
  return x > 0 ? 1 - p : p;
}

// Turn the model's per-team run projections into ML + RL probabilities via a
// normal model of the run margin. One run engine feeds ML, RL, and total — no
// more gut ML number or ±0.08 RL hack. Falls back silently if the model didn't
// return per-team runs.
function deriveRunModel(a, lines) {
  if (!a) return a;
  // Enforce minimum 3.0 runs per team — no MLB team ever averages below this
  const la = Math.max(3.0, parseFloat(a.projAwayRuns));
  const lb = Math.max(3.0, parseFloat(a.projHomeRuns));
  // Write back the floored values so card display is also correct
  a.projAwayRuns = la;
  a.projHomeRuns = lb;
  if (!(la >= 0) || !(lb >= 0)) return a;
  const mu = la - lb;

  // ML: P(away wins) ~ P(margin >= 1), P(home wins) ~ P(margin <= -1).
  // Normalize out the no-tie gap since MLB games can't end tied.
  const pAwayRaw = 1 - normCdf((0.5 - mu) / MARGIN_SD);
  const pHomeRaw = normCdf((-0.5 - mu) / MARGIN_SD);
  const denom = (pAwayRaw + pHomeRaw) || 1;
  a.mlAwayProb = +((pAwayRaw / denom) * 100).toFixed(1);
  a.mlHomeProb = +((pHomeRaw / denom) * 100).toFixed(1);
  a.awayWinPct = a.mlAwayProb;
  a.homeWinPct = a.mlHomeProb;

  // RL: use each side's ACTUAL run-line number (favorite -1.5, dog +1.5 — whichever
  // side is which). margin = away - home. Away covers if margin > -awayRLpt; home
  // covers if margin < homeRLpt.
  let awayRLpt = parseFloat(lines && lines.awayRL);
  let homeRLpt = parseFloat(lines && lines.homeRL);
  if (isNaN(awayRLpt)) awayRLpt = mu > 0 ? -1.5 : 1.5;
  if (isNaN(homeRLpt)) homeRLpt = mu > 0 ? 1.5 : -1.5;
  a.rlAwayProb = +((1 - normCdf((-awayRLpt - mu) / MARGIN_SD)) * 100).toFixed(1);
  a.rlHomeProb = +(normCdf((homeRLpt - mu) / MARGIN_SD) * 100).toFixed(1);

  // Keep the total tied to the same projection if the model didn't give one.
  if (a.projTotal == null || isNaN(parseFloat(a.projTotal))) a.projTotal = +(la + lb).toFixed(1);
  return a;
}

// ── ROOF STATUS SCRAPER ───────────────────────────────────────────────────────
// For teams that publish roof status publicly, scrape the actual status.
// For others, apply climate-based defaults from historical data.
const ROOF_STATUS_URLS = {
  'Arizona Diamondbacks': 'https://www.mlb.com/dbacks/ballpark/information/roof',
  'Milwaukee Brewers':    'https://www.mlb.com/brewers/ballpark/roof-status',
};

// Climate defaults for teams that DON'T publish status (based on historical open % data)
// Houston & Texas: close when temp >82°F or humid or rain — ~80-90% of summer games closed
// Miami: almost always closed — close when temp >75°F or rain
// Toronto: open most games except rain/cold
// Seattle: open when no rain and temp >55°F
const ROOF_CLIMATE_DEFAULTS = {
  'Houston Astros':      (temp, rainy) => temp > 82 || rainy ? 'closed' : 'open',
  'Texas Rangers':       (temp, rainy) => temp > 82 || rainy ? 'closed' : 'open',
  'Miami Marlins':       (temp, rainy) => temp > 75 || rainy ? 'closed' : 'open',
  'Toronto Blue Jays':   (temp, rainy) => rainy || temp < 50 ? 'closed' : 'open',
  'Seattle Mariners':    (temp, rainy) => rainy ? 'closed' : 'open',
};

async function fetchRoofStatus(homeTeam, gameDate, temp, rainy) {
  // 1. Try to scrape actual status for ARI and MIL
  const url = ROOF_STATUS_URLS[homeTeam];
  if (url) {
    try {
      const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
      if (res.ok) {
        const html = await res.text();
        // Look for the game date in the page (format: "June 21" or "Jun 21" or "6/21")
        const d = new Date(gameDate);
        const monthNames = ['January','February','March','April','May','June','July','August','September','October','November','December'];
        const monthShort = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
        const month = monthNames[d.getMonth()];
        const monthS = monthShort[d.getMonth()];
        const day = d.getDate();
        // Build regex to find date row and capture roof status nearby
        const datePatterns = [
          `${month}\\s+${day}`,
          `${monthS}\\.?\\s+${day}`,
          `${d.getMonth()+1}\\/${day}`,
        ];
        for (const pat of datePatterns) {
          const re = new RegExp(pat + '[^<]{0,200}?(open|closed)', 'i');
          const match = html.match(re);
          if (match) {
            const status = match[1].toLowerCase();
            console.log(`  Roof status for ${homeTeam} on ${gameDate}: ${status} (scraped)`);
            return status; // 'open' or 'closed'
          }
        }
        console.log(`  Roof page found for ${homeTeam} but no match for ${gameDate}`);
      }
    } catch(e) {
      console.log(`  Roof scrape error for ${homeTeam}:`, e.message);
    }
  }

  // 2. Apply climate default for teams without public status pages
  const defaultFn = ROOF_CLIMATE_DEFAULTS[homeTeam];
  if (defaultFn) {
    const status = defaultFn(temp, rainy);
    console.log(`  Roof status for ${homeTeam} on ${gameDate}: ${status} (climate default)`);
    return status;
  }

  // 3. No retractable roof — return null (non-retractable teams never reach this)
  return null;
}

// Fetch weather for home park
async function fetchWeather(homeTeam, gameTime, venue) {
  try {
    const park = lookupCoords(homeTeam, venue);
    if (!park) { console.log(`  No park found for ${homeTeam}`); return null; }
    const pf = getParkFactors(homeTeam, venue);
    if (park.dome && !pf.retractable) {
      return { dome: true, runFactor: pf.runFactor, description: 'Fixed-roof dome — weather not a factor' };
    }

    const res = await fetch(
      `https://api.openweathermap.org/data/2.5/forecast?lat=${park.lat}&lon=${park.lon}&appid=${WEATHER_API_KEY}&units=imperial`
    );
    if (!res.ok) return null;
    const data = await res.json();

    const gameTs = new Date(gameTime).getTime();
    const closest = data.list.reduce((best, item) => {
      const diff = Math.abs(new Date(item.dt * 1000).getTime() - gameTs);
      return !best || diff < Math.abs(new Date(best.dt * 1000).getTime() - gameTs) ? item : best;
    }, null);

    if (!closest) return null;

    const wind = closest.wind;
    const temp = Math.round(closest.main.temp);
    const desc = closest.weather[0].description;
    const windSpeed = Math.round(wind.speed);
    const windDeg = wind.deg;

    // Retractable roof: get actual status or climate default
    let roofOpenProb = 1;
    let roofStatusSource = 'n/a';
    if (park.dome && pf.retractable) {
      const rainy = /rain|storm|snow|drizzle/.test(desc);
      const gameDate = new Date(gameTime).toISOString().slice(0, 10);
      const actualStatus = await fetchRoofStatus(homeTeam, gameDate, temp, rainy);
      if (actualStatus === 'closed') {
        roofOpenProb = 0;
        roofStatusSource = 'confirmed closed';
      } else if (actualStatus === 'open') {
        roofOpenProb = 1;
        roofStatusSource = 'confirmed open';
      } else {
        // Fallback to weather heuristic
        roofOpenProb = (!rainy && temp >= 68 && temp <= 85) ? 0.6 : 0.15;
        roofStatusSource = 'estimated';
      }
    }
    // If roof is confirmed/estimated closed, weather is not a factor
    const roofClosed = !!(park.dome && pf.retractable && roofOpenProb <= 0.1);
    // Effective wind = raw wind x how much THIS park plays the wind x roof-open chance.
    const effWind = Math.round(windSpeed * (pf.windFactor || 1) * roofOpenProb);

    // Calculate wind direction relative to stadium
    const homeplateFacing = park.homeplateFacing || 0;

    // Wind blowing FROM a direction means it travels TO the opposite
    // If wind is FROM the west (270°) and home plate faces west, wind blows IN from CF
    // If wind is FROM the east (90°) and home plate faces west, wind blows OUT to CF

    // Angle between wind source and home plate facing
    const windFrom = windDeg; // meteorological: direction wind comes FROM
    const windTo = (windDeg + 180) % 360; // direction wind is going TO

    // Relative angle: how wind aligns with home plate to CF axis
    let relAngle = ((windTo - homeplateFacing) + 360) % 360;

    // Determine field direction
    let fieldWindDir, windImpact, windArrow;
    if (relAngle <= 45 || relAngle >= 315) {
      fieldWindDir = 'OUT to CF';
      windArrow = '↑';
      windImpact = effWind >= 10 ? 'over' : 'neutral';
    } else if (relAngle >= 135 && relAngle <= 225) {
      fieldWindDir = 'IN from CF';
      windArrow = '↓';
      windImpact = effWind >= 10 ? 'under' : 'neutral';
    } else if (relAngle > 45 && relAngle < 135) {
      fieldWindDir = 'L to R';
      windArrow = '→';
      windImpact = 'neutral';
    } else {
      fieldWindDir = 'R to L';
      windArrow = '←';
      windImpact = 'neutral';
    }

    // Cardinal direction wind is coming from
    const windCard = windDeg < 22.5 || windDeg >= 337.5 ? 'N' :
                     windDeg < 67.5 ? 'NE' : windDeg < 112.5 ? 'E' :
                     windDeg < 157.5 ? 'SE' : windDeg < 202.5 ? 'S' :
                     windDeg < 247.5 ? 'SW' : windDeg < 292.5 ? 'W' : 'NW';

    // Upgrade wind impact for strong winds
    if (effWind >= 18 && windImpact === 'over') windImpact = 'significant over';
    if (effWind >= 18 && windImpact === 'under') windImpact = 'significant under';
    if (roofClosed) windImpact = 'neutral';   // closed roof -> no wind effect regardless of the outside reading

    // Flag significant weather — suppress all flags if roof is closed
    const flags = [];
    if (!roofClosed) {
      if (effWind >= 15) flags.push(effWind >= 20 ? 'HIGH WIND' : 'WIND FACTOR');
      if (temp <= 45) flags.push('COLD WEATHER');
      if (temp >= 90) flags.push('HOT WEATHER');
      if (desc.includes('rain') || desc.includes('storm')) flags.push('RAIN RISK');
      if (effWind >= 10 && (fieldWindDir === 'OUT to CF' || fieldWindDir === 'IN from CF')) {
        flags.push(windImpact.toUpperCase());
      }
    }
    if (park.dome && pf.retractable) {
      const statusLabel = roofStatusSource === 'confirmed closed' ? 'CLOSED'
        : roofStatusSource === 'confirmed open' ? 'OPEN'
        : `~${Math.round(roofOpenProb*100)}% open (est.)`;
      flags.push(`RETRACTABLE ROOF (${statusLabel})`);
    }

    return {
      dome: false,
      temp,
      desc,
      windSpeed,
      effWind,
      windCard,
      fieldWindDir,
      windArrow,
      windImpact,
      runFactor: pf.runFactor,
      windFactor: pf.windFactor,
      retractable: !!(park.dome && pf.retractable),
      roofOpenProb,
      weatherNeutralized: roofClosed,
      flags,
      summary: roofClosed
        ? `${temp}°F, ${desc} (roof ${roofStatusSource} — weather neutralized)`
        : `${temp}°F, ${desc}, wind ${windSpeed}mph ${windCard} (${windArrow} ${fieldWindDir})${flags.length ? ' — ' + flags.join(', ') : ''}`
    };
  } catch(e) {
    console.log(`  Weather error for ${homeTeam}:`, e.message);
    return null;
  }
}

// Fetch MLB pitcher stats from MLB Stats API (free, no key needed)
async function fetchPitcherStats(pitcherName) {
  try {
    if (!pitcherName || pitcherName === 'TBD') return null;
    const lastName = pitcherName.split(' ').pop();
    const searchRes = await fetch(
      `https://statsapi.mlb.com/api/v1/people/search?names=${encodeURIComponent(lastName)}&sportId=1`
    );
    if (!searchRes.ok) return null;
    const searchData = await searchRes.json();
    const people = searchData.people || [];
    if (!people.length) return null;

    const pitcher = people.find(p =>
      p.fullName.toLowerCase().includes(pitcherName.toLowerCase().split(' ')[0].toLowerCase())
    ) || people[0];

    const statsRes = await fetch(
      `https://statsapi.mlb.com/api/v1/people/${pitcher.id}/stats?stats=season,gameLog&group=pitching&season=2026&limit=5`
    );
    if (!statsRes.ok) return null;
    const statsData = await statsRes.json();

    const seasonStats = statsData.stats?.find(s => s.type?.displayName === 'season')?.splits?.[0]?.stat;
    const gameLog = statsData.stats?.find(s => s.type?.displayName === 'gameLog')?.splits?.slice(0, 5) || [];

    if (!seasonStats) return null;

    const last3 = gameLog.slice(0, 3).map(g => ({
      era: g.stat?.era,
      ip: g.stat?.inningsPitched,
      er: g.stat?.earnedRuns,
      date: g.date
    }));

    const recentERA = last3.length > 0
      ? (last3.reduce((sum, g) => sum + parseFloat(g.er || 0), 0) /
         last3.reduce((sum, g) => sum + parseFloat(g.ip || 1), 0) * 9).toFixed(2)
      : null;

    const trending = recentERA && seasonStats.era
      ? parseFloat(recentERA) < parseFloat(seasonStats.era) - 0.5 ? 'HOT' :
        parseFloat(recentERA) > parseFloat(seasonStats.era) + 0.5 ? 'COLD' : 'NEUTRAL'
      : 'UNKNOWN';

    return {
      name: pitcher.fullName,
      era: seasonStats.era,
      whip: seasonStats.whip,
      strikeouts: seasonStats.strikeOuts,
      wins: seasonStats.wins,
      losses: seasonStats.losses,
      ip: seasonStats.inningsPitched,
      recentERA,
      trending,
      last3
    };
  } catch(e) {
    return null;
  }
}

// Fetch team batting stats and hot/cold hitters
async function fetchTeamStats(teamName, venueId = null) {
  try {
    const teamsRes = await fetch('https://statsapi.mlb.com/api/v1/teams?sportId=1&season=2026');
    if (!teamsRes.ok) return null;
    const teamsData = await teamsRes.json();
    const team = teamsData.teams?.find(t =>
      t.name.toLowerCase().includes(teamName.toLowerCase().split(' ').pop().toLowerCase()) ||
      teamName.toLowerCase().includes(t.name.toLowerCase().split(' ').pop().toLowerCase())
    );
    if (!team) return null;

    // Fetch season stats + home/away splits + venue splits in parallel
    const [statsRes, splitRes, schedRes] = await Promise.all([
      fetch(`https://statsapi.mlb.com/api/v1/teams/${team.id}/stats?stats=season&group=hitting&season=2026`),
      fetch(`https://statsapi.mlb.com/api/v1/teams/${team.id}/stats?stats=statSplits&group=hitting&season=2026&sitCodes=h,a`),
      fetch(`https://statsapi.mlb.com/api/v1/schedule?teamId=${team.id}&sportId=1&season=2026&gameType=R&startDate=2026-01-01&endDate=${new Date().toISOString().split('T')[0]}`)
    ]);

    if (!statsRes.ok) return null;
    const statsData = await statsRes.json();
    const stats = statsData.stats?.[0]?.splits?.[0]?.stat;
    if (!stats) return null;

    // Parse home/away splits
    let homeOPS = null, awayOPS = null, homeAVG = null, awayAVG = null;
    let homeRuns = null, awayRuns = null;
    if (splitRes.ok) {
      const sd = await splitRes.json();
      const splits = sd.stats?.[0]?.splits || [];
      const home = splits.find(s => s.split?.code === 'h');
      const away = splits.find(s => s.split?.code === 'a');
      homeOPS  = home?.stat?.ops  || null;
      awayOPS  = away?.stat?.ops  || null;
      homeAVG  = home?.stat?.avg  || null;
      awayAVG  = away?.stat?.avg  || null;
      homeRuns = home?.stat?.runs || null;
      awayRuns = away?.stat?.runs || null;
    }

    // Last 10 games record
    let last10 = null;
    if (schedRes.ok) {
      const schedData = await schedRes.json();
      const games = schedData.dates?.flatMap(d => d.games) || [];
      const completed = games.filter(g => g.status?.abstractGameState === 'Final').slice(-10);
      const wins = completed.filter(g => {
        const isHome = g.teams?.home?.team?.id === team.id;
        return isHome ? g.teams?.home?.isWinner : g.teams?.away?.isWinner;
      }).length;
      last10 = `${wins}-${completed.length - wins}`;
    }

    return {
      teamId: team.id,
      teamName: team.name,
      avg: stats.avg, ops: stats.ops, runs: stats.runs,
      hr: stats.homeRuns, obp: stats.obp, slg: stats.slg,
      homeOPS, awayOPS, homeAVG, awayAVG, homeRuns, awayRuns,
      last10
    };
  } catch(e) { return null; }
}

// Fetch today's probable pitchers from MLB Stats API
async function fetchProbablePitchers(gameDate) {
  try {
    const res = await fetch(
      `https://statsapi.mlb.com/api/v1/schedule?sportId=1&date=${gameDate}&gameType=R&hydrate=probablePitcher(note),team`
    );
    if (!res.ok) return { pitcherMap: {}, venueMap: {}, scheduleGames: [] };
    const data = await res.json();
    const pitcherMap = {};
    const venueMap = {};
    const scheduleGames = [];   // one entry per real game — keeps gamePk + start time so doubleheaders don't collapse
    for (const date of (data.dates || [])) {
      for (const game of (date.games || [])) {
        const awayId = game.teams?.away?.team?.id;
        const homeId = game.teams?.home?.team?.id;
        const venueName = game.venue?.name || null;
        if (homeId) venueMap[`home_${homeId}`] = venueName; // actual park for this game (handles neutral sites)
        const awayPitcher = game.teams?.away?.probablePitcher;
        const homePitcher = game.teams?.home?.probablePitcher;
        const awayP = awayPitcher ? { id: awayPitcher.id, name: awayPitcher.fullName, note: awayPitcher.note || null, vs: homeId, gamePk: game.gamePk, venue: venueName } : null;
        const homeP = homePitcher ? { id: homePitcher.id, name: homePitcher.fullName, note: homePitcher.note || null, vs: awayId, gamePk: game.gamePk, venue: venueName } : null;
        if (awayP) pitcherMap[`away_${awayId}`] = awayP;  // legacy team-id map (collapses on doubleheaders; kept as fallback)
        if (homeP) pitcherMap[`home_${homeId}`] = homeP;
        scheduleGames.push({ gamePk: game.gamePk, awayId, homeId, gameDate: game.gameDate, venue: venueName, venueId: game.venue?.id || null, awayPitcher: awayP, homePitcher: homeP, seriesGameNumber: game.seriesGameNumber, gamesInSeries: game.gamesInSeries });
      }
    }
    console.log(`Probable pitchers found: ${Object.keys(pitcherMap).length}`);
    return { pitcherMap, venueMap, scheduleGames };
  } catch(e) {
    console.log('Pitcher lookup failed:', e.message);
    return { pitcherMap: {}, venueMap: {}, scheduleGames: [] };
  }
}

// Series sweep-spot detector. Looks at the prior games of THIS series (the seriesGameNumber-1 most
// recent head-to-head finals before today) and returns the side in position to sweep ('AWAY'|'HOME')
// if one team has won every one of them, else null. Best-effort: any hiccup returns null = no fade.
async function fetchSeriesSweepSide(awayId, homeId, dateStr, seriesGameNumber, currentGamePk = null) {
  const priorNeeded = (seriesGameNumber || 0) - 1;
  if (priorNeeded < 2) return null;                       // need games 1 & 2 already played (this is game 3+)
  try {
    const start = new Date(new Date(dateStr + 'T12:00:00Z').getTime() - 8 * 86400000).toISOString().slice(0, 10);
    const res = await fetch(`https://statsapi.mlb.com/api/v1/schedule?sportId=1&startDate=${start}&endDate=${dateStr}&teamId=${awayId}&opponentId=${homeId}&gameType=R&hydrate=linescore`);
    if (!res.ok) return null;
    const data = await res.json();
    const h2h = [];
    for (const d of (data.dates || [])) for (const g of (d.games || [])) {
      const aId = g.teams?.away?.team?.id, hId = g.teams?.home?.team?.id;
      const pair = (aId === awayId && hId === homeId) || (aId === homeId && hId === awayId);
      if (!pair) continue;
      if (currentGamePk && g.gamePk === currentGamePk) continue; // skip the current game
      if (g.status?.abstractGameState !== 'Final') continue;
      const od = g.officialDate || (g.gameDate || '').slice(0, 10);
      if (!od || od > dateStr) continue;                  // only games up to and including today
      const aS = g.teams?.away?.score, hS = g.teams?.home?.score;
      if (aS == null || hS == null) continue;
      h2h.push({ date: od, winnerId: aS > hS ? aId : hId });
    }
    h2h.sort((x, y) => (x.date < y.date ? 1 : -1));        // most recent first
    const series = h2h.slice(0, priorNeeded);             // the prior games of this series
    if (series.length < priorNeeded) return null;         // couldn't confirm them all -> don't fade
    const wins = {};
    for (const g of series) wins[g.winnerId] = (wins[g.winnerId] || 0) + 1;
    if (wins[awayId] === series.length) return 'AWAY';    // away has swept the series so far
    if (wins[homeId] === series.length) return 'HOME';
    return null;                                          // sweep already broken -> no fade
  } catch (e) { return null; }
}

// Check if pitcher is making MLB debut
async function checkMLBDebut(pitcherId) {
  try {
    if (!pitcherId) return false;
    const res = await fetch(
      `https://statsapi.mlb.com/api/v1/people/${pitcherId}/stats?stats=career&group=pitching`
    );
    if (!res.ok) return false;
    const data = await res.json();
    const career = data.stats?.[0]?.splits?.[0]?.stat;
    // If no career stats or 0 games pitched, it's a debut
    if (!career || parseInt(career.gamesStarted || 0) === 0) return true;
    return false;
  } catch(e) { return false; }
}

// Get team ID from Odds API team name
async function getTeamId(teamName) {
  try {
    const res = await fetch('https://statsapi.mlb.com/api/v1/teams?sportId=1&season=2026');
    if (!res.ok) return null;
    const data = await res.json();
    const teams = data.teams || [];
    const norm = s => (s || '').toLowerCase().replace(/[^a-z ]/g, '').trim();
    const target = norm(teamName);
    // 1) exact full-name match (the Odds API almost always uses MLB's full names)
    let team = teams.find(t => norm(t.name) === target);
    // 2) full-name containment (handles minor punctuation/variant) — NOT last-word,
    //    so "Chicago White Sox" can't collide with "Boston Red Sox".
    if (!team) team = teams.find(t => { const tn = norm(t.name); return target.includes(tn) || tn.includes(target); });
    // 3) Athletics relocation/naming alias
    if (!team && target.includes('athletics')) team = teams.find(t => norm(t.name).includes('athletics'));
    if (!team) console.log(`  ⚠ Could not resolve team id for "${teamName}"`);
    return team?.id || null;
  } catch(e) { return null; }
}


const STATCAST_PROXY = 'https://betting-proxy.svdrenovations.workers.dev';

async function fetchStatcastCSV(pitcherId, groupBy = 'name', playerType = 'pitcher') {
  const endDate = new Date().toISOString().split('T')[0];
  const startDate = `${new Date().getFullYear()}-01-01`;
  const url = `${STATCAST_PROXY}/statcast?pitcherId=${pitcherId}&playerType=${playerType}&groupBy=${groupBy}&startDate=${startDate}&endDate=${endDate}`;
  try {
    const res = await fetch(url);
    if (!res.ok) { console.log(`  Statcast proxy error: HTTP ${res.status} for pitcherId ${pitcherId}`); return null; }
    const text = await res.text();
    if (!text) { console.log(`  Statcast proxy: empty response for pitcherId ${pitcherId}`); return null; }
    if (text.includes('Method not allowed') || text.includes('Missing')) { console.log(`  Statcast proxy: ${text.slice(0,50)} for pitcherId ${pitcherId}`); return null; }
    const lines = text.trim().split('\n');
    console.log(`  Statcast proxy: ${lines.length} rows for pitcherId ${pitcherId}`);
    if (lines.length <= 1) { console.log(`  Statcast proxy: header only — Savant returned no pitch data`); return null; }
    return text;
  } catch(e) {
    console.log(`  Statcast proxy fetch error for ${pitcherId}:`, e.message);
    return null;
  }
}

async function fetchStatcastXStats(pitcherId) {
  const url = `${STATCAST_PROXY}/statcast-xstats?pitcherId=${pitcherId}`;
  const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
  if (!res.ok) return null;
  const text = await res.text();
  if (!text || text.includes('Method not allowed')) return null;
  return text;
}

// Load Statcast cache from Supabase (written by fetch_statcast.py daily at 6am ET)
let _statcastCache = null;
async function loadStatcastCache() {
  if (_statcastCache) return _statcastCache;
  try {
    const url = `${process.env.SUPABASE_URL}/rest/v1/statcast_cache?select=player_id,player_type,name,data&updated_at=gte.${new Date(Date.now() - 24*60*60*1000).toISOString()}`;
    const res = await fetch(url, {
      headers: {
        'apikey': process.env.SUPABASE_SERVICE_KEY,
        'Authorization': `Bearer ${process.env.SUPABASE_SERVICE_KEY}`
      }
    });
    if (!res.ok) throw new Error(`Supabase error: ${res.status}`);
    const rows = await res.json();
    _statcastCache = { pitchers: {}, batters: {} };
    for (const row of rows) {
      const data = typeof row.data === 'string' ? JSON.parse(row.data) : row.data;
      const bucket = row.player_type === 'pitcher' ? 'pitchers' : 'batters';
      _statcastCache[bucket][String(row.player_id)] = { name: row.name, ...data };
    }
    const pc = Object.keys(_statcastCache.pitchers).length;
    const bc = Object.keys(_statcastCache.batters).length;
    console.log(`  Loaded Statcast cache from Supabase: ${pc} pitchers, ${bc} batters`);
  } catch(e) {
    console.log('  Statcast cache load error:', e.message);
    // Fallback: try local /tmp cache from current run
    try {
      const fs = require('fs');
      if (fs.existsSync('/tmp/statcast_cache.json')) {
        const raw = JSON.parse(fs.readFileSync('/tmp/statcast_cache.json', 'utf8'));
        _statcastCache = {
          pitchers: raw.pitchers || raw,
          batters: raw.batters || {}
        };
        console.log(`  Fallback: loaded from /tmp cache`);
      } else {
        _statcastCache = { pitchers: {}, batters: {} };
      }
    } catch(fe) {
      _statcastCache = { pitchers: {}, batters: {} };
    }
  }
  return _statcastCache;
}

function getStatcastBatter(batterId) {
  return _statcastCache?.batters?.[String(batterId)] || null;
}

// Fetch Statcast metrics — reads from pybaseball cache first, falls back to MLB Stats API
async function fetchStatcast(pitcherName, pitcherId) {
  try {
    if (!pitcherId) return null;

    // Try Supabase cache first (rich pitch-level data from pybaseball)
    const cache = await loadStatcastCache();
    const cached = cache.pitchers?.[String(pitcherId)];
    if (cached) {
      console.log(`  Statcast ${pitcherName} (cache): velo ${cached.avgVelo}mph (${cached.veloTrend}), whiff ${cached.whiffRate}%, barrel ${cached.barrelRate}%${cached.xERA ? ` | xERA ${cached.xERA}` : ''}`);
      return cached;
    }

    // Fallback: MLB Stats API sabermetrics (less detail but always available)
    console.log(`  Statcast ${pitcherName}: not in cache — using MLB Stats API fallback`);
    const [saberRes, gameLogRes] = await Promise.all([
      fetch(`https://statsapi.mlb.com/api/v1/people/${pitcherId}/stats?stats=sabermetrics&group=pitching&season=2026`),
      fetch(`https://statsapi.mlb.com/api/v1/people/${pitcherId}/stats?stats=gameLog&group=pitching&season=2026`)
    ]);

    let avgVelo = null, whiffRate = null, hardHitRate = null, barrelRate = null;
    let xERA = null, xwOBA = null, veloTrend = 'UNKNOWN', lastStartVelo = null;
    let last3Rates = [];

    if (saberRes.ok) {
      const sd = await saberRes.json();
      const s = sd.stats?.[0]?.splits?.[0]?.stat;
      if (s) {
        whiffRate   = s.whiffPercent   != null ? parseFloat(s.whiffPercent).toFixed(1)   : null;
        hardHitRate = s.hardHitPercent != null ? parseFloat(s.hardHitPercent).toFixed(1) : null;
        barrelRate  = s.barrelPercent  != null ? parseFloat(s.barrelPercent).toFixed(1)  : null;
        xERA        = s.xEra           != null ? parseFloat(s.xEra).toFixed(2)           : null;
        xwOBA       = s.xWoba          != null ? parseFloat(s.xWoba).toFixed(3)          : null;
      }
    }

    if (gameLogRes.ok) {
      const gd = await gameLogRes.json();
      const games = gd.stats?.[0]?.splits || [];
      last3Rates = games.slice(-3).map(g => ({
        date: g.date,
        ip: g.stat?.inningsPitched,
        er: g.stat?.earnedRuns,
        kPct: null, bbPct: null
      }));
      veloTrend = 'STABLE';
    }

    console.log(`  Statcast ${pitcherName} (API fallback): whiff ${whiffRate}%, hardHit ${hardHitRate}%, barrel ${barrelRate}%${xERA ? ` | xERA ${xERA}` : ''}`);
    return { avgVelo, lastStartVelo, veloTrend, whiffRate, hardHitRate, barrelRate, pitches: null, xERA, xwOBA, last3Rates, arsenal: null };
  } catch(e) {
    console.log(`  Statcast error for ${pitcherName}:`, e.message);
    return null;
  }
}

// Fetch confirmed lineup from MLB Stats API
async function fetchLineup(teamId, gameDate) {
  try {
    if (!teamId) return null;
    const res = await fetch(
      `https://statsapi.mlb.com/api/v1/schedule?sportId=1&date=${gameDate}&teamId=${teamId}&gameType=R&hydrate=lineups`
    );
    if (!res.ok) return null;
    const data = await res.json();
    const game = data.dates?.[0]?.games?.[0];
    if (!game) return null;

    const isHome = game.teams?.home?.team?.id === teamId;
    const lineup = isHome
      ? game.lineups?.homePlayers
      : game.lineups?.awayPlayers;

    if (!lineup || !lineup.length) return null;
    return lineup.map(p => ({ id: p.id, name: p.fullName, position: p.primaryPosition?.abbreviation }));
  } catch(e) { return null; }
}

// Fetch batter vs pitcher career matchup stats
async function fetchMatchupStats(batterId, pitcherId) {
  try {
    if (!batterId || !pitcherId) return null;
    const res = await fetch(
      `https://statsapi.mlb.com/api/v1/people/${batterId}/stats?stats=vsPlayer&opposingPlayerId=${pitcherId}&group=hitting&sportId=1`
    );
    if (!res.ok) return null;
    const data = await res.json();
    // API returns multiple splits — find one with actual AB data (career aggregate)
    const allSplits = (data.stats || []).flatMap(s => s.splits || []);
    const stat = allSplits.find(s => (s.stat?.atBats || 0) > 0)?.stat;
    if (!stat || !stat.atBats) return null;
    return {
      ab:  stat.atBats      || 0,
      avg: stat.avg         || '.000',
      ops: stat.ops         || '.000',
      hr:  stat.homeRuns    || 0,
      so:  stat.strikeOuts  || 0,
      bb:  stat.baseOnBalls || 0,
      obp: stat.obp         || '.000',
      slg: stat.slg         || '.000',
    };
  } catch(e) { return null; }
}

// Build full lineup matchup profile vs starting pitcher
async function fetchLineupMatchups(teamId, pitcherId, gameDate) {
  try {
    const lineup = await fetchLineup(teamId, gameDate);
    if (!lineup || !lineup.length) return null;
    const handedness = await lineupHandedness(lineup.slice(0, 9));

    const matchups = await Promise.all(
      lineup.slice(0, 9).map(batter => fetchMatchupStats(batter.id, pitcherId))
    );

    // Aggregate matchup stats (minimum 10 AB for meaningful data)
    const meaningful = matchups.filter(m => m && m.ab >= 10);
    if (!meaningful.length) return { lineup: lineup.slice(0,9), matchups, meaningful: 0, handedness, note: 'Insufficient sample vs this pitcher' };

    const avgOPS = meaningful.reduce((sum, m) => sum + parseFloat(m.ops || 0), 0) / meaningful.length;
    const avgAVG = meaningful.reduce((sum, m) => sum + parseFloat(m.avg || 0), 0) / meaningful.length;
    const totalK = meaningful.reduce((sum, m) => sum + m.so, 0);
    const totalAB = meaningful.reduce((sum, m) => sum + m.ab, 0);
    const kRate = totalAB > 0 ? ((totalK / totalAB) * 100).toFixed(1) : null;

    // Flag notable individual matchups
    const hotBatters = meaningful.filter(m => parseFloat(m.ops) > .900).length;
    const coldBatters = meaningful.filter(m => parseFloat(m.ops) < .550).length;

    return {
      lineup: lineup.slice(0, 9),
      meaningful: meaningful.length,
      avgOPS: avgOPS.toFixed(3),
      avgAVG: avgAVG.toFixed(3),
      kRate,
      hotBatters,
      coldBatters,
      handedness,
      sample: `${meaningful.length} of 9 batters with 10+ AB vs this pitcher`
    };
  } catch(e) {
    console.log('  Lineup matchup error:', e.message);
    return null;
  }
}

// Real starter stats by ID: ERA/WHIP/recent form, avg innings per start, throw hand.
// (The old pitcherMap only carried id/name — this fills in the actual numbers.)
async function fetchPitcherDetail(pitcherId, venueId = null) {
  try {
    if (!pitcherId) return null;

    const [statsRes, personRes, splitRes] = await Promise.all([
      fetch(`https://statsapi.mlb.com/api/v1/people/${pitcherId}/stats?stats=season,gameLog&group=pitching&season=2026`),
      fetch(`https://statsapi.mlb.com/api/v1/people/${pitcherId}`),
      fetch(`https://statsapi.mlb.com/api/v1/people/${pitcherId}/stats?stats=statSplits&group=pitching&season=2026&sitCodes=h,a,vl,vr`)
    ]);

    let throwHand = null;
    if (personRes.ok) {
      const p = await personRes.json();
      throwHand = p.people?.[0]?.pitchHand?.code || null;
    }

    // Parse home/away/handedness splits
    let homeERA = null, awayERA = null, vsLHB = null, vsRHB = null;
    if (splitRes.ok) {
      const sd = await splitRes.json();
      const splits = sd.stats?.[0]?.splits || [];
      const home = splits.find(s => s.split?.code === 'h');
      const away = splits.find(s => s.split?.code === 'a');
      const vl   = splits.find(s => s.split?.code === 'vl');
      const vr   = splits.find(s => s.split?.code === 'vr');
      homeERA = home?.stat?.era || null;
      awayERA = away?.stat?.era || null;
      vsLHB   = vl?.stat ? { era: vl.stat.era, ops: vl.stat.ops, k9: vl.stat.strikeoutsPer9Inn } : null;
      vsRHB   = vr?.stat ? { era: vr.stat.era, ops: vr.stat.ops, k9: vr.stat.strikeoutsPer9Inn } : null;
    }

    if (!statsRes.ok) return throwHand ? { throwHand, homeERA, awayERA, vsLHB, vsRHB } : null;
    const d = await statsRes.json();
    const season  = d.stats?.find(s => s.type?.displayName === 'season')?.splits?.[0]?.stat;
    const gameLog = d.stats?.find(s => s.type?.displayName === 'gameLog')?.splits || [];
    if (!season) return throwHand ? { throwHand, homeERA, awayERA, vsLHB, vsRHB } : null;

    const starts = gameLog.filter(g => parseInt(g.stat?.gamesStarted || 0) > 0 || parseFloat(g.stat?.inningsPitched || 0) >= 3).slice(-5);
    const avgIP  = starts.length ? (starts.reduce((s, g) => s + parseFloat(g.stat?.inningsPitched || 0), 0) / starts.length).toFixed(1) : null;
    const last3  = gameLog.slice(-3).map(g => ({ ip: g.stat?.inningsPitched, er: g.stat?.earnedRuns, date: g.date }));
    const recentERA = last3.length
      ? (last3.reduce((s, g) => s + parseFloat(g.er || 0), 0) / Math.max(0.1, last3.reduce((s, g) => s + parseFloat(g.ip || 0), 0)) * 9).toFixed(2)
      : null;
    const trending = recentERA && season.era
      ? (parseFloat(recentERA) < parseFloat(season.era) - 0.5 ? 'HOT'
        : parseFloat(recentERA) > parseFloat(season.era) + 0.5 ? 'COLD' : 'NEUTRAL')
      : 'UNKNOWN';

    // Venue-specific ERA if venueId provided — fetch from game log
    let venueERA = null;
    if (venueId && gameLog.length) {
      // Filter game log to games at this venue — approximate by checking gamePk
      // MLB API doesn't directly expose venueId in gameLog splits easily
      // So we'll use home/away as proxy: if pitching at home stadium
      const venueGames = gameLog.filter(g => g.isHome === true || (g.team?.venue?.id === venueId));
      if (venueGames.length >= 2) {
        const vIP = venueGames.reduce((s, g) => s + parseFloat(g.stat?.inningsPitched || 0), 0);
        const vER = venueGames.reduce((s, g) => s + parseFloat(g.stat?.earnedRuns || 0), 0);
        if (vIP > 0) venueERA = (vER / vIP * 9).toFixed(2);
      }
    }

    return {
      era: season.era, whip: season.whip, wins: season.wins, losses: season.losses,
      ip: season.inningsPitched, recentERA, trending, avgIP, throwHand, last3,
      homeERA, awayERA, venueERA, vsLHB, vsRHB,
      seasonK9: season.strikeoutsPer9Inn, seasonBB9: season.walksPer9Inn
    };
  } catch(e) { return null; }
}

// Fetch pitcher's pitch arsenal from Baseball Savant
// Returns pitch type usage, whiff rate, velo, movement, arm slot per pitch
async function fetchPitchArsenal(pitcherId, season = 2026) {
  try {
    if (!pitcherId) return null;
    const csv = await fetchStatcastCSV(pitcherId, 'name-pitch_type', 'pitcher');
    if (!csv) return null;
    const csvLines = csv.trim().split('\n');
    if (csvLines.length < 2) return null;

    const headers = csvLines[0].split(',');
    const get = (row, col) => { const i = headers.indexOf(col); return i >= 0 ? row.split(',')[i]?.trim() : null; };

    // Aggregate pitch type data
    const pitchMap = {}; // key = pitch_type

    for (let i = 1; i < csvLines.length; i++) {
      const row = csvLines[i];
      if (!row.trim()) continue;
      const pt = get(row, 'pitch_type');
      if (!pt || pt === 'null' || pt === '') continue;

      if (!pitchMap[pt]) pitchMap[pt] = { count: 0, velos: [], whiffs: 0, swings: 0, hx: [], hz: [], relX: [], relZ: [] };
      const p = pitchMap[pt];
      p.count++;

      const velo = parseFloat(get(row, 'release_speed'));
      if (!isNaN(velo) && velo > 0) p.velos.push(velo);

      const desc = get(row, 'description') || '';
      if (desc.includes('swing') || desc.includes('foul') || desc.includes('hit')) p.swings++;
      if (desc.includes('swinging_strike')) p.whiffs++;

      const hBreak = parseFloat(get(row, 'pfx_x'));
      const vBreak = parseFloat(get(row, 'pfx_z'));
      if (!isNaN(hBreak)) p.hx.push(hBreak);
      if (!isNaN(vBreak)) p.hz.push(vBreak);

      const rx = parseFloat(get(row, 'release_pos_x'));
      const rz = parseFloat(get(row, 'release_pos_z'));
      if (!isNaN(rx)) p.relX.push(rx);
      if (!isNaN(rz)) p.relZ.push(rz);
    }

    const totalPitches = Object.values(pitchMap).reduce((s, p) => s + p.count, 0);
    if (!totalPitches) return null;

    const pitchNames = {
      'FF': '4-Seam FB', 'SI': 'Sinker', 'FC': 'Cutter', 'SL': 'Slider',
      'SW': 'Sweeper', 'CU': 'Curveball', 'KC': 'Knuckle-Curve', 'CH': 'Changeup',
      'FS': 'Splitter', 'KN': 'Knuckleball', 'ST': 'Sweeper', 'SV': 'Screwball'
    };

    const arsenal = Object.entries(pitchMap)
      .filter(([, p]) => p.count >= 10)
      .map(([pt, p]) => ({
        type: pt,
        name: pitchNames[pt] || pt,
        pct: ((p.count / totalPitches) * 100).toFixed(1),
        velo: p.velos.length ? (p.velos.reduce((a, b) => a + b, 0) / p.velos.length).toFixed(1) : null,
        whiffPct: p.swings > 0 ? ((p.whiffs / p.swings) * 100).toFixed(1) : null,
        hBreak: p.hx.length ? (p.hx.reduce((a, b) => a + b, 0) / p.hx.length).toFixed(1) : null,
        vBreak: p.hz.length ? (p.hz.reduce((a, b) => a + b, 0) / p.hz.length).toFixed(1) : null,
        armSlotX: p.relX.length ? (p.relX.reduce((a, b) => a + b, 0) / p.relX.length).toFixed(2) : null,
        armSlotZ: p.relZ.length ? (p.relZ.reduce((a, b) => a + b, 0) / p.relZ.length).toFixed(2) : null,
      }))
      .sort((a, b) => parseFloat(b.pct) - parseFloat(a.pct));

    // Arm slot classification
    const avgRelX = arsenal.length ? arsenal.reduce((s, p) => s + parseFloat(p.armSlotX || 0), 0) / arsenal.length : 0;
    const avgRelZ = arsenal.length ? arsenal.reduce((s, p) => s + parseFloat(p.armSlotZ || 0), 0) / arsenal.length : 0;
    let armSlot = 'over-the-top';
    if (avgRelZ < 5.5) armSlot = 'sidearm';
    else if (avgRelZ < 6.2) armSlot = 'low three-quarter';
    else if (avgRelZ < 6.8) armSlot = 'three-quarter';
    else armSlot = 'over-the-top';

    return { arsenal, armSlot, totalPitches };
  } catch(e) {
    console.log(`  Arsenal fetch error:`, e.message);
    return null;
  }
}

// Fetch batter's performance vs specific pitch types from Baseball Savant
async function fetchBatterVsPitchType(batterId, pitcherHand, season = 2026) {
  try {
    if (!batterId) return null;
    const csv = await fetchStatcastCSV(batterId, 'name-pitch_type', 'batter');
    if (!csv) return null;
    const csvLines = csv.trim().split('\n');
    if (csvLines.length < 2) return null;

    const headers = csvLines[0].split(',');
    const get = (row, col) => { const i = headers.indexOf(col); return i >= 0 ? row.split(',')[i]?.trim() : null; };

    const pitchMap = {};
    for (let i = 1; i < csvLines.length; i++) {
      const row = csvLines[i];
      if (!row.trim()) continue;
      const pt = get(row, 'pitch_type');
      if (!pt || pt === 'null' || pt === '') continue;
      if (!pitchMap[pt]) pitchMap[pt] = { pa: 0, swings: 0, whiffs: 0, inZone: 0, chases: 0, hardHits: 0, batted: 0 };
      const p = pitchMap[pt];
      p.pa++;
      const desc = get(row, 'description') || '';
      const zone = parseInt(get(row, 'zone') || 0);
      const inZone = zone >= 1 && zone <= 9;
      if (inZone) p.inZone++;
      if (desc.includes('swing') || desc.includes('foul') || desc.includes('hit')) {
        p.swings++;
        if (!inZone) p.chases++;
      }
      if (desc.includes('swinging_strike')) p.whiffs++;
      const exitVelo = parseFloat(get(row, 'launch_speed'));
      if (!isNaN(exitVelo) && exitVelo > 0) {
        p.batted++;
        if (exitVelo >= 95) p.hardHits++;
      }
    }

    return Object.entries(pitchMap)
      .filter(([, p]) => p.pa >= 10)
      .map(([pt, p]) => ({
        type: pt,
        whiffPct: p.swings > 0 ? ((p.whiffs / p.swings) * 100).toFixed(1) : null,
        chasePct: p.chases > 0 && p.swings > 0 ? ((p.chases / p.swings) * 100).toFixed(1) : null,
        hardHitPct: p.batted > 0 ? ((p.hardHits / p.batted) * 100).toFixed(1) : null,
        pa: p.pa
      }))
      .sort((a, b) => b.pa - a.pa);
  } catch(e) { return null; }
}

// Match pitcher arsenal vs lineup swing tendencies
// Returns a matchup score and narrative for each key pitch type
function analyzeArsenalMatchup(arsenal, lineupPitchStats, pitcherHand) {
  if (!arsenal?.arsenal?.length || !lineupPitchStats?.length) return null;

  const matchups = [];
  for (const pitch of arsenal.arsenal.slice(0, 4)) { // top 4 pitches
    // Find how lineup performs vs this pitch type
    const lineupVsPitch = lineupPitchStats
      .map(batter => batter?.find(p => p.type === pitch.type))
      .filter(Boolean);

    if (!lineupVsPitch.length) continue;

    const avgWhiff = lineupVsPitch.reduce((s, p) => s + parseFloat(p.whiffPct || 0), 0) / lineupVsPitch.length;
    const avgChase = lineupVsPitch.reduce((s, p) => s + parseFloat(p.chasePct || 0), 0) / lineupVsPitch.length;
    const avgHH = lineupVsPitch.reduce((s, p) => s + parseFloat(p.hardHitPct || 0), 0) / lineupVsPitch.length;

    // Pitcher's own whiff rate on this pitch
    const pitcherWhiff = parseFloat(pitch.whiffPct || 0);

    // Edge: if lineup whiffs a lot on pitch type AND pitcher also has high whiff = pitcher advantage
    // If lineup makes hard contact on pitch type = batter advantage
    const edge = pitcherWhiff > avgWhiff ? 'pitcher' : avgHH > 38 ? 'batter' : 'neutral';

    matchups.push({
      pitch: pitch.name,
      usage: pitch.pct,
      pitcherWhiff: pitch.whiffPct,
      lineupWhiff: avgWhiff.toFixed(1),
      lineupChase: avgChase.toFixed(1),
      lineupHardHit: avgHH.toFixed(1),
      edge
    });
  }

  const pitcherEdges = matchups.filter(m => m.edge === 'pitcher').length;
  const batterEdges = matchups.filter(m => m.edge === 'batter').length;
  const overallEdge = pitcherEdges > batterEdges ? 'PITCHER DOMINATES' : batterEdges > pitcherEdges ? 'LINEUP ADVANTAGE' : 'EVEN';

  return { matchups, overallEdge, armSlot: arsenal.armSlot };
}
async function fetchUmpireTendency(gamePk) {
  try {
    if (!gamePk) return null;
    // Get umpire assignment from MLB Stats API
    const res = await fetch(`https://statsapi.mlb.com/api/v1/game/${gamePk}/boxscore`);
    if (!res.ok) return null;
    const data = await res.json();
    const officials = data.officials || [];
    const hp = officials.find(o => (o.officialType || '').toLowerCase().includes('home plate') || (o.officialType || '').toLowerCase() === 'hp');
    if (!hp?.official?.id) return null;

    const umpireId = hp.official.id;
    const umpireName = hp.official.fullName || 'Unknown';

    // Get umpire's 2026 season stats from MLB Stats API
    const statsRes = await fetch(
      `https://statsapi.mlb.com/api/v1/people/${umpireId}/stats?stats=byYear&group=umpiring&season=2026`
    );

    let runsPerGame = null;
    if (statsRes.ok) {
      const sData = await statsRes.json();
      const splits = sData.stats?.[0]?.splits || [];
      const season = splits.find(s => s.season === '2026');
      if (season?.stat) {
        const games = parseFloat(season.stat.gamesTotal || 0);
        const runs = parseFloat(season.stat.runsTotal || 0);
        if (games > 0) runsPerGame = (runs / games).toFixed(2);
      }
    }

    // League avg is ~8.8 runs/game — classify tendency
    const rpg = parseFloat(runsPerGame);
    let tendency = 'NEUTRAL';
    if (!isNaN(rpg)) {
      if (rpg >= 9.5) tendency = 'HIGH_SCORER'; // tight zone, more walks, more runs
      else if (rpg <= 8.1) tendency = 'LOW_SCORER'; // big zone, more Ks, fewer runs
    }

    console.log(`  Umpire: ${umpireName} | runs/game: ${runsPerGame || '?'} | tendency: ${tendency}`);
    return { umpireId, umpireName, runsPerGame, tendency };
  } catch(e) {
    return null;
  }
}

// Fetch lineup batting order from MLB Stats API boxscore
async function fetchLineupOrder(gamePk, teamId) {
  try {
    if (!gamePk || !teamId) return null;
    const res = await fetch(`https://statsapi.mlb.com/api/v1/game/${gamePk}/boxscore`);
    if (!res.ok) return null;
    const data = await res.json();

    // Find which side (home/away) this team is on
    const awayId = data.teams?.away?.team?.id;
    const homeId = data.teams?.home?.team?.id;
    const side = awayId === teamId ? 'away' : homeId === teamId ? 'home' : null;
    if (!side) return null;

    const players = data.teams?.[side]?.players || {};
    const batters = Object.values(players)
      .filter(p => p.battingOrder)
      .sort((a, b) => parseInt(a.battingOrder) - parseInt(b.battingOrder))
      .map(p => ({
        id: p.person?.id,
        name: p.person?.fullName,
        order: parseInt(p.battingOrder) / 100, // MLB encodes as 100, 200, etc.
        ops: p.seasonStats?.batting?.ops || null,
        avg: p.seasonStats?.batting?.avg || null
      }));

    return batters.slice(0, 9);
  } catch(e) {
    return null;
  }
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
    return {
      L: sides.filter(s => s === 'L').length,
      R: sides.filter(s => s === 'R').length,
      S: sides.filter(s => s === 'S').length
    };
  } catch(e) { return null; }
}

// Bullpen quality (IP-weighted ERA + K-BB%) and recent fatigue.
async function fetchBullpen(teamId) {
  try {
    if (!teamId) return null;
    const rosRes = await fetch(`https://statsapi.mlb.com/api/v1/teams/${teamId}/roster?rosterType=active`);
    if (!rosRes.ok) return null;
    const ros = await rosRes.json();
    const pitchers = (ros.roster || []).filter(p => p.position?.abbreviation === 'P' || p.position?.code === '1');
    if (!pitchers.length) return null;

    const ids = pitchers.map(p => p.person.id);
    const statsList = await Promise.all(ids.map(id =>
      fetch(`https://statsapi.mlb.com/api/v1/people/${id}/stats?stats=season&group=pitching&season=2026`)
        .then(r => r.ok ? r.json() : null).catch(() => null)
    ));

    const relievers = [];
    statsList.forEach((d, i) => {
      const st = d?.stats?.[0]?.splits?.[0]?.stat;
      if (!st) return;
      const gp = parseInt(st.gamesPitched || 0), gs = parseInt(st.gamesStarted || 0);
      if (gp >= 3 && gs / Math.max(1, gp) < 0.4) {
        relievers.push({
          id: ids[i],
          name: pitchers[i].person.fullName,
          era: parseFloat(st.era) || 99,
          ip: parseFloat(st.inningsPitched) || 0,
          k: parseInt(st.strikeOuts || 0),
          bb: parseInt(st.baseOnBalls || 0),
          bf: parseInt(st.battersFaced || st.atBats || 0),
          saves: parseInt(st.saves || 0),
          holds: parseInt(st.holds || 0),
          blownSaves: parseInt(st.saveOpportunities || 0) - parseInt(st.saves || 0),
          gp
        });
      }
    });
    if (!relievers.length) return null;

    // Sort by high-leverage role: saves first, then holds
    relievers.sort((a, b) => (b.saves + b.holds) - (a.saves + a.holds));

    // Identify closer and depth chart
    const closer = relievers[0];
    const setupMan = relievers[1] || null;
    const depthChart = relievers.slice(0, 5);

    const totIP = relievers.reduce((s, r) => s + r.ip, 0) || 1;
    const wERA = relievers.reduce((s, r) => s + (isNaN(r.era) ? 4.5 : r.era) * r.ip, 0) / totIP;
    const totK = relievers.reduce((s, r) => s + r.k, 0);
    const totBB = relievers.reduce((s, r) => s + r.bb, 0);
    const totBF = relievers.reduce((s, r) => s + r.bf, 0) || 1;
    const kbbPct = (((totK - totBB) / totBF) * 100).toFixed(1);

    // Fetch fatigue with individual availability
    const fatigue = await bullpenFatigue(teamId, relievers);

    // Build closer availability assessment
    const closerIP = fatigue?.ipByName?.[closer?.name] || 0;
    let closerStatus = 'AVAILABLE';
    if (closerIP >= 1.0 && closerIP < 2.0) closerStatus = 'QUESTIONABLE (pitched recently)';
    else if (closerIP >= 2.0) closerStatus = 'LIKELY UNAVAILABLE (heavy usage last 3d)';

    // Fill-in closer if primary is unavailable
    let fillInCloser = null;
    if (closerStatus !== 'AVAILABLE' && setupMan) {
      const setupIP = fatigue?.ipByName?.[setupMan?.name] || 0;
      const setupStatus = setupIP >= 2.0 ? 'also tired' : 'available';
      fillInCloser = { name: setupMan.name, era: setupMan.era, status: setupStatus };
    }

    const closerInfo = closer
      ? `Closer: ${closer.name} (ERA ${closer.era}, ${closer.saves}SV/${closer.saves+Math.max(0,closer.blownSaves)}opp, ${closer.blownSaves > 0 ? closer.blownSaves+'BS' : '0BS'}) — ${closerStatus}` +
        (fillInCloser ? ` | Fill-in: ${fillInCloser.name} (ERA ${fillInCloser.era}, ${fillInCloser.status})` : '')
      : 'Closer: unknown';

    return {
      count: relievers.length,
      weightedERA: wERA.toFixed(2),
      kbbPct,
      fatigueNote: fatigue?.note || 'fresh',
      tired: fatigue?.tired || [],
      closerInfo,
      closer,
      fillInCloser,
      summary: `${relievers.length} arms, pen ERA ${wERA.toFixed(2)}, K-BB% ${kbbPct} — ${fatigue?.note || 'fresh'} | ${closerInfo}`
    };
  } catch(e) { console.log('  Bullpen error:', e.message); return null; }
}

// Tally reliever innings across the team's last 3 completed games to flag fatigue.
async function bullpenFatigue(teamId, relievers) {
  try {
    const end = new Date().toISOString().split('T')[0];
    const start = new Date(Date.now() - 4 * 864e5).toISOString().split('T')[0];
    const schedRes = await fetch(`https://statsapi.mlb.com/api/v1/schedule?sportId=1&teamId=${teamId}&startDate=${start}&endDate=${end}&gameType=R`);
    if (!schedRes.ok) return null;
    const sched = await schedRes.json();
    const games = (sched.dates || []).flatMap(d => d.games || [])
      .filter(g => g.status?.abstractGameState === 'Final').slice(-3);

    const ipById = {};
    const ipByName = {};
    for (const g of games) {
      const box = await fetch(`https://statsapi.mlb.com/api/v1/game/${g.gamePk}/boxscore`)
        .then(r => r.ok ? r.json() : null).catch(() => null);
      if (!box) continue;
      const side = box.teams?.home?.team?.id === teamId ? 'home' : 'away';
      const players = box.teams?.[side]?.players || {};
      Object.values(players).forEach(pl => {
        const ip = parseFloat(pl.stats?.pitching?.inningsPitched || 0);
        if (ip > 0) {
          ipById[pl.person.id] = (ipById[pl.person.id] || 0) + ip;
          ipByName[pl.person.fullName] = (ipByName[pl.person.fullName] || 0) + ip;
        }
      });
    }

    // Check yesterday specifically — pitched yesterday = higher concern
    const yesterday = new Date(Date.now() - 864e5).toISOString().split('T')[0];
    const pitchedYesterday = [];
    const lastGame = games[games.length - 1];
    if (lastGame && (lastGame.officialDate || '').slice(0,10) === yesterday) {
      const box = await fetch(`https://statsapi.mlb.com/api/v1/game/${lastGame.gamePk}/boxscore`)
        .then(r => r.ok ? r.json() : null).catch(() => null);
      if (box) {
        const side = box.teams?.home?.team?.id === teamId ? 'home' : 'away';
        Object.values(box.teams?.[side]?.players || {}).forEach(pl => {
          const ip = parseFloat(pl.stats?.pitching?.inningsPitched || 0);
          if (ip >= 0.1) pitchedYesterday.push(pl.person.fullName);
        });
      }
    }

    const tired = relievers.filter(r => (ipById[r.id] || 0) >= 2.0).map(r => r.name);
    const usedCount = relievers.filter(r => (ipById[r.id] || 0) > 0).length;
    let note = 'fresh';
    if (tired.length >= 2) note = `TAXED (${tired.length} arms heavy last 3d)`;
    else if (tired.length === 1) note = `${tired[0]} taxed`;
    else if (usedCount >= 4) note = 'worked recently';
    if (pitchedYesterday.length >= 3) note += ` | ${pitchedYesterday.length} arms pitched yesterday`;

    return { note, tired, ipById, ipByName, pitchedYesterday };
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
    for (const game of data) {
      const lines = {};
      for (const bm of (game.bookmakers || [])) {
        for (const mkt of (bm.markets || [])) {
          if (mkt.key === 'h2h_h1' && !lines.f5AwayML) {
            for (const o of mkt.outcomes) {
              if (o.name === game.away_team) lines.f5AwayML = o.price > 0 ? `+${o.price}` : `${o.price}`;
              if (o.name === game.home_team) lines.f5HomeML = o.price > 0 ? `+${o.price}` : `${o.price}`;
            }
          }
          if (mkt.key === 'totals_h1' && !lines.f5Total) {
            const over = mkt.outcomes.find(o => o.name === 'Over');
            const under = mkt.outcomes.find(o => o.name === 'Under');
            if (over) {
              lines.f5Total = `${over.point}`;
              lines.f5OverOdds = over.price > 0 ? `+${over.price}` : `${over.price}`;
              lines.f5UnderOdds = under ? (under.price > 0 ? `+${under.price}` : `${under.price}`) : null;
            }
          }
        }
        if (lines.f5AwayML && lines.f5Total) break;
      }
      map[game.id] = lines;
    }
    return map;
  } catch(e) { return {}; }
}

async function fetchActionNetwork(awayTeam, homeTeam, gameDate) {
  try {
    console.log(`  Fetching Action Network for ${awayTeam} @ ${homeTeam}...`);
    const dateStr = gameDate.split('T')[0];
    const url = `https://api.actionnetwork.com/web/v1/games?sport=baseball&date=${dateStr}&league=mlb`;
    const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' } });
    if (!res.ok) return null;
    const data = await res.json();
    const games = data.games || [];
    const match = games.find(g => {
      const at = (g.away_team?.full_name || '').toLowerCase();
      const ht = (g.home_team?.full_name || '').toLowerCase();
      return (at.includes(awayTeam.toLowerCase().split(' ').pop()) || awayTeam.toLowerCase().includes(at.split(' ').pop())) &&
             (ht.includes(homeTeam.toLowerCase().split(' ').pop()) || homeTeam.toLowerCase().includes(ht.split(' ').pop()));
    });
    if (!match) { console.log(`  No AN match found for ${awayTeam} @ ${homeTeam}`); return null; }
    return {
      total: match.total || null,
      awayML: match.away_ml || null,
      homeML: match.home_ml || null,
      awayMLPct: match.away_ml_pct || null,
      homeMLPct: match.home_ml_pct || null,
      overPct: match.over_pct || null,
      underPct: match.under_pct || null,
      awayMoneyPct: match.away_money_pct || null,
      homeMoneyPct: match.home_money_pct || null
    };
  } catch(e) { return null; }
}

function parseOddsData(game, opts = {}) {
  let awayML=null,homeML=null,total=null,overOdds=null,underOdds=null,awayRL=null,homeRL=null,awayRLOdds=null,homeRLOdds=null;
  // Feed-integrity context
  const commence = opts.commenceTime ? new Date(opts.commenceTime)
                 : (game.commence_time ? new Date(game.commence_time) : null);
  const now = opts.now ? new Date(opts.now) : new Date();
  let bookUsed = null, lastUpdate = null, inPlaySkipped = false;

  // Try books in PREFERRED_BOOKS order; unlisted books keep their feed order after.
  const books = [...(game.bookmakers||[])].sort((a,b) => {
    const ia = PREFERRED_BOOKS.indexOf(a.key); const ib = PREFERRED_BOOKS.indexOf(b.key);
    return (ia<0?999:ia) - (ib<0?999:ib);
  });

  for (const bm of books) {
    // IN-PLAY GUARD: a book whose last_update is AFTER first pitch is quoting a
    // live/in-game price, not a pre-game or closing line. Skip it (fall through to
    // the next book) — this is the precise fix for the "said it was live" -104/+108 bug.
    const lu = bm.last_update ? new Date(bm.last_update) : null;
    if (commence && lu && lu.getTime() > commence.getTime()) { inPlaySkipped = true; continue; }

    // Extract all markets from this book
    let bmAwayML=null,bmHomeML=null,bmTotal=null,bmOverOdds=null,bmUnderOdds=null,bmAwayRL=null,bmHomeRL=null,bmAwayRLOdds=null,bmHomeRLOdds=null;
    for (const mkt of (bm.markets||[])) {
      if (mkt.key==='h2h') {
        for (const o of mkt.outcomes) {
          if (o.name===game.away_team) bmAwayML=o.price>0?`+${o.price}`:`${o.price}`;
          if (o.name===game.home_team) bmHomeML=o.price>0?`+${o.price}`:`${o.price}`;
        }
      }
      if (mkt.key==='totals') {
        const over=mkt.outcomes.find(o=>o.name==='Over');
        const under=mkt.outcomes.find(o=>o.name==='Under');
        if (over) {
          const pt = parseFloat(over.point);
          if (pt >= 6.5 && pt <= 13.5) {
            bmTotal=`${over.point}`;
            bmOverOdds=over.price>0?`+${over.price}`:`${over.price}`;
            bmUnderOdds=under?(under.price>0?`+${under.price}`:`${under.price}`):null;
          }
        }
      }
      if (mkt.key==='spreads') {
        for (const o of mkt.outcomes) {
          if (o.name===game.away_team) { bmAwayRL=o.point>0?`+${o.point}`:`${o.point}`; bmAwayRLOdds=o.price>0?`+${o.price}`:`${o.price}`; }
          if (o.name===game.home_team) { bmHomeRL=o.point>0?`+${o.point}`:`${o.point}`; bmHomeRLOdds=o.price>0?`+${o.price}`:`${o.price}`; }
        }
      }
    }
    // Only use this book if it has at minimum the ML — fill in what it has, skip what it doesn't
    if (!bmAwayML || !bmHomeML) continue;
    // Take ML from this book always (first valid book wins for ML)
    if (!awayML) { awayML=bmAwayML; homeML=bmHomeML; bookUsed=bm.title||bm.key; lastUpdate=lu?lu.toISOString():null; }
    // Only fill in RL and Total from the SAME book that gave us ML — never mix books
    if (bookUsed===(bm.title||bm.key)) {
      if (!total && bmTotal) { total=bmTotal; overOdds=bmOverOdds; underOdds=bmUnderOdds; }
      if (!awayRL && bmAwayRL) { awayRL=bmAwayRL; homeRL=bmHomeRL; awayRLOdds=bmAwayRLOdds; homeRLOdds=bmHomeRLOdds; }
    }
    if (awayML&&homeML&&total&&awayRL) break;
  }
  // MLB run-line invariant: the moneyline favorite is ALWAYS the -1.5 side. If the feed
  // landed the -1.5 on the ML underdog (an outcome-ordering quirk that flips some games),
  // swap the run-line points AND their odds so the favorite holds -1.5. No-op when already
  // correct. Keeps the displayed RL, the cover probabilities, EV, and the verdict all
  // consistent with the moneyline instead of contradicting it.
  const aProb = americanToProb(awayML), hProb = americanToProb(homeML);
  const aRLpt = parseFloat(awayRL), hRLpt = parseFloat(homeRL);
  if (aProb != null && hProb != null && aProb !== hProb && !isNaN(aRLpt) && !isNaN(hRLpt) && (aRLpt < 0) !== (hRLpt < 0)) {
    const awayIsFav = aProb > hProb;
    if (awayIsFav !== (aRLpt < 0)) {
      [awayRL, homeRL] = [homeRL, awayRL];
      [awayRLOdds, homeRLOdds] = [homeRLOdds, awayRLOdds];
    }
  }
  const lineAgeMin = lastUpdate ? Math.round((now - new Date(lastUpdate)) / 60000) : null;
  const stale = lineAgeMin != null && lineAgeMin > STALE_MIN;
  return {awayML,homeML,total,overOdds,underOdds,awayRL,homeRL,awayRLOdds,homeRLOdds,
          bookUsed, lastUpdate, lineAgeMin, stale, inPlaySkipped};
}

function validateTotal(oddsTotal, anTotal) {
  const ot=parseFloat(oddsTotal), at=parseFloat(anTotal);
  // Prefer Action Network if available and realistic
  if (anTotal&&!isNaN(at)&&at>=6.5&&at<=13.5) return `${at}`;
  // Use Odds API if realistic
  if (!isNaN(ot)&&ot>=6.5&&ot<=13.5) return `${ot}`;
  // If both out of range, try to find best bookmaker line from raw data
  console.log(`  Warning: unusual total ${oddsTotal} - may be alt market`);
  return oddsTotal;
}

async function analyzeGame(game, lines, anData, f5Lines, weather, awayStats, homeStats, awayPitcher, homePitcher, awayStatcast, homeStatcast, awayMatchups, homeMatchups, awayBullpen, homeBullpen, venueName, umpire, awayLineupOrder, homeLineupOrder, awayArsenal, homeArsenal, awayVsHomeArsenal, homeVsAwayArsenal) {
  console.log(`  Analyzing ${game.away_team} @ ${game.home_team}...`);

  // ── DETERMINISTIC RUN PROJECTIONS ──────────────────────────────────────────
  // Compute before the LLM prompt so the model receives auditable projections
  const parkFactors = getParkFactors(game.home_team, venueName);

  const awayRunProj = projectRuns({
    offenseStats: awayStats,
    offenseMatchups: awayMatchups,
    offenseOrder: awayLineupOrder,
    offenseHandedness: awayMatchups?.handedness,
    isOffenseHome: false,           // away team is always visiting
    defPitcher: homePitcher,
    defStatcast: homeStatcast,
    defPitcherHand: homePitcher?.throwHand,
    isPitcherHome: true,            // home pitcher pitching at home
    defBullpen: homeBullpen,
    arsenalMatchup: awayVsHomeArsenal,
    parkFactors, weather, umpire
  });

  const homeRunProj = projectRuns({
    offenseStats: homeStats,
    offenseMatchups: homeMatchups,
    offenseOrder: homeLineupOrder,
    offenseHandedness: homeMatchups?.handedness,
    isOffenseHome: true,            // home team at home
    defPitcher: awayPitcher,
    defStatcast: awayStatcast,
    defPitcherHand: awayPitcher?.throwHand,
    isPitcherHome: false,           // away pitcher pitching on road
    defBullpen: awayBullpen,
    arsenalMatchup: homeVsAwayArsenal,
    parkFactors, weather, umpire
  });

  const detProj = {
    awayRuns: awayRunProj.runs,
    homeRuns: homeRunProj.runs,
    total: +(parseFloat(awayRunProj.runs) + parseFloat(homeRunProj.runs)).toFixed(2),
    awayFactors: awayRunProj.factors,
    homeFactors: homeRunProj.factors
  };

  const formatFactors = (f) =>
    `pitcher×${f.pitcher} offense×${f.offense} park×${f.park} weather×${f.weather} umpire×${f.umpire} bullpen×${f.bullpen} platoon×${f.platoon}`;

  console.log(`  DET PROJ: ${game.away_team} ${detProj.awayRuns} - ${game.home_team} ${detProj.homeRuns} (tot ${detProj.total})`);
  console.log(`    Away factors: ${formatFactors(detProj.awayFactors)}`);
  console.log(`    Home factors: ${formatFactors(detProj.homeFactors)}`);
  // ── END DETERMINISTIC PROJECTIONS ──────────────────────────────────────────

  const weatherInfo = weather
    ? weather.dome ? 'Indoor dome — weather not a factor'
    : weather.weatherNeutralized ? `Retractable roof likely CLOSED (~${Math.round((weather.roofOpenProb ?? 0.2)*100)}% open) — treat as INDOOR: weather is NOT a factor and you must NOT tag this game "weather". (Outside conditions, for reference only: ${weather.summary})`
    : `${weather.summary}${weather.flags?.length ? '\nWeather flags: ' + weather.flags.join(', ') : ''}`
    : 'Weather data unavailable';

  const awayPitcherInfo = awayPitcher
    ? `${awayPitcher.name} (${awayPitcher.throwHand||'?'}HP): ERA ${awayPitcher.era}, WHIP ${awayPitcher.whip}, ${awayPitcher.wins}W-${awayPitcher.losses}L, Recent ERA ${awayPitcher.recentERA} (${awayPitcher.trending}), avg ${awayPitcher.avgIP||'?'} IP/start, Last 3: ${awayPitcher.last3?.map(g=>`${g.ip}IP/${g.er}ER`).join(', ')}` +
      (awayPitcher.homeERA || awayPitcher.awayERA ? ` | Home ERA: ${awayPitcher.homeERA||'?'} Away ERA: ${awayPitcher.awayERA||'?'}` : '') +
      (awayPitcher.venueERA ? ` | At this venue ERA: ${awayPitcher.venueERA}` : '') +
      (awayPitcher.vsLHB || awayPitcher.vsRHB ? ` | vs LHB: ERA ${awayPitcher.vsLHB?.era||'?'} OPS ${awayPitcher.vsLHB?.ops||'?'} | vs RHB: ERA ${awayPitcher.vsRHB?.era||'?'} OPS ${awayPitcher.vsRHB?.ops||'?'}` : '')
    : 'Away pitcher: TBD';

  const homePitcherInfo = homePitcher
    ? `${homePitcher.name} (${homePitcher.throwHand||'?'}HP): ERA ${homePitcher.era}, WHIP ${homePitcher.whip}, ${homePitcher.wins}W-${homePitcher.losses}L, Recent ERA ${homePitcher.recentERA} (${homePitcher.trending}), avg ${homePitcher.avgIP||'?'} IP/start, Last 3: ${homePitcher.last3?.map(g=>`${g.ip}IP/${g.er}ER`).join(', ')}` +
      (homePitcher.homeERA || homePitcher.awayERA ? ` | Home ERA: ${homePitcher.homeERA||'?'} Away ERA: ${homePitcher.awayERA||'?'}` : '') +
      (homePitcher.venueERA ? ` | At this venue ERA: ${homePitcher.venueERA}` : '') +
      (homePitcher.vsLHB || homePitcher.vsRHB ? ` | vs LHB: ERA ${homePitcher.vsLHB?.era||'?'} OPS ${homePitcher.vsLHB?.ops||'?'} | vs RHB: ERA ${homePitcher.vsRHB?.era||'?'} OPS ${homePitcher.vsRHB?.ops||'?'}` : '')
    : 'Home pitcher: TBD';

  const awayBullpenInfo = awayBullpen ? `${game.away_team} bullpen: ${awayBullpen.summary}` : `${game.away_team} bullpen: unavailable`;
  const homeBullpenInfo = homeBullpen ? `${game.home_team} bullpen: ${homeBullpen.summary}` : `${game.home_team} bullpen: unavailable`;

  const awayHand = awayMatchups?.handedness;
  const homeHand = homeMatchups?.handedness;
  const platoonInfo =
    `${game.away_team} lineup bats: ${awayHand ? `${awayHand.L}L/${awayHand.R}R/${awayHand.S}S` : '?'} vs ${homePitcher?.throwHand||'?'}HP (home starter)\n` +
    `${game.home_team} lineup bats: ${homeHand ? `${homeHand.L}L/${homeHand.R}R/${homeHand.S}S` : '?'} vs ${awayPitcher?.throwHand||'?'}HP (away starter)`;

  const pf = getParkFactors(game.home_team, venueName);
  const atNeutral = venueName && VENUE_PARKS[venueName];
  const parkInfo = `${atNeutral ? `Venue: ${venueName} (neutral/alternate site) — ` : ''}${game.home_team} park: run factor ${pf.runFactor} (1.0 = neutral, >1 = hitter-friendly), wind plays ${pf.windFactor}x (how much wind matters here)${pf.retractable ? ', retractable roof' : ''}`;

  const shadow = shadowProfile(game.home_team, game.commence_time, venueName);
  const shadowInfo = shadow ? shadow.note : 'No day-game shadow factor (night game, roofed park, or low susceptibility).';

  const awayTeamInfo = awayStats
    ? `${awayStats.teamName}: AVG ${awayStats.avg}, OPS ${awayStats.ops}, ${awayStats.runs} runs scored, ${awayStats.hr} HR, Last 10: ${awayStats.last10||'N/A'}` +
      (awayStats.awayOPS ? ` | Road OPS: ${awayStats.awayOPS} (home OPS: ${awayStats.homeOPS||'?'})` : '')
    : `${game.away_team}: Stats unavailable`;

  const homeTeamInfo = homeStats
    ? `${homeStats.teamName}: AVG ${homeStats.avg}, OPS ${homeStats.ops}, ${homeStats.runs} runs scored, ${homeStats.hr} HR, Last 10: ${homeStats.last10||'N/A'}` +
      (homeStats.homeOPS ? ` | Home OPS: ${homeStats.homeOPS} (road OPS: ${homeStats.awayOPS||'?'})` : '')
    : `${game.home_team}: Stats unavailable`;

  const publicInfo = anData
    ? `ML public: Away ${anData.awayMLPct||'?'}% bets/${anData.awayMoneyPct||'?'}% money | Home ${anData.homeMLPct||'?'}% bets/${anData.homeMoneyPct||'?'}% money\nTotal public: ${anData.overPct||'?'}% Over / ${anData.underPct||'?'}% Under`
    : 'Public betting data unavailable';

  const awayStatcastInfo = awayStatcast
    ? `${awayPitcher?.name||'Away'} Statcast: avg velo ${awayStatcast.avgVelo}mph (${awayStatcast.veloTrend}), last start ${awayStatcast.lastStartVelo}mph, whiff% ${awayStatcast.whiffRate}, hard hit% ${awayStatcast.hardHitRate}, barrel% ${awayStatcast.barrelRate}` +
      (awayStatcast.xERA ? ` | xERA ${awayStatcast.xERA}, xFIP ${awayStatcast.xFIP||'?'}, xwOBA ${awayStatcast.xwOBA||'?'}` : '') +
      (awayStatcast.last3Rates?.length ? ` | Last 3 starts K%: ${awayStatcast.last3Rates.map(s=>s.kPct).join('/')} BB%: ${awayStatcast.last3Rates.map(s=>s.bbPct).join('/')}` : '')
    : 'Away pitcher Statcast: unavailable';

  const homeStatcastInfo = homeStatcast
    ? `${homePitcher?.name||'Home'} Statcast: avg velo ${homeStatcast.avgVelo}mph (${homeStatcast.veloTrend}), last start ${homeStatcast.lastStartVelo}mph, whiff% ${homeStatcast.whiffRate}, hard hit% ${homeStatcast.hardHitRate}, barrel% ${homeStatcast.barrelRate}` +
      (homeStatcast.xERA ? ` | xERA ${homeStatcast.xERA}, xFIP ${homeStatcast.xFIP||'?'}, xwOBA ${homeStatcast.xwOBA||'?'}` : '') +
      (homeStatcast.last3Rates?.length ? ` | Last 3 starts K%: ${homeStatcast.last3Rates.map(s=>s.kPct).join('/')} BB%: ${homeStatcast.last3Rates.map(s=>s.bbPct).join('/')}` : '')
    : 'Home pitcher Statcast: unavailable';

  const umpireInfo = umpire
    ? `HP Umpire: ${umpire.umpireName} | runs/game ${umpire.runsPerGame||'?'} (league avg ~8.8) | tendency: ${umpire.tendency} — ${umpire.tendency==='HIGH_SCORER'?'tight zone, expect more walks/runs':umpire.tendency==='LOW_SCORER'?'wide zone, expect more Ks/fewer runs':'neutral impact on scoring'}`
    : 'Umpire data unavailable';

  const formatLineupOrder = (order, teamName) => {
    if (!order?.length) return `${teamName} lineup order: unavailable`;
    const formatted = order.map((b,i) => `${i+1}. ${b.name}${b.ops?' (OPS '+b.ops+')':''}`).join(', ');
    return `${teamName} batting order: ${formatted}`;
  };

  const awayMatchupInfo = (awayMatchups && awayMatchups.avgOPS != null)
    ? `${game.away_team} lineup vs ${homePitcher?.name||'home pitcher'}: avg OPS ${awayMatchups.avgOPS}, avg AVG ${awayMatchups.avgAVG}, K% ${awayMatchups.kRate}, hot bats ${awayMatchups.hotBatters}, cold bats ${awayMatchups.coldBatters} (${awayMatchups.sample})`
    : `${game.away_team} lineup matchup data: unavailable (lineup not yet posted or no history vs this pitcher)`;

  const homeMatchupInfo = (homeMatchups && homeMatchups.avgOPS != null)
    ? `${game.home_team} lineup vs ${awayPitcher?.name||'away pitcher'}: avg OPS ${homeMatchups.avgOPS}, avg AVG ${homeMatchups.avgAVG}, K% ${homeMatchups.kRate}, hot bats ${homeMatchups.hotBatters}, cold bats ${homeMatchups.coldBatters} (${homeMatchups.sample})`
    : `${game.home_team} lineup matchup data: unavailable (lineup not yet posted or no history vs this pitcher)`;

  const f5Info = f5Lines
    ? `F5 ML: Away ${f5Lines.f5AwayML||'N/A'} / Home ${f5Lines.f5HomeML||'N/A'}\nF5 Total: ${f5Lines.f5Total||'N/A'} (Over ${f5Lines.f5OverOdds||'N/A'} / Under ${f5Lines.f5UnderOdds||'N/A'})`
    : 'F5 lines unavailable';

  const prompt = `You are an expert MLB betting analyst. Today is ${new Date().toLocaleDateString('en-US',{weekday:'long',month:'long',day:'numeric',year:'numeric'})}. Analyze this game using all provided data and return ONLY valid JSON.

GAME: ${game.away_team} @ ${game.home_team}
Time: ${new Date(game.commence_time).toLocaleTimeString('en-US',{hour:'numeric',minute:'2-digit',timeZone:'America/New_York'})} ET

FULL GAME LINES:
ML: Away ${lines.awayML||'?'} / Home ${lines.homeML||'?'}
RL: Away ${lines.awayRL||'?'} (${lines.awayRLOdds||'?'}) / Home ${lines.homeRL||'?'} (${lines.homeRLOdds||'?'})
Total: ${lines.total||'?'} — Over ${lines.overOdds||'?'} / Under ${lines.underOdds||'?'}

FIRST 5 INNINGS:
${f5Info}

WEATHER:
${weatherInfo}

UMPIRE:
${umpireInfo}

BATTING ORDER:
${formatLineupOrder(awayLineupOrder, game.away_team)}
${formatLineupOrder(homeLineupOrder, game.home_team)}

PITCH ARSENAL & ARM SLOT vs LINEUP SWING TENDENCIES:
${awayArsenal ? `${awayPitcher?.name||'Away'} (${awayArsenal.armSlot}): ${awayArsenal.arsenal.slice(0,4).map(p=>`${p.name} ${p.pct}% velo ${p.velo}mph whiff ${p.whiffPct}%`).join(' | ')}` : `${awayPitcher?.name||'Away'} arsenal: unavailable`}
${homeArsenal ? `${homePitcher?.name||'Home'} (${homeArsenal.armSlot}): ${homeArsenal.arsenal.slice(0,4).map(p=>`${p.name} ${p.pct}% velo ${p.velo}mph whiff ${p.whiffPct}%`).join(' | ')}` : `${homePitcher?.name||'Home'} arsenal: unavailable`}
${awayVsHomeArsenal ? `${game.away_team} vs ${homePitcher?.name||'home'}: ${awayVsHomeArsenal.overallEdge} | ${awayVsHomeArsenal.matchups.map(m=>`${m.pitch}: lineup whiff ${m.lineupWhiff}% chase ${m.lineupChase}% hardHit ${m.lineupHardHit}% (pitcher whiff ${m.pitcherWhiff}%) → ${m.edge}`).join(' | ')}` : `${game.away_team} vs home arsenal matchup: unavailable`}
${homeVsAwayArsenal ? `${game.home_team} vs ${awayPitcher?.name||'away'}: ${homeVsAwayArsenal.overallEdge} | ${homeVsAwayArsenal.matchups.map(m=>`${m.pitch}: lineup whiff ${m.lineupWhiff}% chase ${m.lineupChase}% hardHit ${m.lineupHardHit}% (pitcher whiff ${m.pitcherWhiff}%) → ${m.edge}`).join(' | ')}` : `${game.home_team} vs away arsenal matchup: unavailable`}

PARK FACTORS:
${parkInfo}

DAY-GAME SHADOW / SCORING DISTRIBUTION:
${shadowInfo}

DETERMINISTIC RUN PROJECTION (computed from explicit factors — use as your projection anchor):
${game.away_team}: ${detProj.awayRuns} runs | factors: ${formatFactors(detProj.awayFactors)}
${game.home_team}: ${detProj.homeRuns} runs | factors: ${formatFactors(detProj.homeFactors)}
Projected total: ${detProj.total} | Posted line: ${lines.total}
NOTE: This projection is computed from pitcher ERA (60% recent/40% season weighted), lineup OPS, park factor, weather, umpire tendency, bullpen exposure, and platoon splits. You may adjust by up to ±0.5 runs based on specific matchup factors not captured here (arsenal matchup, lineup quality vs this specific pitcher, etc.) but you MUST NOT deviate by more than 1.0 run without documenting why. Your projAwayRuns and projHomeRuns in the response JSON should be your final adjusted number. MINIMUM: never project below 3.0 runs for either team regardless of pitcher quality — even elite pitchers allow 3+ runs on average.

PITCHING MATCHUP:
Away: ${awayPitcherInfo}
${awayStatcastInfo}
Home: ${homePitcherInfo}
${homeStatcastInfo}

BULLPENS (quality + recent workload — a tired or weak pen loses late leads):
${awayBullpenInfo}
${homeBullpenInfo}

PLATOON / HANDEDNESS:
${platoonInfo}

LINEUP VS PITCHER MATCHUPS (career stats — min 10 AB):
${awayMatchupInfo}
${homeMatchupInfo}

TEAM STATS (2026 season):
Away: ${awayTeamInfo}
Home: ${homeTeamInfo}

PUBLIC BETTING:
${publicInfo}

ANALYSIS INSTRUCTIONS — CRITICAL:
- Your job is PROBABILITIES and PROJECTIONS, nothing else. The EV, breakeven, win probabilities, and juice-sensitivity numbers are computed DOWNSTREAM from your projections — do not freehand them.
- PROJECT EACH TEAM'S EXPECTED RUNS separately as projAwayRuns and projHomeRuns. These are the most important numbers you produce: the downstream math derives ML (who wins), RL (margin), and the total (their sum) all from these two numbers via a run-margin model. Project them carefully from 2026 run rates, the pitching matchup, Statcast, bullpens, platoon edges, lineup matchups, park, and weather.
- ML / RL come from the projected run MARGIN (projAwayRuns - projHomeRuns), not a gut feel. A bigger projected margin = bigger favorite and better run-line cover odds. Do not hand-tune mlAwayProb; just project the runs accurately.
- BULLPEN matters for who WINS, not just totals: a TAXED or high-ERA pen is more likely to blow a late lead — shade the run margin toward the team with the stronger/fresher pen, especially in tight projected games.
- CLOSER AVAILABILITY: If the closer is LIKELY UNAVAILABLE or QUESTIONABLE, the fill-in closer is typically less reliable. Reduce confidence in that team holding a late lead. If both the closer AND setup man are taxed, treat the pen as significantly degraded for save situations.
- BLOWN SAVE RISK: A closer with 2+ blown saves on the season, pitching on back-to-back days, or listed as QUESTIONABLE is a meaningful risk factor. Do not eliminate a play because of this alone, but factor it into the run margin — a degraded closer means tighter projected margins.
- PLATOON: a lineup stacked opposite-handed to the starter (e.g. many R bats vs a LHP) should score more; same-handed heavy lineups score less. Fold this into the run projections.
- EXPECTED STARTER LENGTH: a starter averaging under ~5 IP exposes the bullpen earlier — weight the bullpen more heavily for that team.
- SHARP / LINE ACTION IS INFORMATIONAL ONLY. Report any sharp or line-movement read in lineNote / sharpSide / lineSharp for display, but DO NOT let public or sharp money move your run projections or probabilities. Project independently of the market.
- The "situations" array must ONLY contain these exact lowercase values: revenge, travel, sharp, weather, rest, series, fade, mustwin, debut. DO NOT add any other values. DO NOT use situations to flag data availability issues. If data is missing just work with what you have.
- fadeReason: WHENEVER you tag "fade", you MUST populate fadeReason — never leave it empty if fade is in situations. Use ONLY these values: velo (starter velocity trending DOWN vs season average by 1+ mph), coldarm (starter recent ERA or WHIP significantly worse than season average — last 3 starts), contact (starter hard-hit rate >=42% OR barrel rate above league avg with low whiff), form (team 2-8 or worse in last 10 games). Multiple allowed. If you tagged "fade" but cannot identify a specific reason from this list, remove "fade" from situations entirely. This is ANNOTATION ONLY — it records why you faded.
- USE ONLY 2026 SEASON STATS for all projections. IGNORE all prior year data entirely.
- STATCAST IS CRITICAL: A pitcher with velocity DOWN trend is significantly worse than ERA suggests — fade. A pitcher with low barrel rate and high whiff rate is elite regardless of ERA — back. Hard hit rate above 42% means the pitcher is getting hit hard even if runs haven't scored yet.
- LINEUP MATCHUPS OVERRIDE SEASON STATS: if the opposing lineup has OPS below .600 vs this pitcher with 25%+ K rate, project that team's runs 20-25% lower than season average. If lineup has OPS above .850 vs this pitcher, project 20-25% higher.
- Velocity DOWN on last start vs season average = COLD flag, reduce confidence, lean against this pitcher
- Velocity UP or STABLE = trust the ERA and recent form
- Hot pitchers (trending HOT — recent ERA significantly lower than season ERA) = team edge
- Cold pitchers (trending COLD) = fade regardless of reputation or contract
- Wind 15+ mph blowing out = more runs, 15+ mph in = fewer runs. The wind figure already accounts for how much THIS park plays the wind, so trust it as given.
- APPLY THE PARK RUN FACTOR to your run projections: multiply the run environment by it (e.g. 1.06 = project ~6% more runs, 0.92 = ~8% fewer). This is a real number — use it instead of recalling park reputations.
- DAY-GAME SHADOW: if a shadow profile is given, apply it as a SCORING-DISTRIBUTION shift, not a flat under — add its early-innings runs to your F5 projection and its late-innings runs to the full game. It is a small, approximate effect; do not let it swing a play on its own.
- Current season form only — a team 2-8 in last 10 is a fade regardless of brand
- PITCH ARSENAL vs SWING PATH: This is the most important matchup factor. If a pitcher's primary pitch (40%+ usage) has a high whiff rate AND the opposing lineup also whiffs at high rates on that pitch type, the pitcher has a dominant edge — project lower runs for that lineup. If the lineup makes hard contact (38%+) on the pitcher's primary pitch, project higher runs. Arm slot matters: over-the-top pitchers with heavy breaking balls are harder for same-handed batters; sidearm/low three-quarter pitchers are more effective against same-handed batters due to movement angle. Use PITCHER DOMINATES / LINEUP ADVANTAGE / EVEN classification directly in your run projection.
- UMPIRE IMPACT: HP umpires with runs/game significantly above 8.8 (league avg) have tight zones — more walks, more baserunners, more scoring. Factor this into totals projection (HIGH_SCORER umpire = +0.3 to +0.5 runs, LOW_SCORER = -0.3 to -0.5 runs). Do not let it swing a ML/RL call on its own.
- LINEUP ORDER MATTERS: A team with their best hitters in slots 3-5 with weak 1-2 hitters scores fewer early runs. A balanced lineup (good hitters spread across 1-6) generates more consistent scoring. Factor batting order quality into run projections especially for F5.
- xERA vs ERA: If a pitcher's xERA is significantly higher than their ERA (by 0.75+), they are overperforming and regression is likely — treat them as worse than ERA suggests. If xERA is lower than ERA, they have been unlucky and are better than ERA suggests.
- PROJECTION CALIBRATION: Historical tracking across 241 games shows your total projections run high by an average of 0.14 runs (actual avg 8.80 vs projected avg 8.95). More importantly, 63% of games come in UNDER your projection vs 37% over. This means when your edge on a total is marginal, lean toward under. Do NOT force under calls — only call under when the data genuinely supports it. But when the game projects to 8.8 and the line is 8.5, consider whether the true projection after calibration is closer to 8.66 (8.80 - 0.14), which changes the edge calculation meaningfully.

Return ONLY this JSON (no markdown, no code fences). Return ONLY these fields — every EV, breakeven, win-probability, and juice table is recomputed downstream from your projections, so do NOT include them:
{
  "situations": ["revenge","travel","sharp","weather","rest","series","fade","mustwin","debut"],
  "fadeReason": [],
  "projAwayRuns": NUMBER,
  "projHomeRuns": NUMBER,
  "projTotal": NUMBER,
  "f5ProjTotal": NUMBER,
  "ml": "BET AWAY|BET HOME|LEAN AWAY|LEAN HOME|SKIP",
  "rl": "BET AWAY|BET HOME|LEAN AWAY|LEAN HOME|SKIP",
  "total": "BET OVER|BET UNDER|LEAN OVER|LEAN UNDER|SKIP",
  "f5": "BET AWAY|BET HOME|BET OVER|BET UNDER|LEAN AWAY|LEAN HOME|LEAN OVER|LEAN UNDER|SKIP",
  "best": "ml|rl|total|f5",
  "bestPlay": "one sentence on the strongest play",
  "confidence": "LOW|MEDIUM|HIGH",
  "lineSharp": true|false,
  "sharpSide": "${game.away_team}|${game.home_team}|NONE",
  "lineNote": "brief note on line movement or public action",
  "weatherImpact": "none|over|under|significant",
  "pitcherEdge": "${game.away_team}|${game.home_team}|EVEN",
  "situation": "2 sentences on key situational and pitching factors",
  "factors": "2 sentences on stats, hot/cold streaks, and matchup",
  "risks": "1 sentence on biggest risk to the top play"
}

The projTotal and f5ProjTotal are the most important numbers you produce — the downstream math converts them into win probabilities, EV, breakeven lines, and the full juice-sensitivity table. Project carefully using 2026 data, Statcast, and lineup matchups.`;

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: 'claude-sonnet-4-5', max_tokens: 2000, messages: [{ role: 'user', content: prompt }] })
  });

  if (!res.ok) throw new Error(`Claude error: ${res.status}`);
  const data = await res.json();
  const text = data.content.map(c => c.text||'').join('').trim();
  try {
    const clean = text.replace(/```json|```/g,'').trim();
    const s=clean.indexOf('{'), e=clean.lastIndexOf('}');
    return JSON.parse(clean.substring(s,e+1));
  } catch(err) {
    console.error(`Parse error:`, text.substring(0,200));
    return null;
  }
}

// ── DETERMINISTIC CONFIDENCE FORMULA ─────────────────────────────────────────
// Replaces LLM subjective confidence with a rule-based score.
// Based on 160-bet sample analysis (June 11-20, 2026):
//   - Model LEAN outperforms BET (71% vs 64%) — strength label not reliable
//   - Agreed BET is strongest signal (73%, +53.5% ROI)
//   - Agreed LEAN is negative — penalize
//   - LOW confidence anywhere: 1-3 (33%) — don't bet
//   - Big dogs inflate EV artificially — cap confidence
//   - 6-9% EV on standalone plays: 75% win rate — best calibrated bucket
//   - 15-19% EV: 54% — overconfident range, no bonus
//   - Totals underside: 83% win rate
//
// Score → Label:  ≥7 = HIGH | 4-6 = MEDIUM | 1-3 = LOW | 0 = SKIP (don't bet)
function computeConfidence(analysis, lines) {
  if (!analysis) return 'LOW';

  let score = 0;

  // ── 1. Best play EV tier ──────────────────────────────────────────────────
  // Use the highest EV market that has a verdict
  const markets = [
    { verdict: analysis.ml,    ev: parseFloat(analysis.mlEV    || 0) },
    { verdict: analysis.rl,    ev: parseFloat(analysis.rlEV    || 0) },
    { verdict: analysis.total, ev: parseFloat(analysis.totalEV || 0) },
  ].filter(m => m.verdict && m.verdict !== 'SKIP' && m.ev >= 6);

  if (!markets.length) return 'LOW'; // no qualifying play

  const bestEV = Math.max(...markets.map(m => m.ev));

  if      (bestEV >= 20)  score += 4;
  else if (bestEV >= 10)  score += 3;
  else if (bestEV >= 6)   score += 2;
  // 15-19% gets same as 10-14% — no bonus for that range based on data

  // ── 2. Model / Sim agreement ──────────────────────────────────────────────
  // Check each qualifying market for agreement
  const mkts = ['ml','rl','total'];
  let anyAgree = false, anyDisagree = false;

  for (const mkt of mkts) {
    const modelV = analysis[mkt];
    const simV   = analysis['sim' + mkt.charAt(0).toUpperCase() + mkt.slice(1)];
    if (!modelV || modelV === 'SKIP') continue;
    if (!simV   || simV   === 'SKIP') continue;
    // Extract side from verdict e.g. "BET AWAY" → "AWAY"
    const modelSide = (modelV.match(/(AWAY|HOME|OVER|UNDER)/)||[])[1];
    const simSide   = (simV.match(  /(AWAY|HOME|OVER|UNDER)/)||[])[1];
    if (!modelSide || !simSide) continue;
    if (modelSide === simSide) anyAgree = true;
    else anyDisagree = true;
  }

  if (anyAgree && !anyDisagree)  score += 3; // full agreement = biggest boost
  else if (anyAgree)             score += 1; // partial agreement
  else if (anyDisagree)          score -= 1; // disagreement = penalty

  // ── 3. BET vs LEAN strength ───────────────────────────────────────────────
  // Data shows LEAN outperforms BET — no penalty for LEAN, but BET on agreed plays gets a boost
  const bestMkt = markets.sort((a,b) => b.ev - a.ev)[0];
  const isBet = bestMkt && bestMkt.verdict && bestMkt.verdict.startsWith('BET');
  if (isBet && anyAgree && !anyDisagree) score += 1; // agreed BET = strongest signal

  // ── 4. Situation flags ────────────────────────────────────────────────────
  const sits = (analysis.situations || []).map(s => (s||'').toLowerCase().trim());
  const fadePresent = sits.includes('fade');
  const sitCount = sits.filter(s => ['revenge','travel','sharp','weather','rest','series','fade'].includes(s)).length;

  if (sitCount >= 2) score += 2;
  else if (sitCount === 1) score += 1;

  // ── 5. Price range guard — big dogs inflate EV artificially ──────────────
  // Cap confidence on extreme underdogs regardless of EV
  const bestOdds = (() => {
    const v = bestMkt?.verdict || '';
    const side = (v.match(/(AWAY|HOME|OVER|UNDER)/)||[])[1];
    if (!side) return null;
    if (bestMkt.verdict.includes('AWAY') && analysis.ml?.includes('AWAY')) return parseFloat(lines?.awayML || 0);
    if (bestMkt.verdict.includes('HOME') && analysis.ml?.includes('HOME')) return parseFloat(lines?.homeML || 0);
    if (bestMkt.verdict.includes('AWAY') && analysis.rl?.includes('AWAY')) return parseFloat(lines?.awayRLOdds || 0);
    if (bestMkt.verdict.includes('HOME') && analysis.rl?.includes('HOME')) return parseFloat(lines?.homeRLOdds || 0);
    if (bestMkt.verdict.includes('OVER'))  return parseFloat(lines?.overOdds || 0);
    if (bestMkt.verdict.includes('UNDER')) return parseFloat(lines?.underOdds || 0);
    return null;
  })();

  if (bestOdds && bestOdds >= 200)  score -= 2; // big dog +200 or more
  else if (bestOdds && bestOdds >= 150) score -= 1; // dog +150 to +199

  // ── 6. Under plays get a small boost (83% hit rate) ───────────────────────
  const hasUnder = markets.some(m => m.verdict && m.verdict.includes('UNDER'));
  if (hasUnder) score += 1;

  // ── Final label ───────────────────────────────────────────────────────────
  if (score >= 7) return 'HIGH';
  if (score >= 4) return 'MEDIUM';
  if (score >= 1) return 'LOW';
  return 'LOW'; // never return SKIP — let EV gate handle play selection
}

async function upsertGame(game, lines, analysis, anData, f5Lines, weather, awayPitcherData, homePitcherData, awayStatcastData, homeStatcastData, awayMatchupData, homeMatchupData, pitcherStatus, gamePk) {
  const row = {
    id: game.id,
    game_pk: gamePk || null,
    game_date: new Date(game.commence_time).toLocaleDateString('en-CA', {timeZone: 'America/New_York'}),
    away_team: game.away_team,
    home_team: game.home_team,
    commence_time: game.commence_time,
    away_pitcher: awayPitcherData?.name || 'TBD',
    home_pitcher: homePitcherData?.name || 'TBD',
    away_pitcher_hand: awayPitcherData?.throwHand || null,
    home_pitcher_hand: homePitcherData?.throwHand || null,
    pitcher_status: pitcherStatus || 'tbd',
    away_pitcher_debut: awayPitcherData?.debut || false,
    home_pitcher_debut: homePitcherData?.debut || false,
    away_ml: lines.awayML,
    home_ml: lines.homeML,
    total: lines.total,
    over_odds: lines.overOdds,
    under_odds: lines.underOdds,
    away_rl: lines.awayRL,
    home_rl: lines.homeRL,
    away_rl_odds: lines.awayRLOdds,
    home_rl_odds: lines.homeRLOdds,
    f5_away_ml: f5Lines?.f5AwayML||null,
    f5_home_ml: f5Lines?.f5HomeML||null,
    f5_total: f5Lines?.f5Total||null,
    f5_over_odds: f5Lines?.f5OverOdds||null,
    f5_under_odds: f5Lines?.f5UnderOdds||null,
    away_ml_pct: anData?.awayMLPct||null,
    home_ml_pct: anData?.homeMLPct||null,
    over_pct: anData?.overPct||null,
    under_pct: anData?.underPct||null,
    weather_summary: weather?.summary||null,
    weather_temp: weather?.temp||null,
    weather_wind_speed: weather?.windSpeed||null,
    weather_wind_dir: weather?.windCard||null,
    weather_field_wind_dir: weather?.fieldWindDir||null,
    weather_wind_arrow: weather?.windArrow||null,
    weather_flags: weather?.flags||[],
    weather_dome: weather?.dome||false,
    run_type: RUN_TYPE,
    updated_at: new Date().toISOString(),
    away_velo: awayStatcastData?.avgVelo || null,
    away_velo_trend: awayStatcastData?.veloTrend || null,
    away_whiff_rate: awayStatcastData?.whiffRate || null,
    away_barrel_rate: awayStatcastData?.barrelRate || null,
    away_hard_hit: awayStatcastData?.hardHitRate || null,
    home_velo: homeStatcastData?.avgVelo || null,
    home_velo_trend: homeStatcastData?.veloTrend || null,
    home_whiff_rate: homeStatcastData?.whiffRate || null,
    home_barrel_rate: homeStatcastData?.barrelRate || null,
    home_hard_hit: homeStatcastData?.hardHitRate || null,
    away_lineup_ops: awayMatchupData?.avgOPS || null,
    away_lineup_k_rate: awayMatchupData?.kRate || null,
    home_lineup_ops: homeMatchupData?.avgOPS || null,
    home_lineup_k_rate: homeMatchupData?.kRate || null,
    lineup_status: (awayMatchupData && homeMatchupData) ? 'confirmed' : (awayMatchupData || homeMatchupData) ? 'partial' : 'projected'
  };

  if (analysis) {
    Object.assign(row, {
      analyzed: true,
      analyzed_at: new Date().toISOString(),
      situations: (analysis.situations||[])
        .filter(s => ['revenge','travel','sharp','weather','rest','series','fade','mustwin','debut'].includes((s||'').toLowerCase().trim()))
        .filter(s => !(weather?.weatherNeutralized && (s||'').toLowerCase().trim() === 'weather'))
        .filter(s => {
          // Remove fade tag if no specific reason can be identified
          if ((s||'').toLowerCase().trim() !== 'fade') return true;
          const faded = (analysis.situations||[]).map(x => (x||'').toLowerCase().trim()).includes('fade');
          if (!faded) return false;
          // Check if any fade reason exists from LLM or Statcast
          const llmReasons = (analysis.fadeReason||[]).map(r => (r||'').toLowerCase().trim()).filter(r => ['velo','coldarm','contact','form'].includes(r));
          const hasVelo = awayStatcastData && String(awayStatcastData.veloTrend||'').toUpperCase() === 'DOWN' || homeStatcastData && String(homeStatcastData.veloTrend||'').toUpperCase() === 'DOWN';
          const hasContact = awayStatcastData && parseFloat(awayStatcastData.hardHitRate) >= 42 || homeStatcastData && parseFloat(homeStatcastData.hardHitRate) >= 42;
          const hasCold = awayPitcherData && String(awayPitcherData.trending||'').toUpperCase() === 'COLD' || homePitcherData && String(homePitcherData.trending||'').toUpperCase() === 'COLD';
          const hasForm = llmReasons.includes('form');
          return llmReasons.length > 0 || hasVelo || hasContact || hasCold || hasForm;
        }),
      fade_reason: (() => {
        // The model self-reports fadeReason but collapses to the dominant narrative (coldarm/form),
        // dropping velo/contact even when the Statcast numbers it was shown clearly meet the bar.
        // So we DERIVE those reasons deterministically from the same numbers and union them in.
        // ANNOTATION ONLY — this does not change whether or how anything was faded.
        const faded = (analysis.situations||[]).map(s => (s||'').toLowerCase().trim()).includes('fade');
        if (!faded) return '';
        const reasons = new Set(
          (analysis.fadeReason||[]).map(r => (r||'').toLowerCase().trim())
            .filter(r => ['velo','coldarm','contact','form'].includes(r))
        );
        const down = sc => sc && String(sc.veloTrend||'').toUpperCase() === 'DOWN';
        if (down(awayStatcastData) || down(homeStatcastData)) reasons.add('velo');
        const hardhit = sc => sc && parseFloat(sc.hardHitRate) >= 42;
        if (hardhit(awayStatcastData) || hardhit(homeStatcastData)) reasons.add('contact');
        const cold = p => p && String(p.trending||'').toUpperCase() === 'COLD';
        if (cold(awayPitcherData) || cold(homePitcherData)) reasons.add('coldarm');
        return [...reasons].join(',');
      })(),
      ml_verdict: analysis.ml,
      ml_ev: analysis.mlEV,
      rl_verdict: analysis.rl,
      rl_ev: analysis.rlEV,
      sweep_fade: analysis.sweepFade || null,
      total_verdict: analysis.total,
      total_ev: analysis.totalEV,
      total_line: analysis.totalLine,
      proj_total: analysis.projTotal,
      proj_away_runs: analysis.projAwayRuns != null ? Math.max(3.0, parseFloat(analysis.projAwayRuns)).toFixed(1) : null,
      proj_home_runs: analysis.projHomeRuns != null ? Math.max(3.0, parseFloat(analysis.projHomeRuns)).toFixed(1) : null,
      sim_away_runs: analysis.simAwayRuns ?? null,
      sim_home_runs: analysis.simHomeRuns ?? null,
      sim_ml_verdict: analysis.simMl ?? null,
      sim_ml_ev: analysis.simMlEV ?? null,
      sim_rl_verdict: analysis.simRl ?? null,
      sim_rl_ev: analysis.simRlEV ?? null,
      sim_total_verdict: analysis.simTotal ?? null,
      sim_total_ev: analysis.simTotalEV ?? null,
      rl_away_prob: analysis.rlAwayProb ?? null,
      rl_home_prob: analysis.rlHomeProb ?? null,
      f5_verdict: analysis.f5,
      f5_ev: analysis.f5EV,
      f5_line: analysis.f5Line,
      f5_proj_total: analysis.f5ProjTotal,
      best_market: analysis.best,
      best_play: analysis.bestPlay,
      ml_breakeven: analysis.mlBreakeven,
      ml_away_prob: analysis.mlAwayProb,
      ml_home_prob: analysis.mlHomeProb,
      rl_breakeven: analysis.rlBreakeven,
      total_breakeven: analysis.totalBreakeven,
      total_juice_sensitivity: analysis.totalJuiceSensitivity ? JSON.stringify(analysis.totalJuiceSensitivity) : null,
      f5_juice_sensitivity: analysis.f5JuiceSensitivity ? JSON.stringify(analysis.f5JuiceSensitivity) : null,
      f5_breakeven: analysis.f5Breakeven,
      away_win_pct: analysis.awayWinPct,
      home_win_pct: analysis.homeWinPct,
      edge_pct: analysis.edgePct,
      confidence: computeConfidence(analysis, lines),
      line_sharp: analysis.lineSharp,
      sharp_side: analysis.sharpSide,
      line_note: analysis.lineNote,
      weather_impact: (weather?.weatherNeutralized ? 'none' : analysis.weatherImpact),
      pitcher_edge: analysis.pitcherEdge,
      situation_text: analysis.situation,
      factors_text: analysis.factors,
      risks_text: analysis.risks
    });
  }

  const res = await fetch(`${SUPABASE_URL}/rest/v1/mlb_games`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'apikey': SUPABASE_SERVICE_KEY,
      'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
      'Prefer': 'resolution=merge-duplicates'
    },
    body: JSON.stringify(row)
  });

  if (!res.ok) console.error(`Supabase error:`, await res.text());
}

// ── AUTO SETTLE PENDING BETS ─────────────────────────────────────────────────
// Convert American odds to implied probability (includes vig; fine for CLV deltas
// since both sides carry comparable juice and we compare the same market over time).
function americanToProb(o){ o=parseFloat(o); if(isNaN(o)) return null; return o>0 ? 100/(o+100) : (-o)/((-o)+100); }
// Map a bet's type to the closing price + line on its exact side, from a stored game row.
function closingForBet(typeRaw, g){
  const type=(typeRaw||'').toLowerCase(), f5=type.includes('f5');
  if(type.includes('over'))  return { odds: f5?g.f5_over_odds:g.over_odds,  line: f5?g.f5_total:g.total };
  if(type.includes('under')) return { odds: f5?g.f5_under_odds:g.under_odds, line: f5?g.f5_total:g.total };
  if(type.includes('(away')) return { odds: f5?g.f5_away_ml:(type.includes('run line')?g.away_rl_odds:g.away_ml), line: type.includes('run line')?g.away_rl:null };
  if(type.includes('(home')) return { odds: f5?g.f5_home_ml:(type.includes('run line')?g.home_rl_odds:g.home_ml), line: type.includes('run line')?g.home_rl:null };
  if(type.includes('rl -1.5')) return { odds: g.away_rl_odds, line: g.away_rl };
  if(type.includes('rl +1.5')) return { odds: g.home_rl_odds, line: g.home_rl };
  return { odds:null, line:null };
}

// ── PER-BOOK CLOSING SNAPSHOT + BOOK-GATED CLV ───────────────────────────────
// CLV is only meaningful when the closing price comes from the SAME book you bet
// at. So at close we snapshot EVERY pre-game book into mlb_games.closing_lines, and
// a bet's CLV is resolved against closing_lines[<the book you recorded>]. No book on
// the bet -> no CLV (by design: it won't populate until you record where you bet).
const _fmtAm = (p) => (p == null ? null : (p > 0 ? `+${p}` : `${p}`));

// Map the book dropdown's friendly name to an Odds-API key. Title-matching (below)
// catches most; this handles the few where the name and the feed title differ.
const BOOK_ALIASES = {
  dk:'draftkings', fd:'fanduel', mgm:'betmgm', czr:'caesars', wh:'williamhill_us',
  williamhill:'williamhill_us', caesars:'williamhill_us', br:'betrivers',
  pb:'pointsbetus', pointsbet:'pointsbetus', espn:'espnbet', hardrock:'hardrockbet',
};
function normalizeBook(s){ return (s||'').toLowerCase().replace(/[^a-z0-9]/g,''); }
function resolveBookKey(userBook, closingLines){
  if(!userBook || !closingLines) return null;
  const n = normalizeBook(userBook), alias = BOOK_ALIASES[n] || n;
  for (const k of Object.keys(closingLines)){
    const nk = normalizeBook(k), nt = normalizeBook(closingLines[k]?.title);
    if (nk === n || nk === alias || nt === n || nt === alias) return k;
  }
  return null;
}

// MLB run-line favorite invariant on one per-book record (favorite must hold -1.5).
function rlInvariant(rec){
  const aProb = americanToProb(rec.away_ml), hProb = americanToProb(rec.home_ml);
  const aRLpt = parseFloat(rec.away_rl), hRLpt = parseFloat(rec.home_rl);
  if (aProb != null && hProb != null && aProb !== hProb && !isNaN(aRLpt) && !isNaN(hRLpt) && (aRLpt < 0) !== (hRLpt < 0)) {
    if ((aProb > hProb) !== (aRLpt < 0)) {
      [rec.away_rl, rec.home_rl] = [rec.home_rl, rec.away_rl];
      [rec.away_rl_odds, rec.home_rl_odds] = [rec.home_rl_odds, rec.away_rl_odds];
    }
  }
}

// Build the per-book pre-game snapshot for one game (+ optional raw F5 game object).
// In-play books (last_update after first pitch) are skipped — same guard as the line feed.
function buildClosingLines(game, f5game, commence){
  const out = {};
  const commenceT = commence ? new Date(commence) : null;
  const inPlay = (bm) => { const lu = bm.last_update ? new Date(bm.last_update) : null; return commenceT && lu && lu.getTime() > commenceT.getTime(); };
  const rec = (bm) => out[bm.key] || (out[bm.key] = { title: bm.title || bm.key, last_update: bm.last_update || null });
  for (const bm of (game.bookmakers||[])) {
    if (inPlay(bm)) continue;
    const r = rec(bm);
    for (const mkt of (bm.markets||[])) {
      if (mkt.key==='h2h') for (const o of mkt.outcomes){ if(o.name===game.away_team) r.away_ml=_fmtAm(o.price); if(o.name===game.home_team) r.home_ml=_fmtAm(o.price); }
      else if (mkt.key==='totals'){ const ov=mkt.outcomes.find(o=>o.name==='Over'), un=mkt.outcomes.find(o=>o.name==='Under'); if(ov && parseFloat(ov.point)>=6.5 && parseFloat(ov.point)<=13.5){ r.total=String(ov.point); r.over_odds=_fmtAm(ov.price); r.under_odds=un?_fmtAm(un.price):null; } }
      else if (mkt.key==='spreads') for (const o of mkt.outcomes){ if(o.name===game.away_team){ r.away_rl=_fmtAm(o.point); r.away_rl_odds=_fmtAm(o.price);} if(o.name===game.home_team){ r.home_rl=_fmtAm(o.point); r.home_rl_odds=_fmtAm(o.price);} }
    }
  }
  if (f5game) for (const bm of (f5game.bookmakers||[])) {
    if (inPlay(bm)) continue;
    const r = rec(bm);
    for (const mkt of (bm.markets||[])) {
      if (mkt.key==='h2h_h1') for (const o of mkt.outcomes){ if(o.name===f5game.away_team) r.f5_away_ml=_fmtAm(o.price); if(o.name===f5game.home_team) r.f5_home_ml=_fmtAm(o.price); }
      else if (mkt.key==='totals_h1'){ const ov=mkt.outcomes.find(o=>o.name==='Over'), un=mkt.outcomes.find(o=>o.name==='Under'); if(ov){ r.f5_total=String(ov.point); r.f5_over_odds=_fmtAm(ov.price); r.f5_under_odds=un?_fmtAm(un.price):null; } }
    }
  }
  for (const k in out) rlInvariant(out[k]);
  return out;
}

// Raw F5 fetch (keeps per-book detail, unlike fetchF5Lines which collapses to one book).
async function fetchF5Raw(){
  try{
    const url = `https://api.the-odds-api.com/v4/sports/baseball_mlb/odds/?apiKey=${ODDS_API_KEY}&regions=us&markets=h2h_h1,totals_h1&oddsFormat=american&dateFormat=iso`;
    const res = await fetch(url); if(!res.ok) return {};
    const data = await res.json(); const map = {}; for (const g of data) map[g.id] = g; return map;
  }catch(e){ return {}; }
}

// Book-gated CLV pass. For every bet with a recorded book, resolve the closing price from that
// game's per-book snapshot on the bet's exact side. CLV is deliberately NOT write-once: while a
// game is still PRE-PITCH we re-resolve it every run so the value tracks the latest snapshot and
// the final pre-pitch pass (against the true close) wins. Once the game has STARTED the value is
// frozen — the last pre-pitch number stands. This stops an early in-window snapshot (captured up to
// REFRESH_WINDOW_MIN out, still near your entry) from locking a premature ~0% CLV that never
// advances to the real close.
async function computeClvFromBooks(){
  try{
    // Candidates: any book-tagged bet still missing CLV (any date) PLUS every book-tagged bet from
    // the last 2 days (so pre-pitch bets that already hold a provisional CLV get re-resolved toward
    // close). Older, already-started bets keep their finalized value and are skipped in the loop.
    const recentCutoff = new Date(Date.now() - 2*86400000).toLocaleDateString('en-CA',{timeZone:'America/New_York'});
    const res = await fetch(`${SUPABASE_URL}/rest/v1/mlb_bets?book=not.is.null&or=(clv.is.null,game_date.gte.${recentCutoff})&order=game_date.desc&limit=400`, {
      headers: { 'apikey': SUPABASE_SERVICE_KEY, 'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}` }
    });
    if(!res.ok){ console.error(`  CLV pass query failed: ${res.status}`); return; }
    const bets = await res.json();
    if(!bets.length){ console.log('  CLV pass: nothing to resolve.'); return; }
    console.log(`\nResolving book-matched CLV for ${bets.length} candidate bets...`);
    const cache = new Map(); let filled=0, refreshed=0, frozen=0, unchanged=0, noSnap=0, noBook=0, noOdds=0;
    for (const bet of bets){
      try{
        if(!bet.book || !String(bet.book).trim()){ noBook++; continue; }
        const aw=(bet.matchup||'').split(' @ ')[0]||'', hm=(bet.matchup||'').split(' @ ')[1]||'';
        if(!cache.has(bet.game_date)){
          const gRes = await fetch(`${SUPABASE_URL}/rest/v1/mlb_games?game_date=eq.${bet.game_date}&select=away_team,home_team,closing_lines,commence_time`, { headers:{ 'apikey':SUPABASE_SERVICE_KEY, 'Authorization':`Bearer ${SUPABASE_SERVICE_KEY}` }});
          cache.set(bet.game_date, gRes.ok ? await gRes.json() : []);
        }
        const rows = cache.get(bet.game_date)||[];
        const g = rows.find(r=>{ const at=r.away_team||'',ht=r.home_team||''; return (at.includes(aw.split(' ').pop())||aw.includes(at.split(' ').pop())) && (ht.includes(hm.split(' ').pop())||hm.includes(ht.split(' ').pop())); });
        if(!g || !g.closing_lines){ noSnap++; continue; }                 // close not snapshotted yet -> leave null
        // Freeze rule: re-resolve only while pre-pitch. Once the game has started the last pre-pitch
        // value is final — only (re)fill a started game if it never got a CLV at all.
        const notStarted = g.commence_time ? (Date.now() < new Date(g.commence_time).getTime()) : false;
        const isFirstFill = (bet.clv == null);
        if(!isFirstFill && !notStarted){ frozen++; continue; }            // already finalized -> leave it
        const key = resolveBookKey(bet.book, g.closing_lines);
        if(!key){ noBook++; continue; }                                   // book not in snapshot (e.g. a prediction market) -> honest null
        const c = closingForBet(bet.bet_type, g.closing_lines[key]);
        const pc = americanToProb(c.odds), pb = americanToProb(bet.odds);
        if(pc==null || pb==null){ noOdds++; continue; }
        // No-op guard: if the resolved close is unchanged from what's stored, skip the write + sleep.
        if(!isFirstFill && String(bet.closing_odds??'') === String(c.odds??'')){ unchanged++; continue; }
        const clv = +(((pc-pb)*100).toFixed(1));
        const r = await fetch(`${SUPABASE_URL}/rest/v1/mlb_bets?id=eq.${bet.id}`, {
          method:'PATCH', headers:{ 'Content-Type':'application/json','apikey':SUPABASE_SERVICE_KEY,'Authorization':`Bearer ${SUPABASE_SERVICE_KEY}`,'Prefer':'return=minimal' },
          body: JSON.stringify({ closing_odds: c.odds||null, closing_line:(c.line!=null&&c.line!=='')?String(c.line):null, clv })
        });
        if(r.ok){
          if(isFirstFill) filled++; else refreshed++;
          const tag = !notStarted ? 'finalized' : (isFirstFill ? 'set' : '↻ updated');
          console.log(`  ✓ CLV ${clv>=0?'+':''}${clv}% ${tag} — ${bet.matchup} @ ${g.closing_lines[key].title||key} (closed ${c.odds||'?'})`);
        }
        await new Promise(rr=>setTimeout(rr,150));
      }catch(e){ /* skip this bet */ }
    }
    console.log(`  CLV pass done — ${filled} set, ${refreshed} refreshed, ${unchanged} unchanged, ${frozen} frozen(started); no snapshot ${noSnap}, book missing ${noBook}, no odds ${noOdds}`);
  }catch(e){ console.error('CLV pass error:', e.message); }
}

// Match a schedule game to these team names. On a doubleheader / resumed-suspension day more than
// one schedule game carries the same teams; instead of taking the first hit (which graded 7:15
// games off the 2pm resumed final), pick the one whose start time is closest to targetTimeMs (the
// analyzed game's commence_time). Falls back to the sole/first match when there's no ambiguity.
function pickScheduleGame(games, awayName, homeName, targetTimeMs) {
  const matches = (games || []).filter(g => {
    const at = g.teams?.away?.team?.name || '', ht = g.teams?.home?.team?.name || '';
    return (at.includes(String(awayName).split(' ').pop()) || String(awayName).includes(at.split(' ').pop())) &&
           (ht.includes(String(homeName).split(' ').pop()) || String(homeName).includes(ht.split(' ').pop()));
  });
  if (matches.length <= 1) return matches[0] || null;
  if (targetTimeMs == null) return matches[0];
  return matches.reduce((best, g) =>
    Math.abs(new Date(g.gameDate).getTime() - targetTimeMs) < Math.abs(new Date(best.gameDate).getTime() - targetTimeMs) ? g : best
  );
}

async function settlePendingBets() {
  console.log('\nChecking pending bets for settlement...');
  try {
    // Get all pending bets from Supabase
    const res = await fetch(`${SUPABASE_URL}/rest/v1/mlb_bets?result=eq.pending&order=game_date.desc`, {
      headers: {
        'apikey': SUPABASE_SERVICE_KEY,
        'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`
      }
    });
    if (!res.ok) return;
    const bets = await res.json();
    if (!bets.length) { console.log('  No pending bets to settle'); return; }
    console.log(`  Found ${bets.length} pending bets`);

    const gameTimeCache = new Map(); // game_date -> [{away_team,home_team,commence_time}] for doubleheader disambiguation
    for (const bet of bets) {
      try {
        // Get final score from MLB Stats API
        const schedRes = await fetch(
          `https://statsapi.mlb.com/api/v1/schedule?sportId=1&date=${bet.game_date}&gameType=R&hydrate=linescore`
        );
        if (!schedRes.ok) continue;
        const schedData = await schedRes.json();
        const games = schedData.dates?.[0]?.games || [];

        // Find matching game
        const matchup = bet.matchup || '';
        const awayName = matchup.split(' @ ')[0];
        const homeName = matchup.split(' @ ')[1];

        // On a doubleheader day this matchup matches two schedule games; disambiguate by the
        // analyzed game's start time (read once per date from mlb_games), then pick the closest.
        if (!gameTimeCache.has(bet.game_date)) {
          const gr = await fetch(`${SUPABASE_URL}/rest/v1/mlb_games?game_date=eq.${bet.game_date}&select=away_team,home_team,commence_time`, { headers:{ 'apikey':SUPABASE_SERVICE_KEY, 'Authorization':`Bearer ${SUPABASE_SERVICE_KEY}` }});
          gameTimeCache.set(bet.game_date, gr.ok ? await gr.json() : []);
        }
        const grow = (gameTimeCache.get(bet.game_date)||[]).find(r => {
          const at=r.away_team||'', ht=r.home_team||'';
          return (at.includes(awayName.split(' ').pop()) || awayName.includes(at.split(' ').pop())) &&
                 (ht.includes(homeName?.split(' ').pop()) || homeName?.includes(ht.split(' ').pop()));
        });
        const targetMs = grow?.commence_time ? new Date(grow.commence_time).getTime() : null;
        const game = pickScheduleGame(games, awayName, homeName, targetMs);

        if (!game) continue;
        if (game.status?.abstractGameState !== 'Final') continue;

        const awayScore = game.teams?.away?.score;
        const homeScore = game.teams?.home?.score;
        if (awayScore === undefined || homeScore === undefined) continue;

        const totalScore = awayScore + homeScore;
        const type = (bet.bet_type || '').toLowerCase();
        const betLine = parseFloat(bet.bet_line) || 0;
        const odds = parseFloat(bet.odds) || 0;

        let result = 'pending';

        // Determine result based on bet type
        if (type.includes('total over') || type.includes('over')) {
          if (totalScore > betLine) result = 'win';
          else if (totalScore < betLine) result = 'loss';
          else result = 'push';
        } else if (type.includes('total under') || type.includes('under')) {
          if (totalScore < betLine) result = 'win';
          else if (totalScore > betLine) result = 'loss';
          else result = 'push';
        } else if (type.includes('moneyline (away)') || type.includes('f5 moneyline (away)')) {
          if (awayScore > homeScore) result = 'win';
          else if (awayScore < homeScore) result = 'loss';
          else result = 'push';
        } else if (type.includes('moneyline (home)') || type.includes('f5 moneyline (home)')) {
          if (homeScore > awayScore) result = 'win';
          else if (homeScore < awayScore) result = 'loss';
          else result = 'push';
        } else if (type.includes('rl -1.5') || type.includes('run line (away')) {
          const sp = parseFloat(bet.bet_line); const d = (awayScore - homeScore) + (isNaN(sp) ? -1.5 : sp);
          result = d > 0 ? 'win' : d < 0 ? 'loss' : 'push';
        } else if (type.includes('rl +1.5') || type.includes('run line (home')) {
          const sp = parseFloat(bet.bet_line); const d = (homeScore - awayScore) + (isNaN(sp) ? 1.5 : sp);
          result = d > 0 ? 'win' : d < 0 ? 'loss' : 'push';
        }

        if (result === 'pending') continue;

        // Settle the result/score only. CLV is computed separately and book-gated by
        // computeClvFromBooks() (it needs the book you bet at + the per-book close), so we
        // deliberately do NOT touch closing_odds/closing_line/clv here.
        const updateRes = await fetch(`${SUPABASE_URL}/rest/v1/mlb_bets?id=eq.${bet.id}`, {
          method: 'PATCH',
          headers: {
            'Content-Type': 'application/json',
            'apikey': SUPABASE_SERVICE_KEY,
            'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
            'Prefer': 'return=minimal'
          },
          body: JSON.stringify({
            result,
            away_score: awayScore,
            home_score: homeScore,
            settled_at: new Date().toISOString()
          })
        });

        if (updateRes.ok) {
          console.log(`  ✓ Settled: ${bet.matchup} — ${result.toUpperCase()} (${awayScore}-${homeScore})`);
        }

        await new Promise(r => setTimeout(r, 500));
      } catch(e) {
        console.error(`  Error settling ${bet.matchup}:`, e.message);
      }
    }
  } catch(e) {
    console.error('Settlement error:', e.message);
  }
}

// ── GAME-LEVEL FINAL SCORES (for the magnitude / projection-accuracy test) ───
// Independent of betting. Writes away_final/home_final/actual_total onto EVERY mlb_games row
// that has finished but isn't scored yet — including weather-neutral games and whole slates we
// never bet (e.g. a scrapped day). That makes every analyzed game a data point for comparing
// proj_total (and sim_away_runs+sim_home_runs) against what actually happened. One schedule
// call per distinct unscored date keeps API use tiny. Idempotent: actual_total stays null until
// a game is Final and scored once, so re-runs are cheap no-ops. On first run after deploy it
// backfills the existing history in one pass.
async function settleGameScores() {
  console.log('\nCapturing final scores into mlb_games...');
  try {
    const todayET = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' }); // YYYY-MM-DD
    // Only games that have already happened (don't try to score the future) and aren't scored yet.
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/mlb_games?actual_total=is.null&game_date=lte.${todayET}&select=id,game_date,away_team,home_team,commence_time&order=game_date.desc`,
      { headers: { 'apikey': SUPABASE_SERVICE_KEY, 'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}` } }
    );
    if (!res.ok) { console.log('  (could not read unscored games — is the actual_total column added?)'); return; }
    const rows = await res.json();
    if (!rows.length) { console.log('  No unscored finished games.'); return; }

    // Group by date so we hit the schedule API once per day, not once per game.
    const byDate = {};
    for (const r of rows) (byDate[r.game_date] ||= []).push(r);

    let scored = 0;
    for (const date of Object.keys(byDate)) {
      let games = [];
      try {
        const sres = await fetch(`https://statsapi.mlb.com/api/v1/schedule?sportId=1&date=${date}&gameType=R&hydrate=linescore`);
        if (!sres.ok) continue;
        const sdata = await sres.json();
        games = sdata.dates?.[0]?.games || [];
      } catch { continue; }

      for (const row of byDate[date]) {
        // Same fuzzy last-word team match the bet settler uses, sourced from the game row.
        const awayName = row.away_team || '';
        const homeName = row.home_team || '';
        // Doubleheader-safe: pick the schedule game closest to this row's analyzed start time
        // instead of the first team-name match (which graded 7:15 rows off the 2pm resumed final).
        const targetMs = row.commence_time ? new Date(row.commence_time).getTime() : null;
        const game = pickScheduleGame(games, awayName, homeName, targetMs);
        if (!game || game.status?.abstractGameState !== 'Final') continue;  // skip not-yet-final; scored on a later tick
        const a = game.teams?.away?.score, h = game.teams?.home?.score;
        if (a === undefined || h === undefined) continue;

        const up = await fetch(`${SUPABASE_URL}/rest/v1/mlb_games?id=eq.${row.id}`, {
          method: 'PATCH',
          headers: {
            'Content-Type': 'application/json',
            'apikey': SUPABASE_SERVICE_KEY,
            'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
            'Prefer': 'return=minimal'
          },
          body: JSON.stringify({ away_final: a, home_final: h, actual_total: a + h })
        });
        if (up.ok) { scored++; console.log(`  ✓ Scored: ${awayName} @ ${homeName} (${date}) — ${a}-${h}, total ${a + h}`); }
        await new Promise(r => setTimeout(r, 250));
      }
    }
    console.log(`  Final-score capture done — ${scored} game(s) scored.`);
  } catch (e) {
    console.error('  Game-score capture error:', e.message);
  }
}

// ── CLOSING-LINE REFRESH (lightweight) ───────────────────────────────────────
// Runs ~5 min before each block of games (RUN_TYPE=closing). Only re-pulls odds and
// PATCHes the odds columns on existing game rows — no Claude calls, no re-analysis, so
// the day's verdicts are untouched. Games already underway are skipped, so each game's
// row keeps the last line seen before its first pitch ≈ the true close.
// Capture ONE game's per-book closing snapshot (and refresh its line columns). Shared by the
// standalone closing run and the unified heartbeat. Returns 'updated' | 'inplay' | 'started' | 'error'.
async function snapshotGameClose(g, f5Map, f5Raw, today, now) {
  const minutesSinceStart = (now - new Date(g.commence_time)) / 60000;
  if (minutesSinceStart > 5) return 'started'; // already underway — its last refresh holds the close
  const lines = parseOddsData(g, { commenceTime: g.commence_time, now });
  const awayML = parseFloat(lines.awayML), homeML = parseFloat(lines.homeML);
  if (!isNaN(awayML) && !isNaN(homeML) && (Math.abs(awayML) > 600 || Math.abs(homeML) > 600)) return 'inplay'; // backstop
  // If every book's only price was in-play (all skipped) we have no real close — don't overwrite
  // the good earlier line with garbage. Keep whatever the last clean pull stored.
  if (!lines.awayML) { console.log(`  ⊘ ${g.away_team} @ ${g.home_team} — no pre-game line (all books in-play), keeping prior close`); return 'inplay'; }
  const f5 = f5Map[g.id] || null;
  const closing_lines = buildClosingLines(g, f5Raw[g.id] || null, g.commence_time); // per-book CLV basis
  const payload = {
    away_ml: lines.awayML, home_ml: lines.homeML, total: lines.total,
    over_odds: lines.overOdds, under_odds: lines.underOdds,
    away_rl: lines.awayRL, home_rl: lines.homeRL,
    away_rl_odds: lines.awayRLOdds, home_rl_odds: lines.homeRLOdds,
    f5_away_ml: f5?.f5AwayML || null, f5_home_ml: f5?.f5HomeML || null,
    f5_total: f5?.f5Total || null, f5_over_odds: f5?.f5OverOdds || null, f5_under_odds: f5?.f5UnderOdds || null,
    closing_lines
  };
  // Target the exact row by Odds-API event id (the row PK) so a doubleheader's two games don't
  // overwrite each other's close. Fall back to team+date only if this game somehow has no id.
  const url = g.id
    ? `${SUPABASE_URL}/rest/v1/mlb_games?id=eq.${encodeURIComponent(g.id)}`
    : `${SUPABASE_URL}/rest/v1/mlb_games?game_date=eq.${today}&away_team=eq.${encodeURIComponent(g.away_team)}&home_team=eq.${encodeURIComponent(g.home_team)}`;
  // GUARD: always prefer the most recent pre-game snapshot.
  // The last analyze run before first pitch has the truest closing line.
  // Only keep prior if current pull has zero books (empty/failed fetch).
  const newCount = closing_lines ? Object.keys(closing_lines).length : 0;
  if (newCount === 0) {
    console.log(`  ⊘ ${g.away_team} @ ${g.home_team} — empty closing snapshot, keeping prior`);
    delete payload.closing_lines;
  }
  if (newCount === 0) delete payload.closing_lines; // never write an empty snapshot over anything
  try {
    const res = await fetch(url, { method:'PATCH', headers:{ 'Content-Type':'application/json','apikey':SUPABASE_SERVICE_KEY,'Authorization':`Bearer ${SUPABASE_SERVICE_KEY}`,'Prefer':'return=minimal' }, body: JSON.stringify(payload) });
    if (res.ok) { console.log(`  ✓ Close refreshed: ${g.away_team} @ ${g.home_team} | ML ${lines.awayML}/${lines.homeML} | ${lines.total} | ${lines.bookUsed||'?'} (${lines.lineAgeMin!=null?lines.lineAgeMin+'m old':'age?'})${lines.stale?' ⚠STALE':''} | ${Object.keys(closing_lines).length} books snapshotted`); return 'updated'; }
    console.error(`  ✗ ${g.away_team} @ ${g.home_team}: ${await res.text()}`); return 'error';
  } catch(e) { console.error(`  ✗ ${g.away_team} @ ${g.home_team}:`, e.message); return 'error'; }
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
    // Only snapshot closing lines within 30 minutes of first pitch
    // Earlier runs would write stale analysis-time odds as the "close" which is wrong
    if (minsToStart > 30) {
      console.log(`  ⏭  ${g.away_team} @ ${g.home_team} — ${Math.round(minsToStart)}m to first pitch, skipping close snapshot`);
      continue;
    }
    const st = await snapshotGameClose(g, f5Map, f5Raw, today, now);
    if (st === 'updated') updated++;
    await new Promise(r => setTimeout(r, 300));
  }
  console.log(`\n✅ Closing refresh done — ${updated} games updated`);
  await settlePendingBets();    // settles finals (result + score only)
  await settleGameScores();     // capture game-level finals into mlb_games (magnitude test)
  await computeClvFromBooks();  // book-gated CLV: fills closing line + CLV for any book-tagged bet
}

// FREE readiness pre-check (MLB Stats only — no Odds API credits). Returns { ready, refresh }:
//   ready   = games to ANALYZE now (both probables posted + both lineups official, not yet done)
//   refresh = already-analyzed games inside the closing window before first pitch (need a snapshot)
// One schedule call hydrates probables + lineups together. Lets a tick decide whether to spend any
// Odds API credits at all. {-1,-1} means the schedule couldn't be read -> caller proceeds anyway.
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
      if (minsToStart < -5) { started++; continue; }                     // underway/finished
      if (doneSet.has(`gp:${g.gamePk}`) || doneSet.has(`nm:${away}@${home}`)) {  // already analyzed (gamePk; name = legacy)
        if (minsToStart <= REFRESH_WINDOW_MIN) refresh++;                // needs a close snapshot now
        continue;
      }
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

  // Pre-load Statcast cache from Supabase before game analysis begins
  await loadStatcastCache();
  // Expose globally for sim-data.js access
  global._statcastCache = _statcastCache;

  // Use ET timezone for date
  const etDate = new Date().toLocaleDateString('en-US', {timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit'});
  const [etMonth, etDay, etYear] = etDate.split('/');
  const today = etYear + '-' + etMonth + '-' + etDay;

  // Idempotency set first (free Supabase read): which games are already analyzed on confirmed
  // pitchers + lineups. Used by both the readiness pre-check and the per-game skip in the loop.
  const doneSet = new Set();
  try {
    const dRes = await fetch(`${SUPABASE_URL}/rest/v1/mlb_games?game_date=eq.${today}&select=id,game_pk,away_team,home_team,pitcher_status,lineup_status`, { headers:{ 'apikey':SUPABASE_SERVICE_KEY, 'Authorization':`Bearer ${SUPABASE_SERVICE_KEY}` }});
    if (dRes.ok) for (const r of await dRes.json()) {
      if (r.pitcher_status === 'confirmed' && r.lineup_status === 'confirmed') {
        if (r.id) doneSet.add(String(r.id));               // Odds-API event id = the row PK — per-game, doubleheader-safe (used by the main loop)
        if (r.game_pk) doneSet.add(`gp:${r.game_pk}`);      // MLB gamePk — used by the schedule-side readiness pre-check
        doneSet.add(`nm:${r.away_team}@${r.home_team}`);    // team-name fallback for legacy rows that predate game_pk
      }
    }
    if (doneSet.size) console.log(`Already analyzed on confirmed lineups: ${doneSet.size} — will skip those.`);
  } catch(e) { /* if this read fails, worst case we re-analyze a game; not fatal */ }

  // OPTIMIZATION — spend Odds API credits only when there's work this tick. The free MLB Stats
  // pass returns how many games need ANALYSIS (ready) and how many need a CLOSE snapshot (refresh,
  // i.e. already analyzed and inside the window before first pitch). If both are zero, this tick
  // pulls no odds — it just settles/CLVs and exits. So on a day with a lone 1pm game and the rest
  // at 7pm, once the 1pm is analyzed AND its close captured, the afternoon ticks cost ~nothing
  // until the evening lineups post. ({-1,-1} means the schedule couldn't be read -> proceed.)
  const { ready, refresh } = await countReadyGames(today, doneSet);
  if (ready === 0 && refresh === 0) {
    console.log('Nothing to analyze and no closes to snapshot — skipping the Odds API pull this tick.');
    await settlePendingBets();
    await settleGameScores();
    await computeClvFromBooks();
    console.log('✅ Tick done — nothing to do.');
    return;
  }

  const [games, f5Map, f5Raw, probables] = await Promise.all([fetchOddsAPI(), fetchF5Lines(), fetchF5Raw(), fetchProbablePitchers(today)]);
  const pitcherMap = probables.pitcherMap;
  const venueMap = probables.venueMap;
  const scheduleGames = probables.scheduleGames || [];
  const now = new Date();
  const todayGames = games.filter(g => {
    // Compare each game's date in ET (matches how game_date is stored on upsert).
    // The Odds API commence_time is UTC, so a naive startsWith(today) drops every
    // game after ~8pm ET, whose UTC timestamp has already rolled to tomorrow.
    const gameEtDate = new Date(g.commence_time).toLocaleDateString('en-CA', {timeZone: 'America/New_York'});
    if (gameEtDate !== today) return false;
    const gameTime = new Date(g.commence_time);
    const minutesSinceStart = (now - gameTime) / 60000;
    // Skip games that started more than 5 minutes ago
    if (minutesSinceStart > 5) {
      console.log(`  Skipping ${g.away_team} @ ${g.home_team} — game already started`);
      return false;
    }
    // Skip games with extreme live lines (indicates in-game pricing)
    const lines = parseOddsData(g, { commenceTime: g.commence_time, now });
    const awayML = parseFloat(lines.awayML);
    const homeML = parseFloat(lines.homeML);
    if (!isNaN(awayML) && !isNaN(homeML)) {
      if (Math.abs(awayML) > 600 || Math.abs(homeML) > 600) {
        console.log(`  Skipping ${g.away_team} @ ${g.home_team} — extreme live odds detected`);
        return false;
      }
    }
    return true;
  });
  console.log(`Today: ${todayGames.length} games\n`);

  for (const game of todayGames) {
    try {
      // Already analyzed -> CLOSE-REFRESH branch. Snapshot its per-book close once inside the
      // window before first pitch (each tick re-captures; the last pre-pitch one is the close).
      // Outside the window it's a free no-op — no odds work for that game.
      if (doneSet.has(String(game.id))) {
        const minsToStart = (new Date(game.commence_time) - now) / 60000;
        if (minsToStart > REFRESH_WINDOW_MIN) {
          console.log(`  ⏭  ${game.away_team} @ ${game.home_team} — analyzed; close-refresh window not open yet (${Math.round(minsToStart)}m to first pitch)`);
        } else {
          await snapshotGameClose(game, f5Map, f5Raw, today, now);
          await new Promise(r => setTimeout(r, 300));
        }
        continue;
      }
      const lines = parseOddsData(game, { commenceTime: game.commence_time });
      if (lines.stale) console.log(`  ⚠ ${game.away_team} @ ${game.home_team} — line is ${lines.lineAgeMin}m old (${lines.bookUsed||'?'}), may be stale`);

      // Get team IDs for pitcher lookup
      const [awayTeamId, homeTeamId] = await Promise.all([
        getTeamId(game.away_team),
        getTeamId(game.home_team)
      ]);

      // Resolve the exact schedule game for THIS Odds-API event (doubleheader-safe): match team ids,
      // then — if more than one game (a doubleheader) — the closest start time. Falls back to the
      // legacy team-id pitcher map when there's no schedule hit.
      let sg = null;
      const sgMatches = scheduleGames.filter(s => s.awayId === awayTeamId && s.homeId === homeTeamId);
      if (sgMatches.length === 1) sg = sgMatches[0];
      else if (sgMatches.length > 1) {
        const t = new Date(game.commence_time).getTime();
        sg = sgMatches.reduce((b, s) => Math.abs(new Date(s.gameDate).getTime() - t) < Math.abs(new Date(b.gameDate).getTime() - t) ? s : b);
      }
      const awayPitcherInfo = sg?.awayPitcher || (awayTeamId ? pitcherMap[`away_${awayTeamId}`] : null);
      const homePitcherInfo = sg?.homePitcher || (homeTeamId ? pitcherMap[`home_${homeTeamId}`] : null);
      const resolvedGamePk = sg?.gamePk || awayPitcherInfo?.gamePk || homePitcherInfo?.gamePk || null;

      // Actual venue for THIS game (handles neutral sites like the A's Las Vegas series).
      const venueName = sg?.venue || (homeTeamId && venueMap[`home_${homeTeamId}`]) || homePitcherInfo?.venue || awayPitcherInfo?.venue || null;

      // Confirm both probables come from the SAME real MLB game between these two teams.
      // If a probable's recorded opponent/gamePk doesn't line up, the team mapping is off.
      let pitcherStatus = 'tbd';
      if (awayPitcherInfo && homePitcherInfo) {
        const sameGame = awayPitcherInfo.gamePk && awayPitcherInfo.gamePk === homePitcherInfo.gamePk;
        const opponentsMatch = awayPitcherInfo.vs === homeTeamId && homePitcherInfo.vs === awayTeamId;
        if (sameGame && opponentsMatch) {
          pitcherStatus = 'confirmed';
        } else {
          pitcherStatus = 'mismatch';
          console.log(`  ⚠ PITCHER MATCHUP UNVERIFIED for ${game.away_team} @ ${game.home_team}: ${awayPitcherInfo.name} (gamePk ${awayPitcherInfo.gamePk}, vs ${awayPitcherInfo.vs}) / ${homePitcherInfo.name} (gamePk ${homePitcherInfo.gamePk}, vs ${homePitcherInfo.vs}); resolved team ids away=${awayTeamId} home=${homeTeamId}`);
        }
      } else if (awayPitcherInfo || homePitcherInfo) {
        pitcherStatus = 'partial';
      }
      if (pitcherStatus === 'confirmed') console.log(`  ✓ Pitchers confirmed: ${awayPitcherInfo.name} @ ${homePitcherInfo.name} (gamePk ${awayPitcherInfo.gamePk})`);

      // GATE 1 — probable pitchers must be confirmed (both, same real game) before we analyze.
      // 'tbd' / 'partial' / 'mismatch' all mean "not ready" — skip and let a later tick retry.
      if (pitcherStatus !== 'confirmed') {
        console.log(`  ⏳ ${game.away_team} @ ${game.home_team} — probable pitchers not confirmed yet (${pitcherStatus}); will analyze once set`);
        continue;
      }

      // Check for MLB debut
      const [awayDebut, homeDebut] = await Promise.all([
        awayPitcherInfo ? checkMLBDebut(awayPitcherInfo.id) : Promise.resolve(false),
        homePitcherInfo ? checkMLBDebut(homePitcherInfo.id) : Promise.resolve(false)
      ]);

      if (awayPitcherInfo) awayPitcherInfo.debut = awayDebut;
      if (homePitcherInfo) homePitcherInfo.debut = homeDebut;
      if (awayDebut) console.log(`  🚨 MLB DEBUT: ${awayPitcherInfo.name} (${game.away_team})`);
      if (homeDebut) console.log(`  🚨 MLB DEBUT: ${homePitcherInfo.name} (${game.home_team})`);

      // Fetch Statcast metrics and lineup matchups in parallel
      const [awayStatcast, homeStatcast, awayMatchups, homeMatchups] = await Promise.all([
        awayPitcherInfo?.id ? fetchStatcast(awayPitcherInfo.name, awayPitcherInfo.id) : Promise.resolve(null),
        homePitcherInfo?.id ? fetchStatcast(homePitcherInfo.name, homePitcherInfo.id) : Promise.resolve(null),
        homePitcherInfo?.id && awayTeamId ? fetchLineupMatchups(awayTeamId, homePitcherInfo.id, today) : Promise.resolve(null),
        awayPitcherInfo?.id && homeTeamId ? fetchLineupMatchups(homeTeamId, awayPitcherInfo.id, today) : Promise.resolve(null)
      ]);

      if (awayStatcast) console.log(`  Statcast ${awayPitcherInfo.name}: velo ${awayStatcast.avgVelo} (${awayStatcast.veloTrend}), whiff ${awayStatcast.whiffRate}%, barrel ${awayStatcast.barrelRate}%`);

      // GATE 2 — both starting lineups must be officially posted before we analyze. fetchLineupMatchups
      // returns null until MLB posts the lineup, so a null/short matchup means "not out yet." This is
      // the gate you described: confirm pitchers + lineups first, THEN run the analysis on the game.
      const lineupsReady = (awayMatchups?.lineup?.length >= 9) && (homeMatchups?.lineup?.length >= 9);
      if (!lineupsReady) {
        console.log(`  ⏳ ${game.away_team} @ ${game.home_team} — starting lineups not posted yet; will analyze once confirmed`);
        continue;
      }
      if (homeStatcast) console.log(`  Statcast ${homePitcherInfo.name}: velo ${homeStatcast.avgVelo} (${homeStatcast.veloTrend}), whiff ${homeStatcast.whiffRate}%, barrel ${homeStatcast.barrelRate}%`);
      if (awayMatchups?.avgOPS != null) console.log(`  Away lineup vs ${homePitcherInfo?.name}: OPS ${awayMatchups.avgOPS}, K% ${awayMatchups.kRate}`);
      else if (awayMatchups) console.log(`  Away lineup vs ${homePitcherInfo?.name}: no batter-vs-pitcher sample (using season stats) — ${awayMatchups.meaningful || 0} batters with 10+ AB found`);
      if (homeMatchups?.avgOPS != null) console.log(`  Home lineup vs ${awayPitcherInfo?.name}: OPS ${homeMatchups.avgOPS}, K% ${homeMatchups.kRate}`);
      else if (homeMatchups) console.log(`  Home lineup vs ${awayPitcherInfo?.name}: no batter-vs-pitcher sample (using season stats) — ${homeMatchups.meaningful || 0} batters with 10+ AB found`);

      const venueId = sg?.venueId || null;

      // Real starter stats with home/away/venue splits
      const [awayDetail, homeDetail, awayBullpen, homeBullpen, awayArsenal, homeArsenal] = await Promise.all([
        awayPitcherInfo?.id ? fetchPitcherDetail(awayPitcherInfo.id, venueId) : Promise.resolve(null),
        homePitcherInfo?.id ? fetchPitcherDetail(homePitcherInfo.id, venueId) : Promise.resolve(null),
        awayTeamId ? fetchBullpen(awayTeamId) : Promise.resolve(null),
        homeTeamId ? fetchBullpen(homeTeamId) : Promise.resolve(null),
        awayPitcherInfo?.id ? fetchPitchArsenal(awayPitcherInfo.id) : Promise.resolve(null),
        homePitcherInfo?.id ? fetchPitchArsenal(homePitcherInfo.id) : Promise.resolve(null)
      ]);
      if (awayPitcherInfo && awayDetail) Object.assign(awayPitcherInfo, awayDetail);
      if (homePitcherInfo && homeDetail) Object.assign(homePitcherInfo, homeDetail);
      if (awayBullpen) console.log(`  ${game.away_team} pen: ${awayBullpen.summary}`);
      if (homeBullpen) console.log(`  ${game.home_team} pen: ${homeBullpen.summary}`);
      if (awayArsenal?.arsenal) console.log(`  ${awayPitcherInfo?.name} arsenal: ${Object.entries(awayArsenal.arsenal).slice(0,3).map(([pt,p])=>`${pt} ${p.pct}% (whiff ${p.whiffRate}%)`).join(', ')}`);
      if (homeArsenal?.arsenal) console.log(`  ${homePitcherInfo?.name} arsenal: ${Object.entries(homeArsenal.arsenal).slice(0,3).map(([pt,p])=>`${pt} ${p.pct}% (whiff ${p.whiffRate}%)`).join(', ')}`);

      // Build batter pitch type stats from Supabase Statcast cache
      const getBatterPitchStats = (lineup) => {
        if (!lineup?.length) return null;
        return lineup.slice(0, 9).map(b => {
          const cached = _statcastCache?.batters?.[String(b.id)];
          if (!cached?.pitchTypeStats) return null;
          return Object.entries(cached.pitchTypeStats).map(([pt, s]) => ({
            type: pt, ...s
          }));
        });
      };

      const awayBatterPitchStats = getBatterPitchStats(awayMatchups?.lineup || awayLineupOrder);
      const homeBatterPitchStats = getBatterPitchStats(homeMatchups?.lineup || homeLineupOrder);

      // Arsenal vs lineup matchup analysis
      const awayVsHomeArsenal = analyzeArsenalMatchup(homeArsenal, awayBatterPitchStats, homePitcherInfo?.throwHand);
      const homeVsAwayArsenal = analyzeArsenalMatchup(awayArsenal, homeBatterPitchStats, awayPitcherInfo?.throwHand);

      const [anData, weather, awayStats, homeStats, umpire, awayLineupOrder, homeLineupOrder] = await Promise.all([
        fetchActionNetwork(game.away_team, game.home_team, game.commence_time),
        fetchWeather(game.home_team, game.commence_time, venueName),
        fetchTeamStats(game.away_team),
        fetchTeamStats(game.home_team),
        resolvedGamePk ? fetchUmpireTendency(resolvedGamePk) : Promise.resolve(null),
        resolvedGamePk && awayTeamId ? fetchLineupOrder(resolvedGamePk, awayTeamId) : Promise.resolve(null),
        resolvedGamePk && homeTeamId ? fetchLineupOrder(resolvedGamePk, homeTeamId) : Promise.resolve(null)
      ]);

      if (anData?.total) lines.total = validateTotal(lines.total, anData.total);

      const f5Lines = f5Map[game.id] || null;
      const analysis = await analyzeGame(game, lines, anData, f5Lines, weather, awayStats, homeStats, awayPitcherInfo, homePitcherInfo, awayStatcast, homeStatcast, awayMatchups, homeMatchups, awayBullpen, homeBullpen, venueName, umpire, awayLineupOrder, homeLineupOrder, awayArsenal, homeArsenal, awayVsHomeArsenal, homeVsAwayArsenal);

      if (!analysis) {
        console.error(`  ✗ ${game.away_team} @ ${game.home_team}: analysis parse failed — keeping previous row, not overwriting`);
        continue;
      }

      // SHADOW MODE: run the Monte Carlo sim next to the LLM projection. It logs and stores
      // its expected runs for side-by-side comparison on the site, but does NOT drive the
      // verdict yet. Fully wrapped so a sim failure can never disrupt the existing analysis.
      try {
        if (awayMatchups?.lineup?.length >= 9 && homeMatchups?.lineup?.length >= 9 &&
            awayPitcherInfo?.id && homePitcherInfo?.id && awayTeamId && homeTeamId) {
          const simProbs = await simulateGame({
            awayLineupIds: awayMatchups.lineup.map(p => p.id),
            homeLineupIds: homeMatchups.lineup.map(p => p.id),
            awayStarterId: awayPitcherInfo.id,
            homeStarterId: homePitcherInfo.id,
            awayTeamId, homeTeamId,
            awayStarterHand: awayPitcherInfo?.throwHand || 'R',
            homeStarterHand: homePitcherInfo?.throwHand || 'R',
            awayStarterStatcast: awayStatcast || null,
            homeStarterStatcast: homeStatcast || null,
            awayStarterInfo: awayPitcherInfo || null,
            homeStarterInfo: homePitcherInfo || null,
            awayLineupHandedness: awayMatchups.handedness || null,
            homeLineupHandedness: homeMatchups.handedness || null,
            // Pitcher detail for home/away splits
            awayPitcherDetail: awayPitcherInfo || null,
            homePitcherDetail: homePitcherInfo || null,
            // Batter Statcast cache — pitch type stats per batter
            awayBatterStatcast: awayMatchups.lineup.slice(0,9).map(b => _statcastCache?.batters?.[String(b.id)] || null),
            homeBatterStatcast: homeMatchups.lineup.slice(0,9).map(b => _statcastCache?.batters?.[String(b.id)] || null),
            // Arsenal data for matchup adjustments
            awayArsenal: awayArsenal || null,
            homeArsenal: homeArsenal || null,
            parkFactors: getParkFactors(game.home_team, venueName),
            weather: weather ? {
              wxHR: (() => {
                if (!weather || weather.dome) return 1.0;
                let mult = 1.0;
                const temp = weather.temp || 72;
                const effWind = weather.effWind || 0;
                const flags = weather.flags || [];
                if (temp >= 85) mult *= 1.05;
                if (temp <= 50) mult *= 0.95;
                if (flags.some(f => (f||'').includes('OUT to CF'))) mult *= 1 + Math.min(effWind * 0.008, 0.15);
                if (flags.some(f => (f||'').includes('IN from CF'))) mult *= 1 - Math.min(effWind * 0.008, 0.12);
                return mult;
              })()
            } : null,
            totalLine: parseFloat(lines.total) || null,
            f5Line: f5Lines?.f5Total || null,
          });
          analysis.simAwayRuns = +simProbs.meanAway.toFixed(2);
          analysis.simHomeRuns = +simProbs.meanHome.toFixed(2);
          // Sim PLAYS: run the sim's own probabilities through the SAME EV/verdict machinery
          // the model uses (evPct/pickSide/verdictFor), so "the plays the sim likes" are
          // computed and graded identically to the model's. SHADOW ONLY — these verdicts drive
          // nothing; they exist purely for the model-vs-sim scoreboard.
          const simMl = pickSide([
            { ev: evPct(simProbs.pAwayML, lines.awayML), label: 'AWAY' },
            { ev: evPct(simProbs.pHomeML, lines.homeML), label: 'HOME' }
          ]);
          analysis.simMl = simMl ? verdictFor(simMl.ev, simMl.label) : 'SKIP';
          analysis.simMlEV = simMl ? simMl.ev : null;
          // RL: map the sim's by-2 margin probs onto the ACTUAL run-line side. No more
          // away=-1.5 assumption — away is the -1.5 favorite only when its run-line point is negative.
          const aRLpt = parseFloat(lines.awayRL);
          const awayIsFav = !isNaN(aRLpt) ? aRLpt < 0 : (parseFloat(lines.awayML) < parseFloat(lines.homeML));
          let simPAwayRL, simPHomeRL;
          if (simProbs.pAwayBy2 != null && simProbs.pHomeBy2 != null) {
            simPAwayRL = awayIsFav ? simProbs.pAwayBy2 : (1 - simProbs.pHomeBy2);   // away covers its real line
            simPHomeRL = awayIsFav ? (1 - simProbs.pAwayBy2) : simProbs.pHomeBy2;   // home covers its real line
          } else {                                                                  // older engine fallback
            simPAwayRL = simProbs.pAwayRL; simPHomeRL = simProbs.pHomeRL;
          }
          const simRl = pickSide([
            { ev: evPct(simPAwayRL, lines.awayRLOdds), label: 'AWAY' },
            { ev: evPct(simPHomeRL, lines.homeRLOdds), label: 'HOME' }
          ]);
          analysis.simRl = simRl ? verdictFor(simRl.ev, simRl.label) : 'SKIP';
          analysis.simRlEV = simRl ? simRl.ev : null;
          const simTot = pickSide([
            { ev: evPct(simProbs.pOver, lines.overOdds), label: 'OVER' },
            { ev: evPct(simProbs.pUnder, lines.underOdds), label: 'UNDER' }
          ]);
          analysis.simTotal = simTot ? verdictFor(simTot.ev, simTot.label) : 'SKIP';
          analysis.simTotalEV = simTot ? simTot.ev : null;
          console.log(`  SIM ${game.away_team} ${analysis.simAwayRuns} - ${analysis.simHomeRuns} ${game.home_team} | LLM ${analysis.projAwayRuns ?? '?'} - ${analysis.projHomeRuns ?? '?'} (sim pAwayML ${(simProbs.pAwayML*100).toFixed(0)}%, pOver ${(simProbs.pOver*100).toFixed(0)}%) | sim plays ML:${analysis.simMl} RL:${analysis.simRl} TOT:${analysis.simTotal}`);
        }
      } catch (e) {
        console.log(`  sim shadow error: ${e.message}`);
      }

      // Series sweep-fade overlay: if this is game 3+ of a series and one team has swept it so far,
      // flag the side in position to complete the sweep so the model stands down off its +EV play.
      const _gd = new Date(game.commence_time).toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
      let sweepSide = null;
      const sgn = sg?.seriesGameNumber || 0;
      if (sgn >= 3 && awayTeamId && homeTeamId) {
        try { sweepSide = await fetchSeriesSweepSide(awayTeamId, homeTeamId, _gd, sgn, sg?.gamePk || null); }
        catch(e) { /* best-effort */ }
        if (sweepSide) console.log(`  ⚑ sweep spot: ${sweepSide} in position to complete the sweep (series G${sgn}) — fading their +EV ML/RL`);
      }

      // Derive ML/RL probabilities from the projected run margin, then all EV/breakeven/juice
      deriveRunModel(analysis, lines);
      deriveNumbers(analysis, lines, f5Lines, sweepSide, _gd);

      await upsertGame(game, lines, analysis, anData, f5Lines, weather, awayPitcherInfo, homePitcherInfo, awayStatcast, homeStatcast, awayMatchups, homeMatchups, pitcherStatus, resolvedGamePk);

      const ap = awayPitcherInfo?.name || 'TBD';
      const hp = homePitcherInfo?.name || 'TBD';
      console.log(`  ✓ ${game.away_team} @ ${game.home_team} | ${ap} vs ${hp} | ${lines.total} | ${weather?.summary||'dome/no weather'}`);
      await new Promise(r => setTimeout(r, 2500));
    } catch(err) {
      console.error(`  ✗ ${game.away_team} @ ${game.home_team}:`, err.message);
    }
  }

  console.log(`\n✅ Done — ${todayGames.length} games`);
  await settlePendingBets();
  await settleGameScores();
  await computeClvFromBooks();  // pick up CLV for any bet whose book was entered since last run
}

main();
