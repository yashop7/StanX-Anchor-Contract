use anchor_lang::prelude::*;
pub mod constants;
pub mod error;
pub mod events;
pub mod instructions;
pub mod state;
pub use crate::instructions::*;
pub use crate::state::*;

declare_id!("AA9xwyVDCqHJTSPtigKyvLhaMpgjmU7CCT99SXWt43DP");

#[program]
pub mod prediction_market_turbin3 {
    use super::*;

    pub fn initialize_market(
        ctx: Context<InitializeMarket>,
        market_id: u32,
        settlement_deadline: i64,
        meta_data_url: String,
    ) -> Result<()> {
        ctx.accounts
            .initialise(market_id, settlement_deadline, &ctx.bumps, meta_data_url)
    }

    pub fn split_tokens(ctx: Context<SplitToken>, market_id: u32, amount: u64) -> Result<()> {
        ctx.accounts.split_token(market_id, amount, &ctx.bumps)
    }

    pub fn merge_tokens(ctx: Context<MergeTokens>, market_id: u32, amount: u64) -> Result<()> {
        ctx.accounts.merge_tokens(market_id, amount)
    }

    pub fn place_order<'info>(
        ctx: Context<'_, '_, '_, 'info, PlaceOrder<'info>>,
        market_id: u32,
        side: OrderSide,
        token_type: TokenType,
        quantity: u64,
        price: u64,
        max_iteration: u64,
    ) -> Result<()> {
        let remaining_accounts = ctx.remaining_accounts;
        let program_id = ctx.program_id;
        ctx.accounts.handler(
            market_id,
            side,
            token_type,
            quantity,
            price,
            max_iteration,
            &ctx.bumps,
            remaining_accounts,
            program_id,
        )
    }

    pub fn market_order<'info>(
        ctx: Context<'_, '_, '_, 'info, MarketOrder<'info>>,
        market_id: u32,
        side: OrderSide,
        token_type: TokenType,
        order_amount: u64,
        max_iteration: u64,
    ) -> Result<()> {
        let remaining_accounts = ctx.remaining_accounts;
        let program_id = ctx.program_id;
        ctx.accounts.handler(
            market_id,
            side,
            token_type,
            order_amount,
            max_iteration,
            &ctx.bumps,
            remaining_accounts,
            program_id,
        )
    }

    pub fn cancel_order(ctx: Context<CancelOrder>, market_id: u32, order_id: u64) -> Result<()> {
        ctx.accounts.handler(market_id, order_id)
    }

    pub fn close_market(ctx: Context<CloseMarket>, market_id: u32) -> Result<()> {
        ctx.accounts.handler(market_id)
    }

    pub fn claim_funds(ctx: Context<ClaimFunds>, market_id: u32) -> Result<()> {
        ctx.accounts.handler(market_id)
    }

    pub fn claim_rewards(ctx: Context<ClaimRewards>, market_id: u32) -> Result<()> {
        ctx.accounts.handler(market_id)
    }

    pub fn set_winner(
        ctx: Context<SetWinner>,
        market_id: u32,
        winning_outcome: WinningOutcome,
    ) -> Result<()> {
        ctx.accounts.handler(market_id, winning_outcome)
    }

    pub fn update_metadata(
        ctx: Context<UpdateMetadata>,
        market_id: u32,
        new_metadata_url: String,
    ) -> Result<()> {
        ctx.accounts.handler(market_id, new_metadata_url)
    }
}
