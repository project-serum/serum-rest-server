import express from "express";
import {SerumApi} from "./exchange/api";
import expressAsyncHandler from "express-async-handler";
import { logger } from "./utils";

const router = express.Router();
let api: SerumApi;

router.get("/", (req, res, next) => {
  res.send(
    "Hello from the Serum rest server!"
  );
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

export { router as default };
