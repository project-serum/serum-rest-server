import {
  Account,
  AccountInfo, Blockhash,
  Connection,
  Context,
  PublicKey, Transaction,
} from "@solana/web3.js";
import {
  Coin,
  Dir,
  Exchange,
  L2OrderBook,
  MarketInfo, OrderType,
  Pair,
  RawTrade,
  TimestampedL2Levels, TokenAccountInfo,
  Trade,
} from "./types";
import * as config from "../config";
import {COIN_MINTS, EXCHANGE_ENABLED_MARKETS, MINT_COINS} from "./config";
import {DirUtil, getKeys, getUnixTs, logger, sleep} from "../utils";
import assert from "assert";
import {Market, OpenOrders, Orderbook, TokenInstructions} from "@project-serum/serum";
import { Buffer } from "buffer";
import BN from "bn.js";
import {makeClientOrderId, parseTokenAccountData} from "./utils";
import {OrderParams} from "@project-serum/serum/lib/market";
import {BLOCKHASH_CACHE_TIME, DEFAULT_TIMEOUT} from "../config";
import {signAndSerializeTransaction} from "./solana";

export class SerumApi {
  static readonly exchange: Exchange = "serum";
  static url = config.SOLANA_URL;
  readonly exchange: Exchange;
  readonly marketInfo: { [market: string]: MarketInfo };
  readonly markets: Pair[];
  readonly addressMarkets: { [address: string]: Market };
  readonly marketAddresses: { [market: string]: PublicKey };
  readonly addressProgramIds: { [address: string]: PublicKey };
  private _loadedMarkets: { [address: string]: Market };
  private _connections: Connection[];
  private _publicKey: PublicKey;
  private _privateKey: Array<number>;
  private _account: Account;
  private _wsConnection: Connection;
  private _wsOrderbooks: {
    [market: string]: { buy: TimestampedL2Levels; sell: TimestampedL2Levels };
  };
  private _wsOrderbooksConnected: string[];
  protected _tokenAccountsCache: {
    [coin: string]: { accounts: TokenAccountInfo[]; ts: number };
  };
  protected _blockhashCache: {
    blockhash: Blockhash;
    fetchedAt: number;
  };

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
    this._loadedMarkets = {};
    this._wsOrderbooks = {};
    this._wsOrderbooksConnected = [];
    this._tokenAccountsCache = {};
    this._blockhashCache = { blockhash: "", fetchedAt: 0 };
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

