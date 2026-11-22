import {
  BaseError,
  ContractFunctionRevertedError,
  createPublicClient,
  createWalletClient,
  custom,
  fallback,
  formatEther,
  http,
  parseEther,
  parseEventLogs,
  type Address,
  type EIP1193Provider,
  type Hash,
} from 'viem'
import { coinAbi, coordinatorAbi, Side, SIDES, State } from './abi'
import { network } from './networks'

declare global {
  interface Window {
    ethereum?: EIP1193Provider
  }
}

const POLL_MS = 4000
const SCAN = 40 // how many recent flips to look at for the lists
const ZERO = '0x0000000000000000000000000000000000000000'

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T
const ui = {
  connect: $<HTMLButtonElement>('connect'),
  account: $<HTMLSpanElement>('account'),
  notice: $<HTMLParagraphElement>('notice'),
  owed: $<HTMLDivElement>('owed'),
  owedAmount: $<HTMLElement>('owed-amount'),
  withdraw: $<HTMLButtonElement>('withdraw'),
  flipView: $<HTMLElement>('flip-view'),
  fTitle: $<HTMLHeadingElement>('f-title'),
  fStatus: $<HTMLSpanElement>('f-status'),
  coin: $<HTMLDivElement>('coin'),
  fResult: $<HTMLParagraphElement>('f-result'),
  fHeads: $<HTMLSpanElement>('f-heads'),
  fTails: $<HTMLSpanElement>('f-tails'),
  steps: $<HTMLOListElement>('steps'),
  conf: $<HTMLSpanElement>('conf'),
  fActions: $<HTMLDivElement>('f-actions'),
  details: $<HTMLDListElement>('details'),
  createView: $<HTMLElement>('create-view'),
  pickHeads: $<HTMLButtonElement>('pick-heads'),
  pickTails: $<HTMLButtonElement>('pick-tails'),
  stake: $<HTMLInputElement>('stake'),
  create: $<HTMLButtonElement>('create'),
  open: $<HTMLUListElement>('open'),
  openPager: $<HTMLElement>('open-pager'),
  openEmpty: $<HTMLParagraphElement>('open-empty'),
  recent: $<HTMLUListElement>('recent'),
  recentEmpty: $<HTMLParagraphElement>('recent-empty'),
}

type Flip = {
  creator: Address
  creatorSide: number
  state: number
  result: number
  joiner: Address
  joinedBlock: bigint
  winner: Address
  stake: bigint
}

const sym = network.chain.nativeCurrency.symbol
let account: Address | undefined
let busy = false
let side: number = Side.Heads
let confirmations = 3n
let refundAfter = 300n
let pollTimer: number | undefined
let landedId: bigint | undefined // the coin animation has landed for this flip

const pub = (() => {
  const urls = network.chain.rpcUrls.default.http
  return createPublicClient({ chain: network.chain, transport: fallback(urls.map((u) => http(u, { timeout: 8_000 }))) })
})()
const wallet = () => {
  if (!window.ethereum) throw new Error('No browser wallet found. Install MetaMask or Rabby.')
  return createWalletClient({ chain: network.chain, transport: custom(window.ethereum) })
}
const read = <T>(functionName: string, args: unknown[] = []) =>
  pub.readContract({ address: network.coin, abi: coinAbi, functionName, args } as never) as Promise<T>

// ------------------------------------------------------------------ helpers

