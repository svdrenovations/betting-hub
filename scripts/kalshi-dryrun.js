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
const MLB_SERIES  = 'KXMLBGAME';   // single-game MLB winner series (run line = KXMLBSPREAD, total = KXMLBTOTAL)
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


// ---------- model side: load ML / RL / total plays from mlb_games ----------
function parseVerdictSide(verdict) {
  const m = String(verdict || '').toLowerCase().match(/\b(away|home)\b/);
  return m ? m[1] : null;
}
function num(v) { const n = parseFloat(v); return isNaN(n) ? null : n; }
function probFromEv(ev, americanOdds) {
  const dec = americanToDecimal(americanOdds), e = num(ev);
  return (dec && e != null) ? Math.max(0, Math.min(1, (e / 100 + 1) / dec)) : null;   // EV% = p*dec - 1
}

async function loadPlays(date) {
  const cols = ['game_date','away_team','home_team','game_pk',
    'ml_verdict','ml_ev','away_ml','home_ml',
    'rl_verdict','rl_ev','away_rl','home_rl','away_rl_odds','home_rl_odds',
    'total_verdict','total_ev','total_line','over_odds','under_odds',
    'away_final','home_final'].join(',');
  const games = await supaGet(`mlb_games?select=${cols}&game_date=eq.${date}`);
  const plays = [];
  for (const g of games) {
    const base = { date:g.game_date, matchup:`${g.away_team} @ ${g.home_team}`, game_pk:g.game_pk,
                   away_team:g.away_team, home_team:g.home_team, away_final:g.away_final, home_final:g.home_final };
    const ml = parseVerdictSide(g.ml_verdict);
    if (ml) plays.push({ ...base, market:'ML', side:ml, team: ml==='away'?g.away_team:g.home_team,
      line:null, sbEv:num(g.ml_ev), modelProb:probFromEv(g.ml_ev, ml==='away'?g.away_ml:g.home_ml) });
    const rl = parseVerdictSide(g.rl_verdict);
    if (rl) plays.push({ ...base, market:'RL', side:rl, team: rl==='away'?g.away_team:g.home_team,
      line:num(rl==='away'?g.away_rl:g.home_rl), sbEv:num(g.rl_ev),
      modelProb:probFromEv(g.rl_ev, rl==='away'?g.away_rl_odds:g.home_rl_odds) });
    const tv = String(g.total_verdict||'').toLowerCase();
    const ts = tv.includes('over')?'over':tv.includes('under')?'under':null;
    if (ts) plays.push({ ...base, market:'total', side:ts, team:null, line:num(g.total_line),
      sbEv:num(g.total_ev), modelProb:probFromEv(g.total_ev, ts==='over'?g.over_odds:g.under_odds) });
  }
  return plays;
}

