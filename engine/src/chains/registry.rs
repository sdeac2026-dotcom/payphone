//! Multi-chain registry — the supported-network & asset source of truth.
//!
//! Every network shipped here is a **real, production mainnet** with:
//! - a canonical chain id (verified live via `eth_chainId` on the default RPC),
//! - vetted token contracts (two-source rule: CoinGecko tokenlist address +
//!   on-chain `symbol()`/`decimals()` probe — see `scripts/assemble_registry.py`),
//! - sane confirmation depths for finality-sensitive settlement,
//! - a **pool** of free public RPC gateways (each probed live with
//!   `eth_chainId` before inclusion — dead or non-standard gateways never
//!   ship). The engine rotates across the pool and fails over automatically,
//!   so no single free gateway can take a network down. Operators can splice
//!   a dedicated provider in front with `EVM_RPC_<NAME>`; the public pool
//!   then acts as free fallbacks behind it.
//!
//! Verification history (2026-10, live on-chain checks):
//! - `eth_chainId` correct on every network,
//! - every token entry below passed an on-chain `symbol()`+`decimals()` probe
//!   on its own network (candidates that failed were DROPPED, never guessed),
//! - `eth_getLogs` Transfer queries returned real payments on all networks.
//! - worldchain (chain 480) added 2026-10-27: `eth_chainId` = 0x1e0 on the
//!   official Alchemy public RPC; USDC / USDT0 / WLD each passed a live
//!   `symbol()`+`decimals()` probe (explorer cross-checked worldscan.org).
//!
//! Adding a network = one `NetworkSpec` entry. Adding a token = one
//! `TokenSpec` entry (verified). Adding an invoice-able asset = one
//! `AssetSpec` entry. Nothing else in the engine hardcodes chains.

/// A token that can settle invoices on a given network.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TokenSpec {
    /// Display symbol, e.g. `USDC` (matches invoice `asset` field).
    pub symbol: &'static str,
    /// ERC-20 contract address (checksummed display form; matching is
    /// case-insensitive).
    pub address: &'static str,
    pub decimals: u8,
}

/// A real EVM network the engine can watch.
#[derive(Debug, Clone, Copy)]
pub struct NetworkSpec {
    /// Canonical network name used in API requests (`network` field).
    pub name: &'static str,
    /// EVM chain id — verified against the live RPC at boot/diagnostic time.
    pub chain_id: u64,
    /// Native gas asset symbol (used when an invoice settles in native).
    pub native: &'static str,
    /// Confirmations required before a payment is counted as observed.
    pub confirmations: u64,
    /// Free public RPC gateways, verified by a live `eth_chainId` probe at
    /// registry build time. Index 0 is the historical default and stays the
    /// diagnostics' reference endpoint. The engine rotates across the pool
    /// and auto-fails-over. Override the primary with `EVM_RPC_<NAME_UPPER>`
    /// for production volume — the pool remains as fallbacks behind it.
    pub public_rpcs: &'static [&'static str],
    /// Block explorer prefix for building receipt links.
    pub explorer_tx: &'static str,
    /// Settleable ERC-20 tokens on this network.
    pub tokens: &'static [TokenSpec],
}

macro_rules! tokens {
    ($($sym:expr => ($addr:expr, $dec:expr)),* $(,)?) => {
        &[ $( TokenSpec { symbol: $sym, address: $addr, decimals: $dec } ),* ]
    };
}

macro_rules! rpcs {
    ($($u:expr),* $(,)?) => { &[ $( $u ),* ] };
}

