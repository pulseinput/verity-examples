# Verity example consumers

| Contract | Shows |
|---|---|
| `Raffle.sol` | Lock entries when the draw is requested; exactly one draw; if the oracle never answers, refunds (never a re-draw); pull payments |
| `RandomTraitsNFT.sol` | Mint first, reveal later: traits from disjoint 64-bit slices of one VRF word, so minters cannot pick traits |
| `TournamentSeeding.sol` | Verifiable Fisher–Yates seeding; the callback stores only the word and a view derives the seeding (fixed callback gas) |
| `VerityOrbs.sol` | Live NFT demo ([pulseinput.com/verity/use-cases/nft](https://pulseinput.com/verity/use-cases/nft/)): mint first, reveal later, five traits from 48-bit slices, on-chain SVG art |

The contracts import Verity from the npm package [`@pulseinput/contracts`](https://www.npmjs.com/package/@pulseinput/contracts)
(`@pulseinput/contracts/verity/...`), mapped in `remappings.txt` to `node_modules/@pulseinput/contracts/`.

```sh
npm install
forge install foundry-rs/forge-std@v1.17.0 OpenZeppelin/openzeppelin-contracts@v5.0.2 --no-git
forge test
```

## PulseChain notes

- PulseChain supports **Shanghai, not Cancun**. Compile with `evm_version = "shanghai"`. Code compiled for Cancun can deploy but fail at runtime.
- **OpenZeppelin v5.1 and later use `mcopy`** (a Cancun opcode) in `Bytes`, `Arrays`, `Memory` and other utilities that ERC-20, ERC-721 and others pull in. Use **OpenZeppelin v5.0.x** for token contracts on PulseChain. Compiling for `shanghai` makes the compiler catch this.
