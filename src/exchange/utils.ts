import {
  Account,
  Connection,
  PublicKey,
  SystemProgram,
  Transaction,
} from "@solana/web3.js";
import BufferLayout from "buffer-layout";
import { TokenInstructions } from "@project-serum/serum";
import BN from "bn.js";

export const ACCOUNT_LAYOUT = BufferLayout.struct([
  BufferLayout.blob(32, "mint"),
  BufferLayout.blob(32, "owner"),
  BufferLayout.nu64("amount"),
  BufferLayout.blob(93),
]);

export function parseTokenAccountData(
  data: Buffer
): { mint: PublicKey; owner: PublicKey; amount: number } {
  const { mint, owner, amount } = ACCOUNT_LAYOUT.decode(data);
  return {
    mint: new PublicKey(mint),
    owner: new PublicKey(owner),
    amount,
  };
}

export const MINT_LAYOUT = BufferLayout.struct([
  BufferLayout.blob(4),
  BufferLayout.blob(32, "mintAuthority"),
  BufferLayout.blob(8, "supply"),
  BufferLayout.u8("decimals"),
  BufferLayout.u8("isInitialized"),
  BufferLayout.blob(4, "freezeAuthorityOption"),
  BufferLayout.blob(32, "freezeAuthority"),
]);

export function parseMintData(
  data: Buffer
): { mintAuthority: PublicKey; supply: number; decimals: number } {
  const { mintAuthority, supply, decimals } = MINT_LAYOUT.decode(data);
  return {
    mintAuthority: new PublicKey(mintAuthority),
    supply,
    decimals,
  };
}

export async function createAndInitializeTokenAccount({
  connection,
  payer,
  mintPublicKey,
  newAccount,
}: {
  connection: Connection;
  payer: Account;
  mintPublicKey: PublicKey;
  newAccount: Account;
}): Promise<string> {
  const transaction = new Transaction();
  const createAccountInstr = SystemProgram.createAccount({
    fromPubkey: payer.publicKey,
    newAccountPubkey: newAccount.publicKey,
    lamports: await connection.getMinimumBalanceForRentExemption(
      ACCOUNT_LAYOUT.span
    ),
    space: ACCOUNT_LAYOUT.span,
    programId: TokenInstructions.TOKEN_PROGRAM_ID,
  });
  transaction.add(createAccountInstr);
  transaction.add(
    TokenInstructions.initializeAccount({
      account: newAccount.publicKey,
      mint: mintPublicKey,
      owner: payer.publicKey,
    })
  );
  const signers = [payer, newAccount];
  return await connection.sendTransaction(transaction, signers);
}

export function makeClientOrderId(bits = 64): BN {
  let binaryString = "1";
  for (let i = 1; i < bits; i++) {
    binaryString += Math.max(
      Math.min(Math.floor(Math.random() * 2), 1),
      0
    ).toString();
  }
  return new BN(binaryString, 2);
}

export function getTokenMultiplierFromDecimals(decimals: number): BN {
  return new BN(10).pow(new BN(decimals));
}
