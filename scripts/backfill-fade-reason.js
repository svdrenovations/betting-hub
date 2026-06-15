// ─────────────────────────────────────────────────────────────────────────────
// ONE-OFF BACKFILL: fade_reason for historical games.
//
// Re-reads each PAST game that was tagged "fade" but has no fade_reason yet, hands
// the model its OWN stored analysis (narrative + Statcast) for that game, and asks
// it to classify which fade reason(s) drove it — using the same four values the
// live pipeline now emits: velo, coldarm, contact, form.
//
// It does NOT re-run any analysis, change any verdict, or touch non-fade games.
// It only fills the fade_reason column. Idempotent: a game is processed once
// (fade_reason goes from NULL to a value), so re-running skips anything already done.
//
// Run it from the GitHub Actions tab via the backfill-fade.yml workflow, or locally
// with: ANTHROPIC_API_KEY=... SUPABASE_URL=... SUPABASE_SERVICE_KEY=... node backfill-fade-reason.js
// ─────────────────────────────────────────────────────────────────────────────

const ANTHROPIC_API_KEY    = process.env.ANTHROPIC_API_KEY;
const SUPABASE_URL         = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

const VALID = ['velo', 'coldarm', 'contact', 'form'];
const sleep = ms => new Promise(r => setTimeout(r, ms));

function hasFade(situations) {
  let arr = situations;
  if (typeof arr === 'string') { try { arr = JSON.parse(arr); } catch { arr = arr.split(','); } }
  if (!Array.isArray(arr)) return false;
  return arr.map(s => String(s).toLowerCase().trim()).includes('fade');
}

async function classify(g) {
  const sc = (side, label) => `${label}: velo ${g[side+'_velo'] ?? '?'} (trend ${g[side+'_velo_trend'] ?? '?'}), whiff ${g[side+'_whiff_rate'] ?? '?'}%, barrel ${g[side+'_barrel_rate'] ?? '?'}%, hard-hit ${g[side+'_hard_hit'] ?? '?'}%`;
  const prompt = `You previously analyzed this MLB game and tagged it as a "fade". Using ONLY the stored analysis below, identify which specific reason(s) drove that fade.

GAME: ${g.away_team} @ ${g.home_team} (${g.game_date})
Pitchers: ${g.away_pitcher || '?'} (away) vs ${g.home_pitcher || '?'} (home)
${sc('away','Away starter')}
${sc('home','Home starter')}
Lineup OPS vs starter — away ${g.away_lineup_ops ?? '?'}, home ${g.home_lineup_ops ?? '?'}

Your original notes:
- Situation: ${g.situation_text || '—'}
- Key factors: ${g.factors_text || '—'}
- Risks: ${g.risks_text || '—'}
- Pitcher edge: ${g.pitcher_edge || '—'}
- Line note: ${g.line_note || '—'}

Classify the fade using ONLY these values:
- velo    — a starter's velocity is trending DOWN vs his season baseline
- coldarm — a starter's recent ERA is worse than his season ERA (trending cold by results)
- contact — a starter's contact quality is poor (hard-hit >=42%, or high barrel / low whiff) regardless of ERA
- form    — a TEAM is in poor recent form (about 2-8 or worse in its last 10)

Multiple may apply. Pick only the ones clearly supported by the stored analysis above; do not invent a reason that isn't reflected in the notes/Statcast.

Return ONLY this JSON, nothing else: {"fadeReason": ["..."]}  (empty array if none of the four clearly applies)`;

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: 'claude-sonnet-4-5', max_tokens: 200, messages: [{ role: 'user', content: prompt }] })
  });
  if (!res.ok) throw new Error(`anthropic ${res.status}`);
  const data = await res.json();
  let text = (data.content || []).map(c => c.text || '').join('').trim().replace(/```json|```/g, '').trim();
  const parsed = JSON.parse(text);
  const reasons = (parsed.fadeReason || [])
    .map(r => String(r).toLowerCase().trim())
    .filter(r => VALID.includes(r));
  return [...new Set(reasons)];
}

async function main() {
  if (!ANTHROPIC_API_KEY || !SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
    console.error('Missing env: ANTHROPIC_API_KEY / SUPABASE_URL / SUPABASE_SERVICE_KEY'); process.exit(1);
  }
  console.log('Fetching past fade games with no fade_reason...');
  const sel = ['id','game_date','away_team','home_team','away_pitcher','home_pitcher','situations',
    'situation_text','factors_text','risks_text','line_note','pitcher_edge',
    'away_velo','away_velo_trend','away_whiff_rate','away_barrel_rate','away_hard_hit',
    'home_velo','home_velo_trend','home_whiff_rate','home_barrel_rate','home_hard_hit',
    'away_lineup_ops','home_lineup_ops'].join(',');
  const res = await fetch(`${SUPABASE_URL}/rest/v1/mlb_games?analyzed=eq.true&fade_reason=is.null&select=${sel}&limit=5000`, {
    headers: { 'apikey': SUPABASE_SERVICE_KEY, 'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}` }
  });
  if (!res.ok) { console.error('fetch failed', res.status, '(is the fade_reason column added?)'); process.exit(1); }
  const rows = (await res.json()).filter(g => hasFade(g.situations));
  console.log(`${rows.length} fade game(s) to classify.\n`);

  let done = 0, withReason = 0;
  for (const g of rows) {
    try {
      const reasons = await classify(g);
      const value = reasons.join(',');   // '' when none clearly applies (still marks it processed)
      const up = await fetch(`${SUPABASE_URL}/rest/v1/mlb_games?id=eq.${g.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', 'apikey': SUPABASE_SERVICE_KEY, 'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`, 'Prefer': 'return=minimal' },
        body: JSON.stringify({ fade_reason: value })
      });
      if (up.ok) { done++; if (reasons.length) withReason++; console.log(`  ✓ ${g.away_team} @ ${g.home_team} (${g.game_date}) → ${value || '(none)'}`); }
      else console.log(`  ✗ patch failed ${g.away_team} @ ${g.home_team}: ${up.status}`);
    } catch (e) {
      console.log(`  ✗ ${g.away_team} @ ${g.home_team}: ${e.message}`);
    }
    await sleep(1500);   // gentle on the API
  }
  console.log(`\nDone — ${done}/${rows.length} classified, ${withReason} got a specific reason, ${done - withReason} were generic fades.`);
}

main();
