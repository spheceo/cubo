//! Cubo Player: plays a Cubo Core source natively.
//!
//! Core serves the original file untouched (a `native` session); the player
//! caches it ahead as fast as the link allows, decodes it in ffmpeg sidecars
//! (VideoToolbox where the Mac's hardware takes the stream) and presents it
//! with Metal and CoreAudio. Nothing is remuxed or re-encoded on the Core.
//!
//! Started from the web app through a `cubo-player://play?…` link, or from
//! the command line (`--core … --magnet …`, or `--url …` for a plain file).

mod audio;
mod bench;
mod cache;
mod core;
mod decode;
mod launch;
mod player;
mod render;
mod server;

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use anyhow::{anyhow, Context, Result};
use clap::Parser;
use serde_json::{json, Value};
use winit::application::ApplicationHandler;
use winit::dpi::{LogicalSize, PhysicalPosition};
use winit::event::{ElementState, MouseButton, StartCause, WindowEvent};
use winit::event_loop::{ActiveEventLoop, ControlFlow, EventLoop};
use winit::keyboard::{Key, NamedKey};
use winit::window::{Fullscreen, Window, WindowId};

use crate::bench::Bench;
use crate::cache::Cache;
use crate::core::{CoreClient, SessionRequest};
use crate::launch::PlaySpec;
use crate::player::Player;
use crate::render::{Osd, Renderer, COVERAGE_BUCKETS};

#[derive(Parser, Debug)]
#[command(name = "cubo-player", about = "Play a Cubo Core source natively")]
struct Args {
    /// A `cubo-player://play?…` link.
    link: Option<String>,
    /// Cubo Core to play from, e.g. http://kenobi:8765
    #[arg(long)]
    core: Option<String>,
    /// Core session token (read from /v1/health when omitted).
    #[arg(long)]
    token: Option<String>,
    /// Magnet of the source to open on the Core.
    #[arg(long)]
    magnet: Option<String>,
    #[arg(long)]
    file_index: Option<usize>,
    #[arg(long)]
    media_key: Option<String>,
    #[arg(long)]
    title: Option<String>,
    #[arg(long)]
    audio_language: Option<String>,
    /// Play a plain HTTP(S) file instead of a Core session.
    #[arg(long)]
    url: Option<String>,
    /// Start position in seconds.
    #[arg(long, default_value_t = 0.0)]
    start: f64,
    /// HTTP proxy for every request to the Core (benchmarks).
    #[arg(long)]
    proxy: Option<String>,
    #[arg(long)]
    fullscreen: bool,
    /// Play without sound (the audio clock still runs).
    #[arg(long)]
    mute: bool,
    /// Quit after this many seconds and write benchmark JSON.
    #[arg(long)]
    bench_seconds: Option<f64>,
    #[arg(long)]
    bench_out: Option<PathBuf>,
    #[arg(long, default_value = "native")]
    bench_label: String,
    #[arg(long)]
    bench_core_pid: Option<u32>,
    #[arg(long, default_value_t = 10.0)]
    bench_link_mbps: f64,
    /// Write what the window shows to this PPM file once, `--snapshot-at`
    /// seconds after launch (diagnostics).
    #[arg(long)]
    snapshot: Option<PathBuf>,
    #[arg(long, default_value_t = 10.0)]
    snapshot_at: f64,
}

impl Args {
    fn spec(&self) -> Result<Option<PlaySpec>> {
        if let Some(link) = &self.link {
            return PlaySpec::from_link(link).map(Some);
        }
        if self.core.is_none() && self.url.is_none() {
            return Ok(None);
        }
        Ok(Some(PlaySpec {
            core: self.core.clone(),
            token: self.token.clone(),
            magnet: self.magnet.clone(),
            file_index: self.file_index,
            media_key: self.media_key.clone(),
            title: self.title.clone(),
            audio_language: self.audio_language.clone(),
            url: self.url.clone(),
            start: self.start,
            progress: None,
        }))
    }
}

/// One title playing: the player and its Core session.
struct Playback {
    title: String,
    start: f64,
    player: Player,
    session: Option<(CoreClient, String)>,
    progress: Option<Value>,
    stop: Arc<AtomicBool>,
}

