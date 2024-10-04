use anchor_lang::prelude::*;
use anchor_lang::solana_program::keccak;

use anchor_spl::associated_token::AssociatedToken;
use anchor_spl::token_interface::{
    transfer_checked, Mint, TokenAccount, TokenInterface, TransferChecked,
};

use crate::{
    constants::DISCRIMINATOR_SIZE,
    constraints::is_relay_hash_valid,
    error::CustomError,
    state::{FillStatus, FillStatusAccount, RootBundle, State},
    utils::verify_merkle_proof,
};

// TODO: We can likely move some of the common exports to better locations. we are pulling a lot of these from fill.rs
use crate::event::{FillType, FilledV3Relay, RequestedV3SlowFill, V3RelayExecutionEventInfo};
use crate::V3RelayData; // Pulled type definition from fill.rs.

#[event_cpi]
#[derive(Accounts)]
#[instruction(relay_hash: [u8; 32], relay_data: V3RelayData)]
pub struct SlowFillV3Relay<'info> {
    #[account(
        mut,
        seeds = [b"state", state.seed.to_le_bytes().as_ref()],
        bump,
        constraint = !state.paused_fills @ CustomError::FillsArePaused
    )]
    pub state: Account<'info, State>,

    #[account(mut)]
    pub signer: Signer<'info>,

    #[account(
        init_if_needed,
        payer = signer,
        space = DISCRIMINATOR_SIZE + FillStatusAccount::INIT_SPACE,
        seeds = [b"fills", relay_hash.as_ref()],
        bump,
        // Make sure caller provided relay_hash used in PDA seeds is valid.
        constraint = is_relay_hash_valid(&relay_hash, &relay_data, &state) @ CustomError::InvalidRelayHash
    )]
    pub fill_status: Account<'info, FillStatusAccount>,
    pub system_program: Program<'info, System>,
}

pub fn request_v3_slow_fill(
    ctx: Context<SlowFillV3Relay>,
    relay_hash: [u8; 32], // include in props, while not using it, to enable us to access it from the #Instruction Attribute within the accounts. This enables us to pass in the relay_hash PDA.
    relay_data: V3RelayData,
) -> Result<()> {
    let state = &mut ctx.accounts.state;

    // TODO: Try again to pull this into a helper function. for some reason I was not able to due to passing context around of state.
    let current_time = if state.current_time != 0 {
        state.current_time
    } else {
        Clock::get()?.unix_timestamp as u32
    };

    // Check if the fill is within the exclusivity window & fill deadline.
    //TODO: ensure the require blocks here are equivilelent to evm.
    require!(
        relay_data.exclusivity_deadline < current_time,
        CustomError::NoSlowFillsInExclusivityWindow
    );
    require!(
        relay_data.fill_deadline < current_time,
        CustomError::ExpiredFillDeadline
    );

    // Check the fill status
    let fill_status_account = &mut ctx.accounts.fill_status;
    require!(
        fill_status_account.status == FillStatus::Unfilled,
        CustomError::InvalidSlowFillRequest
    );

    // Update the fill status to RequestedSlowFill
    fill_status_account.status = FillStatus::RequestedSlowFill;
    fill_status_account.relayer = ctx.accounts.signer.key();

    // Emit the RequestedV3SlowFill event
    emit_cpi!(RequestedV3SlowFill {
        input_token: relay_data.input_token,
        output_token: relay_data.output_token,
        input_amount: relay_data.input_amount,
        output_amount: relay_data.output_amount,
        origin_chain_id: relay_data.origin_chain_id,
        deposit_id: relay_data.deposit_id,
        fill_deadline: relay_data.fill_deadline,
        exclusivity_deadline: relay_data.exclusivity_deadline,
        exclusive_relayer: relay_data.exclusive_relayer,
        depositor: relay_data.depositor,
        recipient: relay_data.recipient,
        message: relay_data.message,
    });

    Ok(())
}

// Define the V3SlowFill struct
#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct V3SlowFill {
    pub relay_data: V3RelayData,
    pub chain_id: u64,
    pub updated_output_amount: u64,
}

impl V3SlowFill {
    pub fn to_bytes(&self) -> Vec<u8> {
        let mut bytes = Vec::new();

        // Order should match the Solidity struct field order
        bytes.extend_from_slice(&self.relay_data.depositor.to_bytes());
        bytes.extend_from_slice(&self.relay_data.recipient.to_bytes());
        bytes.extend_from_slice(&self.relay_data.exclusive_relayer.to_bytes());
        bytes.extend_from_slice(&self.relay_data.input_token.to_bytes());
        bytes.extend_from_slice(&self.relay_data.output_token.to_bytes());
        bytes.extend_from_slice(&self.relay_data.input_amount.to_le_bytes());
        bytes.extend_from_slice(&self.relay_data.output_amount.to_le_bytes());
        bytes.extend_from_slice(&self.relay_data.origin_chain_id.to_le_bytes());
        bytes.extend_from_slice(&self.relay_data.deposit_id.to_le_bytes());
        bytes.extend_from_slice(&self.relay_data.fill_deadline.to_le_bytes());
        bytes.extend_from_slice(&self.relay_data.exclusivity_deadline.to_le_bytes());
        bytes.extend_from_slice(&self.relay_data.message);
        bytes.extend_from_slice(&self.chain_id.to_le_bytes());
        bytes.extend_from_slice(&self.updated_output_amount.to_le_bytes());

        bytes
    }

