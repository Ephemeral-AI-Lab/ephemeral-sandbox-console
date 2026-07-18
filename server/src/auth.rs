//! Opt-in authentication for the desktop loopback server. The standalone
//! browser server remains unauthenticated; the Tauri host installs this state
//! after binding an ephemeral loopback listener.

use std::fmt;
use std::sync::atomic::{AtomicBool, Ordering};

use http::header::{CACHE_CONTROL, COOKIE, HOST, LOCATION, ORIGIN, SET_COOKIE};
use http::uri::Authority;
use http::{HeaderMap, HeaderValue, Response, StatusCode, Uri};

use crate::response::{self, BoxBody};

pub const DESKTOP_BOOTSTRAP_PATH: &str = "/__ephemeral_sandbox/bootstrap";
pub const DESKTOP_SESSION_COOKIE: &str = "ephemeral_sandbox_session";

const MIN_SECRET_LENGTH: usize = 32;

/// One-time bootstrap and session credentials for one desktop BFF instance.
///
/// Debug output intentionally omits both credentials.
pub struct DesktopSessionAuth {
    authority: Authority,
    origin: HeaderValue,
    bootstrap_nonce: String,
    session_token: String,
    bootstrap_consumed: AtomicBool,
}

impl DesktopSessionAuth {
    /// Create desktop auth for an already-bound `127.0.0.1:<port>` listener.
    ///
    /// # Errors
    /// Returns an error for a non-loopback authority, a missing/zero port, or
    /// credentials too short to be high-entropy generated values.
    pub fn new(
        authority: &str,
        bootstrap_nonce: String,
        session_token: String,
    ) -> Result<Self, &'static str> {
        let authority = authority
            .parse::<Authority>()
            .map_err(|_| "invalid desktop BFF authority")?;
        if authority.host() != "127.0.0.1" || authority.port_u16().is_none_or(|port| port == 0) {
            return Err("desktop BFF authority must be an ephemeral IPv4 loopback address");
        }
        if bootstrap_nonce.len() < MIN_SECRET_LENGTH || session_token.len() < MIN_SECRET_LENGTH {
            return Err("desktop BFF credentials must contain at least 32 characters");
        }
        if !bootstrap_nonce
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric())
            || !session_token
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric())
        {
            return Err("desktop BFF credentials must be ASCII alphanumeric");
        }
        let origin = HeaderValue::from_str(&format!("http://{authority}"))
            .map_err(|_| "invalid desktop BFF origin")?;
        Ok(Self {
            authority,
            origin,
            bootstrap_nonce,
            session_token,
            bootstrap_consumed: AtomicBool::new(false),
        })
    }

    #[must_use]
    pub fn authority(&self) -> &Authority {
        &self.authority
    }

    #[must_use]
    pub fn has_expected_host(&self, headers: &HeaderMap) -> bool {
        let mut values = headers.get_all(HOST).iter();
        let Some(host) = values.next() else {
            return false;
        };
        values.next().is_none() && host.as_bytes() == self.authority.as_str().as_bytes()
    }

    #[must_use]
    pub fn has_allowed_origin(&self, headers: &HeaderMap) -> bool {
        let mut values = headers.get_all(ORIGIN).iter();
        let Some(origin) = values.next() else {
            return true;
        };
        values.next().is_none() && origin.as_bytes() == self.origin.as_bytes()
    }

    #[must_use]
    pub fn has_session(&self, headers: &HeaderMap) -> bool {
        headers.get_all(COOKIE).iter().any(|header| {
            header.to_str().ok().is_some_and(|cookies| {
                cookies.split(';').any(|cookie| {
                    cookie.trim().split_once('=').is_some_and(|(name, value)| {
                        name == DESKTOP_SESSION_COOKIE
                            && secrets_equal(value.as_bytes(), self.session_token.as_bytes())
                    })
                })
            })
        })
    }

    /// Validate and consume the one-time nonce, returning the redirect that
    /// establishes the HttpOnly session.
    #[must_use]
    pub fn bootstrap_response(&self, uri: &Uri) -> Response<BoxBody> {
        let supplied = uri
            .query()
            .and_then(|query| query.strip_prefix("nonce="))
            .filter(|nonce| !nonce.contains('&'));
        let valid = supplied.is_some_and(|nonce| {
            secrets_equal(nonce.as_bytes(), self.bootstrap_nonce.as_bytes())
                && self
                    .bootstrap_consumed
                    .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
                    .is_ok()
        });
        if !valid {
            return response::no_store(response::text(
                StatusCode::FORBIDDEN,
                "invalid or expired desktop bootstrap nonce",
            ));
        }

        let mut redirect = Response::new(response::empty());
        *redirect.status_mut() = StatusCode::SEE_OTHER;
        redirect
            .headers_mut()
            .insert(LOCATION, HeaderValue::from_static("/"));
        redirect.headers_mut().insert(
            SET_COOKIE,
            HeaderValue::from_str(&format!(
                "{DESKTOP_SESSION_COOKIE}={}; HttpOnly; SameSite=Strict; Path=/",
                self.session_token
            ))
            .expect("validated desktop session token is a valid cookie value"),
        );
        redirect
            .headers_mut()
            .insert(CACHE_CONTROL, HeaderValue::from_static("no-store"));
        redirect.headers_mut().insert(
            http::header::REFERRER_POLICY,
            HeaderValue::from_static("no-referrer"),
        );
        redirect
    }
}

impl fmt::Debug for DesktopSessionAuth {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("DesktopSessionAuth")
            .field("authority", &self.authority)
            .field(
                "bootstrap_consumed",
                &self.bootstrap_consumed.load(Ordering::Acquire),
            )
            .finish_non_exhaustive()
    }
}

fn secrets_equal(left: &[u8], right: &[u8]) -> bool {
    if left.len() != right.len() {
        return false;
    }
    left.iter()
        .zip(right)
        .fold(0_u8, |difference, (left, right)| {
            difference | (left ^ right)
        })
        == 0
}

#[cfg(test)]
mod tests {
    use super::*;

    const NONCE: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const TOKEN: &str = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

    #[test]
    fn constructor_only_accepts_ephemeral_ipv4_loopback_authorities() {
        assert!(DesktopSessionAuth::new("127.0.0.1:49152", NONCE.into(), TOKEN.into()).is_ok());
        for authority in [
            "localhost:49152",
            "0.0.0.0:49152",
            "127.0.0.1:0",
            "127.0.0.1",
        ] {
            assert!(
                DesktopSessionAuth::new(authority, NONCE.into(), TOKEN.into()).is_err(),
                "{authority}"
            );
        }
    }

    #[test]
    fn debug_output_never_contains_credentials() {
        let auth = DesktopSessionAuth::new("127.0.0.1:49152", NONCE.into(), TOKEN.into())
            .expect("valid auth");
        let debug = format!("{auth:?}");
        assert!(!debug.contains(NONCE));
        assert!(!debug.contains(TOKEN));
    }

    #[test]
    fn duplicate_origin_headers_are_never_allowed() {
        let auth = DesktopSessionAuth::new("127.0.0.1:49152", NONCE.into(), TOKEN.into())
            .expect("valid auth");
        let mut headers = HeaderMap::new();
        headers.append(ORIGIN, HeaderValue::from_static("http://127.0.0.1:49152"));
        assert!(auth.has_allowed_origin(&headers));

        headers.append(ORIGIN, HeaderValue::from_static("https://attacker.invalid"));
        assert!(!auth.has_allowed_origin(&headers));
    }
}