function notice(msg?: string) {
  ui.notice.hidden = !msg
  ui.notice.textContent = msg ?? ''
}
const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`
const same = (a?: string, b?: string) => !!a && !!b && a.toLowerCase() === b.toLowerCase()
const isMe = (a?: string) => same(a, account)
const who = (a: string) => (isMe(a) ? 'You' : short(a))
const pls = (wei: bigint) => `${Number(formatEther(wei)).toLocaleString('en-US', { maximumFractionDigits: 4 })} ${sym}`
const explorerBase = network.chain.blockExplorers?.default.url ?? ''
const explorer = (kind: 'tx' | 'address' | 'block', v: string, label = v) =>
  `<a class="mono" href="${explorerBase}/${kind}/${v}" target="_blank" rel="noopener">${label}</a>`
const viewId = (): bigint | undefined => {
  const v = new URLSearchParams(location.search).get('id')
  return v && /^\d+$/.test(v) ? BigInt(v) : undefined
}
function go(id?: bigint) {
  history.pushState(null, '', id === undefined ? './' : `?id=${id}`)
  void route()
}

function errorMessage(e: unknown): string {
  if (e instanceof BaseError) {
    const revert = e.walk((err) => err instanceof ContractFunctionRevertedError)
    const name = revert instanceof ContractFunctionRevertedError ? revert.data?.errorName : undefined
    const friendly: Record<string, string> = {
      InvalidStake: `Stake between 0.01 and 10,000 ${sym}.`,
      WrongState: 'This flip has already moved on. The page has been refreshed.',
      WrongPayment: 'Send exactly the same stake as the creator.',
      NotCreator: 'Only the creator can cancel this flip.',
      TooEarly: 'Too early: refunds open 300 blocks after joining.',
      NothingToWithdraw: 'Nothing to withdraw.',
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

/** Send a transaction to the coin flip contract; returns the receipt logs or undefined (message shown). */
async function send(functionName: string, args: unknown[] = [], value?: bigint) {
  if (!account) return undefined
  busy = true
  notice()
  renderButtons()
  try {
    await ensureChain()
    const hash = await wallet().writeContract({
      account,
      chain: network.chain,
      address: network.coin,
      abi: coinAbi,
      functionName,
      args,
      value,
    } as never)
    const receipt = await pub.waitForTransactionReceipt({ hash })
    if (receipt.status !== 'success') throw new Error('The transaction reverted.')
    return receipt.logs
  } catch (e) {
    notice(errorMessage(e))
    return undefined
  } finally {
    busy = false
    renderButtons()
    void refreshLists()
  }
}

// ------------------------------------------------------------------ create + lists

function pick(s: number) {
  side = s
  ui.pickHeads.classList.toggle('on', s === Side.Heads)
  ui.pickTails.classList.toggle('on', s === Side.Tails)
  ui.pickHeads.setAttribute('aria-checked', String(s === Side.Heads))
  ui.pickTails.setAttribute('aria-checked', String(s === Side.Tails))
  renderButtons()
}
function stakeWei(): bigint | undefined {
  try {
    const v = parseEther(ui.stake.value || '0')
    return v >= parseEther('0.01') && v <= parseEther('10000') ? v : undefined
  } catch {
    return undefined
  }
}
function renderButtons() {
  const s = stakeWei()
  ui.create.disabled = !account || busy || s === undefined
  ui.create.textContent = !account
    ? 'Connect a wallet to play'
    : s === undefined
      ? `Stake 0.01 to 10,000 ${sym}`
      : `Create flip: ${SIDES[side]} for ${pls(s)}`
  ui.withdraw.disabled = busy
  ui.flipView.querySelectorAll('button').forEach((b) => (b.disabled = busy || !account))
  ui.open.querySelectorAll('button').forEach((b) => (b.disabled = busy || !account))
}

async function createFlip() {
  const s = stakeWei()
  if (s === undefined) return
  const logs = await send('createFlip', [side], s)
  const [ev] = logs ? parseEventLogs({ abi: coinAbi, eventName: 'FlipCreated', logs }) : []
  if (ev) go(ev.args.id)
}

async function join(id: bigint, stake: bigint) {
  const logs = await send('joinFlip', [id], stake)
  if (logs) go(id)
}

async function loadFlips(): Promise<{ id: bigint; f: Flip }[]> {
  const total = await read<bigint>('flipCount')
  const ids: bigint[] = []
  for (let i = total; i > 0n && ids.length < SCAN; i--) ids.push(i)
  const flips = await Promise.all(ids.map((id) => read<Flip>('getFlip', [id])))
  return ids.map((id, k) => ({ id, f: flips[k]! }))
}

function flipRow(id: bigint, f: Flip, action?: HTMLElement): HTMLLIElement {
  const li = document.createElement('li')
  const a = document.createElement('a')
  a.href = `?id=${id}`
  a.addEventListener('click', (e) => {
    e.preventDefault()
    go(id)
  })
  let text: string
  if (f.state === State.Open) {
    text = `<b>#${id}</b> ${who(f.creator)} picked <b>${SIDES[f.creatorSide]}</b> · ${pls(f.stake)}`
  } else if (f.state === State.Settled) {
    text = `<b>#${id}</b> <span class="coin-mini ${f.result === Side.Heads ? 'h' : 't'}">${f.result === Side.Heads ? 'H' : 'T'}</span> ${who(f.winner)} won ${pls(f.stake * 2n)}`
  } else if (f.state === State.Flipping) {
    text = `<b>#${id}</b> flipping… ${pls(f.stake)} each`
  } else {
    text = `<b>#${id}</b> ${f.state === State.Cancelled ? 'cancelled' : 'refunded'}`
  }
  a.innerHTML = text
  li.append(a)
  if (action) li.append(action)
  return li
}

