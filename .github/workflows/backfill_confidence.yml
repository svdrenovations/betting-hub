#!/usr/bin/env node
// ── CONFIDENCE BACKFILL ───────────────────────────────────────────────────────
// Recalculates confidence for all historical mlb_games rows using the
// deterministic formula, replacing the old LLM-generated labels.
//
// Run via GitHub Actions or locally:
//   SUPABASE_URL=... SUPABASE_SERVICE_KEY=... node scripts/backfill_confidence.js

const SUPABASE_URL        = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_KEY');
  process.exit(1);
}

// ── DETERMINISTIC CONFIDENCE FORMULA ─────────────────────────────────────────
// Mirrors computeConfidence() in analyze.js exactly.
// Input: a row from mlb_games (fields mapped to analysis/lines shape below)
function computeConfidence(analysis, lines) {
  if (!analysis) return 'LOW';

  let score = 0;

  // 1. Best play EV tier
  const markets = [
    { verdict: analysis.ml,    ev: parseFloat(analysis.mlEV    || 0) },
    { verdict: analysis.rl,    ev: parseFloat(analysis.rlEV    || 0) },
    { verdict: analysis.total, ev: parseFloat(analysis.totalEV || 0) },
  ].filter(m => m.verdict && m.verdict !== 'SKIP' && m.ev >= 6);

  if (!markets.length) return 'LOW';

  const bestEV = Math.max(...markets.map(m => m.ev));

  if      (bestEV >= 20) score += 4;
  else if (bestEV >= 10) score += 3;
  else if (bestEV >= 6)  score += 2;

  // 2. Model / Sim agreement
  const mktKeys = ['ml', 'rl', 'total'];
  let anyAgree = false, anyDisagree = false;

  for (const mkt of mktKeys) {
    const modelV = analysis[mkt];
    const simKey = 'sim' + mkt.charAt(0).toUpperCase() + mkt.slice(1);
    const simV   = analysis[simKey];
    if (!modelV || modelV === 'SKIP') continue;
    if (!simV   || simV   === 'SKIP') continue;
    const modelSide = (modelV.match(/(AWAY|HOME|OVER|UNDER)/) || [])[1];
    const simSide   = (simV.match(  /(AWAY|HOME|OVER|UNDER)/) || [])[1];
    if (!modelSide || !simSide) continue;
    if (modelSide === simSide) anyAgree    = true;
    else                       anyDisagree = true;
  }

  if      (anyAgree && !anyDisagree) score += 3;
  else if (anyAgree)                 score += 1;
  else if (anyDisagree)              score -= 1;

  // 3. Agreed BET bonus
  const bestMkt = [...markets].sort((a, b) => b.ev - a.ev)[0];
  const isBet = bestMkt?.verdict?.startsWith('BET');
  if (isBet && anyAgree && !anyDisagree) score += 1;

  // 4. Situation flags
  const sits = (analysis.situations || []).map(s => (s || '').toLowerCase().trim());
  const sitCount = sits.filter(s =>
    ['revenge', 'travel', 'sharp', 'weather', 'rest', 'series', 'fade'].includes(s)
  ).length;

  if      (sitCount >= 2) score += 2;
  else if (sitCount === 1) score += 1;

  // 5. Big dog penalty
  const bestOdds = (() => {
    const v = bestMkt?.verdict || '';
    if (v.includes('AWAY') && analysis.ml?.includes('AWAY'))  return parseFloat(lines?.awayML      || 0);
    if (v.includes('HOME') && analysis.ml?.includes('HOME'))  return parseFloat(lines?.homeML      || 0);
    if (v.includes('AWAY') && analysis.rl?.includes('AWAY'))  return parseFloat(lines?.awayRLOdds  || 0);
    if (v.includes('HOME') && analysis.rl?.includes('HOME'))  return parseFloat(lines?.homeRLOdds  || 0);
    if (v.includes('OVER'))                                   return parseFloat(lines?.overOdds    || 0);
    if (v.includes('UNDER'))                                  return parseFloat(lines?.underOdds   || 0);
    return null;
  })();

  if      (bestOdds && bestOdds >= 200)  score -= 2;
  else if (bestOdds && bestOdds >= 150)  score -= 1;

  // 6. Under bonus
  const hasUnder = markets.some(m => m.verdict?.includes('UNDER'));
  if (hasUnder) score += 1;

  // Final label
  if (score >= 7) return 'HIGH';
  if (score >= 4) return 'MEDIUM';
  return 'LOW';
}

