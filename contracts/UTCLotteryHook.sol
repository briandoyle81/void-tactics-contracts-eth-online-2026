// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.28;

import "@openzeppelin/contracts/access/Ownable.sol";
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

    // NOTE — open question, not resolved by this contract: what "1-of-a-kind"
    // means across repeated draws (a fresh unique variant minted per draw,
    // vs. one eternal prize) is still undecided per the strategy doc. This
    // mints one ship per resolved draw using prizeVariant/prizeTier below;
    // it does not itself guarantee the minted ship is visually or
    // mechanically unique — that's a separate decision for whoever sets
    // prizeVariant, deliberately left configurable rather than assumed here.
    uint16 public prizeVariant;
    uint8 public prizeTier;

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
        ships.createShips(winner, 1, prizeVariant, prizeTier, false);

        emit DrawResolved(_drawId, winner);
    }

    /**
     * @dev OWNER
     */

    function setMinEntryThresholdWei(uint256 _minEntryThresholdWei) external onlyOwner {
        minEntryThresholdWei = _minEntryThresholdWei;
    }

    function setPrize(uint16 _variant, uint8 _tier) external onlyOwner {
        prizeVariant = _variant;
        prizeTier = _tier;
    }

    function setShips(address _ships) external onlyOwner {
        ships = IShips(_ships);
    }

    function setRandomManager(address _randomManager) external onlyOwner {
        randomManager = IRandomManager(_randomManager);
    }
}