// ---------- map a play to its exact Kalshi contract ----------
// Build {eventBase -> [{code, city}]} for the date's games from the winner series.
async function buildEventMap(date) {
  const d0 = new Date(date + 'T12:00:00-04:00');
  const P = new Intl.DateTimeFormat('en-US', { timeZone:'America/New_York', year:'2-digit', month:'short', day:'2-digit' }).formatToParts(d0);
  const token = `${P.find(p=>p.type==='year').value}${P.find(p=>p.type==='month').value.toUpperCase()}${P.find(p=>p.type==='day').value}`;
  const evs = {};
  let cursor = '', pages = 0;
  do {
    const d = await kGet(`/markets?series_ticker=KXMLBGAME&limit=200${cursor ? `&cursor=${cursor}` : ''}`);
    for (const m of (d.markets || [])) {
      const eb = m.event_ticker || '';
      if (!eb.includes(token)) continue;
      (evs[eb] = evs[eb] || []).push({ code: (m.ticker || '').split('-').pop(), city: m.yes_sub_title || '' });
    }
    cursor = d.cursor || ''; pages++;
  } while (cursor && pages < 12);
  return evs;
}
// Kalshi team codes (from live discovery) — match on these, not the truncated city text.
const TEAM_CODE = {
  'arizona diamondbacks':'AZ','atlanta braves':'ATL','baltimore orioles':'BAL','boston red sox':'BOS',
  'chicago cubs':'CHC','chicago white sox':'CWS','cincinnati reds':'CIN','cleveland guardians':'CLE',
  'colorado rockies':'COL','detroit tigers':'DET','houston astros':'HOU','kansas city royals':'KC',
  'los angeles angels':'LAA','los angeles dodgers':'LAD','miami marlins':'MIA','milwaukee brewers':'MIL',
  'minnesota twins':'MIN','new york mets':'NYM','new york yankees':'NYY','athletics':'ATH',
  'philadelphia phillies':'PHI','pittsburgh pirates':'PIT','san diego padres':'SD','san francisco giants':'SF',
  'seattle mariners':'SEA','st. louis cardinals':'STL','tampa bay rays':'TB','texas rangers':'TEX',
  'toronto blue jays':'TOR','washington nationals':'WSH'
};
function codeFor(teamName) {
  const k = String(teamName || '').toLowerCase().trim();
  if (TEAM_CODE[k]) return TEAM_CODE[k];
  for (const [name, code] of Object.entries(TEAM_CODE)) if (k.includes(name) || name.includes(k)) return code;
  return null;
}
function resolveGame(play, evs) {
  const aCode = codeFor(play.away_team), hCode = codeFor(play.home_team);
  if (!aCode || !hCode) return null;
  for (const [eb, teams] of Object.entries(evs)) {
    const codes = teams.map(t => t.code);
    if (codes.includes(aCode) && codes.includes(hCode)) return { eventBase: eb, awayCode: aCode, homeCode: hCode };
  }
  return null;
}
// Build the exact market ticker + which side to buy (yes/no).
function resolveMarket(play, game) {
  const eb = game.eventBase;
  const myCode  = play.side === 'away' ? game.awayCode : game.homeCode;
  const oppCode = play.side === 'away' ? game.homeCode : game.awayCode;
  if (play.market === 'ML')  return { ticker: `${eb}-${myCode}`, action: 'yes' };
  if (play.market === 'RL') {
    const sp = eb.replace('KXMLBGAME', 'KXMLBSPREAD');
    const N = Math.round(Math.abs(play.line) + 0.5);                 // 1.5 -> 2 ("wins by over 1.5")
    return (play.line < 0)
      ? { ticker: `${sp}-${myCode}${N}`,  action: 'yes' }            // favorite -1.5: team wins by over 1.5
      : { ticker: `${sp}-${oppCode}${N}`, action: 'no'  };           // dog +1.5: NO on favorite covering
  }
  if (play.market === 'total') {
    const tt = eb.replace('KXMLBGAME', 'KXMLBTOTAL');
    const N = Math.round(play.line + 0.5);                           // 8.5 -> 9 ("Over 8.5")
    return { ticker: `${tt}-${N}`, action: play.side === 'over' ? 'yes' : 'no' };
  }
  return null;
}
// Price (in cents) to BUY the side we want, from the live market object.
async function fetchPrice(ticker, action) {
  try {
    const d = await kGet(`/markets/${ticker}`);
    const m = d.market || d;
    const toC = (v) => { const n = num(v); return n == null ? null : Math.round(n * 100); };   // "0.5100" -> 51
    // price to BUY our side = that side's ask
    let cents = action === 'yes' ? toC(m.yes_ask_dollars) : toC(m.no_ask_dollars);
    if (cents == null) {                       // derive from the complementary bid
      if (action === 'yes') { const nb = toC(m.no_bid_dollars);  if (nb != null) cents = 100 - nb; }
      else                  { const yb = toC(m.yes_bid_dollars); if (yb != null) cents = 100 - yb; }
    }
    if (cents == null) {                       // last resort: cross the live orderbook (prices in dollars)
      try {
        const ob = await kGet(`/markets/${ticker}/orderbook`);
        const book = ob.orderbook_fp || ob.orderbook || ob;
        const bestC = (a) => (a && a.length) ? Math.round(Math.max(...a.map(x => parseFloat(Array.isArray(x) ? x[0] : x))) * 100) : null;
        if (action === 'yes') { const nb = bestC(book.no_dollars  || book.no);  if (nb != null) cents = 100 - nb; }
        else                  { const yb = bestC(book.yes_dollars || book.yes); if (yb != null) cents = 100 - yb; }
      } catch (e) {}
    }
    const volume = num(m.volume_fp) ?? num(m.volume_24h_fp) ?? num(m.volume) ?? null;
    return { cents, volume, last: toC(m.last_price_dollars), status: m.status };
  } catch (e) { return { cents: null, error: e.message }; }
}