enum UserEvent {
    Link(String),
}

struct App {
    args: Args,
    playback: Option<Playback>,
    window: Option<Arc<Window>>,
    renderer: Option<Renderer>,
    osd_until: Instant,
    cursor: PhysicalPosition<f64>,
    last_click: Option<Instant>,
    last_title: Instant,
    last_coverage: Instant,
    started_at: Instant,
}

fn main() {
    if let Err(error) = run() {
        eprintln!("cubo-player: {error:#}");
        std::process::exit(1);
    }
}

fn run() -> Result<()> {
    let started_at = Instant::now();
    let args = Args::parse();
    let event_loop = EventLoop::<UserEvent>::with_user_event().build()?;
    event_loop.set_control_flow(ControlFlow::Wait);
    #[cfg(target_os = "macos")]
    {
        let proxy = event_loop.create_proxy();
        launch::macos::install(move |link| {
            let _ = proxy.send_event(UserEvent::Link(link));
        });
    }
    let first = args.spec()?;
    let mut app = App {
        args,
        playback: None,
        window: None,
        renderer: None,
        osd_until: Instant::now() + Duration::from_secs(3),
        cursor: PhysicalPosition::new(0.0, 0.0),
        last_click: None,
        last_title: Instant::now() - Duration::from_secs(5),
        last_coverage: Instant::now() - Duration::from_secs(5),
        started_at,
    };
    if let Some(spec) = first {
        app.playback = Some(open(&spec, &app.args, started_at)?);
    }
    event_loop.run_app(&mut app)?;
    app.finish();
    Ok(())
}

/// Opens the source and starts decoding (the window comes separately).
fn open(spec: &PlaySpec, args: &Args, started_at: Instant) -> Result<Playback> {
    let agent = core::agent(args.proxy.as_deref())?;
    let ffmpeg = decode::find_tool("ffmpeg").ok_or_else(|| anyhow!("ffmpeg not found (install Cubo or Homebrew ffmpeg)"))?;
    let ffprobe = decode::find_tool("ffprobe").ok_or_else(|| anyhow!("ffprobe not found"))?;

    let (stream_url, session, session_duration, audio_index, file_name) = match (&spec.core, &spec.url) {
        (Some(base), _) => {
            let magnet = spec.magnet.clone().ok_or_else(|| anyhow!("a Core source needs a magnet"))?;
            let core = CoreClient::connect(base, spec.token.clone(), agent.clone())?;
            let info = core.open_session(&SessionRequest {
                magnet,
                file_index: spec.file_index,
                media_key: spec.media_key.clone(),
                title: spec.title.clone(),
                resume_seconds: Some(spec.start),
                audio_language: spec.audio_language.clone(),
            })?;
            eprintln!("cubo-player: session {} ready after {} ms", info.id, started_at.elapsed().as_millis());
            let url = core.stream_url(&info.id);
            (url, Some((core, info.id)), info.duration, info.audio_index, info.file_name)
        }
        (None, Some(url)) => (url.clone(), None, None, None, url.rsplit('/').next().map(str::to_string)),
        (None, None) => return Err(anyhow!("nothing to play: pass --core with --magnet, or --url")),
    };
    let file_name = file_name.unwrap_or_else(|| "video".into());
    let extension = file_name
        .rsplit_once('.')
        .map(|(_, ext)| ext.to_ascii_lowercase())
        .filter(|ext| ext.len() <= 4)
        .unwrap_or_else(|| "mkv".into());

    let cache_dir = std::env::var_os("HOME")
        .map(|home| PathBuf::from(home).join("Library/Caches/Cubo Player"))
        .unwrap_or_else(std::env::temp_dir);
    let cache = Cache::open(&stream_url, agent, &cache_dir)?;
    cache.start();
    let media_url = server::serve(cache.clone(), &extension)?;
    eprintln!("cubo-player: cache open after {} ms", started_at.elapsed().as_millis());
    let info = decode::probe(&ffprobe, &media_url).context("could not read the file")?;
    eprintln!("cubo-player: probed after {} ms", started_at.elapsed().as_millis());
    let duration = session_duration.or(info.duration).ok_or_else(|| anyhow!("the file has no duration"))?;
    eprintln!(
        "cubo-player: {} {}x{} @ {:.3} fps{}, {:.0} s, {:.0} MB",
        info.video_codec,
        info.width,
        info.height,
        info.fps,
        if info.interlaced { " interlaced" } else { "" },
        duration,
        cache.size as f64 / 1e6
    );
    let audio_stream = audio_index.or(info.first_audio);

    let bench = Bench::new(started_at, args.bench_seconds.is_some());
    bench.start_sampler(cache.clone(), duration, args.bench_core_pid);
    let player = Player::new(ffmpeg, media_url, info, duration, audio_stream, cache, spec.start, bench, args.mute);

    let stop = Arc::new(AtomicBool::new(false));
    if let Some((core, id)) = &session {
        report(core.clone(), id.clone(), player.bench.clone(), spec.progress.clone(), duration, stop.clone());
    }
    Ok(Playback {
        title: spec.title.clone().unwrap_or(file_name),
        start: spec.start,
        player,
        session,
        progress: spec.progress.clone(),
        stop,
    })
}

fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|now| now.as_millis() as u64).unwrap_or(0)
}

/// The web player's progress update, from the template the web app sent.
fn progress_update(template: &Value, position: f64, duration: f64, watched: f64, session: f64, started: bool) -> Value {
    let mut update = template.clone();
    if let Some(fields) = update.as_object_mut() {
        fields.insert("positionSeconds".into(), json!(position));
        fields.insert("durationSeconds".into(), json!(duration));
        fields.insert("progressUpdatedAt".into(), json!(now_ms()));
        fields.insert("watchedDeltaSeconds".into(), json!(watched));
        fields.insert("sessionWatchSeconds".into(), json!(session));
        fields.insert("sessionStarted".into(), json!(started));
    }
    update
}

/// Heartbeats keep Core's session (and the torrent) live; progress goes to
/// the library every 10 s while playing, as from the web player.
fn report(core: CoreClient, id: String, bench: Arc<Bench>, progress: Option<Value>, duration: f64, stop: Arc<AtomicBool>) {
    std::thread::spawn(move || {
        let mut last_position = bench.position();
        let mut watched = 0.0;
        let mut session_watched = 0.0;
        let mut started = true;
        let mut tick = 0u64;
        while !stop.load(Ordering::Relaxed) {
            std::thread::sleep(Duration::from_secs(1));
            tick += 1;
            let position = bench.position();
            let delta = position - last_position;
            last_position = position;
            let playing = bench.playing.load(Ordering::Relaxed);
            if playing && (0.0..5.0).contains(&delta) {
                watched += delta;
                session_watched += delta;
            }
            if tick.is_multiple_of(5) && core.heartbeat(&id, position, playing).is_err() {
                eprintln!("cubo-player: heartbeat failed");
            }
            if let Some(template) = &progress {
                if (started && playing) || (!started && tick.is_multiple_of(10)) {
                    let update = progress_update(template, position, duration, watched, session_watched, started);
                    if core.record_progress(update).is_ok() {
                        watched = 0.0;
                        started = false;
                    }
                }
            }
        }
    });
}

impl Playback {
    fn close(self, args: &Args) {
        self.stop.store(true, Ordering::Relaxed);
        let position = self.player.clock();
        if let (Some(out), true) = (&args.bench_out, self.player.bench.enabled) {
            let downloaded = self.player.cache.downloaded.load(Ordering::Relaxed);
            self.player.bench.write(
                out,
                &args.bench_label,
                self.start,
                args.bench_link_mbps,
                downloaded,
                env!("CARGO_PKG_VERSION"),
            );
        }
        if let Some((core, id)) = &self.session {
            if let Some(template) = &self.progress {
                let _ = core.record_progress(progress_update(template, position, self.player.duration, 0.0, 0.0, false));
            }
            core.close(id);
        }
        self.player.cache.close();
    }
}

impl App {
    fn finish(&mut self) {
        if let Some(playback) = self.playback.take() {
            playback.close(&self.args);
        }
    }

    fn show_osd(&mut self) {
        self.osd_until = Instant::now() + Duration::from_secs(3);
    }

    fn seek_by(&mut self, delta: f64) {
        if let Some(playback) = &mut self.playback {
            let target = playback.player.clock() + delta;
            playback.player.seek(target);
        }
        self.show_osd();
    }

