use std::time::{Duration, Instant};

use futures_util::{
    SinkExt as _, StreamExt,
    stream::{SplitSink, SplitStream},
};
use serde::{Deserialize, Serialize};
use sqlx::PgPool;
use tokio::{net::TcpStream, select, time::timeout};
use tokio_tungstenite::{
    WebSocketStream,
    tungstenite::{self, Message},
};
use tracing::{Instrument, Level};
use uuid::Uuid;

use crate::{
    error::FridgeError,
    geometry::{Shape, Window},
    state::{AppState, PgMagnetUpdate},
};

type WsStream = SplitStream<WebSocketStream<TcpStream>>;
type WsSink = SplitSink<WebSocketStream<TcpStream>, tungstenite::Message>;

#[derive(Debug, Serialize, Deserialize)]
struct Magnet {
    id: i32,
    x: i32,
    y: i32,
    rotation: i32,
    z_index: i64,
    word: String,
}

#[derive(Debug, Serialize, Deserialize)]
struct LocationUpdate {
    id: i32,
    x: i32,
    y: i32,
    rotation: i32,
    z_index: i64,
}

#[derive(Debug, Serialize)]
#[serde(untagged)]
enum MagnetUpdate {
    Create(Magnet),
    Move(LocationUpdate),
    Remove(i32),
    CanvasUpdate(Vec<Magnet>),
    SessionIdUpdate(String),
}

#[derive(Debug, Serialize, Deserialize)]
struct ClientMagnetUpdate {
    is_magnet_update: bool,
    id: i32,
    x: i32,
    y: i32,
    rotation: i32,
}

impl ClientMagnetUpdate {
    fn is_valid(&self, window: &Window) -> bool {
        if self.id > 20_000_100 {
            return false;
        }

        if !(-360..=360).contains(&self.rotation) {
            return false;
        }

        if !(window.x1 - 100..=window.x2 + 100).contains(&self.x)
            || !(window.y1 - 100..=window.y2 + 100).contains(&self.y)
        {
            return false;
        }

        if !(-500_000..=500_000).contains(&self.x) || !(-500_000..=500_000).contains(&self.y) {
            return false;
        }

        true
    }
}

#[derive(Debug, Deserialize)]
#[serde(untagged)]
enum ClientUpdate {
    Window(Window),
    Magnet(ClientMagnetUpdate),
}

// TODO attach timestamp?
#[tracing::instrument(skip(writer))]
async fn send_relevant_update(
    writer: &mut WsSink,
    client_window: &Window,
    magnet_update: PgMagnetUpdate,
) -> Result<bool, tungstenite::Error> {
    if client_window.contains(magnet_update.new_x, magnet_update.new_y) {
        if client_window.contains(magnet_update.old_x, magnet_update.old_y) {
            let location_update = MagnetUpdate::Move(LocationUpdate {
                id: magnet_update.id,
                x: magnet_update.new_x,
                y: magnet_update.new_y,
                rotation: magnet_update.rotation,
                z_index: magnet_update.z_index,
            });

            let buf = rmp_serde::to_vec(&location_update).unwrap();
            writer.send(buf.into()).await?;
        } else {
            let create_update = MagnetUpdate::Create(Magnet {
                id: magnet_update.id,
                x: magnet_update.new_x,
                y: magnet_update.new_y,
                rotation: magnet_update.rotation,
                z_index: magnet_update.z_index,
                word: magnet_update.word,
            });

            let buf = rmp_serde::to_vec(&create_update).unwrap();
            writer.send(buf.into()).await?;
        }
        Ok(true)
    } else if client_window.contains(magnet_update.old_x, magnet_update.old_y) {
        let remove_update = MagnetUpdate::Remove(magnet_update.id);

        let buf = rmp_serde::to_vec(&remove_update).unwrap();
        writer.send(buf.into()).await?;
        Ok(true)
    } else {
        Ok(false)
    }
}