// Scheduled first pitch (ms) parsed from the event ticker's ET time token, e.g. KXMLBGAME-26JUN19'2210'BOSSEA.
// June is EDT (UTC-4). Returns null if it can't parse.
function gameStartMs(eventBase, dateStr) {
  const body = String(eventBase || '').replace(/^KX[A-Z]+-/, '');   // strip the series prefix
  const hhmm = body.slice(7, 11);                                   // 7-char date token, then HHMM
  if (!/^\d{4}$/.test(hhmm)) return null;
  const t = Date.parse(`${dateStr}T${hhmm.slice(0,2)}:${hhmm.slice(2,4)}:00-04:00`);
  return isNaN(t) ? null : t;
}

// Resolve the whole slate to Kalshi markets + prices + EV-at-Kalshi (shared by test and run).
async function resolveSlate(date) {
  const plays = await loadPlays(date);
  const evs = await buildEventMap(date);
  const out = [];
  for (const p of plays) {
    const game = resolveGame(p, evs);
    if (!game) { out.push({ ...p, status: 'no Kalshi event' }); continue; }
    const mk = resolveMarket(p, game);
    if (!mk) { out.push({ ...p, status: 'no mapping' }); continue; }
    const pr = await fetchPrice(mk.ticker, mk.action);
    let kImplied = null, kEv = null;
    if (pr.cents != null && p.modelProb != null) { kImplied = pr.cents / 100; kEv = (p.modelProb * (100 / pr.cents) - 1) * 100; }
    const startMs = gameStartMs(game.eventBase, p.date);
    const started = startMs != null && Date.now() >= startMs;     // first pitch already happened?
    const active  = pr.status ? (pr.status === 'active') : true;
    const st = started ? 'started'
             : pr.cents == null ? (pr.error ? 'price err' : 'no price yet')
             : (active ? 'ok' : 'closed');
    out.push({ ...p, kalshi_ticker: mk.ticker, action: mk.action, entry_cents: pr.cents,
      kalshi_implied: kImplied != null ? +kImplied.toFixed(4) : null,
      kalshi_ev: kEv != null ? +kEv.toFixed(2) : null, kalshi_volume: pr.volume ?? null, status: st });
  }
  return out;
}

// ---------- commands ----------
async function cmdRun(date) {
  requireSupabase();
  const res = await resolveSlate(date);
  const rows = res.filter(r => r.status === 'ok').map(r => ({
    game_date:r.date, matchup:r.matchup, game_pk:r.game_pk, market:r.market, side:r.side, team:r.team, line:r.line,
    kalshi_ticker:r.kalshi_ticker, action:r.action, entry_cents:r.entry_cents, kalshi_implied:r.kalshi_implied,
    model_prob: r.modelProb != null ? +r.modelProb.toFixed(4) : null, sb_ev:r.sbEv, kalshi_ev:r.kalshi_ev,
    kalshi_volume:r.kalshi_volume, result:'pending', captured_at:new Date().toISOString()
  }));
  await supaUpsert('kalshi_paper', rows, 'game_date,matchup,market,side');
  console.log(`${date}: logged ${rows.length} paper entries (of ${res.length} plays).`);
  const skip = res.filter(r => r.status !== 'ok');
  if (skip.length) console.log('not logged:\n  ' + skip.map(r => `${r.market} ${r.matchup} ${r.side} [${r.status}]`).join('\n  '));
}

