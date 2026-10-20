//! The TLS half of the connector: the RSA key the client certificate is
//! issued for, and the check that the server is the instance asked for.

use std::sync::Arc;

use base64::engine::general_purpose::STANDARD;
use base64::Engine;
use rustls::client::danger::{HandshakeSignatureValid, ServerCertVerified, ServerCertVerifier};
use rustls::crypto::{verify_tls12_signature, verify_tls13_signature, CryptoProvider};
use rustls::pki_types::pem::PemObject;
use rustls::pki_types::{CertificateDer, PrivateKeyDer, PrivatePkcs8KeyDer, ServerName, UnixTime};
use rustls::{ClientConfig, DigitallySignedStruct, SignatureScheme};
use tokio::sync::OnceCell;

use super::CloudSqlError;

/// The DER bodies of `pem`'s blocks labelled `label`, for tests (the code
/// reads PEM with rustls' `PemObject`).
#[cfg(test)]
pub(crate) fn pem_blocks(pem: &str, label: &str) -> Vec<Vec<u8>> {
    let begin = format!("-----BEGIN {label}-----");
    let end = format!("-----END {label}-----");
    let mut out = Vec::new();
    let mut rest = pem;
    while let Some(start) = rest.find(&begin) {
        let body = &rest[start + begin.len()..];
        let Some(stop) = body.find(&end) else { break };
        let b64: String = body[..stop].split_whitespace().collect();
        if let Ok(der) = STANDARD.decode(b64) {
            out.push(der);
        }
        rest = &body[stop + end.len()..];
    }
    out
}

fn pem_encode(der: &[u8], label: &str) -> String {
    let b64 = STANDARD.encode(der);
    let mut pem = format!("-----BEGIN {label}-----\n");
    for line in b64.as_bytes().chunks(64) {
        pem.push_str(std::str::from_utf8(line).unwrap_or_default());
        pem.push('\n');
    }
    pem.push_str(&format!("-----END {label}-----\n"));
    pem
}

/// The key a client certificate is issued for: RSA 2048, made once per run
/// and kept in memory only (each certificate lasts an hour).
pub(crate) struct ClientKey {
    pkcs8: Vec<u8>,
    /// SubjectPublicKeyInfo in PEM, as `generateEphemeralCert` takes it.
    pub public_pem: String,
}

impl ClientKey {
    pub fn private_der(&self) -> PrivateKeyDer<'static> {
        PrivateKeyDer::Pkcs8(PrivatePkcs8KeyDer::from(self.pkcs8.clone()))
    }
}

fn generate_key() -> Result<ClientKey, CloudSqlError> {
    use rsa::pkcs8::{EncodePrivateKey, EncodePublicKey};
    let bad = |e: &dyn std::fmt::Display| {
        CloudSqlError::Instance(format!("Couldn't make the connection key: {e}"))
    };
    let mut rng = rand_core_010::UnwrapErr(getrandom::SysRng);
    let key = rsa::RsaPrivateKey::new(&mut rng, 2048).map_err(|e| bad(&e))?;
    let pkcs8 = key.to_pkcs8_der().map_err(|e| bad(&e))?.as_bytes().to_vec();
    let spki = key
        .to_public_key()
        .to_public_key_der()
        .map_err(|e| bad(&e))?;
    Ok(ClientKey {
        pkcs8,
        // The label the Admin API expects, though the body is an SPKI.
        public_pem: pem_encode(spki.as_bytes(), "RSA PUBLIC KEY"),
    })
}

/// The run's client key, made off the async workers on first use.
pub(crate) async fn client_key() -> Result<Arc<ClientKey>, CloudSqlError> {
    static KEY: OnceCell<Arc<ClientKey>> = OnceCell::const_new();
    KEY.get_or_try_init(|| async {
        tokio::task::spawn_blocking(generate_key)
            .await
            .map_err(|e| CloudSqlError::Instance(e.to_string()))?
            .map(Arc::new)
    })
    .await
    .cloned()
}

