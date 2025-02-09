use std::net::SocketAddr;

use axum::{
    extract::{
        ws::{Message, WebSocket},
        ConnectInfo, State, WebSocketUpgrade,
    },
    response::IntoResponse,
    routing::get,
    Router,
};
use serde::{Deserialize, Serialize};
use tokio::select;

use crate::{
    geometry::{Point, Window},
    state::AppState,
};

#[derive(Debug, Serialize, Deserialize)]
struct CreateMagnet {
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

#[derive(Debug, Serialize, Deserialize)]
enum MagnetUpdate {
    Create(CreateMagnet),
    Move(LocationUpdate),
    Remove(i32),
}

#[tracing::instrument]
async fn ws_handler(
    ws: WebSocketUpgrade,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    State(state): State<AppState>,
) -> impl IntoResponse {
    ws.on_upgrade(move |socket| handle_socket(socket, addr, state))
}

#[tracing::instrument]
async fn handle_socket(mut socket: WebSocket, who: SocketAddr, state: AppState) {
    let mut rx = state.magnet_updates.subscribe();
    let mut client_window = Window::default();

    loop {
        select! {
            // Update to a magnet entity from Postgres
            magnet_update = rx.recv() => {
                let magnet_update = magnet_update.expect("Broadcast sender unexpectedly dropped");

                if client_window.contains(Point::new(magnet_update.new_x, magnet_update.new_y)) {
                    if client_window.contains(Point::new(magnet_update.old_x, magnet_update.old_y)) {
                        let location_update = MagnetUpdate::Move(LocationUpdate {
                            id: magnet_update.id,
                            x: magnet_update.new_x,
                            y: magnet_update.new_y,
                            rotation: magnet_update.rotation,
                            z_index: magnet_update.z_index,
                        });

                        let buf = rmp_serde::to_vec(&location_update).unwrap();

                        if socket.send(buf.into()).await.is_err() {
                            break;
                        }
                    } else {
                        let create_update = MagnetUpdate::Create(CreateMagnet {
                            id: magnet_update.id,
                            x: magnet_update.new_x,
                            y: magnet_update.new_y,
                            rotation: magnet_update.rotation,
                            z_index: magnet_update.z_index,
                            word: magnet_update.word,
                        });

                        let buf = rmp_serde::to_vec(&create_update).unwrap();

                        if socket.send(buf.into()).await.is_err() {
                            break;
                        }
                    }
                } else if client_window.contains(Point::new(magnet_update.old_x, magnet_update.old_y)) {
                    let remove_update = MagnetUpdate::Remove(magnet_update.id);

                    let buf = rmp_serde::to_vec(&remove_update).unwrap();

                    if socket.send(buf.into()).await.is_err() {
                        break;
                    }
                }
            }

            // Update to watch window from WebSocket
            message = socket.recv() => {
                match message {
                    Some(Ok(Message::Binary(bytes))) => {
                        if let Ok(window_update) = rmp_serde::from_slice(&bytes) {
                            client_window = window_update;
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
                        tracing::debug!("Received unexpected message over websocket: {thing:?}")
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
