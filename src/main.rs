mod error;
mod geometry;
mod state;
mod websocket;

use std::str::FromStr as _;

use anyhow::Result;
use error::FridgeError;
use mimalloc::MiMalloc;
use secrecy::{ExposeSecret as _, SecretString};
use serde::Deserialize;
use sqlx::postgres::PgListener;
use tokio::{
    net::{TcpListener, TcpStream},
    select, signal,
    sync::broadcast,
};
use tokio_util::{sync::CancellationToken, task::TaskTracker};
use tracing::{Level, level_filters::LevelFilter};
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

fn main() -> Result<()> {
    rubenvy::rubenvy_auto()?;

    let config: Config = envy::from_env()?;

    let filter = tracing_subscriber::filter::Targets::default()
        .with_target("reqwest", LevelFilter::OFF)
        .with_target("hyper_util", LevelFilter::OFF)
        .with_default(Level::DEBUG);

    tracing_subscriber::fmt()
        .with_target(true)
        .with_file(true)
        .with_line_number(true)
        .with_max_level(config.log_level.as_ref().map_or(Level::DEBUG, |s| {
            Level::from_str(s).unwrap_or_else(|_| panic!("Invalid value for FRIDGE_LOG_LEVEL: {s}"))
        }))
        .finish()
        .with(sentry::integrations::tracing::layer())
        .with(filter)
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
) -> Result<(), FridgeError> {
    loop {
        match pg_change_listener.try_recv().await {
            Ok(Some(msg)) => {
                let magnet_update = serde_json::from_str(msg.payload())
                    .expect("Received invalid JSON from postgres");
                if tx.len() >= broadcast_capacity {
                    tracing::error!(
                        "Potentially dropping queued magnet updates. Consider increasing the \
                         capacity of the broadcast channel. Current capacity: {broadcast_capacity}"
                    );
                }

                tracing::trace!("Propagating magnet update to websocket tasks: {magnet_update:#?}");
                if tx.send(magnet_update).is_err() {
                    tracing::warn!("Tried broadcasting magnet update but no receivers present.");
                }
            }
            Ok(None) => {
                tracing::warn!("Temporarily lost connection to Postgres");
            }
            Err(sqlx::Error::PoolClosed) => {
                return Ok(());
            }
            Err(e) => {
                // TODO handle sqlx::Error::Io(std::io::Error::ErrorKind::ConnectionReset)?
                token.cancel();
                tracing::error!("{e}");
                return Err(FridgeError::Sqlx(e));
            }
        }
    }
}

async fn run(config: Config) -> Result<()> {
    // TODO pool size ideally ~ core_count * 2 (of postgres server?)
    // https://github.com/brettwooldridge/HikariCP/wiki/About-Pool-Sizing
    // TODO lower acquire timeout?
    let pool = sqlx::postgres::PgPoolOptions::new()
        .max_connections(5)
        .connect(config.database_url.expose_secret())
        .await?;

    sqlx::migrate!().run(&pool).await?;

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
            () = token.cancelled() => {
                tracing::info!("Token cancelled");
                break;
            }
            () = shutdown_signal() => {
                tracing::info!("Received shutdown signal");
                token.cancel();
                break;
            }
        }
    }

    tracker.close();
    tracing::info!("Waiting for websocket connections to close");
    tracker.wait().await;

    tracing::info!("Closing Postgres connection pool");
    app_state.postgres.close().await;

    tracing::info!("Waiting for broadcast changes task");
    broadcast_changes_task.await??;

    Ok(())
}

async fn accept_connection(stream: TcpStream, state: AppState) {
    let stream_peer_ip = stream
        .peer_addr()
        .map(|a| a.to_string())
        .unwrap_or_default();

    match tokio_websockets::ServerBuilder::new().accept(stream).await {
        Ok((request, ws_stream)) => {
            let peer_addr = request
                .headers()
                .get("CF-Connecting-IP")
                .and_then(|hv| hv.to_str().ok())
                .and_then(|s| s.parse().ok())
                .unwrap_or(stream_peer_ip);

            let session_id = Uuid::now_v7();
            tracing::debug!(
                "Creating new session with session_id: {session_id} for peer: {peer_addr}",
            );
            websocket::handle_socket(ws_stream, session_id, state).await;
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
