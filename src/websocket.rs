use futures_util::{
    stream::{SplitSink, SplitStream},
    SinkExt as _, StreamExt,
};
use serde::{Deserialize, Serialize};
use tokio::{net::TcpStream, select};
use tokio_tungstenite::{tungstenite, tungstenite::Message, WebSocketStream};
use uuid::Uuid;

use crate::{
    state::{AppState, PgMagnetUpdate},
    FridgeError,
};

type WsStream = SplitStream<WebSocketStream<TcpStream>>;
type WsSink = SplitSink<WebSocketStream<TcpStream>, tungstenite::Message>;

#[derive(Clone, Debug)]
struct Point {
    x: i32,
    y: i32,
}

#[derive(Debug)]
struct Polygon {
    p1: Point,
    p2: Point,
    p3: Point,
    p4: Point,
    p5: Point,
    p6: Point,
}

#[derive(Debug)]
enum Shape {
    Window(Window),
    Polygon(Polygon),
}

#[derive(Clone, Debug, Serialize, Deserialize, Default)]
struct Window {
    x1: i32,
    y1: i32,
    x2: i32,
    y2: i32,
}

impl Window {
    #[tracing::instrument]
    fn contains(&self, x: i32, y: i32) -> bool {
        x >= self.x1 && x <= self.x2 && y >= self.y1 && y <= self.y2
    }

    #[tracing::instrument]
    fn difference(&self, other: &Window) -> Option<Shape> {
        if self.x1 == other.x1 && self.x2 == other.x2 && self.y1 == other.y1 && self.y2 == other.y2
        {
            return None;
        }

        if self.x2 <= other.x1 || self.x1 >= other.x2 || self.y2 <= other.y1 || self.y1 >= other.y2
        {
            return Some(Shape::Window(other.clone()));
        }

        if other.x1 <= self.x1 && other.x2 >= self.x2 && other.y1 <= self.y1 && other.y2 >= self.y2
        {
            return Some(Shape::Window(other.clone()));
        }

        if self.x1 <= other.x1 && self.x2 >= other.x2 && self.y1 <= other.y1 && self.y2 >= other.y2
        {
            return Some(Shape::Window(other.clone()));
        }

        if self.x1 == other.x1 && self.x2 == other.x2 {
            return Some(Shape::Window(Window {
                x1: other.x1,
                x2: other.x2,
                y1: self.y2.min(other.y1),
                y2: self.y2.max(other.y2),
            }));
        }
        if self.y1 == other.y1 && self.y2 == other.y2 {
            return Some(Shape::Window(Window {
                x1: self.x2.min(other.x1),
                x2: self.x2.max(other.x2),
                y1: other.y1,
                y2: other.y2,
            }));
        }

        Some(Shape::Polygon(Polygon {
            p1: Point {
                x: other.x1,
                y: other.y1,
            },
            p2: Point {
                x: other.x2,
                y: other.y1,
            },
            p3: Point {
                x: other.x2,
                y: self.y2,
            },
            p4: Point {
                x: self.x2,
                y: self.y2,
            },
            p5: Point {
                x: self.x2,
                y: other.y2,
            },
            p6: Point {
                x: other.x1,
                y: other.y2,
            },
        }))
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

#[derive(Debug, Serialize, Deserialize)]
struct WindowUpdate {
    has_scaled: bool,
    x1: i32,
    y1: i32,
    x2: i32,
    y2: i32,
}

#[derive(Debug, Deserialize)]
#[serde(untagged)]
enum ClientUpdate {
    Window(WindowUpdate),
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
        Shape::Window(window) => {
            tracing::debug!("Window");
            sqlx::query_as!(
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
            .await?
        }

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
    session_id: Uuid,
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
            // TODO yikes... reduce nesting?
            message = reader.next() => {
                match message {
                    Some(Ok(Message::Binary(bytes))) => {
                        if let Ok(client_update) = rmp_serde::from_slice(&bytes) {
                            match client_update {
                                ClientUpdate::Window(window_update) => {
                                    let difference = if window_update.has_scaled {
                                        tracing::debug!("Window: {window_update:?}");
                                        Some(Shape::Window(Window {
                                            x1: window_update.x1,
                                            y1: window_update.y1,
                                            x2: window_update.x2,
                                            y2: window_update.y2
                                        }))
                                    } else {
                                        client_window.difference(&Window {
                                            x1: window_update.x1,
                                            y1: window_update.y1,
                                            x2: window_update.x2,
                                            y2: window_update.y2
                                        })
                                    };

                                    client_window = Window {
                                        x1: window_update.x1,
                                        y1: window_update.y1,
                                        x2: window_update.x2,
                                        y2: window_update.y2
                                    };

                                    if let Some(difference) = difference {
                                        match send_new_magnets(&mut writer, &difference, &state).await {
                                            Ok(()) => {},
                                            Err(FridgeError::Tungstenite(e)) => {
                                                tracing::debug!("Unable to send new magnets, disconnecting websocket: {e}");
                                                break;
                                            }
                                            Err(FridgeError::Sqlx(e)) => {
                                                tracing::error!("Unable to get magnets from database: {e}");
                                            }
                                        }
                                    }
                                }
                                ClientUpdate::Magnet(magnet_update) => {
                                    if let Err(FridgeError::Sqlx(e)) = update_magnet(magnet_update, session_id, &state).await {
                                        tracing::error!("Unable to update magnet in databse: {e}");
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
