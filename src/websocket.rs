use std::time::{Duration, Instant};

use futures_util::{
    SinkExt as _, StreamExt,
    stream::{SplitSink, SplitStream},
};
use serde::{Deserialize, Serialize};
use tokio::{net::TcpStream, select, time::timeout};
use tokio_tungstenite::{
    WebSocketStream,
    tungstenite::{
        self, Message, Utf8Bytes,
        protocol::{CloseFrame, frame::coding::CloseCode},
    },
};
use tracing::{Instrument, Level};
use uuid::Uuid;

use crate::{
    FridgeError,
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
#[tracing::instrument]
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

#[tracing::instrument]
async fn send_new_magnets(
    writer: &mut WsSink,
    shape: &Shape,
    state: &AppState,
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
        .fetch_all(&state.postgres)
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
        .fetch_all(&state.postgres)
        .await?,
    };

    let buf = rmp_serde::to_vec(&MagnetUpdate::CanvasUpdate(magnets)).unwrap();
    writer.send(buf.into()).await?;
    Ok(())
}

#[tracing::instrument]
async fn update_magnet(
    update: ClientMagnetUpdate,
    session_id: &Uuid,
    state: &AppState,
) -> Result<(), FridgeError> {
    // TODO coherence checks: inside area bounds and rotation within correct range
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
    .execute(&state.postgres)
    .await?;

    Ok(())
}

#[tracing::instrument]
async fn handle_websocket_binary(
    bytes: tungstenite::Bytes,
    client_window: &mut Window,
    writer: &mut WsSink,
    state: &AppState,
    session_id: &Uuid,
) -> Result<(), FridgeError> {
    let Ok(client_update) = rmp_serde::from_slice(&bytes) else {
        return Err(FridgeError::InvalidMessage(format!("{bytes:?}")));
    };

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

            send_new_magnets(writer, &difference, state).await?;
        }
        ClientUpdate::Magnet(magnet_update) => {
            if !magnet_update.is_valid(client_window) {
                return Err(FridgeError::OutOfBounds(format!("{magnet_update:?}")));
            }

            update_magnet(magnet_update, session_id, state).await?;
        }
    }

    Ok(())
}

async fn close_with(writer: &mut WsSink, error: FridgeError) -> bool {
    match error {
        e @ FridgeError::Shutdown => {
            tracing::debug!("{e}");
            let _ = writer
                .send(Message::Close(Some(CloseFrame {
                    code: CloseCode::Restart,
                    reason: Utf8Bytes::from_static(""),
                })))
                .await;
            true
        }
        e @ FridgeError::IdleTimeout => {
            tracing::debug!("{e}");
            let _ = writer
                .send(Message::Close(Some(CloseFrame {
                    code: CloseCode::Away,
                    reason: Utf8Bytes::from_static(""),
                })))
                .await;
            true
        }
        e @ FridgeError::InvalidMessage(_) => {
            tracing::debug!("{e}");
            let _ = writer
                .send(Message::Close(Some(CloseFrame {
                    code: CloseCode::Invalid,
                    reason: Utf8Bytes::from_static(""),
                })))
                .await;
            true
        }
        e @ FridgeError::Tungstenite(_) => {
            tracing::debug!("{e}");
            let _ = writer
                .send(Message::Close(Some(CloseFrame {
                    code: CloseCode::Protocol,
                    reason: Utf8Bytes::from_static(""),
                })))
                .await;
            true
        }
        e @ FridgeError::Sqlx(sqlx::Error::RowNotFound) | e @ FridgeError::OutOfBounds(_) => {
            tracing::debug!("{e}");
            let _ = writer
                .send(Message::Close(Some(CloseFrame {
                    code: CloseCode::Policy,
                    reason: Utf8Bytes::from_static(""),
                })))
                .await;
            true
        }
        e @ FridgeError::Other(_) | e @ FridgeError::Sqlx(_) => {
            tracing::error!("{e}");
            let _ = writer
                .send(Message::Close(Some(CloseFrame {
                    code: CloseCode::Error,
                    reason: Utf8Bytes::from_static(""),
                })))
                .await;
            true
        }
        e @ FridgeError::ClientClose(_) => {
            tracing::debug!("{e}");
            true
        }
        e @ FridgeError::RateLimited => {
            tracing::debug!("{e}");
            false
        }
    }
}

pub async fn handle_socket(
    mut reader: WsStream,
    mut writer: WsSink,
    session_id: Uuid,
    state: AppState,
) {
    sentry::configure_scope(|scope| {
        scope.set_tag("session_id", session_id);
    });
    let session = tracing::span!(Level::DEBUG, "session", id = session_id.to_string());

    let mut rx = state.magnet_updates.subscribe();
    let mut client_window = Window::default();

    const REQUESTS_PER_SECOND: usize = 5;
    let mut last_n_requests: [Option<Instant>; REQUESTS_PER_SECOND] = [None; REQUESTS_PER_SECOND];
    let mut current_request_index = 0;

    let mut time_since_last_comms = Instant::now();

    const MAX_IDLE_TIME: Duration = Duration::from_secs(300);

    loop {
        match timeout(Duration::from_millis(10000), async {
            select! {
                () = state.token.cancelled() => {
                    return Err(FridgeError::Shutdown);
                }

                // Update to a magnet entity from Postgres
                magnet_update = rx.recv() => {
                    let _enter = session.enter();
                    let magnet_update = magnet_update.map_err(anyhow::Error::from)?;
                    send_relevant_update(&mut writer, &client_window, magnet_update).await?;
                }

                message = reader.next() => {
                    let _enter = session.enter();

                    // rate limiting - if the nth to last request was less than a second ago, ignore the new one.
                    let now = Instant::now();
                    time_since_last_comms = now;

                    if let Some(timestamp) = last_n_requests[current_request_index] {
                        if (now - timestamp).as_millis() >= 1000 {
                            last_n_requests[current_request_index] = Some(now);
                        } else {
                            return Err(FridgeError::RateLimited);
                        }
                    } else {
                        last_n_requests[current_request_index] = Some(now);
                    }
                    current_request_index += 1;
                    if current_request_index > REQUESTS_PER_SECOND - 1 {
                        current_request_index = 0;
                    }

                    match message {
                        Some(Ok(Message::Binary(bytes))) => {
                            handle_websocket_binary(
                                bytes,
                                &mut client_window,
                                &mut writer,
                                &state,
                                &session_id,
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
                            return Err(FridgeError::InvalidMessage(format!("{thing:?}")));
                        }
                        Some(Err(e)) => {
                            return Err(FridgeError::InvalidMessage(e.to_string()));
                        }
                        None => {
                            return Err(FridgeError::InvalidMessage(String::new()))
                        }
                    }
                }
            }

            Ok(())
        })
        .await
        {
            Ok(Ok(())) => {}
            Ok(Err(e)) => {
                if close_with(&mut writer, e).instrument(session.clone()).await {
                    break;
                }
            }
            Err(_) => {
                if (Instant::now() - time_since_last_comms) > MAX_IDLE_TIME {
                    close_with(&mut writer, FridgeError::IdleTimeout)
                        .instrument(session.clone())
                        .await;
                    break;
                }

                writer
                    .send(tungstenite::Message::Ping(tungstenite::Bytes::new()))
                    .await
                    .unwrap();
            }
        }
    }
}
