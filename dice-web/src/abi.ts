import { parseAbi } from 'viem'

export const diceAbi = parseAbi([
  'function rollDice() returns (uint256 requestId)',
  'function rollDiceWithConfirmations(uint16 requestConfirmations) returns (uint256 requestId)',
  'function resultOf(address roller) view returns (uint8)',
  'function s_requestConfirmations() view returns (uint16)',
  'event DiceRolled(uint256 indexed requestId, address indexed roller)',
  'event DiceLanded(uint256 indexed requestId, address indexed roller, uint8 result)',
  'error AlreadyRolling()',
  'error NotRolled()',
  'error InvalidConfirmations(uint16 requested, uint16 min, uint16 max)',
])

export const coordinatorAbi = parseAbi([
  'event RandomWordsFulfilled(uint256 indexed requestId, uint256 outputSeed, uint256 indexed subId, uint128 payment, bool success)',
  'function pendingRequestExists(uint256 requestId) view returns (bool)',
])
