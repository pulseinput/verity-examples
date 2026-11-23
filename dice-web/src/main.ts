import {
  BaseError,
  ContractFunctionRevertedError,
  createPublicClient,
  fallback,
  createWalletClient,
  custom,
  encodeAbiParameters,
  encodePacked,
  formatEther,
  http,
  keccak256,
  parseEventLogs,
  type Address,
  type EIP1193Provider,
  type Hash,
} from 'viem'
import { coordinatorAbi, diceAbi } from './abi'
import { isDeployed, networks, withUrlOverrides, type Network } from './networks'
import { Die3D } from './die3d'
import { api, renderPager, short, timeAgo, type Page, type Vrf } from './history'

declare global {
  interface Window {
    ethereum?: EIP1193Provider
  }
}

const ROLLING = 255
const BLOCKHASH_WINDOW = 256n

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T
const ui = {
  network: $<HTMLSelectElement>('network'),
  connect: $<HTMLButtonElement>('connect'),
  account: $<HTMLSpanElement>('account'),
  notice: $<HTMLParagraphElement>('notice'),
  die: new Die3D($<HTMLDivElement>('die')),
  result: $<HTMLParagraphElement>('result'),
  confs: $<HTMLSelectElement>('confs'),
  confsHint: $<HTMLSpanElement>('confs-hint'),
  roll: $<HTMLButtonElement>('roll'),
  steps: $<HTMLOListElement>('steps'),
  conf: $<HTMLSpanElement>('conf'),
  details: $<HTMLDListElement>('details'),
}

let account: Address | undefined
let tracking = false

const net = (): Network => withUrlOverrides(networks[Number(ui.network.value)]!)
const publicClient = () => {
  const urls = net().chain.rpcUrls.default.http
  const transport = urls.length > 1 ? fallback(urls.map((u) => http(u, { timeout: 8_000 }))) : http()
  return createPublicClient({ chain: net().chain, transport })
}
const walletClient = () => {
  if (!window.ethereum) throw new Error('No browser wallet found. Install MetaMask or Rabby.')
  return createWalletClient({ chain: net().chain, transport: custom(window.ethereum) })
}

function notice(msg?: string) {
  ui.notice.hidden = !msg
  ui.notice.textContent = msg ?? ''
}

function explorerLink(kind: 'tx' | 'address', value: string): string {
  const base = net().chain.blockExplorers?.default.url
  if (!base) return `<span class="mono">${value}</span>`
  return `<a class="mono" href="${base}/${kind}/${value}" target="_blank" rel="noopener">${value}</a>`
}

function detail(label: string, html: string) {
  const dt = document.createElement('dt')
  dt.textContent = label
  const dd = document.createElement('dd')
  dd.innerHTML = html
  ui.details.append(dt, dd)
}

function setStep(step: 'none' | 'requested' | 'confirming' | 'fulfilled') {
  const order = ['requested', 'confirming', 'fulfilled']
  const at = order.indexOf(step)
  ui.steps.querySelectorAll<HTMLLIElement>('li').forEach((li, i) => {
    li.classList.toggle('done', at >= 0 && (i < at || step === 'fulfilled'))
    li.classList.toggle('active', i === at && step !== 'fulfilled')
  })
}

/**
 * ROLLING -> the die tumbles; 1..6 -> it lands on that face (animated only if it was tumbling);
 * undefined -> idle, never rolled.
 */
async function showResult(result: number | undefined) {
  if (result === ROLLING) {
    ui.die.tumble()
    ui.result.textContent = 'Rolling… waiting for the oracle'
  } else if (result && result >= 1 && result <= 6) {
    await ui.die.land(result)
    ui.result.textContent = `You rolled a ${result}`
  } else {
    ui.die.idle()
    ui.result.textContent = 'Not rolled yet'
  }
}

function errorMessage(e: unknown): string {
  if (e instanceof BaseError) {
    const revert = e.walk((err) => err instanceof ContractFunctionRevertedError)
    if (revert instanceof ContractFunctionRevertedError && revert.data?.errorName === 'AlreadyRolling') {
      return 'You already have a roll in progress. Wait for it to land.'
    }
    if (revert instanceof ContractFunctionRevertedError && revert.data?.errorName === 'InvalidConfirmations') {
      return 'Choose between 1 and 5 confirmations.'
    }
    return e.shortMessage
  }
  return e instanceof Error ? e.message : String(e)
}

