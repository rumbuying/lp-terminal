/** Narrow ABI copied from Sourcify verified Robinhood Chain deployments on 2026-09-26.
 * Each write target must also pass the pinned runtime hash and registry checks. */
export const fablesRegistryAbi = [
  {
    "name": "activePools",
    "type": "function",
    "inputs": [],
    "outputs": [
      {
        "name": "active",
        "type": "tuple[]",
        "components": [
          {
            "name": "key",
            "type": "tuple",
            "components": [
              {
                "name": "currency0",
                "type": "address"
              },
              {
                "name": "currency1",
                "type": "address"
              },
              {
                "name": "fee",
                "type": "uint24"
              },
              {
                "name": "tickSpacing",
                "type": "int24"
              },
              {
                "name": "hooks",
                "type": "address"
              }
            ]
          },
          {
            "name": "id",
            "type": "bytes32"
          },
          {
            "name": "active",
            "type": "bool"
          }
        ]
      }
    ],
    "stateMutability": "view"
  }
] as const

export const fablesLensAbi = [
  {
    "name": "canClaim",
    "type": "function",
    "inputs": [
      {
        "name": "owner",
        "type": "address"
      },
      {
        "name": "key",
        "type": "tuple",
        "components": [
          {
            "name": "currency0",
            "type": "address"
          },
          {
            "name": "currency1",
            "type": "address"
          },
          {
            "name": "fee",
            "type": "uint24"
          },
          {
            "name": "tickSpacing",
            "type": "int24"
          },
          {
            "name": "hooks",
            "type": "address"
          }
        ]
      },
      {
        "name": "tickLower",
        "type": "int24"
      },
      {
        "name": "tickUpper",
        "type": "int24"
      }
    ],
    "outputs": [
      {
        "name": "c",
        "type": "tuple",
        "components": [
          {
            "name": "ok",
            "type": "bool"
          },
          {
            "name": "rangeExists",
            "type": "bool"
          },
          {
            "name": "paused",
            "type": "bool"
          },
          {
            "name": "claimable0",
            "type": "uint128"
          },
          {
            "name": "claimable1",
            "type": "uint128"
          },
          {
            "name": "hasClaimable",
            "type": "bool"
          },
          {
            "name": "effectiveClaimFeeBps",
            "type": "uint16"
          },
          {
            "name": "currentClaimFeeBps",
            "type": "uint16"
          },
          {
            "name": "maxFeeBpsToPass",
            "type": "uint16"
          }
        ]
      },
      {
        "name": "stamp",
        "type": "tuple",
        "components": [
          {
            "name": "arbBlockNumber",
            "type": "uint256"
          },
          {
            "name": "l1BlockNumber",
            "type": "uint256"
          },
          {
            "name": "timestamp",
            "type": "uint64"
          },
          {
            "name": "arbSysAnswered",
            "type": "bool"
          }
        ]
      }
    ],
    "stateMutability": "view"
  },
  {
    "name": "poolHeads",
    "type": "function",
    "inputs": [
      {
        "name": "keys",
        "type": "tuple[]",
        "components": [
          {
            "name": "currency0",
            "type": "address"
          },
          {
            "name": "currency1",
            "type": "address"
          },
          {
            "name": "fee",
            "type": "uint24"
          },
          {
            "name": "tickSpacing",
            "type": "int24"
          },
          {
            "name": "hooks",
            "type": "address"
          }
        ]
      }
    ],
    "outputs": [
      {
        "name": "heads",
        "type": "tuple[]",
        "components": [
          {
            "name": "poolId",
            "type": "bytes32"
          },
          {
            "name": "sqrtPriceX96",
            "type": "uint160"
          },
          {
            "name": "tick",
            "type": "int24"
          },
          {
            "name": "protocolFee",
            "type": "uint24"
          },
          {
            "name": "lpFee",
            "type": "uint24"
          },
          {
            "name": "liquidity",
            "type": "uint128"
          }
        ]
      },
      {
        "name": "stamp",
        "type": "tuple",
        "components": [
          {
            "name": "arbBlockNumber",
            "type": "uint256"
          },
          {
            "name": "l1BlockNumber",
            "type": "uint256"
          },
          {
            "name": "timestamp",
            "type": "uint64"
          },
          {
            "name": "arbSysAnswered",
            "type": "bool"
          }
        ]
      }
    ],
    "stateMutability": "view"
  },
  {
    "name": "quoteWithdraw",
    "type": "function",
    "inputs": [
      {
        "name": "owner",
        "type": "address"
      },
      {
        "name": "key",
        "type": "tuple",
        "components": [
          {
            "name": "currency0",
            "type": "address"
          },
          {
            "name": "currency1",
            "type": "address"
          },
          {
            "name": "fee",
            "type": "uint24"
          },
          {
            "name": "tickSpacing",
            "type": "int24"
          },
          {
            "name": "hooks",
            "type": "address"
          }
        ]
      },
      {
        "name": "tickLower",
        "type": "int24"
      },
      {
        "name": "tickUpper",
        "type": "int24"
      },
      {
        "name": "liquidity",
        "type": "uint128"
      }
    ],
    "outputs": [
      {
        "name": "w",
        "type": "tuple",
        "components": [
          {
            "name": "rangeId",
            "type": "uint256"
          },
          {
            "name": "ticksValid",
            "type": "bool"
          },
          {
            "name": "rangeExists",
            "type": "bool"
          },
          {
            "name": "shares",
            "type": "uint256"
          },
          {
            "name": "staked",
            "type": "uint128"
          },
          {
            "name": "sufficientShares",
            "type": "bool"
          },
          {
            "name": "amount0",
            "type": "uint256"
          },
          {
            "name": "amount1",
            "type": "uint256"
          },
          {
            "name": "claimable0",
            "type": "uint128"
          },
          {
            "name": "claimable1",
            "type": "uint128"
          },
          {
            "name": "total0",
            "type": "uint256"
          },
          {
            "name": "total1",
            "type": "uint256"
          },
          {
            "name": "effectiveClaimFeeBps",
            "type": "uint16"
          },
          {
            "name": "claimPaused",
            "type": "bool"
          }
        ]
      },
      {
        "name": "stamp",
        "type": "tuple",
        "components": [
          {
            "name": "arbBlockNumber",
            "type": "uint256"
          },
          {
            "name": "l1BlockNumber",
            "type": "uint256"
          },
          {
            "name": "timestamp",
            "type": "uint64"
          },
          {
            "name": "arbSysAnswered",
            "type": "bool"
          }
        ]
      }
    ],
    "stateMutability": "view"
  },
  {
    "name": "userRanges",
    "type": "function",
    "inputs": [
      {
        "name": "hook",
        "type": "address"
      },
      {
        "name": "owner",
        "type": "address"
      },
      {
        "name": "ids",
        "type": "uint256[]"
      }
    ],
    "outputs": [
      {
        "name": "rows",
        "type": "tuple[]",
        "components": [
          {
            "name": "rangeId",
            "type": "uint256"
          },
          {
            "name": "keyVerified",
            "type": "bool"
          },
          {
            "name": "key",
            "type": "tuple",
            "components": [
              {
                "name": "currency0",
                "type": "address"
              },
              {
                "name": "currency1",
                "type": "address"
              },
              {
                "name": "fee",
                "type": "uint24"
              },
              {
                "name": "tickSpacing",
                "type": "int24"
              },
              {
                "name": "hooks",
                "type": "address"
              }
            ]
          },
          {
            "name": "tickLower",
            "type": "int24"
          },
          {
            "name": "tickUpper",
            "type": "int24"
          },
          {
            "name": "shares",
            "type": "uint256"
          },
          {
            "name": "staked",
            "type": "uint128"
          },
          {
            "name": "claimable0",
            "type": "uint128"
          },
          {
            "name": "claimable1",
            "type": "uint128"
          },
          {
            "name": "totalShares",
            "type": "uint128"
          },
          {
            "name": "totalStaked",
            "type": "uint128"
          },
          {
            "name": "effectiveClaimFeeBps",
            "type": "uint16"
          },
          {
            "name": "claimPaused",
            "type": "bool"
          },
          {
            "name": "settling",
            "type": "bool"
          },
          {
            "name": "sqrtPriceX96",
            "type": "uint160"
          },
          {
            "name": "tick",
            "type": "int24"
          },
          {
            "name": "inRange",
            "type": "bool"
          },
          {
            "name": "ticksToLower",
            "type": "int24"
          },
          {
            "name": "ticksToUpper",
            "type": "int24"
          },
          {
            "name": "poolLiquidity",
            "type": "uint128"
          },
          {
            "name": "shareOfActiveLiquidityE18",
            "type": "uint256"
          },
          {
            "name": "amount0",
            "type": "uint256"
          },
          {
            "name": "amount1",
            "type": "uint256"
          }
        ]
      },
      {
        "name": "stamp",
        "type": "tuple",
        "components": [
          {
            "name": "arbBlockNumber",
            "type": "uint256"
          },
          {
            "name": "l1BlockNumber",
            "type": "uint256"
          },
          {
            "name": "timestamp",
            "type": "uint64"
          },
          {
            "name": "arbSysAnswered",
            "type": "bool"
          }
        ]
      }
    ],
    "stateMutability": "view"
  }
] as const

