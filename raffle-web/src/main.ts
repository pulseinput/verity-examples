import {
  BaseError,
  ContractFunctionRevertedError,
  createPublicClient,
  createWalletClient,
  custom,
  fallback,
  formatEther,
  http,
  type Address,
  type EIP1193Provider,
  type Hash,
} from 'viem'
import { coordinatorAbi, raffleAbi, State } from './abi'
import { network } from './networks'
import { api, timeAgo, type Page, type Vrf } from './history'

declare global {
  interface Window {
    ethereum?: EIP1193Provider
  }
}

const POLL_MS = 4000
const MAX_PLAYERS_SHOWN = 200

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T
const ui = {
  connect: $<HTMLButtonElement>('connect'),
  account: $<HTMLSpanElement>('account'),
  notice: $<HTMLParagraphElement>('notice'),
  winnings: $<HTMLDivElement>('winnings'),
  winningsAmount: $<HTMLElement>('winnings-amount'),
  withdraw: $<HTMLButtonElement>('withdraw'),
  roundTitle: $<HTMLHeadingElement>('round-title'),
  roundStatus: $<HTMLSpanElement>('round-status'),
  pot: $<HTMLSpanElement>('pot'),
  tickets: $<HTMLSpanElement>('tickets'),
  mine: $<HTMLSpanElement>('mine'),
  chance: $<HTMLSpanElement>('chance'),
  buyBox: $<HTMLDivElement>('buy-box'),
  count: $<HTMLInputElement>('count'),
  minus: $<HTMLButtonElement>('minus'),
  plus: $<HTMLButtonElement>('plus'),
  buy: $<HTMLButtonElement>('buy'),
  drawBox: $<HTMLDivElement>('draw-box'),
  draw: $<HTMLButtonElement>('draw'),
  roundHint: $<HTMLParagraphElement>('round-hint'),
  playersCount: $<HTMLSpanElement>('players-count'),
  players: $<HTMLUListElement>('players'),
  playersPager: $<HTMLElement>('players-pager'),
  lastBox: $<HTMLElement>('last-box'),
  lastTitle: $<HTMLHeadingElement>('last-title'),
  steps: $<HTMLOListElement>('steps'),
  conf: $<HTMLSpanElement>('conf'),
  winnerBox: $<HTMLDivElement>('winner-box'),
  winner: $<HTMLSpanElement>('winner'),
  winnerYou: $<HTMLSpanElement>('winner-you'),
  details: $<HTMLDListElement>('details'),
  refundBox: $<HTMLDivElement>('refund-box'),
  enableRefunds: $<HTMLButtonElement>('enable-refunds'),
  refund: $<HTMLButtonElement>('refund'),
}

type Round = {
  state: number
  closesAt: bigint
  drawRequestedAt: bigint
  tickets: bigint
  winner: Address
  winningTicket: bigint
  pot: bigint
}

const sym = network.chain.nativeCurrency.symbol
const ZERO = '0x0000000000000000000000000000000000000000'

let account: Address | undefined
let busy = false
let config: { price: bigint; confirmations: bigint; refundAfter: bigint; maxBuy: bigint } | undefined
let current: { id: bigint; round: Round; mine: bigint } | undefined
let last: { id: bigint; round: Round; requestId: bigint; mine: bigint } | undefined
/** Proof details per request id, fetched once */
const proofs = new Map<bigint, { tx: Hash; block: bigint; output: bigint; payment: bigint }>()

const pub = (() => {
  const urls = network.chain.rpcUrls.default.http
  return createPublicClient({ chain: network.chain, transport: fallback(urls.map((u) => http(u, { timeout: 8_000 }))) })
})()
const wallet = () => {
  if (!window.ethereum) throw new Error('No browser wallet found. Install MetaMask or Rabby.')
  return createWalletClient({ chain: network.chain, transport: custom(window.ethereum) })
}
const read = <T>(functionName: string, args: unknown[] = []) =>
  pub.readContract({ address: network.raffle, abi: raffleAbi, functionName, args } as never) as Promise<T>

// ------------------------------------------------------------------ helpers

function notice(msg?: string) {
  ui.notice.hidden = !msg
  ui.notice.textContent = msg ?? ''
}