// ── MAP DB ROW → analysis/lines shape ────────────────────────────────────────
function rowToAnalysis(row) {
  return {
    ml:          row.ml_verdict,
    mlEV:        row.ml_ev,
    rl:          row.rl_verdict,
    rlEV:        row.rl_ev,
    total:       row.total_verdict,
    totalEV:     row.total_ev,
    simMl:       row.sim_ml_verdict,
    simMlEV:     row.sim_ml_ev,
    simRl:       row.sim_rl_verdict,
    simRlEV:     row.sim_rl_ev,
    simTotal:    row.sim_total_verdict,
    simTotalEV:  row.sim_total_ev,
    situations:  row.situations || [],
  };
}

function rowToLines(row) {
  return {
    awayML:     row.away_ml,
    homeML:     row.home_ml,
    awayRLOdds: row.away_rl_odds,
    homeRLOdds: row.home_rl_odds,
    overOdds:   row.over_odds,
    underOdds:  row.under_odds,
  };
}

// ── MAIN ──────────────────────────────────────────────────────────────────────
async function run() {
  console.log('Fetching all analyzed games from Supabase…');

  // Fetch all analyzed games — paginate in batches of 1000
  let allRows = [];
  let offset  = 0;
  const batch = 1000;

  while (true) {
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/mlb_games?analyzed=eq.true&select=id,game_date,away_team,home_team,ml_verdict,ml_ev,rl_verdict,rl_ev,total_verdict,total_ev,sim_ml_verdict,sim_ml_ev,sim_rl_verdict,sim_rl_ev,sim_total_verdict,sim_total_ev,situations,away_ml,home_ml,away_rl_odds,home_rl_odds,over_odds,under_odds,confidence&order=game_date.asc&limit=${batch}&offset=${offset}`,
      { headers: { apikey: SUPABASE_SERVICE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_KEY}` } }
    );
    if (!res.ok) { console.error('Fetch error:', await res.text()); process.exit(1); }
    const rows = await res.json();
    allRows = allRows.concat(rows);
    console.log(`  Fetched ${allRows.length} rows so far…`);
    if (rows.length < batch) break;
    offset += batch;
  }

  console.log(`\nTotal games: ${allRows.length}`);

  // Compute new confidence for each row
  let changed = 0, unchanged = 0, skipped = 0;
  const updates = [];

  for (const row of allRows) {
    const analysis = rowToAnalysis(row);
    const lines    = rowToLines(row);

    // Skip rows with no qualifying plays
    const hasPlay = [row.ml_verdict, row.rl_verdict, row.total_verdict]
      .some(v => v && v !== 'SKIP');
    if (!hasPlay) { skipped++; continue; }

    const newConf = computeConfidence(analysis, lines);
    const oldConf = row.confidence;

    if (newConf !== oldConf) {
      changed++;
      updates.push({ id: row.id, confidence: newConf, oldConf, game_date: row.game_date, matchup: `${row.away_team} @ ${row.home_team}` });
    } else {
      unchanged++;
    }
  }

  console.log(`\nConfidence changes: ${changed} | Unchanged: ${unchanged} | No play: ${skipped}`);

  if (!updates.length) {
    console.log('Nothing to update.');
    return;
  }

  // Preview changes
  console.log('\nSample changes (first 20):');
  console.log('Date'.padEnd(12) + ' ' + 'Matchup'.padEnd(42) + ' ' + 'Old'.padEnd(8) + ' New');
  console.log('-'.repeat(75));
  for (const u of updates.slice(0, 20)) {
    console.log(`${u.game_date.padEnd(12)} ${u.matchup.slice(0, 40).padEnd(42)} ${(u.oldConf||'null').padEnd(8)} ${u.confidence}`);
  }

  // Tally: what's changing to what
  const tally = {};
  for (const u of updates) {
    const key = `${u.oldConf||'null'} → ${u.confidence}`;
    tally[key] = (tally[key] || 0) + 1;
  }
  console.log('\nChange summary:');
  for (const [k, v] of Object.entries(tally).sort()) {
    console.log(`  ${k}: ${v} games`);
  }

  // Apply updates in batches of 50
  console.log('\nApplying updates…');
  let done = 0;
  const BATCH = 50;

  for (let i = 0; i < updates.length; i += BATCH) {
    const slice = updates.slice(i, i + BATCH);
    await Promise.all(slice.map(u =>
      fetch(`${SUPABASE_URL}/rest/v1/mlb_games?id=eq.${u.id}`, {
        method: 'PATCH',
        headers: {
          'Content-Type':  'application/json',
          apikey:          SUPABASE_SERVICE_KEY,
          Authorization:   `Bearer ${SUPABASE_SERVICE_KEY}`,
          Prefer:          'return=minimal'
        },
        body: JSON.stringify({ confidence: u.confidence })
      }).then(r => {
        if (!r.ok) console.error(`  Failed to update ${u.id}:`, r.status);
      })
    ));
    done += slice.length;
    console.log(`  Updated ${done}/${updates.length}…`);
  }

  console.log(`\n✓ Done. ${done} games updated.`);
}

run().catch(e => { console.error(e); process.exit(1); });
