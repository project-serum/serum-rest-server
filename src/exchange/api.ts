import {
  Account,
  AccountInfo,
  Blockhash,
  Connection,
  Context,
  LAMPORTS_PER_SOL,
  PublicKey,
  RpcResponseAndContext,
  Transaction,
} from "@solana/web3.js";
import {
  Coin,
  Dir,
  Exchange,
  Fill,
  L2OrderBook,
  MarketInfo,
  Order,
  OrderInfo,
  OrderType,
  OwnOrders,
  Pair,
  RawTrade,
  TimestampedL2Levels,
  TokenAccountInfo,
  Trade,
} from "./types";
import * as config from "../config";
import { COIN_MINTS, EXCHANGE_ENABLED_MARKETS, MINT_COINS } from "./config";
import {
  DirUtil,
  divideBnToNumber,
  getKeys,
  getUnixTs,
  logger,
  sleep,
} from "../utils";
import assert from "assert";
import {
  Market,
  OpenOrders,
  Orderbook,
  TokenInstructions,
} from "@project-serum/serum";
import { Order as SerumOrder } from "@project-serum/serum/lib/market";
import { Buffer } from "buffer";
import BN from "bn.js";
import {
  getTokenMultiplierFromDecimals,
  makeClientOrderId,
  parseMintData,
  parseTokenAccountData,
} from "./utils";
import { OrderParams } from "@project-serum/serum/lib/market";
import { BLOCKHASH_CACHE_TIME, DEFAULT_TIMEOUT } from "../config";
import {
  createRpcRequest,
  GetMultipleAccountsAndContextRpcResult,
  RpcRequest,
  signAndSerializeTransaction,
} from "./solana";
import { WRAPPED_SOL_MINT } from "@project-serum/serum/lib/token-instructions";
import { parse as urlParse } from "url";

export class SerumApi {
  static readonly exchange: Exchange = "serum";
  static url = config.SOLANA_URL;
  readonly exchange: Exchange;
  readonly marketInfo: { [market: string]: MarketInfo };
  readonly markets: Pair[];
  readonly addressMarkets: { [address: string]: Pair };
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
  private _ownOrdersByMarket: {
    [market: string]: {
      orders: OwnOrders<Order<OrderInfo>>;
      fetchedAt: number;
    };
  };
  private _openOrdersAccountCache: {
    [market: string]: {
      accounts: OpenOrders[];
      ts: number;
    };
  };
  private _rpcRequest: RpcRequest;
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
    this._ownOrdersByMarket = {};
    this._openOrdersAccountCache = {};
    this._rpcRequest = createRpcRequest(urlParse(url).href);
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

