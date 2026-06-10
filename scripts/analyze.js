#!/usr/bin/env node

const ODDS_API_KEY = process.env.ODDS_API_KEY;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const WEATHER_API_KEY = process.env.WEATHER_API_KEY;
const RUN_TYPE = process.env.RUN_TYPE || '11am';

// MLB park coordinates for weather
const PARK_COORDS = {
  'Arizona Diamondbacks': { lat: 33.4453, lon: -112.0667, dome: true },
  'Atlanta Braves': { lat: 33.8908, lon: -84.4681, dome: false },
  'Baltimore Orioles': { lat: 39.2838, lon: -76.6218, dome: false },
  'Boston Red Sox': { lat: 42.3467, lon: -71.0972, dome: false },
  'Chicago Cubs': { lat: 41.9484, lon: -87.6553, dome: false },
  'Chicago White Sox': { lat: 41.8300, lon: -87.6339, dome: false },
  'Cincinnati Reds': { lat: 39.0979, lon: -84.5082, dome: false },
  'Cleveland Guardians': { lat: 41.4962, lon: -81.6852, dome: false },
  'Colorado Rockies': { lat: 39.7559, lon: -104.9942, dome: false },
  'Detroit Tigers': { lat: 42.3390, lon: -83.0485, dome: false },
  'Houston Astros': { lat: 29.7573, lon: -95.3555, dome: true },
  'Kansas City Royals': { lat: 39.0517, lon: -94.4803, dome: false },
  'Los Angeles Angels': { lat: 33.8003, lon: -117.8827, dome: false },
  'Los Angeles Dodgers': { lat: 34.0739, lon: -118.2400, dome: false },
  'Miami Marlins': { lat: 25.7781, lon: -80.2197, dome: true },
  'Milwaukee Brewers': { lat: 43.0280, lon: -87.9712, dome: true },
  'Minnesota Twins': { lat: 44.9817, lon: -93.2777, dome: true },
  'New York Mets': { lat: 40.7571, lon: -73.8458, dome: false },
  'New York Yankees': { lat: 40.8296, lon: -73.9262, dome: false },
  'Oakland Athletics': { lat: 37.7516, lon: -122.2005, dome: false },
  'Philadelphia Phillies': { lat: 39.9061, lon: -75.1665, dome: false },
  'Pittsburgh Pirates': { lat: 40.4469, lon: -80.0057, dome: false },
  'San Diego Padres': { lat: 32.7076, lon: -117.1570, dome: false },
  'San Francisco Giants': { lat: 37.7786, lon: -122.3893, dome: false },
  'Seattle Mariners': { lat: 47.5914, lon: -122.3325, dome: true },
  'St. Louis Cardinals': { lat: 38.6226, lon: -90.1928, dome: false },
  'Tampa Bay Rays': { lat: 27.7683, lon: -82.6534, dome: true },
  'Texas Rangers': { lat: 32.7473, lon: -97.0845, dome: true },
  'Toronto Blue Jays': { lat: 43.6414, lon: -79.3894, dome: true },
  'Washington Nationals': { lat: 38.8730, lon: -77.0074, dome: false }
};

