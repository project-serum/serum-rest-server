import { Connection, PublicKey } from "@solana/web3.js";
import { Exchange, Market, SerumMarketInfo } from "./types";
import * as config from "../config";

export class SerumApi {
  static readonly exchange: Exchange = "serum";
  private _connections: Connection[];
  static url = config.SOLANA_URL;

  constructor(
    conections: Connection[],
    marketInfo: { [market: string]: SerumMarketInfo },
    markets: Market[],
    marketAddresses: { [market: string]: PublicKey },
    addressProgramIds: { [address: string]: PublicKey },
    url: string
  ) {}

  static async create(options: { [optionName: string]: unknown } = {}): Promise<SerumApi> {
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
      this.constMarketInfo.map((info) => [info.market.key(), info.address])
    );
    const markets = this.constMarketInfo.map((marketInfo) => marketInfo.market);
    const addressProgramIds = Object.fromEntries(
      Object.entries(this.constMarketInfo).map(([market, info]) => [
        info.address.toBase58(),
        info.programId,
      ])
    );
    const marketInfo: Array<[Market, SerumMarketInfo]> = await Promise.all(
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
}
