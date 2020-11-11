import { LOGGING_DIR, SECRETS_FILE } from "./config";
import { readFileSync } from "fs";
import BN from "bn.js";
import winston, { format } from "winston";
import "winston-daily-rotate-file";
const { combine, timestamp, printf } = format;
import fs from "fs";
// Logging
if (
  LOGGING_DIR &&
  !fs.existsSync(LOGGING_DIR) &&
  process.env.ENVIRONMENT === "prod"
) {
  fs.mkdirSync(LOGGING_DIR);
}

const logFormat = printf(({ level, message, timestamp }) => {
  return `${timestamp} ${level}: ${message}`;
});

export const logger = winston.createLogger({
  level: "silly",
  format: combine(timestamp(), logFormat),
  transports: [
    new winston.transports.Console({
      format: winston.format.simple(),
      level: "info",
    }),
  ],
});

if (process.env.ENVIRONMENT === "prod") {
  logger.add(
    new winston.transports.DailyRotateFile({
      dirname: LOGGING_DIR,
      filename: "remote_js_server-ERROR-%DATE%.log",
      datePattern: "YYYY-MM-DD-HH",
      maxSize: "200m",
      maxFiles: "1",
      utc: true,
      level: "error",
    })
  );
  logger.add(
    new winston.transports.DailyRotateFile({
      dirname: LOGGING_DIR,
      filename: "remote_js_server-INFO-%DATE%.log",
      datePattern: "YYYY-MM-DD-HH",
      maxSize: "200m",
      maxFiles: "3",
      utc: true,
      level: "info",
    })
  );
  logger.add(
    new winston.transports.DailyRotateFile({
      dirname: LOGGING_DIR,
      filename: "remote_js_server-DEBUG-%DATE%.log",
      datePattern: "YYYY-MM-DD-HH",
      maxSize: "200m",
      maxFiles: "3",
      utc: true,
    })
  );
}

class MorganStream {
  write(text: string) {
    logger.info(text.replace(/\n$/, ""));
  }
}
export const morganStream = new MorganStream();

export const getKeys = (keys: string[]): any[] => {
  const allSecrets = JSON.parse(readFileSync(SECRETS_FILE, "utf-8"));
  const secrets: string[] = [];
  for (const key of keys) {
    secrets.push(allSecrets[key]);
  }
  return secrets;
};

export const getUnixTs = (): number => {
  return new Date().getTime() / 1000;
};

export function sleep(time: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, time));
}

export function divideBnToNumber(numerator: BN, denominator: BN): number {
  const quotient = numerator.div(denominator).toNumber();
  const rem = numerator.umod(denominator);
  const gcd = rem.gcd(denominator);
  return quotient + rem.div(gcd).toNumber() / denominator.div(gcd).toNumber();
}
