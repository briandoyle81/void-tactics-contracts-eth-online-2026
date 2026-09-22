"""
Approximate skirmish simulator for balancing variant 1 vs variant 2 defaults.

Usage:  python3 scripts/balance-sim/balance_sim.py
Prints the mean ship for each variant and variant 2's win rate against
variant 1 (0.50 = parity) for every fleet cost limit and every pairing of
play styles (each side independently kites or rushes).

KEEP IN SYNC BY HAND: the V1 / V2 tables below are copies of the defaults in
ignition/modules/DeployAndConfig.ts (variant 1 / variant 2 blocks). After
changing either faction's defaults there, update the tables here and re-run.
See docs/variant-balance.md for how to read the output.

Mirrors the on-chain rules that matter for raw stat balance:
  - deterministic combat: damage = gunDamage - floor(gunDamage * DR / 100), no hit roll
  - each ship acts once per round: move up to `movement` (manhattan, unoccupied
    destination, no pathing) then shoot a target within `range` (manhattan)
  - players alternate ship moves; who moves first alternates each round
  - 0-HP ships are out of action and are destroyed 3 rounds later
  - 17 x 11 grid; ship stats/costs use the ShipAttributes / calculateShipCost formulas,
    including the floors of 1 on final range and movement and the rule that the
    'None' (no armor/shields) movement bonus counts once, not once per slot
  - ship generation odds match GenerateNewShip (tier 50/30/20, weapon %4,
    armor-or-shield coin flip then %4, special %8)

NOT modelled: obstacles / line of sight, scoring tiles, special-item effects
(EMP, repair, flak, storm, swarm) -- only specials' movement and cost.
Each side follows a simple policy, 'kite' or 'rush', chosen independently; the
policies are otherwise identical for both variants. Kiting beats rushing in this
model, so judge parity on the kite-vs-kite cell (see docs/variant-balance.md).
"""
import random, sys, itertools, multiprocessing as mp

W, H = 17, 11

# ---------------------------------------------------------------- tables
def table(base_hull, base_speed, fore, hull_t, eng_t, guns, armors, shields, specials_mv, costs):
    return dict(base_hull=base_hull, base_speed=base_speed, fore=fore, hull_t=hull_t,
                eng_t=eng_t, guns=guns, armors=armors, shields=shields,
                specials_mv=specials_mv, costs=costs)

V1_COSTS = dict(base=50, acc=[0,10,25], hull=[0,10,25], speed=[0,10,25],
                weapon=[25,30,40,40], armor=[0,5,10,15], shields=[0,10,20,30],
                special=[0,10,20,15,0,0,0,0])

V1 = table(100, 4, [0,25,50], [0,10,20], [0,1,2],
           guns=[(3,50,0),(6,40,0),(4,60,-1),(2,80,0)],          # Laser, Railgun, Missile Launcher, Plasma Cannon: (range, damage, movement)
           armors=[(0,1),(15,0),(30,-1),(45,-2)],                # (DR, movement)
           shields=[(0,0),(15,1),(30,0),(45,-1)],                # None movement is never read (None bonus counts once, from armors)
           specials_mv=[0,0,0,0,0,0,0,0], costs=V1_COSTS)

V2 = table(125, 3, [0,25,50], [0,12,25], [0,1,2],
           guns=[(2,60,0),(5,50,0),(3,70,-1),(1,95,0)],          # Medium Mining Laser, Linear Accelerator, Torpedo Launcher, Mining Drill
           armors=[(0,1),(20,0),(40,-1),(60,-3)],                # (DR, movement): heavier and tougher than v1
           shields=[(0,0),(20,1),(40,0),(60,-2)],
           specials_mv=[0,0,0,3,0,0,0,0],                        # slot 3 = AdditionalThruster (+3)
           costs=dict(V1_COSTS, special=[0,15,20,10,0,0,0,0]))

# ---------------------------------------------------------------- generation
def tier(rng):
    r = rng.randrange(100)
    return 0 if r < 50 else (1 if r < 80 else 2)

