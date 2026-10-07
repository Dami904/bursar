// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {JobVault} from "../src/JobVault.sol";
import {BaseTest} from "./Base.t.sol";

contract JobVaultTest is BaseTest {
    // ------------------------------------------------------------------ creation and funding

    function test_createJob_setsOwnerAndStartsActive() public {
        vm.prank(owner);
        vault.createJob(JOB, _params());
        JobVault.Job memory job = vault.getJob(JOB);
        assertEq(job.owner, owner);
        assertEq(uint8(job.status), uint8(JobVault.Status.Active));
        assertEq(job.policyVersion, 1);
        assertEq(job.budget, BUDGET);
    }

    function test_createJob_rejectsDuplicateId() public {
        vm.startPrank(owner);
        vault.createJob(JOB, _params());
        vm.expectRevert(JobVault.JobExists.selector);
        vault.createJob(JOB, _params());
        vm.stopPrank();
    }

    function test_createJob_rejectsBadParams() public {
        JobVault.JobParams memory p = _params();
        p.perTxCap = BUDGET + 1;
        vm.expectRevert(JobVault.InvalidParams.selector);
        vault.createJob(JOB, p);

        p = _params();
        p.windowCap = p.perTxCap - 1; // a window that couldn't fit one payment
        vm.expectRevert(JobVault.InvalidParams.selector);
        vault.createJob(JOB, p);

        p = _params();
        p.expiry = uint64(block.timestamp);
        vm.expectRevert(JobVault.InvalidParams.selector);
        vault.createJob(JOB, p);

        p = _params();
        p.agentWallet = address(0);
        vm.expectRevert(JobVault.InvalidParams.selector);
        vault.createJob(JOB, p);
    }

    function test_fund_anyoneCanPayIn() public {
        _openJob();
        usdc.mint(stranger, 500_000);
        vm.startPrank(stranger);
        usdc.approve(address(vault), 500_000);
        vm.expectEmit(address(vault));
        emit JobVault.Funded(JOB, stranger, 500_000);
        vault.fund(JOB, 500_000);
        vm.stopPrank();
        assertEq(vault.getJob(JOB).deposited, BUDGET + 500_000);
        assertEq(vault.accounted(), BUDGET + 500_000);
    }

    function test_fundWithPermit_fundsInOneTransaction() public {
        uint256 key = 0xB0B;
        address funder = vm.addr(key);
        usdc.mint(funder, 300_000);
        vm.prank(owner);
        vault.createJob(JOB, _params());

        uint256 deadline = block.timestamp + 1 hours;
        bytes32 structHash = keccak256(
            abi.encode(
                keccak256("Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)"),
                funder,
                address(vault),
                300_000,
                usdc.nonces(funder),
                deadline
            )
        );
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", usdc.DOMAIN_SEPARATOR(), structHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, digest);
        vm.prank(funder);
        vault.fundWithPermit(JOB, 300_000, deadline, v, r, s);
        assertEq(vault.getJob(JOB).deposited, 300_000);
    }

    // ------------------------------------------------------------------ release: happy path

    function test_release_paysAnAllowedPayee() public {
        _openJob();
        vm.expectEmit(address(vault));
        emit JobVault.Released(JOB, "op-1", payee, 200_000, false);
        _release("op-1", payee, 200_000);
        assertEq(usdc.balanceOf(payee), 200_000);
        assertEq(vault.getJob(JOB).spent, 200_000);
        assertEq(vault.releasedFor(JOB, "op-1"), 200_000);
        assertEq(vault.available(JOB), BUDGET - 200_000);
    }

    function test_release_canTopUpTheAgentWallet() public {
        _openJob();
        _release("op-1", agentWallet, 100_000);
        assertEq(usdc.balanceOf(agentWallet), 100_000);
    }

    // ------------------------------------------------------------------ release: each check

    function test_release_onlyOperator() public {
        _openJob();
        uint64 version = _version();
        vm.prank(owner);
        vm.expectRevert(JobVault.NotOperator.selector);
        vault.release(JOB, "op-1", payee, 1, version, _noApproval());
    }

    function test_release_deniesPausedJob() public {
        _openJob();
        vm.prank(owner);
        vault.pause(JOB);
        uint64 version = _version();
        vm.prank(operator);
        vm.expectRevert(JobVault.JobNotActive.selector);
        vault.release(JOB, "op-1", payee, 1, version, _noApproval());
    }

    function test_release_deniesAtExpiry() public {
        _openJob();
        vm.warp(vault.getJob(JOB).expiry);
        uint64 version = _version();
        vm.prank(operator);
        vm.expectRevert(JobVault.JobExpired.selector);
        vault.release(JOB, "op-1", payee, 1, version, _noApproval());
    }

    function test_release_deniesZero() public {
        _openJob();
        uint64 version = _version();
        vm.prank(operator);
        vm.expectRevert(JobVault.ZeroAmount.selector);
        vault.release(JOB, "op-1", payee, 0, version, _noApproval());
    }

    function test_release_deniesUnknownPayee_defaultDeny() public {
        _openJob();
        uint64 version = _version();
        vm.prank(operator);
        vm.expectRevert(JobVault.PayeeNotAllowed.selector);
        vault.release(JOB, "op-1", stranger, 1, version, _noApproval());
    }

    function test_release_deniesOverPerTxCap() public {
        _openJob();
        uint64 version = _version();
        vm.prank(operator);
        vm.expectRevert(JobVault.PerTxCapExceeded.selector);
        vault.release(JOB, "op-1", payee, PER_TX + 1, version, _noApproval());
    }

    function test_release_deniesOverBudget() public {
        _openJob();
        vm.prank(owner);
        vault.setLimits(JOB, PER_TX, BUDGET, BUDGET, WINDOW); // no approvals, no window limit
        _release("op-1", payee, 400_000);
        _release("op-2", payee, 400_000);
        uint64 version = _version();
        vm.prank(operator);
        vm.expectRevert(JobVault.BudgetExceeded.selector);
        vault.release(JOB, "op-3", payee, 200_001, version, _noApproval());
    }

    function test_release_deniesMoreThanDeposited() public {
        vm.startPrank(owner);
        vault.createJob(JOB, _params());
        vault.fund(JOB, 100_000);
        vault.setPayee(JOB, payee, true);
        vm.stopPrank();
        uint64 version = _version();
        vm.prank(operator);
        vm.expectRevert(JobVault.Underfunded.selector);
        vault.release(JOB, "op-1", payee, 100_001, version, _noApproval());
    }

    function test_release_rateLimitedWithinWindow_thenResets() public {
        _openJob();
        vm.prank(owner);
        vault.setLimits(JOB, 300_000, BUDGET, 300_000, WINDOW);
        _release("op-1", payee, 200_000);
        uint64 version = _version();
        vm.prank(operator);
        vm.expectRevert(JobVault.RateLimited.selector);
        vault.release(JOB, "op-2", payee, 100_001, version, _noApproval());

        vm.warp(block.timestamp + WINDOW);
        _release("op-2", payee, 100_001);
        assertEq(vault.getJob(JOB).windowSpent, 100_001);
    }

    /// The window is a fixed one: just before it ends a job can use its whole cap, and again just
    /// after. Documented in the contract; the budget and per-payment cap still bound the total.
    function test_release_fixedWindowAllowsTwiceTheCapAcrossABoundary() public {
        _openJob();
        vm.prank(owner);
        vault.setLimits(JOB, 300_000, BUDGET, 300_000, WINDOW);
        uint64 windowEnds = vault.getJob(JOB).windowStart + WINDOW;
        vm.warp(windowEnds - 1);
        _release("op-1", payee, 300_000);
        uint64 version = _version();
        vm.prank(operator);
        vm.expectRevert(JobVault.RateLimited.selector);
        vault.release(JOB, "op-2", payee, 1, version, _noApproval());
        vm.warp(windowEnds);
        _release("op-2", payee, 300_000);
        assertEq(vault.getJob(JOB).spent, 600_000);
        assertEq(vault.getJob(JOB).windowSpent, 300_000);
    }

    /// An approval threshold of zero means every release needs an approver, not none.
    function test_release_thresholdZeroNeedsAnApprovalForEveryRelease() public {
        _openJob();
        vm.prank(owner);
        vault.setLimits(JOB, PER_TX, 0, WINDOW_CAP, WINDOW);
        uint64 version = _version();
        vm.prank(operator);
        vm.expectRevert(JobVault.ApprovalRequired.selector);
        vault.release(JOB, "op-1", payee, 1, version, _noApproval());
    }

    function test_setLimits_rejectsAWindowCapBelowThePerPaymentCap() public {
        _openJob();
        vm.prank(owner);
        vm.expectRevert(JobVault.InvalidParams.selector);
        vault.setLimits(JOB, 300_000, THRESHOLD, 299_999, WINDOW);
    }

    function test_release_operationIdIsSingleUse() public {
        _openJob();
        _release("op-1", payee, 100_000);
        uint64 version = _version();
        vm.prank(operator);
        vm.expectRevert(JobVault.OpAlreadyUsed.selector);
        vault.release(JOB, "op-1", payee, 100_000, version, _noApproval());
    }

    function test_release_rejectsStalePolicyVersion() public {
        _openJob();
        uint64 decidedUnder = _version();
        vm.prank(owner);
        vault.setBudget(JOB, BUDGET - 1); // the owner tightens the rules mid-flight
        vm.prank(operator);
        vm.expectRevert(abi.encodeWithSelector(JobVault.StalePolicy.selector, decidedUnder + 1, decidedUnder));
        vault.release(JOB, "op-1", payee, 1, decidedUnder, _noApproval());
    }

    // ------------------------------------------------------------------ approvals (EIP-712)

    function test_approval_requiredAboveThreshold() public {
        _openJob();
        uint64 version = _version();
        vm.prank(operator);
        vm.expectRevert(JobVault.ApprovalRequired.selector);
        vault.release(JOB, "op-1", payee, THRESHOLD + 1, version, _noApproval());
    }

    function test_approval_validSignaturePays() public {
        _openJob();
        uint64 version = _version();
        JobVault.Approval memory a =
            _approval(approverKey, "op-1", payee, 300_000, version, uint64(block.timestamp + 1 hours));
        vm.expectEmit(address(vault));
        emit JobVault.Released(JOB, "op-1", payee, 300_000, true);
        vm.prank(operator);
        vault.release(JOB, "op-1", payee, 300_000, version, a);
        assertEq(usdc.balanceOf(payee), 300_000);
    }

    function test_approval_rejectsWrongSigner() public {
        _openJob();
        uint64 version = _version();
        JobVault.Approval memory a = _approval(0xBAD, "op-1", payee, 300_000, version, uint64(block.timestamp + 1));
        vm.prank(operator);
        vm.expectRevert(JobVault.BadApproval.selector);
        vault.release(JOB, "op-1", payee, 300_000, version, a);
    }

    function test_approval_rejectsSignatureClaimingAnotherApprover() public {
        _openJob();
        uint64 version = _version();
        JobVault.Approval memory a = _approval(0xBAD, "op-1", payee, 300_000, version, uint64(block.timestamp + 1));
        a.approver = approver; // claims to be the real approver, signed by someone else
        vm.prank(operator);
        vm.expectRevert(JobVault.BadApproval.selector);
        vault.release(JOB, "op-1", payee, 300_000, version, a);
    }

    function test_approval_rejectsDifferentAmountOrPayee() public {
        _openJob();
        vm.prank(owner);
        vault.setPayee(JOB, stranger, true);
        uint64 version = _version();
        uint64 deadline = uint64(block.timestamp + 1 hours);
        JobVault.Approval memory a = _approval(approverKey, "op-1", payee, 300_000, version, deadline);

        vm.startPrank(operator);
        vm.expectRevert(JobVault.BadApproval.selector);
        vault.release(JOB, "op-1", payee, 300_001, version, a);
        vm.expectRevert(JobVault.BadApproval.selector);
        vault.release(JOB, "op-1", stranger, 300_000, version, a);
        vm.stopPrank();
    }

    function test_approval_rejectsAfterDeadline() public {
        _openJob();
        uint64 version = _version();
        uint64 deadline = uint64(block.timestamp + 1 hours);
        JobVault.Approval memory a = _approval(approverKey, "op-1", payee, 300_000, version, deadline);
        vm.warp(deadline + 1);
        vm.prank(operator);
        vm.expectRevert(JobVault.BadApproval.selector);
        vault.release(JOB, "op-1", payee, 300_000, version, a);
    }

    function test_approval_cannotBeReplayedForAnotherOperation() public {
        _openJob();
        uint64 version = _version();
        uint64 deadline = uint64(block.timestamp + 1 hours);
        JobVault.Approval memory a = _approval(approverKey, "op-1", payee, 300_000, version, deadline);
        vm.startPrank(operator);
        vault.release(JOB, "op-1", payee, 300_000, version, a);
        vm.expectRevert(JobVault.BadApproval.selector);
        vault.release(JOB, "op-2", payee, 300_000, version, a);
        vm.stopPrank();
    }

    function test_approval_diesWhenTheOwnerChangesTheRules() public {
        _openJob();
        uint64 signedUnder = _version();
        JobVault.Approval memory a =
            _approval(approverKey, "op-1", payee, 300_000, signedUnder, uint64(block.timestamp + 1 hours));
        vm.prank(owner);
        vault.setApprover(JOB, makeAddr("second approver"), true);
        uint64 current = _version();
        vm.prank(operator);
        vm.expectRevert(JobVault.BadApproval.selector); // signed over the old version
        vault.release(JOB, "op-1", payee, 300_000, current, a);
    }

    function test_approval_removedApproverCanNoLongerApprove() public {
        _openJob();
        vm.prank(owner);
        vault.setApprover(JOB, approver, false);
        uint64 version = _version();
        JobVault.Approval memory a =
            _approval(approverKey, "op-1", payee, 300_000, version, uint64(block.timestamp + 1 hours));
        vm.prank(operator);
        vm.expectRevert(JobVault.BadApproval.selector);
        vault.release(JOB, "op-1", payee, 300_000, version, a);
    }

    function test_approval_domainIsBoundToThisContractAndChain() public {
        _openJob();
        JobVault other = new JobVault(usdc, operator);
        assertTrue(other.domainSeparator() != vault.domainSeparator());
        bytes32 a = vault.approvalDigest(JOB, "op-1", payee, 1, 1, 1);
        bytes32 b = other.approvalDigest(JOB, "op-1", payee, 1, 1, 1);
        assertTrue(a != b);
    }

    // ------------------------------------------------------------------ owner-only rule changes

    function test_rules_onlyOwnerCanChangeThem() public {
        _openJob();
        address[2] memory notOwners = [operator, stranger];
        for (uint256 i; i < notOwners.length; ++i) {
            vm.startPrank(notOwners[i]);
            vm.expectRevert(JobVault.NotOwner.selector);
            vault.setBudget(JOB, BUDGET * 2);
            vm.expectRevert(JobVault.NotOwner.selector);
            vault.setLimits(JOB, BUDGET, BUDGET, BUDGET, WINDOW);
            vm.expectRevert(JobVault.NotOwner.selector);
            vault.setPayee(JOB, notOwners[i], true);
            vm.expectRevert(JobVault.NotOwner.selector);
            vault.setApprover(JOB, notOwners[i], true);
            vm.expectRevert(JobVault.NotOwner.selector);
            vault.closeJob(JOB);
            vm.stopPrank();
        }
    }

    function test_rules_versionBumpsOnlyOnEffectiveChange() public {
        _openJob();
        uint64 before = _version();
        vm.startPrank(owner);
        vault.setPayee(JOB, payee, true); // already allowed
        vault.setApprover(JOB, approver, true); // already an approver
        vault.setBudget(JOB, BUDGET); // unchanged
        vault.setLimits(JOB, PER_TX, THRESHOLD, WINDOW_CAP, WINDOW); // unchanged
        vm.stopPrank();
        assertEq(_version(), before);

        vm.prank(owner);
        vault.setPayee(JOB, stranger, true);
        assertEq(_version(), before + 1);
    }

    function test_rules_budgetCantDropBelowSpent() public {
        _openJob();
        _release("op-1", payee, 200_000);
        vm.prank(owner);
        vm.expectRevert(JobVault.InvalidParams.selector);
        vault.setBudget(JOB, 199_999);
    }

    // ------------------------------------------------------------------ pause and close

    function test_pause_operatorCanPauseButNotUnpause() public {
        _openJob();
        vm.prank(operator);
        vault.pause(JOB);
        assertEq(uint8(vault.getJob(JOB).status), uint8(JobVault.Status.Paused));
        vm.prank(operator);
        vm.expectRevert(JobVault.NotOwner.selector);
        vault.unpause(JOB);
        vm.prank(owner);
        vault.unpause(JOB);
        assertEq(uint8(vault.getJob(JOB).status), uint8(JobVault.Status.Active));
    }

    function test_pause_strangerCantPause() public {
        _openJob();
        vm.prank(stranger);
        vm.expectRevert(JobVault.NotAuthorized.selector);
        vault.pause(JOB);
    }

    function test_close_returnsUnspentToOwnerAndStopsEverything() public {
        _openJob();
        _release("op-1", payee, 200_000);
        uint256 before = usdc.balanceOf(owner);
        vm.prank(owner);
        vault.closeJob(JOB);
        assertEq(usdc.balanceOf(owner) - before, BUDGET - 200_000);
        assertEq(vault.available(JOB), 0);
        assertEq(vault.accounted(), 0);

        uint64 version = _version();
        vm.prank(operator);
        vm.expectRevert(JobVault.JobNotActive.selector);
        vault.release(JOB, "op-2", payee, 1, version, _noApproval());
        vm.prank(owner);
        vm.expectRevert(JobVault.JobClosed.selector);
        vault.fund(JOB, 1);
    }

    // ------------------------------------------------------------------ refunds

    function test_refund_creditsTheJobOnceMoneyIsBack() public {
        _openJob();
        _release("op-1", agentWallet, 200_000);
        vm.prank(agentWallet);
        usdc.transfer(address(vault), 200_000); // x402 payment failed; wallet sends it back
        vm.expectEmit(address(vault));
        emit JobVault.Refunded(JOB, "op-1", 200_000);
        vm.prank(operator);
        vault.refund(JOB, "op-1", 200_000);
        assertEq(vault.getJob(JOB).spent, 0);
        assertEq(vault.available(JOB), BUDGET);
    }

    /// A refund that arrives after the owner closed the job goes to the owner, not into a balance
    /// nobody can withdraw.
    function test_refund_afterCloseGoesStraightToTheOwner() public {
        _openJob();
        _release("op-1", agentWallet, 200_000);
        vm.prank(owner);
        vault.closeJob(JOB); // takes the 800_000 that was left
        uint256 ownerBefore = usdc.balanceOf(owner);

        vm.prank(agentWallet);
        usdc.transfer(address(vault), 200_000); // the failed payment's money comes back late
        vm.expectEmit(address(vault));
        emit JobVault.Refunded(JOB, "op-1", 200_000);
        vm.expectEmit(address(vault));
        emit JobVault.Withdrawn(JOB, owner, 200_000);
        vm.prank(operator);
        vault.refund(JOB, "op-1", 200_000);

        assertEq(usdc.balanceOf(owner), ownerBefore + 200_000);
        assertEq(usdc.balanceOf(address(vault)), 0);
        assertEq(vault.accounted(), 0);
        assertEq(vault.available(JOB), 0);
        JobVault.Job memory job = vault.getJob(JOB);
        assertEq(job.spent, 0);
        assertEq(job.withdrawn, BUDGET);
        // Still only once.
        vm.prank(operator);
        vm.expectRevert(JobVault.AlreadyRefunded.selector);
        vault.refund(JOB, "op-1", 1);
    }

    function test_refund_afterCloseStillNeedsTheMoneyToHaveArrived() public {
        _openJob();
        _release("op-1", agentWallet, 200_000);
        vm.prank(owner);
        vault.closeJob(JOB);
        vm.prank(operator);
        vm.expectRevert(JobVault.RefundNotReceived.selector);
        vault.refund(JOB, "op-1", 200_000);
    }

    /// A refund doesn't lower the window's running total: the release may have been in an earlier
    /// window, and lowering this one's total for it would let a later window spend past its cap.
    function test_refund_doesntLowerTheWindowTotal() public {
        _openJob();
        _release("op-1", agentWallet, 200_000);
        vm.prank(agentWallet);
        usdc.transfer(address(vault), 200_000);
        vm.prank(operator);
        vault.refund(JOB, "op-1", 200_000);
        assertEq(vault.getJob(JOB).spent, 0);
        assertEq(vault.getJob(JOB).windowSpent, 200_000);
    }

    function test_refund_requiresTheMoneyToHaveArrived() public {
        _openJob();
        _release("op-1", agentWallet, 200_000);
        vm.prank(operator);
        vm.expectRevert(JobVault.RefundNotReceived.selector);
        vault.refund(JOB, "op-1", 200_000);
    }

    function test_refund_onlyOnceAndNeverMoreThanReleased() public {
        _openJob();
        _release("op-1", agentWallet, 200_000);
        vm.prank(agentWallet);
        usdc.transfer(address(vault), 200_000);
        vm.startPrank(operator);
        vm.expectRevert(JobVault.RefundTooLarge.selector);
        vault.refund(JOB, "op-1", 200_001);
        vault.refund(JOB, "op-1", 150_000);
        vm.expectRevert(JobVault.AlreadyRefunded.selector);
        vault.refund(JOB, "op-1", 100_000);
        vm.expectRevert(JobVault.NotReleased.selector);
        vault.refund(JOB, "op-never", 1);
        vm.stopPrank();
    }

    function test_refund_doesntReopenTheOperationId() public {
        _openJob();
        _release("op-1", agentWallet, 100_000);
        vm.prank(agentWallet);
        usdc.transfer(address(vault), 100_000);
        vm.prank(operator);
        vault.refund(JOB, "op-1", 100_000);
        uint64 version = _version();
        vm.prank(operator);
        vm.expectRevert(JobVault.OpAlreadyUsed.selector);
        vault.release(JOB, "op-1", payee, 100_000, version, _noApproval());
    }

    function test_refund_onlyOperator() public {
        _openJob();
        _release("op-1", agentWallet, 100_000);
        vm.prank(owner);
        vm.expectRevert(JobVault.NotOperator.selector);
        vault.refund(JOB, "op-1", 100_000);
    }

    // ------------------------------------------------------------------ fuzz

    function testFuzz_release_neverExceedsBudgetOrDeposit(uint128[8] memory amounts) public {
        _openJob();
        vm.prank(owner);
        vault.setLimits(JOB, BUDGET, BUDGET, BUDGET, WINDOW); // only budget and deposit bind
        for (uint256 i; i < amounts.length; ++i) {
            uint128 amount = uint128(bound(amounts[i], 1, BUDGET));
            uint64 version = _version();
            vm.prank(operator);
            try vault.release(JOB, bytes32(i + 1), payee, amount, version, _noApproval()) {} catch {}
            JobVault.Job memory job = vault.getJob(JOB);
            assertLe(job.spent, job.budget);
            assertLe(job.spent, job.deposited);
        }
        assertEq(usdc.balanceOf(payee), vault.getJob(JOB).spent);
    }

    function testFuzz_setLimits_rejectsPerTxCapAboveBudget(uint128 perTxCap) public {
        _openJob();
        perTxCap = uint128(bound(perTxCap, BUDGET + 1, type(uint128).max));
        vm.prank(owner);
        vm.expectRevert(JobVault.InvalidParams.selector);
        vault.setLimits(JOB, perTxCap, THRESHOLD, WINDOW_CAP, WINDOW);
    }
}