#[tracing::instrument(skip(writer, postgres))]
async fn send_new_magnets(
    writer: &mut WsSink,
    shape: &Shape,
    postgres: &PgPool,
) -> Result<(), FridgeError> {
    let magnets = match shape {
        Shape::Window(window) => sqlx::query_as!(
            Magnet,
            r#"SELECT id, coords[0]::int AS "x!", coords[1]::int AS "y!", rotation, word, z_index
               FROM magnets
               WHERE coords <@ Box(Point($1::int, $2::int), Point($3::int, $4::int))"#,
            window.x1,
            window.y1,
            window.x2,
            window.y2
        )
        .fetch_all(postgres)
        .await?,

        // what the fuck
        Shape::Polygon(polygon) => sqlx::query_as!(
            Magnet,
            r#"SELECT id, coords[0]::int AS "x!", coords[1]::int AS "y!", rotation, word, z_index
                FROM magnets
                WHERE coords <@ Polygon('(' ||
                    '(' || $1::int || ',' || $2::int || '),' ||
                    '(' || $3::int || ',' || $4::int || '),' ||
                    '(' || $5::int || ',' || $6::int || '),' ||
                    '(' || $7::int || ',' || $8::int || '),' ||
                    '(' || $9::int || ',' || $10::int || '),' ||
                    '(' || $11::int || ',' || $12::int || ')' ||
                ')')"#,
            polygon.p1.x,
            polygon.p1.y,
            polygon.p2.x,
            polygon.p2.y,
            polygon.p3.x,
            polygon.p3.y,
            polygon.p4.x,
            polygon.p4.y,
            polygon.p5.x,
            polygon.p5.y,
            polygon.p6.x,
            polygon.p6.y
        )
        .fetch_all(postgres)
        .await?,
    };

    let buf = rmp_serde::to_vec(&MagnetUpdate::CanvasUpdate(magnets)).unwrap();
    writer.send(buf.into()).await?;
    Ok(())
}

#[tracing::instrument(skip(session_id, postgres))]
async fn update_magnet(
    update: ClientMagnetUpdate,
    session_id: &Uuid,
    postgres: &PgPool,
) -> Result<(), FridgeError> {
    sqlx::query!(
        r#"UPDATE magnets
           SET coords = Point($1::int, $2::int), rotation = $3, z_index = nextval('magnets_z_index_seq'), last_modifier = $4
           WHERE id = $5"#,
        update.x,
        update.y,
        update.rotation,
        session_id,
        update.id
    )
    .execute(postgres)
    .await?;

    Ok(())
}

#[tracing::instrument(skip(writer, session_id))]
async fn handle_websocket_binary(
    bytes: tungstenite::Bytes,
    client_window: &mut Window,
    writer: &mut WsSink,
    state: &AppState,
    session_id: &Uuid,
) -> Result<(), FridgeError> {
    let client_update = rmp_serde::from_slice(&bytes)?;

    match client_update {
        ClientUpdate::Window(window_update) => {
            if !window_update.is_valid() {
                return Err(FridgeError::OutOfBounds(format!("{window_update:?}")));
            }

            let difference = client_window.difference(&window_update);
            *client_window = window_update.clamp();

            let Some(difference) = difference else {
                // ignoring window non-change
                return Ok(());
            };

            send_new_magnets(writer, &difference, &state.postgres).await?;
        }
        ClientUpdate::Magnet(magnet_update) => {
            if !magnet_update.is_valid(client_window) {
                return Err(FridgeError::OutOfBounds(format!("{magnet_update:?}")));
            }

            update_magnet(magnet_update, session_id, &state.postgres).await?;
        }
    }

    Ok(())
}

#[tracing::instrument(skip(writer))]
async fn close_with(writer: &mut WsSink, error: FridgeError) -> bool {
    match &error {
        e @ FridgeError::ClientClose(_) => {
            tracing::debug!("{e}");
            return true;
        }
        e @ FridgeError::Other(_) | e @ FridgeError::Sqlx(_) => {
            tracing::error!("{e}");
        }
        _ => {}
    }

    if let Some(close_frame) = error.to_close_frame() {
        tracing::debug!("Closing connection with {close_frame:?}");
        let _ = writer.send(Message::Close(Some(close_frame))).await;
        return true;
    }

    // Just rate limited
    false
}

const REQUESTS_PER_SECOND: usize = 5;

#[derive(Debug)]
struct SessionState {
    session_id: Uuid,

    reader: WsStream,
    writer: WsSink,

    rx: tokio::sync::broadcast::Receiver<PgMagnetUpdate>,

    client_window: Window,