def build_ship(t, acc, hull, speed, weapon, armor, shield, special):
    """A ship from explicit tiers/equipment (same stat and cost formulas the
    contracts use). gen_ship draws random ones; ai_config_lab.py builds the AI
    roster's fixed ones."""
    c = t['costs']
    cost = (c['base'] + c['acc'][acc] + c['hull'][hull] + c['speed'][speed] +
            c['weapon'][weapon] + c['armor'][armor] + c['shields'][shield] + c['special'][special])
    rng_, dmg, gmv = t['guns'][weapon]
    r = rng_ + (rng_ * t['fore'][acc]) // 100
    r = max(1, r)                      # on-chain floor: final range >= 1
    hp = t['base_hull'] + t['hull_t'][hull]
    dr_a, mv_a = t['armors'][armor]
    dr_s, mv_s = t['shields'][shield]
    dr = min(100, dr_a + dr_s)
    # Defensive gear's movement counts only for an EQUIPPED piece; the "None"
    # bonus is counted once, for a ship carrying neither (taken from the armor
    # table) -- mirrors ShipAttributes._calculateMovement.
    gear_mv = (mv_a if armor > 0 else 0) + (mv_s if shield > 0 else 0)
    if armor == 0 and shield == 0:
        gear_mv = mv_a
    mv = t['base_speed'] + t['eng_t'][speed] + gmv + gear_mv + t['specials_mv'][special]
    mv = max(1, mv)                    # on-chain floor: final movement >= 1
    return dict(hp=hp, maxhp=hp, dmg=dmg, range=r, mv=mv, dr=dr, cost=cost, timer=0, alive=True)

def gen_ship(rng, t):
    acc, hull, speed = tier(rng), tier(rng), tier(rng)
    weapon = rng.randrange(4)
    if rng.randrange(2) == 0:
        armor, shield = rng.randrange(4), 0
    else:
        armor, shield = 0, rng.randrange(4)
    special = rng.randrange(8)
    return build_ship(t, acc, hull, speed, weapon, armor, shield, special)

def build_fleet(rng, t, limit):
    fleet, total, fails = [], 0, 0
    while fails < 30:
        s = gen_ship(rng, t)
        if total + s['cost'] <= limit:
            fleet.append(s); total += s['cost']; fails = 0
        else:
            fails += 1
    return fleet

# ---------------------------------------------------------------- battle
def dist(a, b): return abs(a[0]-b[0]) + abs(a[1]-b[1])

def place(fleet, side, rng, occ):
    if fleet and all('pos' in s for s in fleet):
        # Pre-placed (e.g. an AI roster with fixed spawn positions).
        for s in fleet:
            s['side'] = side; occ.add(s['pos'])
        return
    cols = list(range(0, 4)) if side == 0 else list(range(W-4, W))
    cells = [(r, c) for r in range(H) for c in cols]
    rng.shuffle(cells)
    for s, cell in zip(fleet, cells):
        s['pos'] = cell; s['side'] = side; occ.add(cell)

