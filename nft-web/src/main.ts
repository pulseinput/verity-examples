import {
  BaseError,
  ContractFunctionRevertedError,
  createPublicClient,
  createWalletClient,
  custom,
  fallback,
  http,
  parseEventLogs,
  type Address,
  type EIP1193Provider,
} from 'viem'
import { ODDS, orbsAbi, RARITIES } from './abi'
import { network } from './networks'

declare global {
  interface Window {
    ethereum?: EIP1193Provider
  }
}

const POLL_MS = 4000
const RECENT = 12

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T
const ui = {
  connect: $<HTMLButtonElement>('connect'),
  account: $<HTMLSpanElement>('account'),
  notice: $<HTMLParagraphElement>('notice'),
  flip: $<HTMLDivElement>('flip'),
  mystery: $<HTMLImageElement>('mystery'),
  revealed: $<HTMLImageElement>('revealed'),
  mintTitle: $<HTMLHeadingElement>('mint-title'),
  mintSub: $<HTMLParagraphElement>('mint-sub'),
  mint: $<HTMLButtonElement>('mint'),
  steps: $<HTMLOListElement>('steps'),
  conf: $<HTMLSpanElement>('conf'),
  traits: $<HTMLDListElement>('traits'),
  tokenLinks: $<HTMLParagraphElement>('token-links'),
  supply: $<HTMLSpanElement>('supply'),
  odds: $<HTMLTableSectionElement>('odds'),
  mineBox: $<HTMLElement>('mine-box'),
  mine: $<HTMLDivElement>('mine'),
  recent: $<HTMLDivElement>('recent'),
  recentEmpty: $<HTMLParagraphElement>('recent-empty'),
}

type Meta = { name: string; image: string; attributes: { trait_type: string; value: string }[] }

const sym = network.chain.nativeCurrency.symbol
let account: Address | undefined
let busy = false
let confirmations = 3n
const metaCache = new Map<bigint, Meta>() // revealed tokens only (their metadata never changes)

const pub = (() => {
  const urls = network.chain.rpcUrls.default.http
  return createPublicClient({ chain: network.chain, transport: fallback(urls.map((u) => http(u, { timeout: 8_000 }))) })
})()
const wallet = () => {
  if (!window.ethereum) throw new Error('No browser wallet found. Install MetaMask or Rabby.')
  return createWalletClient({ chain: network.chain, transport: custom(window.ethereum) })
}
const read = <T>(functionName: string, args: unknown[] = []) =>
  pub.readContract({ address: network.orbs, abi: orbsAbi, functionName, args } as never) as Promise<T>

// ------------------------------------------------------------------ helpers

function notice(msg?: string) {
  ui.notice.hidden = !msg
  ui.notice.textContent = msg ?? ''
}
const explorerBase = network.chain.blockExplorers?.default.url ?? ''
const tokenUrl = (id: bigint) => `${explorerBase}/token/${network.orbs}/instance/${id}`

function errorMessage(e: unknown): string {
  if (e instanceof BaseError) {
    const revert = e.walk((err) => err instanceof ContractFunctionRevertedError)
    const name = revert instanceof ContractFunctionRevertedError ? revert.data?.errorName : undefined
    if (name === 'SoldOut') return 'All 10,000 Orbs have been minted.'
    if (/insufficient funds/i.test(e.message)) return `Not enough ${sym} for gas. Get test PLS from the faucet.`
    if (/user rejected|denied/i.test(e.message)) return 'You cancelled the transaction in your wallet.'
    return e.shortMessage
  }
  return e instanceof Error ? e.message : String(e)
}
async function ensureChain() {
  const w = wallet()
  try {
    await w.switchChain({ id: network.chain.id })
  } catch {
    await w.addChain({ chain: network.chain })
    await w.switchChain({ id: network.chain.id })
  }
}

/** Decode the contract's data: URI. Images are kept as data: URIs and shown with <img> (their SVG ids would clash inline). */
function decodeUri(uri: string): Meta {
  const b64 = uri.replace(/^data:application\/json;base64,/, '')
  const json = new TextDecoder().decode(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)))
  return JSON.parse(json) as Meta
}
async function meta(id: bigint): Promise<Meta> {
  const have = metaCache.get(id)
  if (have) return have
  const m = decodeUri(await read<string>('tokenURI', [id]))
  if (!m.attributes.some((a) => a.trait_type === 'Status')) metaCache.set(id, m)
  return m
}
const attr = (m: Meta, k: string) => m.attributes.find((a) => a.trait_type === k)?.value

