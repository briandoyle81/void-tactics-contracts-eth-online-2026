"""
Design lab for the AI ship configs (ignition/data/singlePlayerStarterContent.json,
"aiShipConfigs") and the missions that use them.

  python3 scripts/balance-sim/ai_config_lab.py table [old|new]    derived stats + checks
  python3 scripts/balance-sim/ai_config_lab.py curve [old|new]    mission difficulty curve
  python3 scripts/balance-sim/ai_config_lab.py write              write the "new" design into the JSON

"old" = the configs currently in the data file; "new" = the design in
DESIGN below. Uses balance_sim's stat/cost formulas (V1/V2 tables must be kept
in sync with the deploy module, see balance_sim.py).

The difficulty curve plays a random variant-1 player fleet, built to the
run's cost cap at that point of the roguelike graph, against each mission's
roster (real spawn positions). The player kites (the strongest style in the
simulator); variant-1 enemies kite and variant-2 enemies rush (a stand-in for
the brawler tree). It ignores specials' effects other than the Thruster's
movement (so healing/Flak/Swarm aren't credited), terrain and objectives — read
it as a relative difficulty curve, not a prediction.
"""
import json, os, random, sys, itertools, multiprocessing as mp
import balance_sim as b

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
SP_PATH = os.path.join(ROOT, 'ignition/data/singlePlayerStarterContent.json')
RL_PATH = os.path.join(ROOT, 'ignition/data/roguelikeStarterContent.json')

ARCH = ['Grunt', 'Aggr', 'Snip', 'Supp', 'Turt', 'Ramm']
WEAPON = ['Gen', 'Snp', 'Msl', 'Cls']
GEAR = ['-', 'L', 'M', 'H']

def table(variant): return b.V1 if variant == 1 else b.V2

def ship_of(cfg):
    e, t = cfg['equipment'], cfg['traits']
    return b.build_ship(table(t['variant']), t['accuracy'], t['hull'], t['speed'],
                        e['mainWeapon'], e['armor'], e['shields'], e['special'])

def load_old():
    return json.load(open(SP_PATH))['aiShipConfigs']

# ------------------------------------------------------------------ table
def show_table(configs):
    print(f"{'key':13s} {'arch':5s} wpn  arm shd spc | acc hul spd | hp  dmg rng mv  DR  cost  name")
    for c in configs:
        e, t = c['equipment'], c['traits']
        s = ship_of(c)
        print(f"{c['key']:13s} {ARCH[c['archetype']]:5s} {WEAPON[e['mainWeapon']]:4s}  {GEAR[e['armor']]:2s}  {GEAR[e['shields']]:2s}  {e['special']}  |  {t['accuracy']}   {t['hull']}   {t['speed']}  |"
              f" {s['hp']:3d} {s['dmg']:3d} {s['range']:2d}  {s['mv']:2d} {s['dr']:3d}  {s['cost']:3d}  {c['name']}")

# ------------------------------------------------------------------ missions
def graph():
    sp = json.load(open(SP_PATH)); rl = json.load(open(RL_PATH))
    kids = {}
    for e in rl['edges']: kids.setdefault(e['from'], []).append(e['to'])
    node = {n['key']: n for n in rl['nodes']}
    order = [rl['root']]
    info = {rl['root']: dict(mission=1, cap=rl['campaign']['initialCostCap'])}
    while order:
        k = order.pop(0)
        for c in kids.get(k, []):
            n = node[c]
            mission = info[k]['mission'] + (1 if n['kind'] == 'Combat' else 0)
            cap = info[k]['cap']
            if n['kind'] == 'Resupply' and n.get('costCapOverride'):
                cap = n['costCapOverride']
            if c not in info or mission < info[c]['mission']:
                info[c] = dict(mission=mission, cap=cap); order.append(c)
    placements = {p['mapKey']: p for p in sp['mapPlacements'] + rl.get('mapPlacements', [])}
    missions = []
    for n in rl['nodes']:
        if n['kind'] != 'Combat': continue
        missions.append(dict(key=n['key'], mission=info[n['key']]['mission'],
                             cap=info[n['key']]['cap'], placement=placements[n['mapKey']]))
    return sorted(missions, key=lambda m: (m['mission'], m['key']))

