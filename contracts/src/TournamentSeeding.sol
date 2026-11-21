// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {VerityConsumerBase} from "@pulseinput/contracts/verity/VerityConsumerBase.sol";

/**
 * @title TournamentSeeding
 * @notice Verifiably fair bracket seeding: the organizer registers participants, then one
 * random word drives a Fisher–Yates shuffle.
 *
 * Pattern: the callback stores ONLY the random word (fixed, small gas cost whatever the
 * field size); the seeding is derived from it in a view. Writing the shuffled list to storage
 * inside the callback would cost millions of gas for large fields and risk running out of
 * callback gas, which makes the fulfilment final with no result.
 *
 * The participant list is frozen before randomness is requested, so the organizer cannot
 * add or remove entrants after seeing the result.
 */
contract TournamentSeeding is VerityConsumerBase {
    uint32 public constant MAX_PARTICIPANTS = 128;
    /// The callback only stores one word
    uint32 public constant CALLBACK_GAS_LIMIT = 60_000;

    bytes32 public immutable keyHash;
    uint256 public immutable subId;
    uint16 public immutable confirmations;

    string[] internal s_participants;
    bool public frozen;
    bool public seeded;
    uint256 public seedingRequestId;
    uint256 public randomWord;

    event ParticipantAdded(uint256 index, string name);
    event SeedingRequested(uint256 requestId, uint256 participants);
    event Seeded(uint256 randomWord);

    error Frozen();
    error TooManyParticipants();
    error NeedTwoParticipants();

    constructor(address coordinator, bytes32 _keyHash, uint256 _subId, uint16 _confirmations)
        VerityConsumerBase(coordinator)
    {
        keyHash = _keyHash;
        subId = _subId;
        confirmations = _confirmations;
    }

    function addParticipants(string[] calldata names) external onlyOwner {
        if (frozen) revert Frozen();
        if (s_participants.length + names.length > MAX_PARTICIPANTS) revert TooManyParticipants();
        for (uint256 i = 0; i < names.length; i++) {
            s_participants.push(names[i]);
            emit ParticipantAdded(s_participants.length - 1, names[i]);
        }
    }

    function requestSeeding() external onlyOwner returns (uint256 requestId) {
        if (frozen) revert Frozen();
        if (s_participants.length < 2) revert NeedTwoParticipants();
        frozen = true; // the field is fixed before the randomness exists
        requestId = s_coordinator.requestRandomWords(keyHash, subId, confirmations, CALLBACK_GAS_LIMIT, 1);
        seedingRequestId = requestId;
        emit SeedingRequested(requestId, s_participants.length);
    }

    function fulfillRandomWords(uint256 requestId, uint256[] memory words) internal override {
        if (requestId != seedingRequestId || seeded) return;
        seeded = true;
        randomWord = words[0];
        emit Seeded(words[0]);
    }

    /// @notice Pure, so anyone can verify the published seeding from the random word.
    /// Fisher–Yates; step i draws from keccak256(word, i), so one 256-bit word covers any size.
    function shuffle(string[] memory list, uint256 word) public pure returns (string[] memory) {
        for (uint256 i = list.length - 1; i > 0; i--) {
            uint256 j = uint256(keccak256(abi.encode(word, i))) % (i + 1);
            (list[i], list[j]) = (list[j], list[i]);
        }
        return list;
    }

    function participants() external view returns (string[] memory) {
        return s_participants;
    }

    /// @notice Seed 1 first. Empty until the randomness arrives.
    function seeding() external view returns (string[] memory) {
        if (!seeded) return new string[](0);
        return shuffle(s_participants, randomWord);
    }
}