const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`
const pls = (wei: bigint) => {
  const s = formatEther(wei)
  const [i, f = ''] = s.split('.')
  const frac = f.slice(0, 4).replace(/0+$/, '')
  return `${Number(i).toLocaleString('en-US')}${frac ? '.' + frac : ''} ${sym}`
}
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
function countdown(secs: number): string {
  const m = Math.floor(secs / 60)
  const s = secs % 60
  return `${m}:${String(s).padStart(2, '0')}`
}

function errorMessage(e: unknown): string {
  if (e instanceof BaseError) {
    const revert = e.walk((err) => err instanceof ContractFunctionRevertedError)
    const name = revert instanceof ContractFunctionRevertedError ? revert.data?.errorName : undefined
    const friendly: Record<string, string> = {
      RoundClosed: 'This round has closed. Start the draw, then buy into the next round.',
      TooEarly: 'Too early: the round is still open.',
      NoTickets: 'Nobody has bought a ticket in this round yet.',
      WrongPayment: 'The amount sent does not match the ticket price.',
      InvalidTicketCount: `Buy between 1 and ${config?.maxBuy ?? 100} tickets at a time.`,
      NothingToWithdraw: 'You have no winnings to withdraw.',
      NothingToRefund: 'You have no tickets to refund in that round.',
      WrongState: 'The round has moved on. The page has been refreshed.',
    }
    if (name && friendly[name]) return friendly[name]
    if (/insufficient funds/i.test(e.message)) return `Not enough ${sym} in your wallet. Get test PLS from the faucet.`
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

/** Send a raffle transaction and wait for it; returns false if it failed (message shown). */
async function send(functionName: string, args: unknown[] = [], value?: bigint): Promise<boolean> {
  if (!account) return false
  busy = true
  notice()
  render()
  try {
    await ensureChain()
    const hash = await wallet().writeContract({
      account,
      chain: network.chain,
      address: network.raffle,
      abi: raffleAbi,
      functionName,
      args,
      value,
    } as never)
    const receipt = await pub.waitForTransactionReceipt({ hash })
    if (receipt.status !== 'success') throw new Error('The transaction reverted.')
    return true
  } catch (e) {
    notice(errorMessage(e))
    return false
  } finally {
    busy = false
    await refresh()
  }
}

// ------------------------------------------------------------------ data

async function loadConfig() {
  const [price, confirmations, refundAfter, maxBuy] = await Promise.all([
    read<bigint>('ticketPrice'),
    read<number>('confirmations'),
    read<bigint>('refundAfterBlocks'),
    read<bigint>('MAX_TICKETS_PER_BUY'),
  ])
  config = { price, confirmations: BigInt(confirmations), refundAfter, maxBuy }
  ui.count.max = String(maxBuy)
}

async function loadPlayers(r: bigint) {
  const entries = await read<{ buyer: Address; end: bigint }[]>('getEntries', [r, 0n, BigInt(MAX_PLAYERS_SHOWN)])
  const byBuyer = new Map<string, bigint>()
  let prev = 0n
  for (const e of entries) {
    byBuyer.set(e.buyer, (byBuyer.get(e.buyer) ?? 0n) + (e.end - prev))
    prev = e.end
  }
  const rows = [...byBuyer.entries()].sort((a, b) => (b[1] > a[1] ? 1 : b[1] < a[1] ? -1 : 0))
  ui.playersCount.textContent = String(rows.length)
  playerRows = rows.map(([buyer, n]) => {
    const li = document.createElement('li')
    const you = account && buyer.toLowerCase() === account.toLowerCase() ? ' <span class="you">you</span>' : ''
    li.innerHTML = `${explorer('address', buyer, short(buyer))}${you}<span class="n">${n} ticket${n === 1n ? '' : 's'}</span>`
    return li
  })
  showPlayers()
}

const PLAYERS_PER_PAGE = 20
let playerRows: HTMLLIElement[] = []
let playersPage = 0

function showPlayers() {
  const pages = Math.max(1, Math.ceil(playerRows.length / PLAYERS_PER_PAGE))
  playersPage = Math.min(playersPage, pages - 1)
  ui.players.replaceChildren(...playerRows.slice(playersPage * PLAYERS_PER_PAGE, (playersPage + 1) * PLAYERS_PER_PAGE))
  renderPager(ui.playersPager, playersPage, pages, (p) => {
    playersPage = p
    showPlayers()
  })
}

// ------------------------------------------------------------------ pagination

/** Draws "← Prev · Page x of y · Next →" into `box` (hidden when there is only one page). */
function renderPager(box: HTMLElement, page: number, pages: number, onPage: (p: number) => void) {
  box.hidden = pages <= 1
  if (box.hidden) return box.replaceChildren()
  const btn = (label: string, to: number, disabled: boolean) => {
    const b = document.createElement('button')
    b.type = 'button'
    b.className = 'small'
    b.textContent = label
    b.disabled = disabled
    b.addEventListener('click', () => onPage(to))
    return b
  }
  const info = document.createElement('span')
  info.className = 'muted small'
  info.textContent = `Page ${page + 1} of ${pages}`
  box.replaceChildren(btn('← Prev', page - 1, page === 0), info, btn('Next →', page + 1, page >= pages - 1))
}


async function loadProof(requestId: bigint, fromBlock: bigint) {
  if (proofs.has(requestId)) return
  const [log] = await pub.getContractEvents({
    address: network.coordinator,
    abi: coordinatorAbi,
    eventName: 'RandomWordsFulfilled',
    args: { requestId },
    fromBlock,
  })
  if (log) {
    proofs.set(requestId, {
      tx: log.transactionHash as Hash,
      block: log.blockNumber,
      output: log.args.outputSeed!,
      payment: log.args.payment!,
    })
  }
}

let head = 0n

async function refresh() {
  try {
    if (!config) await loadConfig()
    const id = await read<bigint>('currentRound')
    const [round, mine, h] = await Promise.all([
      read<Round>('getRound', [id]),
      account ? read<bigint>('ticketsOf', [id, account]) : Promise.resolve(0n),
      pub.getBlockNumber(),
    ])
    head = h
    current = { id, round, mine }
    await loadPlayers(id)

    if (id > 1n) {
      const lid = id - 1n
      const [lround, requestId, lmine] = await Promise.all([
        read<Round>('getRound', [lid]),
        read<bigint>('drawRequestOf', [lid]),
        account ? read<bigint>('ticketsOf', [lid, account]) : Promise.resolve(0n),
      ])
      last = { id: lid, round: lround, requestId, mine: lmine }
      if (lround.state === State.Won) await loadProof(requestId, lround.drawRequestedAt)
    }

    if (account) {
      const w = await read<bigint>('winnings', [account])
      ui.winnings.hidden = w === 0n
      ui.winningsAmount.textContent = pls(w)
    }
    render()
  } catch (e) {
    notice(`Could not read the raffle: ${errorMessage(e)}`)
  }
}

// ------------------------------------------------------------------ view

function render() {
  if (!current || !config) return
  const { id, round, mine } = current
  const now = Math.floor(Date.now() / 1000)
  const closes = Number(round.closesAt)
  const notStarted = round.closesAt === 0n
  const closed = !notStarted && now >= closes

  ui.roundTitle.textContent = `Round ${id}`
  ui.pot.textContent = pls(round.pot)
  ui.tickets.textContent = round.tickets.toString()
  ui.mine.textContent = account ? mine.toString() : '–'
  ui.chance.textContent =
    account && round.tickets > 0n ? `${((Number(mine) / Number(round.tickets)) * 100).toFixed(mine === round.tickets ? 0 : 1)}%` : '–'

  ui.roundStatus.className = 'pill'
  if (notStarted) {
    ui.roundStatus.textContent = 'Waiting for the first ticket'
    ui.roundHint.textContent = `The ${countdown(5 * 60)} countdown starts when someone buys the first ticket. A ticket costs ${pls(config.price)}.`
  } else if (!closed) {
    ui.roundStatus.textContent = `Closes in ${countdown(closes - now)}`
    ui.roundStatus.classList.add('open')
    ui.roundHint.textContent = `A ticket costs ${pls(config.price)}. The winner takes the whole pot.`
  } else {
    ui.roundStatus.textContent = 'Closed: ready to draw'
    ui.roundStatus.classList.add('closed')
    ui.roundHint.textContent = 'Today anyone can press the button. PulseInput Automation (coming soon) will run draws by itself.'
  }

  ui.buyBox.hidden = closed
  ui.drawBox.hidden = !closed
  const n = Math.max(1, Math.min(Number(config.maxBuy), Math.floor(Number(ui.count.value) || 1)))
  ui.buy.textContent = account ? `Buy ${n} ticket${n === 1 ? '' : 's'} · ${pls(config.price * BigInt(n))}` : 'Connect a wallet to buy'
  ui.buy.disabled = !account || busy
  ui.draw.disabled = !account || busy
  ui.draw.textContent = account ? 'Draw the winner' : 'Connect a wallet to draw'
  ui.withdraw.disabled = busy

  renderLast()
}

function setStep(step: 'requested' | 'confirming' | 'fulfilled') {
  const order = ['requested', 'confirming', 'fulfilled']
  const at = order.indexOf(step)
  ui.steps.querySelectorAll<HTMLLIElement>('li').forEach((li, i) => {
    li.classList.toggle('done', i < at || step === 'fulfilled')
    li.classList.toggle('active', i === at && step !== 'fulfilled')
  })
}

function renderLast() {
  if (!last || !config) {
    ui.lastBox.hidden = true
    return
  }
  const { id, round, requestId, mine } = last
  ui.lastBox.hidden = false
  ui.lastTitle.textContent = `Round ${id} draw`
  ui.details.replaceChildren()
  ui.winnerBox.hidden = true
  ui.refundBox.hidden = true

  const reqBlock = round.drawRequestedAt
  const conf = head > reqBlock ? head - reqBlock : 0n
  detail('Pot', pls(round.pot))
  detail('Tickets', round.tickets.toString())
  detail('Request id', `<span class="mono">0x${requestId.toString(16)}</span>`)
  detail('Requested in block', explorer('block', reqBlock.toString()))

  if (round.state === State.Drawing) {
    if (conf < config.confirmations) {
      setStep('confirming')
      ui.conf.textContent = `(${conf} / ${config.confirmations})`
    } else {
      setStep('confirming')
      ui.conf.textContent = `(${config.confirmations} / ${config.confirmations}) · proving…`
    }
    if (head > reqBlock + config.refundAfter) {
      ui.refundBox.hidden = false
      ui.enableRefunds.hidden = false
      ui.refund.hidden = true
      ui.enableRefunds.disabled = !account || busy
    }
  } else if (round.state === State.Won) {
    setStep('fulfilled')
    ui.conf.textContent = ''
    ui.winnerBox.hidden = false
    ui.winner.innerHTML = explorer('address', round.winner)
    ui.winnerYou.hidden = !account || round.winner.toLowerCase() !== account.toLowerCase()
    detail('Winning ticket', `#${round.winningTicket + 1n} of ${round.tickets}`)
    detail('Prize', pls(round.pot))
    const p = proofs.get(requestId)
    if (p) {
      detail('Proof tx', explorer('tx', p.tx))
      detail('Fulfilled in block', `${explorer('block', p.block.toString())} (${p.block - reqBlock} blocks after the request)`)
      detail('VRF output', `<span class="mono">0x${p.output.toString(16).padStart(64, '0')}</span>`)
      detail('Oracle fee', pls(p.payment))
    }
  } else if (round.state === State.Refunding) {
    setStep('confirming')
    ui.conf.textContent = '(no answer: refunded)'
    ui.refundBox.hidden = false
    ui.enableRefunds.hidden = true
    ui.refund.hidden = !account || mine === 0n
    ui.refund.disabled = busy
  }
  if (round.winner === ZERO) ui.winnerYou.hidden = true
}

