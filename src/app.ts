import createError from "http-errors";
import express from "express";
import { default as morgan } from "morgan";
import indexRouter from "./routes";
import { logger, morganStream } from "./utils";
import * as config from "./config";

const app = express();

app.use(
  morgan("combined", {
    stream: morganStream,
  })
);
app.use(express.json());
app.use(express.urlencoded({ extended: false }));

app.use("/", indexRouter);

// catch 404 and forward to error handler
app.use((req, res, next) => {
  next(createError(404));
});

// error handler
app.use((err, req, res, next) => {
  logger.log(
    "error",
    `Express error handler called for error ${err.name}: \n ${err.stack}`
  );
  // set locals, only providing error in development
  res.locals.message = err.message;
  res.locals.error = req.app.get("env") === "dev" ? err : {};

  // render the error page
  res.status(err.status || 500);
  res.send("error");
});

if (config.RESTART_INTERVAL_SEC) {
  const secs = config.RESTART_INTERVAL_SEC + Math.floor(Math.random() * 30);
  setTimeout(() => {
    logger.error(
      `Restarting server on port ${config.PORT} after ${secs} seconds due to timer`
    );
    process.exit(0);
  }, secs * 1000);
}

export default app;