/// The eight production EVM mainnets. Token addresses below were verified
/// on-chain (symbol + decimals) during the 2026-10 registry build; see the
/// module header for the two-source rule.
pub const NETWORKS: &[NetworkSpec] = &[
    NetworkSpec {
        name: "base",
        chain_id: 8453,
        native: "ETH",
        confirmations: 8,
        public_rpcs: rpcs![
            "https://mainnet.base.org",             // official (OP Stack)
            "https://base-rpc.publicnode.com",      // PublicNode
            "https://base.drpc.org",                // dRPC
            "https://base.meowrpc.com",             // MeowRPC
        ],
        explorer_tx: "https://basescan.org/tx/",
        tokens: tokens![
            "USDC"  => ("0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", 6),
            "USDT"  => ("0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2", 6),
            "DAI"   => ("0x50c5725949A6F0c72E6C4a641F24049A917DB0Cb", 18),
            "WETH"  => ("0x4200000000000000000000000000000000000006", 18),
            "cbBTC" => ("0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf", 8),
            "cbETH" => ("0x2Ae3F1ec7F1F5012CFEab0185bfc7aa3cf0DEc22", 18),
        ],
    },
    NetworkSpec {
        name: "ethereum",
        chain_id: 1,
        native: "ETH",
        confirmations: 6,
        public_rpcs: rpcs![
            "https://ethereum-rpc.publicnode.com",  // PublicNode
            "https://eth.drpc.org",                 // dRPC
            "https://cloudflare-eth.com",           // Cloudflare
            "https://eth.meowrpc.com",              // MeowRPC
            "https://rpc.flashbots.net",            // Flashbots Protect
        ],
        explorer_tx: "https://etherscan.io/tx/",
        tokens: tokens![
            "USDC"  => ("0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", 6),
            "USDT"  => ("0xdAC17F958D2ee523a2206206994597C13D831ec7", 6),
            "DAI"   => ("0x6B175474E89094C44Da98b954EedeAC495271d0F", 18),
            "WETH"  => ("0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2", 18),
            "WBTC"  => ("0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599", 8),
            "LINK"  => ("0x514910771AF9Ca656af840dff83E8264EcF986CA", 18),
            "UNI"   => ("0x1f9840a85d5aF5bf1D1762F925BDADdC4201F984", 18),
            "AAVE"  => ("0x7Fc66500c84A76Ad7e9c93437bFc5Ac33E2DDaE9", 18),
            "SHIB"  => ("0x95aD61b0a150d79219dCF64E1E6Cc01f0B64C4cE", 18),
            "LDO"   => ("0x5A98FcBEA516Cf06857215779Fd812CA3beF1B32", 18),
            "CRV"   => ("0xD533a949740bb3306d119CC777fa900bA034cd52", 18),
            "COMP"  => ("0xc00e94Cb662C3520282E6f5717214004A7f26888", 18),
            "GRT"   => ("0xc944E90C64B2c07662A292be6244BDf05Cda44a7", 18),
            "TUSD"  => ("0x0000000000085d4780B73119b644AE5ecd22b376", 18),
            "FRAX"  => ("0x853d955aCEf822Db058eb8505911ED77F175b99e", 18),
            "PYUSD" => ("0x6c3ea9036406852006290770BEdFcAbA0e23A0e8", 6),
            "APE"   => ("0x4d224452801ACEd8B2F0aebE155379bb5D594381", 18),
            "SAND"  => ("0x3845badAde8e6dFF049820680d1F14bD3903a5d0", 18),
            "MANA"  => ("0x0F5D2fB29fb7d3CFeE444a200298f468908cC942", 18),
            "ENS"   => ("0xC18360217D8F7Ab5e7c516566761ea12Ce7F9D72", 18),
            "USDS"  => ("0xdC035D45d973E3EC169d2276DDab16f1e407384F", 18),
            "POL"   => ("0x455e53CBB86018Ac2B8092FdCd39d8444aFFC3F6", 18),
        ],
    },
    NetworkSpec {
        name: "arbitrum",
        chain_id: 42161,
        native: "ETH",
        confirmations: 12,
        public_rpcs: rpcs![
            "https://arb1.arbitrum.io/rpc",               // official
            "https://arbitrum-one-rpc.publicnode.com",    // PublicNode
            "https://arbitrum.drpc.org",                  // dRPC
            "https://arbitrum.meowrpc.com",               // MeowRPC
        ],
        explorer_tx: "https://arbiscan.io/tx/",
        tokens: tokens![
            "USDC" => ("0xaf88d065E77c8cC2239327C5EDb3A432268e5831", 6),
            "USDT" => ("0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9", 6),
            "DAI"  => ("0xDA10009cBd5D07dd0CeCc66161FC93D7c9000da1", 18),
            "WETH" => ("0x82aF49447D8a07e3bd95BD0d56f35241523fBab1", 18),
            "ARB"  => ("0x912CE59144191C1204E64559FE8253a0e49E6548", 18),
            "LINK" => ("0xf97f4df75117a78c1A5a0dbb814Af92458539FB4", 18),
            "GMX"  => ("0xfc5A1A6EB076a2C7aD06eD22C90d7E710E35ad0a", 18),
        ],
    },
    NetworkSpec {
        name: "polygon",
        chain_id: 137,
        native: "POL",
        confirmations: 30,
        public_rpcs: rpcs![
            "https://polygon-bor-rpc.publicnode.com", // PublicNode
            "https://polygon.drpc.org",               // dRPC
        ],
        explorer_tx: "https://polygonscan.com/tx/",
        tokens: tokens![
            "USDC" => ("0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359", 6),
            "USDT" => ("0xc2132D05D31c914a87C6611C10748AEb04B58e8F", 6),
            "DAI"  => ("0x8f3Cf7ad23Cd3CaDbD9735AFf958023239c6A063", 18),
            "LINK" => ("0x53E0bca35eC356BD5ddDFebbD1Fc0fD03FaBad39", 18),
            "AAVE" => ("0xD6DF932A45C0f255f85145f286eA0b292B21C90B", 18),
        ],
    },
    NetworkSpec {
        name: "optimism",
        chain_id: 10,
        native: "ETH",
        confirmations: 8,
        public_rpcs: rpcs![
            "https://mainnet.optimism.io",          // official (OP Stack)
            "https://optimism-rpc.publicnode.com",  // PublicNode
            "https://optimism.drpc.org",            // dRPC
        ],
        explorer_tx: "https://optimistic.etherscan.io/tx/",
        tokens: tokens![
            "USDC"  => ("0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85", 6),
            "USDT"  => ("0x94b008aA00579c1307B0EF2c499aD98a8ce58e58", 6),
            "DAI"   => ("0xDA10009cBd5D07dd0CeCc66161FC93D7c9000da1", 18),
            "WETH"  => ("0x4200000000000000000000000000000000000006", 18),
            "WBTC"  => ("0x68f180fcCe6836688e9084f035309E29Bf0A2095", 8),
            "LINK"  => ("0x350a791Bfc2C21F9Ed5d10980Dad2e2638ffa7f6", 18),
            "UNI"   => ("0x6fd9d7aD17242C41f7131d257212c54a0e816691", 18),
            "AAVE"  => ("0x76FB31fb4af56892a25e32cFC43De717950c9278", 18),
            "LDO"   => ("0xFdb794692724153d1488CcdBE0C56c252596735F", 18),
            "CRV"   => ("0x0994206dFe8De6Ec6920FF4D779B0d950605Fb53", 18),
            "OP"    => ("0x4200000000000000000000000000000000000042", 18),
            "GMX"   => ("0xcEf8A7008310a15b1b1489d88b0E6fe51329B05A", 18),
            "TUSD"  => ("0xcB59a0A753FdB7491d5F3d794316F1adE197b21E", 18),
            "FRAX"  => ("0x2e3D870790dC77A83DD1d18184Acc7439A53f475", 18),
            "cbETH" => ("0xADDb6A0412De1ba0F936dCAeb8aA24578dCF3b2", 18),
        ],
    },
    NetworkSpec {
        name: "bsc",
        chain_id: 56,
        native: "BNB",
        confirmations: 15,
        public_rpcs: rpcs![
            "https://bsc-rpc.publicnode.com",        // PublicNode
            "https://bsc-dataseed.binance.org",      // Binance (official)
            "https://bsc-dataseed1.defibit.io",      // DeFiBit seed (official list)
        ],
        explorer_tx: "https://bscscan.com/tx/",
        tokens: tokens![
            "USDT"  => ("0x524bC91dc82d6B90eF29F76A3ECAAbaffFD490Bc", 6),
            "USDC"  => ("0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d", 18),
            "DAI"   => ("0x1AF3F329e8BE154074D8769D1FFa4eE058B1DBc3", 18),
            "ETH"   => ("0x2170Ed0880ac9A755fd29B2688956BD959F933F8", 18),
            "BTCB"  => ("0x7130d2A12B9BCBFAe4f2634d864A1Ee1Ce3Ead9c", 18),
            "WBTC"  => ("0x0555E30da8f98308EdB960aa94C0Db47230d2B9c", 8),
            "CAKE"  => ("0x0E09FaBB73Bd3Ade0a17ECC321fD13a19e81cE82", 18),
            "LINK"  => ("0xF8A0BF9cF54Bb92F17374d9e9A321E6a111a51bD", 18),
            "UNI"   => ("0xBf5140A22578168FD562DCcF235E5D43a02ce9B1", 18),
            "AAVE"  => ("0xfb6115445Bff7b52Feb98650C87f44907E58f802", 18),
            "COMP"  => ("0x52CE071Bd9b1C4B00A0b92D298C512478cAD67e8", 18),
            "SHIB"  => ("0x2859e4544c4bb03966803b044a93563bd2d0dd4d", 18),
            "PEPE"  => ("0x25d887Ce7a35172C62FeBFD67a1856F20FaEbB00", 18),
            "TUSD"  => ("0x14016E85a25Aeb13065688cAFB43044C2ef86784", 18),
            "FRAX"  => ("0x90C97F71E18723b0Cf0DfA30EE176Ab653E89F40", 18),
            "GMX"   => ("0xcEf8A7008310a15b1b1489d88b0E6fe51329B05A", 18),
            "APE"   => ("0x8f86A15eC17cb3369d8B3e666DADBC11daa82B79", 18),
        ],
    },
    NetworkSpec {
        name: "avalanche",
        chain_id: 43114,
        native: "AVAX",
        confirmations: 10,
        public_rpcs: rpcs![
            "https://avalanche-c-chain-rpc.publicnode.com", // PublicNode
            "https://api.avax.network/ext/bc/C/rpc",        // Ava Labs (official)
            "https://avalanche.drpc.org",                   // dRPC
        ],
        explorer_tx: "https://snowtrace.io/tx/",
        tokens: tokens![
            "USDT"  => ("0x9702230A8Ea53601f5cd2dc00fDBc13d4dF4A8c7", 6),
            "USDC"  => ("0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E", 6),
            "WAVAX" => ("0xB31f66AA3C1e785363F0875A1B74E27b85FD66c7", 18),
            "WBTC"  => ("0x0555E30da8f98308EdB960aa94C0Db47230d2B9c", 8),
            "GMX"   => ("0x62edc0692BD897D2295872a9FFCac5425011c661", 18),
            "PEPE"  => ("0xA659d083b677D6BfFe1cb704e1473b896727be6d", 18),
            "TUSD"  => ("0x1C20E891BaB6b1727d14Da358FAe2984Ed9B59eb", 18),
        ],
    },
    NetworkSpec {
        // World Chain — the World ID rollup (OP Stack, settlement on Ethereum).
        // 2s blocks; 8 confs ≈ 16s. Native USDC (Circle, 2025-06) + Tether's
        // official omnichain USDT0 + WLD, all probed on-chain at add time.
        name: "worldchain",
        chain_id: 480,
        native: "ETH",
        confirmations: 8,
        public_rpcs: rpcs![
            "https://worldchain-mainnet.g.alchemy.com/public",  // Alchemy public
            "https://worldchain-mainnet.gateway.tenderly.co",   // Tenderly gateway
            "https://worldchain.drpc.org",                      // dRPC
        ],
        explorer_tx: "https://worldscan.org/tx/",
        tokens: tokens![
            "USDC"  => ("0x79A02482A880bCE3F13e09Da970dC34db4CD24d1", 6),
            "USDT0" => ("0x102d758f688a4C1C5a80b116bD945d4455460282", 6),
            "WLD"   => ("0x2cFc85d8E48F8EAB294be644d9E25C3030863003", 18),
        ],
    },
];

