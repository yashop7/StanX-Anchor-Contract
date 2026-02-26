use crate::constants::*;
use crate::error::*;
use crate::events::*;
use crate::state::*;
use anchor_lang::prelude::*;
use anchor_spl::{
    associated_token::AssociatedToken,
    token::{self, Transfer},
    token_interface::{Mint, TokenAccount, TokenInterface},
};

#[derive(Accounts)]
#[instruction(market_id: u32)]
pub struct ClaimFunds<'info> {
    #[account(mut)]
    pub user: Signer<'info>,

    #[account(
        seeds = [MARKET_SEED, market.market_id.to_le_bytes().as_ref()],
        bump = market.bump,
        constraint = market.market_id == market_id
    )]
    pub market: Account<'info, Market>,

    #[account(
        mut,
        seeds = [USER_STATS_SEED, market_id.to_le_bytes().as_ref(), user.key().as_ref()],
        bump = user_stats.bump,
        constraint = user_stats.user == user.key()
    )]
    pub user_stats: Account<'info, UserStats>,

    #[account(constraint = collateral_mint.key() == market.collateral_mint)]
    pub collateral_mint: Box<InterfaceAccount<'info, Mint>>,

    #[account(constraint = outcome_yes_mint.key() == market.outcome_yes_mint)]
    pub outcome_yes_mint: Box<InterfaceAccount<'info, Mint>>,

    #[account(constraint = outcome_no_mint.key() == market.outcome_no_mint)]
    pub outcome_no_mint: Box<InterfaceAccount<'info, Mint>>,

    #[account(
        init_if_needed,
        payer = user,
        associated_token::mint = collateral_mint,
        associated_token::authority = user,
        associated_token::token_program = token_program,
    )]
    pub user_collateral: Box<InterfaceAccount<'info, TokenAccount>>,

    #[account(
        mut,
        constraint = collateral_vault.key() == market.collateral_vault
    )]
    pub collateral_vault: Box<InterfaceAccount<'info, TokenAccount>>,

    #[account(
        init_if_needed,
        payer = user,
        associated_token::mint = outcome_yes_mint,
        associated_token::authority = user,
        associated_token::token_program = token_program,
    )]
    pub user_outcome_yes: Box<InterfaceAccount<'info, TokenAccount>>,

    #[account(
        init_if_needed,
        payer = user,
        associated_token::mint = outcome_no_mint,
        associated_token::authority = user,
        associated_token::token_program = token_program,
    )]
    pub user_outcome_no: Box<InterfaceAccount<'info, TokenAccount>>,

    #[account(
        mut,
        constraint = yes_escrow.mint == market.outcome_yes_mint,
        constraint = yes_escrow.key() == market.yes_escrow
    )]
    pub yes_escrow: Box<InterfaceAccount<'info, TokenAccount>>,

    #[account(
        mut,
        constraint = no_escrow.mint == market.outcome_no_mint,
        constraint = no_escrow.key() == market.no_escrow
    )]
    pub no_escrow: Box<InterfaceAccount<'info, TokenAccount>>,

    pub associated_token_program: Program<'info, AssociatedToken>,
    pub token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
}

impl<'info> ClaimFunds<'info> {
    pub fn handler(&mut self, market_id: u32) -> Result<()> {
        let claimable_collateral = self.user_stats.claimable_collateral;
        let claimable_yes = self.user_stats.claimable_yes;
        let claimable_no = self.user_stats.claimable_no;

        require!(
            claimable_collateral > 0 || claimable_yes > 0 || claimable_no > 0,
            PredictionMarketError::NothingToClaim
        );

        let market_id_bytes = self.market.market_id.to_le_bytes();
        let bump = self.market.bump;
        let signer_seeds: &[&[&[u8]]] = &[&[MARKET_SEED, market_id_bytes.as_ref(), &[bump]]];

        // If Claimable assets are available, transfer them to the user

        if claimable_collateral > 0 {
            token::transfer(
                CpiContext::new_with_signer(
                    self.token_program.to_account_info(),
                    Transfer {
                        from: self.collateral_vault.to_account_info(),
                        to: self.user_collateral.to_account_info(),
                        authority: self.market.to_account_info(),
                    },
                    signer_seeds,
                ),
                claimable_collateral,
            )?;
            self.user_stats.claimable_collateral = 0;
        }

        if claimable_yes > 0 {
            token::transfer(
                CpiContext::new_with_signer(
                    self.token_program.to_account_info(),
                    Transfer {
                        from: self.yes_escrow.to_account_info(),
                        to: self.user_outcome_yes.to_account_info(),
                        authority: self.market.to_account_info(),
                    },
                    signer_seeds,
                ),
                claimable_yes,
            )?;
            self.user_stats.claimable_yes = 0;
        }

        if claimable_no > 0 {
            token::transfer(
                CpiContext::new_with_signer(
                    self.token_program.to_account_info(),
                    Transfer {
                        from: self.no_escrow.to_account_info(),
                        to: self.user_outcome_no.to_account_info(),
                        authority: self.market.to_account_info(),
                    },
                    signer_seeds,
                ),
                claimable_no,
            )?;
            self.user_stats.claimable_no = 0;
        }

        msg!(
            "User {} claimed: {} collateral, {} YES tokens, {} NO tokens",
            self.user.key(),
            claimable_collateral,
            claimable_yes,
            claimable_no
        );

        emit!(FundsClaimed {
            market_id,
            user: self.user.key(),
            collateral_amount: claimable_collateral,
            yes_amount: claimable_yes,
            no_amount: claimable_no,
            timestamp: Clock::get()?.unix_timestamp,
        });

        Ok(())
    }
}