// ------------------------------------------------------------------ actions

async function connect() {
  try {
    const [addr] = await wallet().requestAddresses()
    account = addr
    await ensureChain()
    ui.account.textContent = account ?? ''
    ui.connect.textContent = 'Connected'
    await refresh()
  } catch (e) {
    notice(errorMessage(e))
  }
}

function setCount(n: number) {
  const max = Number(config?.maxBuy ?? 100)
  ui.count.value = String(Math.max(1, Math.min(max, Math.floor(n) || 1)))
  render()
}

ui.connect.addEventListener('click', connect)
ui.minus.addEventListener('click', () => setCount(Number(ui.count.value) - 1))
ui.plus.addEventListener('click', () => setCount(Number(ui.count.value) + 1))
ui.count.addEventListener('change', () => setCount(Number(ui.count.value)))
ui.count.addEventListener('input', render)
ui.buy.addEventListener('click', () => {
  if (!config) return
  const n = BigInt(Math.max(1, Math.min(Number(config.maxBuy), Math.floor(Number(ui.count.value) || 1))))
  void send('buyTickets', [n], config.price * n)
})
ui.draw.addEventListener('click', () => void send('draw'))
ui.withdraw.addEventListener('click', () => void send('withdraw'))
ui.enableRefunds.addEventListener('click', () => last && void send('enableRefunds', [last.id]))
ui.refund.addEventListener('click', () => last && void send('refund', [last.id]))