    last_n_requests: [Option<Instant>; REQUESTS_PER_SECOND],
    current_request_index: usize,
    time_since_last_comms: Instant,
}

#[tracing::instrument(skip(session_state))]
async fn get_next_action(
    state: &AppState,
    session_state: &mut SessionState,
) -> Result<(), FridgeError> {
    select! {
        () = state.token.cancelled() => {
            return Err(FridgeError::Shutdown);
        }

        // Update to a magnet entity from Postgres
        magnet_update = session_state.rx.recv() => {
            let magnet_update = magnet_update.map_err(anyhow::Error::from)?;
            send_relevant_update(&mut session_state.writer, &session_state.client_window, magnet_update).await?;
        }

        message = session_state.reader.next() => {

            let now = Instant::now();
            if let Some(timestamp) = session_state.last_n_requests[session_state.current_request_index] {
                if (now - timestamp).as_millis() >= 1000 {
                    session_state.last_n_requests[session_state.current_request_index] = Some(now);
                } else {
                    return Err(FridgeError::RateLimited);
                }
            } else {
                session_state.last_n_requests[session_state.current_request_index] = Some(now);
            }
            session_state.current_request_index += 1;
            if session_state.current_request_index > REQUESTS_PER_SECOND - 1 {
                session_state.current_request_index = 0;
            }

            match message {
                Some(Ok(Message::Binary(bytes))) => {
                    // rate limiting - if the nth to last request was less than a second ago, ignore the new one.
                    session_state.time_since_last_comms = now;
                    handle_websocket_binary(
                        bytes,
                        &mut session_state.client_window,
                        &mut session_state.writer,
                        state,
                        &session_state.session_id,
                    )
                    .await?;
                }
                Some(Ok(Message::Pong(_))) => {
                    return Ok(());
                }
                Some(Ok(Message::Close(close))) => {
                    return Err(FridgeError::ClientClose(close));
                }
                Some(Ok(thing)) => {
                    // Ping or Text
                    return Err(FridgeError::UnsupportedMessage(thing));
                }
                Some(Err(e)) => {
                    return Err(FridgeError::Tungstenite(e));
                }
                None => {
                    return Err(FridgeError::ClientClose(None));
                }
            }
        }
    }

    Ok(())
}

pub async fn handle_socket(
    reader: WsStream,
    mut writer: WsSink,
    session_id: Uuid,
    app_state: AppState,
) {
    sentry::configure_scope(|scope| {
        scope.set_tag("session_id", session_id);
    });
    let session_span = tracing::span!(Level::DEBUG, "session", id = session_id.to_string());

    {
        let session_id_update = MagnetUpdate::SessionIdUpdate(session_id.to_string());
        let buf = rmp_serde::to_vec(&session_id_update).unwrap();
        if writer.send(buf.into()).await.is_err() {
            tracing::debug!(parent: &session_span, "Unable to establish connnection");
            return;
        }
    }

    let mut session_state = SessionState {
        session_id,
        reader,
        writer,
        rx: app_state.magnet_updates.subscribe(),
        client_window: Window::default(),
        last_n_requests: [None; REQUESTS_PER_SECOND],
        current_request_index: 0,
        time_since_last_comms: Instant::now(),
    };

    const MAX_IDLE_TIME: Duration = Duration::from_secs(300);
    const TEN_SECS: Duration = Duration::from_millis(10000);

    loop {
        match timeout(
            TEN_SECS,
            get_next_action(&app_state, &mut session_state).instrument(session_span.clone()),
        )
        .await
        {
            Ok(Ok(())) => {}
            Ok(Err(e)) => {
                if close_with(&mut session_state.writer, e)
                    .instrument(session_span.clone())
                    .await
                {
                    break;
                }
            }
            Err(_) => {
                if (Instant::now() - session_state.time_since_last_comms) > MAX_IDLE_TIME {
                    close_with(&mut session_state.writer, FridgeError::IdleTimeout)
                        .instrument(session_span.clone())
                        .await;
                    break;
                }

                if let Err(e) = session_state
                    .writer
                    .send(tungstenite::Message::Ping(tungstenite::Bytes::new()))
                    .await
                {
                    close_with(&mut session_state.writer, FridgeError::Tungstenite(e))
                        .instrument(session_span.clone())
                        .await;
                    break;
                }
            }
        }
    }
}
