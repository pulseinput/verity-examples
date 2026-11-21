// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {VerityCoordinatorMock} from "@pulseinput/contracts/verity/mocks/VerityCoordinatorMock.sol";
import {Raffle} from "../src/Raffle.sol";
import {RandomTraitsNFT} from "../src/RandomTraitsNFT.sol";
import {TournamentSeeding} from "../src/TournamentSeeding.sol";

/// @notice Example consumers tested against the Verity mock (no node, no proofs).
contract ExamplesTest is Test {
    VerityCoordinatorMock internal mock;
    uint256 internal subId;
    bytes32 internal constant KEY = keccak256("lane");

    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");
    address internal carol = makeAddr("carol");

    function setUp() public {
        mock = new VerityCoordinatorMock();
        subId = mock.createSubscription();
        vm.deal(alice, 100 ether);
        vm.deal(bob, 100 ether);
        vm.deal(carol, 100 ether);
    }

    function one(uint256 w) internal pure returns (uint256[] memory a) {
        a = new uint256[](1);
        a[0] = w;
    }

    // ------------------------------------------------------------------ Raffle

    function newRaffle() internal returns (Raffle r) {
        r = new Raffle(address(mock), KEY, subId, 3, 1 ether, block.timestamp + 1 days, 1_000);
        mock.addConsumer(subId, address(r));
    }

    function test_raffleWinnerTakesPot() public {
        Raffle r = newRaffle();
        vm.prank(alice);
        r.buyTickets{value: 2 ether}(2); // tickets 0, 1
        vm.prank(bob);
        r.buyTickets{value: 1 ether}(1); // ticket 2
        vm.warp(block.timestamp + 1 days);
        uint256 id = r.draw();

        mock.fulfillRandomWordsWithOverride(id, one(5)); // 5 % 3 = ticket 2 -> bob
        assertEq(r.winner(), bob);
        uint256 before = bob.balance;
        vm.prank(bob);
        r.claimPrize();
        assertEq(bob.balance - before, 3 ether);
    }

    function test_raffleLocksEntriesWhenDrawStarts() public {
        Raffle r = newRaffle();
        vm.prank(alice);
        r.buyTickets{value: 1 ether}(1);
        vm.warp(block.timestamp + 1 days);
        r.draw();
        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(Raffle.WrongState.selector, Raffle.State.Drawing, Raffle.State.Open));
        r.buyTickets{value: 1 ether}(1);
        // and there is no second draw
        vm.expectRevert(abi.encodeWithSelector(Raffle.WrongState.selector, Raffle.State.Drawing, Raffle.State.Open));
        r.draw();
    }

    function test_raffleRefundsInsteadOfRedrawWhenOracleSilent() public {
        Raffle r = newRaffle();
        vm.prank(alice);
        r.buyTickets{value: 2 ether}(2);
        vm.prank(bob);
        r.buyTickets{value: 1 ether}(1);
        vm.warp(block.timestamp + 1 days);
        uint256 id = r.draw();

        vm.expectRevert(Raffle.TooEarly.selector);
        r.enableRefunds();
        vm.roll(block.number + 1_001);
        r.enableRefunds();

        uint256 before = alice.balance;
        vm.prank(alice);
        r.refund();
        assertEq(alice.balance - before, 2 ether);
        vm.prank(alice);
        vm.expectRevert(Raffle.NothingToRefund.selector);
        r.refund();

        // a late oracle answer changes nothing
        mock.fulfillRandomWordsWithOverride(id, one(0));
        assertEq(r.winner(), address(0));
        assertEq(uint256(r.state()), uint256(Raffle.State.Refunding));
    }

    function testFuzz_raffleWinnerIsAlwaysATicketHolder(uint256 word, uint8 a, uint8 b) public {
        a = uint8(bound(a, 1, 20));
        b = uint8(bound(b, 0, 20));
        Raffle r = newRaffle();
        vm.prank(alice);
        r.buyTickets{value: uint256(a) * 1 ether}(a);
        if (b > 0) {
            vm.prank(bob);
            r.buyTickets{value: uint256(b) * 1 ether}(b);
        }
        vm.warp(block.timestamp + 1 days);
        uint256 id = r.draw();
        mock.fulfillRandomWordsWithOverride(id, one(word));
        address w = r.winner();
        assertTrue(w == alice || (b > 0 && w == bob));
        assertEq(w, word % (uint256(a) + b) < a ? alice : bob);
    }

    function test_raffleRejectsWrongPaymentAndLateSales() public {
        Raffle r = newRaffle();
        vm.prank(alice);
        vm.expectRevert(Raffle.WrongPayment.selector);
        r.buyTickets{value: 1.5 ether}(1);
        vm.warp(block.timestamp + 1 days);
        vm.prank(alice);
        vm.expectRevert(Raffle.SalesClosed.selector);
        r.buyTickets{value: 1 ether}(1);
    }

    // ------------------------------------------------------------------ RandomTraitsNFT

    function test_nftMintThenReveal() public {
        RandomTraitsNFT nft = new RandomTraitsNFT(address(mock), KEY, subId, 3, 0.1 ether);
        mock.addConsumer(subId, address(nft));
        vm.prank(alice);
        uint256 tokenId = nft.mint{value: 0.1 ether}();
        assertEq(nft.ownerOf(tokenId), alice);
        (bool revealed,,,,) = nft.traits(tokenId);
        assertFalse(revealed, "traits unknown at mint time");

        uint256 word = (uint256(5) << 192) | (uint256(9) << 128) | (uint256(3) << 64) | 99; // 99 -> legendary
        mock.fulfillRandomWordsWithOverride(1, one(word));
        (bool r2, RandomTraitsNFT.Rarity rarity, uint8 bg, uint8 body, uint8 acc) = nft.traits(tokenId);
        assertTrue(r2);
        assertEq(uint256(rarity), uint256(RandomTraitsNFT.Rarity.Legendary));
        assertEq(bg, 3);
        assertEq(body, 9);
        assertEq(acc, 5);
    }

    function test_nftRarityDistribution() public {
        RandomTraitsNFT nft = new RandomTraitsNFT(address(mock), KEY, subId, 3, 0);
        mock.addConsumer(subId, address(nft));
        uint256[4] memory counts;
        for (uint256 i = 0; i < 400; i++) {
            uint256 tokenId = nft.mint();
            mock.fulfillRandomWords(i + 1); // pseudo-random words from the mock
            (, RandomTraitsNFT.Rarity rarity,,,) = nft.traits(tokenId);
            counts[uint256(rarity)]++;
        }
        // 60/30/9/1 % with generous tolerance for 400 samples
        assertApproxEqAbs(counts[0], 240, 45);
        assertApproxEqAbs(counts[1], 120, 40);
        assertApproxEqAbs(counts[2], 36, 25);
        assertLe(counts[3], 15);
    }

    function onERC721Received(address, address, uint256, bytes calldata) external pure returns (bytes4) {
        return this.onERC721Received.selector;
    }

    // ------------------------------------------------------------------ TournamentSeeding

    function names(uint256 n) internal pure returns (string[] memory a) {
        a = new string[](n);
        for (uint256 i = 0; i < n; i++) {
            a[i] = string.concat("team-", vm.toString(i));
        }
    }

    function test_seedingIsAVerifiablePermutation() public {
        TournamentSeeding t = new TournamentSeeding(address(mock), KEY, subId, 3);
        mock.addConsumer(subId, address(t));
        t.addParticipants(names(16));
        uint256 id = t.requestSeeding();
        vm.expectRevert(TournamentSeeding.Frozen.selector);
        t.addParticipants(names(1));

        mock.fulfillRandomWordsWithOverride(id, one(0xDEADBEEF));
        string[] memory seeded = t.seeding();
        assertEq(seeded.length, 16);
        // anyone can recompute it from the public random word
        string[] memory again = t.shuffle(t.participants(), t.randomWord());
        for (uint256 i = 0; i < 16; i++) {
            assertEq(seeded[i], again[i]);
        }
        // it is a permutation: every team appears exactly once
        for (uint256 i = 0; i < 16; i++) {
            uint256 seen;
            for (uint256 k = 0; k < 16; k++) {
                if (keccak256(bytes(seeded[k])) == keccak256(bytes(string.concat("team-", vm.toString(i))))) seen++;
            }
            assertEq(seen, 1);
        }
    }

    function test_seedingFitsCallbackGasAtMaxSize() public {
        TournamentSeeding t = new TournamentSeeding(address(mock), KEY, subId, 3);
        mock.addConsumer(subId, address(t));
        t.addParticipants(names(128));
        uint256 id = t.requestSeeding();
        // the mock forwards exactly CALLBACK_GAS_LIMIT, like the real coordinator
        assertTrue(mock.fulfillRandomWordsWithOverride(id, one(42)));
        assertEq(t.seeding().length, 128, "callback did not run out of gas");
    }
}
