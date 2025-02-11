mod middleware;
mod state;
mod websocket;

use std::{net::SocketAddr, str::FromStr as _};

use anyhow::Result;
use axum::{
    extract::{State, WebSocketUpgrade},
    http::{HeaderMap, HeaderValue, Method, StatusCode},
    response::IntoResponse,
    routing::get,
    Router,
};
use mimalloc::MiMalloc;
use secrecy::{ExposeSecret as _, SecretString};
use sentry::integrations::tower::{NewSentryLayer, SentryHttpLayer};
use serde::Deserialize;
use sqlx::postgres::PgListener;
use thiserror::Error;
use tokio::{net::TcpListener, select, signal, sync::broadcast};
use tokio_util::sync::CancellationToken;
use tower::ServiceBuilder;
use tower_http::{
    cors::{AllowOrigin, Any, CorsLayer},
    limit::RequestBodyLimitLayer,
    trace::{DefaultMakeSpan, DefaultOnResponse, TraceLayer},
    ServiceBuilderExt as _,
};
use tracing::Level;
use tracing_subscriber::{layer::SubscriberExt as _, util::SubscriberInitExt as _};
use uuid::Uuid;

use crate::{
    middleware::{MakeRequestUuidV7, SentryReportRequestInfoLayer},
    state::{AppState, PgMagnetUpdate},
};

#[global_allocator]
static GLOBAL: MiMalloc = MiMalloc;

#[derive(Deserialize, Debug)]
pub struct Config {
    #[serde(rename = "fridge_log_level")]
    pub log_level: Option<String>,
    #[serde(rename = "fridge_trace_sample_rate")]
    pub trace_sample_rate: Option<f32>,
    #[serde(rename = "fridge_error_sample_rate")]
    pub error_sample_rate: Option<f32>,
    #[serde(rename = "fridge_broadcast_capacity")]
    pub broadcast_capacity: Option<usize>,
    #[serde(rename = "fridge_cors_origin")]
    pub cors_origin: Option<String>,

    pub sentry_dsn: Option<SecretString>,
    pub database_url: SecretString,
}

#[derive(Error, Debug)]
pub enum FridgeError {
    #[error(transparent)]
    Sqlx(#[from] sqlx::Error),

    #[error(transparent)]
    Axum(#[from] axum::Error),
}

fn main() -> Result<()> {
    rubenvy::rubenvy_auto()?;

    let config: Config = envy::from_env()?;

    tracing_subscriber::fmt()
        .with_target(true)
        .with_max_level(config.log_level.as_ref().map_or(Level::DEBUG, |s| {
            Level::from_str(s).unwrap_or_else(|_| panic!("Invalid value for FRIDGE_LOG_LEVEL: {s}"))
        }))
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
                sample_rate: config.error_sample_rate.unwrap_or(1.0),
                traces_sample_rate: config.trace_sample_rate.unwrap_or(0.1),
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
    tx: tokio::sync::broadcast::Sender<PgMagnetUpdate>,
    token: CancellationToken,
    mut pg_change_listener: PgListener,
) {
    loop {
        select! {
            () = token.cancelled() => {
                break;
            },
            res = pg_change_listener.recv() => {
                match res {
                    Ok(msg) => {
                        let magnet_update = serde_json::from_str(msg.payload()).expect("Received invalid JSON from postgres");
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
        .connect(config.database_url.expose_secret())
        .await?;

    sqlx::migrate!()
        .run(&pool)
        .await
        .expect("Failed to run migrations");

    let token: CancellationToken = CancellationToken::new();
    let mut pg_change_listener = PgListener::connect_with(&pool).await?;
    pg_change_listener.listen("magnet_updates").await?;

    let tx = broadcast::Sender::new(config.broadcast_capacity.unwrap_or(10));

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
        .layer(
            CorsLayer::new()
                .allow_methods([Method::GET, Method::PUT, Method::OPTIONS])
                .allow_origin(
                    config
                        .cors_origin
                        .and_then(|s| HeaderValue::from_str(s.as_str()).ok())
                        .map_or_else(AllowOrigin::any, AllowOrigin::from),
                )
                .allow_headers(Any),
        );

    let app_state = AppState {
        postgres: pool,
        magnet_updates: tx,
        token: token.clone(),
    };

    let app = Router::new()
        .route("/health", get(health_check))
        .route("/ws", get(ws_handler))
        .layer(service_builder)
        .with_state(app_state);

    let listener = TcpListener::bind("0.0.0.0:8080").await?;
    tracing::info!("Listening on {}", listener.local_addr()?);
    axum::serve(
        listener,
        app.into_make_service_with_connect_info::<SocketAddr>(),
    )
    .with_graceful_shutdown(shutdown_signal())
    .await?;

    token.cancel();
    broadcast_changes_task.await?;

    Ok(())
}

#[tracing::instrument]
async fn ws_handler(
    headers: HeaderMap,
    ws: WebSocketUpgrade,
    State(state): State<AppState>,
) -> Result<impl IntoResponse, StatusCode> {
    let session_id = headers["x-request-id"]
        .to_str()
        .ok()
        .and_then(|s| Uuid::parse_str(s).ok())
        .ok_or(StatusCode::BAD_REQUEST)?;
    Ok(ws.on_upgrade(move |socket| websocket::handle_socket(socket, session_id, state)))
}

#[tracing::instrument]
async fn health_check(State(state): State<AppState>) -> impl IntoResponse {
    if state.postgres.is_closed() {
        StatusCode::INTERNAL_SERVER_ERROR
    } else {
        StatusCode::OK
    }
}

async fn shutdown_signal() {
    let ctrl_c = async {
        signal::ctrl_c()
            .await
            .expect("failed to install Ctrl+C handler");
    };

    #[cfg(unix)]
    let terminate = async {
        signal::unix::signal(signal::unix::SignalKind::terminate())
            .expect("failed to install signal handler")
            .recv()
            .await;
    };

    #[cfg(not(unix))]
    let terminate = std::future::pending::<()>();

    tokio::select! {
        () = ctrl_c => {},
        () = terminate => {},
    }
}
