use anchor_lang::prelude::*;
use anchor_spl::{
    associated_token::AssociatedToken, token::{self, Transfer}, token_interface::{
        CloseAccount, Mint, TokenAccount, TokenInterface, TransferChecked, close_account, transfer_checked
    }
};

use crate::constants::*;
use crate::error::*;
use crate::state::*;
use crate::events::*;

#[derive(Accounts)]
#[instruction(market_id:u32)]
pub struct PlaceOrder<'info> {
    #[account(mut)]
    pub user: Signer<'info>,

    #[account(
        mut,
        seeds=[MARKET_SEED, market.market_id.to_le_bytes().as_ref()],
        bump = market.bump,
        constraint = market.market_id == market_id,
    )]
    pub market: Box<Account<'info, Market>>,

    #[account(
        mut,
        seeds = [ORDERBOOK_SEED, market.market_id.to_le_bytes().as_ref()],
        bump = orderbook.bump,
        constraint = orderbook.market_id == market_id
    )]
    pub orderbook: Account<'info, OrderBook>,

    #[account(
        mut,
        constraint = collateral_vault.key() == market.collateral_vault
    )]
    pub collateral_vault: InterfaceAccount<'info, TokenAccount>,

    #[account(
        mut,
        constraint = user_collateral.mint == market.collateral_mint,
        constraint = user_collateral.owner == user.key()
    )]
    pub user_collateral: InterfaceAccount<'info, TokenAccount>,

    #[account(
        init_if_needed,
        payer = user,
        space = 8 + UserStats::INIT_SPACE,
        seeds = [USER_STATS_SEED, market_id.to_le_bytes().as_ref(), user.key().as_ref()],
        bump
    )]
    pub user_stats_account: Box<Account<'info, UserStats>>,

    #[account(
        mut,
        constraint = user_outcome_yes.mint == market.outcome_yes_mint,
        constraint = user_outcome_yes.owner == user.key()
    )]
    pub user_outcome_yes: InterfaceAccount<'info, TokenAccount>,

    #[account(
        mut,
        constraint = user_outcome_no.mint == market.outcome_no_mint,
        constraint = user_outcome_no.owner == user.key()
    )]
    pub user_outcome_no: InterfaceAccount<'info, TokenAccount>,

    #[account(
        mut,
        constraint = yes_escrow.mint == market.outcome_yes_mint,
        constraint = yes_escrow.key() == market.yes_escrow
    )]
    pub yes_escrow: InterfaceAccount<'info, TokenAccount>,

    #[account(
        mut,
        constraint = no_escrow.mint == market.outcome_no_mint,
        constraint = no_escrow.key() == market.no_escrow
    )]
    pub no_escrow: InterfaceAccount<'info, TokenAccount>,

    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
    pub token_program: Interface<'info, TokenInterface>,
}

