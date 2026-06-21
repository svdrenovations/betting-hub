#!/usr/bin/env node
// ── BETS CONFIDENCE BACKFILL ──────────────────────────────────────────────────
// Updates mlb_bets.confidence to match the recalibrated mlb_games.confidence
// by joining on game_date + matchup (away_team @ home_team).

const SUPABASE_URL         = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_KEY');
  process.exit(1);
}

const headers = {
  apikey:        SUPABASE_SERVICE_KEY,
  Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
  'Content-Type': 'application/json'
};

async function run() {
  // 1. Fetch all mlb_bets
  console.log('Fetching mlb_bets…');
  const betsRes = await fetch(
    `${SUPABASE_URL}/rest/v1/mlb_bets?select=id,game_date,matchup,confidence&limit=2000&order=id.asc`,
    { headers }
  );
  if (!betsRes.ok) { console.error('bets fetch failed:', await betsRes.text()); process.exit(1); }
  const bets = await betsRes.json();
  console.log(`  ${bets.length} bets loaded`);

  // 2. Fetch all mlb_games with updated confidence
  console.log('Fetching mlb_games…');
  const gamesRes = await fetch(
    `${SUPABASE_URL}/rest/v1/mlb_games?analyzed=eq.true&select=game_date,away_team,home_team,confidence&limit=2000&order=game_date.asc`,
    { headers }
  );
  if (!gamesRes.ok) { console.error('games fetch failed:', await gamesRes.text()); process.exit(1); }
  const games = await gamesRes.json();
  console.log(`  ${games.length} games loaded`);

  // 3. Build lookup: "YYYY-MM-DD|Away Team @ Home Team" → confidence
  const gameMap = {};
  for (const g of games) {
    const key = `${g.game_date}|${g.away_team} @ ${g.home_team}`;
    gameMap[key] = g.confidence;
  }

  // 4. Match each bet to its game
  let matched = 0, unmatched = 0, unchanged = 0;
  const updates = [];

  for (const bet of bets) {
    // Normalize matchup — bets sometimes have ↗ suffix
    const matchup = (bet.matchup || '').replace('↗', '').trim();
    const key = `${bet.game_date}|${matchup}`;
    const newConf = gameMap[key];

    if (!newConf) {
      unmatched++;
      continue;
    }
    if (newConf === bet.confidence) {
      unchanged++;
      continue;
    }
    matched++;
    updates.push({ id: bet.id, confidence: newConf, oldConf: bet.confidence, matchup, game_date: bet.game_date });
  }

  console.log(`\nMatched: ${matched} | Unchanged: ${unchanged} | No game found: ${unmatched}`);

  if (!updates.length) {
    console.log('Nothing to update.');
    return;
  }

  // Preview
  console.log('\nSample changes (first 20):');
  console.log('Date'.padEnd(12) + ' ' + 'Matchup'.padEnd(44) + ' ' + 'Old'.padEnd(8) + ' New');
  console.log('-'.repeat(78));
  for (const u of updates.slice(0, 20)) {
    console.log(`${u.game_date.padEnd(12)} ${u.matchup.slice(0, 42).padEnd(44)} ${(u.oldConf||'null').padEnd(8)} ${u.confidence}`);
  }

  // Tally
  const tally = {};
  for (const u of updates) {
    const key = `${u.oldConf||'null'} → ${u.confidence}`;
    tally[key] = (tally[key] || 0) + 1;
  }
  console.log('\nChange summary:');
  for (const [k, v] of Object.entries(tally).sort()) {
    console.log(`  ${k}: ${v} bets`);
  }

  // Apply in batches of 50
  console.log('\nApplying updates…');
  let done = 0;
  const BATCH = 50;

  for (let i = 0; i < updates.length; i += BATCH) {
    const slice = updates.slice(i, i + BATCH);
    await Promise.all(slice.map(u =>
      fetch(`${SUPABASE_URL}/rest/v1/mlb_bets?id=eq.${u.id}`, {
        method: 'PATCH',
        headers: { ...headers, Prefer: 'return=minimal' },
        body: JSON.stringify({ confidence: u.confidence })
      }).then(r => {
        if (!r.ok) console.error(`  Failed to update bet ${u.id}:`, r.status);
      })
    ));
    done += slice.length;
    console.log(`  Updated ${done}/${updates.length}…`);
  }

  console.log(`\n✓ Done. ${done} bets updated.`);
}

run().catch(e => { console.error(e); process.exit(1); });
