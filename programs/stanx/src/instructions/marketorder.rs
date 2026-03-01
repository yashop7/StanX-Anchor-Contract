use anchor_lang::prelude::*;
use anchor_spl::{
    associated_token::AssociatedToken,
    token::{self, Transfer},
    token_interface::{Mint, TokenAccount, TokenInterface},
};

use crate::constants::*;
use crate::error::*;
use crate::state::*;
use crate::events::*;

#[derive(Accounts)]
#[instruction(market_id:u32)]
pub struct MarketOrder<'info> {
    #[account(mut)]
    pub user : Signer<'info>,

    #[account(
        mut,
        seeds=[MARKET_SEED, market.market_id.to_le_bytes().as_ref()],
        bump = market.bump,
        constraint = market.market_id == market_id,
    )]
    pub market : Box<Account<'info, Market>>,

    #[account(
        mut,
        seeds = [ORDERBOOK_SEED, market.market_id.to_le_bytes().as_ref()],
        bump = orderbook.bump,
        constraint = orderbook.market_id == market_id 
    )]
    pub orderbook : Box<Account<'info, OrderBook>>,

    #[account(
        mut,
        constraint = collateral_vault.key() == market.collateral_vault
    )]
    pub collateral_vault: Box<InterfaceAccount<'info, TokenAccount>>,

    #[account(
        mut,
        constraint = user_collateral.mint == market.collateral_mint,
        constraint = user_collateral.owner == user.key()
    )]
    pub user_collateral: Box<InterfaceAccount<'info, TokenAccount>>,

    #[account(
        init_if_needed,
        payer = user,
        space = 8 + UserStats::INIT_SPACE,
        seeds = [USER_STATS_SEED, market_id.to_le_bytes().as_ref(), user.key().as_ref()],
        bump
    )]
    pub user_stats_account: Box<Account<'info, UserStats>>,

    #[account(constraint = outcome_yes_mint.key() == market.outcome_yes_mint)]
    pub outcome_yes_mint: Box<InterfaceAccount<'info, Mint>>,

    #[account(constraint = outcome_no_mint.key() == market.outcome_no_mint)]
    pub outcome_no_mint: Box<InterfaceAccount<'info, Mint>>,

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

    pub system_program: Program<'info, System>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub token_program: Interface<'info, TokenInterface>,
}

