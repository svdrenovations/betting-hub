/**
 * kalshi-dryrun.js  —  $0 dry-run price tester for the MLB model.
 *
 * WHAT IT DOES
 *   For each analyzed game on a slate, it looks up the matching Kalshi single-game
 *   moneyline market (series KXMLBGAME), reads the current price, and records what the
 *   model WOULD have done — the Kalshi implied probability, the model's probability, and
 *   the EV you'd have had at the Kalshi price — into a Supabase table (kalshi_paper).
 *   It then settles those paper entries against final scores. No money is ever at stake.
 *
 * WHY IT IS $0 BY CONSTRUCTION (not by good behaviour)
 *   - It calls ONLY Kalshi's public, unauthenticated market-data endpoints (GET /markets,
 *     GET /markets/{ticker}/orderbook). Those need no API key.
 *   - It holds NO Kalshi credentials and imports NO signing code, so it cannot authenticate.
 *   - It contains NO reference to the orders endpoint. Placing a trade is therefore not a
 *     thing this file is capable of doing. Read-only, full stop.
 *
 * COVERAGE
 *   Kalshi lists MLB moneyline under series KXMLBGAME, and run lines / game totals under their
 *   OWN separate series. The `discover` command sweeps the whole MLB family and reports every
 *   series it finds, so we can wire the run-line and total series in by their real tickers.
 *
 * USAGE (in GitHub Actions, after analyze.js writes the slate to Supabase)
 *   node kalshi-dryrun.js discover [YYYY-MM-DD]   # dump Kalshi MLB markets to calibrate matching
 *   node kalshi-dryrun.js run      [YYYY-MM-DD]   # log paper entries for the slate
 *   node kalshi-dryrun.js settle   [YYYY-MM-DD]   # grade logged paper entries vs final scores
 *   (date defaults to today, US/Eastern)
 *
 * ENV
 *   SUPABASE_URL, SUPABASE_KEY      (same project as the rest of the pipeline)
 *   KALSHI_BASE (optional)          override the base URL if Kalshi changes it
 *   No KALSHI key/secret is read anywhere — intentionally.
 */

'use strict';

// ---------- config ----------
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
// Public read base. If a request 404s/refuses, confirm the current base at docs.kalshi.com and
// set KALSHI_BASE. The discover command will surface a bad base immediately.
const KALSHI_BASE = process.env.KALSHI_BASE || 'https://api.elections.kalshi.com/trade-api/v2';
const MLB_SERIES  = 'KXMLBGAME';   // confirmed single-game MLB moneyline series
// Candidate read bases — discovery tries each until one returns MLB markets, then reports the winner.
const KALSHI_BASES = [...new Set([
  KALSHI_BASE,
  'https://api.elections.kalshi.com/trade-api/v2',
  'https://api.kalshi.com/trade-api/v2',
  'https://trading-api.kalshi.com/trade-api/v2',
  'https://external-api.kalshi.com/trade-api/v2'
])];
const FEE_PER_CONTRACT = 0.02;     // Kalshi's $0.02/contract execution fee — used only in paper PnL
const NOTIONAL = 100;              // contracts a 1u play would represent, for depth/PnL display only

if (!SUPABASE_URL || !SUPABASE_KEY) { /* only run/settle need Supabase; checked in those commands */ }
function requireSupabase() {
  if (!SUPABASE_URL || !SUPABASE_KEY) { console.error('Missing SUPABASE_URL / SUPABASE_KEY env'); process.exit(1); }
}

// ---------- tiny helpers ----------
const sleep = ms => new Promise(r => setTimeout(r, ms));

function etDateStr(d = new Date()) {
  // YYYY-MM-DD in US/Eastern, matching how the slate is keyed elsewhere
  const p = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year:'numeric', month:'2-digit', day:'2-digit' }).formatToParts(d);
  const g = t => p.find(x => x.type === t).value;
  return `${g('year')}-${g('month')}-${g('day')}`;
}

function americanToDecimal(a) {
  a = Number(a);
  if (!a || isNaN(a)) return null;
  return a > 0 ? 1 + a / 100 : 1 + 100 / Math.abs(a);
}

// normalize a team string to a matchable token (last word handles "Red Sox"->"sox" etc. via full compare)
function teamTokens(s) {
  return String(s || '').toLowerCase().replace(/[^a-z ]/g, '').split(/\s+/).filter(Boolean);
}
function teamsMatch(modelTeam, kalshiText) {
  const mt = teamTokens(modelTeam);
  const kt = new Set(teamTokens(kalshiText));
  // match if the model team's nickname (last token) or city token appears in the kalshi text
  return mt.some(tok => tok.length >= 3 && kt.has(tok));
}