const MYSTERY =
  'data:image/svg+xml;utf8,' +
  encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 400"><rect width="400" height="400" fill="#0b0a12"/><circle cx="200" cy="190" r="110" fill="#17141f" stroke="#b77bff" stroke-width="4" stroke-dasharray="10 10"/><text x="200" y="228" text-anchor="middle" font-family="system-ui,sans-serif" font-size="110" font-weight="800" fill="#b77bff">?</text><text x="200" y="350" text-anchor="middle" font-family="system-ui,sans-serif" font-size="20" fill="#9a96ab">Traits decided by Verity</text></svg>',
  )

function tile(id: bigint, m: Meta, mine = false): HTMLAnchorElement {
  const a = document.createElement('a')
  a.className = 'tile'
  a.href = tokenUrl(id)
  a.target = '_blank'
  a.rel = 'noopener'
  const rarity = attr(m, 'Rarity')
  a.innerHTML = `<img alt="${m.name}" loading="lazy" src="${m.image}" /><span class="cap"><span>#${id}</span><span class="r ${(rarity ?? 'pending').toLowerCase()}">${rarity ?? 'Revealing…'}</span></span>`
  if (mine) a.classList.add('mine')
  return a
}

// ------------------------------------------------------------------ data

async function loadStats() {
  const [minted, revealed, ...counts] = await Promise.all([
    read<bigint>('totalMinted'),
    read<bigint>('totalRevealed'),
    ...[0n, 1n, 2n, 3n].map((r) => read<bigint>('rarityCount', [r])),
  ])
  ui.supply.textContent = `${minted} minted · ${revealed} revealed · 10,000 max`
  ui.odds.replaceChildren(
    ...RARITIES.map((name, i) => {
      const tr = document.createElement('tr')
      const n = counts[i] ?? 0n
      const share = revealed > 0n ? ` (${((Number(n) / Number(revealed)) * 100).toFixed(1)}%)` : ''
      tr.innerHTML = `<td><span class="r ${name.toLowerCase()}">${name}</span></td><td>${ODDS[i]}%</td><td>${n}${share}</td>`
      return tr
    }),
  )
  return minted
}

async function loadRecent(minted: bigint) {
  ui.recentEmpty.hidden = minted > 0n
  const ids: bigint[] = []
  for (let i = minted; i > 0n && ids.length < RECENT; i--) ids.push(i)
  const metas = await Promise.all(ids.map((id) => meta(id).catch(() => undefined)))
  ui.recent.replaceChildren(...ids.flatMap((id, k) => (metas[k] ? [tile(id, metas[k]!)] : [])))
}

async function loadMine() {
  if (!account) {
    ui.mineBox.hidden = true
    return
  }
  const logs = await pub.getContractEvents({
    address: network.orbs,
    abi: orbsAbi,
    eventName: 'Transfer',
    args: { to: account },
    fromBlock: network.startBlock,
  })
  const candidates = [...new Set(logs.map((l) => l.args.tokenId!))].sort((a, b) => (a > b ? -1 : 1))
  const owners = await Promise.all(candidates.map((id) => read<Address>('ownerOf', [id]).catch(() => undefined)))
  const owned = candidates.filter((_, k) => owners[k]?.toLowerCase() === account!.toLowerCase())
  ui.mineBox.hidden = owned.length === 0
  const metas = await Promise.all(owned.map((id) => meta(id).catch(() => undefined)))
  ui.mine.replaceChildren(...owned.flatMap((id, k) => (metas[k] ? [tile(id, metas[k]!, true)] : [])))
}

async function refresh() {
  try {
    const minted = await loadStats()
    await Promise.all([loadRecent(minted), loadMine()])
  } catch (e) {
    notice(`Could not read the contract: ${errorMessage(e)}`)
  }
}

// ------------------------------------------------------------------ mint + reveal

function setStep(step: 'confirming' | 'fulfilled') {
  const order = ['requested', 'confirming', 'fulfilled']
  const at = order.indexOf(step)
  ui.steps.querySelectorAll<HTMLLIElement>('li').forEach((li, i) => {
    li.classList.toggle('done', i < at || step === 'fulfilled')
    li.classList.toggle('active', i === at && step !== 'fulfilled')
  })
}

