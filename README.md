# serum-rest-server

# Install

This server uses `yarn` to manage node.js dependencies. To install dependencies, from the root directory run

```
yarn
```

to build the workspace run

```
yarn build
```

to start the server in debug mode

```
DEBUG=js:* yarn start
```

# Configuration

Server configurations are managed with [dotenv](https://www.npmjs.com/package/dotenv). A default configuration is
provided in `.env.development`. The server looks for solana private keys in the file specified by the `SECRETS_FILE`
config. Without any further configuration to permission the server, create a file with following format, replacing
`"your_bs58_private_key"` with your base58 encoded solana private key (which you can export from sollet.io).

```json
{
  "serum_private_key": "your_bs58_private_key"
}
```

Then store this file at a location of your choosing and set the `SECRETS_FILE` config to your chosen location. Note
that `dotenv` by default looks for `.env` files, so you will need to rename `.env.development` to `.env` for the
configurtation file to take effect.

# Shell

A node.js shell is provided for debugging purposes. Start the shell with

```
yarn shell
```

An example of fetching an orderbook for the `BTC/USDC` pair is provided below.

```
[~/serum-rest-server]$ yarn shell
> sapi = await SerumApi.create()
...
> await sapi.getWsOrderbook('BTC', 'USDC')
{
  bids: [...],
  asks: [...],
  market: Pair { coin: 'BTC', priceCurrency: 'USDC' },
  validAt: ...,
  receivedAt: ...
}
```
