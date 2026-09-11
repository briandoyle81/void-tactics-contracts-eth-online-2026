// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.28;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/Strings.sol";
import {BaseHook} from "@uniswap/v4-periphery/src/utils/BaseHook.sol";
import {Hooks} from "@uniswap/v4-core/src/libraries/Hooks.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolId} from "@uniswap/v4-core/src/types/PoolId.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {BalanceDelta, BalanceDeltaLibrary} from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import {BeforeSwapDelta} from "@uniswap/v4-core/src/types/BeforeSwapDelta.sol";
import {SwapParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import "./IShips.sol";
import "./IRandomManager.sol";
import "./Types.sol";

// UTCLotteryHook — the pool + lottery half of the Uniswap pick
// (docs/eth-global-remote-strategy-v2.md, Pick 3). No fee-to-treasury, no
// active peg defense — both were considered and rejected on their own
// merits (see the strategy doc). This hook does exactly one thing: every
// UTC->native ("sell") swap on the one pool it's bound to earns the seller
// weighted entry into a periodic drawing for a prize ship, funded by nothing
// but chance — no funds are taken, no swap economics are altered.
//
// Direction: currency0 is always the native token (Currency.wrap(address(0))
// sorts below every real token address per CurrencyLibrary's convention), so
// `!params.zeroForOne` unambiguously means "trader is providing UTC to the
// pool" — a sell. This is deliberately the *only* direction that earns
// entries: it's also exactly the trade direction that already defends the
// existing passive mint-arbitrage price ceiling (ShipPurchaser.tierPrices),
// so this reinforces that mechanic instead of competing with it, and does
// nothing for the (intentionally undefended) floor.
//
// Single-pool lock: a hook address is permissionless to reference from *any*
// pool someone else creates, not just the one this project intends — an
// attacker could otherwise point a throwaway pool (two tokens they fully
// control) at this same hook address and farm lottery entries for free,
// completely decoupled from real UTC/ETH activity. beforeInitialize is
// implemented purely to close that: it locks onto the first pool that
// initializes with this hook (and only if its currencies actually match the
// configured UTC/native pair), and reverts every later initialize attempt
// for any other pool. afterSwap independently re-checks the pool id anyway —
// cheap, and makes the invariant explicit at the point it actually matters.
contract UTCLotteryHook is BaseHook, Ownable {
    using BalanceDeltaLibrary for BalanceDelta;

    IShips public ships;
    IRandomManager public randomManager;
    address public immutable utcToken;

    bool public poolLocked;
    PoolId public lockedPoolId;

    // Minimum ETH proceeds (native-token side of the swap) a single sell
    // must clear to earn an entry, denominated in wei — deliberately in ETH,
    // not UTC, so a period of low UTC price can't make entries artificially
    // cheap. Not preset to a specific figure here; owner-configurable so it
    // can be set from real data once docs/UTC_Price_Prediction_10k_Players.md
    // is re-examined against the live ETH-denominated deployment (see the
    // strategy doc's open questions for this pick).
    uint256 public minEntryThresholdWei;

    uint256 public constant DRAW_INTERVAL = 24 hours;
    uint256 public lastDrawTime;
    uint256 public currentDrawId;

    // Weight = ETH proceeds of a qualifying sell (not raw UTC amount) — the
    // same figure the entry threshold is checked against, so a manipulated
    // or crashed UTC price can't inflate weight independent of real value
    // contributed. One accumulated weighted entry per address per draw, not
    // one entry per trade.
    mapping(uint256 => address[]) public drawParticipants;
    mapping(uint256 => mapping(address => bool)) public hasParticipated;
    mapping(uint256 => mapping(address => uint256)) public weightInDraw;
    mapping(uint256 => uint256) public totalWeightInDraw;
    mapping(uint256 => uint256) public drawRandomRequestId;
    mapping(uint256 => bool) public drawResolved;

    // "1-of-a-kind" resolved: each resolved draw hand-crafts its winner's
    // ship via Ships.createSpecificShip (not the generic random-rolled
    // createShips every other mint path uses), so the prize is a genuinely
    // distinct template, not just a random ship sharing a common
    // variant/tier with ones sold elsewhere. Provenance/distinctiveness
    // across repeated draws comes from the name, which embeds the draw id
    // ("Legendary Draw #N") — see _buildPrizeShip. The stat/equipment
    // template itself is owner-configurable (setPrizeTemplate) rather than
    // hardcoded, since exact loadout/flavor is a game-design call this
    // contract shouldn't make unilaterally; the constructor seeds a
    // reasonable top-tier default (max accuracy/hull/speed) so the contract
    // is usable before that call is ever made.
    struct PrizeTemplate {
        uint16 variant;
        Colors colors;
        uint8 accuracy;
        uint8 hull;
        uint8 speed;
        MainWeapon mainWeapon;
        Armor armor;
        Shields shields;
        Special special;
    }

    PrizeTemplate public prizeTemplate;

    event SellRecorded(
        uint256 indexed drawId,
        address indexed player,
        uint256 ethProceeds,
        uint256 playerWeightInDraw
    );
    event DrawStarted(uint256 indexed drawId, uint256 requestId, uint256 totalWeight);
    event DrawResolved(uint256 indexed drawId, address indexed winner);

    error NotOurPool();
    error PoolAlreadyLocked();
    error DrawAlreadyResolved(uint256 drawId);
    error DrawNotStarted(uint256 drawId);
    error NoParticipants(uint256 drawId);
    error InvalidPrizeVariant(uint16 variant);
    error ArmorAndShieldsBothSet();
    error InvalidPrizeStatTier();

    constructor(
        IPoolManager _poolManager,
        address _ships,
        address _randomManager,
        address _utcToken,
        address _initialOwner
    ) BaseHook(_poolManager) Ownable(_initialOwner) {
        ships = IShips(_ships);
        randomManager = IRandomManager(_randomManager);
        utcToken = _utcToken;
        lastDrawTime = block.timestamp;

        // Reasonable top-tier default so the contract is usable before
        // setPrizeTemplate is ever called — max stat tier (2, per
        // GenerateNewShip.getTierOfTrait) on all three, variant 1 (present
        // in every fixture/deploy this repo uses), no armor/shields/special
        // preference implied. Owner should still call setPrizeTemplate with
        // real flavor/equipment before this ever goes live.
        prizeTemplate = PrizeTemplate({
            variant: 1,
            colors: Colors({
                h1: 45,
                s1: 100,
                l1: 50,
                h2: 45,
                s2: 100,
                l2: 50,
                h3: 45,
                s3: 100,
                l3: 50
            }),
            accuracy: 2,
            hull: 2,
            speed: 2,
            mainWeapon: MainWeapon.Generic,
            armor: Armor.Heavy,
            // A ship can only have one of armor/shields, never both — see
            // DroneYard.sol's ArmorAndShieldsBothSet check, which this
            // contract's own setPrizeTemplate re-validates since
            // Ships.createSpecificShip doesn't enforce it itself.
            shields: Shields.None,
            special: Special.None
        });
    }

    function getHookPermissions()
        public
        pure
        override
        returns (Hooks.Permissions memory)
    {
        return
            Hooks.Permissions({
                beforeInitialize: true,
                afterInitialize: false,
                beforeAddLiquidity: false,
                afterAddLiquidity: false,
                beforeRemoveLiquidity: false,
                afterRemoveLiquidity: false,
                beforeSwap: false,
                afterSwap: true,
                beforeDonate: false,
                afterDonate: false,
                beforeSwapReturnDelta: false,
                afterSwapReturnDelta: false,
                afterAddLiquidityReturnDelta: false,
                afterRemoveLiquidityReturnDelta: false
            });
    }

    function _beforeInitialize(
        address,
        PoolKey calldata key,
        uint160
    ) internal override returns (bytes4) {
        if (poolLocked) {
            revert PoolAlreadyLocked();
        }
        if (
            Currency.unwrap(key.currency0) != address(0) ||
            Currency.unwrap(key.currency1) != utcToken
        ) {
            revert NotOurPool();
        }
        lockedPoolId = key.toId();
        poolLocked = true;
        return BaseHook.beforeInitialize.selector;
    }

    function _afterSwap(
        address,
        PoolKey calldata key,
        SwapParams calldata params,
        BalanceDelta delta,
        bytes calldata hookData
    ) internal override returns (bytes4, int128) {
        if (!poolLocked || PoolId.unwrap(key.toId()) != PoolId.unwrap(lockedPoolId)) {
            revert NotOurPool();
        }

        // Only the UTC->native direction earns entries. Buys (native->UTC)
        // are deliberately never recorded — see the file header.
        if (!params.zeroForOne) {
            (address player, bool valid) = _extractPlayer(hookData);
            if (valid) {
                _recordSell(player, delta);
            }
            // Deliberately not an error/revert if hookData is missing or
            // malformed: the swap itself must never fail because of this.
            // Worst case with no valid player, the trade just earns no
            // lottery entry — which is also exactly what happens before the
            // frontend/router is updated to pass hookData at all. See the
            // header comment on _extractPlayer for why sender/tx.origin are
            // deliberately not used as a fallback here.
        }

        _maybeStartDraw();

        return (BaseHook.afterSwap.selector, 0);
    }

    // The `sender` PoolManager passes to afterSwap is whatever contract
    // called swap() directly — in practice a router (e.g. Uniswap's
    // UniversalRouter), not the end trader, so it's useless for attributing
    // an entry to a real person. tx.origin was considered and rejected: it
    // misattributes any trade made through a smart-contract wallet (this
    // project already uses Dynamic for wallet auth, so that's a real case,
    // not a hypothetical), and is a well-known phishing-adjacent anti-pattern
    // besides. hookData is v4's own mechanism for exactly this — the
    // swap-initiating call (frontend via its router) is expected to pass the
    // real trader's address as `abi.encode(address)`, 32 bytes exactly.
    function _extractPlayer(
        bytes calldata hookData
    ) internal pure returns (address player, bool valid) {
        if (hookData.length != 32) {
            return (address(0), false);
        }
        player = abi.decode(hookData, (address));
        valid = player != address(0);
    }

    function _recordSell(address _player, BalanceDelta _delta) internal {
        int128 rawAmount0 = _delta.amount0();
        uint256 ethProceeds = uint256(
            uint128(rawAmount0 < 0 ? -rawAmount0 : rawAmount0)
        );

        if (ethProceeds < minEntryThresholdWei) {
            return;
        }

        uint256 drawId = currentDrawId;
        if (!hasParticipated[drawId][_player]) {
            hasParticipated[drawId][_player] = true;
            drawParticipants[drawId].push(_player);
        }
        weightInDraw[drawId][_player] += ethProceeds;
        totalWeightInDraw[drawId] += ethProceeds;

        emit SellRecorded(drawId, _player, ethProceeds, weightInDraw[drawId][_player]);
    }

    function _maybeStartDraw() internal {
        uint256 drawId = currentDrawId;
        if (
            block.timestamp < lastDrawTime + DRAW_INTERVAL ||
            totalWeightInDraw[drawId] == 0
        ) {
            return;
        }

        uint256 requestId = randomManager.requestRandomness();
        drawRandomRequestId[drawId] = requestId;
        lastDrawTime = block.timestamp;
        currentDrawId = drawId + 1;

        emit DrawStarted(drawId, requestId, totalWeightInDraw[drawId]);
    }

    // Permissionless, like Tournament.buildBracket — anyone can trigger
    // resolution once RandomManager's entropy window has opened; reverts
    // TooSoonToReveal (from RandomManager itself) if called too early.
    function resolveDraw(uint256 _drawId) external {
        if (drawResolved[_drawId]) {
            revert DrawAlreadyResolved(_drawId);
        }
        uint256 requestId = drawRandomRequestId[_drawId];
        if (requestId == 0) {
            revert DrawNotStarted(_drawId);
        }
        uint256 totalWeight = totalWeightInDraw[_drawId];
        address[] storage participants = drawParticipants[_drawId];
        if (totalWeight == 0 || participants.length == 0) {
            revert NoParticipants(_drawId);
        }

        uint64 randomness = randomManager.fulfillRandomRequest(requestId);
        uint256 target = uint256(randomness) % totalWeight;

        address winner = participants[participants.length - 1];
        uint256 cumulative;
        for (uint256 i = 0; i < participants.length; i++) {
            cumulative += weightInDraw[_drawId][participants[i]];
            if (target < cumulative) {
                winner = participants[i];
                break;
            }
        }

        drawResolved[_drawId] = true;
        ships.createSpecificShip(winner, _buildPrizeShip(_drawId));

        emit DrawResolved(_drawId, winner);
    }

    // Hand-crafts this draw's prize from the owner-configured template,
    // rather than going through the generic random-rolled createShips path
    // every other mint route in this repo uses — see the PrizeTemplate
    // comment above for why. The name embeds the draw id so winners across
    // different draws are provably distinct from each other, not just from
    // ordinary ships.
    function _buildPrizeShip(
        uint256 _drawId
    ) internal view returns (Ship memory) {
        PrizeTemplate memory t = prizeTemplate;
        return
            Ship({
                name: string.concat(
                    "Legendary Draw #",
                    Strings.toString(_drawId)
                ),
                id: 0, // ignored by createSpecificShip — real id assigned internally
                equipment: Equipment({
                    mainWeapon: t.mainWeapon,
                    armor: t.armor,
                    shields: t.shields,
                    special: t.special
                }),
                traits: Traits({
                    serialNumber: 0, // ignored by createSpecificShip/_applyShipCustomization
                    colors: t.colors,
                    variant: t.variant,
                    accuracy: t.accuracy,
                    hull: t.hull,
                    speed: t.speed
                }),
                shipData: ShipData({
                    shipsDestroyed: 0,
                    costsVersion: 0, // recomputed internally via _setCostOfShip
                    cost: 0, // recomputed internally via _setCostOfShip
                    modified: 0, // recomputed internally via _calculateModifications
                    shiny: true, // the whole point is that it's not an ordinary ship
                    constructed: false, // set true internally by _applyShipCustomization
                    inFleet: false,
                    isFreeShip: false,
                    timestampDestroyed: 0
                }),
                owner: address(0) // ignored — real owner is createSpecificShip's `_to` param
            });
    }

    /**
     * @dev OWNER
     */

    function setMinEntryThresholdWei(uint256 _minEntryThresholdWei) external onlyOwner {
        minEntryThresholdWei = _minEntryThresholdWei;
    }

    function setPrizeTemplate(
        PrizeTemplate calldata _template
    ) external onlyOwner {
        if (_template.variant == 0 || _template.variant > ships.maxVariant()) {
            revert InvalidPrizeVariant(_template.variant);
        }
        if (_template.armor != Armor.None && _template.shields != Shields.None) {
            revert ArmorAndShieldsBothSet();
        }
        if (_template.accuracy > 2 || _template.hull > 2 || _template.speed > 2) {
            revert InvalidPrizeStatTier();
        }
        prizeTemplate = _template;
    }

    function setShips(address _ships) external onlyOwner {
        ships = IShips(_ships);
    }

    function setRandomManager(address _randomManager) external onlyOwner {
        randomManager = IRandomManager(_randomManager);
    }
}
