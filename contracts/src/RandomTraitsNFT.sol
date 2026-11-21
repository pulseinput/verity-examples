// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {VerityConsumerBase} from "@pulseinput/contracts/verity/VerityConsumerBase.sol";

/**
 * @title RandomTraitsNFT
 * @notice Mint first, reveal later: each token's rarity and traits come from a verifiable
 * random word delivered after the mint. The minter commits by minting (and paying) before
 * the randomness exists, so they cannot pick or reroll traits.
 */
contract RandomTraitsNFT is ERC721, VerityConsumerBase {
    enum Rarity {
        Common, //    60%
        Rare, //      30%
        Epic, //       9%
        Legendary //   1%
    }

    struct Traits {
        bool revealed;
        Rarity rarity;
        uint8 background; // 0..7
        uint8 body; // 0..15
        uint8 accessory; // 0..31
    }

    uint32 public constant CALLBACK_GAS_LIMIT = 150_000;
    uint256 public constant MAX_SUPPLY = 10_000;

    bytes32 public immutable keyHash;
    uint256 public immutable subId;
    uint16 public immutable confirmations;
    uint256 public immutable mintPrice;

    uint256 public totalMinted;
    mapping(uint256 => Traits) public traits;
    mapping(uint256 => uint256) public tokenOfRequest;

    event Minted(uint256 indexed tokenId, address indexed to, uint256 requestId);
    event Revealed(uint256 indexed tokenId, Rarity rarity, uint8 background, uint8 body, uint8 accessory);

    error WrongPayment();
    error SoldOut();

    constructor(address coordinator, bytes32 _keyHash, uint256 _subId, uint16 _confirmations, uint256 _mintPrice)
        ERC721("Verity Traits", "VTRAIT")
        VerityConsumerBase(coordinator)
    {
        keyHash = _keyHash;
        subId = _subId;
        confirmations = _confirmations;
        mintPrice = _mintPrice;
    }

    function mint() external payable returns (uint256 tokenId) {
        if (msg.value != mintPrice) revert WrongPayment();
        if (totalMinted == MAX_SUPPLY) revert SoldOut();
        tokenId = ++totalMinted;
        _safeMint(msg.sender, tokenId); // the token exists (unrevealed) before randomness is requested
        uint256 requestId = s_coordinator.requestRandomWords(keyHash, subId, confirmations, CALLBACK_GAS_LIMIT, 1);
        tokenOfRequest[requestId] = tokenId;
        emit Minted(tokenId, msg.sender, requestId);
    }

    function fulfillRandomWords(uint256 requestId, uint256[] memory words) internal override {
        uint256 tokenId = tokenOfRequest[requestId];
        if (tokenId == 0 || traits[tokenId].revealed) return;
        uint256 w = words[0];
        // Independent fields from disjoint 64-bit ranges of one 256-bit word
        uint256 roll = uint64(w) % 100;
        Rarity rarity = roll < 60 ? Rarity.Common : roll < 90 ? Rarity.Rare : roll < 99 ? Rarity.Epic : Rarity.Legendary;
        Traits memory t = Traits({
            revealed: true,
            rarity: rarity,
            background: uint8((w >> 64) % 8),
            body: uint8((w >> 128) % 16),
            accessory: uint8((w >> 192) % 32)
        });
        traits[tokenId] = t;
        emit Revealed(tokenId, t.rarity, t.background, t.body, t.accessory);
    }

    function withdraw(address to) external onlyOwner {
        (bool ok,) = to.call{value: address(this).balance}("");
        require(ok, "transfer failed");
    }
}