    pub fn to_keccak_hash(&self) -> [u8; 32] {
        let input = self.to_bytes();
        keccak::hash(&input).0
    }
}

// Define the V3SlowFill struct
#[event_cpi]
#[derive(Accounts)]
#[instruction(relay_hash: [u8; 32], slow_fill_leaf: V3SlowFill, root_bundle_id: u32)]
pub struct ExecuteV3SlowRelayLeaf<'info> {
    #[account(mut, seeds = [b"state", state.seed.to_le_bytes().as_ref()], bump)]
    pub state: Account<'info, State>,

    #[account(mut, seeds =[b"root_bundle", state.key().as_ref(), root_bundle_id.to_le_bytes().as_ref()], bump)]
    pub root_bundle: Account<'info, RootBundle>,

    #[account(mut)]
    pub signer: Signer<'info>,

    #[account(
        mut,
        seeds = [b"fills", relay_hash.as_ref()],
        bump,
        // Make sure caller provided relay_hash used in PDA seeds is valid.
        constraint = is_relay_hash_valid(&relay_hash, &slow_fill_leaf.relay_data, &state) @ CustomError::InvalidRelayHash
    )]
    pub fill_status: Account<'info, FillStatusAccount>,

    #[account(
        mut,
        address = slow_fill_leaf.relay_data.recipient @ CustomError::InvalidFillRecipient
    )]
    pub recipient: SystemAccount<'info>,

    #[account(
        mut,
        token::token_program = token_program,
        address = slow_fill_leaf.relay_data.output_token @ CustomError::InvalidMint
    )]
    pub mint: InterfaceAccount<'info, Mint>,

    #[account(
        mut,
        associated_token::mint = mint,
        associated_token::authority = recipient,
        associated_token::token_program = token_program
    )]
    pub recipient_token_account: InterfaceAccount<'info, TokenAccount>,

    #[account(
        mut,
        associated_token::mint = mint,
        associated_token::authority = state,
        associated_token::token_program = token_program
    )]
    pub vault: InterfaceAccount<'info, TokenAccount>,

    pub token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
}

pub fn execute_v3_slow_relay_leaf(
    ctx: Context<ExecuteV3SlowRelayLeaf>,
    relay_hash: [u8; 32],
    slow_fill_leaf: V3SlowFill,
    root_bundle_id: u32,
    proof: Vec<[u8; 32]>,
) -> Result<()> {
    let relay_data = slow_fill_leaf.relay_data;

    let slow_fill = V3SlowFill {
        relay_data: relay_data.clone(), // Clone relay_data to avoid move
        chain_id: ctx.accounts.state.chain_id, // This overrides caller provided chain_id, same as in EVM SpokePool.
        updated_output_amount: slow_fill_leaf.updated_output_amount,
    };

    let root = ctx.accounts.root_bundle.slow_relay_root;
    let leaf = slow_fill.to_keccak_hash();
    verify_merkle_proof(root, leaf, proof)?;

    // Check if the fill status is unfilled
    let fill_status_account = &mut ctx.accounts.fill_status;
    require!(
        fill_status_account.status == FillStatus::RequestedSlowFill,
        CustomError::InvalidSlowFillRequest
    );

    // Derive the signer seeds for the state
    let state_seed_bytes = ctx.accounts.state.seed.to_le_bytes();
    let seeds = &[b"state", state_seed_bytes.as_ref(), &[ctx.bumps.state]];
    let signer_seeds = &[&seeds[..]];

    // Invoke the transfer_checked instruction on the token program
    let transfer_accounts = TransferChecked {
        from: ctx.accounts.vault.to_account_info(), // Pull from the vault
        mint: ctx.accounts.mint.to_account_info(),
        to: ctx.accounts.recipient_token_account.to_account_info(), // Send to the recipient
        authority: ctx.accounts.state.to_account_info(), // Authority is the state (owner of the vault)
    };
    let cpi_context = CpiContext::new_with_signer(
        ctx.accounts.token_program.to_account_info(),
        transfer_accounts,
        signer_seeds,
    );
    transfer_checked(
        cpi_context,
        slow_fill_leaf.updated_output_amount,
        ctx.accounts.mint.decimals,
    )?;

    // Update the fill status to Filled. Note we don't set the relayer here as it is set when the slow fill was requested.
    fill_status_account.status = FillStatus::Filled;

    // Emit the FilledV3Relay event
    let message_clone = relay_data.message.clone(); // Clone the message before it is moved

    emit_cpi!(FilledV3Relay {
        input_token: relay_data.input_token,
        output_token: relay_data.output_token,
        input_amount: relay_data.input_amount,
        output_amount: relay_data.output_amount,
        repayment_chain_id: 0, // There is no repayment chain id for slow fills.
        origin_chain_id: relay_data.origin_chain_id,
        deposit_id: relay_data.deposit_id,
        fill_deadline: relay_data.fill_deadline,
        exclusivity_deadline: relay_data.exclusivity_deadline,
        exclusive_relayer: relay_data.exclusive_relayer,
        relayer: *ctx.accounts.signer.key,
        depositor: relay_data.depositor,
        recipient: relay_data.recipient,
        message: relay_data.message,
        relay_execution_info: V3RelayExecutionEventInfo {
            updated_recipient: relay_data.recipient,
            updated_message: message_clone,
            updated_output_amount: slow_fill_leaf.updated_output_amount,
            fill_type: FillType::SlowFill,
        },
    });

    Ok(())
}