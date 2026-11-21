import { parseAbi } from 'viem'

/** VerityOrbs (verity-examples/contracts/src/VerityOrbs.sol) */
export const orbsAbi = parseAbi([
  'struct Traits { bool revealed; uint8 rarity; uint8 background; uint8 shape; uint8 core; uint8 pattern; }',
  'function mint() payable returns (uint256 tokenId)',
  'function mintPrice() view returns (uint256)',
  'function totalMinted() view returns (uint256)',
  'function totalRevealed() view returns (uint256)',
  'function rarityCount(uint256 rarity) view returns (uint256)',
  'function confirmations() view returns (uint16)',
  'function requestOfToken(uint256 tokenId) view returns (uint256)',
  'function traitsOf(uint256 tokenId) view returns (Traits)',
  'function tokenURI(uint256 tokenId) view returns (string)',
  'function ownerOf(uint256 tokenId) view returns (address)',
  'function balanceOf(address owner) view returns (uint256)',
  'event Minted(uint256 indexed tokenId, address indexed to, uint256 requestId)',
  'event Revealed(uint256 indexed tokenId, uint8 rarity, uint8 background, uint8 shape, uint8 core, uint8 pattern)',
  'event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)',
  'error WrongPayment()',
  'error SoldOut()',
])

export const coordinatorAbi = parseAbi([
  'event RandomWordsFulfilled(uint256 indexed requestId, uint256 outputSeed, uint256 indexed subId, uint128 payment, bool success)',
])

export const RARITIES = ['Common', 'Rare', 'Epic', 'Legendary'] as const
export const ODDS = [60, 30, 9, 1] as const
