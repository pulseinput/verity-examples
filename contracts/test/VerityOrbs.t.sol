// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {VerityCoordinatorMock} from "@pulseinput/contracts/verity/mocks/VerityCoordinatorMock.sol";
import {VerityOrbs} from "../src/VerityOrbs.sol";

contract VerityOrbsTest is Test {
    VerityCoordinatorMock internal mock;
    VerityOrbs internal orbs;
    address internal alice = makeAddr("alice");

    function setUp() public {
        mock = new VerityCoordinatorMock();
        uint256 subId = mock.createSubscription();
        orbs = new VerityOrbs(address(mock), keccak256("any key"), subId, 3, 0);
        mock.addConsumer(subId, address(orbs));
    }

    function _word(uint256 w) internal pure returns (uint256[] memory words) {
        words = new uint256[](1);
        words[0] = w;
    }

    function _mint(address to) internal returns (uint256 id) {
        vm.prank(to);
        id = orbs.mint();
    }

    /// Word with the given value in each 48-bit trait slice.
    function _slices(uint256 roll, uint256 bg, uint256 shape, uint256 core, uint256 pattern)
        internal
        pure
        returns (uint256)
    {
        return roll | (bg << 48) | (shape << 96) | (core << 144) | (pattern << 192);
    }

    function test_mintFirstRevealLater() public {
        uint256 id = _mint(alice);
        assertEq(id, 1);
        assertEq(orbs.ownerOf(id), alice);
        assertFalse(orbs.traitsOf(id).revealed);
        uint256 req = orbs.requestOfToken(id);
        assertTrue(mock.pendingRequestExists(req));
        assertEq(orbs.tokenOfRequest(req), id);
        // unrevealed metadata is valid and says so
        assertTrue(_contains(_decodedJson(id), '"Unrevealed"'));
    }

    function test_traitsComeFromSeparateSlices() public {
        uint256 id = _mint(alice);
        assertTrue(mock.fulfillRandomWordsWithOverride(orbs.requestOfToken(id), _word(_slices(99, 7, 4, 5, 4))));
        VerityOrbs.Traits memory t = orbs.traitsOf(id);
        assertTrue(t.revealed);
        assertEq(uint8(t.rarity), uint8(VerityOrbs.Rarity.Legendary));
        assertEq(t.background, 7);
        assertEq(t.shape, 4);
        assertEq(t.core, 5);
        assertEq(t.pattern, 4);
        assertEq(orbs.rarityCount(3), 1);
        assertEq(orbs.totalRevealed(), 1);
        string memory json = _decodedJson(id);
        assertTrue(_contains(json, '"Legendary"'));
        assertTrue(_contains(json, '"Aurora"'));
        assertTrue(_contains(json, '"Star"'));
        assertTrue(_contains(json, '"Amber"'));
        assertTrue(_contains(json, '"Pulse"'));
        assertTrue(_contains(orbs.svgOf(id), "<svg"));
    }

    function test_rarityThresholds() public {
        uint256[4] memory rolls = [uint256(59), 89, 98, 99];
        for (uint256 i = 0; i < 4; i++) {
            uint256 id = _mint(alice);
            mock.fulfillRandomWordsWithOverride(orbs.requestOfToken(id), _word(_slices(rolls[i], 0, 0, 0, 0)));
            assertEq(uint8(orbs.traitsOf(id).rarity), i);
        }
    }

    function test_secondAnswerIgnored() public {
        uint256 id = _mint(alice);
        uint256 req = orbs.requestOfToken(id);
        mock.fulfillRandomWordsWithOverride(req, _word(_slices(0, 1, 1, 1, 1)));
        vm.prank(address(mock));
        orbs.rawFulfillRandomWords(req, _word(_slices(99, 2, 2, 2, 2)));
        VerityOrbs.Traits memory t = orbs.traitsOf(id);
        assertEq(uint8(t.rarity), 0);
        assertEq(t.background, 1);
        assertEq(orbs.totalRevealed(), 1);
    }

    /// 400 mints with mock words: the rarity shares land near 60/30/9/1 and every trait value appears.
    function test_distribution() public {
        uint256 n = 400;
        bool[8] memory bgSeen;
        for (uint256 i = 0; i < n; i++) {
            uint256 id = _mint(alice);
            mock.fulfillRandomWords(orbs.requestOfToken(id)); // words derived from the request id
            bgSeen[orbs.traitsOf(id).background] = true;
        }
        assertEq(orbs.totalRevealed(), n);
        assertApproxEqAbs(orbs.rarityCount(0), 240, 40);
        assertApproxEqAbs(orbs.rarityCount(1), 120, 35);
        assertApproxEqAbs(orbs.rarityCount(2), 36, 20);
        assertLe(orbs.rarityCount(3), 15);
        for (uint256 b = 0; b < 8; b++) {
            assertTrue(bgSeen[b]);
        }
    }

    function test_priceAndWithdraw() public {
        VerityOrbs paid = new VerityOrbs(address(mock), keccak256("k"), 1, 3, 1 ether);
        mock.addConsumer(1, address(paid));
        vm.deal(alice, 2 ether);
        vm.prank(alice);
        vm.expectRevert(VerityOrbs.WrongPayment.selector);
        paid.mint();
        vm.prank(alice);
        paid.mint{value: 1 ether}();
        address to = makeAddr("treasury");
        paid.withdraw(to);
        assertEq(to.balance, 1 ether);
        vm.prank(alice);
        vm.expectRevert();
        paid.withdraw(alice);
    }

    function test_callbackWithinGasLimit() public {
        uint256 id = _mint(alice);
        assertTrue(mock.fulfillRandomWordsWithOverride(orbs.requestOfToken(id), _word(type(uint256).max)));
        assertTrue(orbs.traitsOf(id).revealed);
    }

    function test_unknownTokenReverts() public {
        vm.expectRevert();
        orbs.tokenURI(42);
    }

    // ---------------------------------------------------------------- helpers

    function _decodedJson(uint256 id) internal view returns (string memory) {
        string memory uri = orbs.tokenURI(id);
        string memory prefix = "data:application/json;base64,";
        assertTrue(_startsWith(uri, prefix));
        bytes memory b64 = bytes(uri);
        bytes memory body = new bytes(b64.length - bytes(prefix).length);
        for (uint256 i = 0; i < body.length; i++) {
            body[i] = b64[i + bytes(prefix).length];
        }
        return string(_b64decode(string(body)));
    }

    function _b64decode(string memory s) internal pure returns (bytes memory out) {
        bytes memory t = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
        bytes memory d = bytes(s);
        uint8[128] memory map;
        for (uint8 i = 0; i < 64; i++) {
            map[uint8(t[i])] = i;
        }
        uint256 pad = d.length > 0 && d[d.length - 1] == "=" ? (d.length > 1 && d[d.length - 2] == "=" ? 2 : 1) : 0;
        out = new bytes((d.length / 4) * 3 - pad);
        uint256 o;
        for (uint256 i = 0; i < d.length; i += 4) {
            uint256 v = (uint256(map[uint8(d[i])]) << 18) | (uint256(map[uint8(d[i + 1])]) << 12)
                | (uint256(d[i + 2] == "=" ? 0 : map[uint8(d[i + 2])]) << 6)
                | uint256(d[i + 3] == "=" ? 0 : map[uint8(d[i + 3])]);
            if (o < out.length) out[o++] = bytes1(uint8(v >> 16));
            if (o < out.length) out[o++] = bytes1(uint8(v >> 8));
            if (o < out.length) out[o++] = bytes1(uint8(v));
        }
    }

    function _startsWith(string memory s, string memory p) internal pure returns (bool) {
        bytes memory a = bytes(s);
        bytes memory b = bytes(p);
        if (b.length > a.length) return false;
        for (uint256 i = 0; i < b.length; i++) {
            if (a[i] != b[i]) return false;
        }
        return true;
    }

    function _contains(string memory s, string memory sub) internal pure returns (bool) {
        bytes memory a = bytes(s);
        bytes memory b = bytes(sub);
        if (b.length > a.length) return false;
        for (uint256 i = 0; i + b.length <= a.length; i++) {
            bool ok = true;
            for (uint256 j = 0; j < b.length; j++) {
                if (a[i + j] != b[j]) {
                    ok = false;
                    break;
                }
            }
            if (ok) return true;
        }
        return false;
    }
}
