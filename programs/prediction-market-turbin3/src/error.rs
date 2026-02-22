use anchor_lang::prelude::*;

#[error_code]
pub enum PredictionMarketError {
    Invalid,
    #[msg("Invalid settlement deadline")]
    InvalidSettlementDeadline,
    #[msg("Market already settled")]
    MarketAlreadySettled,
    #[msg("Market has expired")]
    MarketExpired,
    #[msg("Invalid amount")]
    InvalidAmount,
    #[msg("Invalid order quantity")]
    InvalidOrderQuantity,
    #[msg("Invalid order price")]
    InvalidOrderPrice,
    #[msg("Invalid Iteration Limit")]
    InvalidIterationLimit,
    #[msg("Math overflow")]
    MathOverflow,
    #[msg("Invalid winning outcome")]
    InvalidWinningOutcome,
    #[msg("Market is not setteld yet")]
    MarketNotSettled,
    #[msg("Winning outcome is not set yet")]
    WinningOutcomeNotSet,
    #[msg("Max Orders reached for this Side")]
    MaxOrdersReached,
    #[msg("Not enough Balance in the account")]
    NotEnoughBalance,
    #[msg("Seller's UserStats account not provided in remaining_accounts")]
    SellerStatsAccountNotProvided,
    #[msg("Buyer's UserStats account not provided in remaining_accounts")]
    BuyerStatsAccountNotProvided,
    #[msg("Not authorized")]
    NotAuthorized,
    #[msg("Order not found")]
    OrdernotFound,
    #[msg("Order is partially filled and cannot be cancelled")]
    OrderPartiallyFilled,
    #[msg("Invalid metadata URL, exceeds maximum length")]
    InvalidMetadata,
    #[msg("Collateral not fully claimed, cannot close market")]
    CollateralNotFullyClaimed,
    #[msg("Orders still pending, cancel all orders before closing market")]
    OrdersStillPending,
    #[msg("OrderBook is full, cannot add more orders to this side")]
    OrderBookFull
}