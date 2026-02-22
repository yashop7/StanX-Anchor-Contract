use anchor_lang::prelude::*;
pub mod constants;
pub mod error;
pub mod instructions;
pub mod state;
pub use crate::instructions::*;

declare_id!("AA9xwyVDCqHJTSPtigKyvLhaMpgjmU7CCT99SXWt43DP");

#[program]
pub mod prediction_market_turbin3 {
    use super::*;

    pub fn initialize_market(
        ctx: Context<InitializeMarket>,
        market_id: u32,
        settlement_deadline: i64,
    ) -> Result<()> {
        ctx.accounts
            .handler(market_id, settlement_deadline, &ctx.bumps)
    }

    pub fn split_tokens(ctx: Context<SplitToken>, market_id: u32, amount: u64) -> Result<()> {
        ctx.accounts.handler(market_id, amount, &ctx.bumps)
    }

    pub fn merge_tokens(ctx: Context<MergeTokens>, market_id: u32) -> Result<()> {
        ctx.accounts.handler(market_id)
    }
}
