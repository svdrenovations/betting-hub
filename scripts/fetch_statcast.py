"""
fetch_statcast.py
Fetches Statcast data for all active MLB players and caches to Supabase.

Modes:
  --mode=full    (default, run by statcast-daily-cache.yml at 6am ET)
    - Fetches ALL active batters (~750) + today's probable pitchers
    - Saves to Supabase statcast_cache table
    - Runs once per day before lineups are posted

  --mode=pitchers  (run by mlb-analysis.yml before each analysis)
    - Only fetches today's probable pitchers
    - Fast — 18 pitchers takes ~2 minutes
    - Falls back if full cache is stale

Usage:
  python3 scripts/fetch_statcast.py --mode=full
  python3 scripts/fetch_statcast.py --mode=pitchers
"""

import json
import sys
import os
import time
import urllib.request
import urllib.error
from datetime import datetime, timedelta

# Parse mode argument
mode = 'full'
for arg in sys.argv[1:]:
    if arg.startswith('--mode='):
        mode = arg.split('=')[1]

# Supabase config
SUPABASE_URL = os.environ.get('SUPABASE_URL', '')
SUPABASE_KEY = os.environ.get('SUPABASE_SERVICE_KEY', '')

if not SUPABASE_URL or not SUPABASE_KEY:
    print("ERROR: SUPABASE_URL and SUPABASE_SERVICE_KEY required")
    sys.exit(1)

try:
    import pybaseball
    from pybaseball import statcast_pitcher, statcast_batter
    pybaseball.cache.enable()
    print("pybaseball imported successfully")
except ImportError as e:
    print(f"ERROR: pybaseball import failed: {e}")
    sys.exit(1)

season_start = f"{datetime.now().year}-03-01"
today = datetime.now().strftime('%Y-%m-%d')
recent_start = (datetime.now() - timedelta(days=30)).strftime('%Y-%m-%d')

SWING_EVENTS = ['swinging_strike', 'foul', 'hit_into_play', 'foul_tip',
                'swinging_strike_blocked', 'foul_bunt', 'missed_bunt']
WHIFF_EVENTS = ['swinging_strike', 'swinging_strike_blocked']

# ── Supabase helpers ──────────────────────────────────────────────────────────

