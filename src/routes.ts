import express from "express";
import { SerumApi } from "./exchange/api";
import expressAsyncHandler from "express-async-handler";
import { logger } from "./utils";

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

router.get("/orderbook/:coin-:quote", expressAsyncHandler(async (req, res, next) => {
  logger.info(`Received request to ${req.params.exchange} api getOrderbook`);
  api
    .getWsOrderBook(req.params.coin, req.params.quote)
    .then((orderBook) => res.send({ status: "ok", data: orderBook }))
    .catch((err) => next(err));
}));

router.get("/trades/:coin-:quote", expressAsyncHandler(async (req, res, next) => {
  logger.info(`Received request to ${req.params.exchange} api trades`);
  api
    .getTrades(req.params.coin, req.params.quote)
    .then((trades) => res.send({ status: "ok", data: trades }))
    .catch((err) => {
      logger.info(err);
      next(err);
    });
}));

router.get("/place_order", expressAsyncHandler(async (req, res, next) => {}));

router.get("/cancel/:orderId", expressAsyncHandler(async (req, res, next) => {}));

router.get("/own_orders", expressAsyncHandler(async (req, res, next) => {}));

router.get("/fills", expressAsyncHandler(async (req, res, next) => {}));

router.get("/balances", expressAsyncHandler(async (req, res, next) => {}));

router.get("/settle", expressAsyncHandler(async (req, res, next) => {}));

export { router as default };
