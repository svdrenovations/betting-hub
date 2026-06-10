#!/usr/bin/env node

const ODDS_API_KEY = process.env.ODDS_API_KEY;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const WEATHER_API_KEY = process.env.WEATHER_API_KEY;
const RUN_TYPE = process.env.RUN_TYPE || '11am';

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
  'Oakland Athletics': { lat: 37.7516, lon: -122.2005, dome: false , homeplateFacing: 60},
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

// Fetch weather for home park
async function fetchWeather(homeTeam, gameTime) {
  try {
    let park = PARK_COORDS[homeTeam];
    if (!park) {
      // fuzzy match
      const key = Object.keys(PARK_COORDS).find(k => k.includes(homeTeam.split(' ').pop()) || homeTeam.includes(k.split(' ').pop()));
      if (key) park = PARK_COORDS[key];
    }
    if (!park) { console.log(`  No park found for ${homeTeam}`); return null; }
    if (park.dome) return { dome: true, description: 'Indoor dome — weather not a factor' };

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
      windImpact = windSpeed >= 10 ? 'over' : 'neutral';
    } else if (relAngle >= 135 && relAngle <= 225) {
      fieldWindDir = 'IN from CF';
      windArrow = '↓';
      windImpact = windSpeed >= 10 ? 'under' : 'neutral';
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
    if (windSpeed >= 18 && windImpact === 'over') windImpact = 'significant over';
    if (windSpeed >= 18 && windImpact === 'under') windImpact = 'significant under';

    // Flag significant weather
    const flags = [];
    if (windSpeed >= 15) flags.push(windSpeed >= 20 ? 'HIGH WIND' : 'WIND FACTOR');
    if (temp <= 45) flags.push('COLD WEATHER');
    if (temp >= 90) flags.push('HOT WEATHER');
    if (desc.includes('rain') || desc.includes('storm')) flags.push('RAIN RISK');
    if (windSpeed >= 10 && (fieldWindDir === 'OUT to CF' || fieldWindDir === 'IN from CF')) {
      flags.push(windImpact.toUpperCase());
    }

    return {
      dome: false,
      temp,
      desc,
      windSpeed,
      windCard,
      fieldWindDir,
      windArrow,
      windImpact,
      flags,
      summary: `${temp}°F, ${desc}, wind ${windSpeed}mph ${windCard} (${windArrow} ${fieldWindDir})${flags.length ? ' — ' + flags.join(', ') : ''}`
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
async function fetchTeamStats(teamName) {
  try {
    const teamsRes = await fetch('https://statsapi.mlb.com/api/v1/teams?sportId=1&season=2026');
    if (!teamsRes.ok) return null;
    const teamsData = await teamsRes.json();
    const team = teamsData.teams?.find(t =>
      t.name.toLowerCase().includes(teamName.toLowerCase().split(' ').pop().toLowerCase()) ||
      teamName.toLowerCase().includes(t.name.toLowerCase().split(' ').pop().toLowerCase())
    );
    if (!team) return null;

    const statsRes = await fetch(
      `https://statsapi.mlb.com/api/v1/teams/${team.id}/stats?stats=season&group=hitting&season=2026`
    );
    if (!statsRes.ok) return null;
    const statsData = await statsRes.json();
    const stats = statsData.stats?.[0]?.splits?.[0]?.stat;
    if (!stats) return null;

    // Get last 10 games record
    const schedRes = await fetch(
      `https://statsapi.mlb.com/api/v1/schedule?teamId=${team.id}&sportId=1&season=2026&gameType=R&startDate=2026-01-01&endDate=${new Date().toISOString().split('T')[0]}`
    );
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
      avg: stats.avg,
      ops: stats.ops,
      runs: stats.runs,
      hr: stats.homeRuns,
      obp: stats.obp,
      slg: stats.slg,
      last10
    };
  } catch(e) {
    return null;
  }
}

// Fetch today's probable pitchers from MLB Stats API
async function fetchProbablePitchers(gameDate) {
  try {
    const res = await fetch(
      `https://statsapi.mlb.com/api/v1/schedule?sportId=1&date=${gameDate}&gameType=R&hydrate=probablePitcher(note),team`
    );
    if (!res.ok) return {};
    const data = await res.json();
    const pitcherMap = {};
    for (const date of (data.dates || [])) {
      for (const game of (date.games || [])) {
        const awayId = game.teams?.away?.team?.id;
        const homeId = game.teams?.home?.team?.id;
        const awayPitcher = game.teams?.away?.probablePitcher;
        const homePitcher = game.teams?.home?.probablePitcher;
        if (awayPitcher) pitcherMap[`away_${awayId}`] = {
          id: awayPitcher.id,
          name: awayPitcher.fullName,
          note: awayPitcher.note || null
        };
        if (homePitcher) pitcherMap[`home_${homeId}`] = {
          id: homePitcher.id,
          name: homePitcher.fullName,
          note: homePitcher.note || null
        };
      }
    }
    console.log(`Probable pitchers found: ${Object.keys(pitcherMap).length}`);
    return pitcherMap;
  } catch(e) {
    console.log('Pitcher lookup failed:', e.message);
    return {};
  }
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
    const team = data.teams?.find(t =>
      t.name.toLowerCase().includes(teamName.toLowerCase().split(' ').pop().toLowerCase()) ||
      teamName.toLowerCase().includes(t.name.toLowerCase().split(' ').pop().toLowerCase())
    );
    return team?.id || null;
  } catch(e) { return null; }
}


// Fetch Statcast pitcher metrics from Baseball Savant
async function fetchStatcast(pitcherName, pitcherId) {
  try {
    if (!pitcherId) return null;
    const endDate = new Date().toISOString().split('T')[0];
    const startDate = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
    
    const url = 'https://baseballsavant.mlb.com/statcast_search/csv?player_type=pitcher&pitchers_lookup[]=' + pitcherId + '&game_date_gt=' + startDate + '&game_date_lt=' + endDate + '&type=details&hfSea=2026%7C&group_by=name&sort_col=pitches&sort_order=desc&min_abs=0';

    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'text/csv' }
    });
    if (!res.ok) return null;
    const csv = await res.text();
    const lines = csv.trim().split('\n');
    if (lines.length < 2) return null;

    const headers = lines[0].split(',');
    const getCol = (row, name) => {
      const idx = headers.indexOf(name);
      return idx >= 0 ? row.split(',')[idx] : null;
    };

    // Parse all pitches
    let totalPitches = 0, totalVelo = 0, swings = 0, whiffs = 0;
    let barrels = 0, hardHits = 0, batted = 0;
    const startVelos = {};

    for (let i = 1; i < lines.length; i++) {
      const row = lines[i];
      if (!row.trim()) continue;
      const velo = parseFloat(getCol(row, 'release_speed'));
      const gameDate = getCol(row, 'game_date');
      const description = getCol(row, 'description');
      const exitVelo = parseFloat(getCol(row, 'launch_speed'));
      const isBarrel = getCol(row, 'barrel');

      if (!isNaN(velo) && velo > 0) {
        totalPitches++;
        totalVelo += velo;
        if (gameDate) {
          if (!startVelos[gameDate]) startVelos[gameDate] = { total: 0, count: 0 };
          startVelos[gameDate].total += velo;
          startVelos[gameDate].count++;
        }
      }
      if (description && (description.includes('swing') || description.includes('foul') || description.includes('hit'))) swings++;
      if (description && description.includes('swinging_strike')) whiffs++;
      if (!isNaN(exitVelo) && exitVelo > 0) {
        batted++;
        if (exitVelo >= 95) hardHits++;
        if (isBarrel === '1') barrels++;
      }
    }

    const avgVelo = totalPitches > 0 ? (totalVelo / totalPitches).toFixed(1) : null;
    const whiffRate = swings > 0 ? ((whiffs / swings) * 100).toFixed(1) : null;
    const hardHitRate = batted > 0 ? ((hardHits / batted) * 100).toFixed(1) : null;
    const barrelRate = batted > 0 ? ((barrels / batted) * 100).toFixed(1) : null;

    // Velocity trend — compare last start to average
    const startDates = Object.keys(startVelos).sort().slice(-5);
    const lastStartVelo = startDates.length > 0
      ? (startVelos[startDates[startDates.length-1]].total / startVelos[startDates[startDates.length-1]].count).toFixed(1)
      : null;
    const veloTrend = avgVelo && lastStartVelo
      ? parseFloat(lastStartVelo) < parseFloat(avgVelo) - 1.5 ? 'DOWN' :
        parseFloat(lastStartVelo) > parseFloat(avgVelo) + 1.0 ? 'UP' : 'STABLE'
      : 'UNKNOWN';

    return {
      avgVelo,
      lastStartVelo,
      veloTrend,
      whiffRate,
      hardHitRate,
      barrelRate,
      pitches: totalPitches
    };
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
    const stats = data.stats?.[0]?.splits?.[0]?.stat;
    if (!stats) return null;
    return {
      ab: stats.atBats || 0,
      avg: stats.avg || '.000',
      ops: stats.ops || '.000',
      hr: stats.homeRuns || 0,
      so: stats.strikeOuts || 0
    };
  } catch(e) { return null; }
}

