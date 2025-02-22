mod geometry;
mod state;
mod websocket;

use std::str::FromStr as _;

use anyhow::Result;
use futures_util::StreamExt as _;
use mimalloc::MiMalloc;
use secrecy::{ExposeSecret as _, SecretString};
use serde::Deserialize;
use sqlx::postgres::PgListener;
use thiserror::Error;
use tokio::{
    net::{TcpListener, TcpStream},
    select, signal,
    sync::broadcast,
};
use tokio_tungstenite::tungstenite;
use tokio_util::{sync::CancellationToken, task::TaskTracker};
use tracing::Level;
use tracing_subscriber::{layer::SubscriberExt as _, util::SubscriberInitExt as _};
use uuid::Uuid;

use crate::state::{AppState, PgMagnetUpdate};

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

#[derive(Debug, Error)]
enum FridgeError {
    #[error("Server shutting down")]
    Shutdown,

    #[error("Request exceeds rate limits")]
    RateLimited,

    #[error("WebSocket connection closed by client: {0:?}")]
    ClientClose(Option<tungstenite::protocol::frame::CloseFrame>),

    #[error("Closing connection due to idle timeout")]
    IdleTimeout,

    #[error("Invalid message received over WebSocket: {0}")]
    InvalidMessage(String),

    #[error("Out of bounds update: {0}")]
    OutOfBounds(String),

    #[error(transparent)]
    Tungstenite(#[from] tungstenite::Error),

    #[error(transparent)]
    Sqlx(#[from] sqlx::Error),

    #[error("Internal server error: {0}")]
    Other(#[from] anyhow::Error),
}

fn main() -> Result<()> {
    rubenvy::rubenvy_auto()?;

    let config: Config = envy::from_env()?;

    tracing_subscriber::fmt()
        .with_target(true)
        .with_max_level(config.log_level.as_ref().map_or(Level::DEBUG, |s| {
            Level::from_str(s).unwrap_or_else(|_| panic!("Invalid value for FRIDGE_LOG_LEVEL: {s}"))
        }))
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
    broadcast_capacity: usize,
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
                        if tx.len() >= broadcast_capacity {
                            tracing::error!(
                                "Potentially dropping queued magnet updates. \
                                Consider increasing the capacity of the broadcast channel. \
                                Current capacity: {broadcast_capacity}"
                            );
                        }

                        if tx.send(magnet_update).is_err() {
                            tracing::warn!("Tried broadcasting magnet update but no receivers present.");
                        }
                    }
                    Err(e) => {
                        tracing::error!("Error from listener: {e}");
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

    let broadcast_capacity = config.broadcast_capacity.unwrap_or(100);
    let tx = broadcast::Sender::new(broadcast_capacity);

    let broadcast_changes_task = tokio::task::spawn(broadcast_changes(
        tx.clone(),
        token.clone(),
        pg_change_listener,
        broadcast_capacity,
    ));

    let app_state = AppState {
        postgres: pool,
        magnet_updates: tx,
        token: token.clone(),
    };

    let listener = TcpListener::bind("0.0.0.0:8080").await?;
    tracing::info!("Listening on {}", listener.local_addr()?);
    let tracker = TaskTracker::new();
    loop {
        select! {
            accept_result = listener.accept() => {
                match accept_result {
                    Ok((stream, _addr)) => {
                        tracker.spawn(accept_connection(stream, app_state.clone()));
                    }
                    Err(e) => {
                        tracing::warn!("Error accepting connection: {e}");
                    }
                }
            }
            () = shutdown_signal() => {
                tracing::info!("Received shutdown signal");
                break;
            }
        }
    }

    token.cancel();
    tracing::info!("Waiting for broadcast changes task");
    tracker.close();
    tracing::info!("Waiting for websocket connections to close");
    tracker.wait().await;
    broadcast_changes_task.await?;

    Ok(())
}

// TODO tokio-websockets scales better with many connections
// https://github.com/Gelbpunkt/tokio-websockets
async fn accept_connection(stream: TcpStream, state: AppState) {
    let peer_addr = stream
        .peer_addr()
        .map(|a| a.to_string())
        .unwrap_or_default();
    match tokio_tungstenite::accept_async(stream).await {
        Ok(ws_stream) => {
            let session_id = Uuid::now_v7();
            tracing::debug!(
                "Creating new session with session_id: {session_id} for peer: {peer_addr}",
            );
            let (writer, reader) = ws_stream.split();
            websocket::handle_socket(reader, writer, session_id, state).await;
        }
        Err(e) => {
            tracing::warn!("Unable to open websocket connection: {e}");
        }
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

    select! {
        () = ctrl_c => {},
        () = terminate => {},
    }
}