window.ethereum?.on?.('accountsChanged', (accs: Address[]) => {
  account = accs[0]
  ui.account.textContent = account ?? ''
  ui.connect.textContent = account ? 'Connected' : 'Connect wallet'
  void refresh()
})

// Reconnect silently if the site is already authorised in the wallet.
void (async () => {
  try {
    // a stuck wallet extension must not keep the page from loading: give it 2 s
    const accs = (await Promise.race([
      window.ethereum?.request({ method: 'eth_accounts' }),
      new Promise((r) => setTimeout(() => r(undefined), 2000)),
    ])) as Address[] | undefined
    if (accs?.[0]) {
      account = accs[0]
      ui.account.textContent = account
      ui.connect.textContent = 'Connected'
    }
  } catch {
    /* no wallet */
  }
  await refresh()
})()

// Countdown every second; chain state every few seconds (paused while a transaction is in flight).
setInterval(render, 1000)

// ------------------------------------------------------------------ past rounds (demos indexer)

interface PastRound {
  round: number
  tickets: number
  pot: string
  players: number
  state: string
  winner: string | null
  winning_ticket: number | null
  prize: string | null
  draw_ts: number | null
  won_ts: number | null
  won_tx: string | null
  draw_tx: string | null
  vrf: Vrf | null
}
const PAST_PER_PAGE = 10
let pastPage = 0
const appUrl = ((import.meta.env.VITE_VERITY_APP_URL as string | undefined) ?? 'https://app.pulseinput.com').replace(/\/$/, '')
const pastUi = {
  box: document.getElementById('past-box') as HTMLElement,
  list: document.getElementById('past') as HTMLUListElement,
  empty: document.getElementById('past-empty') as HTMLParagraphElement,
  pager: document.getElementById('past-pager') as HTMLElement,
}

