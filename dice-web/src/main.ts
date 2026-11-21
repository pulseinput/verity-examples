import {
  BaseError,
  ContractFunctionRevertedError,
  createPublicClient,
  fallback,
  createWalletClient,
  custom,
  formatEther,
  http,
  parseEventLogs,
  type Address,
  type EIP1193Provider,
  type Hash,
} from 'viem'
import { coordinatorAbi, diceAbi } from './abi'
import { isDeployed, networks, withUrlOverrides, type Network } from './networks'
import { Die3D } from './die3d'

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
