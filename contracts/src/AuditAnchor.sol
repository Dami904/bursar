// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

/// @title AuditAnchor
/// @notice Records the head of Bursar's hash-chained decision log on Arc. Each decision's hash
///         covers the previous one, so a posted head commits to the whole history up to it:
///         editing, deleting or reordering any earlier decision changes every later hash.
/// @dev Holds no money, so it's separate from JobVault and can be redeployed freely.
contract AuditAnchor {
    struct Anchor {
        bytes32 head;
        uint64 decisions;
        uint64 timestamp;
    }

    address public immutable operator;
    /// @dev A uint64 that moves up by one per anchor: it can't realistically overflow (one anchor a
    ///      second would take ~585 billion years).
    uint64 public latestSeq;
    mapping(uint64 seq => Anchor) public anchors;

    event Anchored(uint64 indexed seq, bytes32 head, uint64 decisions, uint64 timestamp);

    error NotOperator();
    error BadSequence(uint64 expected, uint64 got);
    error DecisionsWentBackwards();

    constructor(address operator_) {
        if (operator_ == address(0)) revert NotOperator();
        operator = operator_;
    }

    /// @param seq Must be exactly latestSeq + 1: anchors can't be skipped, replaced or replayed.
    /// @param decisions How many entries of the log `head` covers; never decreases. Bursar passes the
    ///        log's entry count and anchors only when it has grown, so equal counts don't arise in
    ///        practice; they are allowed so that an operator can't be locked out by a repeat.
    function anchor(bytes32 head, uint64 seq, uint64 decisions) external {
        if (msg.sender != operator) revert NotOperator();
        if (seq != latestSeq + 1) revert BadSequence(latestSeq + 1, seq);
        if (decisions < anchors[latestSeq].decisions) revert DecisionsWentBackwards();
        // forge-lint: disable-next-line(unsafe-typecast) -- uint64 seconds lasts ~584 billion years
        uint64 now_ = uint64(block.timestamp);
        anchors[seq] = Anchor(head, decisions, now_);
        latestSeq = seq;
        emit Anchored(seq, head, decisions, now_);
    }
}