function pastRow(r: PastRound): HTMLLIElement {
  const li = document.createElement('li')
  const you = r.winner && account && r.winner.toLowerCase() === account.toLowerCase() ? ' <span class="you">you</span>' : ''
  const when = r.won_ts ?? r.draw_ts
  let head: string
  if (r.state === 'won' && r.winner) {
    head = `<b>Round ${r.round}</b> won by ${explorer('address', r.winner, short(r.winner))}${you} · <b>${pls(BigInt(r.prize ?? r.pot))}</b>`
  } else if (r.state === 'refunding') {
    head = `<b>Round ${r.round}</b> no answer in time: players refunded`
  } else {
    head = `<b>Round ${r.round}</b> drawing…`
  }
  const proof = r.vrf ? ` · <a href="${appUrl}/#/requests/${r.vrf.request_id}" target="_blank" rel="noopener">draw proof</a>` : ''
  const tx = r.won_tx ? ` · ${explorer('tx', r.won_tx, 'winner tx')}` : ''
  const ticket = r.winning_ticket !== null && r.state === 'won' ? `winning ticket #${r.winning_ticket + 1} of ${r.tickets}` : `${r.tickets} tickets`
  li.innerHTML = `<div class="top">${head}<span class="when muted small">${when ? timeAgo(when) : ''}</span></div>
    <div class="sub2">${ticket} · ${r.players} player${r.players === 1 ? '' : 's'}${proof}${tx}</div>`
  return li
}

async function loadPast() {
  if (!network.demosApi) return
  try {
    const p = await api<Page<PastRound>>(network.demosApi, `/raffle/rounds?page=${pastPage}&per=${PAST_PER_PAGE}`)
    pastUi.box.hidden = false
    pastUi.list.replaceChildren(...p.items.map(pastRow))
    pastUi.empty.hidden = p.total > 0
    renderPager(pastUi.pager, p.page, p.pages, (n) => {
      pastPage = n
      void loadPast()
    })
  } catch {
    pastUi.box.hidden = true
  }
}
void loadPast()
setInterval(() => {
  if (document.visibilityState === 'visible') void loadPast()
}, 10_000)
setInterval(() => {
  if (!busy && document.visibilityState === 'visible') void refresh()
}, POLL_MS)