def roster(mission, cfg_by_key):
    ships = []
    for k, pos in zip(mission['placement']['configKeys'], mission['placement']['positions']):
        c = cfg_by_key[k]
        s = ship_of(c)
        s['pos'] = (pos['row'], pos['col'])
        s['variant'] = c['traits']['variant']
        ships.append(s)
    return ships

def fight(args):
    cfgs, mission, n, seed = args
    cfg_by_key = {c['key']: c for c in cfgs}
    rng = random.Random(seed)
    wins = 0.0
    for i in range(n):
        player = b.build_fleet(rng, b.V1, mission['cap'])
        ai = roster(mission, cfg_by_key)
        # the AI fleet's play style: variant 1 kites, variant 2 rushes (brawls)
        style = 'kite' if ai[0]['variant'] == 1 else 'rush'
        res = b.battle([player, ai], rng, ('kite', style), first_side=0)
        wins += 1.0 - res            # b.battle returns side 1's (the AI's) result
    return wins / n

def curve(configs, n=300):
    ms = graph()
    jobs = [(configs, m, n, 100 + i) for i, m in enumerate(ms)]
    with mp.Pool() as pool:
        out = pool.map(fight, jobs)
    cfg_by_key = {c['key']: c for c in configs}
    print("mission node  cap   enemy ships/cost  enemy variant   player win rate")
    for m, w in zip(ms, out):
        r = roster(m, cfg_by_key)
        print(f"   {m['mission']:2d}    {m['key']:4s} {m['cap']:5d}   {len(r):2d} / {sum(x['cost'] for x in r):5d}          v{r[0]['variant']}          {w:.2f}")
    return ms, out

