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
    geometry::{Point, Window},
    state::{AppState, PgMagnetUpdate},
};

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

#[derive(Debug, Serialize, Deserialize)]
enum MagnetUpdate {
    Create(Magnet),
    Move(LocationUpdate),
    Remove(i32),
}

#[derive(Debug, Serialize, Deserialize)]
struct IncomingUpdate {
    id: i32,
    x: i32,
    y: i32,
    rotation: i32,
}

// TODO attach timestamp?
#[tracing::instrument]
async fn send_relevant_update(
    socket: &mut WebSocket,
    client_window: &Window,
    magnet_update: PgMagnetUpdate,
) -> Result<bool, axum::Error> {
    if client_window.contains(&Point::new(magnet_update.new_x, magnet_update.new_y)) {
        if client_window.contains(&Point::new(magnet_update.old_x, magnet_update.old_y)) {
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
    } else if client_window.contains(&Point::new(magnet_update.old_x, magnet_update.old_y)) {
        let remove_update = MagnetUpdate::Remove(magnet_update.id);

        let buf = rmp_serde::to_vec(&remove_update).unwrap();

        socket.send(buf.into()).await?;
        Ok(true)
    } else {
        Ok(false)
    }
}

#[tracing::instrument]
async fn send_new_magnets(socket: &mut WebSocket, window: &Window, state: &AppState) {
    let magnets: Vec<Magnet> = sqlx::query_as!(
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
    .await
    .unwrap();

    let buf = rmp_serde::to_vec(&magnets).unwrap();

    socket.send(buf.into()).await.unwrap();
}

#[tracing::instrument]
async fn update_magnet(update: IncomingUpdate, state: &AppState) {
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
    .await
    .unwrap();
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
                    break;
                }
            }

            // Update to watch window from WebSocket
            message = socket.recv() => {
                match message {
                    Some(Ok(Message::Binary(bytes))) => {
                        if let Ok(window_update) = rmp_serde::from_slice(&bytes) {
                            client_window = window_update;
                            send_new_magnets(&mut socket, &client_window, &state).await;
                        } else if let Ok(location_update) = rmp_serde::from_slice(&bytes) {
                            update_magnet(location_update, &state).await;
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
