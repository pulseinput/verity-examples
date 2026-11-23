import { defineChain, type Address, type Chain } from 'viem'

export const pulsechainTestnet = defineChain({
  id: 943,
  name: 'PulseChain Testnet v4',
  nativeCurrency: { name: 'Test Pulse', symbol: 'tPLS', decimals: 18 },
  // The official RPC has outages: reads fail over in order, and "add network" gives the wallet all of them.
  rpcUrls: {
    default: {
      http: [
        'https://rpc.v4.testnet.pulsechain.com',
        'https://pulsechain-testnet-rpc.publicnode.com',
        'https://rpc-testnet-pulsechain.g4mm4.io',
      ],
    },
  },
  blockExplorers: { default: { name: 'PulseScan', url: 'https://scan.v4.testnet.pulsechain.com/#' } },
  testnet: true,
})

export const localAnvil = defineChain({
  id: 31337,
  name: 'Local Anvil',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: ['http://127.0.0.1:8545'] } },
  testnet: true,
})

export interface Network {
  chain: Chain
  /** Verity testnet addresses: https://docs.pulseinput.com/guide/networks */
  coordinator: Address
  dice: Address
  /** First block to search for coordinator events */
  startBlock: bigint
  /** Demos indexer API (roll history); undefined = history lists are hidden */
  demosApi?: string
}

const ZERO = '0x0000000000000000000000000000000000000000'

export const networks: Record<number, Network> = {
  943: {
    chain: pulsechainTestnet,
    // VerityCoordinator 1.0.0 (see https://docs.pulseinput.com/guide/networks) + DiceRoll with per-roll confirmations 1..5 (2026-11-16)
    coordinator: '0xF3cBd70d61a8F5c8522d1377D9208844C3e1f0D7',
    dice: '0xFEeFf3BB39c415b3875CcF93c6f5761145D2F71D',
    startBlock: 25826198n,
    demosApi: 'https://api.pulseinput.com/demos/v1',
  },
  31337: {
    chain: localAnvil,
    // Deterministic for a fresh anvil + script/Deploy.s.sol with account 0
    coordinator: '0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512',
    dice: '0x5FC8d32690cc91D4c39d9d3abcBD16989F875707',
    startBlock: 0n,
  },
}

export const isDeployed = (n: Network) => n.coordinator !== ZERO && n.dice !== ZERO

/** ?coordinator=0x..&dice=0x.. in the URL overrides the configured addresses */
export function withUrlOverrides(n: Network): Network {
  const q = new URLSearchParams(location.search)
  const addr = (k: string) => {
    const v = q.get(k)
    return v && /^0x[0-9a-fA-F]{40}$/.test(v) ? (v as Address) : undefined
  }
  const overridden = !!(addr('coordinator') || addr('dice'))
  // ?demosApi= picks another indexer; the history is turned off when the page points at other contracts
  const api = q.get('demosApi')
  const demosApi = api !== null ? api || undefined : overridden ? undefined : n.demosApi
  return { ...n, coordinator: addr('coordinator') ?? n.coordinator, dice: addr('dice') ?? n.dice, demosApi }
}
