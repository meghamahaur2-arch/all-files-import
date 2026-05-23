// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IERC20 {
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
}

/// @title PayMemo BatchPayout
/// @notice Stateless helper for paying many recipients in a single transaction.
/// @dev    Holds no funds, no admin, no upgrade path. ETH path uses checks-effects
///         -interactions with a reentrancy guard; ERC-20 path tolerates non-standard
///         tokens that return no boolean by inspecting the returndata.
contract BatchPayout {
    event EthPayout(bytes32 indexed batchId, address indexed sender, address indexed recipient, uint256 amount);
    event Erc20Payout(
        bytes32 indexed batchId,
        address indexed sender,
        address indexed token,
        address recipient,
        uint256 amount
    );
    event BatchSubmitted(bytes32 indexed batchId, address indexed sender, uint256 itemCount);

    error LengthMismatch();
    error IncorrectEthValue();
    error TransferFailed();
    error EmptyBatch();
    error TooManyRecipients();
    error Reentrancy();

    /// @dev Hard cap to keep a single batch within sane gas bounds and to bound
    ///      the worst-case loop length on any chain.
    uint256 private constant MAX_BATCH = 256;

    uint256 private _locked = 1;

    modifier nonReentrant() {
        if (_locked != 1) revert Reentrancy();
        _locked = 2;
        _;
        _locked = 1;
    }

    /// @notice Pay an arbitrary list of recipients in native ETH.
    /// @param  batchId    Caller-chosen identifier (for off-chain indexing only).
    /// @param  recipients Payable addresses.
    /// @param  amounts    Per-recipient amounts in wei. Sum must equal msg.value.
    function batchPayETH(bytes32 batchId, address payable[] calldata recipients, uint256[] calldata amounts)
        external
        payable
        nonReentrant
    {
        uint256 length = recipients.length;
        if (length != amounts.length) revert LengthMismatch();
        if (length == 0) revert EmptyBatch();
        if (length > MAX_BATCH) revert TooManyRecipients();

        uint256 total;
        for (uint256 i = 0; i < length; ) {
            total += amounts[i];
            unchecked { ++i; }
        }
        if (msg.value != total) revert IncorrectEthValue();

        emit BatchSubmitted(batchId, msg.sender, length);

        for (uint256 i = 0; i < length; ) {
            (bool ok, ) = recipients[i].call{value: amounts[i]}("");
            if (!ok) revert TransferFailed();
            emit EthPayout(batchId, msg.sender, recipients[i], amounts[i]);
            unchecked { ++i; }
        }
    }

    /// @notice Pay an arbitrary list of recipients in any ERC-20.
    /// @dev    The caller must have approved this contract for at least the
    ///         total amount. Uses a low-level call so that legacy tokens
    ///         which return no boolean (USDT-style) are tolerated.
    function batchPayERC20(
        bytes32 batchId,
        IERC20 token,
        address[] calldata recipients,
        uint256[] calldata amounts
    ) external nonReentrant {
        uint256 length = recipients.length;
        if (length != amounts.length) revert LengthMismatch();
        if (length == 0) revert EmptyBatch();
        if (length > MAX_BATCH) revert TooManyRecipients();

        emit BatchSubmitted(batchId, msg.sender, length);

        for (uint256 i = 0; i < length; ) {
            _safeTransferFrom(address(token), msg.sender, recipients[i], amounts[i]);
            emit Erc20Payout(batchId, msg.sender, address(token), recipients[i], amounts[i]);
            unchecked { ++i; }
        }
    }

    /// @dev Reverts on tokens that return `false`, on tokens that revert, and
    ///      accepts tokens that return nothing. Encoded inline to avoid an
    ///      external SafeERC20 dependency.
    function _safeTransferFrom(address token, address from, address to, uint256 amount) private {
        (bool ok, bytes memory data) = token.call(
            abi.encodeWithSelector(IERC20.transferFrom.selector, from, to, amount)
        );
        if (!ok) revert TransferFailed();
        if (data.length != 0 && !abi.decode(data, (bool))) revert TransferFailed();
    }
}
