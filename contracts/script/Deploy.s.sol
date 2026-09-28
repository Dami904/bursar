// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Script, console2} from "forge-std/Script.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {AuditAnchor} from "../src/AuditAnchor.sol";
import {JobVault} from "../src/JobVault.sol";

/// @notice Deploys JobVault and AuditAnchor and records their addresses in
///         deployments/<chainId>.json.
///
///   USDC_ADDRESS=0x36... OPERATOR_ADDRESS=0x... \
///   forge script script/Deploy.s.sol --rpc-url arc_testnet --broadcast --private-key <deployer>
///
/// The deployer only pays for deployment; it gets no role in either contract. The operator key
/// (Bursar's server) can release within each job's rules and anchor the audit log.
contract Deploy is Script {
    function run() external returns (JobVault vault, AuditAnchor anchor) {
        address usdc = vm.envAddress("USDC_ADDRESS");
        address operator = vm.envAddress("OPERATOR_ADDRESS");

        vm.startBroadcast();
        vault = new JobVault(IERC20(usdc), operator);
        anchor = new AuditAnchor(operator);
        vm.stopBroadcast();

        console2.log("JobVault   ", address(vault));
        console2.log("AuditAnchor", address(anchor));

        string memory key = "deployment";
        vm.serializeUint(key, "chainId", block.chainid);
        vm.serializeAddress(key, "usdc", usdc);
        vm.serializeAddress(key, "operator", operator);
        vm.serializeAddress(key, "jobVault", address(vault));
        vm.serializeUint(key, "deployedAtBlock", block.number);
        string memory json = vm.serializeAddress(key, "auditAnchor", address(anchor));
        vm.writeJson(json, string.concat(vm.projectRoot(), "/deployments/", vm.toString(block.chainid), ".json"));
    }
}
