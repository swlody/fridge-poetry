use thiserror::Error;
use tokio_websockets::{CloseCode, Message};

#[derive(Debug, Error)]
pub enum FridgeError {
    #[error("Server shutting down")]
    Shutdown,

    #[error("Request exceeds rate limits")]
    RateLimited,

    #[error("WebSocket connection closed by client")]
    ClientClose(Option<(CloseCode, String)>),

    #[error("Closing connection due to idle timeout")]
    IdleTimeout,

    #[error("Received an unsupported message type")]
    UnsupportedMessage(tokio_websockets::Message),

    #[error(transparent)]
    InvalidMessage(#[from] rmp_serde::decode::Error),

    #[error("Out of bounds update")]
    OutOfBounds(String),

    #[error(transparent)]
    Tungstenite(#[from] tokio_websockets::Error),

    #[error(transparent)]
    Sqlx(#[from] sqlx::Error),

    #[error("Internal server error")]
    Other(#[from] anyhow::Error),
}

impl FridgeError {
    pub fn to_close_message(&self) -> Option<Message> {
        match self {
            FridgeError::Shutdown => Some(Message::close(Some(CloseCode::SERVICE_RESTART), "")),
            FridgeError::IdleTimeout => Some(Message::close(Some(CloseCode::GOING_AWAY), "")),
            FridgeError::InvalidMessage(_) => Some(Message::close(
                Some(CloseCode::INVALID_FRAME_PAYLOAD_DATA),
                "",
            )),
            FridgeError::UnsupportedMessage(_) => {
                Some(Message::close(Some(CloseCode::UNSUPPORTED_DATA), ""))
            }
            FridgeError::Tungstenite(tokio_websockets::Error::PayloadTooLong { .. }) => {
                Some(Message::close(Some(CloseCode::MESSAGE_TOO_BIG), ""))
            }
            FridgeError::Tungstenite(_) => {
                // We experienced an error in sending a previous message,
                // don't expect this one to complete
                Some(Message::close(Some(CloseCode::INTERNAL_SERVER_ERROR), ""))
            }
            FridgeError::Sqlx(sqlx::Error::RowNotFound) | FridgeError::OutOfBounds(_) => {
                Some(Message::close(Some(CloseCode::POLICY_VIOLATION), ""))
            }
            FridgeError::Other(_) | FridgeError::Sqlx(_) => {
                Some(Message::close(Some(CloseCode::INTERNAL_SERVER_ERROR), ""))
            }
            FridgeError::ClientClose(_) => None,
            FridgeError::RateLimited => None,
        }
    }
}
