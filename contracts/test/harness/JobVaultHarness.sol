// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {JobVault} from "../../src/JobVault.sol";

/// @dev Test-only: lets the parity tests place a job in an exact state (prior spend, window
///      position, status) without replaying its whole history. Never deployed.
contract JobVaultHarness is JobVault {
    constructor(IERC20 usdc_, address operator_) JobVault(usdc_, operator_) {}

    function forceState(bytes32 jobId, Status status, uint128 spent, uint64 windowStart, uint128 windowSpent) external {
        Job storage job = _jobs[jobId];
        job.status = status;
        job.spent = spent;
        accounted -= spent;
        job.windowStart = windowStart;
        job.windowSpent = windowSpent;
    }
}
