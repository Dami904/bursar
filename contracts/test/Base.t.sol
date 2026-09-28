// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Test} from "forge-std/Test.sol";
import {JobVault} from "../src/JobVault.sol";
import {MockUSDC} from "./mocks/MockUSDC.sol";

/// @dev Shared setup: a vault, a funded owner, an operator, a payee and an approver.
abstract contract BaseTest is Test {
    MockUSDC internal usdc;
    JobVault internal vault;

    address internal owner = makeAddr("owner");
    address internal operator = makeAddr("operator");
    address internal agentWallet = makeAddr("agentWallet");
    address internal payee = makeAddr("payee");
    address internal stranger = makeAddr("stranger");
    uint256 internal approverKey = 0xA11CE;
    address internal approver = vm.addr(approverKey);

    bytes32 internal constant JOB = keccak256("job-1");
    uint128 internal constant BUDGET = 1_000_000; // 1.00 USDC
    uint128 internal constant PER_TX = 400_000;
    uint128 internal constant THRESHOLD = 250_000;
    uint128 internal constant WINDOW_CAP = 800_000;
    uint64 internal constant WINDOW = 1 hours;

    function setUp() public virtual {
        vm.warp(1_790_000_000);
        usdc = new MockUSDC();
        vault = _deployVault();
        usdc.mint(owner, 100_000_000);
        vm.prank(owner);
        usdc.approve(address(vault), type(uint256).max);
    }

    function _deployVault() internal virtual returns (JobVault) {
        return new JobVault(usdc, operator);
    }

    function _params() internal view returns (JobVault.JobParams memory) {
        return JobVault.JobParams({
            agentWallet: agentWallet,
            budget: BUDGET,
            perTxCap: PER_TX,
            approvalThreshold: THRESHOLD,
            windowCap: WINDOW_CAP,
            window: WINDOW,
            expiry: uint64(block.timestamp + 7 days)
        });
    }

    /// @dev An active, fully funded job with one allowed payee and one approver.
    function _openJob() internal {
        vm.startPrank(owner);
        vault.createJob(JOB, _params());
        vault.fund(JOB, BUDGET);
        vault.setPayee(JOB, payee, true);
        vault.setApprover(JOB, approver, true);
        vm.stopPrank();
    }

    function _noApproval() internal pure returns (JobVault.Approval memory) {
        return JobVault.Approval({approver: address(0), deadline: 0, signature: ""});
    }

    function _version() internal view returns (uint64) {
        return vault.getJob(JOB).policyVersion;
    }

    function _release(bytes32 opId, address to, uint128 amount) internal {
        uint64 version = _version();
        vm.prank(operator);
        vault.release(JOB, opId, to, amount, version, _noApproval());
    }

    function _approval(uint256 key, bytes32 opId, address to, uint128 amount, uint64 version, uint64 deadline)
        internal
        view
        returns (JobVault.Approval memory)
    {
        bytes32 digest = vault.approvalDigest(JOB, opId, to, amount, version, deadline);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, digest);
        return JobVault.Approval({approver: vm.addr(key), deadline: deadline, signature: abi.encodePacked(r, s, v)});
    }
}