// Same resolution as run, but writes NOTHING — just prints, so you can verify mapping + prices.
async function cmdTest(date) {
  requireSupabase();                 // reads mlb_games only
  const res = await resolveSlate(date);
  const ok = res.filter(r => r.status === 'ok');
  console.log(`${date}: ${res.length} plays resolved, ${ok.length} pre-game & priced (loggable) — DRY READ, nothing written\n`);
  for (const r of res) {
    const px = r.entry_cents != null ? `${Math.round(r.entry_cents)}c` : '--';
    const ev = r.kalshi_ev != null ? `${r.kalshi_ev > 0 ? '+' : ''}${r.kalshi_ev}%` : '';
    const desc = `${r.market.padEnd(5)} ${r.matchup}  ${r.side}${r.team ? ' ' + r.team : ''}${r.line != null ? ' ' + r.line : ''}`;
    console.log(`  ${desc}\n        -> ${r.kalshi_ticker || ''}  ${r.action || ''} ${px} ${ev}  [${r.status}]`);
  }
  console.log('\nDry read only — nothing logged. If the tickers and prices look right, say so and I\'ll switch on logging.');
  if (res.some(r => r.status === 'no Kalshi event')) {
    console.log('\nUnmatched game(s) — today\'s Kalshi events + team names (to fix the alias):');
    const evs = await buildEventMap(date);
    for (const [eb, teams] of Object.entries(evs)) console.log(`   ${eb}  [${teams.map(t => `${t.code}:${t.city}`).join('  ,  ')}]`);
  }
}

// debug: dump the raw market object + live orderbook for one ticker (to find the price fields)
async function cmdPrice(ticker) {
  if (!ticker || !/^KXMLB/i.test(ticker)) { console.log('usage: price <KXMLB...-ticker>'); return; }
  console.log(`raw Kalshi data for ${ticker}\n`);
  try { const m  = await kGet(`/markets/${ticker}`);           console.log('--- /markets/<ticker> ---\n' + JSON.stringify(m,  null, 2).slice(0, 2600)); }
  catch (e) { console.log('market fetch error: ' + e.message); }
  try { const ob = await kGet(`/markets/${ticker}/orderbook`); console.log('\n--- /markets/<ticker>/orderbook ---\n' + JSON.stringify(ob, null, 2).slice(0, 1800)); }
  catch (e) { console.log('orderbook fetch error: ' + e.message); }
}

async function cmdSettle(date) {
  requireSupabase();
  const rows = await supaGet(`kalshi_paper?select=*&game_date=eq.${date}&result=eq.pending`);
  if (!rows.length) { console.log(`Nothing pending to settle for ${date}.`); return; }
  const games = await supaGet(`mlb_games?select=away_team,home_team,away_final,home_final&game_date=eq.${date}`);
  const fin = {};
  for (const g of games) if (g.away_final != null && g.home_final != null)
    fin[`${g.away_team} @ ${g.home_team}`] = { a: g.away_final, h: g.home_final };

  let done = 0;
  for (const r of rows) {
    const f = fin[r.matchup]; if (!f) continue;            // not final yet
    let won;
    if (r.market === 'ML')      won = ((f.a > f.h ? 'away' : 'home') === r.side);
    else if (r.market === 'RL') won = (((r.side === 'away' ? f.a - f.h : f.h - f.a) + Number(r.line)) > 0);
    else                        won = (r.side === 'over' ? (f.a + f.h > Number(r.line)) : (f.a + f.h < Number(r.line)));
    const c = r.entry_cents / 100;
    const pl = (won ? (1 - c) : -c) - FEE_PER_CONTRACT;
    await supaPatch('kalshi_paper',
      `game_date=eq.${date}&matchup=eq.${encodeURIComponent(r.matchup)}&market=eq.${r.market}&side=eq.${r.side}`,
      { result: won ? 'win' : 'loss', paper_pl_per_contract: +pl.toFixed(4), settled_at: new Date().toISOString() });
    done++;
  }
  console.log(`settled ${done} paper entries for ${date}.`);
}

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

// ---------- entry ----------
(async () => {
  const cmd  = (process.argv[2] || 'test').toLowerCase();
  const date = process.argv[3] || etDateStr();
  try {
    if (cmd === 'discover')    await cmdDiscover(date);
    else if (cmd === 'test')   await cmdTest(date);
    else if (cmd === 'price')  await cmdPrice(date);
    else if (cmd === 'run')    await cmdRun(date);
    else if (cmd === 'settle') await cmdSettle(date);
    else { console.error(`unknown command "${cmd}"`); process.exit(1); }
  } catch (e) {
    console.error('error:', e.message);
    process.exit(1);
  }
})();
