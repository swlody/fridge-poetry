use futures_util::{
    stream::{SplitSink, SplitStream},
    SinkExt as _, StreamExt,
};
use serde::{Deserialize, Serialize};
use tokio::{net::TcpStream, select};
use tokio_tungstenite::{tungstenite, tungstenite::Message, WebSocketStream};
use uuid::Uuid;

use crate::{
    geometry::{Shape, Window},
    state::{AppState, PgMagnetUpdate},
    FridgeError,
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
    session_id: Uuid,
) -> Result<bool, tungstenite::Error> {
    if magnet_update.session_id == session_id {
        return Ok(false);
    }

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
                WHERE coords <@ ('(' ||
            '(' || $1::int || ',' || $2::int || '),' ||
            '(' || $3::int || ',' || $4::int || '),' ||
            '(' || $5::int || ',' || $6::int || '),' ||
            '(' || $7::int || ',' || $8::int || '),' ||
            '(' || $9::int || ',' || $10::int || '),' ||
            '(' || $11::int || ',' || $12::int || ')' ||
            ')')::polygon"#,
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
    bytes: tokio_tungstenite::tungstenite::Bytes,
    client_window: &mut Window,
    mut writer: &mut WsSink,
    state: &AppState,
    session_id: &Uuid,
) -> Result<(), ()> {
    let Ok(client_update) = rmp_serde::from_slice(&bytes) else {
        tracing::debug!("Received unknown msgpack");
        return Ok(());
    };

    match client_update {
        ClientUpdate::Window(window_update) => {
            let difference = client_window.difference(&window_update);
            *client_window = window_update.clone();

            let Some(difference) = difference else {
                return Ok(());
            };

            match send_new_magnets(writer, &difference, state).await {
                Ok(()) => {}
                Err(FridgeError::Tungstenite(e)) => {
                    tracing::debug!("Unable to send new magnets, disconnecting websocket: {e}");
                    return Err(());
                }
                Err(FridgeError::Sqlx(e)) => {
                    tracing::error!("Unable to get magnets from database: {e}");
                }
            }
        }
        ClientUpdate::Magnet(magnet_update) => {
            if let Err(FridgeError::Sqlx(e)) = update_magnet(magnet_update, session_id, state).await
            {
                tracing::error!("Unable to update magnet in databse: {e}");
            }
        }
    }

    Ok(())
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

    let mut rx = state.magnet_updates.subscribe();
    let mut client_window = Window::default();

    loop {
        select! {
            () = state.token.cancelled() => {
                break;
            }

            // Update to a magnet entity from Postgres
            magnet_update = rx.recv() => {
                let magnet_update = magnet_update.expect("Broadcast sender unexpectedly dropped");

                if send_relevant_update(&mut writer, &client_window, magnet_update, session_id)
                    .await
                    .is_err()
                {
                    tracing::debug!("Unable to send single magnet update, closing connection");
                    break;
                }
            }

            // Update to watch window from WebSocket
            message = reader.next() => {
                match message {
                    Some(Ok(Message::Binary(bytes))) => {
                        if handle_websocket_binary(
                            bytes,
                            &mut client_window,
                            &mut writer,
                            &state,
                            &session_id,
                        )
                        .await
                        .is_err()
                        {
                            break;
                        };
                    }
                    Some(Ok(Message::Close(close))) => {
                        tracing::debug!("WebSocket closed by client: {close:?}");
                        break;
                    }
                    Some(Ok(thing)) => {
                        // TODO just disconnect if we receive invalid data?
                        tracing::debug!("Received unexpected message over websocket: {thing:?}");
                    }
                    Some(Err(e)) => {
                        tracing::debug!("Websocket error: {e}");
                        break;
                    }
                    None => {
                        tracing::debug!("Received empty message over websocket");
                        break;
                    }
                }
            }
        }
    }
}
