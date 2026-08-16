// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {InfraXEscrow} from "../InfraXEscrow.sol";

/// @notice UUPS 升级测试用 V2 实现（bytecode 与 V1 不同，验证升级后 impl 切换 + 存储保留）
contract InfraXEscrowV2Mock is InfraXEscrow {
    /// @dev 升级验证要求调用父类 initializer（proxy 上实际存储不受影响，owner 保持现值）
    function initializeV2() external initializer {
        __Ownable_init(owner());
        __Pausable_init();
    }

    function version() external pure returns (string memory) {
        return "v2";
    }
}
