import { getLayoutVersion, MARKETS, TOKEN_MINTS } from "@project-serum/serum";
import { HARD_CODED_MINTS } from "../config";
import { Market } from "./types";

export const MARKET_PARAMS = MARKETS.map((marketInfo) => {
  const [coin, priceCurrency] = marketInfo.name.split("/");
  return {
    address: marketInfo.address,
    market: new Market(coin, priceCurrency),
    programId: marketInfo.programId,
    version: getLayoutVersion(marketInfo.programId),
  };
});

export const HARD_CODED_COINS = new Set(Object.keys(HARD_CODED_MINTS));

export const COIN_MINTS = Object.fromEntries(
  TOKEN_MINTS.filter(mint => !(mint.name in HARD_CODED_MINTS))
    .map((mint) => [mint.name, mint.address.toBase58()])
    .concat(Object.entries(HARD_CODED_MINTS))
);