/// Solana assets (SPL tokens). Native SOL carries no entry — the Solana
/// adapter treats an empty `token_address` as the native asset.
pub const SOLANA_TOKENS: &[TokenSpec] = &[
    TokenSpec { symbol: "USDC", address: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", decimals: 6 },
];

/// Tron assets (TRC-20). Native TRX carries no entry.
pub const TRON_TOKENS: &[TokenSpec] = &[
    TokenSpec { symbol: "USDT", address: "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t", decimals: 6 },
];

/// Non-EVM chain metadata (Bitcoin, Solana, Tron — watch-only adapters).
#[derive(Debug, Clone, Copy)]
pub struct OffchainSpec {
    /// Canonical network name (`network` field for these invoices).
    pub name: &'static str,
    /// Chain kind string used in API requests (`chain` field).
    pub chain: &'static str,
    /// Native asset symbol.
    pub native: &'static str,
    /// Confirmations approximated in the observation model (bitcoin uses
    /// chain-confirmed balances; solana/tron document their depth here).
    pub confirmations: u64,
    /// SPL / TRC-20 tokens settleable on this chain.
    pub tokens: &'static [TokenSpec],
}

pub const OFFCHAIN_CHAINS: &[OffchainSpec] = &[
    OffchainSpec {
        name: "mainnet",
        chain: "bitcoin",
        native: "BTC",
        confirmations: 2, // chain-confirmed balances are enforced by the data source
        tokens: &[],
    },
    OffchainSpec {
        name: "mainnet",
        chain: "solana",
        native: "SOL",
        confirmations: 32, // ~12.8 s of slots
        tokens: SOLANA_TOKENS,
    },
    OffchainSpec {
        name: "mainnet",
        chain: "tron",
        native: "TRX",
        confirmations: 20, // ~1 min, TronGrid `only_confirmed=true` enforces it
        tokens: TRON_TOKENS,
    },
];

/// Find an off-chain chain spec by chain kind.
pub fn find_offchain(chain: &str) -> Option<&'static OffchainSpec> {
    OFFCHAIN_CHAINS.iter().find(|c| c.chain.eq_ignore_ascii_case(chain))
}