async function ensureChain() {
  const wallet = walletClient()
  const chain = net().chain
  try {
    await wallet.switchChain({ id: chain.id })
  } catch {
    await wallet.addChain({ chain })
    await wallet.switchChain({ id: chain.id })
  }
}

async function refresh() {
  notice()
  const n = net()
  if (!isDeployed(n)) {
    notice(`Verity is not deployed on ${n.chain.name} yet.`)
    ui.roll.disabled = true
    return
  }
  ui.roll.disabled = !account || tracking
  ui.confs.disabled = tracking
  if (!account) return
  try {
    const r = await publicClient().readContract({ address: n.dice, abi: diceAbi, functionName: 'resultOf', args: [account] })
    await showResult(r)
  } catch {
    await showResult(undefined) // NotRolled
  }
}

async function connect() {
  try {
    const [addr] = await walletClient().requestAddresses()
    account = addr
    await ensureChain()
    ui.account.textContent = account ?? ''
    ui.connect.textContent = 'Connected'
    await refresh()
  } catch (e) {
    notice(errorMessage(e))
  }
}

async function roll() {
  if (!account) return
  const n = net()
  const pub = publicClient()
  ui.details.replaceChildren()
  ui.conf.textContent = ''
  setStep('none')
  notice()
  ui.roll.disabled = true
  ui.confs.disabled = true
  const confirmations = Number(ui.confs.value)
  try {
    await ensureChain()
    const hash = await walletClient().writeContract({
      account,
      chain: n.chain,
      address: n.dice,
      abi: diceAbi,
      functionName: 'rollDiceWithConfirmations',
      args: [confirmations],
    })
    await showResult(ROLLING)
    detail('Request tx', explorerLink('tx', hash))
    const receipt = await pub.waitForTransactionReceipt({ hash })
    const [rolled] = parseEventLogs({ abi: diceAbi, eventName: 'DiceRolled', logs: receipt.logs })
    if (!rolled) throw new Error('DiceRolled event not found in receipt')
    setStep('requested')
    detail('Request id', `<span class="mono">0x${rolled.args.requestId.toString(16)}</span>`)
    detail('Request block', receipt.blockNumber.toString())
    detail('Confirmations', String(confirmations))
    await track(rolled.args.requestId, receipt.blockNumber, BigInt(confirmations))
  } catch (e) {
    notice(errorMessage(e))
    await refresh()
  } finally {
    tracking = false
    ui.roll.disabled = !account
    ui.confs.disabled = false
  }
}

/** Follow the request until the oracle's proof lands on-chain. */
async function track(requestId: bigint, requestBlock: bigint, minConf: bigint) {
  tracking = true
  const n = net()
  const pub = publicClient()
  setStep('confirming')

  for (;;) {
    const head = await pub.getBlockNumber()
    const conf = head > requestBlock ? head - requestBlock : 0n
    ui.conf.textContent = `(${conf < minConf ? conf : minConf} / ${minConf})`

    const [log] = await pub.getContractEvents({
      address: n.coordinator,
      abi: coordinatorAbi,
      eventName: 'RandomWordsFulfilled',
      args: { requestId },
      fromBlock: requestBlock,
    })
    if (log) {
      setStep('fulfilled')
      detail('Proof tx', explorerLink('tx', log.transactionHash as Hash))
      detail('Fulfilled in block', log.blockNumber.toString())
      detail('VRF output', `<span class="mono">0x${log.args.outputSeed!.toString(16).padStart(64, '0')}</span>`)
      detail('Callback', log.args.success ? 'succeeded' : 'failed')
      detail('Fee charged', `${formatEther(log.args.payment!)} ${n.chain.nativeCurrency.symbol}`)
      const r = await pub.readContract({ address: n.dice, abi: diceAbi, functionName: 'resultOf', args: [account!] })
      await showResult(r)
      return
    }
    if (head > requestBlock + BLOCKHASH_WINDOW) {
      notice('The oracle did not answer within 256 blocks. This request has expired; roll again.')
      return
    }
    await new Promise((r) => setTimeout(r, 2000))
  }
}

/** Explain the trade-off of the chosen confirmations (PulseChain blocks are ~10 s). */
function confsHint() {
  const c = Number(ui.confs.value)
  const secs = (c + 1) * 10
  ui.confsHint.textContent =
    c <= 2
      ? `Result in about ${secs} s. Fast, but a short chain reorganisation could replace the result.`
      : `Result in about ${secs} s. Blocks to wait before the oracle answers; more is safer against reorgs.`
}
ui.confs.addEventListener('change', confsHint)
confsHint()

