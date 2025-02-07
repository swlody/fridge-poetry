use std::net::SocketAddr;

use axum::{
    body::Bytes,
    extract::{
        ws::{Message, WebSocket},
        ConnectInfo, State, WebSocketUpgrade,
    },
    response::IntoResponse,
    routing::get,
    Router,
};
use futures_util::FutureExt;
use tokio::select;

use crate::{
    error::FridgeError,
    geometry::{Point, Window},
    state::AppState,
};

#[tracing::instrument]
async fn ws_handler(
    ws: WebSocketUpgrade,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    State(state): State<AppState>,
) -> impl IntoResponse {
    // TODO limit to number of open WebSocket connections per IP?

    ws.on_upgrade(move |socket| {
        handle_socket(socket, addr, state).map(|res| {
            if let Err(e) = res {
                tracing::error!("Error in websocket: {:?}", e);
            }
        })
    })
}

#[tracing::instrument]
async fn handle_socket(
    mut socket: WebSocket,
    who: SocketAddr,
    state: AppState,
) -> Result<(), FridgeError> {
    let mut rx = state.magnet_updates.subscribe();
    let mut client_window = Window::default();

    loop {
        select! {
            // Update to a magnet entity from Postgres
            magnet_update = rx.recv() => {
                let magnet_update = magnet_update.expect("Broadcast sender unexpectedly dropped");
                if client_window.contains(Point::new(magnet_update.x, magnet_update.y)) {
                    // TODO also need to send update if magnet that was previously in bounds goes out of bounds
                    let magnet_update = serde_json::to_string(&magnet_update).unwrap();
                    if socket.send(magnet_update.into()).await.is_err() {
                        tracing::debug!("Error sending magnet update to client");
                        break;
                    }
                }
            },

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
                    thing => {
                        tracing::debug!("Received unexpected message over websocket: {thing:?}")
                    },
                }
            },
        }
    }

    Ok(())
}

pub fn routes() -> Router<AppState> {
    Router::new().route("/", get(ws_handler))
}
