import dotenv from "dotenv";
import {PublicKey} from "@solana/web3.js";
import {Market} from "./exchange/types";

// use passed port if specified otherwise default to the .env file
const PASSED_PORT = process.env.PORT;

dotenv.config();

export const PORT = PASSED_PORT || process.env.PORT;
export const ENV = process.env.ENVIRONMENT;
export const SECRETS_FILE = process.env.SECRETS_FILE || "";
export const LOGGING_DIR = process.env.LOGGING_DIR || "";

// check truthiness of this to determine if we should restart at interval
export const RESTART_INTERVAL_SEC = parseInt(
  process.env.RESTART_INTERVAL_SEC || "0"
);

export const HARD_CODED_MINTS = process.env.HARD_CODED_MINTS || {};
export const DEFAULT_TIMEOUT = 15000;
export const NUM_CONNECTIONS = 1;
export const SOLANA_URL = process.env.SOLANA_URL || "http://validator-lb.wirelesstable.net";
