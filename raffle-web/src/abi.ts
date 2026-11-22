import { parseAbi } from 'viem'

/** RaffleRounds (@pulseinput/contracts: verity/examples/RaffleRounds.sol) */
export const raffleAbi = parseAbi([
  'struct Round { uint8 state; uint64 closesAt; uint64 drawRequestedAt; uint96 tickets; address winner; uint96 winningTicket; uint256 pot; }',
  'struct Entry { address buyer; uint96 end; }',
  'function currentRound() view returns (uint256)',
  'function getRound(uint256 r) view returns (Round)',
  'function getEntries(uint256 r, uint256 start, uint256 count) view returns (Entry[])',
  'function entryCount(uint256 r) view returns (uint256)',
  'function ticketsOf(uint256 r, address player) view returns (uint256)',
  'function winnings(address player) view returns (uint256)',
  'function drawRequestOf(uint256 r) view returns (uint256)',
  'function ticketPrice() view returns (uint256)',
  'function roundDuration() view returns (uint64)',
  'function confirmations() view returns (uint16)',
  'function refundAfterBlocks() view returns (uint64)',
  'function MAX_TICKETS_PER_BUY() view returns (uint256)',
  'function buyTickets(uint256 count) payable',
  'function draw() returns (uint256 requestId)',
  'function withdraw()',
  'function enableRefunds(uint256 r)',
  'function refund(uint256 r)',
  'event TicketsBought(uint256 indexed round, address indexed buyer, uint256 count, uint256 firstTicket)',
  'event DrawRequested(uint256 indexed round, uint256 indexed requestId)',
  'event WinnerDrawn(uint256 indexed round, address indexed winner, uint256 winningTicket, uint256 prize)',
  'error WrongState(uint8 have, uint8 want)',
  'error WrongPayment()',
  'error InvalidTicketCount(uint256 count, uint256 max)',
  'error RoundClosed()',
  'error TooEarly()',
  'error NoTickets()',
  'error NothingToRefund()',
  'error NothingToWithdraw()',
  'error TransferFailed()',
])

export const coordinatorAbi = parseAbi([
  'event RandomWordsFulfilled(uint256 indexed requestId, uint256 outputSeed, uint256 indexed subId, uint128 payment, bool success)',
])

export const State = { Open: 0, Drawing: 1, Won: 2, Refunding: 3 } as const