impl<'info> PlaceOrder<'info> {
    /// Place an order to buy or sell outcome tokens
    ///
    /// Flow:
    /// - On placing Order
    ///   - SELL order: Seller's YES/NO tokens locked in escrow immediately
    ///   - BUY order: Buyer's collateral locked in vault immediately
    /// - When matched:
    ///   - Buyer's & Sellers claimable amount will be incremented in their UserStats Account (user can claim later from dashboard)
    ///   - Person whose order is on the orderbook first can withdraw collateral from vault separately
    pub fn handler(
        &mut self,
        market_id: u32,
        side: OrderSide,
        token_type: TokenType,
        quantity: u64,
        price: u64,
        max_iteration: u64,
        bumps: &PlaceOrderBumps,
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

    require!(quantity > 0, PredictionMarketError::InvalidOrderQuantity);
    // There should be another checks for Lamports, We can't pay less than the minimum decimals of the Token
    require!(price > 0, PredictionMarketError::InvalidOrderPrice);

    // Initialising the user stats account
    let user_stats = &mut self.user_stats_account;
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

    let (_mint_type, user_token_account, token_escrow) = match token_type {
        TokenType::Yes => (
            market.outcome_yes_mint,
            &self.user_outcome_yes,
            &self.yes_escrow,
        ),
        TokenType::No => (
            market.outcome_no_mint,
            &self.user_outcome_no,
            &self.no_escrow,
        ),
    };

    let amount = quantity
        .checked_mul(price)
        .ok_or(PredictionMarketError::MathOverflow)?;

    // Lock funds immediately when placing order
    // For Buyer Lock collateral in Vault
    // For Seller Locking tokens in Escrow
    if side == OrderSide::Sell {
        require!(
            user_token_account.amount >= quantity,
            PredictionMarketError::NotEnoughBalance
        );

        token::transfer(
            CpiContext::new(
                self.token_program.to_account_info(),
                Transfer {
                    from: user_token_account.to_account_info(),
                    to: token_escrow.to_account_info(),
                    authority: self.user.to_account_info(),
                },
            ),
            quantity,
        )?;

        let user_stats = &mut self.user_stats_account;

        match token_type {
            TokenType::Yes => {
                user_stats.locked_yes = user_stats
                    .locked_yes
                    .checked_add(quantity)
                    .ok_or(PredictionMarketError::MathOverflow)?;
            }
            TokenType::No => {
                user_stats.locked_no = user_stats
                    .locked_no
                    .checked_add(quantity)
                    .ok_or(PredictionMarketError::MathOverflow)?;
            }
        }
    } else {
        require!(
            self.user_collateral.amount >= amount,
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
            amount,
        )?;

        // Locking the collateral
        let user_stats = &mut self.user_stats_account;
        user_stats.locked_collateral = user_stats
            .locked_collateral
            .checked_add(amount)
            .ok_or(PredictionMarketError::MathOverflow)?;
    }

    let mut order = Order {
        id: orderbook.next_order_id,
        market_id: market.market_id,
        user_key: self.user.key(),
        side,
        token_type,
        price,
        quantity,
        filledquantity: 0,
        timestamp: Clock::get()?.unix_timestamp,
    };

    orderbook.next_order_id = orderbook
        .next_order_id
        .checked_add(1)
        .ok_or(PredictionMarketError::MathOverflow)?;

    let mut idx = 0;
    let mut iteration = 0;

    // Get the appropriate order vectors based on token type and side
    let (matching_orders, is_buy_order) = match (token_type, side) {
        (TokenType::Yes, OrderSide::Buy) => (&mut orderbook.yes_sell_orders, true),
        (TokenType::Yes, OrderSide::Sell) => (&mut orderbook.yes_buy_orders, false),
        (TokenType::No, OrderSide::Buy) => (&mut orderbook.no_sell_orders, true),
        (TokenType::No, OrderSide::Sell) => (&mut orderbook.no_buy_orders, false),
    };

    // Iterating through all order to find matching order
    while idx < matching_orders.len() && iteration < max_iteration {
        let (book_price, book_qty, book_filled_qty) = {
            let book_order = &matching_orders[idx];
            (
                book_order.price,
                book_order.quantity,
                book_order.filledquantity,
            )
        };

        // Price matching logic:
        let price_matches = if is_buy_order {
            order.price >= book_price // Buyer matches with lower or equal sell prices
        } else {
            order.price <= book_price // Seller matches with higher or equal buy prices
        };

        if price_matches {
            // user cannot match their own orders
            if matching_orders[idx].user_key == self.user.key() {
                idx += 1;
                continue;
            }

            // Calculate remaining quantities
            let our_left_qty = order
                .quantity
                .checked_sub(order.filledquantity)
                .ok_or(PredictionMarketError::MathOverflow)?;
            let book_left_qty = book_qty
                .checked_sub(book_filled_qty)
                .ok_or(PredictionMarketError::MathOverflow)?;
            let min_qty = our_left_qty.min(book_left_qty);

            // If our order is fully filled, we're done
            if our_left_qty == 0 {
                break;
            }

            // If book order is empty, remove it and continue, imp: not inc. idx
            if book_left_qty == 0 {
                matching_orders.remove(idx);
                continue;
            }

            // Update filled quantities
            matching_orders[idx].filledquantity = book_filled_qty
                .checked_add(min_qty)
                .ok_or(PredictionMarketError::MathOverflow)?;

            order.filledquantity = order
                .filledquantity
                .checked_add(min_qty)
                .ok_or(PredictionMarketError::MathOverflow)?;

            let collateral_amount = min_qty
                .checked_mul(book_price)
                .ok_or(PredictionMarketError::MathOverflow)?;

            // Credit the appropriate user stats based on whether this is a buy or sell order
            if is_buy_order {
                match token_type {
                    TokenType::Yes => {
                        self.user_stats_account.claimable_yes = self
                            .user_stats_account
                            .claimable_yes
                            .checked_add(min_qty)
                            .ok_or(PredictionMarketError::MathOverflow)?;
                    }
                    TokenType::No => {
                        self.user_stats_account.claimable_no = self
                            .user_stats_account
                            .claimable_no
                            .checked_add(min_qty)
                            .ok_or(PredictionMarketError::MathOverflow)?;
                    }
                }

                self.user_stats_account.locked_collateral = self
                    .user_stats_account
                    .locked_collateral
                    .checked_sub(collateral_amount)
                    .ok_or(PredictionMarketError::MathOverflow)?;

                // Credit SELLER (from matching order) with collateral
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
                for account_info in remaining_accounts.iter() {
                    if account_info.key == &seller_stats_pda {
                        let mut data = account_info.try_borrow_mut_data()?;
                        let mut seller_stats = UserStats::try_deserialize(&mut &data[..])?;

                        seller_stats.claimable_collateral = seller_stats
                            .claimable_collateral
                            .checked_add(collateral_amount)
                            .ok_or(PredictionMarketError::MathOverflow)?;

                        // Reduce seller's locked tokens since order was filled
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

                msg!(
                    "Trade: Buyer +{} claimable {:?}, Seller +{} claimable collateral",
                    min_qty,
                    token_type,
                    collateral_amount
                );
            } else {
                // When user is SELLER - credit collateral and reduce locked tokens
                self.user_stats_account.claimable_collateral = self
                    .user_stats_account
                    .claimable_collateral
                    .checked_add(collateral_amount)
                    .ok_or(PredictionMarketError::MathOverflow)?;

                // Reduce seller's locked tokens since order was filled
                match token_type {
                    TokenType::Yes => {
                        self.user_stats_account.locked_yes = self
                            .user_stats_account
                            .locked_yes
                            .checked_sub(min_qty)
                            .ok_or(PredictionMarketError::MathOverflow)?;
                    }
                    TokenType::No => {
                        self.user_stats_account.locked_no = self
                            .user_stats_account
                            .locked_no
                            .checked_sub(min_qty)
                            .ok_or(PredictionMarketError::MathOverflow)?;
                    }
                }

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

                        // Reduce buyer's locked collateral since order was filled
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

                msg!(
                    "Trade: Seller +{} claimable collateral, Buyer +{} claimable {:?}",
                    collateral_amount,
                    min_qty,
                    token_type
                );
            }

            // Remove completed orders or advance to next
            if matching_orders[idx].filledquantity >= matching_orders[idx].quantity {
                matching_orders.remove(idx);
                // Don't increment idx since we removed the element
            } else {
                idx += 1;
            }

            iteration += 1;
        } else {
            // No more matching orders
            break;
        }
    }

    // If order is not fully filled, add it to the appropriate order book
    if order.filledquantity < order.quantity {
        // Calculate space requirements BEFORE getting mutable references
        let current_space = orderbook.to_account_info().data_len();
        let required_space = orderbook.space_with_growth(ORDERBOOK_GROWTH_BATCH);
        let needs_realloc = required_space > current_space;

        let order_vec = match (token_type, side) {
            (TokenType::Yes, OrderSide::Buy) => &mut orderbook.yes_buy_orders,
            (TokenType::Yes, OrderSide::Sell) => &mut orderbook.yes_sell_orders,
            (TokenType::No, OrderSide::Buy) => &mut orderbook.no_buy_orders,
            (TokenType::No, OrderSide::Sell) => &mut orderbook.no_sell_orders,
        };

        // Check if we've exceeded the maximum orders for this side
        require!(
            order_vec.len() < MAX_ORDERS_PER_SIDE,
            PredictionMarketError::OrderBookFull
        );

        // Reallocate if needed (user pays ONLY for the growth batch, not entire max size)
        if needs_realloc {
            let new_space = required_space.min(OrderBook::space(MAX_ORDERS_PER_SIDE));
            orderbook.to_account_info().resize(new_space)?;

            // Transfer rent from user to orderbook account for the INCREMENTAL space
            let rent = Rent::get()?;
            let new_minimum_balance = rent.minimum_balance(new_space);
            let current_balance = orderbook.to_account_info().lamports();

            if new_minimum_balance > current_balance {
                let lamports_needed = new_minimum_balance - current_balance;
                anchor_lang::system_program::transfer(
                    CpiContext::new(
                        self.system_program.to_account_info(),
                        anchor_lang::system_program::Transfer {
                            from: self.user.to_account_info(),
                            to: orderbook.to_account_info(),
                        },
                    ),
                    lamports_needed,
                )?;

                msg!(
                    "User paid {} lamports for orderbook growth (batch size: {})",
                    lamports_needed,
                    ORDERBOOK_GROWTH_BATCH
                );
            }
            // Reload the orderbook
            orderbook.reload()?;
        }

        // Re-get mutable reference after reallocation
        let order_vec = match (token_type, side) {
            (TokenType::Yes, OrderSide::Buy) => &mut orderbook.yes_buy_orders,
            (TokenType::Yes, OrderSide::Sell) => &mut orderbook.yes_sell_orders,
            (TokenType::No, OrderSide::Buy) => &mut orderbook.no_buy_orders,
            (TokenType::No, OrderSide::Sell) => &mut orderbook.no_sell_orders,
        };

        order_vec.push(order);

        // Sorting Buy order in Decrement & Sell orders in Increment acc. to price
        if side == OrderSide::Buy {
            order_vec.sort_by(|a, b| b.price.cmp(&a.price));
        } else {
            order_vec.sort_by(|a, b| a.price.cmp(&b.price));
        }
    }

    msg!(
        "Order processed: {} filled, {} remaining",
        order.filledquantity,
        order.quantity - order.filledquantity
    );

    emit!(OrderPlaced {
        market_id,
        order_id: order.id,
        user: self.user.key(),
        side,
        token_type,
        price,
        quantity,
        timestamp: order.timestamp,
    });

    Ok(())
    }
}
