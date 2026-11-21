import {
  BaseError,
  ContractFunctionRevertedError,
  createPublicClient,
  createWalletClient,
  custom,
  fallback,
  formatEther,
  getAddress,
  http,
  isAddress,
  parseEventLogs,
  type Address,
  type EIP1193Provider,
  type Hash,
} from 'viem'
import { coordinatorAbi, pickerAbi, State } from './abi'
import { network } from './networks'

declare global {
  interface Window {
    ethereum?: EIP1193Provider
  }
}

const POLL_MS = 4000
const RECENT = 8
const MAX_ENTRANTS = 2000
const MAX_WINNERS = 50
const MAX_TITLE_BYTES = 80

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T
const ui = {
  connect: $<HTMLButtonElement>('connect'),
  account: $<HTMLSpanElement>('account'),
  notice: $<HTMLParagraphElement>('notice'),
  createView: $<HTMLElement>('create-view'),
  recentView: $<HTMLElement>('recent-view'),
  title: $<HTMLInputElement>('title'),
  sample: $<HTMLButtonElement>('sample'),
  entrants: $<HTMLTextAreaElement>('entrants'),
  parse: $<HTMLParagraphElement>('parse'),
  count: $<HTMLInputElement>('count'),
  minus: $<HTMLButtonElement>('minus'),
  plus: $<HTMLButtonElement>('plus'),
  create: $<HTMLButtonElement>('create'),
  recent: $<HTMLUListElement>('recent'),
  recentEmpty: $<HTMLParagraphElement>('recent-empty'),
  resultView: $<HTMLElement>('result-view'),
  gTitle: $<HTMLHeadingElement>('g-title'),
  gStatus: $<HTMLSpanElement>('g-status'),
  gMeta: $<HTMLParagraphElement>('g-meta'),
  steps: $<HTMLOListElement>('steps'),
  conf: $<HTMLSpanElement>('conf'),
  winners: $<HTMLOListElement>('winners'),
  copy: $<HTMLButtonElement>('copy'),
  checkView: $<HTMLElement>('check-view'),
  check: $<HTMLParagraphElement>('check'),
  details: $<HTMLDListElement>('details'),
  entrantsCount: $<HTMLSpanElement>('entrants-count'),
  entrantList: $<HTMLOListElement>('entrant-list'),
}

type Giveaway = {
  creator: Address
  state: number
  winnerCount: number
  entrantCount: number
  createdBlock: bigint
  entrantsHash: Hash
  randomWord: bigint
}
type Created = { title: string; entrants: readonly Address[]; requestId: bigint; tx: Hash }

const sym = network.chain.nativeCurrency.symbol
let account: Address | undefined
let busy = false
let confirmations = 3n
let parsed: Address[] = []
/** Creation event per giveaway id (it never changes) */
const created = new Map<bigint, Created>()

const pub = (() => {
  const urls = network.chain.rpcUrls.default.http
  return createPublicClient({ chain: network.chain, transport: fallback(urls.map((u) => http(u, { timeout: 8_000 }))) })
})()
const wallet = () => {
  if (!window.ethereum) throw new Error('No browser wallet found. Install MetaMask or Rabby.')
  return createWalletClient({ chain: network.chain, transport: custom(window.ethereum) })
}
const read = <T>(functionName: string, args: unknown[] = []) =>
  pub.readContract({ address: network.picker, abi: pickerAbi, functionName, args } as never) as Promise<T>

// ------------------------------------------------------------------ helpers