const OPEN_PER_PAGE = 8
let openRows: HTMLLIElement[] = []
let openPage = 0

function showOpen() {
  const pages = Math.max(1, Math.ceil(openRows.length / OPEN_PER_PAGE))
  openPage = Math.min(openPage, pages - 1)
  ui.open.replaceChildren(...openRows.slice(openPage * OPEN_PER_PAGE, (openPage + 1) * OPEN_PER_PAGE))
  renderPager(ui.openPager, openPage, pages, (p) => {
    openPage = p
    showOpen()
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

async function refreshLists() {
  try {
    const flips = await loadFlips()
    const open = flips.filter(({ f }) => f.state === State.Open)
    ui.openEmpty.hidden = open.length > 0
    openRows = open.map(({ id, f }) => {
        const b = document.createElement('button')
        if (isMe(f.creator)) {
          b.textContent = 'Flip solo'
          b.title = 'Join your own flip to see how it works: the stakes come back to you.'
        } else {
          b.textContent = `Take ${SIDES[1 - f.creatorSide]}`
          b.className = 'primary small'
        }
        b.disabled = busy || !account
        b.addEventListener('click', () => void join(id, f.stake))
        return flipRow(id, f, b)
      })
    showOpen()
    const done = flips.filter(({ f }) => f.state === State.Settled).slice(0, 10)
    ui.recentEmpty.hidden = done.length > 0
    ui.recent.replaceChildren(...done.map(({ id, f }) => flipRow(id, f)))
    if (account) {
      const owed = await read<bigint>('balances', [account])
      ui.owed.hidden = owed === 0n
      ui.owedAmount.textContent = pls(owed)
    }
  } catch (e) {
    notice(`Could not read the contract: ${errorMessage(e)}`)
  }
}

// ------------------------------------------------------------------ flip view

function setStep(step: 'requested' | 'confirming' | 'fulfilled' | 'none') {
  const order = ['requested', 'confirming', 'fulfilled']
  const at = order.indexOf(step)
  ui.steps.querySelectorAll<HTMLLIElement>('li').forEach((li, i) => {
    li.classList.toggle('done', at >= 0 && (i < at || step === 'fulfilled'))
    li.classList.toggle('active', i === at && step !== 'fulfilled')
  })
}
function coin(mode: 'idle' | 'spin' | 'heads' | 'tails') {
  ui.coin.className = `coin ${mode}`
}
function actionButton(label: string, cls: string, onClick: () => void) {
  const b = document.createElement('button')
  b.textContent = label
  if (cls) b.className = cls
  b.disabled = busy || !account
  b.addEventListener('click', onClick)
  ui.fActions.append(b)
}

async function showFlip(id: bigint) {
  window.clearTimeout(pollTimer)
  try {
    const total = await read<bigint>('flipCount')
    if (id < 1n || id > total) {
      ui.fTitle.textContent = `Flip #${id}`
      ui.fStatus.textContent = 'Not found'
      ui.fResult.textContent = 'There is no flip with this number on PulseChain Testnet v4.'
      ui.steps.hidden = true
      return
    }
    const f = await read<Flip>('getFlip', [id])
    ui.steps.hidden = f.state === State.Open || f.state === State.Cancelled
    ui.fTitle.textContent = `Flip #${id} · ${pls(f.stake)} each`
    const headsPlayer = f.creatorSide === Side.Heads ? f.creator : f.joiner
    const tailsPlayer = f.creatorSide === Side.Tails ? f.creator : f.joiner
    ui.fHeads.innerHTML = headsPlayer === ZERO ? '<span class="muted">open seat</span>' : explorer('address', headsPlayer, who(headsPlayer))
    ui.fTails.innerHTML = tailsPlayer === ZERO ? '<span class="muted">open seat</span>' : explorer('address', tailsPlayer, who(tailsPlayer))
    ui.fActions.replaceChildren()
    ui.details.replaceChildren()
    const detail = (k: string, v: string) => {
      const dt = document.createElement('dt')
      dt.textContent = k
      const dd = document.createElement('dd')
      dd.innerHTML = v
      ui.details.append(dt, dd)
    }

    if (f.state === State.Open) {
      coin('idle')
      ui.fStatus.textContent = 'Waiting for an opponent'
      ui.fStatus.className = 'pill'
      ui.fResult.textContent = isMe(f.creator)
        ? 'Share this page, or flip solo to see how it works (the stakes come back to you).'
        : `Take ${SIDES[1 - f.creatorSide]} by matching the ${pls(f.stake)} stake.`
      if (isMe(f.creator)) {
        actionButton('Flip solo', 'primary', () => void join(id, f.stake))
        actionButton('Cancel and refund', '', () => void send('cancelFlip', [id]).then(() => showFlip(id)))
      } else {
        actionButton(`Take ${SIDES[1 - f.creatorSide]} · ${pls(f.stake)}`, 'primary', () => void join(id, f.stake))
      }
      pollTimer = window.setTimeout(() => void showFlip(id), POLL_MS)
      return
    }
    if (f.state === State.Cancelled) {
      coin('idle')
      ui.fStatus.textContent = 'Cancelled'
      ui.fStatus.className = 'pill'
      ui.fResult.textContent = 'The creator cancelled this flip before anyone joined. Their stake was returned.'
      return
    }

    const requestId = await read<bigint>('requestOf', [id])
    detail('Request id', `<span class="mono">0x${requestId.toString(16)}</span>`)
    detail('Joined in block', explorer('block', f.joinedBlock.toString()))

    if (f.state === State.Flipping) {
      coin('spin')
      landedId = undefined
      const head = await pub.getBlockNumber()
      const conf = head > f.joinedBlock ? head - f.joinedBlock : 0n
      setStep('confirming')
      ui.conf.textContent = conf < confirmations ? `(${conf} / ${confirmations})` : `(${confirmations} / ${confirmations}) · proving…`
      ui.fStatus.textContent = 'Flipping…'
      ui.fStatus.className = 'pill open'
      ui.fResult.textContent = 'Both stakes are locked. Waiting for Verity to flip the coin.'
      if (head > f.joinedBlock + refundAfter) {
        ui.fResult.textContent = 'Verity did not answer in time, so both players can be refunded. The coin is never flipped again.'
        actionButton('Refund both players', 'primary', () => void send('refundUnanswered', [id]).then(() => showFlip(id)))
      }
      pollTimer = window.setTimeout(() => void showFlip(id), POLL_MS)
      return
    }
    if (f.state === State.Refunded) {
      coin('idle')
      setStep('confirming')
      ui.conf.textContent = '(no answer: refunded)'
      ui.fStatus.textContent = 'Refunded'
      ui.fStatus.className = 'pill closed'
      ui.fResult.textContent = 'Verity did not answer in time, so both stakes were returned.'
      return
    }

    // settled
    setStep('fulfilled')
    ui.conf.textContent = ''
    ui.fStatus.textContent = 'Settled'
    ui.fStatus.className = 'pill open'
    const face = f.result === Side.Heads ? 'heads' : 'tails'
    if (landedId !== id) {
      // spin briefly, then land, so a fresh result is visibly "flipped"
      coin('spin')
      landedId = id
      window.setTimeout(() => coin(face), 900)
    } else {
      coin(face)
    }
    const won = isMe(f.winner)
    const both = isMe(f.creator) && isMe(f.joiner)
    ui.fResult.innerHTML = `<b>${SIDES[f.result]}!</b> ${
      both ? `You played both sides, so the ${pls(f.stake * 2n)} came back to you.` : won ? `You won ${pls(f.stake * 2n)}.` : `${who(f.winner)} won ${pls(f.stake * 2n)}.`
    }`
    ui.fResult.classList.toggle('win', won)
    const [log] = await pub.getContractEvents({
      address: network.coordinator,
      abi: coordinatorAbi,
      eventName: 'RandomWordsFulfilled',
      args: { requestId },
      fromBlock: f.joinedBlock,
    })
    if (log) {
      detail('Proof tx', explorer('tx', log.transactionHash as Hash, short(log.transactionHash as Hash)))
      detail('Fulfilled in block', `${log.blockNumber} (${log.blockNumber - f.joinedBlock} blocks after joining)`)
      detail('VRF output', `<span class="mono">0x${log.args.outputSeed!.toString(16).padStart(64, '0')}</span>`)
    }
  } catch (e) {
    notice(`Could not load the flip: ${errorMessage(e)}`)
    pollTimer = window.setTimeout(() => void showFlip(id), POLL_MS * 2)
  }
}

// ------------------------------------------------------------------ routing + wiring

async function route() {
  const id = viewId()
  ui.flipView.hidden = id === undefined
  window.clearTimeout(pollTimer)
  if (id !== undefined) {
    ui.flipView.scrollIntoView({ block: 'nearest' })
    await showFlip(id)
  }
  await refreshLists()
}

async function connect() {
  try {
    const [addr] = await wallet().requestAddresses()
    account = addr
    await ensureChain()
    ui.account.textContent = account ?? ''
    ui.connect.textContent = 'Connected'
    renderButtons()
    await route()
  } catch (e) {
    notice(errorMessage(e))
  }
}

ui.connect.addEventListener('click', connect)
ui.pickHeads.addEventListener('click', () => pick(Side.Heads))
ui.pickTails.addEventListener('click', () => pick(Side.Tails))
ui.stake.addEventListener('input', renderButtons)
ui.create.addEventListener('click', () => void createFlip())
ui.withdraw.addEventListener('click', () => void send('withdraw'))
window.addEventListener('popstate', () => void route())
window.ethereum?.on?.('accountsChanged', (accs: Address[]) => {
  account = accs[0]
  ui.account.textContent = account ?? ''
  ui.connect.textContent = account ? 'Connected' : 'Connect wallet'
  renderButtons()
  void route()
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
  renderButtons()
  Promise.all([read<number>('confirmations'), read<bigint>('refundAfterBlocks')])
    .then(([c, r]) => {
      confirmations = BigInt(c)
      refundAfter = r
    })
    .catch(() => {})
  await route()
})()
setInterval(() => {
  if (!busy && document.visibilityState === 'visible' && viewId() === undefined) void refreshLists()
}, 10_000)
