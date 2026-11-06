//! Cubo Core's HTTP API, as much as the player needs: the session token,
//! a `native` playback session (the file served as it is), heartbeats that
//! keep the torrent live, and closing.

use std::time::{Duration, Instant};

use anyhow::{anyhow, bail, Context, Result};
use serde::Deserialize;
use serde_json::{json, Value};

pub fn agent(proxy: Option<&str>) -> Result<ureq::Agent> {
    let mut builder = ureq::AgentBuilder::new()
        .timeout_connect(Duration::from_secs(10))
        .timeout_read(Duration::from_secs(60));
    if let Some(proxy) = proxy {
        builder = builder.proxy(ureq::Proxy::new(proxy).context("invalid proxy")?);
    }
    Ok(builder.build())
}

#[derive(Clone)]
pub struct CoreClient {
    base: String,
    token: String,
    agent: ureq::Agent,
}

#[derive(Debug, Clone)]
pub struct SessionInfo {
    pub id: String,
    pub duration: Option<f64>,
    pub audio_index: Option<u32>,
    pub file_name: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Health {
    session_token: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Status {
    id: String,
    phase: String,
    #[serde(default)]
    error: Option<Value>,
    #[serde(default)]
    mode: Option<String>,
    #[serde(default)]
    duration_seconds: Option<f64>,
    #[serde(default)]
    audio_index: Option<u32>,
    #[serde(default)]
    file_name: Option<String>,
}

pub struct SessionRequest {
    pub magnet: String,
    pub file_index: Option<usize>,
    pub media_key: Option<String>,
    pub title: Option<String>,
    pub resume_seconds: Option<f64>,
    pub audio_language: Option<String>,
}

impl CoreClient {
    /// Connects to a Core and reads its session token, unless one is given.
    pub fn connect(base: &str, token: Option<String>, agent: ureq::Agent) -> Result<Self> {
        let base = base.trim_end_matches('/').to_string();
        let token = match token {
            Some(token) => token,
            None => {
                let health: Health = agent
                    .get(&format!("{base}/v1/health"))
                    .call()
                    .with_context(|| format!("could not reach Cubo Core at {base}"))?
                    .into_json()?;
                health
                    .session_token
                    .ok_or_else(|| anyhow!("this Core does not hand out its token; pass --token"))?
            }
        };
        Ok(Self { base, token, agent })
    }

    fn auth(&self) -> String {
        format!("Bearer {}", self.token)
    }

    /// Opens a native session and waits until Core has the source ready.
    pub fn open_session(&self, request: &SessionRequest) -> Result<SessionInfo> {
        let body = json!({
            "magnet": request.magnet,
            "fileIndex": request.file_index,
            "mediaKey": request.media_key,
            "title": request.title,
            "resumeSeconds": request.resume_seconds,
            "audioLanguage": request.audio_language,
            "native": true,
        });
        let created: Status = self
            .agent
            .post(&format!("{}/v1/sessions", self.base))
            .set("Authorization", &self.auth())
            .send_json(body)
            .map_err(describe)?
            .into_json()?;
        let deadline = Instant::now() + Duration::from_secs(180);
        let mut status = created;
        loop {
            match status.phase.as_str() {
                "ready" => break,
                "failed" | "closed" => bail!(
                    "Core could not open the source: {}",
                    status.error.map(|error| error.to_string()).unwrap_or_else(|| status.phase.clone())
                ),
                _ => {}
            }
            if Instant::now() > deadline {
                bail!("the source did not become ready in time");
            }
            std::thread::sleep(Duration::from_millis(250));
            status = self
                .agent
                .get(&format!("{}/v1/sessions/{}", self.base, status.id))
                .set("Authorization", &self.auth())
                .call()
                .map_err(describe)?
                .into_json()?;
        }
        if status.mode.as_deref() != Some("direct") {
            bail!("Core opened a {:?} session; this Core is too old for Cubo Player", status.mode);
        }
        Ok(SessionInfo {
            id: status.id,
            duration: status.duration_seconds,
            audio_index: status.audio_index,
            file_name: status.file_name,
        })
    }

    pub fn stream_url(&self, session: &str) -> String {
        format!(
            "{}/v1/sessions/{}/stream?token={}",
            self.base,
            session,
            urlencoding::encode(&self.token)
        )
    }

    pub fn heartbeat(&self, session: &str, position: f64, playing: bool) -> Result<()> {
        self.agent
            .post(&format!("{}/v1/sessions/{}/heartbeat", self.base, session))
            .set("Authorization", &self.auth())
            .send_json(json!({ "positionSeconds": position, "playing": playing }))
            .map_err(describe)?;
        Ok(())
    }

    /// Saves a library progress update (the web player's shape).
    pub fn record_progress(&self, update: Value) -> Result<()> {
        self.agent
            .post(&format!("{}/v1/library/progress", self.base))
            .set("Authorization", &self.auth())
            .send_json(update)
            .map_err(describe)?;
        Ok(())
    }

    pub fn close(&self, session: &str) {
        let _ = self
            .agent
            .delete(&format!("{}/v1/sessions/{}", self.base, session))
            .set("Authorization", &self.auth())
            .call();
    }
}

fn describe(error: ureq::Error) -> anyhow::Error {
    match error {
        ureq::Error::Status(code, response) => {
            let body = response.into_string().unwrap_or_default();
            anyhow!("Core answered {code}: {body}")
        }
        other => anyhow!(other),
    }
}