ui.connect.addEventListener('click', connect)
ui.roll.addEventListener('click', roll)
ui.network.addEventListener('change', async () => {
  if (account) await ensureChain().catch((e) => notice(errorMessage(e)))
  await refresh()
})
window.ethereum?.on?.('accountsChanged', (accs: Address[]) => {
  account = accs[0]
  ui.account.textContent = account ?? ''
  void refresh()
})
void refresh()

// ------------------------------------------------------------------ everyone's rolls (demos indexer)

interface Roll {
  request_id: string
  roller: string
  req_block: number
  req_tx: string
  req_ts: number
  result: number | null
  landed_block: number | null
  landed_tx: string | null
  vrf: Vrf | null
}

const hist = {
  live: $<HTMLElement>('live-card'),
  rolling: $<HTMLUListElement>('rolling'),
  rollingEmpty: $<HTMLParagraphElement>('rolling-empty'),
  pastCard: $<HTMLElement>('past-card'),
  past: $<HTMLUListElement>('past'),
  pastEmpty: $<HTMLParagraphElement>('past-empty'),
  pager: $<HTMLDivElement>('past-pager'),
  note: $<HTMLParagraphElement>('history-note'),
  replay: $<HTMLElement>('replay-card'),
  replayDie: new Die3D($<HTMLDivElement>('replay-die')),
  replayResult: $<HTMLParagraphElement>('replay-result'),
  replayAgain: $<HTMLButtonElement>('replay-again'),
  replayClose: $<HTMLButtonElement>('replay-close'),
  replayDetails: $<HTMLDListElement>('replay-details'),
}
const PER_PAGE = 10
let pastPage = 0
let selected: Roll | undefined
let replayTimer: ReturnType<typeof setTimeout> | undefined
const appUrl = (import.meta.env.VITE_VERITY_APP_URL as string | undefined)?.replace(/\/$/, '')
const mono = (v: string) => `<span class="mono">${v}</span>`
const who = (a: string) => (account && a.toLowerCase() === account.toLowerCase() ? 'you' : short(a))

function rollRow(r: Roll, clickable: boolean): HTMLLIElement {
  const li = document.createElement('li')
  const face = document.createElement('span')
  face.className = `face-mini${r.result ? '' : ' rolling'}`
  face.textContent = r.result ? String(r.result) : '?'
  const mid = document.createElement('span')
  mid.className = 'grow'
  const conf = r.vrf ? ` · ${r.vrf.min_conf} confirmation${r.vrf.min_conf === 1 ? '' : 's'}` : ''
  mid.innerHTML = `${r.result ? `Rolled a <b>${r.result}</b>` : 'Rolling…'} by <span class="mono">${who(r.roller)}</span><span class="muted small">${conf}</span>`
  const when = document.createElement('span')
  when.className = 'when muted small'
  when.textContent = timeAgo(r.req_ts)
  li.append(face, mid, when)
  if (clickable) {
    li.className = 'clickable'
    li.tabIndex = 0
    li.setAttribute('role', 'button')
    li.setAttribute('aria-label', `Replay the roll of ${r.result} by ${who(r.roller)}`)
    if (selected?.request_id === r.request_id) li.classList.add('selected')
    const open = () => void openReplay(r, li)
    li.addEventListener('click', open)
    li.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault()
        open()
      }
    })
  }
  return li
}

async function loadHistory() {
  const base = net().demosApi
  if (!base) {
    hist.live.hidden = hist.pastCard.hidden = true
    return
  }
  try {
    const [live, past] = await Promise.all([
      api<{ items: Roll[] }>(base, '/dice/rolling'),
      api<Page<Roll>>(base, `/dice/rolls?page=${pastPage}&per=${PER_PAGE}`),
    ])
    hist.note.hidden = true
    hist.live.hidden = hist.pastCard.hidden = false
    hist.rolling.replaceChildren(...live.items.map((r) => rollRow(r, false)))
    hist.rollingEmpty.hidden = live.items.length > 0
    hist.past.replaceChildren(...past.items.map((r) => rollRow(r, true)))
    hist.pastEmpty.hidden = past.total > 0
    renderPager(hist.pager, past.page, past.pages, (p) => {
      pastPage = p
      void loadHistory()
    })
  } catch {
    hist.note.hidden = false
  }
}

