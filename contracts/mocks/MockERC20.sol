// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * @title MockERC20
 * @dev Mock ERC20 token contract for testing
 */
contract MockERC20 {
  string public name;
  string public symbol;
  uint8 public decimals = 18;

  mapping(address => uint256) public balanceOf;
  mapping(address => mapping(address => uint256)) public allowance;

  event Transfer(address indexed from, address indexed to, uint256 value);
  event Approval(address indexed owner, address indexed spender, uint256 value);

  constructor(string memory _name, string memory _symbol) {
    name = _name;
    symbol = _symbol;
  }

  function transfer(address to, uint256 value) external returns (bool) {
    require(balanceOf[msg.sender] >= value, "Insufficient balance");
    balanceOf[msg.sender] -= value;
    balanceOf[to] += value;
    emit Transfer(msg.sender, to, value);
    return true;
  }

  function transferFrom(address from, address to, uint256 value) external returns (bool) {
    require(balanceOf[from] >= value, "Insufficient balance");
    require(allowance[from][msg.sender] >= value, "Insufficient allowance");
    balanceOf[from] -= value;
    balanceOf[to] += value;
    allowance[from][msg.sender] -= value;
    emit Transfer(from, to, value);
    return true;
  }

  function approve(address spender, uint256 amount) external returns (bool) {
    allowance[msg.sender][spender] = amount;
    emit Approval(msg.sender, spender, amount);
    return true;
  }

  function mint(address to, uint256 amount) external {
    balanceOf[to] += amount;
    emit Transfer(address(0), to, amount);
  }
}