# ------------------------------------------------------------------ design
# One row per ship: (variant, archetype, level, acc, hull, speed, weapon,
#                    armor, shields, special).  Level 1-5 is a difficulty tier
# the mission rosters pick from; cost rises with level (~80-105 at level 1 to
# ~180-205 at level 5) so a roster's total cost tracks its difficulty.
#
# Weapons: 0 Generic, 1 Sniper, 2 Missile, 3 Close. Gear: 0 none, 1 Light,
# 2 Medium, 3 Heavy (a ship carries armor OR shields).
# Specials (per faction!): variant 1: 1 EMP, 2 Repair Drones, 3 Flak Array;
#                          variant 2: 1 Electric Storm, 2 Drone Swarm, 3 Thruster.
GRUNT, AGGR, SNIP, SUPP, TURT, RAMM = range(6)
DESIGN = [
    # ---- variant 1: light, fast, long-range SKIRMISHERS (shields keep them quick)
    (1, GRUNT, 1, 0,0,0, 0, 0,1, 0), (1, GRUNT, 2, 1,1,1, 0, 0,1, 0),
    (1, GRUNT, 3, 2,1,1, 0, 0,1, 3), (1, GRUNT, 4, 2,2,1, 0, 0,2, 3),
    (1, GRUNT, 5, 2,2,2, 0, 0,3, 3),
    (1, AGGR,  1, 0,1,1, 2, 0,1, 0), (1, AGGR,  2, 1,2,2, 2, 0,1, 0),
    (1, AGGR,  3, 2,2,2, 2, 0,1, 0), (1, AGGR,  4, 2,2,2, 2, 0,2, 0),
    (1, AGGR,  5, 2,2,2, 2, 0,3, 1),
    (1, SNIP,  1, 1,0,0, 1, 0,1, 0), (1, SNIP,  2, 2,1,1, 1, 0,1, 0),
    (1, SNIP,  3, 2,2,2, 1, 0,1, 0), (1, SNIP,  4, 2,2,2, 1, 0,2, 0),
    (1, SNIP,  5, 2,2,2, 1, 0,3, 0),
    (1, SUPP,  1, 0,0,0, 0, 0,1, 2), (1, SUPP,  2, 1,1,1, 0, 0,1, 2),
    (1, SUPP,  3, 2,2,2, 0, 0,1, 2), (1, SUPP,  4, 2,2,2, 0, 0,2, 2),
    (1, SUPP,  5, 2,2,2, 0, 0,3, 2),
    (1, TURT,  1, 0,1,0, 0, 1,0, 0), (1, TURT,  2, 1,2,1, 0, 1,0, 0),
    (1, TURT,  3, 2,2,1, 0, 2,0, 3), (1, TURT,  4, 2,2,2, 0, 2,0, 3),
    (1, TURT,  5, 2,2,2, 0, 3,0, 3),
    (1, RAMM,  1, 0,1,2, 0, 0,1, 0), (1, RAMM,  2, 1,2,2, 0, 0,2, 0),
    # ---- variant 2: heavy, slow, tough BRAWLERS (armor; Thruster on the heaviest)
    (2, GRUNT, 1, 0,0,0, 0, 1,0, 0), (2, GRUNT, 2, 1,1,1, 0, 1,0, 0),
    (2, GRUNT, 3, 2,2,1, 0, 1,0, 2), (2, GRUNT, 4, 2,2,1, 0, 2,0, 2),
    (2, GRUNT, 5, 2,2,2, 0, 3,0, 3),
    (2, AGGR,  1, 0,1,1, 3, 1,0, 0), (2, AGGR,  2, 1,2,2, 3, 1,0, 0),
    (2, AGGR,  3, 2,2,2, 3, 1,0, 0), (2, AGGR,  4, 2,2,2, 3, 2,0, 1),
    (2, AGGR,  5, 2,2,2, 3, 3,0, 3),
    (2, SNIP,  1, 1,0,0, 1, 0,1, 0), (2, SNIP,  2, 2,1,1, 1, 0,1, 0),
    (2, SNIP,  3, 2,2,2, 1, 0,1, 0), (2, SNIP,  4, 2,2,2, 1, 0,2, 0),
    (2, SNIP,  5, 2,2,2, 1, 0,3, 3),
    (2, SUPP,  1, 0,0,0, 0, 0,1, 0), (2, SUPP,  2, 1,1,1, 0, 0,1, 0),
    (2, SUPP,  3, 2,2,2, 0, 0,1, 0), (2, SUPP,  4, 2,2,2, 0, 0,2, 0),
    (2, SUPP,  5, 2,2,2, 0, 0,3, 3),
    (2, TURT,  1, 0,1,0, 0, 1,0, 0), (2, TURT,  2, 1,2,1, 0, 1,0, 0),
    (2, TURT,  3, 1,2,2, 0, 2,0, 2), (2, TURT,  4, 2,2,2, 0, 2,0, 2),
    (2, TURT,  5, 2,2,2, 0, 3,0, 2),
]
ROMAN = ['', '', ' II', ' III', ' IV', ' V']
ARCH_NAME = ['Grunt', 'Aggressor', 'Sniper', 'Support', 'Turtle', 'Rammer']

def new_configs():
    old = {c['key']: c for c in load_old()}
    out = []
    for v, a, lvl, acc, hul, spd, w, ar, sh, sp in DESIGN:
        key = ('v2' if v == 2 else '') + ARCH_NAME[a].lower() + ('' if lvl == 1 else str(lvl))
        name = old[key]['name'] if key in old and v == 2 else f"AI {ARCH_NAME[a]}{ROMAN[lvl]}"
        out.append(dict(key=key, name=name,
                        equipment=dict(mainWeapon=w, armor=ar, shields=sh, special=sp),
                        traits=dict(variant=v, accuracy=acc, hull=hul, speed=spd), archetype=a))
    return out