function replayDetail(label: string, html: string) {
  const dt = document.createElement('dt')
  dt.textContent = label
  const dd = document.createElement('dd')
  dd.innerHTML = html
  hist.replayDetails.append(dt, dd)
}

/** Tumble for 2 seconds, then land on the roll's number. */
function playReplay(result: number) {
  clearTimeout(replayTimer)
  hist.replayDie.idle()
  hist.replayDie.tumble()
  hist.replayResult.textContent = 'Rolling…'
  replayTimer = setTimeout(async () => {
    await hist.replayDie.land(result)
    hist.replayResult.textContent = `It landed on ${result}`
  }, 2000)
}

async function openReplay(r: Roll, row?: HTMLLIElement) {
  if (!r.result) return
  selected = r
  hist.past.querySelectorAll('li').forEach((li) => li.classList.remove('selected'))
  row?.classList.add('selected')
  hist.replay.hidden = false
  hist.replayDetails.replaceChildren()
  hist.replay.scrollIntoView({ behavior: 'smooth', block: 'start' })
  playReplay(r.result)
  const v = r.vrf
  replayDetail('Result', `<b>${r.result}</b>`)
  replayDetail('Rolled by', explorerLink('address', r.roller))
  replayDetail('Requested', `block ${r.req_block}, ${new Date(r.req_ts * 1000).toLocaleString()}<br>${explorerLink('tx', r.req_tx)}`)
  if (!v) return
  const reqLink = appUrl
    ? `<a class="mono" href="${appUrl}/#/requests/${v.request_id}" target="_blank" rel="noopener">${v.request_id}</a><br><span class="muted small">opens the request in the Verity explorer</span>`
    : mono(v.request_id)
  replayDetail('Request id', reqLink)
  replayDetail('Confirmations waited', String(v.min_conf))
  replayDetail('Oracle key hash', mono(v.key_hash))
  replayDetail('Pre-seed', mono(v.pre_seed))
  // seed = keccak256(pre-seed ++ hash of the request block), exactly as the coordinator computes it
  try {
    const block = await publicClient().getBlock({ blockNumber: BigInt(v.req_block) })
    if (selected !== r) return
    const seed = keccak256(encodePacked(['uint256', 'bytes32'], [BigInt(v.pre_seed), block.hash!]))
    replayDetail('Request block hash', mono(block.hash!))
    replayDetail('Seed', `${mono(seed)}<br><span class="muted small">keccak256(pre-seed, block hash), recomputed in your browser</span>`)
  } catch {
    /* RPC unreachable: skip the recomputed seed */
  }
  if (!v.output_seed || !v.word0 || !v.ful_tx) {
    replayDetail('Proof', 'not answered yet')
    return
  }
  replayDetail('Proof transaction', `block ${v.ful_block}<br>${explorerLink('tx', v.ful_tx)}`)
  replayDetail('VRF output', mono(v.output_seed))
  const word = keccak256(encodeAbiParameters([{ type: 'uint256' }, { type: 'uint256' }], [BigInt(v.output_seed), 0n]))
  const wordOk = word.toLowerCase() === v.word0.toLowerCase()
  replayDetail(
    'Random word',
    `${mono(word)}<br><span class="${wordOk ? 'ok-mark' : 'bad-mark'}">${wordOk ? '✓' : '✕'}</span> <span class="muted small">keccak256(abi.encode(output, 0)), recomputed in your browser</span>`,
  )
  const mod = BigInt(word) % 6n
  const dieOk = Number(mod) + 1 === r.result
  replayDetail(
    'Die face',
    `word mod 6 = ${mod}, plus 1 = <b>${Number(mod) + 1}</b> <span class="${dieOk ? 'ok-mark' : 'bad-mark'}">${dieOk ? '✓ matches the roll' : '✕ does not match'}</span>`,
  )
  if (v.payment) replayDetail('Fee charged', `${formatEther(BigInt(v.payment))} ${net().chain.nativeCurrency.symbol}`)
}

hist.replayAgain.addEventListener('click', () => {
  if (selected?.result) playReplay(selected.result)
})
hist.replayClose.addEventListener('click', () => {
  clearTimeout(replayTimer)
  hist.replay.hidden = true
  selected = undefined
  hist.past.querySelectorAll('li').forEach((li) => li.classList.remove('selected'))
})
ui.network.addEventListener('change', () => {
  pastPage = 0
  void loadHistory()
})
void loadHistory()
setInterval(() => {
  if (document.visibilityState === 'visible') void loadHistory()
}, 5_000)
