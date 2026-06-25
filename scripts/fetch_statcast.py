"""
fetch_statcast.py
Fetches pitcher Statcast data from Baseball Savant via pybaseball.
Saves to /tmp/statcast_cache.json for analyze.js to read.

Runs as a GitHub Actions step before analyze.js.
Uses pybaseball which handles rate limiting and caching automatically.
"""

import json
import sys
import os
from datetime import datetime, timedelta

try:
    import pybaseball
    from pybaseball import statcast_pitcher, pitching_stats_range, cache
    pybaseball.cache.enable()
except ImportError:
    print("pybaseball not available — skipping Statcast fetch")
    # Write empty cache so analyze.js doesn't fail
    with open('/tmp/statcast_cache.json', 'w') as f:
        json.dump({}, f)
    sys.exit(0)

# Date range — current season
season_start = f"{datetime.now().year}-03-01"
today = datetime.now().strftime('%Y-%m-%d')
recent_start = (datetime.now() - timedelta(days=21)).strftime('%Y-%m-%d')

# MLB Stats API to get today's probable pitchers
import urllib.request

def get_todays_pitcher_ids():
    """Fetch today's probable pitcher IDs from MLB Stats API"""
    try:
        url = f"https://statsapi.mlb.com/api/v1/schedule?sportId=1&date={today}&gameType=R&hydrate=probablePitcher"
        with urllib.request.urlopen(url, timeout=10) as r:
            data = json.loads(r.read())
        
        pitcher_ids = {}
        for date_entry in data.get('dates', []):
            for game in date_entry.get('games', []):
                away_p = game.get('teams', {}).get('away', {}).get('probablePitcher', {})
                home_p = game.get('teams', {}).get('home', {}).get('probablePitcher', {})
                if away_p.get('id'):
                    pitcher_ids[away_p['id']] = away_p.get('fullName', str(away_p['id']))
                if home_p.get('id'):
                    pitcher_ids[home_p['id']] = home_p.get('fullName', str(home_p['id']))
        
        print(f"Found {len(pitcher_ids)} probable pitchers for {today}")
        return pitcher_ids
    except Exception as e:
        print(f"Error fetching pitcher IDs: {e}")
        return {}