# ---- checks: every config must be a viable ship for its role -------------
def check(configs):
    problems = []
    for c in configs:
        s, v, a = ship_of(c), c['traits']['variant'], c['archetype']
        e = c['equipment']
        min_mv = 2 if a == TURT else 3
        if s['mv'] < min_mv: problems.append(f"{c['key']}: movement {s['mv']} < {min_mv}")
        if v == 1 and a in (SNIP,) and s['range'] < 6: problems.append(f"{c['key']}: sniper range {s['range']}")
        if a == SNIP and e['mainWeapon'] != 1: problems.append(f"{c['key']}: sniper without the sniper gun")
        if a == SUPP and v == 1 and e['special'] != 2: problems.append(f"{c['key']}: v1 support can't heal (needs special 2)")
        if e['armor'] and e['shields']: problems.append(f"{c['key']}: armor AND shields")
        if e['special'] not in (0, 1, 2, 3): problems.append(f"{c['key']}: special slot {e['special']} isn't a real slot")
    # cost ramp: each archetype's cost must rise with level
    for v in (1, 2):
        for a in range(6):
            cs = [ship_of(c)['cost'] for c in configs if c['traits']['variant'] == v and c['archetype'] == a
                  for _ in [0]]
            if cs != sorted(cs): problems.append(f"v{v} {ARCH[a]}: cost not increasing with level {cs}")
    return problems

# ---- cost efficiency: a fleet of copies vs a random player fleet, same cost
def eff_fight(args):
    cfg, cap, n, seed = args
    rng = random.Random(seed)
    v = cfg['traits']['variant']
    wins = 0.0
    for i in range(n):
        one = ship_of(cfg)
        copies = max(1, cap // one['cost'])
        ai = [dict(one) for _ in range(copies)]
        # the player gets exactly the AI fleet's total cost, so integer
        # rounding of "how many copies fit" doesn't skew the comparison
        player = b.build_fleet(rng, b.V1, copies * one['cost'])
        style = 'kite' if v == 1 else 'rush'
        res = b.battle([player, ai], rng, ('kite', style), first_side=i % 2)
        wins += res
    return wins / n

def efficiency(configs, cap=700, n=300):
    jobs = [(c, cap, n, 900 + i) for i, c in enumerate(configs)]
    with mp.Pool() as pool:
        out = pool.map(eff_fight, jobs)
    print(f"cost efficiency: a fleet of copies of one config (cap {cap}) vs a random variant-1 fleet at the same cost — win rate (0.50 = par)")
    for v in (1, 2):
        for a in range(6):
            row = [(c['key'], w) for c, w in zip(configs, out) if c['traits']['variant'] == v and c['archetype'] == a]
            if row: print(f"  v{v} {ARCH[a]:5s} " + "  ".join(f"L{i+1}:{w:.2f}" for i, (k, w) in enumerate(row)))
    return out

if __name__ == '__main__':
    what = sys.argv[1] if len(sys.argv) > 1 else 'table'
    which = sys.argv[2] if len(sys.argv) > 2 else 'old'
    configs = new_configs() if which == 'new' else load_old()
    if what == 'table':
        show_table(configs)
        probs = check(configs)
        print("\nchecks:", "all pass" if not probs else "")
        for p_ in probs: print("  PROBLEM:", p_)
    elif what == 'curve': curve(configs)
    elif what == 'eff': efficiency(configs)
    elif what == 'write':
        # Replace the "aiShipConfigs" block in the data file with the DESIGN
        # (byte-for-byte the file's own JSON style). Rosters are edited by hand.
        raw = open(SP_PATH).read()
        start = raw.index('  "aiShipConfigs": [')
        end = raw.index('  "maps": [')
        block = '  "aiShipConfigs": ' + json.dumps(new_configs(), indent=2).replace('\n', '\n  ') + ',\n'
        open(SP_PATH, 'w').write(raw[:start] + block + raw[end:])
        print(f"wrote {len(new_configs())} configs to {SP_PATH}")

def roster_eval(keys, positions, cap, cfgs=None, n=400, seed=5):
    """Player win rate for a candidate roster (config keys at the first
    len(keys) of `positions`) against a random variant-1 fleet at `cap`."""
    cfgs = cfgs or new_configs()
    by = {c['key']: c for c in cfgs}
    mission = dict(cap=cap, placement=dict(configKeys=keys, positions=positions[:len(keys)]))
    return fight((cfgs, mission, n, seed)), sum(ship_of(by[k])['cost'] for k in keys)
