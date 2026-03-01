import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { PredictionMarketTurbin3 } from "../target/types/prediction_market_turbin3";
import {
  PublicKey,
  Keypair,
  SystemProgram,
  LAMPORTS_PER_SOL,
  Connection,
} from "@solana/web3.js";
import {
  createMint,
  getOrCreateAssociatedTokenAccount,
  mintTo,
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  getAccount,
} from "@solana/spl-token";
import { BN } from "bn.js";
import { assert, expect } from "chai";

describe("prediction_market", () => {
  // Configure the client to use the local cluster.
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace
    .predictionMarketTurbin3 as Program<PredictionMarketTurbin3>;

  let authority = provider.wallet;
  let user: Keypair;

  // Mints and Accounts
  let collateralMint: PublicKey;
  let collateralVault: PublicKey;
  let outcomeYesMint: PublicKey;
  let outcomeNoMint: PublicKey;
  let marketPda: PublicKey;
  let orderbookPda: PublicKey;
  let yesEscrowPda: PublicKey;
  let noEscrowPda: PublicKey;

  // User Account
  let userCollateralAccount: PublicKey;
  let userOutcomeYesAccount: PublicKey;
  let userOutcomeNoAccount: PublicKey;
  let userStatsAccount: PublicKey;

  let marketId = 1;
  let max_iteration = 20;
  let USDC_UNIT = 1_000_000;
  const initialCollateralAmount = 200_000_000; //200 USDC

  before(async () => {
    user = Keypair.generate();

    const airdropSignature = await provider.connection.requestAirdrop(
      user.publicKey,
      anchor.web3.LAMPORTS_PER_SOL * 2,
    );

    await provider.connection.confirmTransaction(airdropSignature);

    collateralMint = await createMint(
      provider.connection,
      authority.payer,
      authority?.publicKey,
      null,
      6,
    );

    console.log("Collateral Mint:", collateralMint.toBase58());
  });

  describe("Initialize Market", () => {
    it("Intialising the Prediction Market Succesfully", async () => {
      const settlementDeadline = new anchor.BN(
        Math.floor(Date.now() / 1000) + 86400,
      );

      const marketID = new BN(1);
      const marketIdLE = marketID.toArrayLike(Buffer, "le", 4); // Converting it into 4-byte little-endian Buffer

      [marketPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("market"), marketIdLE],
        program.programId,
      );
      [collateralVault] = PublicKey.findProgramAddressSync(
        [Buffer.from("vault"), marketIdLE],
        program.programId,
      );
      [outcomeYesMint] = PublicKey.findProgramAddressSync(
        [Buffer.from("outcome_a"), marketIdLE],
        program.programId,
      );
      [outcomeNoMint] = PublicKey.findProgramAddressSync(
        [Buffer.from("outcome_b"), marketIdLE],
        program.programId,
      );
      [orderbookPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("orderbook"), marketIdLE],
        program.programId,
      );
      [yesEscrowPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("escrow"), marketIdLE, outcomeYesMint.toBuffer()],
        program.programId,
      );
      [noEscrowPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("escrow"), marketIdLE, outcomeNoMint.toBuffer()],
        program.programId,
      );
      [userStatsAccount] = PublicKey.findProgramAddressSync(
        [Buffer.from("user_stats"), marketIdLE, user.publicKey.toBuffer()],
        program.programId,
      );

      console.log("Market PDA:", marketPda.toBase58());
      console.log("Collateral Vault PDA:", collateralVault.toBase58());
      console.log("Outcome Yes Mint PDA:", outcomeYesMint.toBase58());
      console.log("Outcome No Mint PDA:", outcomeNoMint.toBase58());
      console.log("Orderbook PDA:", orderbookPda.toBase58());
      console.log("Yes Escrow PDA:", yesEscrowPda.toBase58());
      console.log("No Escrow PDA:", noEscrowPda.toBase58());
      console.log("User Stats Account PDA:", userStatsAccount.toBase58());

      // Now you can see all the accounts needed for initializeMarket!
      await program.methods
        .initializeMarket(marketId, settlementDeadline, "")
        .accounts({
          market: marketPda,
          authority: authority.publicKey,
          collateralMint: collateralMint,
          collateralVault,
          outcomeYesMint,
          outcomeNoMint,
          yesEscrowPda,
          noEscrowPda,
          orderbookPda,
          systemProgram: SystemProgram.programId,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .rpc();

      console.log("Market initialized successfully!");
      console.log("Market PDA:", marketPda.toBase58());
    });
  });

  describe("Split Tokens", () => {
    before(async () => {
      // What we want to do is that fund the User Mint Account
      let userCollateralAccountInfo = await getOrCreateAssociatedTokenAccount(
        provider.connection,
        authority.payer,
        collateralMint,
        user.publicKey,
      );

      userCollateralAccount = userCollateralAccountInfo.address;
      // Now we will mint tokens in the user Account

      await mintTo(
        provider.connection,
        authority.payer,
        collateralMint,
        userCollateralAccount,
        authority.publicKey,
        initialCollateralAmount,
      );
      console.log("Tokens Minted to the User wallet");

      let outcomeAAccountInfo = await getOrCreateAssociatedTokenAccount(
        provider.connection,
        authority.payer,
        outcomeYesMint,
        user.publicKey,
      );
      userOutcomeYesAccount = outcomeAAccountInfo.address;

      let outcomeBAccountInfo = await getOrCreateAssociatedTokenAccount(
        provider.connection,
        authority.payer,
        outcomeNoMint,
        user.publicKey,
      );
      userOutcomeNoAccount = outcomeBAccountInfo.address;

      console.log(
        "In Before of Split Token, funded the user collateral account & outcome accounts",
      );
    });

    it("Split Collateral Account & fund both the Outcome Account of User", async () => {
      const splitAmount = initialCollateralAmount / 2;

      let userCollateralAccountBefore = await getAccount(
        provider.connection,
        userCollateralAccount,
      );

      await program.methods
        .splitTokens(marketId, new anchor.BN(splitAmount))
        .accounts({
          market: marketPda,
          user: user.publicKey,
          userCollateral: userCollateralAccount,
          collateralVault,
          outcomeYesMint,
          outcomeNoMint,
          userOutcomeYes: userOutcomeYesAccount,
          userOutcomeNo: userOutcomeNoAccount,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([user])
        .rpc();

      let userCollateralAccountAfter = await getAccount(
        provider.connection,
        userCollateralAccount,
      );

      //Ok Now we have to verify does the tokens really Split

      //Getting the Outcome Account
      let outcomeAAccount = await getAccount(
        provider.connection,
        userOutcomeYesAccount,
      );
      let outcomeBAccount = await getAccount(
        provider.connection,
        userOutcomeNoAccount,
      );
      let vault = await getAccount(provider.connection, collateralVault);
      assert.equal(Number(outcomeAAccount.amount), splitAmount);
      assert.equal(Number(outcomeBAccount.amount), splitAmount);
      assert.equal(Number(vault.amount), splitAmount);
      //checking the user Balance
      assert.equal(
        Number(userCollateralAccountBefore.amount) -
          Number(userCollateralAccountAfter.amount),
        splitAmount,
      );

      //Now the Market is initialised & we will verify the state of market, like how much is locked in the market right now
      const market = await program.account.market.fetch(marketPda);
      assert.equal(Number(market.totalCollateralLocked), splitAmount);
    });

    it("What If we give zero amount, then we will observe the State", async () => {
      try {
        const splitAmount = 0;
        await program.methods
          .splitTokens(marketId, new anchor.BN(splitAmount))
          .accounts({
            market: marketPda,
            user: user.publicKey,
            userCollateral: userCollateralAccount,
            collateralVault,
            outcomeYesMint,
            outcomeNoMint,
            userOutcomeYes: userOutcomeYesAccount,
            userOutcomeNo: userOutcomeNoAccount,
            userStatsAccount,
            systemProgram: SystemProgram.programId,
            associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
            tokenProgram: TOKEN_PROGRAM_ID,
          })
          .signers([user])
          .rpc();
      } catch (err) {
        expect(err.toString()).to.include("InvalidAmount");
      }
    });
  });

  describe("Testing OrderBook", async () => {
    let other_user = Keypair.generate();
    let other_userCollateralAccount: PublicKey;
    let other_userOutcomeYesAccount: PublicKey;
    let other_userOutcomeNoAccount: PublicKey;
    let other_userStatsAccount: PublicKey;
    let other_user_initial_amount_for_otherTokens = initialCollateralAmount / 2;

    before(async () => {
      // Order book is already defined, we will just make an order and push it in the orderbook
      // For that what we need is a Seller(other User), Let's give him Collateral & tokens already

      const airdropSignature = await provider.connection.requestAirdrop(
        other_user.publicKey,
        5 * LAMPORTS_PER_SOL,
      );

      await provider.connection.confirmTransaction(airdropSignature);

      let other_userCollateralAccountInfo =
        await getOrCreateAssociatedTokenAccount(
          provider.connection,
          authority.payer,
          collateralMint,
          other_user.publicKey,
        );

      other_userCollateralAccount = other_userCollateralAccountInfo.address;
      // Now we will mint tokens in the other_user Account

      await mintTo(
        provider.connection,
        authority.payer,
        collateralMint,
        other_userCollateralAccount,
        authority.publicKey,
        initialCollateralAmount,
      );

      let outcomeAAccountInfo = await getOrCreateAssociatedTokenAccount(
        provider.connection,
        authority.payer,
        outcomeYesMint,
        other_user.publicKey,
      );
      other_userOutcomeYesAccount = outcomeAAccountInfo.address;

      let outcomeBAccountInfo = await getOrCreateAssociatedTokenAccount(
        provider.connection,
        authority.payer,
        outcomeNoMint,
        other_user.publicKey,
      );
      other_userOutcomeNoAccount = outcomeBAccountInfo.address;

      // Get UserStats PDA for other_user
      const marketIdLE = new BN(marketId).toArrayLike(Buffer, "le", 4);
      [other_userStatsAccount] = PublicKey.findProgramAddressSync(
        [
          Buffer.from("user_stats"),
          marketIdLE,
          other_user.publicKey.toBuffer(),
        ],
        program.programId,
      );

      // Use split_tokens to get outcome tokens (market PDA is the mint authority)
      await program.methods
        .splitTokens(
          marketId,
          new BN(other_user_initial_amount_for_otherTokens),
        )
        .accounts({
          market: marketPda,
          user: other_user.publicKey,
          userCollateral: other_userCollateralAccount,
          collateralVault,
          outcomeYesMint,
          outcomeNoMint,
          userOutcomeYes: other_userOutcomeYesAccount,
          userOutcomeNo: other_userOutcomeNoAccount,
          userStatsAccount: other_userStatsAccount,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([other_user])
        .rpc();

      let otherUserCollateralAccount = await getAccount(
        provider.connection,
        other_userCollateralAccount,
      );
      let otherUserYesAccount = await getAccount(
        provider.connection,
        other_userOutcomeYesAccount,
      );
      let otherUserNoAccount = await getAccount(
        provider.connection,
        other_userOutcomeNoAccount,
      );

      let mainUserCollateralAccount = await getAccount(
        provider.connection,
        userCollateralAccount,
      );
      let mainUserYesAccount = await getAccount(
        provider.connection,
        userOutcomeYesAccount,
      );
      let mainUserNoAccount = await getAccount(
        provider.connection,
        userOutcomeNoAccount,
      );

      console.log(
        "Main User - Collateral:",
        mainUserCollateralAccount.amount,
        "Yes:",
        mainUserYesAccount.amount,
        "No:",
        mainUserNoAccount.amount,
      );

      console.log(
        "Other User - Collateral:",
        otherUserCollateralAccount.amount,
        "Yes:",
        otherUserYesAccount.amount,
        "No:",
        otherUserNoAccount.amount,
      );
    });
    it("Placing order in the orderbook", async () => {
      const orderqty = 10;
      const price = 0.5 * USDC_UNIT; // 0.5
      const orderAmount = orderqty * price;

      let userCollateralAccountBefore = await getAccount(
        provider.connection,
        userCollateralAccount,
      );
      let userStatsAccountinfoBefore = await program.account.userStats.fetch(
        userStatsAccount,
      );

      await program.methods
        .placeOrder(
          marketId,
          { buy: {} },
          { yes: {} },
          new BN(orderqty),
          new BN(price),
          new BN(max_iteration),
        )
        .accounts({
          market: marketPda,
          orderbook: orderbookPda,
          user: user.publicKey,
          userOutcomeYes: userOutcomeYesAccount,
          userOutcomeNo: userOutcomeNoAccount,
          collateralVault,
          userCollateral: userCollateralAccount,
          userStatsAccount,
          yesEscrow: yesEscrowPda,
          noEscrow: noEscrowPda,
          systemProgram: SystemProgram.programId,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([user])
        .rpc();

      // Now  I have to check in the user stats account of the user
      // Check the locked amount
      // Check our account, Is the money debited
      // Check inside the orderbook,

      let userCollateralAccountAfter = await getAccount(
        provider.connection,
        userCollateralAccount,
      );

      let userStatsAccountinfoAfter = await program.account.userStats.fetch(
        userStatsAccount,
      );

      // checking the collateral Difference
      assert.equal(
        Number(userCollateralAccountBefore.amount) -
          Number(userCollateralAccountAfter.amount),
        orderAmount,
      );
      // checking the locked amount
      assert.equal(
        Number(userStatsAccountinfoAfter.lockedCollateral) -
          Number(userStatsAccountinfoBefore.lockedCollateral),
        orderAmount,
      );
      // Inspecting orderbook
      {
        let orderbookInfo = await program.account.orderBook.fetch(orderbookPda);
        assert.equal(orderbookInfo.yesBuyOrders.length, 1);
        assert.equal(Number(orderbookInfo.yesBuyOrders[0].quantity), orderqty);
        assert.equal(Number(orderbookInfo.yesBuyOrders[0].price), price);

        console.log(" user A stats BEFORE:");
        console.log(
          "  Locked YES:",
          Number(userStatsAccountinfoAfter.lockedYes),
        );
        console.log("  Locked NO:", Number(userStatsAccountinfoAfter.lockedNo));
        console.log(
          "  Locked Collateral:",
          Number(userStatsAccountinfoAfter.lockedCollateral),
        );
        console.log(
          "  Claimable YES:",
          Number(userStatsAccountinfoAfter.claimableYes),
        );
        console.log(
          "  Claimable NO:",
          Number(userStatsAccountinfoAfter.claimableNo),
        );
        console.log(
          "  Claimable Collateral:",
          Number(userStatsAccountinfoAfter.claimableCollateral),
        );
      }

      console.log("Order placed successfully in the orderbook");
    });

    it("Matching order with other person", async () => {
      // Placing a matching order - other_user places a SELL order for NO at 0.4 (matches with BUY YES at 0.6)

      let sell_orderqty = 5;
      let sell_price = 0.4 * USDC_UNIT;

      let orderbook = await program.account.orderBook.fetch(orderbookPda);
      let min_qty = Math.min(
        sell_orderqty,
        Number(orderbook.yesBuyOrders[0].quantity),
      );

      // For the Price, It will always execute acc. to the order resting inside the orderbook
      let buy_price = Number(orderbook.yesBuyOrders[0].price);

      let otherUserStatsAccountinfoBefore =
        await program.account.userStats.fetch(other_userStatsAccount);

      let otherUserOutcomeYesAccountBefore = await getAccount(
        provider.connection,
        other_userOutcomeYesAccount,
      );

      let userStatsAccountinfoBefore = await program.account.userStats.fetch(
        userStatsAccount,
      );

      // this time the other user will place the order & we will then check the other user
      await program.methods
        .placeOrder(
          marketId,
          { sell: {} },
          { yes: {} },
          new BN(sell_orderqty),
          new BN(sell_price),
          new BN(max_iteration),
        )
        .accounts({
          market: marketPda,
          orderbook: orderbookPda,
          user: other_user.publicKey,
          userOutcomeYes: other_userOutcomeYesAccount,
          userOutcomeNo: other_userOutcomeNoAccount,
          collateralVault,
          userCollateral: other_userCollateralAccount,
          userStatsAccount: other_userStatsAccount,
          yesEscrow: yesEscrowPda,
          noEscrow: noEscrowPda,
          systemProgram: SystemProgram.programId,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .remainingAccounts([
          {
            pubkey: userStatsAccount,
            isSigner: false,
            isWritable: true,
          },
        ])
        .signers([other_user])
        .rpc();

      // Check other_user stats after matching
      let otherUserStatsAccountinfoAfter =
        await program.account.userStats.fetch(other_userStatsAccount);

      let otherUserOutcomeYesAccountAfter = await getAccount(
        provider.connection,
        other_userOutcomeYesAccount,
      );

      let userStatsAccountinfoAfter = await program.account.userStats.fetch(
        userStatsAccount,
      );

      // We will have to find the min_qty from our current Order and eisiting order
      // in the orderbook
      // and accordingly we will check What's reduced, Like Take Qty

      let amount = min_qty * buy_price;

      // For seller
      // Checking the claimable collateral
      assert.equal(
        Number(otherUserStatsAccountinfoAfter.claimableCollateral) -
          Number(otherUserStatsAccountinfoBefore.claimableCollateral),
        amount,
      );
      // Checking the missing A Tokens from the other user ATA
      assert.equal(
        Number(otherUserOutcomeYesAccountBefore.amount) -
          Number(otherUserOutcomeYesAccountAfter.amount),
        min_qty,
      );

      // For Buyer
      // Checking the locked collateral
      assert.equal(
        Number(userStatsAccountinfoBefore.lockedCollateral) -
          Number(userStatsAccountinfoAfter.lockedCollateral),
        amount,
      );
      // Checking the claimable yes
      assert.equal(
        Number(userStatsAccountinfoAfter.claimableYes) -
          Number(userStatsAccountinfoBefore.claimableYes),
        min_qty,
      );

      {
        console.log("\n" + "=".repeat(80));
        console.log("📊 AFTER MATCH - Account Balances After Order Match");
        console.log("=".repeat(80));
        console.log("\n=== User (Buyer) - AFTER Match ===");
        console.log(
          "  Locked YES:",
          Number(userStatsAccountinfoAfter.lockedYes),
        );
        console.log("  Locked NO:", Number(userStatsAccountinfoAfter.lockedNo));
        console.log(
          "  Locked Collateral:",
          Number(userStatsAccountinfoAfter.lockedCollateral),
        );
        console.log(
          "  Claimable YES:",
          Number(userStatsAccountinfoAfter.claimableYes),
        );
        console.log(
          "  Claimable NO:",
          Number(userStatsAccountinfoAfter.claimableNo),
        );
        console.log(
          "  Claimable Collateral:",
          Number(userStatsAccountinfoAfter.claimableCollateral),
        );

        console.log("\n=== Other User (Seller) - AFTER Match ===");
        console.log(
          "  Locked YES:",
          Number(otherUserStatsAccountinfoAfter.lockedYes),
        );
        console.log(
          "  Locked NO:",
          Number(otherUserStatsAccountinfoAfter.lockedNo),
        );
        console.log(
          "  Locked Collateral:",
          Number(otherUserStatsAccountinfoAfter.lockedCollateral),
        );
        console.log(
          "  Claimable YES:",
          Number(otherUserStatsAccountinfoAfter.claimableYes),
        );
        console.log(
          "  Claimable NO:",
          Number(otherUserStatsAccountinfoAfter.claimableNo),
        );
        console.log(
          "  Claimable Collateral:",
          Number(otherUserStatsAccountinfoAfter.claimableCollateral),
        );
        console.log("=".repeat(80) + "\n");
      }

      // Check orderbook state after matching
      let orderbookInfoAfter = await program.account.orderBook.fetch(
        orderbookPda,
      );

      {
        console.log("\n" + "-".repeat(80));
        console.log("📖 ORDERBOOK STATE - After Match");
        console.log("-".repeat(80));
        console.log(
          "  YES Buy Orders:",
          orderbookInfoAfter.yesBuyOrders.length,
        );
        console.log(
          "  YES Sell Orders:",
          orderbookInfoAfter.yesSellOrders.length,
        );
        console.log("  NO Buy Orders:", orderbookInfoAfter.noBuyOrders.length);
        console.log(
          "  NO Sell Orders:",
          orderbookInfoAfter.noSellOrders.length,
        );
      }

      // Check the first user's order (should be partially filled)
      if (orderbookInfoAfter.yesBuyOrders.length > 0) {
        let firstUserOrder = orderbookInfoAfter.yesBuyOrders[0];
        console.log("\nFirst user's order:");
        console.log("  Quantity:", Number(firstUserOrder.quantity));
        console.log(
          "  Filled Quantity:",
          Number(firstUserOrder.filledquantity),
        );
        console.log("  Price:", Number(firstUserOrder.price));

        // Filled - remaining quantity should also be present into his locked Collateral User stats account

        let remaining_qty =
          Number(firstUserOrder.quantity) -
          Number(firstUserOrder.filledquantity);
        let remaining_collateral = remaining_qty * Number(firstUserOrder.price);

        assert.equal(
          Number(userStatsAccountinfoBefore.lockedCollateral) -
            Number(userStatsAccountinfoAfter.lockedCollateral),
          remaining_collateral,
        );
      }

      // Check if other_user's order was completely filled (should not be in orderbook)
      let otherUserOrderExists = orderbookInfoAfter.noSellOrders.length > 0;
      console.log("\nOther user's order still in book?", otherUserOrderExists);

      // If the order was completely matched, it should not be in the orderbook
      // If it's partially matched, it should still be there
      if (otherUserOrderExists) {
        let otherUserOrder = orderbookInfoAfter.noSellOrders[0];
        console.log("  Quantity:", Number(otherUserOrder.quantity));
        console.log(
          "  Filled Quantity:",
          Number(otherUserOrder.filledquantity),
        );
      }

      console.log("\nOrder matching completed successfully!");
    });

    it("Checking if orderbook can complete subsequent orders", async () => {
      // Other user will place orders
      //making order in the orderbook
      console.log("\n" + "=".repeat(80));
      console.log("📋 SUBSEQUENT ORDERS TEST");
      console.log("=".repeat(80));

      let UserCurrentCollateralAccountinfoBefore = await getAccount(
        provider.connection,
        userCollateralAccount,
      );
      let UserCurrentStatsAccountBefore = await program.account.userStats.fetch(
        userStatsAccount,
      );

      let orderqty = 2;
      let priceStart = 0.6 * USDC_UNIT;
      let priceIncrement = 0.1 * USDC_UNIT;

      {
        console.log("\n" + "-".repeat(80));
        console.log("User State BEFORE placing 20 buy orders");
        console.log("-".repeat(80));
        let userStatsAfterMatch = await program.account.userStats.fetch(
          userStatsAccount,
        );
        // Get token account balances
        let userCollateralBalance = await getAccount(
          provider.connection,
          userCollateralAccount,
        );
        let userYesBalance = await getAccount(
          provider.connection,
          userOutcomeYesAccount,
        );
        let userNoBalance = await getAccount(
          provider.connection,
          userOutcomeNoAccount,
        );

        console.log("\n=== User Stats before Match ===");
        console.log("User (Buyer):");
        console.log("  Locked YES:", Number(userStatsAfterMatch.lockedYes));
        console.log("  Locked NO:", Number(userStatsAfterMatch.lockedNo));
        console.log(
          "  Locked Collateral:",
          Number(userStatsAfterMatch.lockedCollateral),
        );
        console.log(
          "  Claimable YES:",
          Number(userStatsAfterMatch.claimableYes),
        );
        console.log("  Claimable NO:", Number(userStatsAfterMatch.claimableNo));
        console.log(
          "  Claimable Collateral:",
          Number(userStatsAfterMatch.claimableCollateral),
        );

        console.log("\n  💰 Token Account Balances of User :");
        console.log("     Collateral:", Number(userCollateralBalance.amount));
        console.log("     YES tokens:", Number(userYesBalance.amount));
        console.log("     NO tokens:", Number(userNoBalance.amount));
        console.log("-".repeat(80) + "\n");
      }

      for (let i = 0; i < 10; i++) {
        await program.methods
          .placeOrder(
            marketId,
            { buy: {} },
            { yes: {} },
            new BN(orderqty),
            new BN(priceStart + i * priceIncrement),
            new BN(max_iteration),
          )
          .accounts({
            market: marketPda,
            orderbook: orderbookPda,
            user: user.publicKey,
            userOutcomeYes: userOutcomeYesAccount,
            userOutcomeNo: userOutcomeNoAccount,
            collateralVault,
            userCollateral: userCollateralAccount,
            userStatsAccount,
            yesEscrow: yesEscrowPda,
            noEscrow: noEscrowPda,
            systemProgram: SystemProgram.programId,
            tokenProgram: TOKEN_PROGRAM_ID,
          })
          .signers([user])
          .rpc();
      }

      // How orderbook looks like
      {
        console.log("\n" + "-".repeat(80));
        console.log("📖 ORDERBOOK STATE - After Buyer Places 20 Orders");
        console.log("-".repeat(80));
        let orderbookInfoAfter = await program.account.orderBook.fetch(
          orderbookPda,
        );
        console.log("\nOrderbook after matching:");
        console.log(
          "  YES Buy Orders:",
          orderbookInfoAfter.yesBuyOrders.length,
        );
        console.log(
          "  YES Sell Orders:",
          orderbookInfoAfter.yesSellOrders.length,
        );
        console.log("  NO Buy Orders:", orderbookInfoAfter.noBuyOrders.length);
        console.log(
          "  NO Sell Orders:",
          orderbookInfoAfter.noSellOrders.length,
        );

        let i = 0;
        while (i < orderbookInfoAfter.yesBuyOrders.length) {
          const order = orderbookInfoAfter.yesBuyOrders[i];
          console.log(`Order ${i}:`, {
            quantity: Number(order.quantity),
            filledQuantity: Number(order.filledquantity),
            price: Number(order.price) / USDC_UNIT,
          });
          i++;
        }
        console.log("-".repeat(80) + "\n");
      }

      let UserCurrentCollateralAccountinfoAfter = await getAccount(
        provider.connection,
        userCollateralAccount,
      );
      let UserCurrentStatsAccountAfter = await program.account.userStats.fetch(
        userStatsAccount,
      );

      let amount_invested_buying =
        Number(UserCurrentCollateralAccountinfoBefore.amount) -
        Number(UserCurrentCollateralAccountinfoAfter.amount);

      assert.equal(
        amount_invested_buying,
        Number(UserCurrentStatsAccountAfter.lockedCollateral) -
          Number(UserCurrentStatsAccountBefore.lockedCollateral),
        "Locked amount is not right in the userstats account after placing orders",
      );

      // Other user putting his sell otder
      let other_user_qty_sell = 20;
      let other_user_price_sell = 0.5 * USDC_UNIT;

      await program.methods
        .placeOrder(
          marketId,
          { sell: {} },
          { yes: {} },
          new BN(other_user_qty_sell),
          new BN(other_user_price_sell),
          new BN(max_iteration),
        )
        .accounts({
          market: marketPda,
          orderbook: orderbookPda,
          user: other_user.publicKey,
          userOutcomeYes: other_userOutcomeYesAccount,
          userOutcomeNo: other_userOutcomeNoAccount,
          collateralVault,
          userCollateral: other_userCollateralAccount,
          userStatsAccount: other_userStatsAccount,
          yesEscrow: yesEscrowPda,
          noEscrow: noEscrowPda,
          systemProgram: SystemProgram.programId,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .remainingAccounts([
          {
            pubkey: userStatsAccount,
            isSigner: false,
            isWritable: true,
          },
        ])
        .signers([other_user])
        .rpc();

      // Logs inside the Orderbook after Seller Put his order
      {
        //Logs inside the Orderbook
        console.log("\n" + "-".repeat(80));
        console.log(
          "📖 ORDERBOOK STATE - After Seller Places Big Order (40 YES @ 0.5)",
        );
        console.log("-".repeat(80));
        let orderbookInfoAfter2 = await program.account.orderBook.fetch(
          orderbookPda,
        );
        console.log("\nOrderbook after matching:");
        console.log(
          "  YES Buy Orders:",
          orderbookInfoAfter2.yesBuyOrders.length,
        );
        console.log(
          "  YES Sell Orders:",
          orderbookInfoAfter2.yesSellOrders.length,
        );
        console.log("  NO Buy Orders:", orderbookInfoAfter2.noBuyOrders.length);
        console.log(
          "  NO Sell Orders:",
          orderbookInfoAfter2.noSellOrders.length,
        );

        let i = 0;
        console.log("\nRemaining Buy Orders:");
        while (i < orderbookInfoAfter2.yesBuyOrders.length) {
          const order = orderbookInfoAfter2.yesBuyOrders[i];
          console.log(`Order ${i}:`, {
            quantity: Number(order.quantity),
            filledQuantity: Number(order.filledquantity),
            price: Number(order.price) / USDC_UNIT,
          });
          i++;
        }
        console.log("-".repeat(80) + "\n");
      }

      // Let's check the Claimed yes of the Userstats Account of the User
      // Then we also have to check the claimable Collateral inside the Other User Userstats Account
      {
        console.log("\n" + "=".repeat(80));
        console.log("🎯 FINAL STATE - After Matching All Orders");
        console.log("=".repeat(80));
        let userStatsAfterMatch = await program.account.userStats.fetch(
          userStatsAccount,
        );
        let otherUserStatsAfterMatch = await program.account.userStats.fetch(
          other_userStatsAccount,
        );

        // Get token account balances
        let userCollateralBalance = await getAccount(
          provider.connection,
          userCollateralAccount,
        );
        let userYesBalance = await getAccount(
          provider.connection,
          userOutcomeYesAccount,
        );
        let userNoBalance = await getAccount(
          provider.connection,
          userOutcomeNoAccount,
        );

        let otherUserCollateralBalance = await getAccount(
          provider.connection,
          other_userCollateralAccount,
        );
        let otherUserYesBalance = await getAccount(
          provider.connection,
          other_userOutcomeYesAccount,
        );
        let otherUserNoBalance = await getAccount(
          provider.connection,
          other_userOutcomeNoAccount,
        );

        console.log("\n=== User Stats After Match ===");
        console.log("User (Buyer):");
        console.log("  Locked YES:", Number(userStatsAfterMatch.lockedYes));
        console.log("  Locked NO:", Number(userStatsAfterMatch.lockedNo));
        console.log(
          "  Locked Collateral:",
          Number(userStatsAfterMatch.lockedCollateral),
        );
        console.log(
          "  Claimable YES:",
          Number(userStatsAfterMatch.claimableYes),
        );
        console.log("  Claimable NO:", Number(userStatsAfterMatch.claimableNo));
        console.log(
          "  Claimable Collateral:",
          Number(userStatsAfterMatch.claimableCollateral),
        );
        console.log("\n  Token Account Balances:");
        console.log("  Collateral:", Number(userCollateralBalance.amount));
        console.log("  YES tokens:", Number(userYesBalance.amount));
        console.log("  NO tokens:", Number(userNoBalance.amount));

        console.log("\n=== Other User (Seller) - FINAL STATE ===");
        console.log(
          "  Locked YES:",
          Number(otherUserStatsAfterMatch.lockedYes),
        );
        console.log("  Locked NO:", Number(otherUserStatsAfterMatch.lockedNo));
        console.log(
          "  Locked Collateral:",
          Number(otherUserStatsAfterMatch.lockedCollateral),
        );
        console.log(
          "  Claimable YES:",
          Number(otherUserStatsAfterMatch.claimableYes),
        );
        console.log(
          "  Claimable NO:",
          Number(otherUserStatsAfterMatch.claimableNo),
        );
        console.log(
          "  Claimable Collateral:",
          Number(otherUserStatsAfterMatch.claimableCollateral),
        );
        console.log("\n  💰 Token Account Balances:");
        console.log(
          "     Collateral:",
          Number(otherUserCollateralBalance.amount),
        );
        console.log("     YES tokens:", Number(otherUserYesBalance.amount));
        console.log("     NO tokens:", Number(otherUserNoBalance.amount));
        console.log("=".repeat(80) + "\n");
      }
    });

    describe("Checking for Market Orders", async () => {
      it("Placing Market order in the orderbook", async () => {
        // Before running this Test,
        // !! Make sure there is no Order inside the Orderbook !!

        // Let's See User can place the Order
        // Check inside the Orderbook // There will be One Order
        // Check the user Collateral Amount
        // Also check in the Locked
        //
        // Also run Fail Tests -> Place order with Zero Amount or Quantity
        // Like what happens If My Order completely Occupies Every Order, Then I get back my Collateral Back or not
        // Check If locked amount is zero, as the either the Collateral is deposited to us or Order scucceds and we get in the Claim
        // First we will Log here the What's the Current Stats of Token & User Userstats account of main & other user // we will see

        // Other user will place the Sell order

        let other_user_qty = 10;
        let other_user_price = 0.5 * USDC_UNIT;

        let orderbook = await program.account.orderBook.fetch(orderbookPda);
        assert.equal(
          orderbook.yesSellOrders.length,
          0,
          "Orderbook should be empty",
        );

        await program.methods
          .placeOrder(
            marketId,
            { sell: {} },
            { yes: {} },
            new BN(other_user_qty),
            new BN(other_user_price),
            new BN(max_iteration),
          )
          .accounts({
            market: marketPda,
            orderbook: orderbookPda,
            user: other_user.publicKey,
            userOutcomeYes: other_userOutcomeYesAccount,
            userOutcomeNo: other_userOutcomeNoAccount,
            collateralVault,
            userCollateral: other_userCollateralAccount,
            userStatsAccount: other_userStatsAccount,
            yesEscrow: yesEscrowPda,
            noEscrow: noEscrowPda,
            systemProgram: SystemProgram.programId,
            tokenProgram: TOKEN_PROGRAM_ID,
          })
          .remainingAccounts([
            {
              pubkey: userStatsAccount,
              isSigner: false,
              isWritable: true,
            },
          ])
          .signers([other_user])
          .rpc();

        // Fetch seller stats AFTER placing sell order, BEFORE market order
        let other_user_stats_accountBefore =
          await program.account.userStats.fetch(other_userStatsAccount);

        // Selling 10 Tokens of Yes
        // In orderbook, there is a Order in sell_yes_vec
        let user_yes_accountBefore = await getAccount(
          provider.connection,
          userOutcomeYesAccount,
        );

        let user_collateral_accountBefore = await getAccount(
          provider.connection,
          userCollateralAccount,
        );

        let user_order_amount = 5 * USDC_UNIT; // 5 USDC

        await program.methods
          .marketOrder(
            marketId,
            { buy: {} },
            { yes: {} },
            new BN(user_order_amount),
            new BN(max_iteration),
          )
          .accounts({
            market: marketPda,
            orderbook: orderbookPda,
            user: user.publicKey,
            userOutcomeYes: userOutcomeYesAccount,
            userOutcomeNo: userOutcomeNoAccount,
            collateralVault,
            userCollateral: userCollateralAccount,
            userStatsAccount,
            outcomeYesMint,
            outcomeNoMint,
            yesEscrow: yesEscrowPda,
            noEscrow: noEscrowPda,
            systemProgram: SystemProgram.programId,
            associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
            tokenProgram: TOKEN_PROGRAM_ID,
          })
          .remainingAccounts([
            {
              pubkey: other_userStatsAccount,
              isSigner: false,
              isWritable: true,
            },
          ])
          .signers([user])
          .rpc();

        let user_yes_accountAfter = await getAccount(
          provider.connection,
          userOutcomeYesAccount,
        );

        let user_collateral_accountAfter = await getAccount(
          provider.connection,
          userCollateralAccount,
        );
        let other_user_stats_accountAfter =
          await program.account.userStats.fetch(other_userStatsAccount);

        // other user_stats account => check the claim Collateral
        // Check the locked Yes in the user stats of the Other User
        // This user, Check If he received the Yes Token in the Yes Token Account
        // Check If the Collateral debited from the main user (Buyer)

        let collateral_actually_spent =
          Number(user_collateral_accountBefore.amount) -
          Number(user_collateral_accountAfter.amount);
        let tokens_recevied =
          Number(user_yes_accountAfter.amount) -
          Number(user_yes_accountBefore.amount);

        assert.equal(
          Number(other_user_stats_accountAfter.claimableCollateral) -
            Number(other_user_stats_accountBefore.claimableCollateral),
          collateral_actually_spent,
          "Error in Market order, User spended collateral is not equal to the claimable collateral in the other user account",
        );
        assert.equal(
          Number(other_user_stats_accountBefore.lockedYes) -
            Number(other_user_stats_accountAfter.lockedYes),
          tokens_recevied,
          "Error in Market Order, Locked Token in other User account are not equal to the received token in the main user account",
        );
      });
    });

    describe("Checking for Order Cancellation", async () => {
      it("Cancelling a Buy Order - should return locked collateral", async () => {
        // User places a buy order for YES tokens
        let orderqty = 5;
        let price = 0.6 * USDC_UNIT;
        let orderAmount = orderqty * price;

        // Get initial state
        let userCollateralAccountBefore = await getAccount(
          provider.connection,
          userCollateralAccount,
        );
        let userStatsAccountBefore = await program.account.userStats.fetch(
          userStatsAccount,
        );
        let orderbookBefore = await program.account.orderBook.fetch(
          orderbookPda,
        );
        let initialBuyOrdersLength = orderbookBefore.yesBuyOrders.length;

        // Place the buy order
        await program.methods
          .placeOrder(
            marketId,
            { buy: {} },
            { yes: {} },
            new BN(orderqty),
            new BN(price),
            new BN(max_iteration),
          )
          .accounts({
            market: marketPda,
            orderbook: orderbookPda,
            user: user.publicKey,
            userOutcomeYes: userOutcomeYesAccount,
            userOutcomeNo: userOutcomeNoAccount,
            collateralVault,
            userCollateral: userCollateralAccount,
            userStatsAccount,
            yesEscrow: yesEscrowPda,
            noEscrow: noEscrowPda,
            systemProgram: SystemProgram.programId,
            tokenProgram: TOKEN_PROGRAM_ID,
          })
          .signers([user])
          .rpc();

        // Verify order was placed
        let orderbookAfterPlace = await program.account.orderBook.fetch(
          orderbookPda,
        );
        assert.equal(
          orderbookAfterPlace.yesBuyOrders.length,
          initialBuyOrdersLength + 1,
          "Order should be added to orderbook",
        );

        let userStatsAfterPlace = await program.account.userStats.fetch(
          userStatsAccount,
        );
        assert.equal(
          Number(userStatsAfterPlace.lockedCollateral) -
            Number(userStatsAccountBefore.lockedCollateral),
          orderAmount,
          "Collateral should be locked after placing order",
        );

        // Get the order ID (last order in the list)
        let orderId =
          orderbookAfterPlace.yesBuyOrders[
            orderbookAfterPlace.yesBuyOrders.length - 1
          ].id;

        // Cancel the order
        await program.methods
          .cancelOrder(marketId, new BN(orderId))
          .accounts({
            market: marketPda,
            orderbook: orderbookPda,
            user: user.publicKey,
            userOutcomeYes: userOutcomeYesAccount,
            userOutcomeNo: userOutcomeNoAccount,
            collateralVault,
            userCollateral: userCollateralAccount,
            userStatsAccount,
            yesEscrow: yesEscrowPda,
            noEscrow: noEscrowPda,
            systemProgram: SystemProgram.programId,
            tokenProgram: TOKEN_PROGRAM_ID,
          })
          .signers([user])
          .rpc();

        // Verify order was cancelled
        let orderbookAfterCancel = await program.account.orderBook.fetch(
          orderbookPda,
        );
        let userStatsAfterCancel = await program.account.userStats.fetch(
          userStatsAccount,
        );
        let userCollateralAccountAfter = await getAccount(
          provider.connection,
          userCollateralAccount,
        );

        // Order should be removed from orderbook
        assert.equal(
          orderbookAfterCancel.yesBuyOrders.length,
          initialBuyOrdersLength,
          "Order should be removed from orderbook after cancellation",
        );

        // Locked collateral should be returned
        assert.equal(
          Number(userStatsAfterCancel.lockedCollateral),
          Number(userStatsAccountBefore.lockedCollateral),
          "Locked collateral should be returned to user",
        );

        // Collateral should be back in user's account
        assert.equal(
          Number(userCollateralAccountAfter.amount),
          Number(userCollateralAccountBefore.amount),
          "User's collateral balance should be restored",
        );

        console.log("Buy order cancelled successfully");
      });

      it("Cancelling a Sell Order - should return locked tokens", async () => {
        // Other user places a sell order for YES tokens
        let orderqty = 8;
        let price = 0.4 * USDC_UNIT;

        // Get initial state
        let otherUserYesAccountBefore = await getAccount(
          provider.connection,
          other_userOutcomeYesAccount,
        );
        let otherUserStatsAccountBefore = await program.account.userStats.fetch(
          other_userStatsAccount,
        );
        let orderbookBefore = await program.account.orderBook.fetch(
          orderbookPda,
        );
        let initialSellOrdersLength = orderbookBefore.yesSellOrders.length;

        // Place the sell order
        await program.methods
          .placeOrder(
            marketId,
            { sell: {} },
            { yes: {} },
            new BN(orderqty),
            new BN(price),
            new BN(max_iteration),
          )
          .accounts({
            market: marketPda,
            orderbook: orderbookPda,
            user: other_user.publicKey,
            userOutcomeYes: other_userOutcomeYesAccount,
            userOutcomeNo: other_userOutcomeNoAccount,
            collateralVault,
            userCollateral: other_userCollateralAccount,
            userStatsAccount: other_userStatsAccount,
            yesEscrow: yesEscrowPda,
            noEscrow: noEscrowPda,
            systemProgram: SystemProgram.programId,
            tokenProgram: TOKEN_PROGRAM_ID,
          })
          .signers([other_user])
          .rpc();

        // Verify order was placed
        let orderbookAfterPlace = await program.account.orderBook.fetch(
          orderbookPda,
        );
        assert.equal(
          orderbookAfterPlace.yesSellOrders.length,
          initialSellOrdersLength + 1,
          "Sell order should be added to orderbook",
        );

        let otherUserStatsAfterPlace = await program.account.userStats.fetch(
          other_userStatsAccount,
        );
        assert.equal(
          Number(otherUserStatsAfterPlace.lockedYes) -
            Number(otherUserStatsAccountBefore.lockedYes),
          orderqty,
          "YES tokens should be locked after placing sell order",
        );

        // Get the order ID (last order in the list)
        let orderId =
          orderbookAfterPlace.yesSellOrders[
            orderbookAfterPlace.yesSellOrders.length - 1
          ].id;

        // Cancel the order
        await program.methods
          .cancelOrder(marketId, new BN(orderId))
          .accounts({
            market: marketPda,
            orderbook: orderbookPda,
            user: other_user.publicKey,
            userOutcomeYes: other_userOutcomeYesAccount,
            userOutcomeNo: other_userOutcomeNoAccount,
            collateralVault,
            userCollateral: other_userCollateralAccount,
            userStatsAccount: other_userStatsAccount,
            yesEscrow: yesEscrowPda,
            noEscrow: noEscrowPda,
            systemProgram: SystemProgram.programId,
            tokenProgram: TOKEN_PROGRAM_ID,
          })
          .signers([other_user])
          .rpc();

        // Verify order was cancelled
        let orderbookAfterCancel = await program.account.orderBook.fetch(
          orderbookPda,
        );
        let otherUserStatsAfterCancel = await program.account.userStats.fetch(
          other_userStatsAccount,
        );
        let otherUserYesAccountAfter = await getAccount(
          provider.connection,
          other_userOutcomeYesAccount,
        );

        // Order should be removed from orderbook
        assert.equal(
          orderbookAfterCancel.yesSellOrders.length,
          initialSellOrdersLength,
          "Sell order should be removed from orderbook after cancellation",
        );

        // Locked YES tokens should be returned
        assert.equal(
          Number(otherUserStatsAfterCancel.lockedYes),
          Number(otherUserStatsAccountBefore.lockedYes),
          "Locked YES tokens should be returned to user",
        );

        // YES tokens should be back in user's account
        assert.equal(
          Number(otherUserYesAccountAfter.amount),
          Number(otherUserYesAccountBefore.amount),
          "User's YES token balance should be restored",
        );

        console.log("Sell order cancelled successfully");
      });

      it("Cancelling a NO token Sell Order - should return locked NO tokens", async () => {
        // Other user places a sell order for NO tokens
        let orderqty = 6;
        let price = 0.5 * USDC_UNIT;

        // Get initial state
        let otherUserNoAccountBefore = await getAccount(
          provider.connection,
          other_userOutcomeNoAccount,
        );
        let otherUserStatsAccountBefore = await program.account.userStats.fetch(
          other_userStatsAccount,
        );
        let orderbookBefore = await program.account.orderBook.fetch(
          orderbookPda,
        );
        let initialSellOrdersLength = orderbookBefore.noSellOrders.length;

        // Place the sell order for NO tokens
        await program.methods
          .placeOrder(
            marketId,
            { sell: {} },
            { no: {} },
            new BN(orderqty),
            new BN(price),
            new BN(max_iteration),
          )
          .accounts({
            market: marketPda,
            orderbook: orderbookPda,
            user: other_user.publicKey,
            userOutcomeYes: other_userOutcomeYesAccount,
            userOutcomeNo: other_userOutcomeNoAccount,
            collateralVault,
            userCollateral: other_userCollateralAccount,
            userStatsAccount: other_userStatsAccount,
            yesEscrow: yesEscrowPda,
            noEscrow: noEscrowPda,
            systemProgram: SystemProgram.programId,
            tokenProgram: TOKEN_PROGRAM_ID,
          })
          .signers([other_user])
          .rpc();

        // Verify order was placed
        let orderbookAfterPlace = await program.account.orderBook.fetch(
          orderbookPda,
        );
        let otherUserStatsAfterPlace = await program.account.userStats.fetch(
          other_userStatsAccount,
        );

        assert.equal(
          orderbookAfterPlace.noSellOrders.length,
          initialSellOrdersLength + 1,
          "NO sell order should be added to orderbook",
        );

        assert.equal(
          Number(otherUserStatsAfterPlace.lockedNo) -
            Number(otherUserStatsAccountBefore.lockedNo),
          orderqty,
          "NO tokens should be locked after placing sell order",
        );

        // Get the order ID
        let orderId =
          orderbookAfterPlace.noSellOrders[
            orderbookAfterPlace.noSellOrders.length - 1
          ].id;

        // Cancel the order
        await program.methods
          .cancelOrder(marketId, new BN(orderId))
          .accounts({
            market: marketPda,
            orderbook: orderbookPda,
            user: other_user.publicKey,
            userOutcomeYes: other_userOutcomeYesAccount,
            userOutcomeNo: other_userOutcomeNoAccount,
            collateralVault,
            userCollateral: other_userCollateralAccount,
            userStatsAccount: other_userStatsAccount,
            yesEscrow: yesEscrowPda,
            noEscrow: noEscrowPda,
            systemProgram: SystemProgram.programId,
            tokenProgram: TOKEN_PROGRAM_ID,
          })
          .signers([other_user])
          .rpc();

        // Verify cancellation
        let orderbookAfterCancel = await program.account.orderBook.fetch(
          orderbookPda,
        );
        let otherUserStatsAfterCancel = await program.account.userStats.fetch(
          other_userStatsAccount,
        );
        let otherUserNoAccountAfter = await getAccount(
          provider.connection,
          other_userOutcomeNoAccount,
        );

        assert.equal(
          orderbookAfterCancel.noSellOrders.length,
          initialSellOrdersLength,
          "NO sell order should be removed from orderbook",
        );

        assert.equal(
          Number(otherUserStatsAfterCancel.lockedNo),
          Number(otherUserStatsAccountBefore.lockedNo),
          "Locked NO tokens should be returned",
        );

        assert.equal(
          Number(otherUserNoAccountAfter.amount),
          Number(otherUserNoAccountBefore.amount),
          "NO token balance should be restored",
        );

        console.log("NO token sell order cancelled successfully");
      });

      it("Should fail - Cancelling partially filled order", async () => {
        // User places a buy order
        let buyOrderQty = 15;
        let buyPrice = 0.6 * USDC_UNIT;

        await program.methods
          .placeOrder(
            marketId,
            { buy: {} },
            { yes: {} },
            new BN(buyOrderQty),
            new BN(buyPrice),
            new BN(max_iteration),
          )
          .accounts({
            market: marketPda,
            orderbook: orderbookPda,
            user: user.publicKey,
            userOutcomeYes: userOutcomeYesAccount,
            userOutcomeNo: userOutcomeNoAccount,
            collateralVault,
            userCollateral: userCollateralAccount,
            userStatsAccount,
            yesEscrow: yesEscrowPda,
            noEscrow: noEscrowPda,
            systemProgram: SystemProgram.programId,
            tokenProgram: TOKEN_PROGRAM_ID,
          })
          .signers([user])
          .rpc();

        let orderbookAfterBuy = await program.account.orderBook.fetch(
          orderbookPda,
        );
        let buyOrderId =
          orderbookAfterBuy.yesBuyOrders[
            orderbookAfterBuy.yesBuyOrders.length - 1
          ].id;

        // Other user places a matching sell order that partially fills the buy order
        await program.methods
          .placeOrder(
            marketId,
            { sell: {} },
            { yes: {} },
            new BN(10), // Only 10 tokens, partially filling the 15 token buy order
            new BN(0.5 * USDC_UNIT), // Price so it matches
            new BN(max_iteration),
          )
          .accounts({
            market: marketPda,
            orderbook: orderbookPda,
            user: other_user.publicKey,
            userOutcomeYes: other_userOutcomeYesAccount,
            userOutcomeNo: other_userOutcomeNoAccount,
            collateralVault,
            userCollateral: other_userCollateralAccount,
            userStatsAccount: other_userStatsAccount,
            yesEscrow: yesEscrowPda,
            noEscrow: noEscrowPda,
            systemProgram: SystemProgram.programId,
            tokenProgram: TOKEN_PROGRAM_ID,
          })
          .remainingAccounts([
            {
              pubkey: userStatsAccount,
              isSigner: false,
              isWritable: true,
            },
          ])
          .signers([other_user])
          .rpc();

        // Verify the order was partially filled
        let orderbookAfterMatch = await program.account.orderBook.fetch(
          orderbookPda,
        );
        let partiallyFilledOrder = orderbookAfterMatch.yesBuyOrders.find(
          (o) => Number(o.id) === Number(buyOrderId),
        );

        assert.isTrue(
          Number(partiallyFilledOrder.filledquantity) > 0 &&
            Number(partiallyFilledOrder.filledquantity) <
              Number(partiallyFilledOrder.quantity),
          "Order should be partially filled",
        );

        // Try to cancel the partially filled order - should fail
        try {
          await program.methods
            .cancelOrder(marketId, new BN(buyOrderId))
            .accounts({
              market: marketPda,
              orderbook: orderbookPda,
              user: user.publicKey,
              userOutcomeYes: userOutcomeYesAccount,
              userOutcomeNo: userOutcomeNoAccount,
              collateralVault,
              userCollateral: userCollateralAccount,
              userStatsAccount,
              yesEscrow: yesEscrowPda,
              noEscrow: noEscrowPda,
              systemProgram: SystemProgram.programId,
              tokenProgram: TOKEN_PROGRAM_ID,
            })
            .signers([user])
            .rpc();

          assert.fail("Should not be able to cancel, OrderPartiallyFilled");
        } catch (err) {
          expect(err.toString()).to.include("OrderPartiallyFilled");
          console.log(
            "Correctly prevented cancellation of partially filled order",
          );
        }
      });

      it("Should fail - Wrong user trying to cancel order", async () => {
        // User places a buy order
        let orderqty = 5;
        let price = 0.6 * USDC_UNIT;

        await program.methods
          .placeOrder(
            marketId,
            { buy: {} },
            { yes: {} },
            new BN(orderqty),
            new BN(price),
            new BN(max_iteration),
          )
          .accounts({
            market: marketPda,
            orderbook: orderbookPda,
            user: user.publicKey,
            userOutcomeYes: userOutcomeYesAccount,
            userOutcomeNo: userOutcomeNoAccount,
            collateralVault,
            userCollateral: userCollateralAccount,
            userStatsAccount,
            yesEscrow: yesEscrowPda,
            noEscrow: noEscrowPda,
            systemProgram: SystemProgram.programId,
            tokenProgram: TOKEN_PROGRAM_ID,
          })
          .signers([user])
          .rpc();

        let orderbookAfterPlace = await program.account.orderBook.fetch(
          orderbookPda,
        );
        let orderId =
          orderbookAfterPlace.yesBuyOrders[
            orderbookAfterPlace.yesBuyOrders.length - 1
          ].id;

        // Other user tries to cancel the order - should fail
        try {
          await program.methods
            .cancelOrder(marketId, new BN(orderId))
            .accounts({
              market: marketPda,
              orderbook: orderbookPda,
              user: other_user.publicKey, // Wrong user!
              userOutcomeYes: other_userOutcomeYesAccount,
              userOutcomeNo: other_userOutcomeNoAccount,
              collateralVault,
              userCollateral: other_userCollateralAccount,
              userStatsAccount: other_userStatsAccount,
              yesEscrow: yesEscrowPda,
              noEscrow: noEscrowPda,
              systemProgram: SystemProgram.programId,
              tokenProgram: TOKEN_PROGRAM_ID,
            })
            .signers([other_user])
            .rpc();

          assert.fail("Should not allow other user to cancel the order");
        } catch (err) {
          expect(err.toString()).to.include("NotAuthorized");
          console.log("Correctly prevented unauthorized cancellation");
        }

        // Clean up: User cancels their own order
        await program.methods
          .cancelOrder(marketId, new BN(orderId))
          .accounts({
            market: marketPda,
            orderbook: orderbookPda,
            user: user.publicKey,
            userOutcomeYes: userOutcomeYesAccount,
            userOutcomeNo: userOutcomeNoAccount,
            collateralVault,
            userCollateral: userCollateralAccount,
            userStatsAccount,
            yesEscrow: yesEscrowPda,
            noEscrow: noEscrowPda,
            systemProgram: SystemProgram.programId,
            tokenProgram: TOKEN_PROGRAM_ID,
          })
          .signers([user])
          .rpc();
      });

      it("Should fail - Cancelling non-existent order (invalid order_id)", async () => {
        // Use a very large order ID that doesn't exist
        let invalidOrderId = 999999;

        try {
          await program.methods
            .cancelOrder(marketId, new BN(invalidOrderId))
            .accounts({
              market: marketPda,
              orderbook: orderbookPda,
              user: user.publicKey,
              userOutcomeYes: userOutcomeYesAccount,
              userOutcomeNo: userOutcomeNoAccount,
              collateralVault,
              userCollateral: userCollateralAccount,
              userStatsAccount,
              yesEscrow: yesEscrowPda,
              noEscrow: noEscrowPda,
              systemProgram: SystemProgram.programId,
              tokenProgram: TOKEN_PROGRAM_ID,
            })
            .signers([user])
            .rpc();

          assert.fail("Should not allow cancelling non-existent order");
        } catch (err) {
          expect(err.toString()).to.include("OrdernotFound");
          console.log("Correctly prevented cancellation of non-existent order");
        }
      });
    });

    describe("Merge Tokens", () => {
      it("Merging YES + NO tokens back into collateral", async () => {
        // mergeTokens burns equal amounts of YES & NO tokens
        // and releases that same amount of collateral back to the user
        // totalCollateralLocked in market should decrease too

        let mergeAmount = 5; // merging 5 YES + 5 NO => get 5 collateral back

        // State BEFORE merge
        let userYesAccountBefore = await getAccount(
          provider.connection,
          userOutcomeYesAccount,
        );
        let userNoAccountBefore = await getAccount(
          provider.connection,
          userOutcomeNoAccount,
        );
        let userCollateralAccountBefore = await getAccount(
          provider.connection,
          userCollateralAccount,
        );
        let marketBefore = await program.account.market.fetch(marketPda);

        await program.methods
          .mergeTokens(marketId, new BN(mergeAmount))
          .accounts({
            market: marketPda,
            user: user.publicKey,
            userCollateral: userCollateralAccount,
            collateralVault,
            outcomeYesMint,
            outcomeNoMint,
            userOutcomeYes: userOutcomeYesAccount,
            userOutcomeNo: userOutcomeNoAccount,
            tokenProgram: TOKEN_PROGRAM_ID,
          })
          .signers([user])
          .rpc();

        // State AFTER merge
        let userYesAccountAfter = await getAccount(
          provider.connection,
          userOutcomeYesAccount,
        );
        let userNoAccountAfter = await getAccount(
          provider.connection,
          userOutcomeNoAccount,
        );
        let userCollateralAccountAfter = await getAccount(
          provider.connection,
          userCollateralAccount,
        );
        let marketAfter = await program.account.market.fetch(marketPda);

        // YES tokens should be burned
        assert.equal(
          Number(userYesAccountBefore.amount) -
            Number(userYesAccountAfter.amount),
          mergeAmount,
          "YES tokens should be burned equal to mergeAmount",
        );

        // NO tokens should be burned
        assert.equal(
          Number(userNoAccountBefore.amount) -
            Number(userNoAccountAfter.amount),
          mergeAmount,
          "NO tokens should be burned equal to mergeAmount",
        );

        // Collateral should be returned to the user
        assert.equal(
          Number(userCollateralAccountAfter.amount) -
            Number(userCollateralAccountBefore.amount),
          mergeAmount,
          "User collateral should increase by mergeAmount",
        );

        // Market's total locked collateral should decrease
        assert.equal(
          Number(marketBefore.totalCollateralLocked) -
            Number(marketAfter.totalCollateralLocked),
          mergeAmount,
          "Market totalCollateralLocked should decrease by mergeAmount",
        );

        console.log("Merge successful, collateral returned to user");
      });

      it("What if we give zero amount in merge, should fail", async () => {
        // mergeTokens has require!(amount > 0, InvalidAmount)
        // so passing 0 should fail with InvalidAmount

        try {
          await program.methods
            .mergeTokens(marketId, new BN(0))
            .accounts({
              market: marketPda,
              user: user.publicKey,
              userCollateral: userCollateralAccount,
              collateralVault,
              outcomeYesMint,
              outcomeNoMint,
              userOutcomeYes: userOutcomeYesAccount,
              userOutcomeNo: userOutcomeNoAccount,
              tokenProgram: TOKEN_PROGRAM_ID,
            })
            .signers([user])
            .rpc();
        } catch (err) {
          expect(err.toString()).to.include("InvalidAmount");
        }
      });

      it("What if we merge more than we hold, should fail with NotEnoughBalance", async () => {
        // mergeTokens checks both YES and NO balances before burning
        // User tries to merge more tokens than they actually have

        let userYesAccount = await getAccount(
          provider.connection,
          userOutcomeYesAccount,
        );

        // Trying to merge more than what the user actually holds
        let tooMuch = Number(userYesAccount.amount) + 100;

        try {
          await program.methods
            .mergeTokens(marketId, new BN(tooMuch))
            .accounts({
              market: marketPda,
              user: user.publicKey,
              userCollateral: userCollateralAccount,
              collateralVault,
              outcomeYesMint,
              outcomeNoMint,
              userOutcomeYes: userOutcomeYesAccount,
              userOutcomeNo: userOutcomeNoAccount,
              tokenProgram: TOKEN_PROGRAM_ID,
            })
            .signers([user])
            .rpc();
        } catch (err) {
          expect(err.toString()).to.include("NotEnoughBalance");
        }
      });
    });

    describe("Claim Funds", () => {
      it("Buyer claiming claimableYes tokens from UserStats account", async () => {
        // After order matching, user (buyer) has claimableYes sitting in their UserStats
        // claimFunds should transfer those YES tokens from yesEscrow => user's ATA
        // and zero out claimableYes in the UserStats

        let userStatsBefore = await program.account.userStats.fetch(
          userStatsAccount,
        );

        // There should be something to claim from the matching tests
        let expectedClaimableYes = Number(userStatsBefore.claimableYes);
        console.log("\n User claimableYes before claim:", expectedClaimableYes);

        let userYesAccountBefore = await getAccount(
          provider.connection,
          userOutcomeYesAccount,
        );
        let userCollateralAccountBefore = await getAccount(
          provider.connection,
          userCollateralAccount,
        );

        await program.methods
          .claimFunds(marketId)
          .accounts({
            market: marketPda,
            user: user.publicKey,
            userStats: userStatsAccount,
            collateralMint,
            outcomeYesMint,
            outcomeNoMint,
            userCollateral: userCollateralAccount,
            collateralVault,
            userOutcomeYes: userOutcomeYesAccount,
            userOutcomeNo: userOutcomeNoAccount,
            yesEscrow: yesEscrowPda,
            noEscrow: noEscrowPda,
            associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
            tokenProgram: TOKEN_PROGRAM_ID,
            systemProgram: SystemProgram.programId,
          })
          .signers([user])
          .rpc();

        let userStatsAfter = await program.account.userStats.fetch(
          userStatsAccount,
        );
        let userYesAccountAfter = await getAccount(
          provider.connection,
          userOutcomeYesAccount,
        );
        let userCollateralAccountAfter = await getAccount(
          provider.connection,
          userCollateralAccount,
        );

        // claimableYes should be zeroed out
        assert.equal(
          Number(userStatsAfter.claimableYes),
          0,
          "claimableYes should be 0 after claiming",
        );
        assert.equal(
          Number(userStatsAfter.claimableCollateral),
          0,
          "claimableCollateral should still be 0",
        );

        // YES tokens should land in the user's ATA
        assert.equal(
          Number(userYesAccountAfter.amount) -
            Number(userYesAccountBefore.amount),
          expectedClaimableYes,
          "User should receive exactly claimableYes tokens in their ATA",
        );

        // Collateral should be unchanged (nothing claimable there)
        assert.equal(
          Number(userCollateralAccountAfter.amount),
          Number(userCollateralAccountBefore.amount),
          "Collateral balance should not change (nothing was claimableCollateral)",
        );

        console.log(
          "Buyer claimed",
          expectedClaimableYes,
          "YES tokens successfully",
        );
      });

      it("Seller claiming claimableCollateral from UserStats account", async () => {
        // other_user (seller) has claimableCollateral from matching orders
        // claimFunds should transfer collateral from vault => other_user's ATA
        // and zero out claimableCollateral in the UserStats

        let otherUserStatsBefore = await program.account.userStats.fetch(
          other_userStatsAccount,
        );

        let expectedClaimableCollateral = Number(
          otherUserStatsBefore.claimableCollateral,
        );
        console.log(
          "Other user claimableCollateral before claim:",
          expectedClaimableCollateral,
        );

        let otherUserCollateralBefore = await getAccount(
          provider.connection,
          other_userCollateralAccount,
        );
        let otherUserYesBefore = await getAccount(
          provider.connection,
          other_userOutcomeYesAccount,
        );

        await program.methods
          .claimFunds(marketId)
          .accounts({
            market: marketPda,
            user: other_user.publicKey,
            userStats: other_userStatsAccount,
            collateralMint,
            outcomeYesMint,
            outcomeNoMint,
            userCollateral: other_userCollateralAccount,
            collateralVault,
            userOutcomeYes: other_userOutcomeYesAccount,
            userOutcomeNo: other_userOutcomeNoAccount,
            yesEscrow: yesEscrowPda,
            noEscrow: noEscrowPda,
            associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
            tokenProgram: TOKEN_PROGRAM_ID,
            systemProgram: SystemProgram.programId,
          })
          .signers([other_user])
          .rpc();

        let otherUserStatsAfter = await program.account.userStats.fetch(
          other_userStatsAccount,
        );
        let otherUserCollateralAfter = await getAccount(
          provider.connection,
          other_userCollateralAccount,
        );
        let otherUserYesAfter = await getAccount(
          provider.connection,
          other_userOutcomeYesAccount,
        );

        // claimableCollateral should be zeroed out
        assert.equal(
          Number(otherUserStatsAfter.claimableCollateral),
          0,
          "claimableCollateral should be 0 after claiming",
        );
        assert.equal(
          Number(otherUserStatsAfter.claimableYes),
          0,
          "claimableYes should still be 0",
        );

        // Collateral should land in other_user's ATA
        assert.equal(
          Number(otherUserCollateralAfter.amount) -
            Number(otherUserCollateralBefore.amount),
          expectedClaimableCollateral,
          "Seller should receive exactly claimableCollateral in their ATA",
        );

        // YES token balance should not change (seller had nothing claimableYes)
        assert.equal(
          Number(otherUserYesAfter.amount),
          Number(otherUserYesBefore.amount),
          "YES token balance should not change for seller",
        );

        console.log(
          "Seller claimed",
          expectedClaimableCollateral,
          "collateral successfully",
        );
      });

      it("What if there is nothing to claim, should fail with NothingToClaim", async () => {
        // Previous tests already drained all claimable fields for user
        // Calling claimFunds again should fail with NothingToClaim

        try {
          await program.methods
            .claimFunds(marketId)
            .accounts({
              market: marketPda,
              user: user.publicKey,
              userStats: userStatsAccount,
              collateralMint,
              outcomeYesMint,
              outcomeNoMint,
              userCollateral: userCollateralAccount,
              collateralVault,
              userOutcomeYes: userOutcomeYesAccount,
              userOutcomeNo: userOutcomeNoAccount,
              yesEscrow: yesEscrowPda,
              noEscrow: noEscrowPda,
              associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
              tokenProgram: TOKEN_PROGRAM_ID,
              systemProgram: SystemProgram.programId,
            })
            .signers([user])
            .rpc();
        } catch (err) {
          expect(err.toString()).to.include("NothingToClaim");
        }
      });
    });
  });

  describe("Settlement & Lifecycle", () => {
    let marketId2 = 2;
    let marketPda2: PublicKey;
    let collateralVault2: PublicKey;
    let outcomeYesMint2: PublicKey;
    let outcomeNoMint2: PublicKey;
    let orderbookPda2: PublicKey;
    let yesEscrowPda2: PublicKey;
    let noEscrowPda2: PublicKey;
    let userStatsAccount2: PublicKey;

    let userOutcomeYesAccount2: PublicKey;
    let userOutcomeNoAccount2: PublicKey;

    before(async () => {
      const marketId2BN = new BN(2);
      const marketId2LE = marketId2BN.toArrayLike(Buffer, "le", 4);

      [marketPda2] = PublicKey.findProgramAddressSync(
        [Buffer.from("market"), marketId2LE],
        program.programId,
      );
      [collateralVault2] = PublicKey.findProgramAddressSync(
        [Buffer.from("vault"), marketId2LE],
        program.programId,
      );
      [outcomeYesMint2] = PublicKey.findProgramAddressSync(
        [Buffer.from("outcome_a"), marketId2LE],
        program.programId,
      );
      [outcomeNoMint2] = PublicKey.findProgramAddressSync(
        [Buffer.from("outcome_b"), marketId2LE],
        program.programId,
      );
      [orderbookPda2] = PublicKey.findProgramAddressSync(
        [Buffer.from("orderbook"), marketId2LE],
        program.programId,
      );
      [yesEscrowPda2] = PublicKey.findProgramAddressSync(
        [Buffer.from("escrow"), marketId2LE, outcomeYesMint2.toBuffer()],
        program.programId,
      );
      [noEscrowPda2] = PublicKey.findProgramAddressSync(
        [Buffer.from("escrow"), marketId2LE, outcomeNoMint2.toBuffer()],
        program.programId,
      );
      [userStatsAccount2] = PublicKey.findProgramAddressSync(
        [Buffer.from("user_stats"), marketId2LE, user.publicKey.toBuffer()],
        program.programId,
      );

      // Deadline of 2 seconds
      const shortDeadline = new BN(Math.floor(Date.now() / 1000) + 2);

      await program.methods
        .initializeMarket(marketId2, shortDeadline, "")
        .accounts({
          market: marketPda2,
          authority: authority.publicKey,
          collateralMint: collateralMint,
          collateralVault: collateralVault2,
          outcomeYesMint: outcomeYesMint2,
          outcomeNoMint: outcomeNoMint2,
          yesEscrow: yesEscrowPda2,
          noEscrow: noEscrowPda2,
          orderbook: orderbookPda2,
          systemProgram: SystemProgram.programId,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .rpc();

      let splitAmount2 = 50;

      const userOutcomeYesInfo2 = await getOrCreateAssociatedTokenAccount(
        provider.connection,
        authority.payer,
        outcomeYesMint2,
        user.publicKey,
      );
      userOutcomeYesAccount2 = userOutcomeYesInfo2.address;

      const userOutcomeNoInfo2 = await getOrCreateAssociatedTokenAccount(
        provider.connection,
        authority.payer,
        outcomeNoMint2,
        user.publicKey,
      );
      userOutcomeNoAccount2 = userOutcomeNoInfo2.address;

      await program.methods
        .splitTokens(marketId2, new BN(splitAmount2))
        .accounts({
          market: marketPda2,
          user: user.publicKey,
          userCollateral: userCollateralAccount,
          collateralVault: collateralVault2,
          outcomeYesMint: outcomeYesMint2,
          outcomeNoMint: outcomeNoMint2,
          userOutcomeYes: userOutcomeYesAccount2,
          userOutcomeNo: userOutcomeNoAccount2,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([user])
        .rpc();

      console.log(
        "Market 2 initialised with short deadline & user funded with YES/NO tokens",
      );
    });

    describe("Update Metadata", () => {
      it("Updating the market metadata URL", async () => {
        const newUrl = "https://new_url.com";

        await program.methods
          .updateMetadata(marketId, newUrl)
          .accounts({
            market: marketPda,
            authority: authority.publicKey,
          })
          .rpc();

        const market = await program.account.market.fetch(marketPda);
        assert.equal(
          market.metaDataUrl,
          newUrl,
          "Market metaDataUrl should be updated",
        );

        console.log("Metadata updated to:", newUrl);
      });
    });

    describe("Set Winner", () => {
      it("What if we try to set winner before the deadline, should fail with SettlementDeadlineNotReached", async () => {
        try {
          await program.methods
            .setWinner(marketId, { outcomeA: {} })
            .accounts({
              market: marketPda,
              authority: authority.publicKey,
              outcomeYesMint,
              outcomeNoMint,
              associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
              tokenProgram: TOKEN_PROGRAM_ID,
            })
            .rpc();
        } catch (err) {
          expect(err.toString()).to.include("SettlementDeadlineNotReached");
        }
      });

      it("Setting YES as the winner on market_id=2 after deadline expires", async () => {
        // Waiting for 3 sec
        await new Promise((s) => setTimeout(s, 3000));

        await program.methods
          .setWinner(marketId2, { outcomeA: {} })
          .accounts({
            market: marketPda2,
            authority: authority.publicKey,
            outcomeYesMint: outcomeYesMint2,
            outcomeNoMint: outcomeNoMint2,
            associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
            tokenProgram: TOKEN_PROGRAM_ID,
          })
          .rpc();

        const market2 = await program.account.market.fetch(marketPda2);

        assert.isTrue(market2.isSettled, "Market should be marked as settled");
        assert.deepEqual(
          market2.winningOutcome,
          { outcomeA: {} },
          "Winning outcome should be YES",
        );

        console.log("Winner set: YES");

        // Verify collateral is still in the vault (50 from splitTokens)
        // This is important — we'll use this to test CollateralNotFullyClaimed below
        const lockedAfterSettle = Number(market2.totalCollateralLocked);
        assert.isAbove(
          lockedAfterSettle,
          0,
          "Vault should still have collateral after setWinner",
        );
      });

      it("What if we try to set winner again on an already settled market, should fail", async () => {
        // require!(!self.market.is_settled, MarketAlreadySettled)

        try {
          await program.methods
            .setWinner(marketId2, { outcomeB: {} })
            .accounts({
              market: marketPda2,
              authority: authority.publicKey,
              outcomeYesMint: outcomeYesMint2,
              outcomeNoMint: outcomeNoMint2,
              associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
              tokenProgram: TOKEN_PROGRAM_ID,
            })
            .rpc();
        } catch (err) {
          expect(err.toString()).to.include("MarketAlreadySettled");
        }
      });

      it("What if we try to close the settled market while collateral is still in the vault, should fail with CollateralNotFullyClaimed", async () => {
        // Right after setWinner, the 50 collateral from splitTokens is still in the vault
        // closeMarket requires total_collateral_locked == 0
        // So closing here (before anyone calls claimRewards) should fail
        //
        // This is the exact ordering users must follow:
        //   setWinner -> all users claimRewards -> authority closeMarket

        let market2 = await program.account.market.fetch(marketPda2);
        console.log(
          "totalCollateralLocked right after setWinner:",
          Number(market2.totalCollateralLocked),
        );
        assert.isAbove(
          Number(market2.totalCollateralLocked),
          0,
          "Precondition: vault must still have collateral right after setWinner",
        );

        try {
          await program.methods
            .closeMarket(marketId2)
            .accounts({
              market: marketPda2,
              authority: authority.publicKey,
              orderbook: orderbookPda2,
            })
            .rpc();
        } catch (err) {
          expect(err.toString()).to.include("CollateralNotFullyClaimed");
        }
      });
    });

    describe("Claim Rewards", () => {
      it("What if we try to claimRewards before market is settled, should fail", async () => {
        // require!(self.market.is_settled, MarketNotSettled)
        // market_id=1 is not settled yet — good test target

        try {
          await program.methods
            .claimRewards(marketId)
            .accounts({
              market: marketPda,
              user: user.publicKey,
              userStats: userStatsAccount,
              collateralMint,
              userCollateral: userCollateralAccount,
              collateralVault,
              outcomeYesMint,
              outcomeNoMint,
              userOutcomeYes: userOutcomeYesAccount,
              userOutcomeNo: userOutcomeNoAccount,
              associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
              tokenProgram: TOKEN_PROGRAM_ID,
              systemProgram: SystemProgram.programId,
            })
            .signers([user])
            .rpc();
        } catch (err) {
          expect(err.toString()).to.include("MarketNotSettled");
        }
      });

      it("Winner (YES holder) claiming collateral rewards by burning YES tokens", async () => {
        // YES wins on market_id=2 — user holds YES tokens from splitTokens in before()
        // claimRewards burns all YES tokens and returns 1:1 collateral
        // totalCollateralLocked should decrease by the amount burned

        let userYesAccountBefore = await getAccount(
          provider.connection,
          userOutcomeYesAccount2,
        );
        let userCollateralAccountBefore = await getAccount(
          provider.connection,
          userCollateralAccount,
        );
        let market2Before = await program.account.market.fetch(marketPda2);

        let yesToBurn = Number(userYesAccountBefore.amount);
        console.log("YES tokens to burn for reward:", yesToBurn);

        await program.methods
          .claimRewards(marketId2)
          .accounts({
            market: marketPda2,
            user: user.publicKey,
            userStats: userStatsAccount2,
            collateralMint,
            userCollateral: userCollateralAccount,
            collateralVault: collateralVault2,
            outcomeYesMint: outcomeYesMint2,
            outcomeNoMint: outcomeNoMint2,
            userOutcomeYes: userOutcomeYesAccount2,
            userOutcomeNo: userOutcomeNoAccount2,
            associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
            tokenProgram: TOKEN_PROGRAM_ID,
            systemProgram: SystemProgram.programId,
          })
          .signers([user])
          .rpc();

        let userYesAccountAfter = await getAccount(
          provider.connection,
          userOutcomeYesAccount2,
        );
        let userCollateralAccountAfter = await getAccount(
          provider.connection,
          userCollateralAccount,
        );
        let market2After = await program.account.market.fetch(marketPda2);

        // All YES tokens should be burned
        assert.equal(
          Number(userYesAccountAfter.amount),
          0,
          "All YES tokens should be burned after claiming rewards",
        );

        // Collateral returned 1:1 for the burned YES tokens
        assert.equal(
          Number(userCollateralAccountAfter.amount) -
            Number(userCollateralAccountBefore.amount),
          yesToBurn,
          "User should receive collateral equal to burned YES tokens",
        );

        // Market totalCollateralLocked should decrease by the burned amount
        assert.equal(
          Number(market2Before.totalCollateralLocked) -
            Number(market2After.totalCollateralLocked),
          yesToBurn,
          "totalCollateralLocked should decrease by the amount of YES tokens burned",
        );

        console.log(
          "Claimed rewards: burned",
          yesToBurn,
          "YES tokens, received",
          yesToBurn,
          "collateral",
        );
      });

      it("What if user tries to claim rewards again, should fail with NothingToClaim", async () => {
        // After claimRewards succeeds, user_stats.reward_claimed is set to true
        // The guard require!(!user_stats.reward_claimed, NothingToClaim) fires on the next call,
        // even before it can reach the InvalidAmount check

        try {
          await program.methods
            .claimRewards(marketId2)
            .accounts({
              market: marketPda2,
              user: user.publicKey,
              userStats: userStatsAccount2,
              collateralMint,
              userCollateral: userCollateralAccount,
              collateralVault: collateralVault2,
              outcomeYesMint: outcomeYesMint2,
              outcomeNoMint: outcomeNoMint2,
              userOutcomeYes: userOutcomeYesAccount2,
              userOutcomeNo: userOutcomeNoAccount2,
              associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
              tokenProgram: TOKEN_PROGRAM_ID,
              systemProgram: SystemProgram.programId,
            })
            .signers([user])
            .rpc();
        } catch (err) {
          expect(err.toString()).to.include("NothingToClaim");
        }
      });
    });

    describe("Close Market", () => {
      it("What if we try to close before market is settled, should fail with MarketNotSettled", async () => {
        // require!(market.is_settled, MarketNotSettled)
        // market_id=1 is still live

        try {
          await program.methods
            .closeMarket(marketId)
            .accounts({
              market: marketPda,
              authority: authority.publicKey,
              orderbook: orderbookPda,
            })
            .rpc();
        } catch (err) {
          expect(err.toString()).to.include("MarketNotSettled");
        }
      });

      it("Closing market_id=2 successfully after all collateral is claimed", async () => {
        // By this point: setWinner ran (market settled), claimRewards ran (vault is empty)
        // closeMarket will close both the market + orderbook accounts
        // and return rent back to authority

        let authorityBalanceBefore = await provider.connection.getBalance(
          authority.publicKey,
        );

        await program.methods
          .closeMarket(marketId2)
          .accounts({
            market: marketPda2,
            authority: authority.publicKey,
            orderbook: orderbookPda2,
          })
          .rpc();

        let authorityBalanceAfter = await provider.connection.getBalance(
          authority.publicKey,
        );

        // Authority should have received rent back (balance increased)
        assert.isTrue(
          authorityBalanceAfter > authorityBalanceBefore,
          "Authority should receive rent back when market is closed",
        );

        // Market account should no longer exist on-chain
        let marketInfo = await provider.connection.getAccountInfo(marketPda2);
        assert.isNull(marketInfo, "Market account should be closed");

        console.log(
          "Market closed successfully! Rent returned:",
          authorityBalanceAfter - authorityBalanceBefore,
          "lamports",
        );
      });
    });
  });
});