impl<'info> MarketOrder<'info> {
    pub fn handler(
        &mut self,
        market_id: u32,
        side: OrderSide,
        token_type: TokenType,
        order_amount: u64,
        max_iteration: u64,
        bumps: &MarketOrderBumps,
        remaining_accounts: &[AccountInfo<'info>],
        program_id: &Pubkey,
    ) -> Result<()> {
        let market = &mut self.market;
        let orderbook = &mut self.orderbook;

        require!(
            Clock::get()?.unix_timestamp < market.settlement_deadline,
            PredictionMarketError::MarketExpired
        );

        require!(
            !market.is_settled,
            PredictionMarketError::MarketAlreadySettled
        );

        require!(
            max_iteration > 0,
            PredictionMarketError::InvalidIterationLimit
        );

        require!(
            order_amount > 0,
            PredictionMarketError::InvalidOrderQuantity
        );

        let user_stats: &mut Box<Account<'_, UserStats>> = &mut self.user_stats_account;
        if user_stats.user == Pubkey::default() {
            user_stats.user = self.user.key();
            user_stats.market_id = market_id;
            user_stats.locked_yes = 0;
            user_stats.claimable_yes = 0;
            user_stats.locked_no = 0;
            user_stats.claimable_no = 0;
            user_stats.locked_collateral = 0;
            user_stats.claimable_collateral = 0;
            user_stats.bump = bumps.user_stats_account;
        }

        // Checking balance in account
        match side {
            OrderSide::Buy => {
                require!(
                    self.user_collateral.amount >= order_amount,
                    PredictionMarketError::NotEnoughBalance
                );
            }
            OrderSide::Sell => {
                let user_token_account = match token_type {
                    TokenType::Yes => &self.user_outcome_yes,
                    TokenType::No => &self.user_outcome_no,
                };

                require!(
                    user_token_account.amount >= order_amount,
                    PredictionMarketError::NotEnoughBalance
                );
            }
        }

        // Locking of Funds
        if side == OrderSide::Buy {
            // Locking the collateral in the Collateral Vault
            require!(
                self.user_collateral.amount >= order_amount,
                PredictionMarketError::NotEnoughBalance
            );

            token::transfer(
                CpiContext::new(
                    self.token_program.to_account_info(),
                    Transfer {
                        from: self.user_collateral.to_account_info(),
                        to: self.collateral_vault.to_account_info(),
                        authority: self.user.to_account_info(),
                    },
                ),
                order_amount,
            )?;

            let user_stats = &mut self.user_stats_account;
            user_stats.locked_collateral = user_stats
                .locked_collateral
                .checked_add(order_amount)
                .ok_or(PredictionMarketError::MathOverflow)?;

            // Track vault-level collateral
            market.total_collateral_locked = market
                .total_collateral_locked
                .checked_add(order_amount)
                .ok_or(PredictionMarketError::MathOverflow)?;
        } else {
            // Locking the tokens in the Escrow
            let (user_token_account, token_escrow) = match token_type {
                TokenType::Yes => (&self.user_outcome_yes, &self.yes_escrow),
                TokenType::No => (&self.user_outcome_no, &self.no_escrow),
            };

            token::transfer(
                CpiContext::new(
                    self.token_program.to_account_info(),
                    Transfer {
                        from: user_token_account.to_account_info(),
                        to: token_escrow.to_account_info(),
                        authority: self.user.to_account_info(),
                    },
                ),
                order_amount,
            )?;

            let user_stats = &mut self.user_stats_account;
            let locked_field = match token_type {
                TokenType::Yes => &mut user_stats.locked_yes,
                TokenType::No => &mut user_stats.locked_no,
            };

            *locked_field = locked_field
                .checked_add(order_amount)
                .ok_or(PredictionMarketError::MathOverflow)?;
        }

        // We want to check in the orderbook
        // 1. we will iterate over the orderbook, & calculate the iterations, Then we will leave the order at that time
        // 2. Segreagte the logic & then generalise the Buy/Sell, Yes/No token

        let (matching_orders, is_buy_order) = match (token_type, side) {
            (TokenType::Yes, OrderSide::Buy) => (&mut orderbook.yes_sell_orders, true),
            (TokenType::Yes, OrderSide::Sell) => (&mut orderbook.yes_buy_orders, false),
            (TokenType::No, OrderSide::Buy) => (&mut orderbook.no_sell_orders, true),
            (TokenType::No, OrderSide::Sell) => (&mut orderbook.no_buy_orders, false),
        };

        let mut idx = 0;
        let mut iteration = 0;
        let mut remaining_amount: u64 = order_amount;
        let mut fullfilled_qty: u64 = 0; // Tokens in case of Buy // Collateral in case of selling

        while idx < matching_orders.len() && iteration < max_iteration && remaining_amount > 0 {
            let (book_price, book_qty, book_filled_qty) = {
                let book_order = &matching_orders[idx];
                (
                    book_order.price,
                    book_order.quantity,
                    book_order.filledquantity,
                )
            };

            let book_remaining_qty = book_qty
                .checked_sub(book_filled_qty)
                .ok_or(PredictionMarketError::MathOverflow)?;

            // Skip empty orders
            if book_remaining_qty == 0 {
                matching_orders.remove(idx);
                continue;
            }

            // Prevent self-trading
            if matching_orders[idx].user_key == self.user.key() {
                idx += 1;
                continue;
            }

            let min_qty;

            match side {
                OrderSide::Buy => {
                    // Calculate how many tokens we can buy with REMAINING collateral
                    let order_buy_qty = remaining_amount
                        .checked_div(book_price)
                        .ok_or(PredictionMarketError::MathOverflow)?;
                    min_qty = order_buy_qty.min(book_remaining_qty);
                }
                OrderSide::Sell => {
                    // Use remaining tokens, not total order_amount
                    min_qty = remaining_amount.min(book_remaining_qty);
                }
            }

            let collateral_amount = book_price
                .checked_mul(min_qty)
                .ok_or(PredictionMarketError::MathOverflow)?;

            // Update book order's filled quantity
            matching_orders[idx].filledquantity = book_filled_qty
                .checked_add(min_qty)
                .ok_or(PredictionMarketError::MathOverflow)?;

            match side {
                OrderSide::Buy => {
                    remaining_amount = remaining_amount
                        .checked_sub(collateral_amount)
                        .ok_or(PredictionMarketError::MathOverflow)?;
                    fullfilled_qty = fullfilled_qty
                        .checked_add(min_qty)
                        .ok_or(PredictionMarketError::MathOverflow)?;
                }
                OrderSide::Sell => {
                    remaining_amount = remaining_amount
                        .checked_sub(min_qty)
                        .ok_or(PredictionMarketError::MathOverflow)?;
                    fullfilled_qty = fullfilled_qty
                        .checked_add(collateral_amount)
                        .ok_or(PredictionMarketError::MathOverflow)?;
                }
            }

            // Here transfering the Claimable assets to the other party only,
            // For the user who has placed order, Assets will be directly transffered later
            if is_buy_order {
                // Credit Seller (from matching order) with collateral
                let seller_pubkey = matching_orders[idx].user_key;
                let seller_stats_pda = Pubkey::find_program_address(
                    &[
                        USER_STATS_SEED,
                        market.market_id.to_le_bytes().as_ref(),
                        seller_pubkey.as_ref(),
                    ],
                    program_id,
                )
                .0;
                let mut seller_credited = false;

                // Transferring assets to the Claimable feild in User stats Account + removing the locked assets
                for account_info in remaining_accounts.iter() {
                    if account_info.key == &seller_stats_pda {
                        let mut data = account_info.try_borrow_mut_data()?;
                        let mut seller_stats = UserStats::try_deserialize(&mut &data[..])?;

                        seller_stats.claimable_collateral = seller_stats
                            .claimable_collateral
                            .checked_add(collateral_amount)
                            .ok_or(PredictionMarketError::MathOverflow)?;

                        match token_type {
                            TokenType::Yes => {
                                seller_stats.locked_yes = seller_stats
                                    .locked_yes
                                    .checked_sub(min_qty)
                                    .ok_or(PredictionMarketError::MathOverflow)?;
                            }
                            TokenType::No => {
                                seller_stats.locked_no = seller_stats
                                    .locked_no
                                    .checked_sub(min_qty)
                                    .ok_or(PredictionMarketError::MathOverflow)?;
                            }
                        }
                        let mut writer = &mut data[..];
                        seller_stats.try_serialize(&mut writer)?;

                        seller_credited = true;
                        break;
                    }
                }
                require!(
                    seller_credited,
                    PredictionMarketError::SellerStatsAccountNotProvided
                );
            } else {
                // Credit BUYER (from matching order) with YES/NO tokens
                let buyer_pubkey = matching_orders[idx].user_key;
                let buyer_stats_pda = Pubkey::find_program_address(
                    &[
                        USER_STATS_SEED,
                        market.market_id.to_le_bytes().as_ref(),
                        buyer_pubkey.as_ref(),
                    ],
                    program_id,
                )
                .0;
                let mut buyer_credited = false;

                // Transferring assets to the Claimable feild in User stats Account + removing the locked assets
                for account_info in remaining_accounts.iter() {
                    if account_info.key == &buyer_stats_pda {
                        let mut data = account_info.try_borrow_mut_data()?;
                        let mut buyer_stats = UserStats::try_deserialize(&mut &data[..])?;

                        match token_type {
                            TokenType::Yes => {
                                buyer_stats.claimable_yes = buyer_stats
                                    .claimable_yes
                                    .checked_add(min_qty)
                                    .ok_or(PredictionMarketError::MathOverflow)?;
                            }
                            TokenType::No => {
                                buyer_stats.claimable_no = buyer_stats
                                    .claimable_no
                                    .checked_add(min_qty)
                                    .ok_or(PredictionMarketError::MathOverflow)?;
                            }
                        }
                        buyer_stats.locked_collateral = buyer_stats
                            .locked_collateral
                            .checked_sub(collateral_amount)
                            .ok_or(PredictionMarketError::MathOverflow)?;

                        let mut writer = &mut data[..];
                        buyer_stats.try_serialize(&mut writer)?;

                        buyer_credited = true;
                        break;
                    }
                }

                require!(
                    buyer_credited,
                    PredictionMarketError::BuyerStatsAccountNotProvided
                );
            }

            // Remove completed orders or advance to next
            if matching_orders[idx].filledquantity >= matching_orders[idx].quantity {
                matching_orders.remove(idx);
                // we will not increment idx
            } else {
                idx += 1;
            }

            iteration += 1;
        }

        // Transfering assets to the user who has placed the order right away
        match side {
            OrderSide::Buy => {
                let (user_token_account, token_escrow) = match token_type {
                    TokenType::Yes => (&self.user_outcome_yes, &self.yes_escrow),
                    TokenType::No => (&self.user_outcome_no, &self.no_escrow),
                };

                let market_id_bytes = market.market_id.to_le_bytes();
                let seeds = &[MARKET_SEED, market_id_bytes.as_ref(), &[market.bump]];

                token::transfer(
                    CpiContext::new_with_signer(
                        self.token_program.to_account_info(),
                        Transfer {
                            from: token_escrow.to_account_info(),
                            to: user_token_account.to_account_info(),
                            authority: market.to_account_info(),
                        },
                        &[seeds],
                    ),
                    fullfilled_qty,
                )?;

                // Reduce locked collateral for buyer
                // For Buy orders: fullfilled_qty = tokens received, we need collateral spent
                let collateral_spent = order_amount
                    .checked_sub(remaining_amount)
                    .ok_or(PredictionMarketError::MathOverflow)?;

                let user_stats = &mut self.user_stats_account;

                user_stats.locked_collateral = user_stats
                    .locked_collateral
                    .checked_sub(collateral_spent)
                    .ok_or(PredictionMarketError::MathOverflow)?;

                market.total_collateral_locked = market
                    .total_collateral_locked
                    .checked_sub(collateral_spent)
                    .ok_or(PredictionMarketError::MathOverflow)?;

                // Returning remaining collateral if any remains
                if remaining_amount > 0 {
                    let market_id_bytes = market.market_id.to_le_bytes();
                    let seeds = &[MARKET_SEED, market_id_bytes.as_ref(), &[market.bump]];

                    token::transfer(
                        CpiContext::new_with_signer(
                            self.token_program.to_account_info(),
                            Transfer {
                                from: self.collateral_vault.to_account_info(),
                                to: self.user_collateral.to_account_info(),
                                authority: market.to_account_info(),
                            },
                            &[seeds],
                        ),
                        remaining_amount,
                    )?;

                    // Reduce locked collateral for the returned amount
                    user_stats.locked_collateral = user_stats
                        .locked_collateral
                        .checked_sub(remaining_amount)
                        .ok_or(PredictionMarketError::MathOverflow)?;

                    // Track vault-level collateral leaving
                    market.total_collateral_locked = market
                        .total_collateral_locked
                        .checked_sub(remaining_amount)
                        .ok_or(PredictionMarketError::MathOverflow)?;

                    msg!("Returned {} remaining collateral to user", remaining_amount);
                }
            }
            OrderSide::Sell => {
                let market_id_bytes = market.market_id.to_le_bytes();
                let seeds = &[MARKET_SEED, market_id_bytes.as_ref(), &[market.bump]];

                token::transfer(
                    CpiContext::new_with_signer(
                        self.token_program.to_account_info(),
                        Transfer {
                            from: self.collateral_vault.to_account_info(),
                            to: self.user_collateral.to_account_info(),
                            authority: market.to_account_info(),
                        },
                        &[seeds],
                    ),
                    fullfilled_qty,
                )?;

                // Track vault-level collateral leaving (seller gets paid)
                market.total_collateral_locked = market
                    .total_collateral_locked
                    .checked_sub(fullfilled_qty)
                    .ok_or(PredictionMarketError::MathOverflow)?;

                // Reduce locked tokens for seller
                // For Sell orders: fullfilled_qty = collateral received, we need tokens sold
                let tokens_sold = order_amount
                    .checked_sub(remaining_amount)
                    .ok_or(PredictionMarketError::MathOverflow)?;

                let user_stats = &mut self.user_stats_account;

                match token_type {
                    TokenType::Yes => {
                        user_stats.locked_yes = user_stats
                            .locked_yes
                            .checked_sub(tokens_sold)
                            .ok_or(PredictionMarketError::MathOverflow)?;
                    }
                    TokenType::No => {
                        user_stats.locked_no = user_stats
                            .locked_no
                            .checked_sub(tokens_sold)
                            .ok_or(PredictionMarketError::MathOverflow)?;
                    }
                }

                // Returning remaining tokens if any remain
                if remaining_amount > 0 {
                    let (user_token_account, token_escrow) = match token_type {
                        TokenType::Yes => (&self.user_outcome_yes, &self.yes_escrow),
                        TokenType::No => (&self.user_outcome_no, &self.no_escrow),
                    };

                    let market_id_bytes = market.market_id.to_le_bytes();
                    let seeds = &[MARKET_SEED, market_id_bytes.as_ref(), &[market.bump]];

                    token::transfer(
                        CpiContext::new_with_signer(
                            self.token_program.to_account_info(),
                            Transfer {
                                from: token_escrow.to_account_info(),
                                to: user_token_account.to_account_info(),
                                authority: market.to_account_info(),
                            },
                            &[seeds],
                        ),
                        remaining_amount,
                    )?;

                    // Reduce locked tokens for the returned amount
                    match token_type {
                        TokenType::Yes => {
                            user_stats.locked_yes = user_stats
                                .locked_yes
                                .checked_sub(remaining_amount)
                                .ok_or(PredictionMarketError::MathOverflow)?;
                        }
                        TokenType::No => {
                            user_stats.locked_no = user_stats
                                .locked_no
                                .checked_sub(remaining_amount)
                                .ok_or(PredictionMarketError::MathOverflow)?;
                        }
                    }

                    msg!("Returned {} remaining tokens to user", remaining_amount);
                }
            }
        }

        msg!(
            "Market order: filled {}, remaining {}",
            order_amount - remaining_amount,
            remaining_amount
        );

        emit!(MarketOrderExecuted {
            market_id,
            user: self.user.key(),
            side,
            token_type,
            total_quantity: order_amount - remaining_amount,
            orders_matched: iteration,
            timestamp: Clock::get()?.unix_timestamp,
        });

        // Now we have to Transfer the Assets in their respective accounts
        // The we have to sort the vector out
        // Some additional changes& checks in B/W the code
        // Transfer the Money at same time to the User
        Ok(())
    }
}