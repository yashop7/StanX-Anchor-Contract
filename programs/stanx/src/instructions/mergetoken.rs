use anchor_lang::prelude::*;
use anchor_spl::{
    token::{self, Token, Burn, Transfer},
    token_interface::{TokenAccount , Mint}
};

use crate::constants::*;
use crate::error::*;
use crate::state::{Market, UserStats};

#[derive(Accounts)]
#[instruction(market_id: u32)]
pub struct MergeTokens<'info> {
    #[account(
        mut,
        seeds = [MARKET_SEED, market.market_id.to_le_bytes().as_ref()],
        bump = market.bump,
        constraint = market.market_id == market_id
    )]
    pub market: Box<Account<'info, Market>>,

    #[account(mut)]
    pub user: Signer<'info>,

    #[account(
        mut,
        constraint = user_collateral.mint == market.collateral_mint,
        constraint = user_collateral.owner == user.key()
    )]
    pub user_collateral: Box<InterfaceAccount<'info, TokenAccount>>,

    #[account(
        mut,
        constraint = collateral_vault.key() == market.collateral_vault
    )]
    pub collateral_vault: Box<InterfaceAccount<'info, TokenAccount>>,

    #[account(
        mut,
        constraint = outcome_yes_mint.key() == market.outcome_yes_mint
    )]
    pub outcome_yes_mint: Box<InterfaceAccount<'info, Mint>>,

    #[account(
        mut,
        constraint = outcome_no_mint.key() == market.outcome_no_mint
    )]
    pub outcome_no_mint: Box<InterfaceAccount<'info, Mint>>,

    #[account(
        mut,
        constraint = user_outcome_yes.owner == user.key(),
        constraint = user_outcome_yes.mint == market.outcome_yes_mint
    )]
    pub user_outcome_yes: Box<InterfaceAccount<'info, TokenAccount>>, // Ohh we willn't make this account here,
    #[account(
        mut,
        seeds = [USER_STATS_SEED, market_id.to_le_bytes().as_ref(), user.key().as_ref()],
        bump = user_stats_account.bump
    )]
    pub user_stats_account: Box<Account<'info, UserStats>>,

    #[account(
        mut,
        constraint = user_outcome_no.owner == user.key(),
        constraint = user_outcome_no.mint == market.outcome_no_mint
    )]
    pub user_outcome_no: Box<InterfaceAccount<'info, TokenAccount>>,
    pub token_program: Program<'info, Token>,
}

impl<'info> MergeTokens<'info> {
    pub fn merge_tokens(&mut self, _market_id: u32) -> Result<()> {
        require!(
            Clock::get()?.unix_timestamp < self.market.settlement_deadline,
            PredictionMarketError::MarketExpired
        );
        require!(
            !self.market.is_settled,
            PredictionMarketError::MarketAlreadySettled
        );

        let bal_a = self.user_outcome_yes.amount;
        let bal_b = self.user_outcome_no.amount;
        let amount = bal_a.min(bal_b);

        require!(amount > 0, PredictionMarketError::InvalidAmount);

        token::burn(
            CpiContext::new(
                self.token_program.to_account_info(),
                Burn {
                    mint: self.outcome_yes_mint.to_account_info(),
                    from: self.user_outcome_yes.to_account_info(),
                    authority: self.user.to_account_info(),
                },
            ),
            amount,
        )?;
        token::burn(
            CpiContext::new(
                self.token_program.to_account_info(),
                Burn {
                    mint: self.outcome_no_mint.to_account_info(),
                    from: self.user_outcome_no.to_account_info(),
                    authority: self.user.to_account_info(),
                },
            ),
            amount,
        )?;

        let market_id_bytes = self.market.market_id.to_le_bytes();
        let market_bump = self.market.bump;
        let seeds = &[MARKET_SEED, market_id_bytes.as_ref(), &[market_bump]];

        token::transfer(
            CpiContext::new_with_signer(
                self.token_program.to_account_info(),
                Transfer {
                    from: self.collateral_vault.to_account_info(),
                    to: self.user_collateral.to_account_info(),
                    authority: self.market.to_account_info(),
                },
                &[seeds],
            ),
            amount,
        )?;

        self.market.total_collateral_locked = self
            .market
            .total_collateral_locked
            .checked_sub(amount)
            .ok_or(PredictionMarketError::MathOverflow)?;

        let user_stats = &mut self.user_stats_account;

        user_stats.locked_yes = user_stats
            .locked_yes
            .checked_sub(amount)
            .ok_or(PredictionMarketError::MathOverflow)?;
        user_stats.locked_no = user_stats
            .locked_no
            .checked_sub(amount)
            .ok_or(PredictionMarketError::MathOverflow)?;

        msg!(
            "Merged {} pairs of outcome tokens back to collateral",
            amount
        );

        Ok(())
    }
}
