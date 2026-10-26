// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * @title PhoneRegistry
 * @notice On-chain mapping from a PayPhone phone hash to a payout wallet.
 *
 * A phone number never touches the chain. The PayPhone Engine normalizes it
 * to E.164 and hashes it with a per-deployment pepper:
 *
 *     phoneHash = keccak256(pepper ‖ E164)
 *
 * The recipient — and only the recipient — can bind their hash to a wallet:
 * directly by sending the transaction, or indirectly through an EIP-712
 * signature so custodial flows (SMS-claim services) can register on the
 * user's behalf without holding their key.
 *
 * The engine resolves `phoneHash → wallet` with a single `eth_call`, so the
 * chain itself is the identity database.
 */
contract PhoneRegistry {
    /// @notice phoneHash → payout wallet (address(0) = unregistered).
    mapping(bytes32 => address) public registry;

    /// @notice When the current binding was registered (unix seconds).
    mapping(bytes32 => uint64) public registeredAt;

    /// @notice EIP-712 domain separator material.
    bytes32 public constant REGISTER_TYPEHASH =
        keccak256("Register(address wallet,bytes32 phoneHash,uint256 nonce)");

    address public immutable owner;

    event Registered(bytes32 indexed phoneHash, address indexed wallet, address indexed by);
    event Revoked(bytes32 indexed phoneHash);

    error Unauthorized();
    error ZeroAddress();

    modifier onlyOwner() {
        if (msg.sender != owner) revert Unauthorized();
        _;
    }

    constructor() {
        owner = msg.sender;
    }

    /**
     * @notice Bind (or re-bind) a phone hash to a payout wallet.
     * @param phoneHash keccak256(pepper ‖ E164) — computed off-chain.
     * @param wallet The recipient's receiving address.
     */
    function register(bytes32 phoneHash, address wallet) external {
        _register(phoneHash, wallet, msg.sender);
    }

    /**
     * @notice Register via signature — lets an SMS-claim service onboard a
     *         user who proves phone ownership out-of-band, without custody.
     * @param wallet Recipient wallet.
     * @param phoneHash The salted phone hash.
     * @param nonce Replay protection chosen by the relayer.
     * @param signature EIP-191 signature by `wallet` over the EIP-712 struct.
     */
    function registerBySignature(
        address wallet,
        bytes32 phoneHash,
        uint256 nonce,
        bytes calldata signature
    ) external {
        bytes32 digest = keccak256(
            abi.encodePacked("\x19Ethereum Signed Message:\n32",
                keccak256(abi.encode(REGISTER_TYPEHASH, wallet, phoneHash, nonce)))
        );
        address signer = _recover(digest, signature);
        if (signer != wallet) revert Unauthorized();
        _register(phoneHash, wallet, msg.sender);
    }

    /// @notice Remove a binding (self-service).
    function revoke(bytes32 phoneHash) external {
        if (registry[phoneHash] != msg.sender) revert Unauthorized();
        delete registry[phoneHash];
        delete registeredAt[phoneHash];
        emit Revoked(phoneHash);
    }

    /// @notice Resolve a hash — mirrors the engine's identity lookup.
    function resolve(bytes32 phoneHash) external view returns (address wallet, uint64 at) {
        return (registry[phoneHash], registeredAt[phoneHash]);
    }

    function _register(bytes32 phoneHash, address wallet, address by) internal {
        if (wallet == address(0)) revert ZeroAddress();
        registry[phoneHash] = wallet;
        registeredAt[phoneHash] = uint64(block.timestamp);
        emit Registered(phoneHash, wallet, by);
    }

    function _recover(bytes32 digest, bytes calldata signature) internal pure returns (address) {
        require(signature.length == 65, "bad signature length");
        bytes32 r; bytes32 s; uint8 v;
        // r, s, v — calldata slicing avoids memory copy
        assembly {
            r := calldataload(signature.offset)
            s := calldataload(add(signature.offset, 32))
            v := byte(0, calldataload(add(signature.offset, 64)))
        }
        return ecrecover(digest, v, r, s);
    }
}
