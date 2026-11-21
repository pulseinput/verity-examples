// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {Base64} from "@openzeppelin/contracts/utils/Base64.sol";
import {Strings} from "@openzeppelin/contracts/utils/Strings.sol";
import {VerityConsumerBase} from "@pulseinput/contracts/verity/VerityConsumerBase.sol";

/**
 * @title VerityOrbs
 * @notice Random-trait NFTs with on-chain art. Used by the live demo at pulseinput.com/verity/use-cases/nft/.
 *
 * Mint first, reveal later: the token exists (unrevealed) before its randomness is requested, so a minter
 * can't see the traits and back out, and can't reroll. Each trait reads its own 48-bit slice of the single
 * Verity word, so traits are independent. tokenURI draws the SVG from the stored traits; nothing lives off-chain.
 */
contract VerityOrbs is ERC721, VerityConsumerBase {
    using Strings for uint256;

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
        uint8 shape; // 0..5
        uint8 core; // 0..7
        uint8 pattern; // 0..4
    }

    uint32 public constant CALLBACK_GAS_LIMIT = 150_000;
    uint256 public constant MAX_SUPPLY = 10_000;

    bytes32 public immutable keyHash;
    uint256 public immutable subId;
    uint16 public immutable confirmations;
    uint256 public immutable mintPrice;

    uint256 public totalMinted;
    uint256 public totalRevealed;
    uint256[4] public rarityCount;
    mapping(uint256 => Traits) internal s_traits;
    mapping(uint256 => uint256) public tokenOfRequest;
    mapping(uint256 => uint256) public requestOfToken;

    event Minted(uint256 indexed tokenId, address indexed to, uint256 requestId);
    event Revealed(uint256 indexed tokenId, Rarity rarity, uint8 background, uint8 shape, uint8 core, uint8 pattern);

    error WrongPayment();
    error SoldOut();
    error TransferFailed();

    constructor(address coordinator, bytes32 _keyHash, uint256 _subId, uint16 _confirmations, uint256 _mintPrice)
        ERC721("Verity Orbs", "ORB")
        VerityConsumerBase(coordinator)
    {
        keyHash = _keyHash;
        subId = _subId;
        confirmations = _confirmations;
        mintPrice = _mintPrice;
    }

    // ---------------------------------------------------------------- mint + reveal

    function mint() external payable returns (uint256 tokenId) {
        if (msg.value != mintPrice) revert WrongPayment();
        if (totalMinted == MAX_SUPPLY) revert SoldOut();
        tokenId = ++totalMinted;
        _mint(msg.sender, tokenId); // exists, unrevealed, before randomness is requested
        uint256 requestId = s_coordinator.requestRandomWords(keyHash, subId, confirmations, CALLBACK_GAS_LIMIT, 1);
        tokenOfRequest[requestId] = tokenId;
        requestOfToken[tokenId] = requestId;
        emit Minted(tokenId, msg.sender, requestId);
    }

    function fulfillRandomWords(uint256 requestId, uint256[] memory words) internal override {
        uint256 tokenId = tokenOfRequest[requestId];
        if (tokenId == 0 || s_traits[tokenId].revealed) return; // never revert in the callback
        uint256 w = words[0];
        // one independent 48-bit slice per trait
        uint256 roll = uint48(w) % 100;
        Rarity rarity = roll < 60 ? Rarity.Common : roll < 90 ? Rarity.Rare : roll < 99 ? Rarity.Epic : Rarity.Legendary;
        Traits memory t = Traits({
            revealed: true,
            rarity: rarity,
            background: uint8(uint48(w >> 48) % 8),
            shape: uint8(uint48(w >> 96) % 6),
            core: uint8(uint48(w >> 144) % 8),
            pattern: uint8(uint48(w >> 192) % 5)
        });
        s_traits[tokenId] = t;
        totalRevealed++;
        rarityCount[uint8(rarity)]++;
        emit Revealed(tokenId, t.rarity, t.background, t.shape, t.core, t.pattern);
    }

    /// @notice Mint proceeds (if a price is set) go to the owner.
    function withdraw(address to) external onlyOwner {
        (bool ok,) = payable(to).call{value: address(this).balance}("");
        if (!ok) revert TransferFailed();
    }

    // ---------------------------------------------------------------- views

    function traitsOf(uint256 tokenId) external view returns (Traits memory) {
        _requireOwned(tokenId);
        return s_traits[tokenId];
    }

    function tokenURI(uint256 tokenId) public view override returns (string memory) {
        _requireOwned(tokenId);
        Traits memory t = s_traits[tokenId];
        string memory name = string.concat("Verity Orb #", tokenId.toString());
        string memory attrs = t.revealed
            ? string.concat(
                '[{"trait_type":"Rarity","value":"',
                _rarityName(t.rarity),
                '"},{"trait_type":"Background","value":"',
                _backgroundName(t.background),
                '"},{"trait_type":"Shape","value":"',
                _shapeName(t.shape),
                '"},{"trait_type":"Core","value":"',
                _coreName(t.core),
                '"},{"trait_type":"Pattern","value":"',
                _patternName(t.pattern),
                '"}]'
            )
            : '[{"trait_type":"Status","value":"Unrevealed"}]';
        string memory json = string.concat(
            '{"name":"',
            name,
            '","description":"A random-trait NFT whose traits come from a Verity verifiable random number delivered after the mint. Art is drawn on-chain.","attributes":',
            attrs,
            ',"image":"data:image/svg+xml;base64,',
            Base64.encode(bytes(svgOf(tokenId))),
            '"}'
        );
        return string.concat("data:application/json;base64,", Base64.encode(bytes(json)));
    }

    /// @notice The token's artwork as an SVG string.
    function svgOf(uint256 tokenId) public view returns (string memory) {
        _requireOwned(tokenId);
        Traits memory t = s_traits[tokenId];
        if (!t.revealed) return _mysterySvg(tokenId);
        (string memory bg1, string memory bg2) = _backgroundColors(t.background);
        (string memory c1, string memory c2) = _coreColors(t.core);
        return string.concat(
            '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 400"><defs>',
            '<linearGradient id="b" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="',
            bg1,
            '"/><stop offset="1" stop-color="',
            bg2,
            '"/></linearGradient><radialGradient id="c" cx=".35" cy=".3" r=".9"><stop offset="0" stop-color="',
            c1,
            '"/><stop offset="1" stop-color="',
            c2,
            '"/></radialGradient>',
            _shapeDef(t.shape),
            '<clipPath id="k"><use href="#s"/></clipPath>',
            '<pattern id="d" width="26" height="26" patternUnits="userSpaceOnUse"><circle cx="13" cy="13" r="4" fill="#fff" fill-opacity=".35"/></pattern>',
            "</defs>",
            '<rect width="400" height="400" fill="url(#b)"/>',
            _frame(t.rarity),
            '<use href="#s" fill="url(#c)" stroke="#fff" stroke-opacity=".35" stroke-width="3"/>',
            '<g clip-path="url(#k)">',
            _pattern(t.pattern),
            '<ellipse cx="165" cy="150" rx="55" ry="30" fill="#fff" fill-opacity=".22" transform="rotate(-30 165 150)"/></g>',
            _labels(tokenId, t.rarity),
            "</svg>"
        );
    }

    // ---------------------------------------------------------------- art (internal)

    function _mysterySvg(uint256 tokenId) internal pure returns (string memory) {
        return string.concat(
            '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 400"><rect width="400" height="400" fill="#0b0a12"/>',
            '<circle cx="200" cy="190" r="110" fill="#17141f" stroke="#b77bff" stroke-width="4" stroke-dasharray="10 10"/>',
            '<text x="200" y="228" text-anchor="middle" font-family="system-ui,sans-serif" font-size="110" font-weight="800" fill="#b77bff">?</text>',
            '<text x="200" y="350" text-anchor="middle" font-family="system-ui,sans-serif" font-size="20" fill="#9a96ab">Orb #',
            tokenId.toString(),
            " \xc2\xb7 waiting for Verity</text></svg>"
        );
    }

    function _shapeDef(uint8 s) internal pure returns (string memory) {
        if (s == 0) return '<circle id="s" cx="200" cy="200" r="112"/>';
        if (s == 1) return '<path id="s" d="M138 105h124l54 66-116 144L84 171Z"/>';
        if (s == 2) return '<path id="s" d="M200 84l102 58v116l-102 58-102-58V142Z"/>';
        if (s == 3) return '<path id="s" d="M200 76l124 124-124 124L76 200Z"/>';
        if (s == 4) return '<path id="s" d="M200 74l35 80 87 8-66 58 20 85-76-45-76 45 20-85-66-58 87-8Z"/>';
        return '<path id="s" d="M200 82l108 36v78c0 66-46 108-108 128-62-20-108-62-108-128v-78Z"/>';
    }

    function _pattern(uint8 p) internal pure returns (string memory) {
        if (p == 1) {
            return '<g fill="none" stroke="#fff" stroke-opacity=".3" stroke-width="7"><circle cx="200" cy="200" r="38"/><circle cx="200" cy="200" r="74"/><circle cx="200" cy="200" r="110"/></g>';
        }
        if (p == 2) {
            return '<path d="M40 180L220 0M40 260L300 0M40 340L380 0M100 360L400 60M180 360L400 140M260 360L400 220" stroke="#fff" stroke-opacity=".22" stroke-width="16"/>';
        }
        if (p == 3) return '<rect width="400" height="400" fill="url(#d)"/>';
        if (p == 4) {
            return '<path d="M60 205h72l22-54 32 104 26-82 16 32h112" fill="none" stroke="#fff" stroke-opacity=".85" stroke-width="10" stroke-linecap="round" stroke-linejoin="round"/>';
        }
        return "";
    }

    function _frame(Rarity r) internal pure returns (string memory) {
        if (r == Rarity.Rare) {
            return
                '<rect x="12" y="12" width="376" height="376" rx="28" fill="none" stroke="#d5dbe8" stroke-width="6"/>';
        }
        if (r == Rarity.Epic) {
            return string.concat(
                '<linearGradient id="e" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#8000ff"/><stop offset="1" stop-color="#ff1f6b"/></linearGradient>',
                '<rect x="12" y="12" width="376" height="376" rx="28" fill="none" stroke="url(#e)" stroke-width="9"/>'
            );
        }
        if (r == Rarity.Legendary) {
            return string.concat(
                '<linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#fff2b0"/><stop offset=".5" stop-color="#ffb800"/><stop offset="1" stop-color="#ffe27a"/></linearGradient>',
                '<rect x="12" y="12" width="376" height="376" rx="28" fill="none" stroke="url(#g)" stroke-width="11"/>',
                '<path d="M70 64l6 16 16 6-16 6-6 16-6-16-16-6 16-6ZM332 300l5 13 13 5-13 5-5 13-5-13-13-5 13-5ZM330 70l4 10 10 4-10 4-4 10-4-10-10-4 10-4Z" fill="#ffe27a"/>'
            );
        }
        return "";
    }

    function _labels(uint256 tokenId, Rarity r) internal pure returns (string memory) {
        return string.concat(
            '<text x="32" y="372" font-family="system-ui,sans-serif" font-size="20" font-weight="700" fill="#fff" fill-opacity=".85">#',
            tokenId.toString(),
            '</text><text x="368" y="48" text-anchor="end" font-family="system-ui,sans-serif" font-size="18" font-weight="700" fill="#fff" fill-opacity=".85">',
            _rarityName(r),
            "</text>"
        );
    }

    function _backgroundColors(uint8 b) internal pure returns (string memory, string memory) {
        if (b == 0) return ("#0b0a1a", "#241a52"); // Midnight
        if (b == 1) return ("#2a0a3d", "#62207a"); // Plum
        if (b == 2) return ("#001b3a", "#00587f"); // Ocean
        if (b == 3) return ("#062a1e", "#11613f"); // Forest
        if (b == 4) return ("#3a0a00", "#8f3200"); // Ember
        if (b == 5) return ("#3a0a20", "#8f1d50"); // Rose
        if (b == 6) return ("#1a1d24", "#424a59"); // Slate
        return ("#00a6d6", "#7000e0"); // Aurora
    }

    function _coreColors(uint8 c) internal pure returns (string memory, string memory) {
        if (c == 0) return ("#9ff6ff", "#0096c7"); // Cyan
        if (c == 1) return ("#9dbdff", "#0040c9"); // Blue
        if (c == 2) return ("#d2a8ff", "#5c00c9"); // Purple
        if (c == 3) return ("#ffa8f7", "#b400b4"); // Magenta
        if (c == 4) return ("#ffa8c4", "#c9104f"); // Pink
        if (c == 5) return ("#ffe29d", "#c97f00"); // Amber
        if (c == 6) return ("#d6ff9d", "#479900"); // Lime
        return ("#ffffff", "#8fa7c9"); // Ice
    }

    function _rarityName(Rarity r) internal pure returns (string memory) {
        if (r == Rarity.Common) return "Common";
        if (r == Rarity.Rare) return "Rare";
        if (r == Rarity.Epic) return "Epic";
        return "Legendary";
    }

    function _backgroundName(uint8 b) internal pure returns (string memory) {
        string[8] memory n = ["Midnight", "Plum", "Ocean", "Forest", "Ember", "Rose", "Slate", "Aurora"];
        return n[b];
    }

    function _shapeName(uint8 s) internal pure returns (string memory) {
        string[6] memory n = ["Orb", "Gem", "Hexagon", "Diamond", "Star", "Shield"];
        return n[s];
    }

    function _coreName(uint8 c) internal pure returns (string memory) {
        string[8] memory n = ["Cyan", "Blue", "Purple", "Magenta", "Pink", "Amber", "Lime", "Ice"];
        return n[c];
    }

    function _patternName(uint8 p) internal pure returns (string memory) {
        string[5] memory n = ["Plain", "Rings", "Stripes", "Dots", "Pulse"];
        return n[p];
    }
}
