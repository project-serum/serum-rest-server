import express from "express";
import expressAsyncHandler from "express-async-handler";
import { DirUtil, logger } from "./utils";
import { SerumApi } from "./exchange";
import { Coin, OrderType } from "./exchange/types";

const router = express.Router();
let api: SerumApi;

router.get("/", (req, res, next) => {
  res.send("Hello from the Serum rest server!");
});

router.use(
  "/",
  expressAsyncHandler(async (req, res, next) => {
    if (!api) {
      logger.debug("Creating api.");
      api = await SerumApi.create();
    }
    next();
  })
);

router.get(
  "/market_info",
  expressAsyncHandler(async (req, res, next) => {
    logger.info("Received request to get market_info");
    api
      .getMarketInfo()
      .then((marketInfo) => res.send({ status: "ok", data: marketInfo }))
      .catch((err) => next(err));
  })
);

router.get(
  "/orderbook/:coin-:quote",
  expressAsyncHandler(async (req, res, next) => {
    logger.info("Received request to api getOrderbook");
    api
      .getWsOrderBook(req.params.coin, req.params.quote)
      .then((orderBook) => res.send({ status: "ok", data: orderBook }))
      .catch((err) => next(err));
  })
);

router.get(
  "/trades/:coin-:quote",
  expressAsyncHandler(async (req, res, next) => {
    logger.info("Received request to api getTrades");
    api
      .getTrades(req.params.coin, req.params.quote)
      .then((trades) => res.send({ status: "ok", data: trades }))
      .catch((err) => {
        logger.info(err);
        next(err);
      });
  })
);

router.post(
  "/place_order",
  expressAsyncHandler(async (req, res, next) => {
    logger.info(`Order parameters ${JSON.stringify(req.body)}`);
    api
      .placeOrder(
        DirUtil.parse(req.body.side),
        req.body.coin,
        req.body.priceCurrency,
        req.body.quantity,
        req.body.price,
        OrderType[req.body.orderType],
        {
          clientId: req.body.clientId,
          orderEdge: req.body.orderEdge,
        }
      )
      .then((id) => res.send({ status: "ok", data: { id: id } }))
      .catch((err) => {
        logger.log("error", `${req.params.exchange} make_order error: ${err}`);
        try {
          const body = {
            status: "error",
            data: {
              errorType: err.name,
              errorMessage: err.message || JSON.stringify(err),
              stack: (err.stack && err.stack.toString()) || JSON.stringify(err),
            },
          };
          res.send(body);
        } catch (e) {
          try {
            const body = {
              status: "error",
              data: { errorMessage: err, name: undefined, stack: undefined },
            };
            res.send(body);
          } catch (f) {
            next(err);
          }
        }
      });
  })
);

router.post(
  "/cancel",
  expressAsyncHandler(async (req, res, next) => {
    const coin = req.body.coin;
    const priceCurrency = req.body.priceCurrency;
    const orderId = req.body.orderId;
    const clientOrderId = req.body.clientOrderId;

    if (!coin) {
      const body = {
        status: "error",
        data: {
          errorMessage: "Coin parameter missing from cancel request",
        },
      };
      res.send(body);
    } else if (!priceCurrency) {
      const body = {
        status: "error",
        data: {
          errorMessage: "Price currency parameter missing from cancel request",
        },
      };
      res.send(body);
    } else if (!orderId && !clientOrderId) {
      const body = {
        status: "error",
        data: {
          errorMessage:
            "Order id and client order id missing from cancel request",
        },
      };
      res.send(body);
    }

    let cancelFn: (
      orderId: string,
      coin: Coin,
      priceCurrency: Coin
    ) => Promise<void>;
    if (clientOrderId) {
      cancelFn = api.cancelByClientId;
    } else {
      cancelFn = api.cancelByStandardOrderId;
    }
    cancelFn(req.params.orderId, req.params.coin, req.params.priceCurrency)
      .then((result) => res.send({ status: "ok", data: {} }))
      .catch((err) => {
        logger.error(
          `${req.params.coin}/${req.params.priceCurrency} cancel 
          ${req.params.orderId} received error ${JSON.stringify(err)}`
        );
        try {
          const body = {
            status: "error",
            data: {
              errorType: err.name,
              errorMessage: err.message || JSON.stringify(err),
              stack: (err.stack && err.stack.toString()) || JSON.stringify(err),
            },
          };
          res.send(body);
        } catch (e) {
          try {
            const body = {
              status: "error",
              data: { errorMessage: err, name: undefined, stack: undefined },
            };
            res.send(body);
          } catch (f) {
            next(err);
          }
        }
      });
  })
);

router.get(
  "/own_orders/:coin-:quote",
  expressAsyncHandler(async (req, res, next) => {
    api
      .getOwnOrders(req.params.coin, req.params.priceCurrency)
      .then((orders) => res.send({ status: "ok", data: { orders } }))
      .catch((err) => {
        logger.log(
          "error",
          `Call to own_orders encountered error ${err.name}: \n ${err.stack}`
        );
        res.send({
          status: "error",
          data: {
            errorType: err.name,
            errorMessage: err.message,
            stack: err.stack.toString(),
          },
        });
      });
  })
);

router.get(
  "/fills/:coin-:quote",
  expressAsyncHandler(async (req, res, next) => {
    if ("coin" in req.query && "priceCurrency" in req.query) {
      api
        .getFills(req.params.coin, req.params.priceCurrency)
        .then((fills) => res.send({ status: "ok", data: fills }))
        .catch((err) => next(err));
    } else {
      api
        .getFills()
        .then((fills) => res.send({ status: "ok", data: fills }))
        .catch((err) => next(err));
    }
  })
);

router.get(
  "/balances",
  expressAsyncHandler(async (req, res, next) => {
    api
      .getBalances()
      .then((balances) => res.send({ status: "ok", data: balances }))
      .catch((err) => next(err));
  })
);

router.post(
  "/settle",
  expressAsyncHandler(async (req, res, next) => {
    api
      .settleFunds(req.body.coin, req.body.priceCurrency)
      .then((_) => res.send({ status: "ok", data: {} }))
      .catch((err) => next(err));
  })
);

export { router as default };
