import { Account, Connection, PublicKey } from "@solana/web3.js";
import { Coin, Exchange, MarketInfo, Pair } from "./types";
import * as config from "../config";
import { COIN_MINTS, EXCHANGE_ENABLED_MARKETS } from "./config";
import { getKeys } from "../utils";
import assert from "assert";
import { Market } from "@project-serum/serum";

export class SerumApi {
  static readonly exchange: Exchange = "serum";
  static url = config.SOLANA_URL;
  readonly exchange: Exchange;
  readonly marketInfo: { [market: string]: MarketInfo };
  readonly markets: Pair[];
  readonly addressMarkets: { [address: string]: Market };
  readonly marketAddresses: { [market: string]: PublicKey };
  readonly addressProgramIds: { [address: string]: PublicKey };
  private _connections: Connection[];
  private _publicKey: PublicKey;
  private _privateKey: Array<number>;
  private _account: Account;
  private _wsConnection: Connection;

  constructor(
    exchange: Exchange,
    conections: Connection[],
    marketInfo: { [market: string]: MarketInfo },
    markets: Pair[],
    marketAddresses: { [market: string]: PublicKey },
    addressProgramIds: { [address: string]: PublicKey },
    url: string
  ) {
    this.exchange = exchange;
    this._connections = conections;
    this._privateKey = getKeys([`${this.exchange}_private_key`])[0];
    this._account = new Account(this._privateKey);
    this._publicKey = this._account.publicKey;
    this.marketInfo = marketInfo;
    this.markets = markets;
    this.marketAddresses = marketAddresses;
    this.addressMarkets = Object.assign(
      {},
      ...Object.entries(marketAddresses).map(([market, address]) => ({
        [address.toBase58()]: Pair.fromKey(market),
      }))
    );
    this.addressProgramIds = addressProgramIds;
    this._wsConnection = new Connection(url, "recent");
  }

  static async create(
    options: { [optionName: string]: unknown } = {}
  ): Promise<SerumApi> {
    const connections: Connection[] = [];
    for (let i = 0; i < config.NUM_CONNECTIONS; i++) {
      const url =
        "url" in options && typeof options.url === "string"
          ? options.url
          : this.url;
      const connection = new Connection(url, "recent");
      connection.onSlotChange((slotInfo) => {});
      connections.push(connection);
    }
    const marketAddresses = Object.fromEntries(
      EXCHANGE_ENABLED_MARKETS[this.exchange].map((info) => [
        info.market.key(),
        info.address,
      ])
    );
    const markets = EXCHANGE_ENABLED_MARKETS[this.exchange].map(
      (marketInfo) => marketInfo.market
    );
    const addressProgramIds = Object.fromEntries(
      Object.entries(
        EXCHANGE_ENABLED_MARKETS[this.exchange]
      ).map(([market, info]) => [info.address.toBase58(), info.programId])
    );
    const marketInfo: Array<[Pair, MarketInfo]> = await Promise.all(
      markets.map((market) =>
        this.getMarketInfo(
          connections[0],
          market.coin,
          market.priceCurrency,
          marketAddresses[market.key()],
          addressProgramIds[marketAddresses[market.key()].toBase58()]
        )
      )
    );
    return new this(
      this.exchange,
      connections,
      Object.fromEntries(
        marketInfo.map(([market, info]) => [market.key(), info])
      ),
      markets,
      marketAddresses,
      addressProgramIds,
      this.url
    );
  }

  static async getMarketInfo(
    connection: Connection,
    coin: Coin,
    priceCurrency: Coin,
    marketAddress: PublicKey,
    programId: PublicKey
  ): Promise<any> {
    const market = new Pair(coin, priceCurrency);
    const serumMarket = await Market.load(
      connection,
      marketAddress,
      {},
      programId
    );
    assert(
      serumMarket.baseMintAddress.toBase58() === COIN_MINTS[coin],
      `${coin} on ${coin}/${priceCurrency} has wrong mint. Our mint: ${
        COIN_MINTS[coin]
      } Serum's mint ${serumMarket.baseMintAddress.toBase58()}`
    );
    assert(
      serumMarket.quoteMintAddress.toBase58() === COIN_MINTS[priceCurrency],
      `${priceCurrency} on ${coin}/${priceCurrency} has wrong mint. Our mint: ${
        COIN_MINTS[priceCurrency]
      } Serum's mint ${serumMarket.quoteMintAddress.toBase58()}`
    );
    return [
      market,
      {
        coin: coin,
        priceCurrency: priceCurrency,
        address: marketAddress,
        baseMint: serumMarket.baseMintAddress,
        quoteMint: serumMarket.quoteMintAddress,
        minOrderSize: serumMarket.minOrderSize,
        tickSize: serumMarket.tickSize,
        programId: programId,
      },
    ];
  }

  async getMarketInfo(): Promise<{ [k: string]: {[prop: string]: string | number}}> {
    return Object.fromEntries(
      Object.entries(this.marketInfo).map(([market, info]) => [
        market,
        {
          ...info,
          address: info.address.toBase58(),
          baseMint: info.baseMint.toBase58(),
          quoteMint: info.quoteMint.toBase58(),
          programId: info.programId.toBase58(),
          minOrderSize: info.minOrderSize,
          tickSize: info.tickSize,
        },
      ])
    );
  }
}