/// Look up an EVM network spec by name (case-insensitive).
pub fn find(network: &str) -> Option<&'static NetworkSpec> {
    NETWORKS
        .iter()
        .find(|n| n.name.eq_ignore_ascii_case(network))
}

/// Resolve an asset symbol (e.g. `USDC`) to its token contract on an EVM
/// network. Native symbols (`ETH`, `POL`, `BNB`, `AVAX`) return `None` by
/// design — native invoices carry an empty `token_address`.
pub fn resolve_token(network: &str, asset: &str) -> Option<&'static TokenSpec> {
    let net = find(network)?;
    let a = asset.to_uppercase();
    if a == net.native {
        return None; // native asset — not an ERC-20
    }
    net.tokens.iter().find(|t| t.symbol.eq_ignore_ascii_case(&a))
}

/// Resolve a non-EVM chain asset (SPL mint / TRC-20 contract). Native assets
/// return `None` by design.
pub fn resolve_offchain_token(chain: &str, asset: &str) -> Option<&'static TokenSpec> {
    let c = find_offchain(chain)?;
    c.tokens
        .iter()
        .find(|t| t.symbol.eq_ignore_ascii_case(asset.to_uppercase().as_str()))
}

/// Look up a token spec by its contract address (case-insensitive).
pub fn token_by_address(network: &str, address: &str) -> Option<&'static TokenSpec> {
    let net = find(network)?;
    let a = address.to_lowercase();
    net.tokens.iter().find(|t| t.address.to_lowercase() == a)
}

