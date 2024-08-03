// Migrations are an early feature. Currently, they're nothing more than this
// single deploy script that's invoked from the CLI, injecting a provider
// configured from the workspace's Anchor.toml.

import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { Crystalball } from "../target/types/crystalball";
import { Keypair, PublicKey, SystemProgram } from '@solana/web3.js';


module.exports = async (provider: anchor.AnchorProvider) => {
  anchor.setProvider(provider);

  // const program = new anchor.Program(idl, provider) as Program<Crystalball>;
  
  const program = anchor.workspace.Crystalball as Program<Crystalball>;
  const deployer: Keypair = (provider.wallet as any).payer;

  console.log('program id', program.programId.toBase58());

  const protocolFee = 1; // 1%
  const feeReceiver = deployer.publicKey;

  // const [ configPubkey ] = PublicKey.findProgramAddressSync([Buffer.from('config')], program.programId);

  await program.methods.updateConfig(
    protocolFee,
    feeReceiver,
    false,
  ).accounts({
    admin: deployer.publicKey,
    //@ts-ignore
    // config: configPubkey,
    //@ts-ignore
    systemProgram: SystemProgram.programId,
  }).signers([deployer]).rpc();

  console.log('completed.');

};