// ---------- Supabase (REST) ----------
async function supaGet(path) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` }
  });
  if (!res.ok) throw new Error(`Supabase GET ${path} -> ${res.status}`);
  return res.json();
}
async function supaUpsert(table, rows, onConflict) {
  if (!rows.length) return;
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}?on_conflict=${onConflict}`, {
    method: 'POST',
    headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`,
               'Content-Type': 'application/json', Prefer: 'resolution=merge-duplicates,return=minimal' },
    body: JSON.stringify(rows)
  });
  if (!res.ok) throw new Error(`Supabase upsert ${table} -> ${res.status} ${await res.text()}`);
}
async function supaPatch(table, query, body) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}?${query}`, {
    method: 'PATCH',
    headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`,
               'Content-Type': 'application/json', Prefer: 'return=minimal' },
    body: JSON.stringify(body)
  });
  if (!res.ok) throw new Error(`Supabase PATCH ${table} -> ${res.status}`);
}

// ---------- Kalshi (READ ONLY — public endpoints, no auth) ----------
async function kGet(path) {
  const res = await fetch(`${KALSHI_BASE}${path}`, { headers: { Accept: 'application/json' } });
  if (res.status === 429) { await sleep(1500); return kGet(path); }   // simple backoff
  if (!res.ok) throw new Error(`Kalshi GET ${path} -> ${res.status}`);
  return res.json();
}
// same, against an explicit base (discovery tries several to find the one serving MLB markets)
async function kGetBase(base, path) {
  const res = await fetch(`${base}${path}`, { headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error(String(res.status));
  return res.json();
}

// pull all open single-game MLB markets (paginated)
async function kalshiMlbMarkets() {
  const out = [];
  let cursor = '';
  do {
    const q = `?series_ticker=${MLB_SERIES}&status=open&limit=200${cursor ? `&cursor=${cursor}` : ''}`;
    const data = await kGet(`/markets${q}`);
    for (const m of (data.markets || [])) out.push(m);
    cursor = data.cursor || '';
  } while (cursor);
  return out;
}

// ---------- model side: derive the slate's ML plays from mlb_games ----------
function parseVerdictSide(verdict) {
  // ml_verdict looks like "BET away" / "LEAN home" / "SKIP" — return 'away'|'home'|null
  const m = String(verdict || '').toLowerCase().match(/\b(away|home)\b/);
  return m ? m[1] : null;
}

async function loadMlPlays(date) {
  const cols = 'game_date,away_team,home_team,game_pk,ml_verdict,ml_ev,away_ml,home_ml,away_final,home_final,' +
               'rl_verdict,total_verdict';
  const games = await supaGet(`mlb_games?select=${cols}&game_date=eq.${date}`);
  const plays = [];
  let unsupported = 0;
  for (const g of games) {
    // count RL/total recommendations that have no Kalshi market, for coverage reporting
    if (parseVerdictSide(g.rl_verdict)) unsupported++;
    if (String(g.total_verdict || '').toLowerCase().match(/over|under/)) unsupported++;

    const side = parseVerdictSide(g.ml_verdict);
    if (!side) continue;
    const team   = side === 'away' ? g.away_team : g.home_team;
    const sbOdds = side === 'away' ? g.away_ml   : g.home_ml;
    const dec    = americanToDecimal(sbOdds);
    const ev     = parseFloat(g.ml_ev);
    // model win prob implied by its EV at the sportsbook price:  EV% = p*dec - 1
    const modelProb = (dec && !isNaN(ev)) ? Math.max(0, Math.min(1, (ev / 100 + 1) / dec)) : null;
    plays.push({
      date: g.game_date, matchup: `${g.away_team} @ ${g.home_team}`, game_pk: g.game_pk,
      side, team, away_team: g.away_team, home_team: g.home_team,
      sbOdds, modelProb, sbEv: isNaN(ev) ? null : ev,
      away_final: g.away_final, home_final: g.home_final
    });
  }
  return { plays, unsupported };
}

// pick the Kalshi market whose YES outcome = the model's team, for the right game
function matchMarket(play, markets) {
  // candidate markets mentioning BOTH teams in the game (so we pick the right game), then the
  // one whose YES side text names the model's team.
  const cands = markets.filter(m => {
    const text = `${m.title || ''} ${m.yes_sub_title || ''} ${m.subtitle || ''} ${m.event_ticker || ''}`;
    return teamsMatch(play.away_team, text) && teamsMatch(play.home_team, text);
  });
  for (const m of cands) {
    const yesText = `${m.yes_sub_title || ''} ${m.title || ''}`;
    if (teamsMatch(play.team, yesText)) return { market: m, yesIsTeam: true };
  }
  // fall back: a market for this game where YES names the OTHER team -> we'd take NO
  if (cands.length) return { market: cands[0], yesIsTeam: false };
  return null;
}

// ---------- commands ----------
async function cmdDiscover(arg) {
  const base = 'https://api.elections.kalshi.com/trade-api/v2';   // confirmed working
  console.log('Kalshi MLB line discovery — read-only\n');

  // today's event date token, e.g. "26JUN19" (Kalshi encodes it in the event ticker)
  const P = new Intl.DateTimeFormat('en-US', { timeZone:'America/New_York', year:'2-digit', month:'short', day:'2-digit' }).formatToParts(new Date());
  const token = `${P.find(p=>p.type==='year').value}${P.find(p=>p.type==='month').value.toUpperCase()}${P.find(p=>p.type==='day').value}`;
  console.log(`today (ET) token: ${token}`);

  // optional override: node kalshi-dryrun.js discover KXMLBGAME-26JUN192040PITCOL
  let targetEvent = (arg && /^KXMLB/i.test(arg)) ? arg : null;
  if (!targetEvent) {
    const events = new Set();
    let cursor = '', pages = 0;
    do {
      const d = await kGetBase(base, `/markets?series_ticker=KXMLBGAME&limit=200${cursor ? `&cursor=${cursor}` : ''}`);
      for (const m of (d.markets || [])) if ((m.event_ticker || '').includes(token)) events.add(m.event_ticker);
      cursor = d.cursor || ''; pages++;
    } while (cursor && pages < 12 && !events.size);
    targetEvent = [...events][0] || null;
    console.log(`today's KXMLBGAME events found: ${events.size}`);
    if (!targetEvent) {                       // fallback: just take the first event available
      const d = await kGetBase(base, `/markets?series_ticker=KXMLBGAME&limit=1`);
      targetEvent = ((d.markets || [])[0] || {}).event_ticker || null;
    }
  }
  if (!targetEvent) { console.log('No event to inspect — paste this back.'); return; }
  console.log(`inspecting event: ${targetEvent}\n`);

  const dump = (m) => `   series=${m.series_ticker || (m.ticker || '').split('-')[0]}  ${m.ticker}\n      title="${m.title || ''}"  yes_sub="${m.yes_sub_title || ''}"  sub="${m.subtitle || ''}"  bid/ask=${m.yes_bid}/${m.yes_ask}`;

  // all markets nested under this game's event — for a same-day game this should include RL + total
  let nested = [];
  try {
    const d = await kGetBase(base, `/events/${targetEvent}?with_nested_markets=true`);
    nested = (d.event && d.event.markets) || d.markets || [];
    console.log(`== ${nested.length} markets nested under ${targetEvent} ==`);
    nested.forEach(m => console.log(dump(m)));
  } catch (e) { console.log('event fetch error ' + e.message); }

  // if still only the two winner markets, the run line / total are separate events — probe parallels
  if (nested.length <= 2) {
    const suffix = targetEvent.replace(/^KXMLBGAME/, '');
    console.log('\n(only winner markets here — probing parallel events for run line / total)');
    for (const p of ['KXMLBSPREAD','KXMLBRUNLINE','KXMLBRL','KXMLBGAMESPREAD','KXMLBGAMERUNLINE','KXMLBGAMERL','KXMLBMARGIN','KXMLBTOTAL','KXMLBTOTALRUNS','KXMLBGAMETOTAL','KXMLBRUNS','KXMLBGAMERUNS','KXMLBOU','KXMLBSCORE']) {
      const et = p + suffix;
      try {
        const d = await kGetBase(base, `/events/${et}?with_nested_markets=true`);
        const ms = (d.event && d.event.markets) || d.markets || [];
        if (ms.length) { console.log(`   FOUND ${et} -> ${ms.length} markets`); ms.slice(0, 6).forEach(m => console.log(dump(m))); }
      } catch (e) {}
    }
  }
  console.log('\nPaste all of this back.');
}

