# StanX - On-Chain Prediction Market Protocol

**A high-performance Central Limit Order Book (CLOB) for YouTube creator economy prediction markets on Solana.**

> Part of the [StanX Platform](https://github.com/yashop7/Stanx) - enabling Gen-Z fans to trade on creator statistics with institutional-grade price discovery.

---

## Overview

StanX reimagines prediction markets for the creator economy. Users trade predictions on YouTube creator statistics: *"Will MrBeast's next video hit 50M views in 72 hours?"*

This repository contains the **Solana smart contract** - a fully on-chain orderbook supporting limit and market orders with institutional-grade matching logic.

**Target Users**: Gen-Z fans (18-28), brands evaluating creator partnerships, Solana traders

**Competitive Edge**: On-chain CLOB vs. Polymarket (off-chain), Kalshi (centralized), Pump.fun (AMM slippage)

---

## Why CLOB Over AMM?

Traditional prediction markets use bonding curve AMMs. StanX implements a **Central Limit Order Book** for superior capital efficiency:

**AMM**: $10K buy → 15-40% slippage → Pay $11,500 for $10K position  
**CLOB**: $10K buy → Match limit orders → Pay $10,200 for $10K position (1-3% spread)

### Vector-Based Orderbook

- **4 sorted vectors**: `yes_buy`, `yes_sell`, `no_buy`, `no_sell` (max 32 orders each)
- **Pre-allocated space**: 10,021 bytes at initialization (predictable rent)
- **Sequential matching**: O(n) scan optimized for Solana's compute model
- **Benefits**: Lower CU cost, transparent depth, MEV resistance

---

## Architecture

**[INSERT ARCHITECTURE DIAGRAM HERE: System overview showing Program, PDAs, Vaults, and user interactions]**

### Core State Accounts

**Market PDA** (`[MARKET_SEED, market_id]`)  
- Metadata: deadline, authority, settlement status, winning outcome
- References: collateral vault, YES/NO mints, YES/NO escrows

**OrderBook PDA** (`[ORDERBOOK_SEED, market_id]`)  
- 4 sorted vectors: `yes_buy_orders`, `yes_sell_orders`, `no_buy_orders`, `no_sell_orders`
- Space: 10,021 bytes (32 orders × 78 bytes × 4 sides)

**UserStats PDA** (`[USER_STATS_SEED, market_id, user]`)  
- Tracks: `locked_collateral`, `locked_yes/no`, `claimable_collateral`, `claimable_yes/no`
- Settlement: `reward_claimed` flag (one-time redemption)

---

## Program Instructions

**[INSERT DIAGRAM HERE: Instruction flow diagram showing market lifecycle]**

### 1. `initialize_market`
Creates a new prediction market with outcome mints, vaults, and orderbook.

**Parameters**: `market_id`, `settlement_deadline`, `meta_data_url` (max 200 chars)  
**Creates**: Market PDA, YES/NO mints (6 decimals), Collateral vault, Escrows, OrderBook  
**Access**: Permissionless (anyone can create markets)

---

### 2. `split_tokens`
Deposits collateral and mints paired YES+NO tokens (1:1:1 ratio).

**[INSERT DIAGRAM HERE: Token split flow]**

```
Input:  100 USDC → Output: 100 YES + 100 NO tokens
```

**Logic**: Transfers collateral to vault, mints equal YES/NO tokens, increments `total_collateral_locked`

---

### 3. `merge_tokens`
Burns paired YES+NO tokens to redeem collateral (inverse of split).

**[INSERT DIAGRAM HERE: Token merge flow]**

```
Input: 50 YES + 50 NO → Output: 50 USDC
```

---

### 4. `place_order` (Limit Order)
Submits a limit order that matches immediately or rests on the book.

**[INSERT DIAGRAM HERE: Limit order matching engine]**

**Parameters**: `side` (Buy/Sell), `token_type` (YES/NO), `quantity`, `price`, `max_iteration`

**Matching Logic**:
1. Lock funds (collateral for buys, tokens for sells)
2. Sequential scan through opposing side (price-time priority)
3. Execute trades at **book price** (price improvement to taker)
4. Unfilled remainder → Added to book (if space) or moved to claimable (IOC)

**Price Improvement Example**:
```
User: BUY 100 YES @ 0.65 USDC
Book: SELL 100 YES @ 0.60 USDC
→ Execution @ 0.60, refund 5 USDC to claimable_collateral
```

---

### 5. `market_order`
Executes immediately at best available prices with no resting order.

**Parameters**: `order_amount` (collateral for buys, tokens for sells), `max_iteration`

**Difference from Limit**: No price param, consumes liquidity at any price, instant refund of unfilled portion

---

### 6. `cancel_order`
Removes a resting limit order and unlocks funds.

**Logic**: Search orderbook for `order_id`, verify ownership, refund unfilled portion, remove from vector

---

### 7. `set_winner`
Authority-only settlement after deadline.

**[INSERT DIAGRAM HERE: Settlement flow]**

**Parameters**: `winning_outcome` (OutcomeA/OutcomeB/Neither)  
**Effect**: Sets `is_settled = true`, removes mint authority from both tokens (prevents future splits)

---

### 8. `claim_funds`
Withdraws claimable balances earned from matched trades.

**Logic**: Transfers `claimable_collateral`, `claimable_yes`, `claimable_no` from vaults/escrows → user

---

### 9. `claim_rewards`
One-time redemption of winning tokens for collateral after settlement.

**[INSERT DIAGRAM HERE: Rewards redemption flow]**

```
Market settled: YES wins
User holds: 500 YES → Burns 500 YES → Receives 500 USDC (1:1)
```

---

### 10. `close_market` & 11. `update_metadata`
Admin utilities for cleanup and metadata updates.

---

## Token Economics

**[INSERT DIAGRAM HERE: Token lifecycle from split → trade → settlement → redemption]**

### Token Mechanics

```
1 USDC ←→ 1 YES + 1 NO (always paired)

Split:  Lock 1 USDC → Mint 1 YES + 1 NO
Merge:  Burn 1 YES + 1 NO → Unlock 1 USDC
Trade:  YES and NO trade independently on orderbook
```

### Settlement

**YES Wins**: 1 YES → 1 USDC redemption, NO tokens worthless  
**NO Wins**: 1 NO → 1 USDC redemption, YES tokens worthless  
**Draw**: Neither token redeemable (merge only option)

---

## Deployment

**Program ID**: `AA9xwyVDCqHJTSPtigKyvLhaMpgjmU7CCT99SXWt43DP`  
**Network**: Devnet (`https://api.devnet.solana.com`)  
**Anchor**: v0.32.1 | **Solana**: v1.18.22 | **Rust**: 1.79.0

```bash
# Build & Test
anchor build
anchor test

# Deploy to devnet
anchor deploy --provider.cluster devnet
```

---

## Testing

**35+ comprehensive tests** covering happy paths and error cases:
- Market initialization, token split/merge, orderbook matching
- Limit/market orders, cancellation, settlement, rewards
- Edge cases: invalid params, unauthorized access, capacity limits

```bash
anchor test                          # Full suite (localnet)
anchor test -- --grep "Market Order" # Specific tests
```

See [PRESENTATION_GUIDE.md](./PRESENTATION_GUIDE.md) for detailed walkthrough.

---

## Documentation

- **Architecture**: [System Design Doc](https://docs.google.com/document/d/1Gz8__StJKRCUP8g1L1SKqGIB8xqP-ULBbnj2RbLEaHg/edit?usp=sharing) (PDA structure, compute optimization)
- **User Stories**: [User Flow Analysis](https://docs.google.com/document/d/1Y15Y3g5-QQhOD_KBkGlWl56jKhsNQJHVomWOAFaSh1I/edit?usp=sharing) (Personas, requirements)
- **Platform**: [StanX Frontend](https://github.com/yashop7/Stanx) (in progress)

---

## Technical Reference

**PDA Seeds**: `market`, `orderbook`, `user_stats`, `collateral_vault`, `yes_escrow`, `no_escrow`  
**Constants**: `MAX_ORDERS_PER_SIDE = 32`, `MAX_METADATA_LENGTH = 200`  
**Enums**: `WinningOutcome`, `TokenType`, `OrderSide`  
**Events**: `MarketInitialized`, `OrderPlaced`, `OrderMatched`, `MarketOrderExecuted`, `WinningSideSet`, etc.

See [programs/stanx/src/](programs/stanx/src/) for full source code.

---

## Known Limitations

⚠️ **Not audited - use at own risk**

- **Centralized settlement**: Authority controls `set_winner` (future: oracles)
- **Orderbook capacity**: 32 orders/side max (extensible via cranking)
- **Compute budget**: `max_iteration` param limits matching depth

---

## License

MIT License - See [LICENSE](./LICENSE) for details.

---

## Contact

**Developer**: Yash  
**GitHub**: [@yashop7](https://github.com/yashop7)  
**Twitter**: [@yashtwt7](https://twitter.com/yashtwt7)  
**Platform**: [StanX](https://github.com/yashop7/Stanx)

---

## Acknowledgments

Built with:
- [Anchor Framework](https://www.anchor-lang.com/) - Solana development framework
- [Solana](https://solana.com/) - High-performance blockchain
- [SPL Token](https://spl.solana.com/token) - Token program standard

Inspired by prediction market research from Polymarket, Kalshi, and the broader DeFi orderbook ecosystem.

---

**Note**: This is a Proof-of-Concept implementation. The StanX platform (frontend + indexer) is under active development at [github.com/yashop7/Stanx](https://github.com/yashop7/Stanx).
