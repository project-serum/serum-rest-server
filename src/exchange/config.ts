import { getLayoutVersion, MARKETS, TOKEN_MINTS } from "@project-serum/serum";
import { HARD_CODED_MINTS } from "../config";
import { Pair } from "./types";
import { PublicKey } from "@solana/web3.js";

export const MARKET_PARAMS = MARKETS.map((marketInfo) => {
  const [coin, priceCurrency] = marketInfo.name.split("/");
  return {
    address: marketInfo.address,
    market: new Pair(coin, priceCurrency),
    programId: marketInfo.programId,
    version: getLayoutVersion(marketInfo.programId),
  };
});

export const HARD_CODED_COINS = new Set(Object.keys(HARD_CODED_MINTS));

export const COIN_MINTS: { [coin: string]: string } = Object.fromEntries(
  TOKEN_MINTS.filter((mint) => !(mint.name in HARD_CODED_MINTS))
    .map((mint) => [mint.name, mint.address.toBase58()])
    .concat(Object.entries(HARD_CODED_MINTS))
);

export const MINT_COINS: { [mint: string]: string } = Object.assign(
  {},
  ...Object.entries(COIN_MINTS).map(([coin, mint]) => ({
    [mint]: coin,
  }))
);

export const EXCHANGE_ENABLED_MARKETS: {
  [exchange: string]: {
    address: PublicKey;
    market: Pair;
    programId: PublicKey;
    version: number;
  }[];
} = {
  serum: MARKET_PARAMS,
};
