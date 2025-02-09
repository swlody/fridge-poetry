use axum::{
    extract::{
        ws::{Message, WebSocket},
        State, WebSocketUpgrade,
    },
    response::IntoResponse,
    routing::get,
    Router,
};
use serde::{Deserialize, Serialize};
use tokio::select;

use crate::{
    error::FridgeError,
    state::{AppState, PgMagnetUpdate},
};

#[derive(Clone, Debug, Serialize, Deserialize, Default)]
struct Window {
    x1: i32,
    y1: i32,
    x2: i32,
    y2: i32,
}

impl Window {
    const fn contains(&self, x: i32, y: i32) -> bool {
        x >= self.x1 && x <= self.x2 && y >= self.y1 && y <= self.y2
    }
}

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
    id: i32,
    x: i32,
    y: i32,
    rotation: i32,
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
    socket: &mut WebSocket,
    client_window: &Window,
    magnet_update: PgMagnetUpdate,
) -> Result<bool, axum::Error> {
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
            socket.send(buf.into()).await?;
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
            socket.send(buf.into()).await?;
        }
        Ok(true)
    } else if client_window.contains(magnet_update.old_x, magnet_update.old_y) {
        let remove_update = MagnetUpdate::Remove(magnet_update.id);

        let buf = rmp_serde::to_vec(&remove_update).unwrap();
        socket.send(buf.into()).await?;
        Ok(true)
    } else {
        Ok(false)
    }
}

#[tracing::instrument]
async fn send_new_magnets(
    socket: &mut WebSocket,
    window: &Window,
    state: &AppState,
) -> Result<(), FridgeError> {
    let magnets = sqlx::query_as!(
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
    .await?;

    let buf = rmp_serde::to_vec(&MagnetUpdate::CanvasUpdate(magnets)).unwrap();
    socket.send(buf.into()).await?;
    Ok(())
}

#[tracing::instrument]
async fn update_magnet(update: ClientMagnetUpdate, state: &AppState) -> Result<(), FridgeError> {
    // TODO coherence checks: inside area bounds and rotation within correct range
    sqlx::query!(
        r#"UPDATE magnets
           SET coords = Point($1::int, $2::int), rotation = $3, z_index = nextval('magnets_z_index_seq')
           WHERE id = $4"#,
        update.x,
        update.y,
        update.rotation,
        update.id
    )
    .execute(&state.postgres)
    .await?;

    Ok(())
}

#[tracing::instrument]
async fn ws_handler(ws: WebSocketUpgrade, State(state): State<AppState>) -> impl IntoResponse {
    ws.on_upgrade(move |socket| handle_socket(socket, state))
}

async fn handle_socket(mut socket: WebSocket, state: AppState) {
    let mut rx = state.magnet_updates.subscribe();
    let mut client_window = Window::default();

    loop {
        select! {
            // Update to a magnet entity from Postgres
            magnet_update = rx.recv() => {
                let magnet_update = magnet_update.expect("Broadcast sender unexpectedly dropped");

                if send_relevant_update(&mut socket, &client_window, magnet_update)
                    .await
                    .is_err()
                {
                    tracing::debug!("Unable to send single magnet update, closing connection");
                    break;
                }
            }

            // Update to watch window from WebSocket
            message = socket.recv() => {
                match message {
                    Some(Ok(Message::Binary(bytes))) => {
                        if let Ok(client_update) = rmp_serde::from_slice(&bytes) {
                            match client_update {
                                ClientUpdate::Window(window_update) => {
                                    client_window = window_update;
                                    match send_new_magnets(&mut socket, &client_window, &state).await {
                                        Ok(()) => {},
                                        Err(FridgeError::Axum(e)) => {
                                            tracing::debug!("Unable to send new magnets, disconnecting websocket: {e}");
                                            break;
                                        }
                                        Err(FridgeError::Sqlx(e)) => {
                                            tracing::error!("Unable to get magnets from database: {e}");
                                        }
                                    }
                                }
                                ClientUpdate::Magnet(magnet_update) => {
                                    match update_magnet(magnet_update, &state).await {
                                        Err(FridgeError::Sqlx(e)) => {
                                            tracing::error!("Unable to update magnet in databse: {e}");
                                        }
                                        _ => {}
                                    }
                                }
                            }
                        } else {
                            tracing::debug!("Received unknown msgpack");
                        }
                    }
                    Some(Ok(Message::Close(close))) => {
                        tracing::debug!("WebSocket closed by client: {close:?}");
                        break;
                    }
                    Some(thing) => {
                        // TODO just disconnect if we receive invalid data?
                        tracing::debug!("Received unexpected message over websocket: {thing:?}");
                    }
                    None => {
                        break;
                    }
                }
            }
        }
    }

    tracing::debug!("WebSocket disconnected");
}

pub fn routes() -> Router<AppState> {
    Router::new().route("/", get(ws_handler))
}
