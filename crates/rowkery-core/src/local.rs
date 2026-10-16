//! "Found on this Mac": Postgres servers answering on loopback. Only looks
//! (a TCP connect, nothing sent); connecting is the user's choice.

use std::net::{SocketAddr, TcpStream};
use std::thread;
use std::time::Duration;

use serde::Serialize;

/// The ports a local Postgres usually listens on: the default, a second
/// install, and this repo's Docker test server.
pub const LOCAL_PORTS: [u16; 3] = [5432, 5433, 54329];

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct LocalServer {
    pub port: u16,
    /// The OS user, which a local Postgres usually has a role and a
    /// database for (libpq's defaults).
    pub user: String,
}

/// Ports among `ports` that accept a connection on 127.0.0.1 within
/// `timeout`, in the given order. All are tried at once.
pub fn answering_ports(ports: &[u16], timeout: Duration) -> Vec<u16> {
    let probes: Vec<_> = ports
        .iter()
        .map(|&port| {
            thread::spawn(move || {
                let addr = SocketAddr::from(([127, 0, 0, 1], port));
                TcpStream::connect_timeout(&addr, timeout).is_ok()
            })
        })
        .collect();
    ports
        .iter()
        .zip(probes)
        .filter_map(|(&port, probe)| probe.join().unwrap_or(false).then_some(port))
        .collect()
}

/// The login name libpq would use (`USER`, or `USERNAME` on Windows).
pub fn os_user() -> String {
    std::env::var("USER")
        .or_else(|_| std::env::var("USERNAME"))
        .unwrap_or_else(|_| "postgres".into())
}

/// Local servers answering on the usual ports (300 ms each, in parallel).
pub fn local_servers() -> Vec<LocalServer> {
    let user = os_user();
    answering_ports(&LOCAL_PORTS, Duration::from_millis(300))
        .into_iter()
        .map(|port| LocalServer {
            port,
            user: user.clone(),
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::TcpListener;

    #[test]
    fn only_listening_ports_answer() {
        let open = TcpListener::bind("127.0.0.1:0").unwrap();
        let open_port = open.local_addr().unwrap().port();
        // A port that was free a moment ago: bind, read, drop.
        let closed_port = {
            let l = TcpListener::bind("127.0.0.1:0").unwrap();
            l.local_addr().unwrap().port()
        };
        let found = answering_ports(&[closed_port, open_port], Duration::from_millis(300));
        assert_eq!(found, vec![open_port]);
    }
}
