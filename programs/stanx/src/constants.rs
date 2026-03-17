pub const MARKET_SEED: &[u8] = b"market";
pub const VAULT_SEED: &[u8] = b"vault";
pub const OUTCOME_YES_SEED: &[u8] = b"outcome_a";
pub const OUTCOME_NO_SEED: &[u8] = b"outcome_b";
pub const ORDERBOOK_SEED: &[u8] = b"orderbook";
pub const USER_STATS_SEED: &[u8] = b"user_stats";
pub const ESCROW_SEED: &[u8] = b"escrow";
pub const MAX_ORDERS_PER_SIDE: usize = 32;
pub const ORDERBOOK_GROWTH_BATCH: usize = 10;

// Both outcome tokens and collateral have 6 decimals.
// quantity (base units) × price (micro USDC per display token) must be divided by this
// to get the collateral amount in micro USDC.
pub const TOKEN_DECIMALS_SCALE: u64 = 1_000_000;

// Minimum order size: 0.001 display tokens (1_000 base units).
// Prevents quantity × price / TOKEN_DECIMALS_SCALE from truncating to zero.
pub const MIN_ORDER_QUANTITY: u64 = 1_000;