def act(ship, enemies, allies_occ, policy):
    """One ship's move + shot. Returns None."""
    foes = [e for e in enemies if e['hp'] > 0 and e['alive']]
    if not foes: return
    me = ship['pos']
    # candidate targets reachable this turn: dist - mv <= range
    reach = [e for e in foes if dist(me, e['pos']) - ship['mv'] <= ship['range']]
    if reach:
        # focus the target that dies soonest (lowest hits-to-kill), tie -> lowest hp
        def key(e):
            d = ship['dmg'] - (ship['dmg'] * e['dr']) // 100
            hits = -(-e['hp'] // d) if d > 0 else 999
            return (hits, e['hp'])
        tgt = min(reach, key=key)
        best, best_score = None, None
        for dr_ in range(-ship['mv'], ship['mv'] + 1):
            for dc in range(-(ship['mv'] - abs(dr_)), ship['mv'] - abs(dr_) + 1):
                p = (me[0] + dr_, me[1] + dc)
                if not (0 <= p[0] < H and 0 <= p[1] < W): continue
                if p != me and p in allies_occ: continue
                d = dist(p, tgt['pos'])
                if d > ship['range']: continue
                score = d if policy == 'kite' else -d
                if best is None or score > best_score:
                    best, best_score = p, score
        if best is None: return
        allies_occ.discard(me); allies_occ.add(best); ship['pos'] = best
        # shoot
        d = ship['dmg'] - (ship['dmg'] * tgt['dr']) // 100
        if d >= tgt['hp']:
            tgt['hp'] = 0
        else:
            tgt['hp'] -= d
    else:
        # advance: tile within movement minimizing distance to nearest foe
        nearest = min(foes, key=lambda e: dist(me, e['pos']))
        best, best_d = me, dist(me, nearest['pos'])
        for dr_ in range(-ship['mv'], ship['mv'] + 1):
            for dc in range(-(ship['mv'] - abs(dr_)), ship['mv'] - abs(dr_) + 1):
                p = (me[0] + dr_, me[1] + dc)
                if not (0 <= p[0] < H and 0 <= p[1] < W): continue
                if p in allies_occ: continue
                d = dist(p, nearest['pos'])
                if d < best_d: best, best_d = p, d
        allies_occ.discard(me); allies_occ.add(best); ship['pos'] = best

def battle(fleets, rng, policies, first_side, max_rounds=80):
    # policies[side] is that side's play style ('kite' or 'rush'); side 0 = variant 1, side 1 = variant 2
    occ = set()
    for side in (0, 1): place(fleets[side], side, rng, occ)
    for rnd in range(max_rounds):
        # start of round: zero-HP ships' reactor timers tick
        for f in fleets:
            for s in f:
                if s['alive'] and s['hp'] == 0:
                    s['timer'] += 1
                    if s['timer'] >= 3:
                        s['alive'] = False; occ.discard(s['pos'])
        active = [[s for s in f if s['alive'] and s['hp'] > 0] for f in fleets]
        if not active[0] or not active[1]:
            break
        order_first = first_side if rnd % 2 == 0 else 1 - first_side
        queues = [list(active[0]), list(active[1])]
        turn = order_first
        while queues[0] or queues[1]:
            if not queues[turn]:
                turn = 1 - turn
                continue
            ship = queues[turn].pop(0)
            if ship['hp'] > 0 and ship['alive']:
                act(ship, fleets[1 - turn], occ, policies[turn])
            if queues[1 - turn]:
                turn = 1 - turn
    hp = [sum(s['hp'] for s in f) for f in fleets]
    alive = [sum(1 for s in f if s['hp'] > 0) for f in fleets]
    if alive[0] == 0 and alive[1] == 0: return 0.5
    if alive[0] == 0: return 1.0   # side 1 wins
    if alive[1] == 0: return 0.0
    return 1.0 if hp[1] > hp[0] else (0.0 if hp[0] > hp[1] else 0.5)

def run(args):
    t2, limit, policies, n, seed = args        # policies = (variant 1's style, variant 2's style)
    rng = random.Random(seed)
    wins = 0.0
    for i in range(n):
        f1 = build_fleet(rng, V1, limit)
        f2 = build_fleet(rng, t2, limit)
        res = battle([f1, f2], rng, policies, first_side=i % 2)
        wins += res
    return wins / n   # fraction of matches variant 2 (side 1) wins

STYLES = ('kite', 'rush')
STYLE_PAIRS = tuple(itertools.product(STYLES, STYLES))   # (variant 1 style, variant 2 style)

def winrate(t2, limits=(500, 1000, 2000), pairs=STYLE_PAIRS, n=1500, seed=1):
    """Variant 2's win rate for every (cost limit, (v1 style, v2 style)) cell."""
    keys = list(itertools.product(limits, pairs))
    jobs = [(t2, lim, pair, n, seed + k) for k, (lim, pair) in enumerate(keys)]
    with mp.Pool() as pool:
        out = pool.map(run, jobs)
    return dict(zip(keys, out))

def mean_ship(t, n=4000, seed=7):
    rng = random.Random(seed)
    ships = [gen_ship(rng, t) for _ in range(n)]
    avg = lambda k: sum(s[k] for s in ships) / n
    return {k: round(avg(k), 2) for k in ('hp', 'dmg', 'range', 'mv', 'dr', 'cost')}

if __name__ == '__main__':
    limits = (500, 1000, 2000)
    print('V1 mean ship', mean_ship(V1))
    print('V2 mean ship', mean_ship(V2))
    r = winrate(V2, limits=limits, n=1500, seed=21)
    print('\nVariant 2 win rate vs variant 1 (0.50 = parity), by fleet cost limit and play style.')
    print('Rows: variant 1 style. Columns: variant 2 style.  (~ +/-0.013 per cell)')
    for lim in limits:
        print(f'\n  cost limit {lim}')
        print('                 V2 kite   V2 rush')
        for v1s in STYLES:
            cells = '   '.join(f'{r[(lim, (v1s, v2s))]:.2f}   ' for v2s in STYLES)
            print(f'    V1 {v1s:5s}      {cells}')
    same = [v for (lim, (a, b)), v in r.items() if a == b]
    print(f'\n  mean, same style both sides : {sum(same) / len(same):.3f}')
    print(f'  mean, all {len(r)} cells         : {sum(r.values()) / len(r):.3f}')