export const fablesHookAbi = [
  {
    "name": "Deposited",
    "type": "event",
    "inputs": [
      {
        "name": "owner",
        "type": "address",
        "indexed": true
      },
      {
        "name": "rangeId",
        "type": "uint256",
        "indexed": true
      },
      {
        "name": "liquidity",
        "type": "uint128",
        "indexed": false
      }
    ],
    "anonymous": false
  },
  {
    "name": "FeesClaimed",
    "type": "event",
    "inputs": [
      {
        "name": "owner",
        "type": "address",
        "indexed": true
      },
      {
        "name": "rangeId",
        "type": "uint256",
        "indexed": true
      },
      {
        "name": "amount0",
        "type": "uint256",
        "indexed": false
      },
      {
        "name": "amount1",
        "type": "uint256",
        "indexed": false
      }
    ],
    "anonymous": false
  },
  {
    "name": "Transfer",
    "type": "event",
    "inputs": [
      {
        "name": "caller",
        "type": "address",
        "indexed": false
      },
      {
        "name": "from",
        "type": "address",
        "indexed": true
      },
      {
        "name": "to",
        "type": "address",
        "indexed": true
      },
      {
        "name": "id",
        "type": "uint256",
        "indexed": true
      },
      {
        "name": "amount",
        "type": "uint256",
        "indexed": false
      }
    ],
    "anonymous": false
  },
  {
    "name": "Withdrawn",
    "type": "event",
    "inputs": [
      {
        "name": "owner",
        "type": "address",
        "indexed": true
      },
      {
        "name": "rangeId",
        "type": "uint256",
        "indexed": true
      },
      {
        "name": "liquidity",
        "type": "uint128",
        "indexed": false
      }
    ],
    "anonymous": false
  },
  {
    "name": "balanceOf",
    "type": "function",
    "inputs": [
      {
        "name": "owner",
        "type": "address"
      },
      {
        "name": "id",
        "type": "uint256"
      }
    ],
    "outputs": [
      {
        "name": "balance",
        "type": "uint256"
      }
    ],
    "stateMutability": "view"
  },
  {
    "name": "claimFees",
    "type": "function",
    "inputs": [
      {
        "name": "key",
        "type": "tuple",
        "components": [
          {
            "name": "currency0",
            "type": "address"
          },
          {
            "name": "currency1",
            "type": "address"
          },
          {
            "name": "fee",
            "type": "uint24"
          },
          {
            "name": "tickSpacing",
            "type": "int24"
          },
          {
            "name": "hooks",
            "type": "address"
          }
        ]
      },
      {
        "name": "tickLower",
        "type": "int24"
      },
      {
        "name": "tickUpper",
        "type": "int24"
      },
      {
        "name": "to",
        "type": "address"
      },
      {
        "name": "maxFeeBps",
        "type": "uint16"
      }
    ],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "name": "deposit",
    "type": "function",
    "inputs": [
      {
        "name": "key",
        "type": "tuple",
        "components": [
          {
            "name": "currency0",
            "type": "address"
          },
          {
            "name": "currency1",
            "type": "address"
          },
          {
            "name": "fee",
            "type": "uint24"
          },
          {
            "name": "tickSpacing",
            "type": "int24"
          },
          {
            "name": "hooks",
            "type": "address"
          }
        ]
      },
      {
        "name": "tickLower",
        "type": "int24"
      },
      {
        "name": "tickUpper",
        "type": "int24"
      },
      {
        "name": "liquidity",
        "type": "uint128"
      },
      {
        "name": "amount0Max",
        "type": "uint128"
      },
      {
        "name": "amount1Max",
        "type": "uint128"
      },
      {
        "name": "deadline",
        "type": "uint256"
      }
    ],
    "outputs": [],
    "stateMutability": "payable"
  },
  {
    "name": "effectiveClaimFee",
    "type": "function",
    "inputs": [
      {
        "name": "id",
        "type": "uint256"
      }
    ],
    "outputs": [
      {
        "name": "",
        "type": "uint16"
      }
    ],
    "stateMutability": "view"
  },
  {
    "name": "paused",
    "type": "function",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "bool"
      }
    ],
    "stateMutability": "view"
  },
  {
    "name": "pausedFor",
    "type": "function",
    "inputs": [
      {
        "name": "poolId",
        "type": "bytes32"
      }
    ],
    "outputs": [
      {
        "name": "",
        "type": "bool"
      }
    ],
    "stateMutability": "view"
  },
  {
    "name": "rangeId",
    "type": "function",
    "inputs": [
      {
        "name": "poolId",
        "type": "bytes32"
      },
      {
        "name": "tickLower",
        "type": "int24"
      },
      {
        "name": "tickUpper",
        "type": "int24"
      }
    ],
    "outputs": [
      {
        "name": "",
        "type": "uint256"
      }
    ],
    "stateMutability": "pure"
  },
  {
    "name": "rangeKey",
    "type": "function",
    "inputs": [
      {
        "name": "id",
        "type": "uint256"
      }
    ],
    "outputs": [
      {
        "name": "key",
        "type": "tuple",
        "components": [
          {
            "name": "currency0",
            "type": "address"
          },
          {
            "name": "currency1",
            "type": "address"
          },
          {
            "name": "fee",
            "type": "uint24"
          },
          {
            "name": "tickSpacing",
            "type": "int24"
          },
          {
            "name": "hooks",
            "type": "address"
          }
        ]
      },
      {
        "name": "tickLower",
        "type": "int24"
      },
      {
        "name": "tickUpper",
        "type": "int24"
      },
      {
        "name": "set",
        "type": "bool"
      }
    ],
    "stateMutability": "view"
  },
  {
    "name": "withdraw",
    "type": "function",
    "inputs": [
      {
        "name": "key",
        "type": "tuple",
        "components": [
          {
            "name": "currency0",
            "type": "address"
          },
          {
            "name": "currency1",
            "type": "address"
          },
          {
            "name": "fee",
            "type": "uint24"
          },
          {
            "name": "tickSpacing",
            "type": "int24"
          },
          {
            "name": "hooks",
            "type": "address"
          }
        ]
      },
      {
        "name": "tickLower",
        "type": "int24"
      },
      {
        "name": "tickUpper",
        "type": "int24"
      },
      {
        "name": "liquidity",
        "type": "uint128"
      },
      {
        "name": "to",
        "type": "address"
      },
      {
        "name": "amount0Min",
        "type": "uint128"
      },
      {
        "name": "amount1Min",
        "type": "uint128"
      },
      {
        "name": "deadline",
        "type": "uint256"
      }
    ],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "name": "withdrawAndClaim",
    "type": "function",
    "inputs": [
      {
        "name": "key",
        "type": "tuple",
        "components": [
          {
            "name": "currency0",
            "type": "address"
          },
          {
            "name": "currency1",
            "type": "address"
          },
          {
            "name": "fee",
            "type": "uint24"
          },
          {
            "name": "tickSpacing",
            "type": "int24"
          },
          {
            "name": "hooks",
            "type": "address"
          }
        ]
      },
      {
        "name": "tickLower",
        "type": "int24"
      },
      {
        "name": "tickUpper",
        "type": "int24"
      },
      {
        "name": "liquidity",
        "type": "uint128"
      },
      {
        "name": "to",
        "type": "address"
      },
      {
        "name": "amount0Min",
        "type": "uint128"
      },
      {
        "name": "amount1Min",
        "type": "uint128"
      },
      {
        "name": "deadline",
        "type": "uint256"
      },
      {
        "name": "maxFeeBps",
        "type": "uint16"
      }
    ],
    "outputs": [],
    "stateMutability": "nonpayable"
  }
] as const