def supabase_upsert(records):
    """Upsert records to statcast_cache table"""
    if not records:
        return
    url = f"{SUPABASE_URL}/rest/v1/statcast_cache"
    data = json.dumps(records).encode('utf-8')
    req = urllib.request.Request(
        url,
        data=data,
        headers={
            'Content-Type': 'application/json',
            'apikey': SUPABASE_KEY,
            'Authorization': f'Bearer {SUPABASE_KEY}',
            'Prefer': 'resolution=merge-duplicates'
        },
        method='POST'
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return r.status
    except Exception as e:
        print(f"  Supabase upsert error: {e}")
        return None

def supabase_upsert_batch(records, batch_size=50):
    """Upsert in batches to avoid payload limits"""
    total = len(records)
    saved = 0
    for i in range(0, total, batch_size):
        batch = records[i:i+batch_size]
        result = supabase_upsert(batch)
        if result:
            saved += len(batch)
    return saved

# ── MLB Stats API helpers ────────────────────────────────────────────────────

def get_todays_pitchers():
    try:
        url = f"https://statsapi.mlb.com/api/v1/schedule?sportId=1&date={today}&gameType=R&hydrate=probablePitcher"
        with urllib.request.urlopen(url, timeout=10) as r:
            data = json.loads(r.read())
        ids = {}
        for d in data.get('dates', []):
            for g in d.get('games', []):
                for side in ['away', 'home']:
                    p = g.get('teams', {}).get(side, {}).get('probablePitcher', {})
                    if p.get('id'):
                        ids[p['id']] = p.get('fullName', str(p['id']))
        print(f"Found {len(ids)} probable pitchers for {today}")
        return ids
    except Exception as e:
        print(f"Error fetching pitchers: {e}")
        return {}

def get_all_active_batters():
    """Get all active MLB batters from 40-man rosters"""
    try:
        # Fetch all teams
        url = "https://statsapi.mlb.com/api/v1/teams?sportId=1&season=2026"
        with urllib.request.urlopen(url, timeout=10) as r:
            data = json.loads(r.read())
        
        teams = [t['id'] for t in data.get('teams', [])]
        batters = {}
        
        for team_id in teams:
            try:
                roster_url = f"https://statsapi.mlb.com/api/v1/teams/{team_id}/roster?rosterType=active"
                with urllib.request.urlopen(roster_url, timeout=10) as r:
                    roster_data = json.loads(r.read())
                for player in roster_data.get('roster', []):
                    pos = player.get('position', {}).get('code', '')
                    # Include non-pitchers (position players)
                    if pos != '1':
                        pid = player['person']['id']
                        name = player['person']['fullName']
                        batters[pid] = name
            except:
                continue
        
        print(f"Found {len(batters)} active position players across all teams")
        return batters
    except Exception as e:
        print(f"Error fetching active batters: {e}")
        return {}

# ── Statcast fetch functions ─────────────────────────────────────────────────

def fetch_pitcher_statcast(pid, name):
    try:
        df = statcast_pitcher(season_start, today, pid)
        if df is None or df.empty:
            return None

        total = len(df)
        velos = df['release_speed'].dropna()
        avg_velo = round(float(velos.mean()), 1) if len(velos) > 0 else None

        # Last start velocity trend
        last_start_velo = None
        velo_trend = 'UNKNOWN'
        if 'game_date' in df.columns:
            df['game_date'] = df['game_date'].astype(str)
            last_date = df['game_date'].max()
            last_velos = df[df['game_date'] == last_date]['release_speed'].dropna()
            last_start_velo = round(float(last_velos.mean()), 1) if len(last_velos) > 0 else None
            if avg_velo and last_start_velo:
                if last_start_velo < avg_velo - 1.5:
                    velo_trend = 'DOWN'
                elif last_start_velo > avg_velo + 1.0:
                    velo_trend = 'UP'
                else:
                    velo_trend = 'STABLE'

        # Whiff, hard hit, barrel rates
        desc = df['description'].fillna('')
        swings = desc.isin(SWING_EVENTS).sum()
        whiffs = desc.isin(WHIFF_EVENTS).sum()
        whiff_rate = round(float(whiffs/swings*100), 1) if swings > 0 else None

        batted = df[df['launch_speed'].notna()]
        hard_hits = (batted['launch_speed'] >= 95).sum()
        hard_hit_rate = round(float(hard_hits/len(batted)*100), 1) if len(batted) > 0 else None

        barrel_rate = None
        if 'barrel' in df.columns:
            barrels = (df['barrel'] == 1).sum()
            barrel_rate = round(float(barrels/len(batted)*100), 1) if len(batted) > 0 else None

        # Arsenal by pitch type
        arsenal = {}
        if 'pitch_type' in df.columns:
            for pt, grp in df.groupby('pitch_type'):
                if not pt or str(pt) == 'nan' or len(grp) < 10:
                    continue
                p_desc = grp['description'].fillna('')
                p_swings = p_desc.isin(SWING_EVENTS).sum()
                p_whiffs = p_desc.isin(WHIFF_EVENTS).sum()
                p_batted = grp[grp['launch_speed'].notna()]
                p_hh = (p_batted['launch_speed'] >= 95).sum()
                arsenal[pt] = {
                    'pct': round(len(grp)/total*100, 1),
                    'velo': round(float(grp['release_speed'].dropna().mean()), 1) if len(grp['release_speed'].dropna()) > 0 else None,
                    'whiffRate': round(float(p_whiffs/p_swings*100), 1) if p_swings > 0 else None,
                    'hardHitRate': round(float(p_hh/len(p_batted)*100), 1) if len(p_batted) > 0 else None,
                    'hBreak': round(float(grp['pfx_x'].dropna().mean()*12), 1) if 'pfx_x' in grp.columns and len(grp['pfx_x'].dropna()) > 0 else None,
                    'vBreak': round(float(grp['pfx_z'].dropna().mean()*12), 1) if 'pfx_z' in grp.columns and len(grp['pfx_z'].dropna()) > 0 else None,
                    'armSlotX': round(float(grp['release_pos_x'].dropna().mean()), 2) if 'release_pos_x' in grp.columns and len(grp['release_pos_x'].dropna()) > 0 else None,
                    'armSlotZ': round(float(grp['release_pos_z'].dropna().mean()), 2) if 'release_pos_z' in grp.columns and len(grp['release_pos_z'].dropna()) > 0 else None,
                    'count': int(len(grp))
                }

        # Last 3 starts breakdown
        last3 = []
        if 'game_date' in df.columns:
            for gd in sorted(df['game_date'].unique())[-3:]:
                gdf = df[df['game_date'] == gd]
                bf = int(gdf['events'].notna().sum())
                ks = int(gdf['events'].isin(['strikeout', 'strikeout_double_play']).sum())
                bbs = int(gdf['events'].isin(['walk', 'hit_by_pitch']).sum())
                last3.append({
                    'date': str(gd),
                    'kPct': round(float(ks/bf*100), 1) if bf > 0 else None,
                    'bbPct': round(float(bbs/bf*100), 1) if bf > 0 else None,
                })

        return {
            'avgVelo': avg_velo,
            'lastStartVelo': last_start_velo,
            'veloTrend': velo_trend,
            'whiffRate': whiff_rate,
            'hardHitRate': hard_hit_rate,
            'barrelRate': barrel_rate,
            'totalPitches': int(total),
            'arsenal': arsenal,
            'last3Rates': last3
        }
    except Exception as e:
        print(f"  Error pitcher {name}: {e}")
        return None

def fetch_batter_statcast(pid, name):
    try:
        df = statcast_batter(season_start, today, pid)
        if df is None or df.empty:
            return None

        # Per pitch type performance
        pitch_type_stats = {}
        if 'pitch_type' in df.columns:
            for pt, grp in df.groupby('pitch_type'):
                if not pt or str(pt) == 'nan' or len(grp) < 5:
                    continue
                desc = grp['description'].fillna('')
                swings = desc.isin(SWING_EVENTS).sum()
                whiffs = desc.isin(WHIFF_EVENTS).sum()
                # Chase rate — swings on out-of-zone pitches (zones 11-14)
                chase_pct = None
                if 'zone' in grp.columns:
                    ooz = grp[grp['zone'].isin([11, 12, 13, 14])]
                    ooz_swings = ooz['description'].fillna('').isin(SWING_EVENTS).sum()
                    chase_pct = round(float(ooz_swings/len(ooz)*100), 1) if len(ooz) > 0 else None
                batted = grp[grp['launch_speed'].notna()]
                hh = (batted['launch_speed'] >= 95).sum()
                pitch_type_stats[pt] = {
                    'pa': int(len(grp)),
                    'whiffPct': round(float(whiffs/swings*100), 1) if swings > 0 else None,
                    'chasePct': chase_pct,
                    'hardHitPct': round(float(hh/len(batted)*100), 1) if len(batted) > 0 else None,
                }

        # Overall hard hit rate
        batted_all = df[df['launch_speed'].notna()]
        overall_hh = round(float((batted_all['launch_speed'] >= 95).sum()/len(batted_all)*100), 1) if len(batted_all) > 0 else None

        # Exit velocity average
        avg_ev = round(float(batted_all['launch_speed'].mean()), 1) if len(batted_all) > 0 else None

        return {
            'pitchTypeStats': pitch_type_stats,
            'overallHardHitPct': overall_hh,
            'avgExitVelo': avg_ev
        }
    except Exception as e:
        print(f"  Error batter {name}: {e}")
        return None

# ── Main ─────────────────────────────────────────────────────────────────────

def main():
    print(f"\n=== Statcast Cache — mode={mode} | {today} ===\n")

    # Always fetch today's pitchers
    pitcher_ids = get_todays_pitchers()
    pitcher_records = []
    for i, (pid, name) in enumerate(pitcher_ids.items()):
        print(f"  [{i+1}/{len(pitcher_ids)}] Pitcher: {name}")
        data = fetch_pitcher_statcast(pid, name)
        if data:
            pitcher_records.append({
                'player_id': str(pid),
                'player_type': 'pitcher',
                'name': name,
                'data': json.dumps(data, default=str),
                'updated_at': datetime.utcnow().isoformat()
            })
            print(f"    ✓ velo {data.get('avgVelo')}mph ({data.get('veloTrend')}), whiff {data.get('whiffRate')}%, arsenal {list(data.get('arsenal',{}).keys())}")
        time.sleep(0.5)  # rate limiting

    saved = supabase_upsert_batch(pitcher_records)
    print(f"\n✅ Pitchers: {saved}/{len(pitcher_ids)} saved to Supabase")

    if mode == 'full':
        # Fetch ALL active batters
        batter_ids = get_all_active_batters()
        batter_records = []
        errors = 0
        for i, (pid, name) in enumerate(batter_ids.items()):
            if i % 50 == 0:
                print(f"  Progress: {i}/{len(batter_ids)} batters...")
            data = fetch_batter_statcast(pid, name)
            if data:
                batter_records.append({
                    'player_id': str(pid),
                    'player_type': 'batter',
                    'name': name,
                    'data': json.dumps(data, default=str),
                    'updated_at': datetime.utcnow().isoformat()
                })
            else:
                errors += 1
            time.sleep(0.3)  # rate limiting — ~750 batters at 0.3s = ~4 minutes

            # Save in batches of 100 to avoid memory buildup
            if len(batter_records) >= 100:
                supabase_upsert_batch(batter_records)
                batter_records = []

        # Save remaining
        if batter_records:
            supabase_upsert_batch(batter_records)

        print(f"✅ Batters: {len(batter_ids)-errors}/{len(batter_ids)} saved to Supabase")

    print(f"\n✅ Statcast cache complete for {today}")

if __name__ == '__main__':
    main()
