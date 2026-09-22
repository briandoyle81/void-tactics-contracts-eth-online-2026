// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.28;

import "./Types.sol";
import "./IMaps.sol";

// Shared toolbox for the AI turn-decision engine: targeting, stepping,
// scoring-tile and per-archetype rule primitives. Every function here is
// internal/pure/view (no storage writes), so this compiles as a plain
// internal Solidity library — inlined into each contract that uses it, no
// separate deployment/delegatecall needed (unlike SpecialEffectsLib.sol,
// which needs external+storage because it writes game state; this only
// ever reads and returns a decision).
//
// Which tree a ship actually follows is NOT decided here. Each variant
// (faction) has its own AI contract (Variant1AI, Variant2AI, ...) that
// composes its decision trees from these primitives using what it knows
// about its own faction — e.g. that healing is an equipped special, or that
// every ship has a repair action but no ram. AIBehaviorRegistry maps
// variant -> that contract, so a faction's AI can be replaced or upgraded
// without redeploying the match contracts that call it.
//
// Design constraint: every decision here is paid for in gas by the human
// player triggering takeAITurn, and Solidity has no real search/pathfinding
// primitives. So this is deliberately a cheap ordered priority-list per
// archetype (check a primitive, act or fall through) rather than anything
// resembling enumerate-and-score optimization. Movement ("step toward"/
// "step away") is greedy axis-priority stepping toward/away from a single
// target point, not pathfinding — it ignores obstacles/other ships, the
// same simplification the original v0 script already had. SinglePlayerMatch
// wraps each ship's actual moveShip call in try/catch specifically to
// absorb the rare case this produces an illegal move (e.g. stepping onto an
// occupied cell) rather than reverting the whole turn.
library AIBehavior {
    struct Decision {
        int16 destRow;
        int16 destCol;
        ActionType action;
        uint actionTarget;
    }

    // Bundles the values almost every function here needs, to keep
    // individual function signatures short — Solidity's legacy codegen
    // runs out of stack slots quickly once a view function has ~6+
    // parameters plus a handful of locals, the same issue SpecialEffectsLib
    // hit earlier for the same reason.
    struct Ctx {
        GameDataView g;
        IMaps maps;
        uint gameId;
        uint shipId;
        Position pos;
        Attributes attrs;
        MainWeapon mainWeapon;
        ScoringPosition[] scoringPositions;
        int16 gridWidth;
        int16 gridHeight;
    }

    // ---- shared lookups over GameDataView (already fetched once per
    // takeAITurn call — these never make a new Game call) ----

    function findPosition(
        GameDataView memory g,
        uint shipId
    ) internal pure returns (Position memory pos, bool found) {
        for (uint i = 0; i < g.shipPositions.length; i++) {
            if (g.shipPositions[i].shipId == shipId) {
                return (g.shipPositions[i].position, true);
            }
        }
    }

    // O(n) scan — only use this for a single specific shipId (e.g. the one
    // ship whose turn is being decided this call). Do NOT call this inside a
    // loop over ctx.g.shipPositions/joinerActiveShipIds: Game.getGame()
    // builds shipIds/shipAttributes and shipPositions from the exact same
    // creatorActiveShipIds-then-joinerActiveShipIds ordering (see
    // Game.sol's getGame/getAllShipPositions), so for any index i where
    // shipPositions[i].status == 0 (the only case any candidate-scan helper
    // below ever needs), shipAttributes[i] is already that exact ship's
    // attributes — read it directly instead of re-scanning for it (G-01).
    function findAttributes(
        GameDataView memory g,
        uint shipId
    ) internal pure returns (Attributes memory attrs, bool found) {
        for (uint i = 0; i < g.shipIds.length; i++) {
            if (g.shipIds[i] == shipId) {
                return (g.shipAttributes[i], true);
            }
        }
    }

    function _manhattan(
        Position memory a,
        Position memory b
    ) private pure returns (uint16) {
        uint16 rowDiff = a.row > b.row
            ? uint16(a.row - b.row)
            : uint16(b.row - a.row);
        uint16 colDiff = a.col > b.col
            ? uint16(a.col - b.col)
            : uint16(b.col - a.col);
        return rowDiff + colDiff;
    }

    // Enemy (opposing side) in manhattan range with LOS. Primary sort key is
    // "standing on a scoring tile" (contesting the objective is worth more
    // than shaving HP off someone who isn't); within the same tier, prefers
    // the lowest nonzero HP target (focus the weakest), falling back to the
    // first found if every in-range enemy in that tier is already at 0 HP
    // (still a legal Shoot, still meaningful reactor-timer progress).
    function _bestEnemyInRange(
        Ctx memory ctx,
        Position memory fromPos,
        uint8 range
    ) private view returns (uint targetId, bool found) {
        return _bestEnemyWithin(ctx, fromPos, range, true);
    }

    // Same search, with line of sight optional: guns need it past range 1,
    // but some specials (e.g. Drone Swarm) only care about range.
    function _bestEnemyWithin(
        Ctx memory ctx,
        Position memory fromPos,
        uint8 range,
        bool needsLineOfSight
    ) private view returns (uint targetId, bool found) {
        uint8 bestHp = type(uint8).max;
        bool bestIsZero = false;
        bool bestOnTile = false;
        for (uint i = 0; i < ctx.g.shipPositions.length; i++) {
            ShipPosition memory sp = ctx.g.shipPositions[i];
            if (sp.shipId == ctx.shipId || sp.status != 0 || !sp.isCreator)
                continue; // AI is always joiner, so enemies are isCreator
            uint16 dist = _manhattan(fromPos, sp.position);
            if (dist > range) continue;
            if (
                needsLineOfSight &&
                dist > 1 &&
                !ctx.maps.hasMaps(
                    ctx.gameId,
                    fromPos.row,
                    fromPos.col,
                    sp.position.row,
                    sp.position.col
                )
            ) continue;

            // sp.status == 0 already checked above, so index i is in the
            // active range and shipAttributes[i] is guaranteed to be this
            // exact ship's attributes (G-01) — no scan needed.
            Attributes memory attrs = ctx.g.shipAttributes[i];

            bool onTile = _isScoringTile(ctx.scoringPositions, sp.position);

            if (!found) {
                targetId = sp.shipId;
                found = true;
                bestHp = attrs.hullPoints;
                bestIsZero = attrs.hullPoints == 0;
                bestOnTile = onTile;
                continue;
            }
            if (onTile != bestOnTile) {
                // on-tile always beats off-tile, regardless of HP
                if (onTile) {
                    targetId = sp.shipId;
                    bestHp = attrs.hullPoints;
                    bestIsZero = attrs.hullPoints == 0;
                    bestOnTile = true;
                }
                continue;
            }
            if (bestIsZero && attrs.hullPoints > 0) {
                // any live target beats defaulting to a 0-HP one
                targetId = sp.shipId;
                bestHp = attrs.hullPoints;
                bestIsZero = false;
            } else if (
                !bestIsZero && attrs.hullPoints > 0 && attrs.hullPoints < bestHp
            ) {
                targetId = sp.shipId;
                bestHp = attrs.hullPoints;
            }
        }
    }

    function _isScoringTile(
        ScoringPosition[] memory scoringPositions,
        Position memory p
    ) private pure returns (bool) {
        for (uint i = 0; i < scoringPositions.length; i++) {
            if (
                scoringPositions[i].row == p.row &&
                scoringPositions[i].col == p.col
            ) return true;
        }
        return false;
    }

    // Same shape as _bestEnemyInRange but for the AI's own side, preferring
    // a 0-HP ally (a RepairDrones hit revives it) over the most-injured
    // alive ally.
    function _bestAllyToHeal(
        Ctx memory ctx,
        uint8 range
    ) private pure returns (uint targetId, bool found) {
        uint8 bestHp = type(uint8).max;
        bool bestIsZero = false;
        for (uint i = 0; i < ctx.g.shipPositions.length; i++) {
            ShipPosition memory sp = ctx.g.shipPositions[i];
            if (sp.shipId == ctx.shipId || sp.status != 0 || sp.isCreator)
                continue; // own side only, not self
            if (_manhattan(ctx.pos, sp.position) > range) continue;

            // sp.status == 0 already checked above (G-01) — direct index read.
            Attributes memory attrs = ctx.g.shipAttributes[i];
            if (attrs.hullPoints >= attrs.maxHullPoints)
                continue; // not actually injured

            bool isZero = attrs.hullPoints == 0;
            if (!found) {
                targetId = sp.shipId;
                found = true;
                bestHp = attrs.hullPoints;
                bestIsZero = isZero;
                continue;
            }
            if (isZero && !bestIsZero) {
                targetId = sp.shipId;
                bestHp = attrs.hullPoints;
                bestIsZero = true;
            } else if (isZero == bestIsZero && attrs.hullPoints < bestHp) {
                targetId = sp.shipId;
                bestHp = attrs.hullPoints;
            }
        }
    }

    // Nearest enemy position, anywhere on the board (any HP). preferZeroHP
    // makes this look only at 0-HP enemies first, falling back to any enemy
    // if none exist — kept as a general targeting option even though no
    // archetype currently passes true (Rammer, the only caller that did,
    // was removed) — e.g. a future assassin-style archetype beelining for
    // a finishing blow would want this exact behavior.
    function _nearestEnemyPosition(
        Ctx memory ctx,
        bool preferZeroHP
    ) private pure returns (Position memory pos, bool found) {
        uint16 bestDist = type(uint16).max;
        if (preferZeroHP) {
            for (uint i = 0; i < ctx.g.shipPositions.length; i++) {
                ShipPosition memory sp = ctx.g.shipPositions[i];
                if (sp.shipId == ctx.shipId || sp.status != 0 || !sp.isCreator)
                    continue;
                // sp.status == 0 already checked above (G-01) — direct index read.
                if (ctx.g.shipAttributes[i].hullPoints != 0) continue;
                uint16 dist = _manhattan(ctx.pos, sp.position);
                if (!found || dist < bestDist) {
                    pos = sp.position;
                    found = true;
                    bestDist = dist;
                }
            }
            if (found) return (pos, found);
        }
        for (uint i = 0; i < ctx.g.shipPositions.length; i++) {
            ShipPosition memory sp = ctx.g.shipPositions[i];
            if (sp.shipId == ctx.shipId || sp.status != 0 || !sp.isCreator)
                continue;
            uint16 dist = _manhattan(ctx.pos, sp.position);
            if (!found || dist < bestDist) {
                pos = sp.position;
                found = true;
                bestDist = dist;
            }
        }
    }

    function _isOccupiedByOther(
        Ctx memory ctx,
        Position memory p
    ) private pure returns (bool) {
        for (uint i = 0; i < ctx.g.shipPositions.length; i++) {
            ShipPosition memory sp = ctx.g.shipPositions[i];
            if (sp.shipId == ctx.shipId || sp.status != 0) continue;
            if (sp.position.row == p.row && sp.position.col == p.col)
                return true;
        }
        return false;
    }

    // Picks a scoring-tile movement target. Preference order:
    //   1. Unclaimed (unoccupied) tile on this ship's weapon-range-
    //      appropriate side of the grid — long-range weapons (Sniper,
    //      Missile) stick close to the AI's own spawn side (high
    //      columns), short-range weapons (Generic, Close) push toward
    //      the midline/opponent's side (low columns) — nearest first.
    //   2. Unclaimed tile on either side, nearest first (no matching-side
    //      tile exists on this map).
    //   3. Any tile at all, even one currently held by a ship, nearest
    //      first — so there's always somewhere to head as long as scoring
    //      tiles exist, rather than stalling out with nothing to do.
    function _bestScoringTile(
        Ctx memory ctx
    ) private pure returns (Position memory pos, bool found) {
        int16 midCol = ctx.gridWidth / 2;
        bool longRange = ctx.mainWeapon == MainWeapon.Sniper ||
            ctx.mainWeapon == MainWeapon.Missile;

        for (uint pass = 0; pass < 3; pass++) {
            uint16 bestDist = type(uint16).max;
            for (uint i = 0; i < ctx.scoringPositions.length; i++) {
                Position memory candidate = Position({
                    row: ctx.scoringPositions[i].row,
                    col: ctx.scoringPositions[i].col
                });
                if (pass < 2 && _isOccupiedByOther(ctx, candidate)) continue;
                if (pass == 0) {
                    bool onOwnSide = longRange
                        ? candidate.col >= midCol
                        : candidate.col <= midCol;
                    if (!onOwnSide) continue;
                }
                uint16 dist = _manhattan(ctx.pos, candidate);
                if (!found || dist < bestDist) {
                    pos = candidate;
                    bestDist = dist;
                    found = true;
                }
            }
            if (found) return (pos, true);
        }
    }

    // True when this ship is already standing on a scoring tile with no
    // enemy in range from here (caller guarantees the latter — the
    // free-shoot check already failed) and should therefore just hold
    // position instead of being lured away by "seek a scoring tile"/
    // "approach the enemy" movement logic. Overridden only when ALL of:
    // this ship could actually reach a shot by moving anyway, another
    // living ally could reach this tile itself if this ship leaves, and no
    // enemy is currently positioned to threaten the tile — i.e. leaving is
    // genuinely free. Any one of those failing means hold.
    function _shouldHoldScoringTile(Ctx memory ctx) private view returns (bool) {
        if (!_isScoringTile(ctx.scoringPositions, ctx.pos)) return false;

        (Position memory enemyPos, bool enemyFound) = _nearestEnemyPosition(
            ctx,
            false
        );
        if (enemyFound) {
            Position memory stepped = _stepToward(
                ctx.pos,
                enemyPos,
                ctx.attrs.movement
            );
            (, bool couldShoot) = _bestEnemyInRange(
                ctx,
                stepped,
                ctx.attrs.range
            );
            if (
                couldShoot &&
                _allyCanCoverTile(ctx) &&
                !_enemyThreatensTile(ctx, ctx.pos)
            ) {
                return false;
            }
        }
        return true;
    }

    // Any other living ally that could reach this position under its own
    // movement stat this turn — used to decide whether it's safe for the
    // ship currently on the tile to leave it uncovered.
    function _allyCanCoverTile(
        Ctx memory ctx
    ) private view returns (bool) {
        for (uint i = 0; i < ctx.g.shipPositions.length; i++) {
            ShipPosition memory sp = ctx.g.shipPositions[i];
            if (sp.shipId == ctx.shipId || sp.status != 0 || sp.isCreator)
                continue; // own side only, not self
            // sp.status == 0 already checked above (G-01) — direct index read.
            Attributes memory attrs = ctx.g.shipAttributes[i];
            if (_manhattan(sp.position, ctx.pos) <= attrs.movement)
                return true;
        }
        return false;
    }

    // Any living enemy whose weapon range (with LOS) already reaches the
    // given tile from its current position — used to decide whether a tile
    // is actually safe to leave uncovered.
    function _enemyThreatensTile(
        Ctx memory ctx,
        Position memory tilePos
    ) private view returns (bool) {
        for (uint i = 0; i < ctx.g.shipPositions.length; i++) {
            ShipPosition memory sp = ctx.g.shipPositions[i];
            if (sp.status != 0 || !sp.isCreator) continue;
            // sp.status == 0 already checked above (G-01) — direct index read.
            Attributes memory attrs = ctx.g.shipAttributes[i];
            uint16 dist = _manhattan(sp.position, tilePos);
            if (dist > attrs.range) continue;
            if (
                dist > 1 &&
                !ctx.maps.hasMaps(
                    ctx.gameId,
                    sp.position.row,
                    sp.position.col,
                    tilePos.row,
                    tilePos.col
                )
            ) continue;
            return true;
        }
        return false;
    }

    function _holdDecision(
        Ctx memory ctx
    ) private pure returns (Decision memory d) {
        d.destRow = ctx.pos.row;
        d.destCol = ctx.pos.col;
        d.action = ActionType.Pass;
    }

    // Shared fallback movement step used by every archetype whose primary
    // directive (shoot, heal, retreat) didn't produce a decision this turn:
    // close on the nearest enemy, but only follow through on that step if it
    // would actually bring an enemy into range this turn — otherwise
    // redirect the move toward a scoring tile instead, since walking toward
    // an enemy that stays out of reach anyway makes no more progress than
    // walking toward the objective. Falls back to the enemy-directed step if
    // no scoring tile exists on the map at all (or enemyFound is false and
    // there's no tile either, in which case this just holds position).
    function _approachOrSeekTile(
        Ctx memory ctx,
        Position memory enemyPos,
        bool enemyFound
    ) private view returns (Decision memory d) {
        d.destRow = ctx.pos.row;
        d.destCol = ctx.pos.col;
        d.action = ActionType.Pass;

        Position memory towardEnemy = ctx.pos;
        if (enemyFound) {
            towardEnemy = _stepToward(ctx.pos, enemyPos, ctx.attrs.movement);
            (uint target, bool found) = _bestEnemyInRange(
                ctx,
                towardEnemy,
                ctx.attrs.range
            );
            if (found) {
                d.destRow = towardEnemy.row;
                d.destCol = towardEnemy.col;
                d.action = ActionType.Shoot;
                d.actionTarget = target;
                return d;
            }
        }

        (Position memory tilePos, bool tileFound) = _bestScoringTile(ctx);
        if (tileFound) {
            Position memory towardTile = _stepToward(
                ctx.pos,
                tilePos,
                ctx.attrs.movement
            );
            d.destRow = towardTile.row;
            d.destCol = towardTile.col;
            return d;
        }

        if (enemyFound) {
            d.destRow = towardEnemy.row;
            d.destCol = towardEnemy.col;
        }
    }

    // Greedy axis-priority step toward target, clamped to movement budget.
    // Covers as much of the larger-delta axis as the budget allows first,
    // then spends any remainder on the other axis — the resulting point is
    // always within movement of `from` (a legal moveShip destination) and
    // strictly closer to `to`. Does not check grid bounds or occupancy
    // (see this file's header comment) — `to` is always an existing,
    // in-bounds ship/tile position, and moving partway toward an in-bounds
    // point from an in-bounds point stays in bounds.
    function _stepToward(
        Position memory from,
        Position memory to,
        uint8 movement
    ) private pure returns (Position memory) {
        int16 rowDelta = to.row - from.row;
        int16 colDelta = to.col - from.col;
        // Grid coordinates are tiny (rows 0-10, cols 0-16), so these deltas
        // are always well within int16 range — negating them can't overflow.
        uint16 rowDist = rowDelta < 0 ? uint16(-rowDelta) : uint16(rowDelta);
        uint16 colDist = colDelta < 0 ? uint16(-colDelta) : uint16(colDelta);

        uint16 budget = movement;
        int16 rowStep;
        int16 colStep;
        if (rowDist >= colDist) {
            uint16 useRow = rowDist < budget ? rowDist : budget;
            rowStep = rowDelta < 0 ? -int16(useRow) : int16(useRow);
            budget -= useRow;
            uint16 useCol = colDist < budget ? colDist : budget;
            colStep = colDelta < 0 ? -int16(useCol) : int16(useCol);
        } else {
            uint16 useCol = colDist < budget ? colDist : budget;
            colStep = colDelta < 0 ? -int16(useCol) : int16(useCol);
            budget -= useCol;
            uint16 useRow = rowDist < budget ? rowDist : budget;
            rowStep = rowDelta < 0 ? -int16(useRow) : int16(useRow);
        }
        return Position({row: from.row + rowStep, col: from.col + colStep});
    }

    // Same idea, opposite direction, clamped to the grid (retreating can
    // run off the board, unlike stepping toward an existing in-bounds
    // target).
    function _stepAway(
        Position memory from,
        Position memory threat,
        uint8 movement,
        int16 gridHeight,
        int16 gridWidth
    ) private pure returns (Position memory) {
        // Mirror threat through `from` to get an "away" target point, then
        // reuse _stepToward's budget-allocation logic toward that point.
        int16 awayRow = from.row + (from.row - threat.row);
        int16 awayCol = from.col + (from.col - threat.col);
        if (awayRow < 0) awayRow = 0;
        if (awayRow >= gridHeight) awayRow = gridHeight - 1;
        if (awayCol < 0) awayCol = 0;
        if (awayCol >= gridWidth) awayCol = gridWidth - 1;
        return
            _stepToward(from, Position({row: awayRow, col: awayCol}), movement);
    }

    // ---- per-archetype rule lists ----

    // Grunt & Aggressor share this v1: shoot from here if anything's in
    // range, else close distance if that would actually bring an enemy into
    // range this turn, else redirect toward a scoring tile (see
    // _approachOrSeekTile) — a direct generalization of the original v0
    // script's "adjacent enemy: fire; else step left and fire if now
    // adjacent" shape, just toward the nearest enemy instead of a fixed
    // direction. _bestEnemyInRange already focuses the weakest/on-tile
    // target, which covers the "prioritize kills" intent for both without
    // inventing a fake distinction between the two.
    function decideEngageOrApproach(
        Ctx memory ctx
    ) internal view returns (Decision memory d) {
        (uint target, bool found) = _bestEnemyInRange(
            ctx,
            ctx.pos,
            ctx.attrs.range
        );
        if (found) {
            d.destRow = ctx.pos.row;
            d.destCol = ctx.pos.col;
            d.action = ActionType.Shoot;
            d.actionTarget = target;
            return d;
        }

        if (_shouldHoldScoringTile(ctx)) return _holdDecision(ctx);

        (Position memory enemyPos, bool enemyFound) = _nearestEnemyPosition(
            ctx,
            false
        );
        return _approachOrSeekTile(ctx, enemyPos, enemyFound);
    }

    // Shoots from range without moving when possible; retreats (steps away
    // from the nearest enemy) rather than staying adjacent to engage. When
    // out of range entirely, closes the gap only if that would bring an
    // enemy into range this turn, else redirects toward a scoring tile (see
    // _approachOrSeekTile) — the Sniper archetype is always equipped with
    // the long-range MainWeapon.Sniper, so this naturally biases it toward
    // tiles on its own side. (Two different "Sniper"s: Archetype.Sniper is
    // this AI behavior tag; MainWeapon.Sniper is the weapon it wields.)
    function decideSniper(
        Ctx memory ctx
    ) internal view returns (Decision memory d) {
        (Position memory enemyPos, bool enemyFound) = _nearestEnemyPosition(
            ctx,
            false
        );
        if (!enemyFound) {
            if (_shouldHoldScoringTile(ctx)) return _holdDecision(ctx);
            return _approachOrSeekTile(ctx, enemyPos, false);
        }
        uint16 dist = _manhattan(ctx.pos, enemyPos);

        if (dist > 1) {
            (uint target, bool found) = _bestEnemyInRange(
                ctx,
                ctx.pos,
                ctx.attrs.range
            );
            if (found) {
                d.destRow = ctx.pos.row;
                d.destCol = ctx.pos.col;
                d.action = ActionType.Shoot;
                d.actionTarget = target;
                return d;
            }
            if (_shouldHoldScoringTile(ctx)) return _holdDecision(ctx);
            return _approachOrSeekTile(ctx, enemyPos, true);
        }

        // adjacent to an enemy: retreat rather than engage
        d.action = ActionType.Pass;
        Position memory awayPos = _stepAway(
            ctx.pos,
            enemyPos,
            ctx.attrs.movement,
            ctx.gridHeight,
            ctx.gridWidth
        );
        d.destRow = awayPos.row;
        d.destCol = awayPos.col;
    }

    // ---- toolbox for the per-variant trees (Variant1AI / Variant2AI) ----
    // Small, cheap primitives each faction's tree composes; what a faction
    // DOES with them (kite vs brawl, which special is a heal, whether it can
    // ram) is that faction's own knowledge and lives in its contract.

    function decision(
        Position memory dest,
        ActionType action,
        uint target
    ) internal pure returns (Decision memory d) {
        d.destRow = dest.row;
        d.destCol = dest.col;
        d.action = action;
        d.actionTarget = target;
    }

    function hold(Ctx memory ctx) internal pure returns (Decision memory) {
        return _holdDecision(ctx);
    }

    function nearestEnemy(
        Ctx memory ctx
    ) internal pure returns (Position memory pos, bool found) {
        return _nearestEnemyPosition(ctx, false);
    }

    function onScoringTile(Ctx memory ctx) internal pure returns (bool) {
        return _isScoringTile(ctx.scoringPositions, ctx.pos);
    }

    // Already on a scoring tile and leaving it isn't free (see
    // _shouldHoldScoringTile) — the caller should stay put.
    function shouldHoldTile(Ctx memory ctx) internal view returns (bool) {
        return _shouldHoldScoringTile(ctx);
    }

    // Nothing on the board to fight: hold a tile we're already on, else head
    // for an objective.
    function idleOrSeekTile(
        Ctx memory ctx
    ) internal view returns (Decision memory) {
        if (_shouldHoldScoringTile(ctx)) return _holdDecision(ctx);
        return _approachOrSeekTile(ctx, ctx.pos, false);
    }

    // Close in on an enemy only as far as it brings a shot into range,
    // otherwise head for an objective (see _approachOrSeekTile).
    function approachOrSeekTile(
        Ctx memory ctx,
        Position memory enemyPos
    ) internal view returns (Decision memory) {
        return _approachOrSeekTile(ctx, enemyPos, true);
    }

    function bestEnemyWithin(
        Ctx memory ctx,
        Position memory from,
        uint8 range,
        bool needsLineOfSight
    ) internal view returns (uint targetId, bool found) {
        return _bestEnemyWithin(ctx, from, range, needsLineOfSight);
    }

    function stepToward(
        Position memory from,
        Position memory to,
        uint8 budget
    ) internal pure returns (Position memory) {
        return _stepToward(from, to, budget);
    }

    function _min8(uint16 a, uint8 b) private pure returns (uint8) {
        return a < b ? uint8(a) : b;
    }

    // Close on `target` at up to `maxSteps`, but never onto (or past) its tile:
    // stop adjacent at the nearest, and back off one step at a time if the
    // landing square is already taken. Stays put if there is no free square.
    function advanceToward(
        Ctx memory ctx,
        Position memory target,
        uint8 maxSteps
    ) internal pure returns (Position memory dest) {
        uint16 dist = _manhattan(ctx.pos, target);
        if (dist <= 1) return ctx.pos;
        uint8 steps = _min8(dist - 1, maxSteps);
        while (steps > 0) {
            dest = _stepToward(ctx.pos, target, steps);
            if (!_isOccupiedByOther(ctx, dest)) return dest;
            steps--;
        }
        return ctx.pos;
    }

    // Where to stand to shoot the nearest enemy from as far away as this
    // ship's range allows: out of range -> step toward it, but only as far
    // as reaches maximum range (not all the way in); already inside range
    // -> back away (if allowed) toward maximum range. A blocked destination
    // means "stay put".
    function standoffPosition(
        Ctx memory ctx,
        Position memory enemyPos,
        bool allowRetreat
    ) internal pure returns (Position memory stand) {
        uint16 d = _manhattan(ctx.pos, enemyPos);
        uint8 range = ctx.attrs.range;
        if (d > range) {
            stand = _stepToward(
                ctx.pos,
                enemyPos,
                _min8(d - range, ctx.attrs.movement)
            );
        } else if (allowRetreat) {
            uint8 budget = _min8(range - d, ctx.attrs.movement);
            if (budget == 0) return ctx.pos;
            stand = _retreatStep(ctx, enemyPos, budget);
        } else {
            return ctx.pos;
        }
        if (_isOccupiedByOther(ctx, stand)) return ctx.pos;
    }

    // Spend up to `budget` steps moving directly away from `threat` (every step
    // along either axis away from it adds one tile of distance), taking the
    // axis with the larger separation first and the other if that one runs
    // into the edge of the grid. Unlike _stepAway (which only mirrors the
    // threat through the ship, so it can retreat no farther than the current
    // distance), this uses the whole budget — that is what lets a ship back
    // all the way out to its maximum range.
    function _retreatStep(
        Ctx memory ctx,
        Position memory threat,
        uint8 budget
    ) private pure returns (Position memory p) {
        // A COPY: memory structs are references, and mutating ctx.pos itself
        // would corrupt every later read of this ship's own position.
        p = Position({row: ctx.pos.row, col: ctx.pos.col});
        int16 dRow = p.row - threat.row;
        int16 dCol = p.col - threat.col;
        bool rowFirst = (dRow < 0 ? -dRow : dRow) >= (dCol < 0 ? -dCol : dCol);
        for (uint pass = 0; pass < 2 && budget > 0; pass++) {
            bool useRow = (pass == 0) == rowFirst;
            int16 pos = useRow ? p.row : p.col;
            int16 delta = useRow ? dRow : dCol;
            int16 limit = useRow ? ctx.gridHeight : ctx.gridWidth;
            // Away from the threat along this axis; if level with it, toward
            // whichever side of the grid has more room.
            int16 dir = delta > 0 ? int16(1) : delta < 0
                ? int16(-1)
                : (pos < limit / 2 ? int16(1) : int16(-1));
            int16 room = dir > 0 ? limit - 1 - pos : pos;
            uint8 use = uint8(uint16(room)) < budget ? uint8(uint16(room)) : budget;
            if (use == 0) continue;
            if (useRow) p.row += dir * int16(uint16(use));
            else p.col += dir * int16(uint16(use));
            budget -= use;
        }
    }

    // Tally of the live ships within `range` of `center` (excluding this
    // one), for area specials: how many enemies, how many of them are
    // finishable (already at 0 HP or with their reactor timer at 2+), and
    // how many allies are in it / already near destruction themselves.
    struct Sweep {
        uint enemies;
        uint finishableEnemies;
        uint allies;
        uint alliesAtRisk;
    }

    function sweep(
        Ctx memory ctx,
        Position memory center,
        uint8 range
    ) internal pure returns (Sweep memory s) {
        for (uint i = 0; i < ctx.g.shipPositions.length; i++) {
            ShipPosition memory sp = ctx.g.shipPositions[i];
            if (sp.shipId == ctx.shipId || sp.status != 0) continue;
            if (_manhattan(center, sp.position) > range) continue;
            // sp.status == 0 already checked above (G-01) — direct index read.
            Attributes memory a = ctx.g.shipAttributes[i];
            if (sp.isCreator) {
                s.enemies++;
                if (a.hullPoints == 0 || a.reactorCriticalTimer >= 2) {
                    s.finishableEnemies++;
                }
            } else {
                s.allies++;
                if (a.reactorCriticalTimer >= 2) s.alliesAtRisk++;
            }
        }
    }

    // Nearest enemy already at 0 HP (a downed ship still on the board).
    function nearestDownedEnemy(
        Ctx memory ctx
    ) internal pure returns (uint id, Position memory pos, bool found) {
        uint16 bestDist = type(uint16).max;
        for (uint i = 0; i < ctx.g.shipPositions.length; i++) {
            ShipPosition memory sp = ctx.g.shipPositions[i];
            if (sp.status != 0 || !sp.isCreator) continue;
            // sp.status == 0 already checked above (G-01) — direct index read.
            if (ctx.g.shipAttributes[i].hullPoints != 0) continue;
            uint16 dist = _manhattan(ctx.pos, sp.position);
            if (!found || dist < bestDist) {
                id = sp.shipId;
                pos = sp.position;
                found = true;
                bestDist = dist;
            }
        }
    }

    // An enemy within `range` of `from` whose reactor timer is already at 2+:
    // one more tick destroys it, whatever its hull.
    function doomedEnemyWithin(
        Ctx memory ctx,
        Position memory from,
        uint8 range
    ) internal pure returns (uint id, bool found) {
        for (uint i = 0; i < ctx.g.shipPositions.length; i++) {
            ShipPosition memory sp = ctx.g.shipPositions[i];
            if (sp.status != 0 || !sp.isCreator) continue;
            if (_manhattan(from, sp.position) > range) continue;
            // sp.status == 0 already checked above (G-01) — direct index read.
            if (ctx.g.shipAttributes[i].reactorCriticalTimer >= 2) {
                return (sp.shipId, true);
            }
        }
    }

    // Heal the most injured ally this ship can reach THIS turn: if one is
    // already within `range` heal from here, else move just far enough to
    // bring the healer's range onto it and heal from there. HOW a faction
    // heals (an equipped special, a faction ability) and with what range is
    // that faction's own knowledge — it passes both in. healed == false
    // (and an unused Decision) if no injured ally is reachable.
    function healWithReach(
        Ctx memory ctx,
        uint8 range,
        ActionType healAction
    ) internal pure returns (Decision memory d, bool healed) {
        (uint allyId, Position memory allyPos, bool found) = _reachableAlly(
            ctx,
            range
        );
        if (!found) return (d, false);
        return (
            decision(_withinRangeOf(ctx, allyPos, range), healAction, allyId),
            true
        );
    }

    // The injured ally (0-HP preferred, then lowest HP) within `range` plus
    // this ship's movement — i.e. one it can heal this turn.
    function _reachableAlly(
        Ctx memory ctx,
        uint8 range
    ) private pure returns (uint id, Position memory pos, bool found) {
        uint16 reach = uint16(range) + ctx.attrs.movement;
        (id, found) = _bestAllyToHeal(
            ctx,
            reach > type(uint8).max ? type(uint8).max : uint8(reach)
        );
        if (!found) return (id, pos, false);
        (pos, found) = findPosition(ctx.g, id);
    }

    // Stay put if `target` is already within `range`, otherwise step toward
    // it just far enough to bring it within `range` (never past movement).
    function _withinRangeOf(
        Ctx memory ctx,
        Position memory target,
        uint8 range
    ) private pure returns (Position memory) {
        uint16 dist = _manhattan(ctx.pos, target);
        if (dist <= range) return ctx.pos;
        return _stepToward(ctx.pos, target, _min8(dist - range, ctx.attrs.movement));
    }

    // The Support archetype's tree once its variant-specific healing step
    // (see healWithReach) found nothing to heal: shoots an enemy in range —
    // a free action from the current position, never skipped in favor of
    // moving. Otherwise seeks an unclaimed scoring tile first (the
    // objective matters more than positioning near an ally that isn't hurt
    // yet), falling back to closing toward whichever ally most needs
    // staying in healing range of if no scoring tile exists on the map.
    function decideSupportFallback(
        Ctx memory ctx
    ) internal view returns (Decision memory d) {
        d.destRow = ctx.pos.row;
        d.destCol = ctx.pos.col;
        d.action = ActionType.Pass;

        (uint target, bool found) = _bestEnemyInRange(
            ctx,
            ctx.pos,
            ctx.attrs.range
        );
        if (found) {
            d.action = ActionType.Shoot;
            d.actionTarget = target;
            return d;
        }

        if (_shouldHoldScoringTile(ctx)) return d; // already Pass-at-current-pos

        (Position memory dest, bool destFound) = _bestScoringTile(ctx);
        if (!destFound) {
            // No scoring tile on this map: fall back to staying useful near
            // whichever ally is most injured.
            (uint allyTarget, bool allyFound) = _bestAllyToHeal(
                ctx,
                type(uint8).max
            );
            if (!allyFound) return d;
            (dest, destFound) = findPosition(ctx.g, allyTarget);
            if (!destFound) return d;
        }

        Position memory newPos = _stepToward(
            ctx.pos,
            dest,
            ctx.attrs.movement
        );
        d.destRow = newPos.row;
        d.destCol = newPos.col;
    }

    // Holds/seeks unclaimed scoring tiles (weapon-range-biased, see
    // _bestScoringTile); shoots opportunistically from wherever it ends up
    // if an enemy is in range from the current position (never gives up a
    // free shot just to move toward a tile).
    function decideTurtle(
        Ctx memory ctx
    ) internal view returns (Decision memory d) {
        d.destRow = ctx.pos.row;
        d.destCol = ctx.pos.col;
        d.action = ActionType.Pass;

        (uint target, bool found) = _bestEnemyInRange(
            ctx,
            ctx.pos,
            ctx.attrs.range
        );
        if (found) {
            d.action = ActionType.Shoot;
            d.actionTarget = target;
            return d;
        }

        if (_shouldHoldScoringTile(ctx)) return d; // already Pass-at-current-pos

        (Position memory tilePos, bool tileFound) = _bestScoringTile(ctx);
        if (!tileFound) return d;

        // The best available tile may already be held by another ship
        // (everything else on the map is claimed) — standing exactly on it
        // is an illegal move anyway, so once within 1 tile just hold there
        // rather than endlessly retrying the last step.
        if (
            _isOccupiedByOther(ctx, tilePos) &&
            _manhattan(ctx.pos, tilePos) <= 1
        ) {
            return d;
        }

        Position memory newPos = _stepToward(
            ctx.pos,
            tilePos,
            ctx.attrs.movement
        );
        d.destRow = newPos.row;
        d.destCol = newPos.col;
    }

    // ---- objective-first toolbox (ram-on-objective, heal priorities) ----

    // A tile this ship can legally end its move on: reachable within its
    // movement, in bounds, and not occupied by another ship (the same three
    // rules Game.moveShip enforces — blocked tiles only affect line of sight,
    // not movement). `scoring` marks a scoring tile.
    struct Stand {
        Position pos;
        bool found;
        bool scoring;
        uint16 dist;
    }

    // The best tile within `range` of `target` that this ship can move to
    // THIS turn (staying put counts): a scoring tile beats a plain one, then
    // the shortest move. found == false if every such tile is out of reach,
    // off the grid, or occupied.
    function _standTile(
        Ctx memory ctx,
        Position memory target,
        uint8 range
    ) private pure returns (Stand memory s) {
        int16 r = int16(uint16(range));
        for (int16 dr = -r; dr <= r; dr++) {
            int16 rem = r - (dr < 0 ? -dr : dr);
            for (int16 dc = -rem; dc <= rem; dc++) {
                _offerStand(
                    ctx,
                    s,
                    Position({row: target.row + dr, col: target.col + dc})
                );
            }
        }
    }

    function _offerStand(
        Ctx memory ctx,
        Stand memory s,
        Position memory t
    ) private pure {
        if (
            t.row < 0 ||
            t.col < 0 ||
            t.row >= ctx.gridHeight ||
            t.col >= ctx.gridWidth
        ) return;
        uint16 dist = _manhattan(ctx.pos, t);
        if (dist > ctx.attrs.movement) return;
        if (dist != 0 && _isOccupiedByOther(ctx, t)) return;
        bool scoring = _isScoringTile(ctx.scoringPositions, t);
        if (
            !s.found ||
            (scoring && !s.scoring) ||
            (scoring == s.scoring && dist < s.dist)
        ) {
            s.pos = t;
            s.found = true;
            s.scoring = scoring;
            s.dist = dist;
        }
    }

    // Ram, for EVERY variant-1 ship: an enemy that is at 0 HP AND standing on
    // a scoring tile is worth evicting (the rammer takes the tile). Finds the
    // nearest such enemy this ship can ram this turn — moving to a free tile
    // within `ramRange` of it if needed. The caller decides whether its own
    // reactor timer can afford the tick a ram costs.
    function ramOnScoringTile(
        Ctx memory ctx,
        uint8 ramRange
    ) internal pure returns (Decision memory d, bool found) {
        uint16 bestDist = type(uint16).max;
        for (uint i = 0; i < ctx.g.shipPositions.length; i++) {
            ShipPosition memory sp = ctx.g.shipPositions[i];
            if (sp.status != 0 || !sp.isCreator) continue;
            // sp.status == 0 already checked above (G-01) — direct index read.
            if (ctx.g.shipAttributes[i].hullPoints != 0) continue;
            if (!_isScoringTile(ctx.scoringPositions, sp.position)) continue;
            uint16 dist = _manhattan(ctx.pos, sp.position);
            if (found && dist >= bestDist) continue;
            Stand memory s = _standTile(ctx, sp.position, ramRange);
            if (!s.found) continue;
            d = decision(s.pos, ActionType.FactionAbility, sp.shipId);
            bestDist = dist;
            found = true;
        }
    }

    // Which ships a heal may pick and whether the healer may move to reach
    // them (see _planHeal).
    struct HealFilter {
        bool scoringOnly; // target must stand on a scoring tile
        bool disabledOnly; // target must be at 0 HP
        bool includeSelf; // the healer itself is a candidate
        bool canMove; // may step to a free tile within range of the target
    }

    // The injured friendly ship to heal, by priority: disabled (0 HP) first,
    // then lowest HP. With `canMove` the healer may travel to a free tile
    // within `range` of the target (stand = that tile); otherwise the target
    // must already be within `range` of `from`.
    function _planHeal(
        Ctx memory ctx,
        Position memory from,
        uint8 range,
        HealFilter memory f
    ) private pure returns (uint id, Position memory stand, bool found) {
        uint8 bestHp;
        bool bestDisabled;
        for (uint i = 0; i < ctx.g.shipPositions.length; i++) {
            (bool ok, Position memory at) = _healCandidate(
                ctx,
                i,
                from,
                range,
                f
            );
            if (!ok) continue;
            // sp.status == 0 was checked in _healCandidate (G-01).
            uint8 hp = ctx.g.shipAttributes[i].hullPoints;
            bool disabled = hp == 0;
            if (
                found &&
                !((disabled && !bestDisabled) ||
                    (disabled == bestDisabled && hp < bestHp))
            ) continue;
            id = ctx.g.shipPositions[i].shipId;
            stand = at;
            found = true;
            bestHp = hp;
            bestDisabled = disabled;
        }
    }

    // Whether ship index `i` is a legal heal target under filter `f`, and
    // where the healer would stand to heal it.
    function _healCandidate(
        Ctx memory ctx,
        uint i,
        Position memory from,
        uint8 range,
        HealFilter memory f
    ) private pure returns (bool ok, Position memory at) {
        ShipPosition memory sp = ctx.g.shipPositions[i];
        if (sp.status != 0 || sp.isCreator) return (false, at); // own side only
        bool isSelf = sp.shipId == ctx.shipId;
        if (isSelf && !f.includeSelf) return (false, at);
        // sp.status == 0 already checked above (G-01) — direct index read.
        Attributes memory a = ctx.g.shipAttributes[i];
        if (a.hullPoints >= a.maxHullPoints) return (false, at); // not injured
        if (f.disabledOnly && a.hullPoints != 0) return (false, at);
        if (f.scoringOnly && !_isScoringTile(ctx.scoringPositions, sp.position))
            return (false, at);
        if (f.canMove) {
            Stand memory s = _standTile(ctx, sp.position, range);
            return (s.found, s.pos);
        }
        // A ship is always within range of itself, wherever it ends up.
        if (!isSelf && _manhattan(from, sp.position) > range) return (false, at);
        return (true, from);
    }

    function _healDecision(
        Ctx memory ctx,
        Position memory from,
        uint8 range,
        ActionType healAction,
        HealFilter memory f
    ) private pure returns (Decision memory d, bool healed) {
        (uint id, Position memory stand, bool found) = _planHeal(
            ctx,
            from,
            range,
            f
        );
        if (!found) return (d, false);
        return (decision(stand, healAction, id), true);
    }

    // Faction-2 heal priority 1: an injured OR disabled friendly ship (not
    // this one) standing on a scoring tile — moving within `range` of it if
    // needed (onto a scoring tile of its own when it can).
    function healOnScoringTile(
        Ctx memory ctx,
        uint8 range,
        ActionType healAction
    ) internal pure returns (Decision memory, bool) {
        return
            _healDecision(
                ctx,
                ctx.pos,
                range,
                healAction,
                HealFilter(true, false, false, true)
            );
    }

    // Faction-2 heal priority 3, standing where it is (the objective step
    // has already fixed where the ship ends up): a disabled friendly ship
    // within `range` of `from`.
    function healDisabledFrom(
        Ctx memory ctx,
        Position memory from,
        uint8 range,
        ActionType healAction
    ) internal pure returns (Decision memory, bool) {
        return
            _healDecision(
                ctx,
                from,
                range,
                healAction,
                HealFilter(false, true, false, false)
            );
    }

    // Faction-2 heal priority 3 when the ship has no objective to claim: a
    // disabled friendly ship it can reach this turn, moving to do so.
    function healDisabledWithReach(
        Ctx memory ctx,
        uint8 range,
        ActionType healAction
    ) internal pure returns (Decision memory, bool) {
        return
            _healDecision(
                ctx,
                ctx.pos,
                range,
                healAction,
                HealFilter(false, true, false, true)
            );
    }

    // Faction-2 heal, last resort: this ship itself or any injured friendly
    // ship within `range` of where the ship is about to stand (`from`).
    function healAnyFrom(
        Ctx memory ctx,
        Position memory from,
        uint8 range,
        ActionType healAction
    ) internal pure returns (Decision memory, bool) {
        return
            _healDecision(
                ctx,
                from,
                range,
                healAction,
                HealFilter(false, false, true, false)
            );
    }

    // Step toward `target` with the full movement budget, landing on the
    // nearest free square along the way (the target tile itself included).
    function _moveToward(
        Ctx memory ctx,
        Position memory target
    ) private pure returns (Position memory) {
        uint8 steps = _min8(_manhattan(ctx.pos, target), ctx.attrs.movement);
        while (steps > 0) {
            Position memory dest = _stepToward(ctx.pos, target, steps);
            if (!_isOccupiedByOther(ctx, dest)) return dest;
            steps--;
        }
        return ctx.pos;
    }

    // The objective step: standing on a scoring tile already -> stay
    // (objective == true, stand == here); else if an UNCLAIMED scoring tile
    // exists -> head for it at full speed (objective == true, stand == where
    // that lands); else there is nothing to claim (objective == false).
    function claimScoringTile(
        Ctx memory ctx
    ) internal pure returns (Position memory stand, bool objective) {
        if (_isScoringTile(ctx.scoringPositions, ctx.pos)) {
            return (ctx.pos, true);
        }
        (Position memory tile, bool found) = _bestScoringTile(ctx);
        if (!found || _isOccupiedByOther(ctx, tile)) return (ctx.pos, false);
        return (_moveToward(ctx, tile), true);
    }
}
