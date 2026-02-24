// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

contract TaoHTLC {
    struct Swap {
        address sender;
        address receiver;
        uint256 amount;
        uint256 refundAfter;
        bytes32 hashlock;
        bool claimed;
        bool refunded;
    }

    mapping(bytes32 => Swap) public swaps;

    event Locked(
        bytes32 indexed swapId,
        address sender,
        address receiver,
        uint256 amount,
        uint256 refundAfter,
        bytes32 hashlock
    );
    event Claimed(bytes32 indexed swapId, bytes preimage);
    event Refunded(bytes32 indexed swapId);

    function lock(
        address receiver,
        bytes32 hashlock,
        uint256 refundAfter,
        bytes32 clientSalt
    ) external payable returns (bytes32 swapId) {
        require(msg.value > 0, "amount=0");
        require(receiver != address(0), "receiver=0");
        require(refundAfter > block.timestamp, "refundAfter <= now");

        swapId = keccak256(
            abi.encode(msg.sender, receiver, msg.value, refundAfter, hashlock, clientSalt)
        );

        require(swaps[swapId].sender == address(0), "swap exists");

        swaps[swapId] = Swap({
            sender: msg.sender,
            receiver: receiver,
            amount: msg.value,
            refundAfter: refundAfter,
            hashlock: hashlock,
            claimed: false,
            refunded: false
        });

        emit Locked(swapId, msg.sender, receiver, msg.value, refundAfter, hashlock);
    }

    function claim(bytes32 swapId, bytes calldata preimage) external {
        Swap storage s = swaps[swapId];
        require(s.sender != address(0), "swap not found");
        require(!s.claimed && !s.refunded, "swap closed");
        require(preimage.length == 32, "bad preimage length");
        require(sha256(preimage) == s.hashlock, "bad preimage");

        uint256 amount = s.amount;
        address receiver = s.receiver;
        delete swaps[swapId];

        (bool ok, ) = receiver.call{value: amount}("");
        require(ok, "transfer failed");

        emit Claimed(swapId, preimage);
    }

    function refund(bytes32 swapId) external {
        Swap storage s = swaps[swapId];
        require(s.sender != address(0), "swap not found");
        require(!s.claimed && !s.refunded, "swap closed");
        require(block.timestamp >= s.refundAfter, "too early");

        uint256 amount = s.amount;
        address sender = s.sender;
        delete swaps[swapId];

        (bool ok, ) = sender.call{value: amount}("");
        require(ok, "transfer failed");

        emit Refunded(swapId);
    }
}
