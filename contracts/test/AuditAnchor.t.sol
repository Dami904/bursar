// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Test} from "forge-std/Test.sol";
import {AuditAnchor} from "../src/AuditAnchor.sol";

contract AuditAnchorTest is Test {
    AuditAnchor internal anchor;
    address internal operator = makeAddr("operator");

    function setUp() public {
        anchor = new AuditAnchor(operator);
    }

    function test_anchorsInSequence() public {
        vm.startPrank(operator);
        anchor.anchor(keccak256("head-1"), 1, 10);
        anchor.anchor(keccak256("head-2"), 2, 25);
        vm.stopPrank();
        assertEq(anchor.latestSeq(), 2);
        (bytes32 head, uint64 decisions,) = anchor.anchors(2);
        assertEq(head, keccak256("head-2"));
        assertEq(decisions, 25);
    }

    function test_rejectsSkippedOrReplayedSequence() public {
        vm.startPrank(operator);
        vm.expectRevert(abi.encodeWithSelector(AuditAnchor.BadSequence.selector, 1, 2));
        anchor.anchor(keccak256("x"), 2, 1);
        anchor.anchor(keccak256("head-1"), 1, 1);
        vm.expectRevert(abi.encodeWithSelector(AuditAnchor.BadSequence.selector, 2, 1));
        anchor.anchor(keccak256("rewrite"), 1, 1);
        vm.stopPrank();
    }

    function test_rejectsDecisionCountGoingBackwards() public {
        vm.startPrank(operator);
        anchor.anchor(keccak256("head-1"), 1, 10);
        vm.expectRevert(AuditAnchor.DecisionsWentBackwards.selector);
        anchor.anchor(keccak256("head-2"), 2, 9);
        vm.stopPrank();
    }

    function test_onlyOperator() public {
        vm.expectRevert(AuditAnchor.NotOperator.selector);
        anchor.anchor(keccak256("x"), 1, 1);
    }

    function test_rejectsZeroOperator() public {
        vm.expectRevert(AuditAnchor.NotOperator.selector);
        new AuditAnchor(address(0));
    }
}