function renderMintButton() {
  ui.mint.disabled = !account || busy
  ui.mint.textContent = !account ? 'Connect a wallet to mint' : busy ? 'Minting…' : 'Mint an Orb'
}

async function mint() {
  if (!account) return
  busy = true
  notice()
  renderMintButton()
  ui.flip.classList.remove('flipped')
  ui.mystery.src = MYSTERY
  ui.traits.hidden = true
  ui.tokenLinks.hidden = true
  try {
    await ensureChain()
    const price = await read<bigint>('mintPrice')
    const hash = await wallet().writeContract({
      account,
      chain: network.chain,
      address: network.orbs,
      abi: orbsAbi,
      functionName: 'mint',
      value: price,
    })
    const receipt = await pub.waitForTransactionReceipt({ hash })
    const [ev] = parseEventLogs({ abi: orbsAbi, eventName: 'Minted', logs: receipt.logs })
    if (!ev) throw new Error('Minted event not found in the receipt')
    const id = ev.args.tokenId
    ui.mintTitle.textContent = `Orb #${id}`
    ui.mintSub.textContent = 'Minted. Its traits are being decided by Verity…'
    ui.steps.hidden = false
    ui.tokenLinks.hidden = false
    ui.tokenLinks.innerHTML = `<a href="${explorerBase}/tx/${hash}" target="_blank" rel="noopener">Mint transaction</a> · <a href="${tokenUrl(id)}" target="_blank" rel="noopener">Orb #${id} on PulseScan</a>`
    void refresh()
    await waitForReveal(id, receipt.blockNumber)
  } catch (e) {
    notice(errorMessage(e))
  } finally {
    busy = false
    renderMintButton()
  }
}

async function waitForReveal(id: bigint, mintBlock: bigint) {
  for (;;) {
    const t = await read<{ revealed: boolean }>('traitsOf', [id])
    if (t.revealed) break
    const head = await pub.getBlockNumber()
    const conf = head > mintBlock ? head - mintBlock : 0n
    setStep('confirming')
    ui.conf.textContent = conf < confirmations ? `(${conf} / ${confirmations})` : `(${confirmations} / ${confirmations}) · proving…`
    if (head > mintBlock + 256n) {
      notice('Verity did not answer within 256 blocks. This Orb stays unrevealed; mint another.')
      return
    }
    await new Promise((r) => setTimeout(r, POLL_MS))
  }
  const m = await meta(id)
  ui.revealed.src = m.image
  ui.revealed.onload = () => ui.flip.classList.add('flipped')
  setStep('fulfilled')
  ui.conf.textContent = ''
  const rarity = attr(m, 'Rarity') ?? ''
  ui.mintSub.innerHTML = `Revealed: <span class="r ${rarity.toLowerCase()}">${rarity}</span>`
  ui.traits.hidden = false
  ui.traits.replaceChildren()
  for (const k of ['Background', 'Shape', 'Core', 'Pattern']) {
    const dt = document.createElement('dt')
    dt.textContent = k
    const dd = document.createElement('dd')
    dd.textContent = attr(m, k) ?? ''
    ui.traits.append(dt, dd)
  }
  await refresh()
}

// ------------------------------------------------------------------ wiring

async function connect() {
  try {
    const [addr] = await wallet().requestAddresses()
    account = addr
    await ensureChain()
    ui.account.textContent = account ?? ''
    ui.connect.textContent = 'Connected'
    renderMintButton()
    await loadMine()
  } catch (e) {
    notice(errorMessage(e))
  }
}

ui.connect.addEventListener('click', connect)
ui.mint.addEventListener('click', () => void mint())
window.ethereum?.on?.('accountsChanged', (accs: Address[]) => {
  account = accs[0]
  ui.account.textContent = account ?? ''
  ui.connect.textContent = account ? 'Connected' : 'Connect wallet'
  renderMintButton()
  void loadMine()
})

ui.mystery.src = MYSTERY
void (async () => {
  try {
    const accs = (await window.ethereum?.request({ method: 'eth_accounts' })) as Address[] | undefined
    if (accs?.[0]) {
      account = accs[0]
      ui.account.textContent = account
      ui.connect.textContent = 'Connected'
    }
  } catch {
    /* no wallet */
  }
  renderMintButton()
  read<number>('confirmations')
    .then((c) => (confirmations = BigInt(c)))
    .catch(() => {})
  await refresh()
})()
setInterval(() => {
  if (!busy && document.visibilityState === 'visible') void refresh()
}, 15_000)