// Build full lineup matchup profile vs starting pitcher
async function fetchLineupMatchups(teamId, pitcherId, gameDate) {
  try {
    const lineup = await fetchLineup(teamId, gameDate);
    if (!lineup || !lineup.length) return null;

    const matchups = await Promise.all(
      lineup.slice(0, 9).map(batter => fetchMatchupStats(batter.id, pitcherId))
    );

    // Aggregate matchup stats (minimum 10 AB for meaningful data)
    const meaningful = matchups.filter(m => m && m.ab >= 10);
    if (!meaningful.length) return { lineup: lineup.slice(0,9), matchups, meaningful: 0, note: 'Insufficient sample vs this pitcher' };

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
      sample: `${meaningful.length} of 9 batters with 10+ AB vs this pitcher`
    };
  } catch(e) {
    console.log('  Lineup matchup error:', e.message);
    return null;
  }
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

function parseOddsData(game) {
  let awayML=null,homeML=null,total=null,overOdds=null,underOdds=null,awayRL=null,homeRL=null,awayRLOdds=null,homeRLOdds=null;
  for (const bm of (game.bookmakers||[])) {
    for (const mkt of (bm.markets||[])) {
      if (mkt.key==='h2h'&&!awayML) {
        for (const o of mkt.outcomes) {
          if (o.name===game.away_team) awayML=o.price>0?`+${o.price}`:`${o.price}`;
          if (o.name===game.home_team) homeML=o.price>0?`+${o.price}`:`${o.price}`;
        }
      }
      if (mkt.key==='totals') {
        const over=mkt.outcomes.find(o=>o.name==='Over');
        const under=mkt.outcomes.find(o=>o.name==='Under');
        if (over) {
          const pt = parseFloat(over.point);
          // Only use if within realistic MLB range AND better than current
          if (pt >= 6.5 && pt <= 13.5) {
            if (!total) {
              total=`${over.point}`; 
              overOdds=over.price>0?`+${over.price}`:`${over.price}`; 
              underOdds=under?(under.price>0?`+${under.price}`:`${under.price}`):null;
            }
          } else if (!total) {
            // Store unrealistic total temporarily
            total=`${over.point}`;
            overOdds=over.price>0?`+${over.price}`:`${over.price}`;
            underOdds=under?(under.price>0?`+${under.price}`:`${under.price}`):null;
          }
        }
      }
      if (mkt.key==='spreads'&&!awayRL) {
        for (const o of mkt.outcomes) {
          if (o.name===game.away_team) { awayRL=o.point>0?`+${o.point}`:`${o.point}`; awayRLOdds=o.price>0?`+${o.price}`:`${o.price}`; }
          if (o.name===game.home_team) { homeRL=o.point>0?`+${o.point}`:`${o.point}`; homeRLOdds=o.price>0?`+${o.price}`:`${o.price}`; }
        }
      }
    }
    if (awayML&&homeML&&total&&awayRL) break;
  }
  return {awayML,homeML,total,overOdds,underOdds,awayRL,homeRL,awayRLOdds,homeRLOdds};
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

async function analyzeGame(game, lines, anData, f5Lines, weather, awayStats, homeStats, awayPitcher, homePitcher, awayStatcast, homeStatcast, awayMatchups, homeMatchups) {
  console.log(`  Analyzing ${game.away_team} @ ${game.home_team}...`);

  const weatherInfo = weather
    ? weather.dome ? 'Indoor dome — weather not a factor'
    : `${weather.summary}${weather.flags?.length ? '\nWeather flags: ' + weather.flags.join(', ') : ''}`
    : 'Weather data unavailable';

  const awayPitcherInfo = awayPitcher
    ? `${awayPitcher.name}: ERA ${awayPitcher.era}, WHIP ${awayPitcher.whip}, ${awayPitcher.wins}W-${awayPitcher.losses}L, Recent ERA ${awayPitcher.recentERA} (${awayPitcher.trending}), Last 3: ${awayPitcher.last3?.map(g=>`${g.ip}IP/${g.er}ER`).join(', ')}`
    : 'Away pitcher: TBD';

  const homePitcherInfo = homePitcher
    ? `${homePitcher.name}: ERA ${homePitcher.era}, WHIP ${homePitcher.whip}, ${homePitcher.wins}W-${homePitcher.losses}L, Recent ERA ${homePitcher.recentERA} (${homePitcher.trending}), Last 3: ${homePitcher.last3?.map(g=>`${g.ip}IP/${g.er}ER`).join(', ')}`
    : 'Home pitcher: TBD';

  const awayTeamInfo = awayStats
    ? `${awayStats.teamName}: AVG ${awayStats.avg}, OPS ${awayStats.ops}, ${awayStats.runs} runs scored, ${awayStats.hr} HR, Last 10: ${awayStats.last10||'N/A'}`
    : `${game.away_team}: Stats unavailable`;

  const homeTeamInfo = homeStats
    ? `${homeStats.teamName}: AVG ${homeStats.avg}, OPS ${homeStats.ops}, ${homeStats.runs} runs scored, ${homeStats.hr} HR, Last 10: ${homeStats.last10||'N/A'}`
    : `${game.home_team}: Stats unavailable`;

  const publicInfo = anData
    ? `ML public: Away ${anData.awayMLPct||'?'}% bets/${anData.awayMoneyPct||'?'}% money | Home ${anData.homeMLPct||'?'}% bets/${anData.homeMoneyPct||'?'}% money\nTotal public: ${anData.overPct||'?'}% Over / ${anData.underPct||'?'}% Under`
    : 'Public betting data unavailable';

  const awayStatcastInfo = awayStatcast
    ? `${awayPitcher?.name||'Away'} Statcast: avg velo ${awayStatcast.avgVelo}mph (${awayStatcast.veloTrend}), last start ${awayStatcast.lastStartVelo}mph, whiff% ${awayStatcast.whiffRate}, hard hit% ${awayStatcast.hardHitRate}, barrel% ${awayStatcast.barrelRate}`
    : 'Away pitcher Statcast: unavailable';

  const homeStatcastInfo = homeStatcast
    ? `${homePitcher?.name||'Home'} Statcast: avg velo ${homeStatcast.avgVelo}mph (${homeStatcast.veloTrend}), last start ${homeStatcast.lastStartVelo}mph, whiff% ${homeStatcast.whiffRate}, hard hit% ${homeStatcast.hardHitRate}, barrel% ${homeStatcast.barrelRate}`
    : 'Home pitcher Statcast: unavailable';

  const awayMatchupInfo = awayMatchups
    ? `${game.away_team} lineup vs ${homePitcher?.name||'home pitcher'}: avg OPS ${awayMatchups.avgOPS}, avg AVG ${awayMatchups.avgAVG}, K% ${awayMatchups.kRate}, hot bats ${awayMatchups.hotBatters}, cold bats ${awayMatchups.coldBatters} (${awayMatchups.sample})`
    : `${game.away_team} lineup matchup data: unavailable (lineup not yet posted or no history vs this pitcher)`;

  const homeMatchupInfo = homeMatchups
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

PITCHING MATCHUP:
Away: ${awayPitcherInfo}
${awayStatcastInfo}
Home: ${homePitcherInfo}
${homeStatcastInfo}

LINEUP VS PITCHER MATCHUPS (career stats — min 10 AB):
${awayMatchupInfo}
${homeMatchupInfo}

TEAM STATS (2026 season):
Away: ${awayTeamInfo}
Home: ${homeTeamInfo}

PUBLIC BETTING:
${publicInfo}

ANALYSIS INSTRUCTIONS — CRITICAL:
- The "situations" array must ONLY contain these exact lowercase values: revenge, travel, sharp, weather, rest, series, fade, mustwin, debut. DO NOT add any other values. DO NOT use situations to flag data availability issues. If data is missing just work with what you have.
- ANALYSIS INSTRUCTIONS — CRITICAL:
- USE ONLY 2026 SEASON STATS for all total projections. IGNORE all prior year data entirely.
- TOTAL PROJECTION METHOD: (away team 2026 runs/game + home team 2026 runs/game) × pitcher adjustment × park factor × weather adjustment = projected total. Compare to line for edge.
- STATCAST IS CRITICAL: A pitcher with velocity DOWN trend is significantly worse than ERA suggests — fade. A pitcher with low barrel rate and high whiff rate is elite regardless of ERA — back. Hard hit rate above 42% means the pitcher is getting hit hard even if runs haven't scored yet.
- LINEUP MATCHUPS OVERRIDE SEASON STATS for total projections: if the opposing lineup has OPS below .600 vs this pitcher with 25%+ K rate, project runs 20-25% lower than season average. If lineup has OPS above .850 vs this pitcher, project runs 20-25% higher.
- Velocity DOWN on last start vs season average = COLD flag, reduce confidence, lean against this pitcher
- Velocity UP or STABLE = trust the ERA and recent form
- Hot pitchers (trending HOT — recent ERA significantly lower than season ERA) = team edge
- Cold pitchers (trending COLD) = fade regardless of reputation or contract
- Wind 15+ mph blowing out = over lean, 15+ mph in = under lean
- Current season form only — a team 2-8 in last 10 is a fade regardless of brand
- For EACH market with positive EV include the EXACT LINE in projTotal and f5ProjTotal

Return ONLY this JSON (no markdown):
{
  "situations": ["revenge","travel","sharp","weather","rest","series","fade","mustwin","debut"],
  "ml": "BET AWAY|BET HOME|LEAN AWAY|LEAN HOME|SKIP",
  "mlEV": NUMBER,
  "mlAwayProb": NUMBER,
  "mlHomeProb": NUMBER,
  "mlBreakeven": "the worst American odds line that still has positive EV e.g. -118",
  "rl": "BET AWAY|BET HOME|LEAN AWAY|LEAN HOME|SKIP",
  "rlEV": NUMBER,
  "rlBreakeven": "worst American odds still +EV e.g. -105",
  "total": "BET OVER|BET UNDER|LEAN OVER|LEAN UNDER|SKIP",
  "totalEV": NUMBER,
  "totalLine": NUMBER,
  "projTotal": NUMBER,
  "totalBreakeven": "worst total line still +EV e.g. Over 9.0 or Under 8.5",
  "totalJuiceSensitivity": {
    "description": "max juice at each nearby line where bet still has +EV",
    "lines": [
      {"line": NUMBER, "direction": "Over|Under", "maxJuice": NUMBER, "ev": NUMBER},
      {"line": NUMBER, "direction": "Over|Under", "maxJuice": NUMBER, "ev": NUMBER},
      {"line": NUMBER, "direction": "Over|Under", "maxJuice": NUMBER, "ev": NUMBER},
      {"line": NUMBER, "direction": "Over|Under", "maxJuice": NUMBER, "ev": NUMBER},
      {"line": NUMBER, "direction": "Over|Under", "maxJuice": NUMBER, "ev": NUMBER}
    ]
  },
  "f5": "BET AWAY|BET HOME|BET OVER|BET UNDER|LEAN AWAY|LEAN HOME|LEAN OVER|LEAN UNDER|SKIP",
  "f5EV": NUMBER,
  "f5Line": NUMBER,
  "f5ProjTotal": NUMBER,
  "f5Breakeven": "worst f5 line still +EV",
  "f5JuiceSensitivity": {
    "lines": [
      {"line": NUMBER, "direction": "Over|Under", "maxJuice": NUMBER, "ev": NUMBER},
      {"line": NUMBER, "direction": "Over|Under", "maxJuice": NUMBER, "ev": NUMBER},
      {"line": NUMBER, "direction": "Over|Under", "maxJuice": NUMBER, "ev": NUMBER}
    ]
  },
  "best": "ml|rl|total|f5",
  "bestPlay": "one sentence on the strongest play",
  "awayWinPct": NUMBER,
  "homeWinPct": NUMBER,
  "edgePct": NUMBER,
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

For juice sensitivity: for each half-point line near the projected total (projTotal ± 1.5), calculate:
- The maximum American odds (juice) where the bet still has positive EV at that line
- CRITICAL: As the total line goes HIGHER on an OVER, the win probability DECREASES, so the max juice must get BETTER (less negative, closer to even money). Example: Over 7.0 might allow -257 max juice, but Over 8.0 only allows -108 max juice because probability is lower.
- As the total line goes LOWER on an OVER, win probability INCREASES, so you can accept worse juice. Over 6.5 might allow -500 max juice because you win 85% of the time.
- Formula: maxJuice = -(winProbability / (1 - winProbability)) * 100. If result > 0 format as +X, if < -1000 cap at -1000.
- maxJuice is the breakeven juice — anything worse (more negative) than this is negative EV
- ev is the estimated EV% at standard -110 juice for that line

For breakeven lines: calculate the maximum juice/line where the bet still has positive EV based on your probability estimate. Example: if you estimate Away wins 54% of the time, the breakeven ML is -117 (anything worse than -117 is negative EV). For totals: if you project 9.8 runs and the line is 9.5, the breakeven is Under 10.5 — any total above 10.5 flips to negative EV.`;

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: 'claude-sonnet-4-5', max_tokens: 1200, messages: [{ role: 'user', content: prompt }] })
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

async function upsertGame(game, lines, analysis, anData, f5Lines, weather, awayPitcherData, homePitcherData, awayStatcastData, homeStatcastData, awayMatchupData, homeMatchupData) {
  const row = {
    id: game.id,
    game_date: new Date(game.commence_time).toLocaleDateString('en-CA', {timeZone: 'America/New_York'}),
    away_team: game.away_team,
    home_team: game.home_team,
    commence_time: game.commence_time,
    away_pitcher: awayPitcherData?.name || 'TBD',
    home_pitcher: homePitcherData?.name || 'TBD',
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
    home_lineup_k_rate: homeMatchupData?.kRate || null
  };

  if (analysis) {
    Object.assign(row, {
      analyzed: true,
      analyzed_at: new Date().toISOString(),
      situations: (analysis.situations||[]).filter(s => ['revenge','travel','sharp','weather','rest','series','fade','mustwin','debut'].includes((s||'').toLowerCase().trim())),
      ml_verdict: analysis.ml,
      ml_ev: analysis.mlEV,
      rl_verdict: analysis.rl,
      rl_ev: analysis.rlEV,
      total_verdict: analysis.total,
      total_ev: analysis.totalEV,
      total_line: analysis.totalLine,
      proj_total: analysis.projTotal,
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
      confidence: analysis.confidence,
      line_sharp: analysis.lineSharp,
      sharp_side: analysis.sharpSide,
      line_note: analysis.lineNote,
      weather_impact: analysis.weatherImpact,
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

        const game = games.find(g => {
          const awayTeam = g.teams?.away?.team?.name || '';
          const homeTeam = g.teams?.home?.team?.name || '';
          return (awayTeam.includes(awayName.split(' ').pop()) || awayName.includes(awayTeam.split(' ').pop())) &&
                 (homeTeam.includes(homeName?.split(' ').pop()) || homeName?.includes(homeTeam.split(' ').pop()));
        });

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
          if (awayScore - homeScore > 1.5) result = 'win';
          else if (awayScore - homeScore < 1.5) result = 'loss';
          else result = 'push';
        } else if (type.includes('rl +1.5') || type.includes('run line (home')) {
          if (homeScore - awayScore > -1.5) result = 'win';
          else if (homeScore - awayScore < -1.5) result = 'loss';
          else result = 'push';
        }

        if (result === 'pending') continue;

        // Update bet in Supabase
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

async function main() {
  console.log(`\n=== MLB Analysis: ${RUN_TYPE} ===`);
  console.log(`${new Date().toLocaleString('en-US',{timeZone:'America/New_York'})} ET\n`);

  // Use ET timezone for date
  const etDate = new Date().toLocaleDateString('en-US', {timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit'});
  const [etMonth, etDay, etYear] = etDate.split('/');
  const today = etYear + '-' + etMonth + '-' + etDay;
  const [games, f5Map, pitcherMap] = await Promise.all([fetchOddsAPI(), fetchF5Lines(), fetchProbablePitchers(today)]);
  const now = new Date();
  const todayGames = games.filter(g => {
    if (!g.commence_time.startsWith(today)) return false;
    const gameTime = new Date(g.commence_time);
    const minutesSinceStart = (now - gameTime) / 60000;
    // Skip games that started more than 5 minutes ago
    if (minutesSinceStart > 5) {
      console.log(`  Skipping ${g.away_team} @ ${g.home_team} — game already started`);
      return false;
    }
    // Skip games with extreme live lines (indicates in-game pricing)
    const lines = parseOddsData(g);
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
      const lines = parseOddsData(game);

      // Get team IDs for pitcher lookup
      const [awayTeamId, homeTeamId] = await Promise.all([
        getTeamId(game.away_team),
        getTeamId(game.home_team)
      ]);

      const awayPitcherInfo = awayTeamId ? pitcherMap[`away_${awayTeamId}`] : null;
      const homePitcherInfo = homeTeamId ? pitcherMap[`home_${homeTeamId}`] : null;

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
      if (homeStatcast) console.log(`  Statcast ${homePitcherInfo.name}: velo ${homeStatcast.avgVelo} (${homeStatcast.veloTrend}), whiff ${homeStatcast.whiffRate}%, barrel ${homeStatcast.barrelRate}%`);
      if (awayMatchups) console.log(`  Away lineup vs ${homePitcherInfo?.name}: OPS ${awayMatchups.avgOPS}, K% ${awayMatchups.kRate}`);
      if (homeMatchups) console.log(`  Home lineup vs ${awayPitcherInfo?.name}: OPS ${homeMatchups.avgOPS}, K% ${homeMatchups.kRate}`);

      const [anData, weather, awayStats, homeStats] = await Promise.all([
        fetchActionNetwork(game.away_team, game.home_team, game.commence_time),
        fetchWeather(game.home_team, game.commence_time),
        fetchTeamStats(game.away_team),
        fetchTeamStats(game.home_team)
      ]);

      if (anData?.total) lines.total = validateTotal(lines.total, anData.total);

      const f5Lines = f5Map[game.id] || null;
      const analysis = await analyzeGame(game, lines, anData, f5Lines, weather, awayStats, homeStats, awayPitcherInfo, homePitcherInfo, awayStatcast, homeStatcast, awayMatchups, homeMatchups);
      await upsertGame(game, lines, analysis, anData, f5Lines, weather, awayPitcherInfo, homePitcherInfo, awayStatcast, homeStatcast, awayMatchups, homeMatchups);

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
}

main();
