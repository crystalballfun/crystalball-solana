import * as anchor from "@coral-xyz/anchor";
import { Program, web3 } from "@coral-xyz/anchor";
import { Crystalball } from "../target/types/crystalball";
import { PublicKey, Keypair, SystemProgram } from '@solana/web3.js';
import { assert } from 'chai';

describe("crystalball", () => {
  // Configure the client to use the local cluster.
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.Crystalball as Program<Crystalball>;
  const deployer: Keypair = (provider.wallet as any).payer;
  const seed = randomUint64();
  const seed2 = randomUint64();
  let predictionPubkey: PublicKey;
  let prediction2Pubkey: PublicKey;
  let creator: Keypair;
  let user1: Keypair;
  let user2: Keypair;
  let user3: Keypair;
  let user4: Keypair;
  let startTime: number;

  before(async () => {
    [ predictionPubkey ] = PublicKey.findProgramAddressSync([ Buffer.from('prediction'), seed.toArrayLike(Buffer, 'le', 8) ], program.programId);
    [ prediction2Pubkey ] = PublicKey.findProgramAddressSync([ Buffer.from('prediction'), seed2.toArrayLike(Buffer, 'le', 8) ], program.programId);
    console.log('Prediction', predictionPubkey.toBase58());
    console.log('Deployer', deployer.publicKey.toBase58());

    creator = Keypair.generate();
    user1 = Keypair.generate();
    user2 = Keypair.generate();
    user3 = Keypair.generate();
    user4 = Keypair.generate();

    // Airdrop SOL to users
    await airdropSol(creator.publicKey, 1e9);
    await airdropSol(user1.publicKey, 1e9);
    await airdropSol(user2.publicKey, 1e9);
    await airdropSol(user3.publicKey, 1e9);
  });

  it("Initialize config", async () => {
    const protocolFee = 1; // 1%
    const feeReceiver = user4.publicKey;

    const [ configPubkey ] = PublicKey.findProgramAddressSync([Buffer.from('config')], program.programId);

    await program.methods.updateConfig(
      protocolFee,
      feeReceiver,
      false,
    ).accounts({
      admin: deployer.publicKey,
      //@ts-ignore
      systemProgram: SystemProgram.programId,
    }).signers([deployer]).rpc();

    const config = await program.account.config.fetch(configPubkey);
    assert.equal(config.admin.toBase58(), deployer.publicKey.toBase58());
    assert.equal(config.protocolFee, protocolFee);
    assert.equal(config.feeReceiver.toBase58(), feeReceiver.toBase58());

    try {
      await program.methods.updateConfig(
        protocolFee,
        feeReceiver,
        false,
      ).accounts({
        admin: creator.publicKey,
        //@ts-ignore
        systemProgram: SystemProgram.programId,
      }).signers([creator]).rpc();
    } catch (err) {
      const errorMsg = "Invalid owner";
      assert.ok(err.toString().includes(errorMsg), `Expected error message: ${errorMsg}, but got: ${err}`);
    }
  });

  it("Check config owner", async () => {
    const [ configPubkey ] = PublicKey.findProgramAddressSync([Buffer.from('config')],program.programId);
    const configAccountInfo = await provider.connection.getAccountInfo(configPubkey);
    assert.equal(configAccountInfo.owner.toBase58(), program.programId.toBase58(), "Config account owner should be the program ID");
  });

  it("Creating prediction", async () => {
    // Add your test here.
    // const tx = await program.methods.initialize().rpc();
    // console.log("Your transaction signature", tx);
    
    startTime = Math.floor(Date.now() / 1000);
    const title = 'Test Prediction';
    const title2 = 'Test Prediction2';
    // await create(seed, title, startTime, 4);
    // await create(seed2, title2, startTime, 4);
    await Promise.all([
      create(seed, title, startTime, 4), 
      create(seed2, title2, startTime, 4)
    ]);

    const prediction = await program.account.prediction.fetch(predictionPubkey);
    assert.equal(prediction.creator.toBase58(), creator.publicKey.toBase58());
    assert.equal(prediction.title, title);
    console.log('      prediction endedtime', prediction.endedTime.toString());
  });

  it("User predictions", async () => {
    await predict(user1, predictionPubkey, 0, 1e8);
    await predict(user2, predictionPubkey, 0, 1e8);
    await predict(user2, predictionPubkey, 1, 1e8);
    await predict(user2, predictionPubkey, 1, 1e8);
    await predict(user3, predictionPubkey, 2, 2e8);


    await predict(user1, prediction2Pubkey, 1, 1e8);

    const balance = await provider.connection.getBalance(predictionPubkey);
    console.log('      pool balance', balance);
  });

  it('Reveals the result (Not time yet)', async () => {
    try {
      await reveal(creator, predictionPubkey, 1);

      assert.fail('Expected reveal to fail');
    } catch (err) {
        const errorMsg = "Prediction is still open";
        assert.ok(err.toString().includes(errorMsg), `Expected error message: ${errorMsg}, but got: ${err}`);
    }
  });

  it('Reveals the result', async () => {
    const endTime = startTime + 6;
    const waitTime = (endTime * 1000) - Date.now();
    if (waitTime > 0) {
      console.log('      wait ' + (waitTime / 1000) + 's...');
      await sleep(waitTime);
    }
    console.log('      now time ' + Math.floor(Date.now() / 1000));

    try {
      await reveal(user4, predictionPubkey, 1);
    } catch (err) {
        const errorMsg = "Invalid creator";
        assert.ok(err.toString().includes(errorMsg), `Expected error message: ${errorMsg}, but got: ${err}`);
    }

    await reveal(creator, predictionPubkey, 1);

    const prediction = await program.account.prediction.fetch(predictionPubkey);
    assert.equal(prediction.resultIndex, 1);
  });

  it('Users claim their rewards', async () => {
    try {
      await claim(user1, predictionPubkey, 0);
      assert.fail('Expected claim to fail');
    } catch (err) {
      const errorMsg = "Wrong option";
      assert.ok(err.toString().includes(errorMsg), `Expected error message: ${errorMsg}, but got: ${err}`);
    }

    try {
      await claim(user1, predictionPubkey, 1);
      assert.fail('Expected claim to fail');
    } catch (err) {
      const errorMsg = "AccountNotInitialized";
      assert.ok(err.toString().includes(errorMsg), `Expected error message: ${errorMsg}, but got: ${err}`);
    }

    await claim(user2, predictionPubkey, 1);

    try {
      await claim(user2, predictionPubkey, 1);
      assert.fail('Expected claim to fail');
    } catch (err) {
      const errorMsg = "Already claimed";
      assert.ok(err.toString().includes(errorMsg), `Expected error message: ${errorMsg}, but got: ${err}`);
    }

    try {
      await claim(user3, predictionPubkey, 2);
      assert.fail('Expected claim to fail');
    } catch (err) {
      const errorMsg = "Wrong option";
      assert.ok(err.toString().includes(errorMsg), `Expected error message: ${errorMsg}, but got: ${err}`);
    }

    const balance = await provider.connection.getBalance(predictionPubkey);
    const balance1 = await provider.connection.getBalance(user1.publicKey);
    const balance2 = await provider.connection.getBalance(user2.publicKey);
    const balance3 = await provider.connection.getBalance(user3.publicKey);
    const balance4 = await provider.connection.getBalance(user4.publicKey);
    console.log('      user1 balance', balance1);
    console.log('      user2 balance', balance2);
    console.log('      user3 balance', balance3);
    console.log('      pool balance', balance);
    console.log('      protocol fee', balance4);
  });

  it('Test wrong predict and reveal', async () => {
    try {
      await predict(user2, predictionPubkey, 0, 1e8);
      assert.fail('Expected predict to fail');
    } catch (err) {
      const errorMsg = "Prediction has closed";
      assert.ok(err.toString().includes(errorMsg), `Expected error message: ${errorMsg}, but got: ${err}`);
    }

    const revealDeadline = startTime + 10;
    const waitTime = (revealDeadline * 1000) - Date.now();
    if (waitTime > 0) {
      console.log('      wait ' + (waitTime / 1000) + 's...');
      await sleep(waitTime);
    }

    try {
      await reveal(creator, prediction2Pubkey, 2);
      const prediction = await program.account.prediction.fetch(prediction2Pubkey);
      console.log('      reveal deadline', prediction.revealDeadline.toString());
      console.log('      local deadline', revealDeadline / 1000);
      assert.fail('Expected reveal to fail');
    } catch (err) {
        const errorMsg = "Reveal deadline has passed";
        assert.ok(err.toString().includes(errorMsg), `Expected error message: ${errorMsg}, but got: ${err}`);
    }

  });

  it('Users withdraws', async () => {
    try {
      await predict(user2, prediction2Pubkey, 0, 1e8);
      assert.fail('Expected predict to fail');
    } catch (err) {
      const errorMsg = "Prediction has closed";
      assert.ok(err.toString().includes(errorMsg), `Expected error message: ${errorMsg}, but got: ${err}`);
    }

    const balance0 = await provider.connection.getBalance(user1.publicKey);
    console.log('      user1 balance before withdraw', balance0);

    // withdraw
    await withdraw(user1, prediction2Pubkey, 1);

    const balance1 = await provider.connection.getBalance(user1.publicKey);
    console.log('      user1 balance after withdraw', balance1);

    assert.ok(balance0 + 1e8 == balance1, `balance not correct`);
  });
  // it('Show all accounts', async () => {
  //   const accounts = await program.account.prediction.all();
  //   accounts.map(a => console.log(a))
  //   const userOptions = await program.account.userOption.all();
  //   userOptions.map(a => console.log(a))
  // });

  async function predict(user: Keypair, predictionPubkey: PublicKey, optionIndex: number, amount: number) {
    const [ userOptionPubkey, bump ] = PublicKey.findProgramAddressSync(
      [Buffer.from('user-option'), user.publicKey.toBuffer(), predictionPubkey.toBuffer(), Buffer.from([optionIndex])],
      program.programId
    );

    await program.methods.predict(
      optionIndex,
      new anchor.BN(amount),
    ).accounts({
      //@ts-ignore
      prediction: predictionPubkey,
      userOption: userOptionPubkey,
      user: user.publicKey,
      systemProgram: SystemProgram.programId,
    }).signers([user]).rpc();
  }

  async function create(seed: anchor.BN, title: string, startTime: number, expired: number) {
    const options = [
      { label: 'Option 1', amount: new anchor.BN(0) },
      { label: 'Option 2', amount: new anchor.BN(0) },
      { label: 'Option 3', amount: new anchor.BN(0) },
    ];
    // console.log('create time', Date.now() / 1000);
    await program.methods.create(
      seed,
      title,
      'This is a test prediction',
      'https://example.com/image.png',
      new anchor.BN(startTime + expired), // end_time 1 minute from now
      new anchor.BN(startTime + (expired * 2)), // reveal_time 2 minutes from now
      1, // creator_fee
      options,
    ).accounts({
      creator: creator.publicKey,
      //@ts-ignore
      systemProgram: SystemProgram.programId,
    }).signers([ creator ]).rpc();
  }

  async function reveal(creator: Keypair, predictionPubkey: PublicKey, result: number) {
    await program.methods.reveal(result).accounts({
      //@ts-ignore
      prediction: predictionPubkey,
      creator: creator.publicKey,
      feeReceiver: user4.publicKey,
    }).signers([creator]).rpc();

  }

  async function claim(user: Keypair, predictionPubkey: PublicKey, optionIndex: number) {
    const [userOptionPubkey] = PublicKey.findProgramAddressSync(
      [Buffer.from('user-option'), user.publicKey.toBuffer(), predictionPubkey.toBuffer(), Buffer.from([optionIndex])],
      program.programId
    );

    const signature = await program.methods.claim().accounts({
      //@ts-ignore
      prediction: predictionPubkey,
      userOption: userOptionPubkey,
      user: user.publicKey,
    }).signers([user]).rpc();

    await confirmTransactionAndParsedEvents(signature);

    
  }

  async function withdraw(user: Keypair, predictionPubkey: PublicKey, optionIndex: number) {
    const [userOptionPubkey] = PublicKey.findProgramAddressSync(
      [Buffer.from('user-option'), user.publicKey.toBuffer(), predictionPubkey.toBuffer(), Buffer.from([optionIndex])],
      program.programId
    );

    await program.methods.withdraw().accounts({
      //@ts-ignore
      prediction: predictionPubkey,
      userOption: userOptionPubkey,
      user: user.publicKey,
    }).signers([user]).rpc();


    
  }

  async function airdropSol(publicKey: PublicKey, amount: number) {
    const airdropSignature = await provider.connection.requestAirdrop(publicKey, amount);
    await confirmTransaction(airdropSignature);
  }

  async function confirmTransaction(signature: string) {
    const latestBlockHash = await provider.connection.getLatestBlockhash();
    await provider.connection.confirmTransaction({
      blockhash: latestBlockHash.blockhash,
      lastValidBlockHeight: latestBlockHash.lastValidBlockHeight,
      signature,
    }, 'confirmed');
  }

  async function confirmTransactionAndParsedEvents(signature: string) {
    await confirmTransaction(signature);
    // console.log(`Transaction signature: ${signature}`);
    const transaction = await provider.connection.getParsedTransaction(signature, 'confirmed');
    if (transaction && transaction.meta) {
      console.log('Logs:');
      transaction.meta.logMessages?.forEach(log => {
        // console.log(log);
        if (log.includes('Program data:')) {
          const logData = log.split('Program data: ')[1];
          try {
            const event = program.coder.events.decode(logData);
            console.log('Event name:', event.name);
            for (const key in event.data) {
              let value = event.data[key];
              if (value instanceof PublicKey) {
                value = value.toBase58();
              } else if (value.toString) {
                value = value.toString();
              }
              console.log(key + ':', value);
            }
          } catch (e) {
            console.log('Not an event log:', logData);
          }
        }
      });
    }
  }

  function randomUint64(): anchor.BN {
    // Generate two random 32-bit integers
    const high = Math.floor(Math.random() * 0xFFFFFFFF);
    const low = Math.floor(Math.random() * 0xFFFFFFFF);

    // Convert to BN and combine into a 64-bit integer
    const highBN = new anchor.BN(high);
    const lowBN = new anchor.BN(low);

    // Shift high part 32 bits to the left and add low part
    const result = highBN.shln(32).add(lowBN);

    return result;
  } 
  
  function sleep(ms: number) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  async function sendSol(sender: Keypair, recipient: PublicKey) {
    const transaction = new web3.Transaction().add(
      web3.SystemProgram.transfer({
        fromPubkey: sender.publicKey,
        toPubkey: recipient,
        lamports: web3.LAMPORTS_PER_SOL * 0.1,
      }),
    );
      const signature = await web3.sendAndConfirmTransaction(
      provider.connection,
      transaction,
      [ sender ],
    );
  
    console.log('Transaction signature', signature);
  }
  

  
});
