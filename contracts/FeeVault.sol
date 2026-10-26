// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * @title FeeVault
 * @notice Transparent treasury for the PayPhone protocol's share of
 *         processing fees (60% of every fee, per the public schedule).
 *
 * Revenue transparency is a product requirement: anyone can verify
 * protocol income by summing {FeeReceived} events — no dashboard required,
 * no trust assumed. Withdrawals are restricted to the treasurer and emit
 * their own paper trail.
 */
contract FeeVault {
    address public immutable owner;
    address public treasurer;

    uint256 public totalReceived;
    mapping(address => uint256) public erc20Received;

    event FeeReceived(address indexed from, uint256 amount);
    event Erc20FeeReceived(address indexed token, address indexed from, uint256 amount);
    event Withdrawn(address indexed to, uint256 amount, string reason);
    event TreasurerUpdated(address indexed previous, address indexed current);

    error Unauthorized();

    modifier onlyAuthorized() {
        if (msg.sender != owner && msg.sender != treasurer) revert Unauthorized();
        _;
    }

    constructor(address _treasurer) {
        owner = msg.sender;
        treasurer = _treasurer;
    }

    /// @notice The PaymentRouter forwards the protocol share here.
    receive() external payable {
        totalReceived += msg.value;
        emit FeeReceived(msg.sender, msg.value);
    }

    /// @notice Accept ERC-20 protocol shares (stablecoin settlement).
    function receiveErc20(address token, uint256 amount) external {
        erc20Received[token] += amount;
        emit Erc20FeeReceived(token, msg.sender, amount);
        // pull pattern: the router transfers `amount` of `token` to this
        // contract before/after calling receiveErc20 (approve + receive).
    }

    function withdraw(address payable to, uint256 amount, string calldata reason)
        external
        onlyAuthorized
    {
        (bool ok, ) = to.call{value: amount}("");
        require(ok, "withdraw failed");
        emit Withdrawn(to, amount, reason);
    }

    function setTreasurer(address next) external {
        if (msg.sender != owner) revert Unauthorized();
        emit TreasurerUpdated(treasurer, next);
        treasurer = next;
    }

    function balance() external view returns (uint256) {
        return address(this).balance;
    }
}
