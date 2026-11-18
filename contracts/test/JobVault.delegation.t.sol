// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {JobVault} from "../src/JobVault.sol";
import {BaseTest} from "./Base.t.sol";

/// @dev A delegate that says nothing about signatures (no ERC-1271).
contract SilentDelegate {}

/// @dev A delegate that vouches for its own address's plain ECDSA signature, which is what a
///      well-behaved smart-account delegate does for the key that controls the account.
contract VouchingDelegate {
    bytes4 internal constant MAGIC = 0x1626ba7e;

    function isValidSignature(bytes32 hash, bytes calldata signature) external view returns (bytes4) {
        (address recovered, ECDSA.RecoverError err,) = ECDSA.tryRecover(hash, signature);
        return err == ECDSA.RecoverError.NoError && recovered == address(this) ? MAGIC : bytes4(0xffffffff);
    }
}

/// @notice What happens to an owner's approvals when their plain wallet address has been upgraded
///         (EIP-7702) so a wallet can bundle several calls into one confirmation.
/// @dev The vault checks an approver's signature with ECDSA when the address has no code, but asks
///      the address's code (ERC-1271) when it has some, and an upgraded address has code. These
///      tests pin down both outcomes so the web app only turns bundling on for wallets whose
///      upgrade keeps approvals working.
contract JobVaultDelegationTest is BaseTest {
    function _signedApproval() internal view returns (JobVault.Approval memory, uint64 version) {
        version = _version();
        return (_approval(approverKey, "op-1", payee, 300_000, version, uint64(block.timestamp + 1 hours)), version);
    }

    function test_plainAddress_approvalPays() public {
        _openJob();
        (JobVault.Approval memory a, uint64 version) = _signedApproval();
        assertEq(approver.code.length, 0);
        vm.prank(operator);
        vault.release(JOB, "op-1", payee, 300_000, version, a);
        assertEq(usdc.balanceOf(payee), 300_000);
    }

    function test_upgradedAddress_whoseDelegateIsSilent_approvalIsRefused() public {
        _openJob();
        (JobVault.Approval memory a, uint64 version) = _signedApproval();
        vm.signAndAttachDelegation(address(new SilentDelegate()), approverKey);
        vm.prank(operator);
        vm.expectRevert(JobVault.BadApproval.selector);
        vault.release(JOB, "op-1", payee, 300_000, version, a);
        assertEq(usdc.balanceOf(payee), 0);
    }

    function test_upgradedAddress_whoseDelegateVouches_approvalPays() public {
        _openJob();
        (JobVault.Approval memory a, uint64 version) = _signedApproval();
        vm.signAndAttachDelegation(address(new VouchingDelegate()), approverKey);
        vm.prank(operator);
        vault.release(JOB, "op-1", payee, 300_000, version, a);
        assertEq(usdc.balanceOf(payee), 300_000);
    }

    function test_upgradedAddress_whoseDelegateVouches_stillRefusesSomeoneElsesSignature() public {
        _openJob();
        uint64 version = _version();
        // Signed by a key that isn't the approver's, but claiming to be the approver.
        bytes32 digest = vault.approvalDigest(JOB, "op-1", payee, 300_000, version, uint64(block.timestamp + 1 hours));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(0xBAD, digest);
        JobVault.Approval memory forged = JobVault.Approval({
            approver: approver, deadline: uint64(block.timestamp + 1 hours), signature: abi.encodePacked(r, s, v)
        });
        vm.signAndAttachDelegation(address(new VouchingDelegate()), approverKey);
        vm.prank(operator);
        vm.expectRevert(JobVault.BadApproval.selector);
        vault.release(JOB, "op-1", payee, 300_000, version, forged);
    }
}
