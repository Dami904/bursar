// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Permit.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {SignatureChecker} from "@openzeppelin/contracts/utils/cryptography/SignatureChecker.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @title JobVault
/// @notice Holds each job's USDC and enforces its spending envelope on-chain: budget, per-payment
///         cap, rolling window cap, payee allow-list, once-only operation IDs, and human approval
///         above a threshold. Only the job's owner can change those rules; Bursar's operator key can
///         only release money inside them (and pause in an emergency).
/// @dev Checks in `release` run in the same order as the off-chain policy engine
///      (packages/policy); shared vectors keep the two in step. Amounts are USDC base units
///      (6 decimals, ERC-20 interface). See PLAN.md §8.1.
///
///      The spending window is a fixed window that starts at the first release after the last one
///      ended, not a sliding one. Across a boundary a job can therefore release up to 2x `windowCap`
///      in a short time (the cap's full amount just before the window ends and again just after);
///      `budget`, `perTxCap` and `approvalThreshold` still bound the total, and the owner can pause.
///
///      The operator is immutable on purpose: it keeps the trust model to one key that can only
///      release inside each owner's rules. A leaked operator key is contained by those rules and by
///      the owner's own `pause`; replacing it means deploying a new vault (see docs/LIMITATIONS.md).
contract JobVault is EIP712, ReentrancyGuard {
    using SafeERC20 for IERC20;

    enum Status {
        None,
        Active,
        Paused,
        Closed
    }

    struct JobParams {
        address agentWallet;
        uint128 budget;
        uint128 perTxCap;
        uint128 approvalThreshold;
        uint128 windowCap;
        uint64 window;
        uint64 expiry;
    }

    struct Job {
        address owner;
        Status status;
        uint64 policyVersion;
        address agentWallet;
        uint64 expiry;
        uint128 budget;
        uint128 deposited;
        uint128 spent;
        uint128 withdrawn;
        uint128 perTxCap;
        uint128 approvalThreshold;
        uint128 windowCap;
        uint128 windowSpent;
        uint64 window;
        uint64 windowStart;
    }

    /// @notice A human approval for one release above the job's threshold.
    struct Approval {
        address approver;
        uint64 deadline;
        bytes signature;
    }

    bytes32 public constant APPROVAL_TYPEHASH = keccak256(
        "Approval(bytes32 jobId,bytes32 opId,address to,uint128 amount,uint64 policyVersion,uint64 deadline)"
    );

    IERC20 public immutable usdc;
    /// @notice Bursar's release key. Can release within the rules and pause; can't change rules.
    address public immutable operator;

    /// @notice USDC this contract owes to jobs. The token balance is always at least this.
    /// @dev A uint256 while each job's fields are uint128: the sum over every job can exceed one
    ///      job's range, and uint128 is itself ~3.4e14 USDC, far beyond any supply.
    uint256 public accounted;

    mapping(bytes32 jobId => Job) internal _jobs;
    mapping(bytes32 jobId => mapping(address payee => bool)) public isPayee;
    mapping(bytes32 jobId => mapping(address approver => bool)) public isApprover;
    /// @notice Amount released per operation. Non-zero means the operation ID is spent forever.
    mapping(bytes32 jobId => mapping(bytes32 opId => uint128)) public releasedFor;
    mapping(bytes32 jobId => mapping(bytes32 opId => bool)) public refunded;

    event JobCreated(bytes32 indexed jobId, address indexed owner, JobParams params);
    event Funded(bytes32 indexed jobId, address indexed from, uint256 amount);
    event Released(bytes32 indexed jobId, bytes32 indexed opId, address indexed to, uint128 amount, bool approved);
    event Refunded(bytes32 indexed jobId, bytes32 indexed opId, uint128 amount);
    event BudgetChanged(bytes32 indexed jobId, uint128 budget, uint64 policyVersion);
    event LimitsChanged(
        bytes32 indexed jobId,
        uint128 perTxCap,
        uint128 approvalThreshold,
        uint128 windowCap,
        uint64 window,
        uint64 policyVersion
    );
    event PayeeChanged(bytes32 indexed jobId, address indexed payee, bool allowed, uint64 policyVersion);
    event ApproverChanged(bytes32 indexed jobId, address indexed approver, bool allowed, uint64 policyVersion);
    event StatusChanged(bytes32 indexed jobId, Status status, uint64 policyVersion);
    event Withdrawn(bytes32 indexed jobId, address indexed to, uint256 amount);

    error NotOperator();
    error NotOwner();
    error NotAuthorized();
    error JobExists();
    error InvalidParams();
    error JobNotActive();
    error JobClosed();
    error JobExpired();
    error ZeroAmount();
    error PayeeNotAllowed();
    error PerTxCapExceeded();
    error BudgetExceeded();
    error Underfunded();
    error RateLimited();
    error OpAlreadyUsed();
    error StalePolicy(uint64 current, uint64 expected);
    error ApprovalRequired();
    error BadApproval();
    error NotReleased();
    error AlreadyRefunded();
    error RefundTooLarge();
    error RefundNotReceived();

    modifier onlyOperator() {
        if (msg.sender != operator) revert NotOperator();
        _;
    }

    modifier onlyOwner(bytes32 jobId) {
        if (msg.sender != _jobs[jobId].owner) revert NotOwner();
        _;
    }

    constructor(IERC20 usdc_, address operator_) EIP712("Bursar JobVault", "1") {
        if (address(usdc_) == address(0) || operator_ == address(0)) revert InvalidParams();
        usdc = usdc_;
        operator = operator_;
    }

    // ------------------------------------------------------------------ owner: lifecycle

    /// @notice Creates a job owned by the caller. The job starts Active with policyVersion 1.
    /// @dev `agentWallet` is fixed for the life of the job: a job whose agent wallet has to change
    ///      is closed (the owner gets the unspent USDC back) and opened again. The job id is
    ///      first come, first served, so ids should be unguessable until the transaction is mined.
    function createJob(bytes32 jobId, JobParams calldata p) external {
        if (_jobs[jobId].status != Status.None) revert JobExists();
        _validate(p.budget, p.perTxCap, p.windowCap, p.window);
        if (p.agentWallet == address(0) || p.expiry <= block.timestamp) revert InvalidParams();
        Job storage job = _jobs[jobId];
        job.owner = msg.sender;
        job.status = Status.Active;
        job.policyVersion = 1;
        job.agentWallet = p.agentWallet;
        job.expiry = p.expiry;
        job.budget = p.budget;
        job.perTxCap = p.perTxCap;
        job.approvalThreshold = p.approvalThreshold;
        job.windowCap = p.windowCap;
        job.window = p.window;
        // forge-lint: disable-next-line(unsafe-typecast) -- uint64 seconds lasts ~584 billion years
        job.windowStart = uint64(block.timestamp);
        emit JobCreated(jobId, msg.sender, p);
    }

    /// @notice Adds USDC to a job. Anyone can fund, so a customer can pay revenue straight in.
    function fund(bytes32 jobId, uint128 amount) external nonReentrant {
        _fund(jobId, amount);
    }

    /// @notice Funds in one transaction using an EIP-2612 permit. A permit that was front-run is
    ///         ignored as long as the allowance is already in place.
    /// @dev A failed permit is swallowed on purpose (anyone can burn a permit's nonce by submitting
    ///      it first). If the allowance isn't there either, the transfer below reverts with the
    ///      token's own allowance error. The caller must be sure of an allowance of at least `amount`.
    function fundWithPermit(bytes32 jobId, uint128 amount, uint256 deadline, uint8 v, bytes32 r, bytes32 s)
        external
        nonReentrant
    {
        // USDC's own permit; this function is nonReentrant, so the later state writes are safe.
        // slither-disable-next-line reentrancy-benign
        try IERC20Permit(address(usdc)).permit(msg.sender, address(this), amount, deadline, v, r, s) {} catch {}
        _fund(jobId, amount);
    }

    function setBudget(bytes32 jobId, uint128 budget) external onlyOwner(jobId) {
        Job storage job = _jobs[jobId];
        if (budget == 0 || budget < job.spent || budget < job.perTxCap) revert InvalidParams();
        if (budget == job.budget) return;
        job.budget = budget;
        emit BudgetChanged(jobId, budget, ++job.policyVersion);
    }

    /// @param approvalThreshold Releases above this need an approver's signature. Zero is a valid
    ///        setting meaning "approve every release"; use a very large value to need none.
    function setLimits(bytes32 jobId, uint128 perTxCap, uint128 approvalThreshold, uint128 windowCap, uint64 window)
        external
        onlyOwner(jobId)
    {
        Job storage job = _jobs[jobId];
        _validate(job.budget, perTxCap, windowCap, window);
        if (
            perTxCap == job.perTxCap && approvalThreshold == job.approvalThreshold && windowCap == job.windowCap
                && window == job.window
        ) return;
        job.perTxCap = perTxCap;
        job.approvalThreshold = approvalThreshold;
        job.windowCap = windowCap;
        job.window = window;
        emit LimitsChanged(jobId, perTxCap, approvalThreshold, windowCap, window, ++job.policyVersion);
    }

    function setPayee(bytes32 jobId, address payee, bool allowed) external onlyOwner(jobId) {
        if (payee == address(0)) revert InvalidParams();
        if (isPayee[jobId][payee] == allowed) return;
        isPayee[jobId][payee] = allowed;
        emit PayeeChanged(jobId, payee, allowed, ++_jobs[jobId].policyVersion);
    }

    function setApprover(bytes32 jobId, address approver, bool allowed) external onlyOwner(jobId) {
        if (approver == address(0)) revert InvalidParams();
        if (isApprover[jobId][approver] == allowed) return;
        isApprover[jobId][approver] = allowed;
        emit ApproverChanged(jobId, approver, allowed, ++_jobs[jobId].policyVersion);
    }

    /// @notice Stops all releases. The owner or, in an emergency, the operator can pause.
    function pause(bytes32 jobId) external {
        Job storage job = _jobs[jobId];
        if (msg.sender != job.owner && msg.sender != operator) revert NotAuthorized();
        if (job.status != Status.Active) revert JobNotActive();
        job.status = Status.Paused;
        emit StatusChanged(jobId, Status.Paused, ++job.policyVersion);
    }

    /// @notice Only the owner can resume a paused job.
    function unpause(bytes32 jobId) external onlyOwner(jobId) {
        Job storage job = _jobs[jobId];
        if (job.status != Status.Paused) revert JobNotActive();
        job.status = Status.Active;
        emit StatusChanged(jobId, Status.Active, ++job.policyVersion);
    }

    /// @notice Closes the job for good and returns every unspent USDC to the owner.
    function closeJob(bytes32 jobId) external nonReentrant onlyOwner(jobId) {
        Job storage job = _jobs[jobId];
        if (job.status == Status.Closed) revert JobClosed();
        job.status = Status.Closed;
        uint128 amount = _available(job);
        job.withdrawn += amount;
        accounted -= amount;
        emit StatusChanged(jobId, Status.Closed, ++job.policyVersion);
        if (amount > 0) {
            emit Withdrawn(jobId, job.owner, amount);
            usdc.safeTransfer(job.owner, amount);
        }
    }

    // ------------------------------------------------------------------ operator: spending

    /// @notice Pays `amount` to an allow-listed payee or to the job's agent wallet.
    /// @param expectedPolicyVersion The policy version Bursar decided under. If the owner changed
    ///        the rules since, the release is rejected rather than silently applied.
    function release(
        bytes32 jobId,
        bytes32 opId,
        address to,
        uint128 amount,
        uint64 expectedPolicyVersion,
        Approval calldata approval
    ) external nonReentrant onlyOperator {
        Job storage job = _jobs[jobId];
        if (job.status != Status.Active) revert JobNotActive();
        if (block.timestamp >= job.expiry) revert JobExpired();
        if (amount == 0) revert ZeroAmount();
        if (!isPayee[jobId][to] && to != job.agentWallet) revert PayeeNotAllowed();
        if (amount > job.perTxCap) revert PerTxCapExceeded();
        if (job.spent + amount > job.budget) revert BudgetExceeded();
        if (amount > _available(job)) revert Underfunded();
        if (block.timestamp >= uint256(job.windowStart) + job.window) {
            // forge-lint: disable-next-line(unsafe-typecast) -- uint64 seconds lasts ~584 billion years
            job.windowStart = uint64(block.timestamp);
            job.windowSpent = 0;
        }
        if (job.windowSpent + amount > job.windowCap) revert RateLimited();
        if (releasedFor[jobId][opId] != 0) revert OpAlreadyUsed();
        if (job.policyVersion != expectedPolicyVersion) {
            revert StalePolicy(job.policyVersion, expectedPolicyVersion);
        }
        bool approved = amount > job.approvalThreshold;
        if (approved) _checkApproval(jobId, opId, to, amount, job.policyVersion, approval);

        job.spent += amount;
        job.windowSpent += amount;
        releasedFor[jobId][opId] = amount;
        accounted -= amount;
        // The only earlier external call is the ERC-1271 check, a read-only staticcall; release is
        // nonReentrant.
        // forge-lint: disable-next-line(reentrancy-events)
        emit Released(jobId, opId, to, amount, approved);
        usdc.safeTransfer(to, amount);
    }

    /// @notice Credits a job back for money that returned to the vault after a failed payment
    ///         (the agent wallet sends it back first). Each operation refunds at most once and
    ///         never more than it released; the USDC must already be here.
    /// @dev If the job was closed in the meantime, its owner has already taken everything out, so
    ///      the returned money goes straight to the owner instead of being credited to a job that
    ///      can no longer pay it out.
    ///
    ///      The window's running total is not reduced by a refund. The release may have been in an
    ///      earlier window, and the vault doesn't record which: lowering the current window's total
    ///      by an old refund would let a later window spend past its cap. The cost is conservative
    ///      (a refunded payment still counts against its window until the window ends).
    function refund(bytes32 jobId, bytes32 opId, uint128 amount) external nonReentrant onlyOperator {
        Job storage job = _jobs[jobId];
        uint128 released = releasedFor[jobId][opId];
        if (released == 0) revert NotReleased();
        if (refunded[jobId][opId]) revert AlreadyRefunded();
        if (amount == 0) revert ZeroAmount();
        if (amount > released) revert RefundTooLarge();
        if (usdc.balanceOf(address(this)) < accounted + amount) revert RefundNotReceived();
        refunded[jobId][opId] = true;
        job.spent -= amount;
        emit Refunded(jobId, opId, amount);
        if (job.status == Status.Closed) {
            // Closed: the owner already withdrew the job's balance, so pay this to them directly.
            job.withdrawn += amount;
            emit Withdrawn(jobId, job.owner, amount);
            usdc.safeTransfer(job.owner, amount);
        } else {
            accounted += amount;
        }
    }

    // ------------------------------------------------------------------ views

    function getJob(bytes32 jobId) external view returns (Job memory) {
        return _jobs[jobId];
    }

    function available(bytes32 jobId) external view returns (uint128) {
        return _available(_jobs[jobId]);
    }

    function approvalDigest(
        bytes32 jobId,
        bytes32 opId,
        address to,
        uint128 amount,
        uint64 policyVersion,
        uint64 deadline
    ) public view returns (bytes32) {
        return _hashTypedDataV4(
            keccak256(abi.encode(APPROVAL_TYPEHASH, jobId, opId, to, amount, policyVersion, deadline))
        );
    }

    function domainSeparator() external view returns (bytes32) {
        return _domainSeparatorV4();
    }

    // ------------------------------------------------------------------ internal

    function _fund(bytes32 jobId, uint128 amount) private {
        Job storage job = _jobs[jobId];
        if (job.status == Status.None) revert JobNotActive();
        if (job.status == Status.Closed) revert JobClosed();
        if (amount == 0) revert ZeroAmount();
        job.deposited += amount;
        accounted += amount;
        // The only earlier external call is the optional permit in fundWithPermit; both callers
        // are nonReentrant.
        // forge-lint: disable-next-line(reentrancy-events)
        emit Funded(jobId, msg.sender, amount);
        usdc.safeTransferFrom(msg.sender, address(this), amount);
    }

    function _available(Job storage job) private view returns (uint128) {
        return job.deposited - job.spent - job.withdrawn;
    }

    function _validate(uint128 budget, uint128 perTxCap, uint128 windowCap, uint64 window) private pure {
        // A window cap below the per-payment cap would refuse some or all payments for no reason.
        if (budget == 0 || perTxCap == 0 || perTxCap > budget || windowCap < perTxCap || window == 0) {
            revert InvalidParams();
        }
    }

    function _checkApproval(
        bytes32 jobId,
        bytes32 opId,
        address to,
        uint128 amount,
        uint64 policyVersion,
        Approval calldata approval
    ) private view {
        if (approval.approver == address(0)) revert ApprovalRequired();
        if (!isApprover[jobId][approval.approver] || block.timestamp > approval.deadline) {
            revert BadApproval();
        }
        bytes32 digest = approvalDigest(jobId, opId, to, amount, policyVersion, approval.deadline);
        // SignatureChecker accepts both EOAs and smart-contract wallets (ERC-1271).
        if (!SignatureChecker.isValidSignatureNow(approval.approver, digest, approval.signature)) {
            revert BadApproval();
        }
    }
}
