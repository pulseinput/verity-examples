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

export interface Network {
  chain: Chain
  coordinator: Address
  orbs: Address
  /** Block the NFT contract was deployed in (first block to search for mints) */
  startBlock: bigint
  /** Demos indexer API (owned Orbs); undefined = search the chain */
  demosApi?: string
}

const fromUrl = (k: string): Address | undefined => {
  const v = new URLSearchParams(location.search).get(k)
  return v && /^0x[0-9a-fA-F]{40}$/.test(v) ? (v as Address) : undefined
}

/** VerityOrbs demo (2026-11-21). ?orbs=0x.. in the URL overrides it. */
/** ?demosApi= picks another indexer; off when the page is pointed at other contracts through the URL. */
function demosApi(overridden: boolean): string | undefined {
  const v = new URLSearchParams(location.search).get('demosApi')
  if (v !== null) return v || undefined
  return overridden ? undefined : 'https://api.pulseinput.com/demos/v1'
}

export const network: Network = {
  chain: pulsechainTestnet,
  coordinator: fromUrl('coordinator') ?? '0xF3cBd70d61a8F5c8522d1377D9208844C3e1f0D7',
  orbs: fromUrl('orbs') ?? '0x470f825a3002Cf52b4600C3b1C8a645c21912ed4',
  startBlock: 25956980n,
  demosApi: demosApi(!!(fromUrl('coordinator') || fromUrl('orbs'))),
}
