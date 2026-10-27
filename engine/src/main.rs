//! PayPhone Engine — entry point.
//!
//! Copyright (C) 2026 PayPhone Project operators & contributors.
//! Dual-licensed: AGPL-3.0-or-later (LICENSE) or commercial license
//! (COMMERCIAL-LICENSE.md). SPDX-License-Identifier: AGPL-3.0-or-later
//!
//! Boot sequence:
//! 1. Load config from environment (dev-safe defaults + loud warnings).
//! 2. Open SimNet (replay + verify its hash chain) if enabled.
//! 3. Build the chain coordinator and rate limiter.
//! 4. Serve the v1 API with CORS, tracing and graceful shutdown.

mod chains;
mod config;
mod error;
mod fees;
mod invoice;
mod keys;
mod oracle;
mod phone;
mod ratelimit;
mod routes;
mod webhooks;

use std::sync::Arc;
use std::time::{Duration, Instant};

use axum::http::{HeaderValue, Method};
use tower_http::cors::CorsLayer;
use tower_http::trace::TraceLayer;

use crate::chains::{simnet::SimNet, Coordinator};
use crate::chains::evm::EvmAdapter;
use crate::config::Config;
use crate::oracle::Oracle;
use crate::ratelimit::RateLimiter;

#[tokio::main]
async fn main() {
    // ---- observability ---------------------------------------------------
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "payphone_engine=info,tower_http=info".into()),
        )
        .with_target(false)
        .init();

    // ---- config ----------------------------------------------------------
    let config = Config::from_env();

    // ---- SimNet (simulated chain) -----------------------------------------
    let simnet: Option<Arc<SimNet>> = if config.simnet_enabled {
        match SimNet::open(&config.simnet_data_dir) {
            Ok(s) => Some(Arc::new(s)),
            Err(e) => {
                tracing::error!(error = %e, "SimNet journal failed to open — check PAYPHONE_SIMNET_DIR");
                None
            }
        }
    } else {
        None
    };

    // ---- EVM adapter -------------------------------------------------------
    let evm = EvmAdapter::new(config.evm_rpcs.clone());

    // ---- non-EVM watch-only adapters ----------------------------------------
    let bitcoin = crate::chains::bitcoin::BitcoinAdapter::new(config.btc_api_base.clone());
    let solana = crate::chains::solana::SolanaAdapter::new(config.sol_rpc_url.clone());
    let tron = crate::chains::tron::TronAdapter::new(config.tron_api_base.clone());

    let coordinator = Coordinator {
        simnet: simnet.clone(),
        evm: evm.clone(),
        bitcoin: bitcoin.clone(),
        solana: solana.clone(),
        tron: tron.clone(),
    };

    let state = Arc::new(routes::AppState {
        config: config.clone(),
        oracle: Oracle::new(config.oracle_url.clone()),
        simnet,
        evm,
        bitcoin,
        solana,
        tron,
        coordinator,
        limiter: RateLimiter::new(config.rate_limit_per_min),
        started: Instant::now(),
        chain_probe: std::sync::Mutex::new(std::collections::HashMap::new()),
    });

    // ---- CORS --------------------------------------------------------------
    let mut cors = CorsLayer::new()
        .allow_methods([Method::GET, Method::POST, Method::OPTIONS])
        .allow_headers([
            axum::http::header::CONTENT_TYPE,
            axum::http::header::HeaderName::from_static("x-payphone-key"),
            axum::http::header::HeaderName::from_static("x-payphone-timestamp"),
            axum::http::header::HeaderName::from_static("x-payphone-signature"),
            axum::http::header::HeaderName::from_static("x-admin-token"),
        ])
        .max_age(Duration::from_secs(3600));
    if config.cors_origins.iter().any(|o| o == "*") {
        cors = cors.allow_origin(tower_http::cors::Any);
    } else {
        let origins: Vec<HeaderValue> = config
            .cors_origins
            .iter()
            .filter_map(|o| o.parse().ok())
            .collect();
        cors = cors.allow_origin(origins);
    }

    // ---- banner ------------------------------------------------------------
    println!("\n  ╔═══════════════════════════════════════════════════════════╗");
    println!("  ║   PayPhone Engine v{} — your phone number is your wallet", env!("CARGO_PKG_VERSION"));
    println!("  ╠═══════════════════════════════════════════════════════════╣");
    println!("  ║   listening      : http://0.0.0.0:{}", config.port);
    println!("  ║   simnet         : {}", if config.simnet_enabled { "enabled (demo chain)" } else { "disabled" });
    println!("  ║   evm networks   : {} (real mainnet watching)", crate::chains::registry::NETWORKS.iter().map(|n| n.name).collect::<Vec<_>>().join(", "));
    println!("  ║   other chains   : bitcoin, solana, tron (watch-only, real mainnets)");
    println!("  ║   oracle         : {}", config.oracle_url.clone().unwrap_or_else(|| "direct CoinGecko".into()));
    println!("  ╚═══════════════════════════════════════════════════════════╝");
    if config.demo_mode {
        println!("\n  ⚠  DEMO MODE — PAYPHONE_MASTER_KEY is unset, using development keys.");
        println!("     Set PAYPHONE_MASTER_KEY + PAYPHONE_SIGNING_KEY before going live.\n");
    }
    if config.production {
        println!("  ✓ PRODUCTION MODE — fail-closed startup checks passed.");
        if config.cors_origins.iter().any(|o| o == "*") {
            println!("  ⚠  CORS is wide open (PAYPHONE_CORS_ORIGINS=*) — lock it to your console origin.");
        }
        println!("  ✓ EVM watching: {} networks via public defaults (override EVM_RPC_* for volume).",
            crate::chains::registry::NETWORKS.len());
        println!();
    }

    // ---- serve -------------------------------------------------------------
    let app = routes::router(state)
        .layer(cors)
        .layer(TraceLayer::new_for_http());

    let addr = format!("0.0.0.0:{}", config.port);
    let listener = tokio::net::TcpListener::bind(&addr)
        .await
        .unwrap_or_else(|e| panic!("cannot bind {addr}: {e}"));

    axum::serve(listener, app)
        .with_graceful_shutdown(shutdown_signal())
        .await
        .expect("server error");
}

async fn shutdown_signal() {
    let ctrl_c = async {
        tokio::signal::ctrl_c().await.expect("install ctrl-c handler");
    };
    #[cfg(unix)]
    let terminate = async {
        tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
            .expect("install SIGTERM handler")
            .recv()
            .await;
    };
    #[cfg(not(unix))]
    let terminate = std::future::pending::<()>();

    tokio::select! {
        _ = ctrl_c => {},
        _ = terminate => {},
    }
    tracing::info!("shutdown signal received — draining connections");
}
