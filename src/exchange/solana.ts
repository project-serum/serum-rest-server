import { Account, Blockhash, Connection, Transaction } from "@solana/web3.js";
import fetch, { Response } from "node-fetch";
import jayson from "jayson/lib/client/browser";
import { sleep } from "../utils";
import { struct } from "superstruct";

export async function signAndSerializeTransaction(
  connection: Connection,
  transaction: Transaction,
  signers: Array<Account>,
  blockhash: Blockhash
): Promise<Buffer> {
  transaction.recentBlockhash = blockhash;
  transaction.sign(...signers);
  return transaction.serialize();
}

export type RpcRequest = (methodName: string, args: Array<any>) => any;

function jsonRpcResult(resultDescription: any) {
  const jsonRpcVersion = struct.literal("2.0");
  return struct.union([
    struct({
      jsonrpc: jsonRpcVersion,
      id: "string",
      error: "any",
    }),
    struct({
      jsonrpc: jsonRpcVersion,
      id: "string",
      error: "null?",
      result: resultDescription,
    }),
  ]);
}

function jsonRpcResultAndContext(resultDescription: any) {
  return jsonRpcResult({
    context: struct({
      slot: "number",
    }),
    value: resultDescription,
  });
}

const AccountInfoResult = struct({
  executable: "boolean",
  owner: "string",
  lamports: "number",
  data: "any",
  rentEpoch: "number?",
});

export const GetMultipleAccountsAndContextRpcResult = jsonRpcResultAndContext(
  struct.array([struct.union(["null", AccountInfoResult])])
);

export function createRpcRequest(url: string): RpcRequest {
  const server = new jayson(async (request, callback) => {
    const options = {
      method: "POST",
      body: request,
      headers: {
        "Content-Type": "application/json",
      },
    };

    try {
      let too_many_requests_retries = 5;
      let res: Response = {};
      let waitTime = 500;
      for (;;) {
        res = await fetch(url, options);
        if (res.status !== 429 /* Too many requests */) {
          break;
        }
        too_many_requests_retries -= 1;
        if (too_many_requests_retries === 0) {
          break;
        }
        console.log(
          `Server responded with ${res.status} ${res.statusText}.  Retrying after ${waitTime}ms delay...`
        );
        await sleep(waitTime);
        waitTime *= 2;
      }

      const text = await res.text();
      if (res.ok) {
        callback(null, text);
      } else {
        callback(new Error(`${res.status} ${res.statusText}: ${text}`));
      }
    } catch (err) {
      callback(err);
    }
  }, {});

  return (method, args) => {
    return new Promise((resolve, reject) => {
      server.request(method, args, (err, response) => {
        if (err) {
          reject(err);
          return;
        }
        resolve(response);
      });
    });
  };
}