  async getRestOrderBook(
    coin: Coin,
    priceCurrency: Coin
  ): Promise<L2OrderBook> {
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
    onError?: (err) => void
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
    options: { [k: string]: unknown } = {}
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
    options: { [k: string]: unknown } = {}
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
      this.getMarketFromAddress(this.getMarketAddress(coin, priceCurrency)),
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

  async cancelByClientId(
    orderId: string,
    coin: Coin,
    priceCurrency: Coin
  ): Promise<void> {
    const { transaction, signers } = await this.makeCancelByClientIdTransaction(
      orderId,
      coin,
      priceCurrency
    );
    const txid = await this.sendTransaction(
      transaction,
      signers,
      DEFAULT_TIMEOUT,
      () => {}
    );
    logger.debug(
      `finished sending cancel transaction:\n${orderId}\ntxid ${txid}`
    );
  }

  async makeCancelByClientIdTransaction(
    orderId: string,
    coin: Coin,
    priceCurrency: Coin
  ): Promise<{ transaction: Transaction; signers: Account[] }> {
    const accountsForMarket = await this.getOpenOrdersAccountsForMarket(
      coin,
      priceCurrency
    );
    if (!accountsForMarket) {
      throw Error(
        `Could not find an open order accounts for market ${coin}/${priceCurrency}`
      );
    }

    const m = new Pair(coin, priceCurrency);
    const order = this.getOrderFromOwnOrdersCache(orderId, m);
    let account = accountsForMarket.find(
      (account) => account.address.toBase58() === order?.info.openOrdersAddress
    );
    if (!order || !account) {
      this.getOwnOrders(coin, priceCurrency); // update the cache in the background
      // Assume we sent with lowest sort open orders account
      account = accountsForMarket.sort(this.compareOpenOrdersAccounts)[0];
      logger.debug(
        `Did not find order (${orderId}) in open order accounts. 
        Using ${account.publicKey.toBase58()} as account.`
      );
    }
    logger.info(
      `Cancelling ${orderId} using account ${account.publicKey.toBase58()}`
    );

    const market = await this.getMarketFromAddress(
      this.getMarketAddress(coin, priceCurrency)
    );
    const txn = await market.makeCancelOrderByClientIdTransaction(
      this._connection,
      this._publicKey,
      account.address,
      new BN(orderId)
    );
    txn.add(market.makeMatchOrdersTransaction(5));
    const signers = [new Account(this._privateKey)];
    return {
      transaction: txn,
      signers,
    };
  }

  async cancelByStandardOrderId(
    orderId: string,
    coin: Coin,
    priceCurrency: Coin
  ): Promise<void> {
    const {
      transaction,
      signers,
    } = await this.makeCancelByStandardIdTransaction(
      orderId,
      coin,
      priceCurrency
    );
    const txid = await this._connection.sendTransaction(transaction, signers, {
      skipPreflight: true,
    });
    await this.awaitTransactionSignatureConfirmation(txid);
  }

  async makeCancelByStandardIdTransaction(
    orderId: string,
    coin: Coin,
    priceCurrency: Coin
  ): Promise<{ transaction: Transaction; signers: Account[] }> {
    const market = new Pair(coin, priceCurrency);
    let order = this.getOrderFromOwnOrdersCache(orderId, market);
    if (!order) {
      this.getOwnOrders(coin, priceCurrency);
      order = this.getOrderFromOwnOrdersCache(orderId, market);
      if (!order) {
        throw Error("Could not find order for cancellation.");
      }
    }
    logger.info(
      `Cancelling ${orderId} ${coin} ${priceCurrency} using orderId ${order.info.orderId}`
    );

    const serumMarket = await this.getMarketFromAddress(
      this.getMarketAddress(coin, priceCurrency)
    );
    const transaction = await serumMarket.makeCancelOrderTransaction(
      this._connection,
      this._publicKey,
      order.info.toSerumOrder()
    );
    transaction.add(serumMarket.makeMatchOrdersTransaction(5));
    const signers = [new Account(this._privateKey)];
    return {
      transaction,
      signers,
    };
  }

  getOrderFromOwnOrdersCache(
    orderId: string,
    market: Pair
  ): Order<OrderInfo> | null {
    const cachedOwnOrders = this._ownOrdersByMarket[market.key()]?.orders || {};
    let usableOrderId;
    if (orderId in cachedOwnOrders) {
      // use orderId to cancel
      usableOrderId = orderId;
    } else if (
      Object.values(cachedOwnOrders)
        .map((order) => order.info.clientId)
        .includes(orderId)
    ) {
      // orderid is client id,
      usableOrderId = Object.values(cachedOwnOrders).filter(
        (order) => order.info.clientId === orderId
      )[0].info.orderId;
    } else {
      return null;
    }
    return cachedOwnOrders[usableOrderId];
  }

  async getOwnOrders(
    coin?: Coin,
    priceCurrency?: Coin
  ): Promise<OwnOrders<Order<OrderInfo>>> {
    if (coin && priceCurrency) {
      const market = await this.getMarketFromAddress(
        this.getMarketAddress(coin, priceCurrency)
      );
      const fetchedAt = getUnixTs();
      const [bids, asks] = await Promise.all([
        market.loadBids(this._connection),
        market.loadAsks(this._connection),
      ]);
      const openOrdersAccounts = await this.getOpenOrdersAccountsForMarket(
        coin,
        priceCurrency
      );
      const rawOrders = await market.filterForOpenOrders(
        bids,
        asks,
        openOrdersAccounts
      );
      const orders = this.parseRawOrders(rawOrders, coin, priceCurrency);

      this._ownOrdersByMarket[new Pair(coin, priceCurrency).key()] = {
        orders,
        fetchedAt,
      };
      return orders;
    }
    return Promise.all(
      this.markets.map((market) =>
        this.getOwnOrders(market.coin, market.priceCurrency)
      )
    ).then((orders) =>
      orders.reduce((acc, curr) => {
        return { ...acc, ...curr };
      })
    );
  }

  parseRawOrders(
    rawOrders: SerumOrder[],
    coin: Coin,
    priceCurrency: Coin
  ): OwnOrders<Order<OrderInfo>> {
    return Object.fromEntries(
      rawOrders.map((order) => [
        order.orderId,
        {
          exchange: this.exchange,
          coin: coin,
          priceCurrency: priceCurrency,
          side: DirUtil.parse(order.side),
          price: order.price,
          quantity: order.size,
          info: new OrderInfo(
            order.orderId.toString(),
            order.openOrdersAddress.toBase58(),
            order.openOrdersSlot,
            order.price,
            order.priceLots.toString(),
            order.size,
            order.sizeLots.toString(),
            order.side,
            order.clientId ? order.clientId.toString() : "",
            order.feeTier
          ),
        },
      ])
    );
  }

  async getFills(coin?: Coin, priceCurrency?: Coin): Promise<Fill[]> {
    if (coin && priceCurrency) {
      const market = await this.getMarketFromAddress(
        this.getMarketAddress(coin, priceCurrency)
      );
      const rawFills = await market.loadFills(this._connection);
      const openOrdersAccount = (
        await this.getOpenOrdersAccountsForMarket(coin, priceCurrency)
      ).map((account) => account.address.toBase58());
      const ourFills = rawFills.filter((rawFill) =>
        openOrdersAccount.includes(rawFill.openOrders.toBase58())
      );
      return this.parseRawFills(ourFills, coin, priceCurrency);
    }
    return Promise.all(
      this.markets.map((market) =>
        this.getFills(market.coin, market.priceCurrency)
      )
    ).then((fills) => fills.reduce((acc, curr) => [...acc, ...curr]));
  }

  parseRawFills(rawFills: RawTrade[], coin: Coin, priceCurrency: Coin): Fill[] {
    const time = getUnixTs();
    const parseFill = (rawFill): Fill => {
      return {
        exchange: this.exchange,
        coin: coin,
        priceCurrency: priceCurrency,
        side: DirUtil.parse(rawFill.side),
        price: parseFloat(rawFill.price),
        quantity: parseFloat(rawFill.size),
        orderId: rawFill.orderId.toString(),
        fee: rawFill.feeCost,
        time: time,
        info: {
          ...rawFill.eventFlags,
          openOrdersSlot: rawFill.openOrdersSlot,
          quantityReleased: rawFill.nativeQuantityReleased.toString(),
          quantityPaid: rawFill.nativeQuantityPaid.toString(),
          openOrders: rawFill.openOrders.toBase58(),
          clientId: rawFill.clientOrderId.toString(),
          feeOrRebate: rawFill.nativeFeeOrRebate.toString(),
        },
      };
    };
    return rawFills.map((rawFill) => parseFill(rawFill));
  }

  async getBalances(): Promise<{
    [key: string]: {
      mintKey: string;
      coin: string;
      total: number;
      free: number;
    };
  }> {
    const [tokenAccounts, openOrdersAccounts] = await Promise.all([
      this.getTokenAccounts(undefined, 60),
      this.getOpenOrdersAccounts(undefined, 60),
    ]);

    const accountsByCoin: {
      [coin: string]: {
        mint: PublicKey;
        tokenAccounts: PublicKey[];
        openOrdersAccounts: { [key: string]: Pair };
      };
    } = {};
    for (const [marketKey, marketOpenOrdersAccounts] of Object.entries(
      openOrdersAccounts
    )) {
      for (const openOrdersAccount of marketOpenOrdersAccounts) {
        const market = Pair.fromKey(marketKey);
        const key = openOrdersAccount.publicKey.toBase58();
        if (!(market.coin in accountsByCoin)) {
          accountsByCoin[market.coin] = {
            mint: new PublicKey(COIN_MINTS[market.coin]),
            tokenAccounts: [],
            openOrdersAccounts: {},
          };
        }
        if (!(market.priceCurrency in accountsByCoin)) {
          accountsByCoin[market.priceCurrency] = {
            mint: new PublicKey(COIN_MINTS[market.priceCurrency]),
            tokenAccounts: [],
            openOrdersAccounts: {},
          };
        }
        accountsByCoin[market.coin].openOrdersAccounts[key] = market;
        accountsByCoin[market.priceCurrency].openOrdersAccounts[key] = market;
      }
    }
    for (const tokenAccount of tokenAccounts) {
      const coin = MINT_COINS[tokenAccount.mint.toBase58()];
      if (!(coin in accountsByCoin)) {
        accountsByCoin[coin] = {
          mint: tokenAccount.mint,
          tokenAccounts: [],
          openOrdersAccounts: {},
        };
      }
      accountsByCoin[coin].tokenAccounts.push(tokenAccount.pubkey);
    }
    if (!("SOL" in accountsByCoin)) {
      accountsByCoin["SOL"] = {
        mint: WRAPPED_SOL_MINT,
        tokenAccounts: [],
        openOrdersAccounts: {},
      };
    }
    accountsByCoin["SOL"].tokenAccounts.push(this._publicKey);
    accountsByCoin["SOL"].mint = TokenInstructions.WRAPPED_SOL_MINT;

    const coins = Object.keys(accountsByCoin);
    const accountContents = await Promise.all(
      coins.map((coin) =>
        this.getMultipleSolanaAccounts([
          accountsByCoin[coin].mint,
          ...accountsByCoin[coin].tokenAccounts,
          ...Object.keys(accountsByCoin[coin].openOrdersAccounts).map(
            (stringKey) => new PublicKey(stringKey)
          ),
        ])
      )
    );
    const accountContentsByCoin = Object.fromEntries(
      coins.map((coin, i) => [coin, accountContents[i]])
    );
    const balances = {};
    Object.entries(accountContentsByCoin).forEach(([coin, accountsInfo]) => {
      const mintValue =
        accountsInfo.value[accountsByCoin[coin].mint.toBase58()];
      if (mintValue === null) {
        return;
      }
      const mint = parseMintData(mintValue.data);
      const ooFree = {};
      const ooTotal = {};
      for (const openOrdersAccountKey of Object.keys(
        accountsByCoin[coin].openOrdersAccounts
      )) {
        const accountValue = accountsInfo.value[openOrdersAccountKey];
        if (accountValue === null) {
          continue;
        }
        const market =
          accountsByCoin[coin].openOrdersAccounts[openOrdersAccountKey];
        const parsedAccount = OpenOrders.fromAccountInfo(
          new PublicKey(openOrdersAccountKey),
          accountValue,
          this.marketInfo[market.key()].programId
        );
        if (coin == market.coin) {
          ooFree[coin] = ooFree[coin]
            ? parsedAccount.baseTokenFree.add(ooFree[coin])
            : parsedAccount.baseTokenFree;
          ooTotal[coin] = ooTotal[coin]
            ? parsedAccount.baseTokenTotal.add(ooTotal[coin])
            : parsedAccount.baseTokenTotal;
        } else {
          ooFree[coin] = ooFree[coin]
            ? parsedAccount.quoteTokenFree.add(ooFree[coin])
            : parsedAccount.quoteTokenFree;
          ooTotal[coin] = ooTotal[coin]
            ? parsedAccount.quoteTokenTotal.add(ooTotal[coin])
            : parsedAccount.quoteTokenTotal;
        }
      }
      let total = 0;
      let free = 0;
      for (const tokenAccountKey of accountsByCoin[coin].tokenAccounts) {
        const accountValue = accountsInfo.value[tokenAccountKey.toBase58()];
        if (accountValue === null) {
          continue;
        }
        if (coin === "SOL") {
          total += (accountValue.lamports ?? 0) / LAMPORTS_PER_SOL;
          free += total;
        } else {
          const parsedAccount = parseTokenAccountData(accountValue.data);
          const additionalAmount = divideBnToNumber(
            new BN(parsedAccount.amount),
            getTokenMultiplierFromDecimals(mint.decimals)
          );
          total += additionalAmount;
          free += additionalAmount;
        }
      }
      if (ooFree[coin]) {
        free += divideBnToNumber(
          ooFree[coin],
          getTokenMultiplierFromDecimals(mint.decimals)
        );
      }
      if (ooTotal[coin]) {
        total += divideBnToNumber(
          ooTotal[coin],
          getTokenMultiplierFromDecimals(mint.decimals)
        );
      }
      balances[coin] = {
        mintKey: accountsByCoin[coin].mint.toBase58(),
        coin,
        total,
        free,
      };
    });
    return balances;
  }

  async getOpenOrdersAccounts(
    market?: Pair,
    cacheDurationSec = 2
  ): Promise<{ [market: string]: OpenOrders[] }> {
    let serumMarkets: Market[];
    if (market) {
      serumMarkets = [
        await this.getMarketFromAddress(
          this.getMarketAddress(market.coin, market.priceCurrency)
        ),
      ];
    } else {
      serumMarkets = await Promise.all(
        this.markets.map((market) =>
          this.getMarketFromAddress(
            this.getMarketAddress(market.coin, market.priceCurrency)
          )
        )
      );
    }

    const now = getUnixTs();
    const openOrdersAccounts: {
      [market: string]: OpenOrders[];
    } = await Promise.all(
      serumMarkets.map((serumMarket) =>
        serumMarket.findOpenOrdersAccountsForOwner(
          this._connection,
          this._publicKey,
          cacheDurationSec * 1000
        )
      )
    )
      .then((openOrdersAccounts) =>
        openOrdersAccounts.reduce((r, a) => r.concat(a), [])
      )
      .then((openOrdersAccounts) => {
        return openOrdersAccounts.reduce((rv, account) => {
          const market = this.addressMarkets[account.market.toBase58()].key();
          (rv[market] = rv[market] || []).push(account);
          return rv;
        }, {});
      });
    for (const [marketKey, openOrders] of Object.entries(openOrdersAccounts)) {
      this._openOrdersAccountCache[marketKey] = {
        accounts: openOrders,
        ts: now,
      };
    }
    return openOrdersAccounts;
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

  async getMultipleSolanaAccounts(
    publicKeys: PublicKey[]
  ): Promise<
    RpcResponseAndContext<{ [key: string]: AccountInfo<Buffer> | null }>
  > {
    const args = [
      publicKeys.map((k) => k.toBase58()),
      { commitment: "recent" },
    ];
    const unsafeRes = await this._rpcRequest("getMultipleAccounts", args);
    const res = GetMultipleAccountsAndContextRpcResult(unsafeRes);
    if (res.error) {
      throw new Error(
        "failed to get info about accounts " +
          publicKeys.map((k) => k.toBase58()).join(", ") +
          ": " +
          res.error.message
      );
    }
    assert(typeof res.result !== "undefined");
    const accounts: Array<{
      executable: any;
      owner: PublicKey;
      lamports: any;
      data: Buffer;
    } | null> = [];
    for (const account of res.result.value) {
      let value: {
        executable: any;
        owner: PublicKey;
        lamports: any;
        data: Buffer;
      } | null = null;
      if (res.result.value) {
        const { executable, owner, lamports, data } = account;
        assert(data[1] === "base64");
        value = {
          executable,
          owner: new PublicKey(owner),
          lamports,
          data: Buffer.from(data[0], "base64"),
        };
      }
      accounts.push(value);
    }
    return {
      context: {
        slot: res.result.context.slot,
      },
      value: Object.fromEntries(
        accounts.map((account, i) => [publicKeys[i].toBase58(), account])
      ),
    };
  }

  async settleFunds(coin: Coin, priceCurrency: Coin): Promise<void> {
    const market = await this.getMarketFromAddress(
      this.getMarketAddress(coin, priceCurrency)
    );
    const promises: Promise<string>[] = [];
    for (const openOrders of await this.getOpenOrdersAccountsForMarket(
      coin,
      priceCurrency
    )) {
      if (
        openOrders.baseTokenFree.gt(new BN("0")) ||
        openOrders.quoteTokenFree.gt(new BN("0"))
      ) {
        // spl-token accounts to which to send the proceeds from trades
        let baseTokenAccount;
        let quoteTokenAccount;
        if (coin == "SOL") {
          const priceCurrencyTokenAccount = await this.getTokenAccounts(
            priceCurrency,
            60
          );
          baseTokenAccount = this._publicKey;
          quoteTokenAccount = priceCurrencyTokenAccount[0].pubkey;
        } else {
          const [
            coinTokenAccount,
            priceCurrencyTokenAccount,
          ] = await Promise.all([
            this.getTokenAccounts(coin, 60),
            this.getTokenAccounts(priceCurrency, 60),
          ]);
          baseTokenAccount = coinTokenAccount[0].pubkey;
          quoteTokenAccount = priceCurrencyTokenAccount[0].pubkey;
        }
        logger.debug(`Settling funds on ${coin}/${priceCurrency}`);
        promises.push(
          market
            .settleFunds(
              this._connection,
              new Account(this._privateKey),
              openOrders,
              baseTokenAccount,
              quoteTokenAccount
            )
            .then((txid) => this.awaitTransactionSignatureConfirmation(txid))
        );
      }
    }
    await Promise.all(promises);
  }
}