/// TLS to the instance: our client certificate, and its server certificate
/// checked against the instance's own CA (`ca_pem`). When `dns_names` has
/// any (instances on Google's shared CA) the certificate must also carry one
/// of them; an instance with a CA of its own is identified by the CA alone.
pub(crate) fn client_config(
    key: &ClientKey,
    cert_pem: &str,
    ca_pem: &str,
    dns_names: Vec<String>,
) -> Result<ClientConfig, CloudSqlError> {
    let bad = |what: &str| CloudSqlError::Instance(format!("The Admin API sent {what}"));
    let certs = certificates(cert_pem);
    if certs.is_empty() {
        return Err(bad("no client certificate"));
    }
    let cas = certificates(ca_pem);
    if cas.is_empty() {
        return Err(bad("no server CA"));
    }
    let provider = Arc::new(rustls::crypto::ring::default_provider());
    let verifier = InstanceVerifier {
        cas,
        dns_names,
        provider: provider.clone(),
    };
    ClientConfig::builder_with_provider(provider)
        .with_safe_default_protocol_versions()
        .map_err(|e| CloudSqlError::Instance(e.to_string()))?
        .dangerous()
        .with_custom_certificate_verifier(Arc::new(verifier))
        .with_client_auth_cert(certs, key.private_der())
        .map_err(|e| CloudSqlError::Instance(format!("Couldn't use the client certificate: {e}")))
}

fn certificates(pem: &str) -> Vec<CertificateDer<'static>> {
    CertificateDer::pem_slice_iter(pem.as_bytes())
        .filter_map(Result::ok)
        .collect()
}

#[derive(Debug)]
struct InstanceVerifier {
    cas: Vec<CertificateDer<'static>>,
    dns_names: Vec<String>,
    provider: Arc<CryptoProvider>,
}

impl ServerCertVerifier for InstanceVerifier {
    fn verify_server_cert(
        &self,
        end_entity: &CertificateDer<'_>,
        intermediates: &[CertificateDer<'_>],
        _server_name: &ServerName<'_>,
        _ocsp_response: &[u8],
        now: UnixTime,
    ) -> Result<ServerCertVerified, rustls::Error> {
        let invalid = |e: webpki::Error| {
            rustls::Error::InvalidCertificate(rustls::CertificateError::Other(rustls::OtherError(
                Arc::new(e),
            )))
        };
        let anchors = self
            .cas
            .iter()
            .map(webpki::anchor_from_trusted_cert)
            .collect::<Result<Vec<_>, _>>()
            .map_err(invalid)?;
        let cert = webpki::EndEntityCert::try_from(end_entity).map_err(invalid)?;
        cert.verify_for_usage(
            self.provider.signature_verification_algorithms.all,
            &anchors,
            intermediates,
            now,
            webpki::KeyUsage::server_auth(),
            None,
            None,
        )
        .map_err(invalid)?;
        if !self.dns_names.is_empty() {
            let named = self.dns_names.iter().any(|n| {
                ServerName::try_from(n.trim_end_matches('.'))
                    .is_ok_and(|name| cert.verify_is_valid_for_subject_name(&name).is_ok())
            });
            if !named {
                return Err(rustls::Error::InvalidCertificate(
                    rustls::CertificateError::NotValidForName,
                ));
            }
        }
        Ok(ServerCertVerified::assertion())
    }

    fn verify_tls12_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, rustls::Error> {
        verify_tls12_signature(
            message,
            cert,
            dss,
            &self.provider.signature_verification_algorithms,
        )
    }

    fn verify_tls13_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, rustls::Error> {
        verify_tls13_signature(
            message,
            cert,
            dss,
            &self.provider.signature_verification_algorithms,
        )
    }

    fn supported_verify_schemes(&self) -> Vec<SignatureScheme> {
        self.provider
            .signature_verification_algorithms
            .supported_schemes()
    }
}

/// A PKCS#8 RSA key in PEM, for tests (rcgen can't make RSA keys with ring).
#[cfg(test)]
pub(crate) fn test_rsa_pkcs8_pem() -> String {
    static PEM: std::sync::OnceLock<String> = std::sync::OnceLock::new();
    PEM.get_or_init(|| {
        let key = generate_key().unwrap();
        pem_encode(&key.pkcs8, "PRIVATE KEY")
    })
    .clone()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pem_round_trips() {
        let pem = format!(
            "junk\n{}{}",
            pem_encode(b"one", "CERTIFICATE"),
            pem_encode(&[7u8; 100], "CERTIFICATE")
        );
        assert_eq!(
            pem_blocks(&pem, "CERTIFICATE"),
            vec![b"one".to_vec(), vec![7u8; 100]]
        );
        assert!(pem_blocks(&pem, "PRIVATE KEY").is_empty());
    }

    #[test]
    fn the_public_key_is_an_spki_for_the_private_key() {
        use rsa::pkcs8::{DecodePrivateKey, DecodePublicKey};
        let key = generate_key().unwrap();
        let der = pem_blocks(&key.public_pem, "RSA PUBLIC KEY").remove(0);
        let public = rsa::RsaPublicKey::from_public_key_der(&der).unwrap();
        let private = rsa::RsaPrivateKey::from_pkcs8_der(&key.pkcs8).unwrap();
        assert_eq!(public, private.to_public_key());
    }
}
