use futures_util::{SinkExt as _, StreamExt as _};
use rand::{Rng as _, SeedableRng, seq::IndexedRandom as _};
use serde::{Deserialize, Serialize};
use tokio_tungstenite::tungstenite;

#[derive(Clone, Debug, Serialize)]
struct Window {
    x1: i32,
    y1: i32,
    x2: i32,
    y2: i32,
}

#[derive(Debug, Serialize)]
struct ClientMagnetUpdate {
    is_magnet_update: bool,
    id: i32,
    x: i32,
    y: i32,
    rotation: i32,
}

#[derive(Debug, Serialize)]
#[serde(untagged)]
enum ClientUpdate {
    Window(Window),
    Magnet(ClientMagnetUpdate),
}

#[derive(Debug, Deserialize)]
struct Magnet {
    id: i32,
    x: i32,
    y: i32,
    _rotation: i32,
    _z_index: i64,
    _word: String,
}

#[tokio::main]
async fn main() {
    for _ in 0..1_000 {
        tokio::spawn(async {
            let mut rng = rand::rngs::SmallRng::from_os_rng();
            let (socket, response) = tokio_tungstenite::connect_async("ws://localhost:8080/ws")
                .await
                .unwrap();
            assert!(response.status() == tungstenite::http::StatusCode::SWITCHING_PROTOCOLS);

            let (mut writer, mut reader) = socket.split();

            let mut window = true;

            let mut x_center = rng.random_range(-80000..=80000);
            let mut y_center = rng.random_range(-80000..=80000);
            let mut magnetsi: Vec<Magnet> = Vec::new();

            tracing::debug!("starting to send stuff");

            for _ in 0..200 {
                if window {
                    let x_diff = rng.random_range(-1000..1000);
                    let y_diff = rng.random_range(-1000..1000);
                    x_center += x_diff;
                    y_center += y_diff;

                    x_center = std::cmp::min(x_center, 80000);
                    x_center = std::cmp::max(x_center, -80000);
                    y_center = std::cmp::min(y_center, 80000);
                    y_center = std::cmp::max(y_center, -80000);

                    let update_message = ClientUpdate::Window(Window {
                        x1: x_center - 1000,
                        y1: y_center - 1000,
                        x2: x_center + 1000,
                        y2: y_center + 1000,
                    });
                    writer
                        .send(tokio_tungstenite::tungstenite::Message::Binary(
                            rmp_serde::to_vec(&update_message).unwrap().into(),
                        ))
                        .await
                        .unwrap();
                } else {
                    let magnet = magnetsi.choose(&mut rng);

                    if let Some(magnet) = magnet {
                        let id = magnet.id;
                        let x = magnet.x + rng.random_range(-1000..=1000);
                        let y = magnet.y + rng.random_range(-1000..=1000);
                        let rotation = rng.random_range(-359..359);

                        let update_message = ClientUpdate::Magnet(ClientMagnetUpdate {
                            is_magnet_update: true,
                            id,
                            x,
                            y,
                            rotation,
                        });
                        writer
                            .send(tungstenite::Message::Binary(
                                rmp_serde::to_vec(&update_message).unwrap().into(),
                            ))
                            .await
                            .unwrap();
                    }
                }

                tokio::time::sleep(std::time::Duration::from_millis(50)).await;
                window = !window;

                if let Some(Ok(tungstenite::Message::Binary(bytes))) = reader.next().await {
                    let client_update = rmp_serde::from_slice::<Vec<Magnet>>(&bytes);
                    if let Ok(magnets) = client_update {
                        magnetsi = magnets;
                    }
                }
            }
        });
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    }
}