    fn toggle_pause(&mut self) {
        if let Some(playback) = &mut self.playback {
            playback.player.toggle_pause();
        }
        self.show_osd();
    }

    fn toggle_fullscreen(&self) {
        if let Some(window) = &self.window {
            let next = match window.fullscreen() {
                Some(_) => None,
                None => Some(Fullscreen::Borderless(None)),
            };
            window.set_fullscreen(next);
        }
    }

    /// Opens the window for the current playback, or points the existing
    /// one at it.
    fn present(&mut self, event_loop: &ActiveEventLoop) {
        let Some(playback) = &self.playback else { return };
        let window = match &self.window {
            Some(window) => window.clone(),
            None => {
                let attributes = Window::default_attributes()
                    .with_title(&playback.title)
                    .with_inner_size(LogicalSize::new(1280.0, 720.0));
                match event_loop.create_window(attributes) {
                    Ok(window) => {
                        let window = Arc::new(window);
                        if self.args.fullscreen {
                            window.set_fullscreen(Some(Fullscreen::Borderless(None)));
                        }
                        self.window = Some(window.clone());
                        window
                    }
                    Err(error) => {
                        eprintln!("cubo-player: could not open a window: {error}");
                        event_loop.exit();
                        return;
                    }
                }
            }
        };
        let info = &playback.player.info;
        self.renderer = None;
        match Renderer::new(window.clone(), (info.width, info.height), info.aspect) {
            Ok(renderer) => self.renderer = Some(renderer),
            Err(error) => {
                eprintln!("cubo-player: could not start the renderer: {error:#}");
                event_loop.exit();
                return;
            }
        }
        window.focus_window();
        window.request_redraw();
    }

    fn redraw(&mut self, event_loop: &ActiveEventLoop) {
        let Some(playback) = &mut self.playback else { return };
        if let Some(frame) = playback.player.tick() {
            if let Some(renderer) = &mut self.renderer {
                renderer.upload(&frame.data);
            }
        }
        let player = &playback.player;
        let clock = player.clock();
        player.bench.set_position(clock);
        player.bench.playing.store(player.is_playing(), Ordering::Relaxed);
        if let Some(limit) = self.args.bench_seconds {
            if self.started_at.elapsed().as_secs_f64() >= limit {
                event_loop.exit();
                return;
            }
        }
        if self.last_coverage.elapsed() > Duration::from_millis(500) {
            self.last_coverage = Instant::now();
            if let Some(renderer) = &self.renderer {
                renderer.set_coverage(&player.cache.coverage(COVERAGE_BUCKETS));
            }
        }
        if self.last_title.elapsed() > Duration::from_secs(1) {
            self.last_title = Instant::now();
            if let Some(window) = &self.window {
                let state = if player.is_stalled() { " · buffering" } else { "" };
                window.set_title(&format!(
                    "{} — {} / {}{}",
                    playback.title,
                    clock_text(clock),
                    clock_text(player.duration),
                    state
                ));
            }
        }
        let remaining = self.osd_until.saturating_duration_since(Instant::now()).as_secs_f32();
        let osd = Osd {
            alpha: if !player.is_playing() { 1.0 } else { (remaining / 0.4).min(1.0) },
            played: (clock / player.duration) as f32,
        };
        if let Some(renderer) = &mut self.renderer {
            renderer.render(&osd);
            if let Some(path) = &self.args.snapshot {
                if self.started_at.elapsed().as_secs_f64() >= self.args.snapshot_at {
                    match renderer.snapshot(&osd, path) {
                        Ok(()) => eprintln!("cubo-player: snapshot at {clock:.2} s in {}", path.display()),
                        Err(error) => eprintln!("cubo-player: snapshot failed: {error:#}"),
                    }
                    self.args.snapshot = None;
                }
            }
        }
        if let Some(window) = &self.window {
            window.request_redraw();
        }
    }
}

fn clock_text(seconds: f64) -> String {
    let total = seconds.max(0.0) as u64;
    let (h, m, s) = (total / 3600, total / 60 % 60, total % 60);
    if h > 0 {
        format!("{h}:{m:02}:{s:02}")
    } else {
        format!("{m}:{s:02}")
    }
}

