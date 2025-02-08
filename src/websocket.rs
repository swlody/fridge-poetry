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
use tokio::select;

use crate::{
    geometry::{Point, Window},
    state::AppState,
};

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
                if client_window.contains(Point::new(magnet_update.old_x, magnet_update.old_y))
                    || client_window.contains(Point::new(magnet_update.new_x, magnet_update.new_y))
                {
                    let magnet_update = serde_json::to_string(&magnet_update).unwrap();
                    if socket.send(magnet_update.into()).await.is_err() {
                        tracing::debug!("Error sending magnet update to client");
                        break;
                    }
                }
            }

            // Update to watch window from WebSocket
            message = socket.recv() => {
                match message {
                    Some(Ok(Message::Text(text))) => {
                        if let Ok(window_update) = serde_json::from_str(&text) {
                            client_window = window_update;
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
                        tracing::debug!("WebSocket disconnected");
                        break;
                    }
                }
            }
        }
    }
}

pub fn routes() -> Router<AppState> {
    Router::new().route("/", get(ws_handler))
}