function notice(msg?: string) {
  ui.notice.hidden = !msg
  ui.notice.textContent = msg ?? ''
}
const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)
function explorer(kind: 'tx' | 'address' | 'block', value: string, label = value): string {
  const base = network.chain.blockExplorers?.default.url
  return base ? `<a class="mono" href="${base}/${kind}/${value}" target="_blank" rel="noopener">${label}</a>` : label
}
function detail(label: string, html: string) {
  const dt = document.createElement('dt')
  dt.textContent = label
  const dd = document.createElement('dd')
  dd.innerHTML = html
  ui.details.append(dt, dd)
}
function errorMessage(e: unknown): string {
  if (e instanceof BaseError) {
    const revert = e.walk((err) => err instanceof ContractFunctionRevertedError)
    const name = revert instanceof ContractFunctionRevertedError ? revert.data?.errorName : undefined
    const friendly: Record<string, string> = {
      InvalidEntrantCount: `Add between 1 and ${MAX_ENTRANTS} addresses.`,
      InvalidWinnerCount: `Choose between 1 and ${MAX_WINNERS} winners, and no more than the number of entrants.`,
      TitleTooLong: `Keep the title under ${MAX_TITLE_BYTES} characters.`,
    }
    if (name && friendly[name]) return friendly[name]
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
const viewId = (): bigint | undefined => {
  const v = new URLSearchParams(location.search).get('id')
  return v && /^\d+$/.test(v) ? BigInt(v) : undefined
}

// ------------------------------------------------------------------ create view

/** Split on anything that isn't part of an address; keep valid ones, first occurrence only. */
function parseEntrants() {
  const tokens = ui.entrants.value.split(/[\s,;]+/).filter(Boolean)
  const seen = new Set<string>()
  const out: Address[] = []
  let dupes = 0
  const bad: string[] = []
  for (const t of tokens) {
    if (!isAddress(t, { strict: false })) {
      bad.push(t)
      continue
    }
    const a = getAddress(t)
    if (seen.has(a)) {
      dupes++
      continue
    }
    seen.add(a)
    out.push(a)
  }
  parsed = out
  const parts = [`${out.length} address${out.length === 1 ? '' : 'es'}`]
  if (dupes) parts.push(`${dupes} duplicate${dupes === 1 ? '' : 's'} removed`)
  if (bad.length) parts.push(`${bad.length} not an address (e.g. "${esc(bad[0]!.slice(0, 20))}") ignored`)
  if (out.length > MAX_ENTRANTS) parts.push(`too many: the limit is ${MAX_ENTRANTS}`)
  ui.parse.innerHTML = tokens.length ? parts.join(' · ') : ''
  ui.parse.classList.toggle('warn', bad.length > 0 || out.length > MAX_ENTRANTS)
  clampCount()
}

function maxWinners() {
  return Math.max(1, Math.min(MAX_WINNERS, parsed.length || 1))
}
function clampCount(n = Number(ui.count.value)) {
  ui.count.max = String(maxWinners())
  ui.count.value = String(Math.max(1, Math.min(maxWinners(), Math.floor(n) || 1)))
  renderCreate()
}
function renderCreate() {
  const n = Number(ui.count.value)
  const ok = parsed.length > 0 && parsed.length <= MAX_ENTRANTS && n <= parsed.length
  ui.create.disabled = !account || busy || !ok
  ui.create.textContent = !account
    ? 'Connect a wallet to start'
    : busy
      ? 'Waiting for your wallet…'
      : `Pick ${n} winner${n === 1 ? '' : 's'} from ${parsed.length}`
}

function fillSample() {
  const rnd = () => Array.from(crypto.getRandomValues(new Uint8Array(20)), (b) => b.toString(16).padStart(2, '0')).join('')
  ui.entrants.value = Array.from({ length: 25 }, () => getAddress(`0x${rnd()}`)).join('\n')
  if (!ui.title.value) ui.title.value = 'Sample giveaway'
  ui.count.value = '3'
  parseEntrants()
}

async function createGiveaway() {
  if (!account) return
  const title = ui.title.value.trim() || 'Untitled giveaway'
  if (new TextEncoder().encode(title).length > MAX_TITLE_BYTES) return notice(`Keep the title under ${MAX_TITLE_BYTES} characters.`)
  busy = true
  notice()
  renderCreate()
  try {
    await ensureChain()
    const hash = await wallet().writeContract({
      account,
      chain: network.chain,
      address: network.picker,
      abi: pickerAbi,
      functionName: 'createGiveaway',
      args: [title, parsed, Number(ui.count.value)],
    })
    ui.create.textContent = 'Fixing the list on-chain…'
    const receipt = await pub.waitForTransactionReceipt({ hash })
    const [ev] = parseEventLogs({ abi: pickerAbi, eventName: 'GiveawayCreated', logs: receipt.logs })
    if (!ev) throw new Error('GiveawayCreated event not found in the receipt')
    created.set(ev.args.id, { title: ev.args.title, entrants: ev.args.entrants, requestId: ev.args.requestId, tx: hash })
    history.pushState(null, '', `?id=${ev.args.id}`)
    await route()
  } catch (e) {
    notice(errorMessage(e))
  } finally {
    busy = false
    renderCreate()
  }
}

async function loadCreated(id: bigint, block: bigint): Promise<Created | undefined> {
  const have = created.get(id)
  if (have) return have
  const [log] = await pub.getContractEvents({
    address: network.picker,
    abi: pickerAbi,
    eventName: 'GiveawayCreated',
    args: { id },
    fromBlock: block,
    toBlock: block,
  })
  if (!log) return undefined
  const c = { title: log.args.title!, entrants: log.args.entrants!, requestId: log.args.requestId!, tx: log.transactionHash as Hash }
  created.set(id, c)
  return c
}

async function loadRecent() {
  try {
    const total = await read<bigint>('giveawayCount')
    ui.recentEmpty.hidden = total > 0n
    const ids: bigint[] = []
    for (let i = total; i > 0n && ids.length < RECENT; i--) ids.push(i)
    const rows = await Promise.all(
      ids.map(async (id) => {
        const g = await read<Giveaway>('getGiveaway', [id])
        const c = await loadCreated(id, g.createdBlock).catch(() => undefined)
        return { id, g, c }
      }),
    )
    ui.recent.replaceChildren(
      ...rows.map(({ id, g, c }) => {
        const li = document.createElement('li')
        const status = g.state === State.Drawn ? '<span class="pill open">Drawn</span>' : '<span class="pill">Drawing</span>'
        li.innerHTML = `<a href="?id=${id}"><span class="t">#${id} ${esc(c?.title ?? 'Giveaway')}</span><span class="muted small">${g.winnerCount} of ${g.entrantCount}</span>${status}</a>`
        return li
      }),
    )
  } catch (e) {
    ui.recentEmpty.hidden = false
    ui.recentEmpty.textContent = `Could not load recent giveaways: ${errorMessage(e)}`
  }
}

// ------------------------------------------------------------------ result view

let pollTimer: number | undefined

function setStep(step: 'confirming' | 'fulfilled') {
  const order = ['requested', 'confirming', 'fulfilled']
  const at = order.indexOf(step)
  ui.steps.querySelectorAll<HTMLLIElement>('li').forEach((li, i) => {
    li.classList.toggle('done', i < at || step === 'fulfilled')
    li.classList.toggle('active', i === at && step !== 'fulfilled')
  })
}

async function showGiveaway(id: bigint) {
  window.clearTimeout(pollTimer)
  try {
    const total = await read<bigint>('giveawayCount')
    if (id < 1n || id > total) {
      ui.gTitle.textContent = `Giveaway #${id}`
      ui.gStatus.textContent = 'Not found'
      ui.gMeta.textContent = 'There is no giveaway with this number on PulseChain Testnet v4.'
      ui.steps.hidden = true
      return
    }
    ui.steps.hidden = false
    const g = await read<Giveaway>('getGiveaway', [id])
    const c = await loadCreated(id, g.createdBlock)
    ui.gTitle.textContent = c?.title || `Giveaway #${id}`
    document.title = `${c?.title ?? 'Giveaway'} · Verity Giveaway Picker`
    ui.gMeta.innerHTML = `Giveaway #${id} · ${g.winnerCount} winner${g.winnerCount === 1 ? '' : 's'} from ${g.entrantCount} entrants · created by ${explorer('address', g.creator, short(g.creator))}`

    ui.details.replaceChildren()
    const requestId = c?.requestId ?? (await read<bigint>('requestOf', [id]))
    detail('Created in', c ? `${explorer('tx', c.tx, short(c.tx))} (block ${g.createdBlock})` : `block ${g.createdBlock}`)
    detail('Request id', `<span class="mono">0x${requestId.toString(16)}</span>`)
    detail('List hash', `<span class="mono">${g.entrantsHash}</span>`)
    renderEntrants(c?.entrants ?? [], [])

    if (g.state !== State.Drawn) {
      const head = await pub.getBlockNumber()
      const conf = head > g.createdBlock ? head - g.createdBlock : 0n
      setStep('confirming')
      ui.conf.textContent = conf < confirmations ? `(${conf} / ${confirmations})` : `(${confirmations} / ${confirmations}) · proving…`
      ui.gStatus.textContent = 'Drawing…'
      ui.gStatus.className = 'pill'
      ui.winners.hidden = true
      ui.checkView.hidden = false
      ui.check.className = 'check'
      ui.check.textContent = 'Waiting for the random number.'
      if (head > g.createdBlock + 256n) {
        ui.gStatus.textContent = 'No answer'
        ui.check.textContent = 'The oracle did not answer within 256 blocks. This giveaway will not be drawn; create a new one.'
        return
      }
      pollTimer = window.setTimeout(() => void showGiveaway(id), POLL_MS)
      return
    }

    setStep('fulfilled')
    ui.conf.textContent = ''
    ui.gStatus.textContent = 'Winners drawn'
    ui.gStatus.className = 'pill open'
    const idx = await read<readonly bigint[]>('winnerIndices', [id])
    const list = c?.entrants ?? []
    ui.winners.hidden = false
    ui.winners.replaceChildren(
      ...idx.map((i, rank) => {
        const li = document.createElement('li')
        const a = list[Number(i)]
        const you = a && account && a.toLowerCase() === account.toLowerCase() ? '<span class="you">you</span>' : ''
        li.innerHTML = `<span class="rank">#${rank + 1}</span>${a ? explorer('address', a) : '<span class="muted">unknown</span>'}${you}<span class="muted small pos">entry ${Number(i) + 1}</span>`
        return li
      }),
    )
    renderEntrants(list, idx)

    // the contract recomputes the winners from the published list and checks it matches the one fixed at creation
    ui.checkView.hidden = false
    if (list.length) {
      try {
        const onchain = await read<readonly Address[]>('winnersFrom', [id, list])
        const same = onchain.length === idx.length && onchain.every((a, k) => a === list[Number(idx[k])])
        ui.check.className = same ? 'check ok' : 'check bad'
        ui.check.textContent = same
          ? `✓ Verified on-chain: the contract recomputed these ${onchain.length} winner${onchain.length === 1 ? '' : 's'} from the published list of ${list.length}, and the list matches the one fixed when the giveaway was created.`
          : '✗ The on-chain check did not match. Please report this.'
      } catch (e) {
        ui.check.className = 'check bad'
        ui.check.textContent = `On-chain check failed: ${errorMessage(e)}`
      }
    }
    detail('Random word', `<span class="mono">0x${g.randomWord.toString(16).padStart(64, '0')}</span>`)
    const [log] = await pub.getContractEvents({
      address: network.coordinator,
      abi: coordinatorAbi,
      eventName: 'RandomWordsFulfilled',
      args: { requestId },
      fromBlock: g.createdBlock,
    })
    if (log) {
      detail('Proof tx', explorer('tx', log.transactionHash as Hash, short(log.transactionHash as Hash)))
      detail('Fulfilled in block', `${log.blockNumber} (${log.blockNumber - g.createdBlock} blocks after creation)`)
      detail('Oracle fee', `${Number(formatEther(log.args.payment!)).toFixed(4)} ${sym}`)
    }
  } catch (e) {
    notice(`Could not load the giveaway: ${errorMessage(e)}`)
    pollTimer = window.setTimeout(() => void showGiveaway(id), POLL_MS * 2)
  }
}

function renderEntrants(list: readonly Address[], winners: readonly bigint[]) {
  const win = new Set(winners.map(Number))
  ui.entrantsCount.textContent = String(list.length)
  ui.entrantList.replaceChildren(
    ...list.map((a, i) => {
      const li = document.createElement('li')
      li.className = win.has(i) ? 'won' : ''
      li.innerHTML = `<span class="mono">${a}</span>${win.has(i) ? '<span class="you">winner</span>' : ''}`
      return li
    }),
  )
}

// ------------------------------------------------------------------ routing + wiring

async function route() {
  const id = viewId()
  ui.createView.hidden = id !== undefined
  ui.recentView.hidden = id !== undefined
  ui.resultView.hidden = id === undefined
  ui.checkView.hidden = true
  window.clearTimeout(pollTimer)
  if (id === undefined) {
    document.title = 'Verity Giveaway Picker · PulseInput'
    await loadRecent()
  } else {
    await showGiveaway(id)
  }
}

async function connect() {
  try {
    const [addr] = await wallet().requestAddresses()
    account = addr
    await ensureChain()
    ui.account.textContent = account ?? ''
    ui.connect.textContent = 'Connected'
    renderCreate()
  } catch (e) {
    notice(errorMessage(e))
  }
}

ui.connect.addEventListener('click', connect)
ui.sample.addEventListener('click', fillSample)
ui.entrants.addEventListener('input', parseEntrants)
ui.minus.addEventListener('click', () => clampCount(Number(ui.count.value) - 1))
ui.plus.addEventListener('click', () => clampCount(Number(ui.count.value) + 1))
ui.count.addEventListener('change', () => clampCount())
ui.create.addEventListener('click', () => void createGiveaway())
ui.copy.addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(location.href)
    ui.copy.textContent = 'Link copied'
    setTimeout(() => (ui.copy.textContent = 'Copy link'), 1500)
  } catch {
    notice('Copy failed: select the address bar and copy the link.')
  }
})
window.addEventListener('popstate', () => void route())
window.ethereum?.on?.('accountsChanged', (accs: Address[]) => {
  account = accs[0]
  ui.account.textContent = account ?? ''
  ui.connect.textContent = account ? 'Connected' : 'Connect wallet'
  renderCreate()
})

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
  read<number>('confirmations')
    .then((c) => (confirmations = BigInt(c)))
    .catch(() => {})
  parseEntrants()
  await route()
})()