async function cmdRun(date) {
  requireSupabase();
  const { plays, unsupported } = await loadMlPlays(date);
  if (!plays.length) { console.log(`No ML plays for ${date}.`); return; }
  const markets = await kalshiMlbMarkets();
  console.log(`${date}: ${plays.length} ML plays | ${markets.length} open Kalshi MLB markets | ${unsupported} RL/Total plays unsupported on Kalshi`);

  const rows = [];
  let matched = 0, unmatched = [];
  for (const p of plays) {
    const hit = matchMarket(p, markets);
    if (!hit) { unmatched.push(p.matchup + ' (' + p.team + ')'); continue; }
    const m = hit.market;
    // price to BACK the model's team:
    //   YES is the team  -> buy YES at yes_ask
    //   YES is the other -> back our team = buy NO = (100 - yes_bid_of_other)... use no_ask if present
    let entryCents = hit.yesIsTeam ? Number(m.yes_ask) : Number(m.no_ask != null ? m.no_ask : (100 - m.yes_bid));
    if (!entryCents || entryCents <= 0 || entryCents >= 100) { unmatched.push(p.matchup + ' (no price)'); continue; }
    const kImplied = entryCents / 100;
    const kDec = 100 / entryCents;
    const kEv = (p.modelProb != null) ? (p.modelProb * kDec - 1) * 100 : null;
    rows.push({
      game_date: p.date, matchup: p.matchup, game_pk: p.game_pk, market: 'ML',
      side: p.side, team: p.team, kalshi_ticker: m.ticker, kalshi_yes_is_team: hit.yesIsTeam,
      entry_cents: entryCents, kalshi_implied: +kImplied.toFixed(4),
      model_prob: p.modelProb != null ? +p.modelProb.toFixed(4) : null,
      sb_ev: p.sbEv, kalshi_ev: kEv != null ? +kEv.toFixed(2) : null,
      kalshi_volume: m.volume ?? null, result: 'pending', captured_at: new Date().toISOString()
    });
    matched++;
  }
  await supaUpsert('kalshi_paper', rows, 'game_date,matchup,side');
  console.log(`logged ${matched} paper entries; unmatched: ${unmatched.length}`);
  if (unmatched.length) console.log('  ' + unmatched.join('\n  '));
  // quick read of where the model and Kalshi disagree most
  rows.sort((a,b)=>(b.kalshi_ev??-99)-(a.kalshi_ev??-99));
  console.log('\ntop model-vs-Kalshi edges (EV at Kalshi price):');
  for (const r of rows.slice(0,8)) console.log(`  ${r.matchup}  ${r.team}  Kalshi ${Math.round(r.entry_cents)}c (${(r.kalshi_implied*100).toFixed(0)}%)  model ${(r.model_prob*100).toFixed(0)}%  EV ${r.kalshi_ev}%`);
}

