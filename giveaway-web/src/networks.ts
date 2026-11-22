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
  blockExplorers: { default: { name: 'PulseScan', url: 'https://scan.v4.testnet.pulsechain.com' } },
  testnet: true,
})

export interface Network {
  chain: Chain
  /** Verity testnet addresses: https://docs.pulseinput.com/guide/networks */
  coordinator: Address
  picker: Address
  /** Block the picker was deployed in (first block to search) */
  startBlock: bigint
}

const fromUrl = (k: string): Address | undefined => {
  const v = new URLSearchParams(location.search).get(k)
  return v && /^0x[0-9a-fA-F]{40}$/.test(v) ? (v as Address) : undefined
}

/** GiveawayPicker demo (2026-11-21). ?picker=0x.. in the URL overrides it. */
export const network: Network = {
  chain: pulsechainTestnet,
  coordinator: fromUrl('coordinator') ?? '0xF3cBd70d61a8F5c8522d1377D9208844C3e1f0D7',
  picker: fromUrl('picker') ?? '0x500b92B21CbdEA172EF45Af964E1203D7586086A',
  startBlock: 25956712n,
}
