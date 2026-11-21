// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {VerityConsumerBase} from "@pulseinput/contracts/verity/VerityConsumerBase.sol";

/**
 * @title Raffle
 * @notice Buy tickets with native coin; one verifiable random draw picks the winner.
 *
 * Patterns this example demonstrates (copy them):
 *  1. Lock state when randomness is REQUESTED: once the draw starts, nobody can buy tickets.
 *  2. Exactly one draw per raffle: no function lets anyone re-request after seeing a result.
 *  3. If the oracle never answers (the request is cancelled after the coordinator timeout),
 *     players get REFUNDS. There is never a second draw, because a re-draw would let a
 *     requester who saw an unfavourable result in the mempool force a new one.
 *  4. Pull payments: the winner withdraws; the callback only records the result.
 */
contract Raffle is VerityConsumerBase {
    enum State {
        Open,
        Drawing,
        Won,
        Refunding
    }

    uint32 public constant CALLBACK_GAS_LIMIT = 100_000;

    bytes32 public immutable keyHash;
    uint256 public immutable subId;
    uint16 public immutable confirmations;
    uint256 public immutable ticketPrice;
    uint256 public immutable closesAt;
    /// Blocks after the draw request before players may switch to refunds
    uint256 public immutable refundAfterBlocks;

    State public state;
    address[] public tickets;
    mapping(address => uint256) public ticketsOf;
    uint256 public drawRequestId;
    uint256 public drawRequestedAt;
    address public winner;
    bool public prizeClaimed;

    event TicketsBought(address indexed buyer, uint256 count);
    event DrawRequested(uint256 indexed requestId);
    event WinnerDrawn(address indexed winner, uint256 ticketIndex, uint256 prize);
    event RefundsEnabled();

    error WrongState(State have, State want);
    error WrongPayment();
    error SalesClosed();
    error TooEarly();
    error NoTickets();
    error NotWinner();
    error NothingToRefund();
    error TransferFailed();

    constructor(
        address coordinator,
        bytes32 _keyHash,
        uint256 _subId,
        uint16 _confirmations,
        uint256 _ticketPrice,
        uint256 _closesAt,
        uint256 _refundAfterBlocks
    ) VerityConsumerBase(coordinator) {
        keyHash = _keyHash;
        subId = _subId;
        confirmations = _confirmations;
        ticketPrice = _ticketPrice;
        closesAt = _closesAt;
        refundAfterBlocks = _refundAfterBlocks;
    }

    modifier inState(State s) {
        if (state != s) revert WrongState(state, s);
        _;
    }

    function buyTickets(uint256 count) external payable inState(State.Open) {
        if (block.timestamp >= closesAt) revert SalesClosed();
        if (count == 0 || msg.value != count * ticketPrice) revert WrongPayment();
        for (uint256 i = 0; i < count; i++) {
            tickets.push(msg.sender);
        }
        ticketsOf[msg.sender] += count;
        emit TicketsBought(msg.sender, count);
    }

    /// @notice Anyone may start the draw once sales have closed.
    function draw() external inState(State.Open) returns (uint256 requestId) {
        if (block.timestamp < closesAt) revert TooEarly();
        if (tickets.length == 0) revert NoTickets();
        state = State.Drawing; // (1) lock before asking for randomness
        requestId = s_coordinator.requestRandomWords(keyHash, subId, confirmations, CALLBACK_GAS_LIMIT, 1);
        drawRequestId = requestId;
        drawRequestedAt = block.number;
        emit DrawRequested(requestId);
    }

    function fulfillRandomWords(uint256 requestId, uint256[] memory words) internal override {
        // Ignore anything but our one draw (e.g. a late answer after refunds started).
        if (state != State.Drawing || requestId != drawRequestId) return;
        uint256 index = words[0] % tickets.length;
        winner = tickets[index];
        state = State.Won;
        emit WinnerDrawn(winner, index, address(this).balance);
    }

    function claimPrize() external inState(State.Won) {
        if (msg.sender != winner) revert NotWinner();
        prizeClaimed = true;
        _send(winner, address(this).balance);
    }

    /// @notice (3) If no result arrived in time, switch to refunds. Never re-draw.
    function enableRefunds() external inState(State.Drawing) {
        if (block.number <= drawRequestedAt + refundAfterBlocks) revert TooEarly();
        state = State.Refunding;
        emit RefundsEnabled();
    }

    function refund() external inState(State.Refunding) {
        uint256 n = ticketsOf[msg.sender];
        if (n == 0) revert NothingToRefund();
        ticketsOf[msg.sender] = 0;
        _send(msg.sender, n * ticketPrice);
    }

    function ticketCount() external view returns (uint256) {
        return tickets.length;
    }

    function _send(address to, uint256 amount) private {
        (bool ok,) = to.call{value: amount}("");
        if (!ok) revert TransferFailed();
    }
}