async function cmdSettle(date) {
  requireSupabase();
  const rows = await supaGet(`kalshi_paper?select=*&game_date=eq.${date}&result=eq.pending`);
  if (!rows.length) { console.log(`Nothing pending to settle for ${date}.`); return; }
  const games = await supaGet(`mlb_games?select=away_team,home_team,away_final,home_final&game_date=eq.${date}`);
  const fin = {};
  for (const g of games) if (g.away_final != null && g.home_final != null)
    fin[`${g.away_team} @ ${g.home_team}`] = (g.away_final > g.home_final) ? 'away' : 'home';

  let done = 0;
  for (const r of rows) {
    const winSide = fin[r.matchup];
    if (!winSide) continue;                 // game not final yet
    const won = (winSide === r.side);
    // paper PnL per contract at the entry price, minus the per-contract fee
    const c = r.entry_cents / 100;
    const pl = (won ? (1 - c) : -c) - FEE_PER_CONTRACT;
    await supaPatch('kalshi_paper', `game_date=eq.${date}&matchup=eq.${encodeURIComponent(r.matchup)}&side=eq.${r.side}`,
      { result: won ? 'win' : 'loss', paper_pl_per_contract: +pl.toFixed(4), settled_at: new Date().toISOString() });
    done++;
  }
  console.log(`settled ${done} paper entries for ${date}.`);
}

// ---------- entry ----------
(async () => {
  const cmd  = (process.argv[2] || 'run').toLowerCase();
  const date = process.argv[3] || etDateStr();
  try {
    if (cmd === 'discover')      await cmdDiscover(date);
    else if (cmd === 'run')      await cmdRun(date);
    else if (cmd === 'settle')   await cmdSettle(date);
    else { console.error(`unknown command "${cmd}"`); process.exit(1); }
  } catch (e) {
    console.error('error:', e.message);
    process.exit(1);
  }
})();
