use crate::constants::*;
use crate::error::*;
use crate::events::*;
use crate::state::*;
use anchor_lang::prelude::*;
use anchor_spl::associated_token::AssociatedToken;
use anchor_spl::{
    token::{self, spl_token::instruction::AuthorityType, SetAuthority},
    token_interface::{Mint, TokenInterface},
};

#[derive(Accounts)]
#[instruction(market_id: u32)]
pub struct SetWinner<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,

    #[account(
        mut,
        seeds = [MARKET_SEED, market.market_id.to_le_bytes().as_ref()],
        bump = market.bump,
        has_one = authority,
        constraint = market.market_id == market_id
    )]
    pub market: Account<'info, Market>,

    #[account(
        mut,
        constraint = outcome_yes_mint.key() == market.outcome_yes_mint
    )]
    pub outcome_yes_mint: InterfaceAccount<'info, Mint>,

    #[account(
        mut,
        constraint = outcome_no_mint.key() == market.outcome_no_mint
    )]
    pub outcome_no_mint: InterfaceAccount<'info, Mint>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub token_program: Interface<'info, TokenInterface>,
}

impl<'info> SetWinner<'info> {
    pub fn handler(&mut self, _market_id: u32, winning_outcome: WinningOutcome) -> Result<()> {
        require!(
            !self.market.is_settled,
            PredictionMarketError::MarketAlreadySettled
        );

        require!(
            Clock::get()?.unix_timestamp >= self.market.settlement_deadline,
            PredictionMarketError::SettlementDeadlineNotReached
        );

        self.market.is_settled = true;
        self.market.winning_outcome = Some(winning_outcome);

        let market_id_bytes = self.market.market_id.to_le_bytes();
        let bump = self.market.bump;
        let seeds = &[MARKET_SEED, market_id_bytes.as_ref(), &[bump]];

        token::set_authority(
            CpiContext::new_with_signer(
                self.token_program.to_account_info(),
                SetAuthority {
                    current_authority: self.market.to_account_info(),
                    account_or_mint: self.outcome_yes_mint.to_account_info(),
                },
                &[seeds],
            ),
            AuthorityType::MintTokens,
            None,
        )?;

        token::set_authority(
            CpiContext::new_with_signer(
                self.token_program.to_account_info(),
                SetAuthority {
                    current_authority: self.market.to_account_info(),
                    account_or_mint: self.outcome_no_mint.to_account_info(),
                },
                &[seeds],
            ),
            AuthorityType::MintTokens,
            None,
        )?;

        let market_id_val = self.market.market_id;
        let authority_key = self.authority.key();

        msg!("Market settled with winning outcome: {:?}", winning_outcome);

        emit!(WinningSideSet {
            market_id: market_id_val,
            winning_outcome,
            authority: authority_key,
            timestamp: Clock::get()?.unix_timestamp,
        });

        Ok(())
    }
}
