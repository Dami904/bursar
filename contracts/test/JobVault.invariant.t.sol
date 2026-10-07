// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Test} from "forge-std/Test.sol";
import {JobVault} from "../src/JobVault.sol";
import {MockUSDC} from "./mocks/MockUSDC.sol";

/// @dev Drives the vault with random actions across three jobs. Every call is bounded to plausible
///      inputs; calls that revert are simply skipped (fail_on_revert = false).
contract VaultHandler is Test {
    JobVault internal vault;
    MockUSDC internal usdc;
    address internal operator;
    address internal owner;
    address internal agentWallet;
    address internal payee;

    bytes32[3] public jobIds = [keccak256("inv-a"), keccak256("inv-b"), keccak256("inv-c")];
    uint256 internal nextOp = 1;

    // Ghost totals, tracked independently of the vault's own bookkeeping.
    mapping(bytes32 => uint256) public ghostReleased;
    mapping(bytes32 => uint256) public ghostRefunded;
    uint256 public ghostOpsReleasedTwice;

    constructor(
        JobVault vault_,
        MockUSDC usdc_,
        address operator_,
        address owner_,
        address agentWallet_,
        address payee_
    ) {
        vault = vault_;
        usdc = usdc_;
        operator = operator_;
        owner = owner_;
        agentWallet = agentWallet_;
        payee = payee_;
    }

    function fund(uint256 jobSeed, uint128 amount) external {
        bytes32 jobId = jobIds[jobSeed % 3];
        amount = uint128(bound(amount, 1, 2_000_000));
        usdc.mint(owner, amount);
        vm.prank(owner);
        vault.fund(jobId, amount);
    }

    function release(uint256 jobSeed, uint128 amount, bool toAgent, uint256 reuseSeed) external {
        bytes32 jobId = jobIds[jobSeed % 3];
        amount = uint128(bound(amount, 1, 1_000_000));
        // Sometimes retry an old operation ID: the vault must refuse it.
        bytes32 opId = reuseSeed % 4 == 0 && nextOp > 1 ? bytes32(bound(reuseSeed, 1, nextOp - 1)) : bytes32(nextOp++);
        bool alreadyUsed = vault.releasedFor(jobId, opId) != 0;
        uint64 version = vault.getJob(jobId).policyVersion;
        vm.prank(operator);
        try vault.release(jobId, opId, toAgent ? agentWallet : payee, amount, version, _none()) {
            if (alreadyUsed) ghostOpsReleasedTwice++;
            ghostReleased[jobId] += amount;
        } catch {}
    }

    function refund(uint256 jobSeed, uint256 opSeed, uint128 amount) external {
        if (nextOp == 1) return;
        bytes32 jobId = jobIds[jobSeed % 3];
        bytes32 opId = bytes32(bound(opSeed, 1, nextOp - 1));
        uint128 released = vault.releasedFor(jobId, opId);
        if (released == 0 || vault.refunded(jobId, opId)) return;
        amount = uint128(bound(amount, 1, released));
        // The money comes back to the vault first, as the agent wallet would send it.
        usdc.mint(address(this), amount);
        usdc.transfer(address(vault), amount);
        vm.prank(operator);
        try vault.refund(jobId, opId, amount) {
            ghostRefunded[jobId] += amount;
        } catch {}
    }

    function setBudget(uint256 jobSeed, uint128 budget) external {
        bytes32 jobId = jobIds[jobSeed % 3];
        budget = uint128(bound(budget, 1, 5_000_000));
        vm.prank(owner);
        try vault.setBudget(jobId, budget) {} catch {}
    }

    function pauseOrUnpause(uint256 jobSeed, bool pause) external {
        bytes32 jobId = jobIds[jobSeed % 3];
        vm.prank(pause ? operator : owner);
        if (pause) {
            try vault.pause(jobId) {} catch {}
        } else {
            try vault.unpause(jobId) {} catch {}
        }
    }

    function close(uint256 jobSeed) external {
        // Rarely: closing ends the job's story, so keep most runs open.
        if (jobSeed % 20 != 0) return;
        vm.prank(owner);
        try vault.closeJob(jobIds[jobSeed % 3]) {} catch {}
    }

    function warp(uint32 seconds_) external {
        vm.warp(block.timestamp + bound(seconds_, 1, 2 hours));
    }

    function _none() internal pure returns (JobVault.Approval memory) {
        return JobVault.Approval({approver: address(0), deadline: 0, signature: ""});
    }
}

contract JobVaultInvariantTest is Test {
    JobVault internal vault;
    MockUSDC internal usdc;
    VaultHandler internal handler;

    function setUp() public {
        vm.warp(1_790_000_000);
        address operator = makeAddr("operator");
        address owner = makeAddr("owner");
        address agentWallet = makeAddr("agentWallet");
        address payee = makeAddr("payee");
        usdc = new MockUSDC();
        vault = new JobVault(usdc, operator);
        handler = new VaultHandler(vault, usdc, operator, owner, agentWallet, payee);

        vm.startPrank(owner);
        usdc.approve(address(vault), type(uint256).max);
        for (uint256 i; i < 3; ++i) {
            bytes32 jobId = handler.jobIds(i);
            vault.createJob(
                jobId,
                JobVault.JobParams({
                    agentWallet: agentWallet,
                    budget: 3_000_000,
                    perTxCap: 1_000_000,
                    approvalThreshold: 1_000_000, // no approvals needed in this run
                    windowCap: 2_000_000,
                    window: 1 hours,
                    expiry: uint64(block.timestamp + 365 days)
                })
            );
            vault.setPayee(jobId, payee, true);
        }
        vm.stopPrank();
        targetContract(address(handler));
    }

    /// Spending never exceeds the approved budget, or what was deposited.
    function invariant_spentWithinBudgetAndDeposits() public view {
        for (uint256 i; i < 3; ++i) {
            JobVault.Job memory job = vault.getJob(handler.jobIds(i));
            assertLe(job.spent, job.budget, "spent > budget");
            assertLe(uint256(job.spent) + job.withdrawn, job.deposited, "spent + withdrawn > deposited");
        }
    }

    /// The vault always holds at least what it owes, and `accounted` is exactly what it owes.
    function invariant_balanceCoversEveryJob() public view {
        uint256 owed;
        for (uint256 i; i < 3; ++i) {
            owed += vault.available(handler.jobIds(i));
        }
        assertEq(vault.accounted(), owed, "accounted != sum of jobs");
        assertGe(usdc.balanceOf(address(vault)), owed, "balance < owed");
    }

    /// Net spend matches released minus refunded, per job.
    function invariant_spentMatchesReleasesMinusRefunds() public view {
        for (uint256 i; i < 3; ++i) {
            bytes32 jobId = handler.jobIds(i);
            assertEq(vault.getJob(jobId).spent, handler.ghostReleased(jobId) - handler.ghostRefunded(jobId));
        }
    }

    /// A closed job is owed nothing: whatever returns to it afterwards (a late refund) goes to its
    /// owner, so no money is ever left in the vault for a job that can't withdraw it.
    function invariant_closedJobsOweNothing() public view {
        for (uint256 i; i < 3; ++i) {
            bytes32 jobId = handler.jobIds(i);
            if (vault.getJob(jobId).status == JobVault.Status.Closed) {
                assertEq(vault.available(jobId), 0, "a closed job is owed money");
            }
        }
    }

    /// An operation ID never releases twice.
    function invariant_operationIdsAreSingleUse() public view {
        assertEq(handler.ghostOpsReleasedTwice(), 0);
    }
}
