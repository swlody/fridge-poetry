mod api;
mod config;
mod error;
mod geometry;
mod middleware;
mod state;
mod websocket;

use std::net::SocketAddr;

use anyhow::Result;
use axum::{http::Method, Router};
use error::FridgeError;
use mimalloc::MiMalloc;
use secrecy::ExposeSecret as _;
use sentry::integrations::tower::{NewSentryLayer, SentryHttpLayer};
use sqlx::postgres::PgListener;
use tokio::{net::TcpListener, select, sync::broadcast};
use tokio_util::sync::CancellationToken;
use tower::ServiceBuilder;
use tower_http::{
    cors::{Any, CorsLayer},
    limit::RequestBodyLimitLayer,
    timeout::TimeoutLayer,
    trace::{DefaultMakeSpan, DefaultOnResponse, TraceLayer},
    ServiceBuilderExt as _,
};
use tracing_subscriber::{layer::SubscriberExt as _, util::SubscriberInitExt as _};

use crate::{
    config::Config,
    middleware::{MakeRequestUuidV7, SentryReportRequestInfoLayer},
    state::{AppState, MagnetUpdate},
};

#[global_allocator]
static GLOBAL: MiMalloc = MiMalloc;

fn main() -> Result<()> {
    rubenvy::rubenvy_auto()?;

    let config = Config::from_environment();

    tracing_subscriber::fmt()
        .with_target(true)
        .with_max_level(config.log_level)
        .pretty()
        .finish()
        .with(sentry::integrations::tracing::layer())
        .try_init()?;

    let _sentry_guard = if let Some(dsn) = config.sentry_dsn.as_ref() {
        tracing::info!("Initializing Sentry client");
        Some(sentry::init((
            dsn.expose_secret(),
            sentry::ClientOptions {
                release: sentry::release_name!(),
                sample_rate: config.error_sample_rate,
                traces_sample_rate: config.trace_sample_rate,
                attach_stacktrace: true,
                ..Default::default()
            },
        )))
    } else {
        tracing::warn!("Skipping Sentry initialization due to missing SENTRY_DSN");
        None
    };

    tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()?
        .block_on(run(config))
}

async fn broadcast_changes(
    tx: tokio::sync::broadcast::Sender<MagnetUpdate>,
    token: CancellationToken,
    mut pg_change_listener: PgListener,
) {
    loop {
        select! {
            _ = token.cancelled() => {
                tracing::info!("Exiting change broadcast task due to token cancellation");
                break;
            },
            res = pg_change_listener.recv() => {
                match res {
                    Ok(msg) => {
                        let magnet_update = serde_json::from_str(&msg.payload()).expect("Received invalid JSON from postgres");
                        if tx.len() >= 10 {
                            tracing::error!(
                                "Potentially dropping queued magnet updates.\
                                Consider increasing the capacity of the broadcast channel."
                            );
                        }

                        if tx.send(magnet_update).is_err() {
                            tracing::warn!("Tried broadcasting magnet update but no receivers present.");
                        }
                    }
                    Err(e) => {
                        tracing::error!("Error from listener: {}", e);
                    }
                }
            }
        }
    }
}

async fn run(config: Config) -> Result<()> {
    let pool = sqlx::postgres::PgPoolOptions::new()
        .max_connections(5)
        .connect(config.postgres_url.expose_secret())
        .await?;

    let token: CancellationToken = CancellationToken::new();
    let mut pg_change_listener = PgListener::connect_with(&pool).await?;
    pg_change_listener.listen("magnet_updates").await?;

    let tx = broadcast::Sender::new(config.broadcast_capacity);

    let broadcast_changes_task = tokio::task::spawn(broadcast_changes(
        tx.clone(),
        token.clone(),
        pg_change_listener,
    ));

    // TODO rate limiting
    let service_builder = ServiceBuilder::new()
        .set_x_request_id(MakeRequestUuidV7)
        .layer(NewSentryLayer::new_from_top())
        .layer(SentryHttpLayer::with_transaction())
        .layer(SentryReportRequestInfoLayer)
        .layer(
            TraceLayer::new_for_http()
                .make_span_with(DefaultMakeSpan::new().include_headers(true))
                .on_response(DefaultOnResponse::new().include_headers(true)),
        )
        .propagate_x_request_id()
        .layer(RequestBodyLimitLayer::new(1024))
        .layer(TimeoutLayer::new(config.request_timeout))
        .layer(
            CorsLayer::new()
                .allow_methods([Method::GET, Method::PUT, Method::OPTIONS])
                .allow_origin(config.cors_origin)
                .allow_headers(Any),
        );

    let app_state = AppState {
        postgres: pool,
        magnet_updates: tx,
    };

    let app = Router::new()
        .merge(api::routes())
        .nest("/ws", websocket::routes())
        .fallback(|| async { FridgeError::NotFound })
        .layer(service_builder)
        .with_state(app_state);

    let listener = TcpListener::bind("0.0.0.0:8080").await?;
    tracing::info!("Listening on {}", listener.local_addr()?);
    axum::serve(
        listener,
        app.into_make_service_with_connect_info::<SocketAddr>(),
    )
    .await?;

    token.cancel();
    broadcast_changes_task.await?;

    Ok(())
}
