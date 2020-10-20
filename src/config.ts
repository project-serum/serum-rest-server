import dotenv from "dotenv";

// use passed port if sepcified otherwise default to the .env file
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