def fetch_pitcher_statcast(pitcher_id, pitcher_name):
    """Fetch Statcast data for a single pitcher"""
    try:
        print(f"  Fetching Statcast for {pitcher_name} ({pitcher_id})...")
        
        # Season data for overall metrics
        df = statcast_pitcher(season_start, today, pitcher_id)
        
        if df is None or df.empty:
            print(f"  No data for {pitcher_name}")
            return None
        
        # Overall metrics
        total_pitches = len(df)
        
        # Velocity
        velo_data = df['release_speed'].dropna()
        avg_velo = round(float(velo_data.mean()), 1) if len(velo_data) > 0 else None
        
        # Last start velocity
        if 'game_date' in df.columns:
            df['game_date'] = df['game_date'].astype(str)
            last_date = df['game_date'].max()
            last_start_df = df[df['game_date'] == last_date]
            last_velo_data = last_start_df['release_speed'].dropna()
            last_start_velo = round(float(last_velo_data.mean()), 1) if len(last_velo_data) > 0 else None
        else:
            last_start_velo = None
        
        # Velocity trend
        velo_trend = 'UNKNOWN'
        if avg_velo and last_start_velo:
            if last_start_velo < avg_velo - 1.5:
                velo_trend = 'DOWN'
            elif last_start_velo > avg_velo + 1.0:
                velo_trend = 'UP'
            else:
                velo_trend = 'STABLE'
        
        # Whiff rate
        swing_events = ['swinging_strike', 'foul', 'hit_into_play', 'foul_tip',
                       'swinging_strike_blocked', 'foul_bunt', 'missed_bunt']
        whiff_events = ['swinging_strike', 'swinging_strike_blocked']
        
        desc = df['description'].fillna('')
        swings = desc.isin(swing_events).sum()
        whiffs = desc.isin(whiff_events).sum()
        whiff_rate = round(float(whiffs / swings * 100), 1) if swings > 0 else None
        
        # Hard hit rate and barrel rate
        batted = df[df['launch_speed'].notna()]
        hard_hits = (batted['launch_speed'] >= 95).sum()
        hard_hit_rate = round(float(hard_hits / len(batted) * 100), 1) if len(batted) > 0 else None
        
        barrel_col = 'barrel' if 'barrel' in df.columns else None
        barrel_rate = None
        if barrel_col:
            barrels = (df[barrel_col] == 1).sum()
            barrel_rate = round(float(barrels / len(batted) * 100), 1) if len(batted) > 0 else None
        
        # xERA, xwOBA from expected stats
        xera = None
        xwoba = None
        try:
            from pybaseball import expected_statistics
            xstats = expected_statistics(datetime.now().year, 'pitcher')
            if xstats is not None and not xstats.empty:
                player_row = xstats[xstats['player_id'] == pitcher_id]
                if not player_row.empty:
                    xera = round(float(player_row.iloc[0].get('xera', 0) or 0), 2) or None
                    xwoba = round(float(player_row.iloc[0].get('xwoba', 0) or 0), 3) or None
        except Exception as xe:
            print(f"  xStats error for {pitcher_name}: {xe}")
        
        # Pitch arsenal — usage, velo, whiff by pitch type
        arsenal = {}
        if 'pitch_type' in df.columns:
            for pitch_type, group in df.groupby('pitch_type'):
                if not pitch_type or str(pitch_type) == 'nan':
                    continue
                pitch_total = len(group)
                pitch_pct = round(pitch_total / total_pitches * 100, 1)
                pitch_velo = round(float(group['release_speed'].dropna().mean()), 1) if len(group['release_speed'].dropna()) > 0 else None
                
                p_desc = group['description'].fillna('')
                p_swings = p_desc.isin(swing_events).sum()
                p_whiffs = p_desc.isin(whiff_events).sum()
                pitch_whiff = round(float(p_whiffs / p_swings * 100), 1) if p_swings > 0 else None
                
                # Movement
                h_break = round(float(group['pfx_x'].dropna().mean() * 12), 1) if 'pfx_x' in group and len(group['pfx_x'].dropna()) > 0 else None
                v_break = round(float(group['pfx_z'].dropna().mean() * 12), 1) if 'pfx_z' in group and len(group['pfx_z'].dropna()) > 0 else None
                
                # Arm slot
                rel_x = round(float(group['release_pos_x'].dropna().mean()), 2) if 'release_pos_x' in group else None
                rel_z = round(float(group['release_pos_z'].dropna().mean()), 2) if 'release_pos_z' in group else None
                
                arsenal[pitch_type] = {
                    'pct': pitch_pct,
                    'velo': pitch_velo,
                    'whiffRate': pitch_whiff,
                    'hBreak': h_break,
                    'vBreak': v_break,
                    'armSlotX': rel_x,
                    'armSlotZ': rel_z,
                    'count': pitch_total
                }
        
        # Last 3 starts breakdown
        last3_rates = []
        if 'game_date' in df.columns:
            game_dates = sorted(df['game_date'].unique())[-3:]
            for gd in game_dates:
                gdf = df[df['game_date'] == gd]
                bf = len(gdf[gdf['events'].notna() & (gdf['events'] != '')])
                ks = (gdf['events'].isin(['strikeout', 'strikeout_double_play'])).sum()
                bbs = (gdf['events'].isin(['walk', 'hit_by_pitch'])).sum()
                hrs = (gdf['events'] == 'home_run').sum()
                last3_rates.append({
                    'date': gd,
                    'kPct': round(float(ks / bf * 100), 1) if bf > 0 else None,
                    'bbPct': round(float(bbs / bf * 100), 1) if bf > 0 else None,
                    'hrPer9': round(float(hrs / max(1, bf / 4.3) * 9), 2)
                })
        
        result = {
            'pitcherId': pitcher_id,
            'name': pitcher_name,
            'avgVelo': avg_velo,
            'lastStartVelo': last_start_velo,
            'veloTrend': velo_trend,
            'whiffRate': whiff_rate,
            'hardHitRate': hard_hit_rate,
            'barrelRate': barrel_rate,
            'totalPitches': int(total_pitches),
            'xERA': xera,
            'xwOBA': xwoba,
            'arsenal': arsenal,
            'last3Rates': last3_rates
        }
        
        print(f"  ✓ {pitcher_name}: velo {avg_velo}mph ({velo_trend}), whiff {whiff_rate}%, barrel {barrel_rate}%")
        return result
        
    except Exception as e:
        print(f"  Error fetching {pitcher_name}: {e}")
        return None

def main():
    print(f"\n=== Fetching Statcast data for {today} ===\n")
    
    pitcher_ids = get_todays_pitcher_ids()
    if not pitcher_ids:
        print("No pitchers found — writing empty cache")
        with open('/tmp/statcast_cache.json', 'w') as f:
            json.dump({}, f)
        return
    
    cache = {}
    for pid, name in pitcher_ids.items():
        data = fetch_pitcher_statcast(pid, name)
        if data:
            cache[str(pid)] = data
    
    output_path = '/tmp/statcast_cache.json'
    with open(output_path, 'w') as f:
        json.dump(cache, f, indent=2, default=str)
    
    print(f"\n✅ Statcast cache written: {len(cache)}/{len(pitcher_ids)} pitchers → {output_path}")

if __name__ == '__main__':
    main()
