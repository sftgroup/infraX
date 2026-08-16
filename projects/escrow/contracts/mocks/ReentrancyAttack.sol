// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {InfraXEscrow} from "../InfraXEscrow.sol";

/// @notice 重入攻击模拟合约（OE-1 §4.4 安全要点 1：withdraw 重入防护测试）
contract ReentrancyAttack {
    InfraXEscrow public escrow;
    bool public reentered;

    constructor(address escrow_) {
        escrow = InfraXEscrow(payable(escrow_));
    }

    /// @dev 存入后立即提现；receive 中再次尝试提现（重入），应被 ReentrancyGuard 拦截 revert
    function attack() external payable {
        escrow.deposit{value: msg.value}();
        escrow.withdraw(msg.value);
        reentered = true;
    }

    receive() external payable {
        // 无条件重入：withdraw 转账时再次调用 withdraw，应被 nonReentrant 拦截 revert
        if (!reentered) {
            escrow.withdraw(msg.value);
        }
    }
}