  get _connection(): Connection {
    return this._connections[
      Math.floor(Math.random() * this._connections.length)
    ];
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

  async getMarketInfo(): Promise<{
    [k: string]: { [prop: string]: string | number };
  }> {
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

  async getMarketFromAddress(address: string | PublicKey): Promise<Market> {
    const stringAddress =
      typeof address === "string" ? address : address.toBase58();
    if (stringAddress in this._loadedMarkets) {
      return this._loadedMarkets[stringAddress];
    }
    const pubKeyAddress =
      typeof address === "string" ? new PublicKey(address) : address;
    const market = await Market.load(
      this._connection,
      pubKeyAddress,
      {},
      this.addressProgramIds[stringAddress]
    );
    this._loadedMarkets[stringAddress] = market;
    return market;
  }

  private getMarketAddress(coin: Coin, priceCurrency: Coin): PublicKey {
    return this.marketInfo[Pair.key(coin, priceCurrency)].address;
  }

  async getTrades(coin?: Coin, priceCurrency?: Coin): Promise<Trade[]> {
    if (coin && priceCurrency) {
      const market = await this.getMarketFromAddress(
        this.getMarketAddress(coin, priceCurrency)
      );
      const rawTrades = await market.loadFills(this._connection);
      const ourTrades = rawTrades.filter(
        (element) => !element.eventFlags.maker
      );
      return this.parseRawTrades(ourTrades, coin, priceCurrency);
    }
    return Promise.all(
      this.markets.map((market) =>
        this.getTrades(market.coin, market.priceCurrency)
      )
    ).then((trades) =>
      trades.reduce((acc, curr) => {
        return [...acc, ...curr];
      })
    );
  }

  parseRawTrades(
    rawTrades: RawTrade[],
    coin: Coin,
    priceCurrency: Coin
  ): Trade[] {
    const parseTrade = (rawTrade: RawTrade): Trade => {
      // Add ms timestamp to fill id for uniqueness
      const timeSec = getUnixTs();
      const timeMs = Math.floor(timeSec * 1000);
      return {
        exchange: this.exchange,
        coin: coin,
        priceCurrency: priceCurrency,
        id: `${rawTrade.orderId.toString()}|${rawTrade.size}|${timeMs}`,
        orderId: rawTrade.orderId.toString(),
        price: rawTrade.price,
        quantity: rawTrade.size,
        time: timeSec,
        side: DirUtil.parse(rawTrade.side),
        info: {
          ...rawTrade.eventFlags,
          openOrdersSlot: rawTrade.openOrdersSlot,
          quantityReleased: rawTrade.nativeQuantityReleased.toString(),
          quantityPaid: rawTrade.nativeQuantityPaid.toString(),
          openOrders: rawTrade.openOrders.toBase58(),
        },
      };
    };
    return rawTrades.map((trade) => parseTrade(trade));
  }

  async getRestOrderBook(coin: Coin, priceCurrency: Coin): Promise<L2OrderBook> {
    const validAt = getUnixTs();
    const marketAddress: PublicKey = this.getMarketAddress(coin, priceCurrency);
    const market = await this.getMarketFromAddress(marketAddress);
    const bidsPromise = market.loadBids(this._connection);
    const asksPromise = market.loadAsks(this._connection);
    const rawBids = await bidsPromise;
    const rawAsks = await asksPromise;
    const receivedAt = getUnixTs();
    return {
      bids: Object.values(this.parseRawOrderBook(rawBids)),
      asks: Object.values(this.parseRawOrderBook(rawAsks)),
      market: new Pair(coin, priceCurrency),
      validAt,
      receivedAt,
    };
  }

  async getWsOrderBook(coin: Coin, priceCurrency: Coin): Promise<L2OrderBook> {
    const market = new Pair(coin, priceCurrency);
    const validAt = getUnixTs();
    await this.subscribeToOrderBookUpdates(market);
    const bids = this._wsOrderbooks[market.key()][DirUtil.buySell(Dir.B)];
    const asks = this._wsOrderbooks[market.key()][DirUtil.buySell(Dir.S)];
    const receivedAt = Math.min(bids.receivedAt, asks.receivedAt);
    return {
      bids: bids.orderbook,
      asks: asks.orderbook,
      market: new Pair(coin, priceCurrency),
      validAt,
      receivedAt,
    };
  }

  parseRawOrderBook(rawOrders: Orderbook): [number, number][] {
    const orders: [number, number][] = [];
    for (const [price, size] of rawOrders.getL2(100)) {
      orders.push([price, size]);
    }
    return orders;
  }

  async subscribeToOrderBookUpdates(market: Pair): Promise<void> {
    if (this._wsOrderbooksConnected.includes(market.key())) {
      return;
    }
    const serumMarket = await this.getMarketFromAddress(
      this.getMarketAddress(market.coin, market.priceCurrency)
    );
    const updateCallback = (side) => (
      accountInfoUpdate: AccountInfo<Buffer>,
      context: Context
    ) => {
      this._wsOrderbooks[market.key()][DirUtil.buySell(side)] = {
        orderbook: this.parseRawOrderBook(
          Orderbook.decode(serumMarket, accountInfoUpdate.data)
        ),
        receivedAt: getUnixTs(),
      };
    };
    const [bids, asks] = await Promise.all([
      serumMarket.loadBids(this._connection),
      serumMarket.loadAsks(this._connection),
    ]);
    this._wsOrderbooks[market.key()] = {
      buy: { orderbook: this.parseRawOrderBook(bids), receivedAt: getUnixTs() },
      sell: {
        orderbook: this.parseRawOrderBook(asks),
        receivedAt: getUnixTs(),
      },
    };
    this._wsConnection.onAccountChange(
      serumMarket.bidsAddress,
      updateCallback(Dir.B)
    );
    this._wsConnection.onAccountChange(
      serumMarket.asksAddress,
      updateCallback(Dir.S)
    );
    if (this._wsOrderbooksConnected.length == 0) {
      this._wsConnection.onSlotChange((slotInfo) => {});
    }
    this._wsOrderbooksConnected.push(market.key());
  }

  async awaitTransactionSignatureConfirmation(
    txid: string,
    timeout: number = DEFAULT_TIMEOUT
  ): Promise<string> {
    let done = false;
    const result: string = await new Promise((resolve, reject) => {
      (async () => {
        setTimeout(() => {
          if (done) {
            return;
          }
          done = true;
          const message = `awaitTransactionSignature timed out waiting for signature confirmation:\ntxid ${txid}`;
          logger.info(message);
          reject(message);
        }, timeout);
        try {
          this._connection.onSignature(txid, (result, context) => {
            logger.info(
              `awaitTransactionSignature signature confirmed via callback:\ntxid ${txid}\nresult ${JSON.stringify(
                result
              )}`
            );
            done = true;
            if (result.err) {
              reject(result.err);
            } else {
              resolve(txid);
            }
          });
        } catch (e) {
          done = true;
          logger.info(
            `awaitTransactionSignature encountered error setting up solana onSignature callback:\ntxid ${txid}\n${JSON.stringify(
              result
            )}`
          );
          reject(e);
        }
        while (!done) {
          (async () => {
            try {
              const startTime = getUnixTs();
              const signatureStatus = await this._connection.getSignatureStatuses(
                [txid]
              );
              logger.debug(
                `getSignatureStatuses took ${getUnixTs() - startTime} seconds`
              );
              const result = signatureStatus && signatureStatus.value[0];
              if (!done) {
                if (!result) {
                  // received null result
                  return;
                } else if (result.err) {
                  logger.log(
                    "debug",
                    `awaitTransactionSignature received error:\ntxid ${txid}\n${JSON.stringify(
                      result.err
                    )}`
                  );
                  done = true;
                  reject(JSON.stringify(result.err));
                } else if (!result.confirmations) {
                  // received update with no confirmations
                  return;
                } else {
                  logger.log(
                    "debug",
                    `awaitTransactionSignature received confirmation:\ntxid ${txid}\n${JSON.stringify(
                      result
                    )}`
                  );
                  done = true;
                  resolve(result?.toString());
                }
              }
            } catch (e) {
              if (!done) {
                logger.info(
                  `awaitTransactionsSignature encountered error:\ntxid ${txid}\n${JSON.stringify(
                    e
                  )}`
                );
                done = true;
                reject(e);
              }
            }
          })();
          await sleep(1000);
        }
      })();
    });
    done = true;
    return result;
  }

  async sendTransaction(
    transaction: Transaction,
    signers: Account[],
    transactionSignatureTimeout: number = DEFAULT_TIMEOUT,
    onError?: (err) => void,
  ): Promise<string> {
    const blockhash = await this.getCachedBlockhash();
    const rawTransaction = await signAndSerializeTransaction(
      this._connection,
      transaction,
      signers,
      blockhash
    );
    let done = false;
    const startTime = getUnixTs();
    let retries = 0;
    const txid = await this._connection.sendRawTransaction(rawTransaction, {
      skipPreflight: true,
    });
    logger.info(`Started sending transaction for: ${txid}`);
    const awaitSignaturePromise = this.awaitTransactionSignatureConfirmation(
      txid,
      transactionSignatureTimeout
    )
      .then((res) => {
        done = true;
      })
      .catch((e) => {
        done = true;
        if (onError) {
          onError(e);
        } else {
          logger.info(
            `transaction failed with error:\ntxid ${txid}\nerror ${e}`
          );
        }
        throw e;
      });
    while (!done && getUnixTs() - startTime < DEFAULT_TIMEOUT) {
      await sleep(5000);
      if (retries < 2) {
        this._connection.sendRawTransaction(rawTransaction, {
          skipPreflight: true,
        });
        retries += 1;
      }
    }
    await awaitSignaturePromise;
    return txid;
  }

  async getCachedBlockhash(): Promise<Blockhash> {
    const updateBlockhashCache = async () => {
      const now = getUnixTs();
      await this._connection.getRecentBlockhash().then((res) => {
        this._blockhashCache = {
          blockhash: res.blockhash,
          fetchedAt: now,
        };
      });
    };
    if (getUnixTs() - this._blockhashCache.fetchedAt > BLOCKHASH_CACHE_TIME) {
      await updateBlockhashCache();
    } else if (
      getUnixTs() - this._blockhashCache.fetchedAt >
      BLOCKHASH_CACHE_TIME / 2
    ) {
      updateBlockhashCache();
    }
    return this._blockhashCache.blockhash;
  }

  async placeOrder(
    side: Dir,
    coin: Coin,
    priceCurrency: Coin,
    quantity: number,
    price: number,
    orderType: OrderType = OrderType.limit,
    options: {[k: string]: unknown} = {}
  ): Promise<string> {
    const clientId =
      typeof options.clientId === "string" ||
      typeof options.clientId === "number"
        ? new BN(options.clientId)
        : makeClientOrderId();
    const { transaction, signers } = await this.makeOrderTransaction(
      clientId,
      side,
      coin,
      priceCurrency,
      quantity,
      price,
      orderType,
      options
    );
    const onError = (e) => {
      logger.info(
        `placeOrder encountered error when creating transaction:\norderId ${clientId}\nerror ${e}`
      );
    };
    const txid = await this.sendTransaction(
      transaction,
      signers,
      5000,
      onError
    );
    logger.info(
      `makeOrder completed transaction for:\n${clientId.toString()}\n${txid}`
    );
    return clientId.toString();
  }

  async makeOrderTransaction(
    clientId: BN,
    side: Dir,
    coin: Coin,
    priceCurrency: Coin,
    quantity: number,
    price: number,
    orderType: OrderType = OrderType.limit,
    options: {[k: string]: unknown} = {}
  ): Promise<{ transaction: Transaction; signers: Account[] }> {
    logger.info(
      `Order parameters: ${side}, ${coin}, ${priceCurrency}, ${quantity}, ${price}, ${orderType}`
    );
    const owner = new Account(this._privateKey);
    let payer;
    if (coin === "SOL" && side === Dir.S) {
      payer = this._publicKey;
    } else if (side === Dir.S) {
      payer = (await this.getTokenAccounts(coin, 600))[0].pubkey;
    } else {
      payer = (await this.getTokenAccounts(priceCurrency, 600))[0].pubkey;
    }

    const [market, openOrdersAccount] = await Promise.all([
      this.getMarketFromAddress(
        this.getMarketAddress(coin, priceCurrency)
      ),
      this._getOpenOrdersAccountToUse(coin, priceCurrency),
    ]);

    const params: OrderParams = {
      owner,
      payer,
      side: DirUtil.buySell(side),
      price,
      size: quantity,
      orderType,
      clientId,
      openOrdersAddressKey: openOrdersAccount,
    };
    const transaction = new Transaction();
    transaction.add(market.makeMatchOrdersTransaction(15));
    const {
      transaction: placeOrderTransaction,
      signers,
    } = await market.makePlaceOrderTransaction(
      this._connection,
      params,
      600000
    );
    transaction.add(placeOrderTransaction);
    transaction.add(market.makeMatchOrdersTransaction(15));
    return {
      transaction,
      signers,
    };
  }

  async _getOpenOrdersAccountToUse(
    coin: Coin,
    priceCurrency: Coin
  ): Promise<PublicKey> {
    let accountsForMarket = await this.getOpenOrdersAccountsForMarket(
      coin,
      priceCurrency
    );
    if (accountsForMarket.length === 0) {
      // try again without caching in case an account was recently created
      accountsForMarket = await this.getOpenOrdersAccountsForMarket(
        coin,
        priceCurrency,
        0
      );
    }
    if (accountsForMarket.length === 0) {
      const serumMarket = await this.getMarketFromAddress(
        this.getMarketAddress(coin, priceCurrency)
      );
      const newOpenOrdersAccount = new Account();
      await OpenOrders.makeCreateAccountTransaction(
        this._connection,
        serumMarket.address,
        this._publicKey,
        newOpenOrdersAccount.publicKey,
        this.marketInfo[new Pair(coin, priceCurrency).key()].programId
      );
      return newOpenOrdersAccount.publicKey;
    }
    return accountsForMarket.sort(this.compareOpenOrdersAccounts)[0].publicKey;
  }

  compareOpenOrdersAccounts(a: OpenOrders, b: OpenOrders): number {
    const aAddress = a.address.toBase58();
    const bAddress = b.address.toBase58();
    if (aAddress < bAddress) {
      return -1;
    } else if (aAddress === bAddress) {
      return 0;
    } else {
      return 1;
    }
  }

  async getOpenOrdersAccountsForMarket(
    coin: Coin,
    priceCurrency: Coin,
    cacheDurationSec = 60
  ): Promise<OpenOrders[]> {
    const market = await this.getMarketFromAddress(
      this.getMarketAddress(coin, priceCurrency)
    );
    return market.findOpenOrdersAccountsForOwner(
      this._connection,
      this._publicKey,
      cacheDurationSec * 1000
    );
  }

  async getTokenAccounts(
    coin?: Coin,
    cacheDurationSecs = 0
  ): Promise<TokenAccountInfo[]> {
    const now = getUnixTs();
    if (
      coin &&
      coin in this._tokenAccountsCache &&
      now - this._tokenAccountsCache[coin].ts < cacheDurationSecs
    ) {
      return this._tokenAccountsCache[coin].accounts;
    }
    const tokenAccounts = await this._connection.getTokenAccountsByOwner(
      this._publicKey,
      {
        programId: TokenInstructions.TOKEN_PROGRAM_ID,
      }
    );

    const cache: {
      [coin: string]: { accounts: TokenAccountInfo[]; ts: number };
    } = {};
    for (const account of tokenAccounts.value) {
      const parsedTokenAccount = {
        pubkey: account.pubkey,
        ...parseTokenAccountData(account.account.data),
      };
      const coin = MINT_COINS[parsedTokenAccount.mint.toBase58()];
      if (!coin) {
        continue;
      }
      if (!(coin in cache)) {
        cache[coin] = { accounts: [], ts: now };
      }
      cache[coin].accounts.push(parsedTokenAccount);
    }
    this._tokenAccountsCache = cache;
    if (!coin) {
      return Object.values(cache)
        .map((a) => a.accounts)
        .reduce((a, c) => [...a, ...c]);
    }
    return cache[coin].accounts;
  }
}
