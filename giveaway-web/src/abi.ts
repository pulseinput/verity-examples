import { parseAbi } from 'viem'

/** GiveawayPicker (verity-contracts/src/examples/GiveawayPicker.sol) */
export const pickerAbi = parseAbi([
  'struct Giveaway { address creator; uint8 state; uint16 winnerCount; uint32 entrantCount; uint64 createdBlock; bytes32 entrantsHash; uint256 randomWord; }',
  'function giveawayCount() view returns (uint256)',
  'function getGiveaway(uint256 id) view returns (Giveaway)',
  'function requestOf(uint256 id) view returns (uint256)',
  'function confirmations() view returns (uint16)',
  'function MAX_ENTRANTS() view returns (uint256)',
  'function MAX_WINNERS() view returns (uint256)',
  'function winnerIndices(uint256 id) view returns (uint256[])',
  'function winnersFrom(uint256 id, address[] entrants) view returns (address[])',
  'function createGiveaway(string title, address[] entrants, uint16 winnerCount) returns (uint256 id)',
  'event GiveawayCreated(uint256 indexed id, address indexed creator, string title, address[] entrants, uint256 winnerCount, uint256 requestId)',
  'event WinnersDrawn(uint256 indexed id, uint256 randomWord)',
  'error InvalidEntrantCount(uint256 count, uint256 max)',
  'error InvalidWinnerCount(uint256 count, uint256 max)',
  'error TitleTooLong(uint256 length, uint256 max)',
  'error UnknownGiveaway(uint256 id)',
  'error NotDrawn(uint256 id)',
  'error WrongEntrants(uint256 id)',
])

export const coordinatorAbi = parseAbi([
  'event RandomWordsFulfilled(uint256 indexed requestId, uint256 outputSeed, uint256 indexed subId, uint128 payment, bool success)',
])

export const State = { None: 0, Drawing: 1, Drawn: 2 } as const
