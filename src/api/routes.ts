import express from "express";
import expressAsyncHandler from "express-async-handler";
import { DirUtil, logger } from "../utils";
import { SerumApi } from "../exchange";
import { Coin, OrderType } from "../exchange/types";
import { sendErrorResponse, sendSuccessfulResponse } from "./utils";

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
      .then((marketInfo) => sendSuccessfulResponse(res, marketInfo))
      .catch((err) => {
        logger.log(
          "error",
          `Call to getWsOrderBook encountered error ${err.name}: \n ${err.stack}`
        );
        sendErrorResponse(res, err.toString());
      });
  })
);

router.get(
  "/orderbook/:coin-:quote",
  expressAsyncHandler(async (req, res, next) => {
    logger.info("Received request to api getOrderbook");
    api
      .getWsOrderBook(req.params.coin, req.params.quote)
      .then((orderBook) => sendSuccessfulResponse(res, orderBook))
      .catch((err) => {
        logger.log(
          "error",
          `Call to getWsOrderBook encountered error ${err.name}: \n ${err.stack}`
        );
        sendErrorResponse(res, err.toString());
      });
  })
);

router.get(
  "/trades/:coin-:quote",
  expressAsyncHandler(async (req, res, next) => {
    logger.info(
      `Received request to api getTrades. Coin: ${req.params.coin}, Price Currency: ${req.params.quote}`
    );
    api
      .getTrades(req.params.coin, req.params.quote)
      .then((trades) => sendSuccessfulResponse(res, trades))
      .catch((err) => {
        logger.log(
          "error",
          `Call to getTrades encountered error ${err.name}: \n ${err.stack}`
        );
        sendErrorResponse(res, err.toString());
      });
  })
);

router.get(
  "/own_orders/:coin-:quote",
  expressAsyncHandler(async (req, res, next) => {
    api
      .getOwnOrders(req.params.coin, req.params.priceCurrency)
      .then((orders) => sendSuccessfulResponse(res, { orders }))
      .catch((err) => {
        logger.log(
          "error",
          `Call to getOwnOrders encountered error ${err.name}: \n ${err.stack}`
        );
        sendErrorResponse(res, err.toString());
      });
  })
);

router.get(
  "/fills/:coin-:quote",
  expressAsyncHandler(async (req, res, next) => {
    api
      .getFills(req.params.coin, req.params.priceCurrency)
      .then((fills) => sendSuccessfulResponse(res, fills))
      .catch((err) => {
        logger.log(
          "error",
          `Call to getFills encountered error ${err.name}: \n ${err.stack}`
        );
        sendErrorResponse(res, err.toString());
      });
  })
);

router.get(
  "/balances",
  expressAsyncHandler(async (req, res, next) => {
    api
      .getBalances()
      .then((balances) => sendSuccessfulResponse(res, balances))
      .catch((err) => {
        logger.log(
          "error",
          `Call to getBalances encountered error ${err.name}: \n ${err.stack}`
        );
        sendErrorResponse(res, err.toString());
      });
  })
);

router.post(
  "/place_order",
  expressAsyncHandler(async (req, res, next) => {
    logger.info(
      `Received request to api placeOrder. Order parameters ${JSON.stringify(
        req.body
      )}`
    );
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
      .then((id) => sendSuccessfulResponse(res, { id: id }))
      .catch((err) => {
        logger.log("error", `${req.params.exchange} make_order error: ${err}`);
        try {
          sendErrorResponse(res, err.message || JSON.stringify(err));
        } catch (e) {
          try {
            sendErrorResponse(res, err.toString());
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
      sendErrorResponse(res, "Coin parameter missing from cancel request");
    } else if (!priceCurrency) {
      sendErrorResponse(
        res,
        "Price currency parameter missing from cancel request"
      );
    } else if (!orderId && !clientOrderId) {
      sendErrorResponse(
        res,
        "Order id and client order id missing from cancel request"
      );
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
      .then((_) => sendSuccessfulResponse(res))
      .catch((err) => {
        logger.error(
          `${req.params.coin}/${req.params.priceCurrency} cancel 
          ${req.params.orderId} received error ${JSON.stringify(err)}`
        );
        try {
          sendErrorResponse(res, err.message || JSON.stringify(err));
        } catch (e) {
          try {
            sendErrorResponse(res, err);
          } catch (f) {
            next(err);
          }
        }
      });
  })
);

router.post(
  "/settle",
  expressAsyncHandler(async (req, res, next) => {
    api
      .settleFunds(req.body.coin, req.body.priceCurrency)
      .then((_) => sendSuccessfulResponse(res))
      .catch((err) => sendErrorResponse(res, err.toString()));
  })
);

export { router as default };
