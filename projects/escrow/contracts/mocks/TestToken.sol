// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @notice 测试用 ERC20（OE-1 depositERC20/withdrawERC20 测试）
contract TestToken is ERC20 {
    constructor() ERC20("Test Token", "TST") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}
