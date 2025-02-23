use thiserror::Error;
use tokio_tungstenite::tungstenite::{
    self, Utf8Bytes,
    protocol::{CloseFrame, frame::coding::CloseCode},
};

#[derive(Debug, Error)]
pub enum FridgeError {
    #[error("Server shutting down")]
    Shutdown,

    #[error("Request exceeds rate limits")]
    RateLimited,

    #[error("WebSocket connection closed by client")]
    ClientClose(Option<tungstenite::protocol::frame::CloseFrame>),

    #[error("Closing connection due to idle timeout")]
    IdleTimeout,

    #[error("Received an unsupported message type")]
    UnsupportedMessage(tungstenite::Message),

    #[error(transparent)]
    InvalidMessage(#[from] rmp_serde::decode::Error),

    #[error("Out of bounds update")]
    OutOfBounds(String),

    #[error(transparent)]
    Tungstenite(#[from] tungstenite::Error),

    #[error(transparent)]
    Sqlx(#[from] sqlx::Error),

    #[error("Internal server error")]
    Other(#[from] anyhow::Error),
}

impl FridgeError {
    pub fn to_close_frame(&self) -> Option<CloseFrame> {
        match self {
            FridgeError::Shutdown => Some(CloseFrame {
                code: CloseCode::Restart,
                reason: Utf8Bytes::from_static(""),
            }),
            FridgeError::IdleTimeout => Some(CloseFrame {
                code: CloseCode::Away,
                reason: Utf8Bytes::from_static(""),
            }),
            FridgeError::InvalidMessage(_) => Some(CloseFrame {
                code: CloseCode::Invalid,
                reason: Utf8Bytes::from_static(""),
            }),
            FridgeError::UnsupportedMessage(_) => Some(CloseFrame {
                code: CloseCode::Unsupported,
                reason: Utf8Bytes::from_static(""),
            }),
            FridgeError::Tungstenite(tungstenite::error::Error::Capacity(_)) => Some(CloseFrame {
                code: CloseCode::Size,
                reason: Utf8Bytes::from_static(""),
            }),
            FridgeError::Tungstenite(_) => {
                // We experienced an error in sending a previous message,
                // don't expect this one to complete
                Some(CloseFrame {
                    code: CloseCode::Abnormal,
                    reason: Utf8Bytes::from_static(""),
                })
            }
            FridgeError::Sqlx(sqlx::Error::RowNotFound) | FridgeError::OutOfBounds(_) => {
                Some(CloseFrame {
                    code: CloseCode::Policy,
                    reason: Utf8Bytes::from_static(""),
                })
            }
            FridgeError::Other(_) | FridgeError::Sqlx(_) => Some(CloseFrame {
                code: CloseCode::Error,
                reason: Utf8Bytes::from_static(""),
            }),
            FridgeError::ClientClose(_) => None,
            FridgeError::RateLimited => None,
        }
    }
}
