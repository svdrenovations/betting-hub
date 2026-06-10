#!/usr/bin/env node

// MLB Analysis Script
// Runs via GitHub Actions at 11am and 4pm ET
// Pulls from Odds API, runs Claude analysis, stores in Supabase

const ODDS_API_KEY = process.env.ODDS_API_KEY;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const RUN_TYPE = process.env.RUN_TYPE || '11am';

async function fetchOdds() {
  console.log('Fetching MLB schedule and odds from The Odds API...');
  const url = `https://api.the-odds-api.com/v4/sports/baseball_mlb/odds/?apiKey=${ODDS_API_KEY}&regions=us&markets=h2h,spreads,totals&oddsFormat=american&dateFormat=iso`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Odds API error: ${res.status} ${await res.text()}`);
  const data = await res.json();
  console.log(`Found ${data.length} games`);
  return data;
}

function parseOddsData(game) {
  let awayML = null, homeML = null, total = null, awayRL = null, homeRL = null;
  
  for (const bookmaker of (game.bookmakers || [])) {
    for (const market of (bookmaker.markets || [])) {
      if (market.key === 'h2h' && !awayML) {
        for (const outcome of market.outcomes) {
          if (outcome.name === game.away_team) awayML = outcome.price > 0 ? `+${outcome.price}` : `${outcome.price}`;
          if (outcome.name === game.home_team) homeML = outcome.price > 0 ? `+${outcome.price}` : `${outcome.price}`;
        }
      }
      if (market.key === 'totals' && !total) {
        const over = market.outcomes.find(o => o.name === 'Over');
        if (over) total = `${over.point}`;
      }
      if (market.key === 'spreads' && !awayRL) {
        for (const outcome of market.outcomes) {
          if (outcome.name === game.away_team) awayRL = outcome.point > 0 ? `+${outcome.point}` : `${outcome.point}`;
          if (outcome.name === game.home_team) homeRL = outcome.point > 0 ? `+${outcome.point}` : `${outcome.point}`;
        }
      }
    }
    if (awayML && homeML && total) break;
  }
  
  return { awayML, homeML, total, awayRL, homeRL };
}

async function analyzeGame(game, lines) {
  console.log(`  Analyzing ${game.away_team} @ ${game.home_team}...`);
  
  const prompt = `You are an expert MLB betting analyst. Today is ${new Date().toLocaleDateString('en-US', {weekday:'long',month:'long',day:'numeric',year:'numeric'})}. Analyze this game and return ONLY valid JSON.

GAME: ${game.away_team} @ ${game.home_team}
Time: ${new Date(game.commence_time).toLocaleTimeString('en-US', {hour:'numeric',minute:'2-digit',timeZone:'America/New_York'})} ET
Moneyline: ${game.away_team} ${lines.awayML || '?'} / ${game.home_team} ${lines.homeML || '?'}
Run line: ${lines.awayRL || 'N/A'} / ${lines.homeRL || 'N/A'}
Total: ${lines.total || '?'}
Run type: ${RUN_TYPE} analysis

Analyze based on your knowledge of these teams' 2025-2026 season performance, pitching matchups, recent form, situational trends, and line value. Score all four markets.

Return ONLY this JSON (no markdown):
{
  "situations": [],
  "ml": "BET AWAY|BET HOME|LEAN AWAY|LEAN HOME|SKIP",
  "mlEV": NUMBER,
  "rl": "BET AWAY|BET HOME|LEAN AWAY|LEAN HOME|SKIP",
  "rlEV": NUMBER,
  "total": "BET OVER|BET UNDER|LEAN OVER|LEAN UNDER|SKIP",
  "totalEV": NUMBER,
  "f5": "BET AWAY|BET HOME|BET OVER|BET UNDER|LEAN AWAY|LEAN HOME|LEAN OVER|LEAN UNDER|SKIP",
  "f5EV": NUMBER,
  "best": "ml|rl|total|f5",
  "bestPlay": "one sentence on the strongest play",
  "awayWinPct": NUMBER,
  "homeWinPct": NUMBER,
  "projTotal": NUMBER,
  "edgePct": NUMBER,
  "confidence": "LOW|MEDIUM|HIGH",
  "lineSharp": true|false,
  "sharpSide": "${game.away_team}|${game.home_team}|NONE",
  "lineNote": "brief line movement note",
  "situation": "2 sentences on key situational factors",
  "factors": "2 sentences on pitching and recent form",
  "risks": "1 sentence on biggest risk"
}

Situations array may include: revenge, travel, sharp, weather, rest, series, fade, mustwin`;

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-5',
      max_tokens: 1000,
      messages: [{ role: 'user', content: prompt }]
    })
  });

  if (!res.ok) throw new Error(`Claude API error: ${res.status}`);
  const data = await res.json();
  const text = data.content.map(c => c.text || '').join('').trim();
  
  try {
    const clean = text.replace(/```json|```/g, '').trim();
    const s = clean.indexOf('{'), e = clean.lastIndexOf('}');
    return JSON.parse(clean.substring(s, e + 1));
  } catch(err) {
    console.error(`Parse error for ${game.away_team} @ ${game.home_team}:`, text.substring(0, 200));
    return null;
  }
}

async function upsertGame(game, lines, analysis) {
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
    away_rl: lines.awayRL,
    home_rl: lines.homeRL,
    run_type: RUN_TYPE,
    updated_at: new Date().toISOString()
  };

  if (analysis) {
    Object.assign(row, {
      analyzed: true,
      analyzed_at: new Date().toISOString(),
      situations: analysis.situations || [],
      ml_verdict: analysis.ml,
      ml_ev: analysis.mlEV,
      rl_verdict: analysis.rl,
      rl_ev: analysis.rlEV,
      total_verdict: analysis.total,
      total_ev: analysis.totalEV,
      f5_verdict: analysis.f5,
      f5_ev: analysis.f5EV,
      best_market: analysis.best,
      best_play: analysis.bestPlay,
      away_win_pct: analysis.awayWinPct,
      home_win_pct: analysis.homeWinPct,
      proj_total: analysis.projTotal,
      edge_pct: analysis.edgePct,
      confidence: analysis.confidence,
      line_sharp: analysis.lineSharp,
      sharp_side: analysis.sharpSide,
      line_note: analysis.lineNote,
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

  if (!res.ok) {
    const err = await res.text();
    console.error(`Supabase error for ${game.away_team} @ ${game.home_team}:`, err);
  }
}

async function main() {
  console.log(`\n=== MLB Analysis Run: ${RUN_TYPE} ===`);
  console.log(`Time: ${new Date().toLocaleString('en-US', {timeZone: 'America/New_York'})} ET\n`);

  try {
    const games = await fetchOdds();
    
    // Filter to today's games only
    const today = new Date().toISOString().split('T')[0];
    const todayGames = games.filter(g => g.commence_time.startsWith(today));
    console.log(`Today's games: ${todayGames.length}\n`);

    for (const game of todayGames) {
      const lines = parseOddsData(game);
      const analysis = await analyzeGame(game, lines);
      await upsertGame(game, lines, analysis);
      console.log(`  ✓ ${game.away_team} @ ${game.home_team}`);
      // Small delay to avoid rate limits
      await new Promise(r => setTimeout(r, 2000));
    }

    console.log(`\n✅ Complete — ${todayGames.length} games processed`);
  } catch(err) {
    console.error('Fatal error:', err);
    process.exit(1);
  }
}

main();
