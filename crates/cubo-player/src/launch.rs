//! What to play, from the command line or a `cubo-player://play?…` link
//! (the web app's "Play in Cubo Player"), and the macOS handler that
//! receives such links.

use anyhow::{anyhow, bail, Result};
use serde_json::Value;

#[derive(Debug, Clone, Default)]
pub struct PlaySpec {
    pub core: Option<String>,
    pub token: Option<String>,
    pub magnet: Option<String>,
    pub file_index: Option<usize>,
    pub media_key: Option<String>,
    pub title: Option<String>,
    pub audio_language: Option<String>,
    /// A plain HTTP(S) file instead of a Core session.
    pub url: Option<String>,
    pub start: f64,
    /// The web app's library entry for this title (everything but the
    /// position), so the player can save progress the way the web player
    /// does.
    pub progress: Option<Value>,
}

impl PlaySpec {
    /// Parses `cubo-player://play?core=…&magnet=…&…` (values URL-encoded;
    /// `progress` is base64url JSON).
    pub fn from_link(link: &str) -> Result<Self> {
        let rest = link
            .strip_prefix("cubo-player://play")
            .ok_or_else(|| anyhow!("not a Cubo Player link"))?;
        let query = rest.trim_start_matches('/').trim_start_matches('?');
        let mut spec = PlaySpec::default();
        for pair in query.split('&').filter(|pair| !pair.is_empty()) {
            let (key, value) = pair.split_once('=').unwrap_or((pair, ""));
            let value = urlencoding::decode(&value.replace('+', " "))?.into_owned();
            match key {
                "core" => spec.core = Some(value),
                "token" => spec.token = Some(value),
                "magnet" => spec.magnet = Some(value),
                "fileIndex" => spec.file_index = value.parse().ok(),
                "mediaKey" => spec.media_key = Some(value),
                "title" => spec.title = Some(value),
                "audioLanguage" => spec.audio_language = Some(value),
                "start" => spec.start = value.parse().unwrap_or(0.0),
                "progress" => spec.progress = decode_base64url(&value).and_then(|bytes| serde_json::from_slice(&bytes).ok()),
                _ => {}
            }
        }
        let Some(core) = &spec.core else { bail!("the link names no Core") };
        // Only plain web addresses: a link must not point the player at
        // local files or other schemes.
        if !(core.starts_with("http://") || core.starts_with("https://")) {
            bail!("the link's Core is not an http(s) address");
        }
        if spec.magnet.is_none() {
            bail!("the link names no source");
        }
        Ok(spec)
    }
}

fn decode_base64url(text: &str) -> Option<Vec<u8>> {
    let mut bits: u32 = 0;
    let mut count = 0;
    let mut out = Vec::with_capacity(text.len() * 3 / 4);
    for byte in text.bytes() {
        let value = match byte {
            b'A'..=b'Z' => byte - b'A',
            b'a'..=b'z' => byte - b'a' + 26,
            b'0'..=b'9' => byte - b'0' + 52,
            b'-' | b'+' => 62,
            b'_' | b'/' => 63,
            b'=' => break,
            _ => return None,
        };
        bits = (bits << 6) | value as u32;
        count += 6;
        if count >= 8 {
            count -= 8;
            out.push((bits >> count) as u8);
            bits &= (1 << count) - 1;
        }
    }
    Some(out)
}

#[cfg(target_os = "macos")]
pub mod macos {
    //! Links reach a running app as a `GetURL` Apple event, not argv.

    use std::sync::OnceLock;

    use objc2::rc::Retained;
    use objc2::runtime::NSObject;
    use objc2::{define_class, msg_send, sel, AllocAnyThread};
    use objc2_foundation::{NSAppleEventDescriptor, NSAppleEventManager};

    static SINK: OnceLock<Box<dyn Fn(String) + Send + Sync>> = OnceLock::new();

    const INTERNET_EVENT_CLASS: u32 = u32::from_be_bytes(*b"GURL");
    const GET_URL: u32 = u32::from_be_bytes(*b"GURL");
    const DIRECT_OBJECT: u32 = u32::from_be_bytes(*b"----");

    define_class!(
        #[unsafe(super(NSObject))]
        #[name = "CuboPlayerLinkHandler"]
        struct LinkHandler;

        impl LinkHandler {
            #[unsafe(method(handleGetURL:withReplyEvent:))]
            fn handle(&self, event: &NSAppleEventDescriptor, _reply: &NSAppleEventDescriptor) {
                let descriptor: Option<Retained<NSAppleEventDescriptor>> =
                    unsafe { msg_send![event, paramDescriptorForKeyword: DIRECT_OBJECT] };
                let link = descriptor
                    .and_then(|descriptor| descriptor.stringValue())
                    .map(|text| text.to_string());
                if let (Some(link), Some(sink)) = (link, SINK.get()) {
                    sink(link);
                }
            }
        }
    );

    /// Routes `cubo-player://` links to `sink`. Call before the event loop
    /// runs so the link that launched the app is not missed.
    pub fn install(sink: impl Fn(String) + Send + Sync + 'static) {
        if SINK.set(Box::new(sink)).is_err() {
            return;
        }
        let handler: Retained<LinkHandler> = unsafe { msg_send![LinkHandler::alloc(), init] };
        let manager = NSAppleEventManager::sharedAppleEventManager();
        unsafe {
            let _: () = msg_send![
                &manager,
                setEventHandler: &*handler,
                andSelector: sel!(handleGetURL:withReplyEvent:),
                forEventClass: INTERNET_EVENT_CLASS,
                andEventID: GET_URL
            ];
        }
        // The manager does not retain its handlers.
        std::mem::forget(handler);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_a_web_app_link() {
        let progress = "eyJrZXkiOiJ0djoxOjI6MyJ9"; // {"key":"tv:1:2:3"}
        let spec = PlaySpec::from_link(&format!(
            "cubo-player://play?core=http%3A%2F%2Fkenobi%3A8765&token=abc&magnet=magnet%3A%3Fxt%3Durn%3Abtih%3Aff&fileIndex=2&start=12.5&title=The+Traitors&progress={progress}"
        ))
        .unwrap();
        assert_eq!(spec.core.as_deref(), Some("http://kenobi:8765"));
        assert_eq!(spec.magnet.as_deref(), Some("magnet:?xt=urn:btih:ff"));
        assert_eq!(spec.file_index, Some(2));
        assert_eq!(spec.start, 12.5);
        assert_eq!(spec.title.as_deref(), Some("The Traitors"));
        assert_eq!(spec.progress.unwrap()["key"], "tv:1:2:3");
    }

    #[test]
    fn refuses_links_to_other_schemes() {
        assert!(PlaySpec::from_link("cubo-player://play?core=file%3A%2F%2F%2Fetc&magnet=m").is_err());
        assert!(PlaySpec::from_link("https://example.com").is_err());
    }
}
