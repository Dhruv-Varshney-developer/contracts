import * as anchor from "@coral-xyz/anchor";
import { ASSOCIATED_TOKEN_PROGRAM_ID, TOKEN_PROGRAM_ID, createMint } from "@solana/spl-token";
import { Keypair } from "@solana/web3.js";
import { assert } from "chai";
import { ethers } from "ethers";
import { SvmSpoke } from "../../target/types/svm_spoke";
import { MessageTransmitter } from "../../target/types/message_transmitter";
import { evmAddressToPublicKey } from "../../src/SvmUtils";
import { encodeMessageHeader } from "./cctpHelpers";
import { common } from "./SvmSpoke.common";

const { createRoutePda, getVaultAta, initializeState, crossDomainAdmin, remoteDomain, localDomain } = common;

describe("svm_spoke.handle_receive_message", () => {
  anchor.setProvider(anchor.AnchorProvider.env());

  const program = anchor.workspace.SvmSpoke as anchor.Program<SvmSpoke>;
  const messageTransmitterProgram = anchor.workspace.MessageTransmitter as anchor.Program<MessageTransmitter>;
  const provider = anchor.AnchorProvider.env();
  const owner = provider.wallet.publicKey;
  let state: anchor.web3.PublicKey;
  let authorityPda: anchor.web3.PublicKey;
  let messageTransmitterState: anchor.web3.PublicKey;
  let usedNonces: anchor.web3.PublicKey;
  let selfAuthority: anchor.web3.PublicKey;
  let eventAuthority: anchor.web3.PublicKey;
  const firstNonce = 1;
  const attestation = Buffer.alloc(0);
  let nonce = firstNonce;
  let remainingAccounts: anchor.web3.AccountMeta[];
  const cctpMessageversion = 0;
  let destinationCaller = new anchor.web3.PublicKey(new Uint8Array(32)); // We don't use permissioned caller.
  let receiveMessageAccounts;

  const ethereumIface = new ethers.utils.Interface([
    "function pauseDeposits(bool pause)",
    "function pauseFills(bool pause)",
    "function setCrossDomainAdmin(address newCrossDomainAdmin)",
    "function setEnableRoute(bytes32 originToken, uint64 destinationChainId, bool enabled)",
  ]);

  beforeEach(async () => {
    state = await initializeState();

    nonce += 1; // Increment CCTP nonce.

    // Get other required accounts.
    [authorityPda] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("message_transmitter_authority"), program.programId.toBuffer()],
      messageTransmitterProgram.programId
    );
    [messageTransmitterState] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("message_transmitter")],
      messageTransmitterProgram.programId
    );
    [usedNonces] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("used_nonces"), Buffer.from(remoteDomain.toString()), Buffer.from(firstNonce.toString())],
      messageTransmitterProgram.programId
    );
    [selfAuthority] = anchor.web3.PublicKey.findProgramAddressSync([Buffer.from("self_authority")], program.programId);
    [eventAuthority] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("__event_authority")],
      program.programId
    );

    // Accounts in CCTP message_transmitter receive_message instruction.
    receiveMessageAccounts = {
      payer: provider.wallet.publicKey,
      caller: provider.wallet.publicKey,
      authorityPda,
      messageTransmitter: messageTransmitterState,
      usedNonces,
      receiver: program.programId,
      systemProgram: anchor.web3.SystemProgram.programId,
    };

    remainingAccounts = [];
    // state in HandleReceiveMessage accounts (used for remote domain and sender authentication).
    remainingAccounts.push({
      isSigner: false,
      isWritable: false,
      pubkey: state,
    });
    // self_authority in HandleReceiveMessage accounts, also signer in self-invoked CPIs.
    remainingAccounts.push({
      isSigner: false,
      // signer in self-invoked CPIs is mutable, as Solana owner is also fee payer when not using CCTP.
      isWritable: true,
      pubkey: selfAuthority,
    });
    // program in HandleReceiveMessage accounts.
    remainingAccounts.push({
      isSigner: false,
      isWritable: false,
      pubkey: program.programId,
    });
    // state in self-invoked CPIs (state can change as a result of remote call).
    remainingAccounts.push({
      isSigner: false,
      isWritable: true,
      pubkey: state,
    });
    // event_authority in self-invoked CPIs (appended by Anchor with event_cpi macro).
    remainingAccounts.push({
      isSigner: false,
      isWritable: false,
      pubkey: eventAuthority,
    });
    // program in self-invoked CPIs (appended by Anchor with event_cpi macro).
    remainingAccounts.push({
      isSigner: false,
      isWritable: false,
      pubkey: program.programId,
    });
  });

  it("Block Unauthorized Message", async () => {
    const unauthorizedSender = Keypair.generate().publicKey;
    const calldata = ethereumIface.encodeFunctionData("pauseDeposits", [true]);
    const messageBody = Buffer.from(calldata.slice(2), "hex");

    const message = encodeMessageHeader({
      version: cctpMessageversion,
      sourceDomain: remoteDomain,
      destinationDomain: localDomain,
      nonce: BigInt(nonce),
      sender: unauthorizedSender,
      recipient: program.programId,
      destinationCaller,
      messageBody,
    });

    try {
      await messageTransmitterProgram.methods
        .receiveMessage({ message, attestation })
        .accounts(receiveMessageAccounts)
        .remainingAccounts(remainingAccounts)
        .rpc();
      assert.fail("Should not be able to receive message from unauthorized sender");
    } catch (error) {
      assert.instanceOf(error, anchor.AnchorError);
      assert.strictEqual(error.error.errorCode.code, "InvalidRemoteSender", "Expected error code InvalidRemoteSender");
    }
  });

  it("Block Wrong Source Domain", async () => {
    const sourceDomain = 666;
    [receiveMessageAccounts.usedNonces] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("used_nonces"), Buffer.from(sourceDomain.toString()), Buffer.from(firstNonce.toString())],
      messageTransmitterProgram.programId
    );

    const calldata = ethereumIface.encodeFunctionData("pauseDeposits", [true]);
    const messageBody = Buffer.from(calldata.slice(2), "hex");

    const message = encodeMessageHeader({
      version: cctpMessageversion,
      sourceDomain,
      destinationDomain: localDomain,
      nonce: BigInt(nonce),
      sender: crossDomainAdmin,
      recipient: program.programId,
      destinationCaller,
      messageBody,
    });

    try {
      await messageTransmitterProgram.methods
        .receiveMessage({ message, attestation })
        .accounts(receiveMessageAccounts)
        .remainingAccounts(remainingAccounts)
        .rpc();
      assert.fail("Should not be able to receive message from wrong source domain");
    } catch (error) {
      assert.instanceOf(error, anchor.AnchorError);
      assert.strictEqual(error.error.errorCode.code, "InvalidRemoteDomain", "Expected error code InvalidRemoteDomain");
    }
  });

  it("Pauses and unpauses deposits remotely", async () => {
    // Pause deposits.
    let calldata = ethereumIface.encodeFunctionData("pauseDeposits", [true]);
    let messageBody = Buffer.from(calldata.slice(2), "hex");
    let message = encodeMessageHeader({
      version: cctpMessageversion,
      sourceDomain: remoteDomain,
      destinationDomain: localDomain,
      nonce: BigInt(nonce),
      sender: crossDomainAdmin,
      recipient: program.programId,
      destinationCaller,
      messageBody,
    });
    await messageTransmitterProgram.methods
      .receiveMessage({ message, attestation })
      .accounts(receiveMessageAccounts)
      .remainingAccounts(remainingAccounts)
      .rpc();
    let stateData = await program.account.state.fetch(state);
    assert.isTrue(stateData.pausedDeposits, "Deposits should be paused");

    // Unpause deposits.
    nonce += 1;
    calldata = ethereumIface.encodeFunctionData("pauseDeposits", [false]);
    messageBody = Buffer.from(calldata.slice(2), "hex");
    message = encodeMessageHeader({
      version: cctpMessageversion,
      sourceDomain: remoteDomain,
      destinationDomain: localDomain,
      nonce: BigInt(nonce),
      sender: crossDomainAdmin,
      recipient: program.programId,
      destinationCaller,
      messageBody,
    });
    await messageTransmitterProgram.methods
      .receiveMessage({ message, attestation })
      .accounts(receiveMessageAccounts)
      .remainingAccounts(remainingAccounts)
      .rpc();
    stateData = await program.account.state.fetch(state);
    assert.isFalse(stateData.pausedDeposits, "Deposits should not be paused");
  });

  it("Pauses and unpauses fills remotely", async () => {
    // Pause fills.
    let calldata = ethereumIface.encodeFunctionData("pauseFills", [true]);
    let messageBody = Buffer.from(calldata.slice(2), "hex");
    let message = encodeMessageHeader({
      version: cctpMessageversion,
      sourceDomain: remoteDomain,
      destinationDomain: localDomain,
      nonce: BigInt(nonce),
      sender: crossDomainAdmin,
      recipient: program.programId,
      destinationCaller,
      messageBody,
    });
    await messageTransmitterProgram.methods
      .receiveMessage({ message, attestation })
      .accounts(receiveMessageAccounts)
      .remainingAccounts(remainingAccounts)
      .rpc();
    let stateData = await program.account.state.fetch(state);
    assert.isTrue(stateData.pausedFills, "Fills should be paused");

    // Unpause fills.
    nonce += 1;
    calldata = ethereumIface.encodeFunctionData("pauseFills", [false]);
    messageBody = Buffer.from(calldata.slice(2), "hex");
    message = encodeMessageHeader({
      version: cctpMessageversion,
      sourceDomain: remoteDomain,
      destinationDomain: localDomain,
      nonce: BigInt(nonce),
      sender: crossDomainAdmin,
      recipient: program.programId,
      destinationCaller,
      messageBody,
    });
    await messageTransmitterProgram.methods
      .receiveMessage({ message, attestation })
      .accounts(receiveMessageAccounts)
      .remainingAccounts(remainingAccounts)
      .rpc();
    stateData = await program.account.state.fetch(state);
    assert.isFalse(stateData.pausedFills, "Fills should not be paused");
  });

  it("Sets cross-domain admin remotely", async () => {
    const newCrossDomainAdminAddress = ethers.Wallet.createRandom().address;
    const newCrossDomainAdminPubkey = evmAddressToPublicKey(newCrossDomainAdminAddress);
    let calldata = ethereumIface.encodeFunctionData("setCrossDomainAdmin", [newCrossDomainAdminAddress]);
    let messageBody = Buffer.from(calldata.slice(2), "hex");
    let message = encodeMessageHeader({
      version: cctpMessageversion,
      sourceDomain: remoteDomain,
      destinationDomain: localDomain,
      nonce: BigInt(nonce),
      sender: crossDomainAdmin,
      recipient: program.programId,
      destinationCaller,
      messageBody,
    });
    await messageTransmitterProgram.methods
      .receiveMessage({ message, attestation })
      .accounts(receiveMessageAccounts)
      .remainingAccounts(remainingAccounts)
      .rpc();
    let stateData = await program.account.state.fetch(state);
    assert.strictEqual(
      stateData.crossDomainAdmin.toString(),
      newCrossDomainAdminPubkey.toString(),
      "Cross-domain admin should be set"
    );
  });

  it("Enables and disables route remotely", async () => {
    // Enable the route.
    const originToken = await createMint(provider.connection, provider.wallet.payer, owner, owner, 6);
    const routeChainId = 1;
    let calldata = ethereumIface.encodeFunctionData("setEnableRoute", [originToken.toBuffer(), routeChainId, true]);
    let messageBody = Buffer.from(calldata.slice(2), "hex");
    let message = encodeMessageHeader({
      version: cctpMessageversion,
      sourceDomain: remoteDomain,
      destinationDomain: localDomain,
      nonce: BigInt(nonce),
      sender: crossDomainAdmin,
      recipient: program.programId,
      destinationCaller,
      messageBody,
    });

    // Remaining accounts specific to SetEnableRoute.
    const routePda = createRoutePda(originToken, state, new anchor.BN(routeChainId));
    const vault = getVaultAta(originToken, state);
    // Same 3 remaining accounts passed for HandleReceiveMessage context.
    const enableRouteRemainingAccounts = remainingAccounts.slice(0, 3);
    // payer in self-invoked SetEnableRoute.
    enableRouteRemainingAccounts.push({
      isSigner: true,
      isWritable: true,
      pubkey: provider.wallet.publicKey,
    });
    // state in self-invoked SetEnableRoute.
    enableRouteRemainingAccounts.push({
      isSigner: false,
      isWritable: true,
      pubkey: state,
    });
    // route in self-invoked SetEnableRoute.
    enableRouteRemainingAccounts.push({
      isSigner: false,
      isWritable: true,
      pubkey: routePda,
    });
    // vault in self-invoked SetEnableRoute.
    enableRouteRemainingAccounts.push({
      isSigner: false,
      isWritable: true,
      pubkey: vault,
    });
    // origin_token_mint in self-invoked SetEnableRoute.
    enableRouteRemainingAccounts.push({
      isSigner: false,
      isWritable: false,
      pubkey: originToken,
    });
    // token_program in self-invoked SetEnableRoute.
    enableRouteRemainingAccounts.push({
      isSigner: false,
      isWritable: false,
      pubkey: TOKEN_PROGRAM_ID,
    });
    // associated_token_program in self-invoked SetEnableRoute.
    enableRouteRemainingAccounts.push({
      isSigner: false,
      isWritable: false,
      pubkey: ASSOCIATED_TOKEN_PROGRAM_ID,
    });
    // system_program in self-invoked SetEnableRoute.
    enableRouteRemainingAccounts.push({
      isSigner: false,
      isWritable: false,
      pubkey: anchor.web3.SystemProgram.programId,
    });
    // event_authority in self-invoked SetEnableRoute (appended by Anchor with event_cpi macro).
    enableRouteRemainingAccounts.push({
      isSigner: false,
      isWritable: false,
      pubkey: eventAuthority,
    });
    // program in self-invoked SetEnableRoute (appended by Anchor with event_cpi macro).
    enableRouteRemainingAccounts.push({
      isSigner: false,
      isWritable: false,
      pubkey: program.programId,
    });
    await messageTransmitterProgram.methods
      .receiveMessage({ message, attestation })
      .accounts(receiveMessageAccounts)
      .remainingAccounts(enableRouteRemainingAccounts)
      .rpc();

    let routeAccount = await program.account.route.fetch(routePda);
    assert.isTrue(routeAccount.enabled, "Route should be enabled");

    // Disable the route.
    nonce += 1;
    calldata = ethereumIface.encodeFunctionData("setEnableRoute", [originToken.toBuffer(), routeChainId, false]);
    messageBody = Buffer.from(calldata.slice(2), "hex");
    message = encodeMessageHeader({
      version: cctpMessageversion,
      sourceDomain: remoteDomain,
      destinationDomain: localDomain,
      nonce: BigInt(nonce),
      sender: crossDomainAdmin,
      recipient: program.programId,
      destinationCaller,
      messageBody,
    });
    await messageTransmitterProgram.methods
      .receiveMessage({ message, attestation })
      .accounts(receiveMessageAccounts)
      .remainingAccounts(enableRouteRemainingAccounts)
      .rpc();

    routeAccount = await program.account.route.fetch(routePda);
    assert.isFalse(routeAccount.enabled, "Route should be disabled");
  });
});