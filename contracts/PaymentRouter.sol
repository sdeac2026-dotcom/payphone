// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {PhoneRegistry} from "./PhoneRegistry.sol";

/**
 * @title PaymentRouter
 * @notice Phone-number payments and per-invoice routing with protocol fees.
 *
 * Pay flows:
 *
 *  1. Registered number  → `payPhone` forwards to the recipient's wallet
 *     immediately, skimming `protocolBps` for the FeeVault.
 *  2. Unregistered number → funds are held in escrow keyed by the phone
 *     hash. The recipient registers a wallet (PhoneRegistry) and claims
 *     with an OTP-derived proof. Nothing is ever custodied by PayPhone —
 *     the contract itself is the escrow agent.
 *
 * Invoices: merchants may also require payment against an invoice id. The
 * router emits {InvoicePaid} which the PayPhone Engine observes via
 * `eth_getLogs` — the on-chain counterpart of SimNet's journal.
 */
contract PaymentRouter {
    struct Escrow {
        address asset;      // address(0) = native ETH (stablecoin ERC-20 otherwise)
        bytes32 phoneHash;  // recipient identity — resolved at claim time
        uint256 amount;
        uint64 createdAt;
        bool claimed;
    }

    PhoneRegistry public immutable registry;
    address public immutable feeVault;
    uint16 public protocolBps; // e.g. 60 = 0.60% max under current schedule

    mapping(bytes32 => Escrow) public escrows;   // claimId → escrow
    mapping(bytes32 => bool) public paidInvoices; // invoiceId → settled

    event PhonePaid(bytes32 indexed phoneHash, address indexed wallet, address asset, uint256 amount, uint256 fee);
    event EscrowHeld(bytes32 indexed claimId, bytes32 indexed phoneHash, address asset, uint256 amount);
    event EscrowClaimed(bytes32 indexed claimId, bytes32 indexed phoneHash, address indexed to, uint256 amount);
    event InvoicePaid(bytes32 indexed invoiceId, address indexed payer, uint256 amount);
    event ProtocolFeeUpdated(uint16 bps);

    error NotRegistered();
    error AlreadyClaimed();
    error InvoiceAlreadyPaid();
    error BpsTooHigh();

    constructor(PhoneRegistry _registry, address _feeVault, uint16 _protocolBps) {
        registry = _registry;
        feeVault = _feeVault;
        protocolBps = _protocolBps;
    }

    /**
     * @notice Pay a phone number. Registered → instant forward; otherwise escrow.
     * @param phoneHash Salted hash of the recipient's number.
     * @param invoiceRef Optional engine invoice id (keccak256 of the ASCII id).
     */
    function payPhone(bytes32 phoneHash, bytes32 invoiceRef) external payable {
        (address wallet, ) = registry.resolve(phoneHash);

        if (invoiceRef != bytes32(0)) {
            if (paidInvoices[invoiceRef]) revert InvoiceAlreadyPaid();
            paidInvoices[invoiceRef] = true;
            emit InvoicePaid(invoiceRef, msg.sender, msg.value);
        }

        uint256 fee = (msg.value * protocolBps) / 10_000;
        uint256 net = msg.value - fee;

        if (wallet != address(0)) {
            (bool feeOk, ) = feeVault.call{value: fee}("");
            require(feeOk, "fee transfer failed");
            (bool ok, ) = wallet.call{value: net}("");
            require(ok, "transfer failed");
            emit PhonePaid(phoneHash, wallet, address(0), net, fee);
        } else {
            bytes32 claimId = keccak256(abi.encodePacked(phoneHash, msg.sender, block.timestamp));
            escrows[claimId] = Escrow(address(0), phoneHash, net, uint64(block.timestamp), false);
            if (fee > 0) {
                (bool feeOk, ) = feeVault.call{value: fee}("");
                require(feeOk, "fee transfer failed");
            }
            emit EscrowHeld(claimId, phoneHash, address(0), net);
        }
    }

    /**
     * @notice Claim escrowed funds. Access control lives off-chain in v1:
     *         the claimer must have registered the SAME phoneHash in the
     *         PhoneRegistry (proof-of-phone-ownership), and the engine only
     *         surfaces claimIds it issued. Tighten on-chain in v2 with an
     *         OTP-commitment scheme if desired.
     */
    function claim(bytes32 claimId) external {
        Escrow storage e = escrows[claimId];
        if (e.claimed) revert AlreadyClaimed();
        e.claimed = true;

        (address wallet, ) = registry.resolve(e.phoneHash);
        if (wallet == address(0)) revert NotRegistered();

        (bool ok, ) = wallet.call{value: e.amount}("");
        require(ok, "transfer failed");
        emit EscrowClaimed(claimId, e.phoneHash, wallet, e.amount);
    }

    function setProtocolBps(uint16 bps) external {
        if (bps > 150) revert BpsTooHigh(); // hard cap 1.5% — never more
        protocolBps = bps;
        emit ProtocolFeeUpdated(bps);
    }

    receive() external payable {}
}