impl ApplicationHandler<UserEvent> for App {
    fn new_events(&mut self, event_loop: &ActiveEventLoop, cause: StartCause) {
        // Launched without a link and none arrived: nothing to do.
        if let StartCause::ResumeTimeReached { .. } = cause {
            if self.playback.is_none() {
                event_loop.exit();
            }
        }
    }

    fn resumed(&mut self, event_loop: &ActiveEventLoop) {
        if self.playback.is_some() {
            if self.window.is_none() {
                self.present(event_loop);
            }
        } else {
            event_loop.set_control_flow(ControlFlow::WaitUntil(self.started_at + Duration::from_secs(20)));
        }
    }

    fn user_event(&mut self, event_loop: &ActiveEventLoop, event: UserEvent) {
        let UserEvent::Link(link) = event;
        let spec = match PlaySpec::from_link(&link) {
            Ok(spec) => spec,
            Err(error) => {
                eprintln!("cubo-player: ignoring link: {error:#}");
                return;
            }
        };
        if let Some(previous) = self.playback.take() {
            previous.close(&self.args);
        }
        match open(&spec, &self.args, Instant::now()) {
            Ok(playback) => {
                self.playback = Some(playback);
                event_loop.set_control_flow(ControlFlow::Wait);
                self.present(event_loop);
            }
            Err(error) => {
                eprintln!("cubo-player: {error:#}");
                if self.window.is_none() {
                    event_loop.exit();
                }
            }
        }
    }

    fn window_event(&mut self, event_loop: &ActiveEventLoop, _id: WindowId, event: WindowEvent) {
        match event {
            WindowEvent::CloseRequested => event_loop.exit(),
            WindowEvent::Resized(size) => {
                let scale = self.window.as_ref().map_or(1.0, |window| window.scale_factor());
                if let Some(renderer) = &mut self.renderer {
                    renderer.resize(size.width, size.height, scale);
                }
            }
            WindowEvent::KeyboardInput { event, .. } if event.state == ElementState::Pressed => {
                match event.logical_key.as_ref() {
                    Key::Named(NamedKey::Space) => self.toggle_pause(),
                    Key::Named(NamedKey::ArrowLeft) => self.seek_by(-10.0),
                    Key::Named(NamedKey::ArrowRight) => self.seek_by(10.0),
                    Key::Named(NamedKey::ArrowDown) => self.seek_by(-60.0),
                    Key::Named(NamedKey::ArrowUp) => self.seek_by(60.0),
                    Key::Named(NamedKey::Escape) => {
                        if self.window.as_ref().is_some_and(|window| window.fullscreen().is_some()) {
                            self.toggle_fullscreen();
                        } else {
                            event_loop.exit();
                        }
                    }
                    Key::Character("f") => self.toggle_fullscreen(),
                    Key::Character("q") => event_loop.exit(),
                    _ => {}
                }
            }
            WindowEvent::CursorMoved { position, .. } => {
                self.cursor = position;
                self.show_osd();
            }
            WindowEvent::MouseInput { state: ElementState::Pressed, button: MouseButton::Left, .. } => {
                let Some(window) = &self.window else { return };
                let size = window.inner_size();
                let scale = window.scale_factor();
                let margin = 28.0 * scale;
                let bar_top = size.height as f64 - 50.0 * scale;
                if self.cursor.y >= bar_top && size.width as f64 > 2.0 * margin {
                    let fraction = ((self.cursor.x - margin) / (size.width as f64 - 2.0 * margin)).clamp(0.0, 1.0);
                    if let Some(playback) = &mut self.playback {
                        let target = fraction * playback.player.duration;
                        playback.player.seek(target);
                    }
                    self.show_osd();
                } else if self.last_click.is_some_and(|at| at.elapsed() < Duration::from_millis(350)) {
                    self.last_click = None;
                    // The first click of the pair paused: undo it.
                    self.toggle_pause();
                    self.toggle_fullscreen();
                } else {
                    self.last_click = Some(Instant::now());
                    self.toggle_pause();
                }
            }
            WindowEvent::RedrawRequested => self.redraw(event_loop),
            _ => {}
        }
    }
}