// ------------------------------------------------------------ asset catalog --

/// The catalog: settleable assets first (chain != "none"), then quote-only
/// assets. `default_chain` + `default_network` name the settlement venue used
/// when an invoice request omits them; `decimals` is the quantity precision
/// on the default network (per-network resolution always wins elsewhere).
#[derive(Debug, Clone, Copy)]
pub struct AssetSpec {
    pub symbol: &'static str,
    pub name: &'static str,
    /// `evm` | `bitcoin` | `solana` | `tron` | `none` (quote-only).
    pub default_chain: &'static str,
    /// Network within that chain (`base`, `ethereum`, `mainnet`, …).
    pub default_network: &'static str,
    pub decimals: u8,
}
pub const ASSET_CATALOG: &[AssetSpec] = &[
    AssetSpec { symbol: "BTC",   name: "Bitcoin",                 default_chain: "bitcoin", default_network: "mainnet",   decimals: 8 },
    AssetSpec { symbol: "ETH",   name: "Ethereum",                default_chain: "evm",     default_network: "base",      decimals: 18 },
    AssetSpec { symbol: "SOL",   name: "Solana",                  default_chain: "solana",  default_network: "mainnet",   decimals: 9 },
    AssetSpec { symbol: "BNB",   name: "BNB",                     default_chain: "evm",     default_network: "bsc",       decimals: 18 },
    AssetSpec { symbol: "TRX",   name: "Tron",                    default_chain: "tron",    default_network: "mainnet",   decimals: 6 },
    AssetSpec { symbol: "AVAX",  name: "Avalanche",               default_chain: "evm",     default_network: "avalanche", decimals: 18 },
    AssetSpec { symbol: "POL",   name: "Polygon Ecosystem Token", default_chain: "evm",     default_network: "polygon",   decimals: 18 },
    AssetSpec { symbol: "USDC",  name: "USD Coin",                default_chain: "evm",     default_network: "base",      decimals: 6 },
    AssetSpec { symbol: "USDT",  name: "Tether USD",              default_chain: "evm",     default_network: "base",      decimals: 6 },
    AssetSpec { symbol: "DAI",   name: "Dai Stablecoin",          default_chain: "evm",     default_network: "base",      decimals: 18 },
    AssetSpec { symbol: "WETH",  name: "Wrapped Ether",           default_chain: "evm",     default_network: "base",      decimals: 18 },
    AssetSpec { symbol: "WBTC",  name: "Wrapped Bitcoin",         default_chain: "evm",     default_network: "ethereum",  decimals: 8 },
    AssetSpec { symbol: "cbBTC", name: "Coinbase Wrapped BTC",    default_chain: "evm",     default_network: "base",      decimals: 8 },
    AssetSpec { symbol: "cbETH", name: "Coinbase Wrapped ETH",    default_chain: "evm",     default_network: "base",      decimals: 18 },
    AssetSpec { symbol: "LINK",  name: "Chainlink",               default_chain: "evm",     default_network: "ethereum",  decimals: 18 },
    AssetSpec { symbol: "UNI",   name: "Uniswap",                 default_chain: "evm",     default_network: "ethereum",  decimals: 18 },
    AssetSpec { symbol: "AAVE",  name: "Aave",                    default_chain: "evm",     default_network: "ethereum",  decimals: 18 },
    AssetSpec { symbol: "ARB",   name: "Arbitrum",                default_chain: "evm",     default_network: "arbitrum",  decimals: 18 },
    AssetSpec { symbol: "OP",    name: "Optimism",                default_chain: "evm",     default_network: "optimism",  decimals: 18 },
    AssetSpec { symbol: "GMX",   name: "GMX",                     default_chain: "evm",     default_network: "arbitrum",  decimals: 18 },
    AssetSpec { symbol: "LDO",   name: "Lido DAO",                default_chain: "evm",     default_network: "ethereum",  decimals: 18 },
    AssetSpec { symbol: "CRV",   name: "Curve DAO",               default_chain: "evm",     default_network: "ethereum",  decimals: 18 },
    AssetSpec { symbol: "COMP",  name: "Compound",                default_chain: "evm",     default_network: "ethereum",  decimals: 18 },
    AssetSpec { symbol: "GRT",   name: "The Graph",               default_chain: "evm",     default_network: "ethereum",  decimals: 18 },
    AssetSpec { symbol: "ENS",   name: "Ethereum Name Service",   default_chain: "evm",     default_network: "ethereum",  decimals: 18 },
    AssetSpec { symbol: "MANA",  name: "Decentraland",            default_chain: "evm",     default_network: "ethereum",  decimals: 18 },
    AssetSpec { symbol: "SAND",  name: "The Sandbox",             default_chain: "evm",     default_network: "ethereum",  decimals: 18 },
    AssetSpec { symbol: "APE",   name: "ApeCoin",                 default_chain: "evm",     default_network: "ethereum",  decimals: 18 },
    AssetSpec { symbol: "FRAX",  name: "Frax",                    default_chain: "evm",     default_network: "ethereum",  decimals: 18 },
    AssetSpec { symbol: "TUSD",  name: "TrueUSD",                 default_chain: "evm",     default_network: "ethereum",  decimals: 18 },
    AssetSpec { symbol: "PYUSD", name: "PayPal USD",              default_chain: "evm",     default_network: "ethereum",  decimals: 6 },
    AssetSpec { symbol: "USDS",  name: "Sky Dollar",              default_chain: "evm",     default_network: "ethereum",  decimals: 18 },
    AssetSpec { symbol: "SHIB",  name: "Shiba Inu",               default_chain: "evm",     default_network: "ethereum",  decimals: 18 },
    AssetSpec { symbol: "PEPE",  name: "Pepe",                    default_chain: "evm",     default_network: "bsc",       decimals: 18 },
    AssetSpec { symbol: "CAKE",  name: "PancakeSwap",             default_chain: "evm",     default_network: "bsc",       decimals: 18 },
    AssetSpec { symbol: "BTCB",  name: "Binance-Peg Bitcoin",     default_chain: "evm",     default_network: "bsc",       decimals: 18 },
    AssetSpec { symbol: "WAVAX", name: "Wrapped AVAX",            default_chain: "evm",     default_network: "avalanche", decimals: 18 },
    AssetSpec { symbol: "WLD",   name: "Worldcoin",               default_chain: "evm",     default_network: "worldchain", decimals: 18 },
    AssetSpec { symbol: "USDT0", name: "Tether USDT0 (Omnichain)", default_chain: "evm",     default_network: "worldchain", decimals: 6 },
    // ---- quote-only (priced for /v1/quote; invoice settlement pending an adapter) ----
    AssetSpec { symbol: "XRP",  name: "XRP",                  default_chain: "none", default_network: "", decimals: 6 },
    AssetSpec { symbol: "DOGE", name: "Dogecoin",             default_chain: "none", default_network: "", decimals: 8 },
    AssetSpec { symbol: "ADA",  name: "Cardano",              default_chain: "none", default_network: "", decimals: 6 },
    AssetSpec { symbol: "DOT",  name: "Polkadot",             default_chain: "none", default_network: "", decimals: 10 },
    AssetSpec { symbol: "XLM",  name: "Stellar",              default_chain: "none", default_network: "", decimals: 7 },
    AssetSpec { symbol: "HBAR", name: "Hedera",               default_chain: "none", default_network: "", decimals: 8 },
    AssetSpec { symbol: "BCH",  name: "Bitcoin Cash",         default_chain: "none", default_network: "", decimals: 8 },
    AssetSpec { symbol: "LTC",  name: "Litecoin",             default_chain: "none", default_network: "", decimals: 8 },
    AssetSpec { symbol: "ATOM", name: "Cosmos",               default_chain: "none", default_network: "", decimals: 6 },
    AssetSpec { symbol: "FIL",  name: "Filecoin",             default_chain: "none", default_network: "", decimals: 18 },
    AssetSpec { symbol: "INJ",  name: "Injective",            default_chain: "none", default_network: "", decimals: 18 },
    AssetSpec { symbol: "STX",  name: "Stacks",               default_chain: "none", default_network: "", decimals: 6 },
    AssetSpec { symbol: "NEAR", name: "NEAR Protocol",        default_chain: "none", default_network: "", decimals: 24 },
    AssetSpec { symbol: "APT",  name: "Aptos",                default_chain: "none", default_network: "", decimals: 8 },
    AssetSpec { symbol: "SUI",  name: "Sui",                  default_chain: "none", default_network: "", decimals: 9 },
    AssetSpec { symbol: "TON",  name: "Toncoin",              default_chain: "none", default_network: "", decimals: 9 },
    AssetSpec { symbol: "ICP",  name: "Internet Computer",    default_chain: "none", default_network: "", decimals: 8 },
    AssetSpec { symbol: "XMR",  name: "Monero",               default_chain: "none", default_network: "", decimals: 12 },
    AssetSpec { symbol: "ETC",  name: "Ethereum Classic",     default_chain: "none", default_network: "", decimals: 18 },
    AssetSpec { symbol: "RENDER", name: "Render",             default_chain: "none", default_network: "", decimals: 9 },
];

