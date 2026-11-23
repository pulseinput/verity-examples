# Verity use cases

Example contracts and live demo apps for **[Verity](https://pulseinput.com/verity/)**, verifiable randomness for
PulseChain by [PulseInput](https://pulseinput.com). Every demo runs on PulseChain testnet v4 and you can try it in your
browser.

> **Testnet only.** The demos use test PLS from the [PulseInput faucet](https://app.pulseinput.com/#/faucet). Do not use Verity
> to secure real value yet.

## Live demos

| Demo | Try it | App source | Contract |
|---|---|---|---|
| Dice | [pulseinput.com/verity/use-cases/dice](https://pulseinput.com/verity/use-cases/dice/) | [`dice-web/`](dice-web) | `DiceRoll` in [`@pulseinput/contracts`](https://unpkg.com/browse/@pulseinput/contracts@0.1.0/verity/examples/DiceRoll.sol) |
| Raffle | [pulseinput.com/verity/use-cases/raffle](https://pulseinput.com/verity/use-cases/raffle/) | [`raffle-web/`](raffle-web) | `RaffleRounds` in [`@pulseinput/contracts`](https://unpkg.com/browse/@pulseinput/contracts@0.1.0/verity/examples/RaffleRounds.sol) |
| Giveaway picker | [pulseinput.com/verity/use-cases/giveaway](https://pulseinput.com/verity/use-cases/giveaway/) | [`giveaway-web/`](giveaway-web) | `GiveawayPicker` in [`@pulseinput/contracts`](https://unpkg.com/browse/@pulseinput/contracts@0.1.0/verity/examples/GiveawayPicker.sol) |
| Random-trait NFT | [pulseinput.com/verity/use-cases/nft](https://pulseinput.com/verity/use-cases/nft/) | [`nft-web/`](nft-web) | [`contracts/src/VerityOrbs.sol`](contracts/src/VerityOrbs.sol) |
| Coin flip | [pulseinput.com/verity/use-cases/coinflip](https://pulseinput.com/verity/use-cases/coinflip/) | [`coinflip-web/`](coinflip-web) | `CoinFlip` in [`@pulseinput/contracts`](https://unpkg.com/browse/@pulseinput/contracts@0.1.0/verity/examples/CoinFlip.sol) |

Each app is plain TypeScript with [viem](https://viem.sh) and Vite. Run one locally:

```sh
cd raffle-web
npm install
npm run dev
```

Testnet addresses are in each app's `src/networks.ts`.

## Example contracts (`contracts/`)

| Contract | Shows | Tutorial |
|---|---|---|
| [`Raffle.sol`](contracts/src/Raffle.sol) | Lock entries when the draw is requested; exactly one draw; refunds (never a re-draw) if the oracle never answers; pull payments | [Fair raffle](https://docs.pulseinput.com/tutorials/raffle) |
| [`RandomTraitsNFT.sol`](contracts/src/RandomTraitsNFT.sol) | Mint first, reveal later: traits from separate slices of one random word, so minters cannot pick traits | [Random-trait NFTs](https://docs.pulseinput.com/tutorials/nft) |
| [`TournamentSeeding.sol`](contracts/src/TournamentSeeding.sol) | Verifiable Fisher–Yates seeding that anyone can recompute | [Tournament seeding](https://docs.pulseinput.com/tutorials/tournament) |
| [`VerityOrbs.sol`](contracts/src/VerityOrbs.sol) | The live NFT demo: five traits from 48-bit slices of one word, on-chain SVG art | |

The contracts import Verity from [`@pulseinput/contracts`](https://www.npmjs.com/package/@pulseinput/contracts)
(`@pulseinput/contracts/verity/...`). Build and test them with Foundry:

```sh
cd contracts
npm install
forge install foundry-rs/forge-std@v1.17.0 OpenZeppelin/openzeppelin-contracts@v5.0.2 --no-git
forge test
```

The tests use `VerityCoordinatorMock` from the package, so they run without a node or a network.

## PulseChain notes

- PulseChain supports **Shanghai, not Cancun**: compile with `evm_version = "shanghai"`.
- OpenZeppelin **v5.5 and later** use the Cancun opcode `mcopy` in ERC-721 and ERC-1155. These examples use **v5.0.2**.
- Always send a priority fee of at least 1 gwei.

More in the [PulseChain notes](https://docs.pulseinput.com/guide/pulsechain).

## Build your own

Start with the [10-minute Quickstart](https://docs.pulseinput.com/guide/quickstart), then read
[Security rules for consumers](https://docs.pulseinput.com/guide/security).

## Community

Questions, ideas or something you built with Verity? Join the PulseInput community on Telegram:
**[t.me/pulseinput](https://t.me/pulseinput)**. News and updates on X: **[@pulseinput](https://x.com/pulseinput)**. Security issues: please email security@pulseinput.com privately.

## License

MIT