// Fetch weather for home park
async function fetchWeather(homeTeam, gameTime) {
  try {
    const park = PARK_COORDS[homeTeam];
    if (!park) return null;
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

    // Determine wind direction relative to field
    const windDir = windDeg < 45 || windDeg >= 315 ? 'N' :
                    windDeg < 135 ? 'E' :
                    windDeg < 225 ? 'S' : 'W';

    // Flag significant weather
    const flags = [];
    if (windSpeed >= 15) flags.push(windSpeed >= 20 ? 'HIGH WIND' : 'WIND FACTOR');
    if (temp <= 45) flags.push('COLD WEATHER');
    if (temp >= 90) flags.push('HOT WEATHER');
    if (desc.includes('rain') || desc.includes('storm')) flags.push('RAIN RISK');

    // Wind impact on totals
    let windImpact = 'neutral';
    if (windSpeed >= 12) {
      // Simplified: out = over, in = under (depends on park orientation)
      windImpact = windSpeed >= 20 ? 'significant wind factor' : 'moderate wind factor';
    }

    return {
      dome: false,
      temp,
      desc,
      windSpeed,
      windDir,
      windImpact,
      flags,
      summary: `${temp}°F, ${desc}, wind ${windSpeed}mph ${windDir}${flags.length ? ' — ' + flags.join(', ') : ''}`
    };
  } catch(e) {
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
    if (!match) return null;
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
      if (mkt.key==='totals'&&!total) {
        const over=mkt.outcomes.find(o=>o.name==='Over');
        const under=mkt.outcomes.find(o=>o.name==='Under');
        if (over) { total=`${over.point}`; overOdds=over.price>0?`+${over.price}`:`${over.price}`; underOdds=under?(under.price>0?`+${under.price}`:`${under.price}`):null; }
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
  if (anTotal&&!isNaN(at)&&at>=6.5&&at<=14.0) return `${at}`;
  if (!isNaN(ot)&&ot>=6.5&&ot<=14.0) return `${ot}`;
  return oddsTotal;
}

async function analyzeGame(game, lines, anData, f5Lines, weather, awayStats, homeStats, awayPitcher, homePitcher) {
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
Home: ${homePitcherInfo}

TEAM STATS (2026 season):
Away: ${awayTeamInfo}
Home: ${homeTeamInfo}

PUBLIC BETTING:
${publicInfo}

ANALYSIS INSTRUCTIONS:
- Hot pitchers (trending HOT with recent ERA lower than season ERA) give their team a significant edge
- Cold pitchers (trending COLD) are fade candidates even if season ERA is good
- Wind 15+ mph out = over lean, wind 15+ mph in = under lean (for outdoor parks)
- Heavy public sides (70%+) on totals are often worth fading
- Factor platoon splits — lefty/righty matchup advantages
- Series context, rest days, travel fatigue are key situational factors

For EACH market with positive EV, include the EXACT LINE being used in the projTotal, f5ProjTotal fields.

Return ONLY this JSON (no markdown):
{
  "situations": [],
  "ml": "BET AWAY|BET HOME|LEAN AWAY|LEAN HOME|SKIP",
  "mlEV": NUMBER,
  "rl": "BET AWAY|BET HOME|LEAN AWAY|LEAN HOME|SKIP",
  "rlEV": NUMBER,
  "total": "BET OVER|BET UNDER|LEAN OVER|LEAN UNDER|SKIP",
  "totalEV": NUMBER,
  "totalLine": NUMBER,
  "projTotal": NUMBER,
  "f5": "BET AWAY|BET HOME|BET OVER|BET UNDER|LEAN AWAY|LEAN HOME|LEAN OVER|LEAN UNDER|SKIP",
  "f5EV": NUMBER,
  "f5Line": NUMBER,
  "f5ProjTotal": NUMBER,
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
}`;

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

async function upsertGame(game, lines, analysis, anData, f5Lines, weather) {
  const row = {
    id: game.id,
    game_date: new Date(game.commence_time).toISOString().split('T')[0],
    away_team: game.away_team,
    home_team: game.home_team,
    commence_time: game.commence_time,
    away_pitcher: 'TBD',
    home_pitcher: 'TBD',
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
    weather_wind_dir: weather?.windDir||null,
    weather_flags: weather?.flags||[],
    weather_dome: weather?.dome||false,
    run_type: RUN_TYPE,
    updated_at: new Date().toISOString()
  };

  if (analysis) {
    Object.assign(row, {
      analyzed: true,
      analyzed_at: new Date().toISOString(),
      situations: analysis.situations||[],
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

async function main() {
  console.log(`\n=== MLB Analysis: ${RUN_TYPE} ===`);
  console.log(`${new Date().toLocaleString('en-US',{timeZone:'America/New_York'})} ET\n`);

  const [games, f5Map] = await Promise.all([fetchOddsAPI(), fetchF5Lines()]);
  const today = new Date().toISOString().split('T')[0];
  const todayGames = games.filter(g => g.commence_time.startsWith(today));
  console.log(`Today: ${todayGames.length} games\n`);

  for (const game of todayGames) {
    try {
      const lines = parseOddsData(game);

      const [anData, weather, awayStats, homeStats] = await Promise.all([
        fetchActionNetwork(game.away_team, game.home_team, game.commence_time),
        fetchWeather(game.home_team, game.commence_time),
        fetchTeamStats(game.away_team),
        fetchTeamStats(game.home_team)
      ]);

      if (anData?.total) lines.total = validateTotal(lines.total, anData.total);

      const f5Lines = f5Map[game.id] || null;
      const analysis = await analyzeGame(game, lines, anData, f5Lines, weather, awayStats, homeStats, null, null);
      await upsertGame(game, lines, analysis, anData, f5Lines, weather);

      console.log(`  ✓ ${game.away_team} @ ${game.home_team} | ${lines.total} | ${weather?.summary||'dome/no weather'} | Public: ${anData?.overPct||'?'}% Over`);
      await new Promise(r => setTimeout(r, 2500));
    } catch(err) {
      console.error(`  ✗ ${game.away_team} @ ${game.home_team}:`, err.message);
    }
  }

  console.log(`\n✅ Done — ${todayGames.length} games`);
}

main();