/// Look up the asset catalog by symbol (case-insensitive).
pub fn find_asset(asset: &str) -> Option<&'static AssetSpec> {
    let a = asset.to_uppercase();
    ASSET_CATALOG.iter().find(|s| s.symbol.eq_ignore_ascii_case(&a))
}

/// Every network (across all chains) where `asset` is settleable. Used by
/// `GET /v1/assets` and by invoice creation's helpful error messages.
pub fn settleable_networks(asset: &str) -> Vec<(&'static str, &'static str)> {
    let mut out = Vec::new();
    let a = asset.to_uppercase();
    for net in NETWORKS {
        let is_native = net.native.eq_ignore_ascii_case(&a);
        let is_token = net.tokens.iter().any(|t| t.symbol.eq_ignore_ascii_case(&a));
        if is_native || is_token {
            out.push(("evm", net.name));
        }
    }
    for c in OFFCHAIN_CHAINS {
        if c.native.eq_ignore_ascii_case(&a)
            || c.tokens.iter().any(|t| t.symbol.eq_ignore_ascii_case(&a))
        {
            out.push((c.chain, c.name));
        }
    }
    out
}

/// Native-asset decimals for an EVM network (all eight use 18).
pub fn native_decimals(network: &str) -> u8 {
    let _ = find(network); // errors out via callers when the network is unknown
    18
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn all_eight_mainnets_registered() {
        assert_eq!(NETWORKS.len(), 8);
        assert_eq!(find("base").unwrap().chain_id, 8453);
        assert_eq!(find("ETHEREUM").unwrap().chain_id, 1);
        assert_eq!(find("arbitrum").unwrap().chain_id, 42161);
        assert_eq!(find("polygon").unwrap().chain_id, 137);
        assert_eq!(find("optimism").unwrap().chain_id, 10);
        assert_eq!(find("bsc").unwrap().chain_id, 56);
        assert_eq!(find("avalanche").unwrap().chain_id, 43114);
        assert_eq!(find("WORLDCHAIN").unwrap().chain_id, 480);
        assert_eq!(find("worldchain").unwrap().native, "ETH");
        assert!(find("sepolia").is_none(), "testnets are not shipped by default");
    }

    #[test]
    fn worldchain_tokens_resolve() {
        let wld = resolve_token("worldchain", "WLD").unwrap();
        assert_eq!(wld.decimals, 18);
        assert_eq!(wld.address.to_lowercase(), "0x2cfc85d8e48f8eab294be644d9e25c3030863003");
        let usdc = resolve_token("worldchain", "USDC").unwrap();
        assert_eq!(usdc.decimals, 6, "native Circle USDC on worldchain is 6dp");
        let usdt0 = resolve_token("worldchain", "usdt0").unwrap();
        assert_eq!(usdt0.decimals, 6);
        // Native ETH resolves to no ERC-20, like every other network.
        assert!(resolve_token("worldchain", "ETH").is_none());
        // WLD settles ONLY on worldchain (its home network).
        assert_eq!(settleable_networks("WLD"), vec![("evm", "worldchain")]);
        // USDT (plain) must NOT resolve on worldchain — there it is USDT0.
        assert!(resolve_token("worldchain", "USDT").is_none());
    }

    #[test]
    fn token_resolution_by_symbol_and_address() {
        let t = resolve_token("base", "USDC").unwrap();
        assert_eq!(t.address.to_lowercase(), "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913");
        assert_eq!(t.decimals, 6);
        assert!(resolve_token("base", "usdt").is_some());
        // Native is explicitly not a token.
        assert!(resolve_token("base", "ETH").is_none());
        assert!(resolve_token("polygon", "POL").is_none());
        // Round-trip by address.
        let by_addr = token_by_address("polygon", "0x3c499c542cef5e3811e1192ce70d8cc03d5c3359").unwrap();
        assert_eq!(by_addr.symbol, "USDC");
        // BSC USDT is 6dp at the verified Tether contract…
        assert_eq!(resolve_token("bsc", "USDT").unwrap().decimals, 6);
        // …while BSC USDC is 18dp — decimals are per-network, not per-symbol.
        assert_eq!(resolve_token("bsc", "USDC").unwrap().decimals, 18);
        // Asset that exists on one network but not another.
        assert!(resolve_token("arbitrum", "cbBTC").is_none());
    }

    #[test]
    fn offchain_token_resolution() {
        let mint = resolve_offchain_token("solana", "USDC").unwrap();
        assert_eq!(mint.address, "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
        assert_eq!(mint.decimals, 6);
        assert!(resolve_offchain_token("solana", "SOL").is_none()); // native
        let usdt = resolve_offchain_token("tron", "usdt").unwrap();
        assert_eq!(usdt.address, "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t");
        assert!(resolve_offchain_token("bitcoin", "BTC").is_none()); // native
        assert_eq!(find_offchain("bitcoin").unwrap().native, "BTC");
    }

    #[test]
    fn usdc_decimals_are_per_network() {
        // USDC is 6dp on every registered network EXCEPT BSC, where the
        // verified canonical contract (0x8AC7…580d) is 18dp — decimals are a
        // per-network property, which is exactly why expected_qty takes
        // chain-resolved decimals.
        for net in NETWORKS {
            let usdc = net.tokens.iter().find(|t| t.symbol == "USDC")
                .expect("USDC must exist on every registered network");
            assert!(usdc.address.starts_with("0x") && usdc.address.len() == 42);
            if net.name == "bsc" {
                assert_eq!(usdc.decimals, 18, "BSC USDC is the 18dp contract");
            } else {
                assert_eq!(usdc.decimals, 6, "USDC decimals wrong on {}", net.name);
            }
        }
    }

    #[test]
    fn asset_catalog_routes_defaults() {
        let btc = find_asset("btc").unwrap();
        assert_eq!((btc.default_chain, btc.default_network), ("bitcoin", "mainnet"));
        let usdc = find_asset("USDC").unwrap();
        assert_eq!((usdc.default_chain, usdc.default_network), ("evm", "base"));
        let sol = find_asset("sol").unwrap();
        assert_eq!((sol.default_chain, sol.default_network), ("solana", "mainnet"));
        let trx = find_asset("trx").unwrap();
        assert_eq!((trx.default_chain, trx.default_network), ("tron", "mainnet"));
        // Quote-only assets route nowhere.
        assert_eq!(find_asset("xrp").unwrap().default_chain, "none");
        assert!(find_asset("NOSUCHASSET").is_none());
    }

    #[test]
    fn settleable_networks_cover_all_chains() {
        let usdt = settleable_networks("USDT");
        // USDT: 7 EVM networks + tron TRC-20 (not solana — that's USDC only).
        assert_eq!(usdt.len(), 8, "USDT settleable on 7 evm + tron: {usdt:?}");
        assert!(usdt.contains(&("tron", "mainnet")));
        let btc = settleable_networks("BTC");
        assert_eq!(btc, vec![("bitcoin", "mainnet")]);
        let eth = settleable_networks("ETH");
        assert_eq!(eth.len(), 6, "ETH native on six EVM networks: {eth:?}");
        // Quote-only asset settles nowhere.
        assert!(settleable_networks("XRP").is_empty());
    }

    #[test]
    fn unique_names_chain_ids_and_assets() {
        let mut names: Vec<_> = NETWORKS.iter().map(|n| n.name).collect();
        names.sort_unstable();
        names.dedup();
        assert_eq!(names.len(), NETWORKS.len());
        let mut ids: Vec<_> = NETWORKS.iter().map(|n| n.chain_id).collect();
        ids.sort_unstable();
        ids.dedup();
        assert_eq!(ids.len(), NETWORKS.len());
        let mut syms: Vec<_> = ASSET_CATALOG.iter().map(|a| a.symbol).collect();
        syms.sort_unstable();
        let before = syms.len();
        syms.dedup();
        assert_eq!(syms.len(), before, "duplicate asset symbol in catalog");
    }

    #[test]
    fn catalog_decimals_match_default_network_resolution() {
        for a in ASSET_CATALOG {
            if a.default_chain != "evm" || a.default_network.is_empty() {
                continue;
            }
            let net = find(a.default_network).unwrap_or_else(|| panic!("{}", a.default_network));
            let dp = if net.native == a.symbol {
                18
            } else {
                net.tokens.iter().find(|t| t.symbol == a.symbol)
                    .unwrap_or_else(|| panic!("{} missing on {}", a.symbol, net.name))
                    .decimals
            };
            assert_eq!(dp, a.decimals, "{} decimals drift vs default network", a.symbol);
        }
    }
}
