import { parseAbi } from 'viem'

/** CoinFlip (@pulseinput/contracts: verity/examples/CoinFlip.sol) */
export const coinAbi = parseAbi([
  'struct Flip { address creator; uint8 creatorSide; uint8 state; uint8 result; address joiner; uint64 joinedBlock; address winner; uint128 stake; }',
  'function flipCount() view returns (uint256)',
  'function getFlip(uint256 id) view returns (Flip)',
  'function requestOf(uint256 id) view returns (uint256)',
  'function balances(address player) view returns (uint256)',
  'function confirmations() view returns (uint16)',
  'function refundAfterBlocks() view returns (uint64)',
  'function MIN_STAKE() view returns (uint256)',
  'function MAX_STAKE() view returns (uint256)',
  'function createFlip(uint8 side) payable returns (uint256 id)',
  'function joinFlip(uint256 id) payable returns (uint256 requestId)',
  'function cancelFlip(uint256 id)',
  'function refundUnanswered(uint256 id)',
  'function withdraw()',
  'event FlipCreated(uint256 indexed id, address indexed creator, uint8 side, uint256 stake)',
  'event FlipJoined(uint256 indexed id, address indexed joiner, uint256 requestId)',
  'event FlipSettled(uint256 indexed id, uint8 result, address indexed winner, uint256 payout)',
  'error InvalidStake(uint256 stake, uint256 min, uint256 max)',
  'error WrongState(uint8 have, uint8 want)',
  'error WrongPayment(uint256 sent, uint256 want)',
  'error NotCreator()',
  'error TooEarly(uint256 currentBlock, uint256 refundBlock)',
  'error NothingToWithdraw()',
  'error TransferFailed()',
])

export const coordinatorAbi = parseAbi([
  'event RandomWordsFulfilled(uint256 indexed requestId, uint256 outputSeed, uint256 indexed subId, uint128 payment, bool success)',
])

export const Side = { Heads: 0, Tails: 1 } as const
export const SIDES = ['Heads', 'Tails'] as const
export const State = { None: 0, Open: 1, Flipping: 2, Settled: 3, Cancelled: 4, Refunded: 5 } as const
