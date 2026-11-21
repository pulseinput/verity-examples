# verity-examples

Examples of using **Verity** verifiable randomness.

## dice-web

A browser demo of `DiceRoll` (from `verity-contracts/src/examples`). It connects a wallet, rolls, and follows the request through requested → confirmations → proved and fulfilled, with explorer links for both transactions.

```sh
cd dice-web
npm install
npm run dev
```

Networks are configured in `src/networks.ts`. Fill in the PulseChain testnet addresses from `verity-contracts/deployments/943.json`, or override them for a session with `?coordinator=0x..&dice=0x..`.

To try it locally:
1. Run `anvil --hardfork shanghai --block-time 2`.
2. Deploy with `verity-contracts/script/Deploy.s.sol` using anvil account 0.
3. Run a `verity-node`.
4. Choose "Local Anvil" in the page and use an anvil account in your wallet.
