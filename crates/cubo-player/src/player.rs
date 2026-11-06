//! Playback: decoders, the audio clock, buffering and the frame choice.
//!
//! The player starts (and after a stall resumes) once it holds a little
//! decoded audio and video; everything else waits in the byte cache. A stall
//! is any wait for data that the viewer did not cause (a seek or a pause).

use std::collections::VecDeque;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Instant;

use crossbeam_channel::{Receiver, TryRecvError};

use crate::audio::AudioOut;
use crate::bench::Bench;
use crate::cache::Cache;
use crate::decode::{self, Decoder, Frame, MediaInfo};

const VIDEO_READY_FRAMES: usize = 6;
const AUDIO_READY_SECONDS: f64 = 0.6;
const PENDING_FRAMES: usize = 10;

#[derive(Debug, Clone, Copy, PartialEq)]
enum State {
    /// Waiting for data. `stall` is false for waits the viewer caused.
    Buffering { stall: bool },
    Playing,
    Paused,
    Ended,
}

pub struct Player {
    ffmpeg: PathBuf,
    url: String,
    pub info: MediaInfo,
    pub duration: f64,
    audio_stream: Option<u32>,
    audio: Option<AudioOut>,
    pub cache: Arc<Cache>,
    base: f64,
    video: Option<(Decoder, Receiver<Frame>)>,
    audio_decoder: Option<Decoder>,
    audio_done: Arc<AtomicBool>,
    pending: VecDeque<Frame>,
    video_ended: bool,
    state: State,
    shown_pts: Option<f64>,
    /// Clock without audio: media time at an instant.
    wall: Option<(Instant, f64)>,
    frozen_clock: f64,
    pub bench: Arc<Bench>,
}

impl Player {
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        ffmpeg: PathBuf,
        url: String,
        info: MediaInfo,
        duration: f64,
        audio_stream: Option<u32>,
        cache: Arc<Cache>,
        start: f64,
        bench: Arc<Bench>,
        muted: bool,
    ) -> Self {
        let audio = match audio_stream {
            Some(_) => match AudioOut::open(muted) {
                Ok(audio) => Some(audio),
                Err(error) => {
                    eprintln!("cubo-player: no audio output ({error}); playing silent");
                    None
                }
            },
            None => None,
        };
        let mut player = Self {
            ffmpeg,
            url,
            info,
            duration,
            audio_stream,
            audio,
            cache,
            base: start,
            video: None,
            audio_decoder: None,
            audio_done: Arc::new(AtomicBool::new(false)),
            pending: VecDeque::new(),
            video_ended: false,
            state: State::Buffering { stall: false },
            shown_pts: None,
            wall: None,
            frozen_clock: start,
            bench,
        };
        player.seek(start);
        player
    }

    pub fn clock(&self) -> f64 {
        match (&self.audio, self.state) {
            (Some(audio), _) => self.base + audio.shared.played_seconds(),
            (None, State::Playing) => self.wall.map_or(self.frozen_clock, |(at, media)| media + at.elapsed().as_secs_f64()),
            (None, _) => self.frozen_clock,
        }
    }

    pub fn is_playing(&self) -> bool {
        self.state == State::Playing
    }

    pub fn is_stalled(&self) -> bool {
        self.state == (State::Buffering { stall: true })
    }

    pub fn seek(&mut self, target: f64) {
        let target = target.clamp(0.0, (self.duration - 1.0).max(0.0));
        let resume_paused = self.state == State::Paused;
        if let State::Buffering { stall: true } = self.state {
            self.bench.stall_ended();
        }
        self.video = None;
        self.audio_decoder = None;
        if let Some(audio) = &self.audio {
            audio.shared.reset();
        }
        self.pending.clear();
        self.video_ended = false;
        self.shown_pts = None;
        self.base = target;
        self.frozen_clock = target;
        self.wall = None;
        match decode::video(&self.ffmpeg, &self.url, target, &self.info) {
            Ok(video) => self.video = Some(video),
            Err(error) => eprintln!("cubo-player: {error:#}"),
        }
        self.audio_done = Arc::new(AtomicBool::new(false));
        if let (Some(stream), Some(audio)) = (self.audio_stream, &self.audio) {
            match decode::audio(
                &self.ffmpeg,
                &self.url,
                target,
                stream,
                audio.shared.rate,
                audio.shared.feeder(),
                self.audio_done.clone(),
            ) {
                Ok(decoder) => self.audio_decoder = Some(decoder),
                Err(error) => eprintln!("cubo-player: {error:#}"),
            }
        }
        self.state = if resume_paused { State::Paused } else { State::Buffering { stall: false } };
    }

    pub fn toggle_pause(&mut self) {
        match self.state {
            State::Paused => self.state = State::Buffering { stall: false },
            State::Ended => self.seek(0.0),
            _ => {
                self.frozen_clock = self.clock();
                if let State::Buffering { stall: true } = self.state {
                    self.bench.stall_ended();
                }
                self.state = State::Paused;
                if let Some(audio) = &self.audio {
                    audio.shared.set_playing(false);
                }
            }
        }
    }

    fn enter_stall(&mut self) {
        self.frozen_clock = self.clock();
        self.state = State::Buffering { stall: true };
        if let Some(audio) = &self.audio {
            audio.shared.set_playing(false);
        }
        self.bench.stall_started(self.frozen_clock);
    }

    /// Advances playback; returns a frame to show, if the picture changes.
    pub fn tick(&mut self) -> Option<Frame> {
        if let Some((_, frames)) = &self.video {
            while self.pending.len() < PENDING_FRAMES {
                match frames.try_recv() {
                    Ok(frame) => {
                        if self.shown_pts.is_none() && self.pending.is_empty() {
                            eprintln!(
                                "cubo-player: first frame decoded after {} ms",
                                self.bench.started_at.elapsed().as_millis()
                            );
                        }
                        self.pending.push_back(frame)
                    }
                    Err(TryRecvError::Empty) => break,
                    Err(TryRecvError::Disconnected) => {
                        self.video_ended = true;
                        break;
                    }
                }
            }
        }
        let audio_done = self.audio_done.load(Ordering::Relaxed);
        let audio_buffered = self.audio.as_ref().map_or(f64::INFINITY, |audio| audio.shared.buffered_seconds());

        match self.state {
            State::Buffering { stall } => {
                let video_ready = self.pending.len() >= VIDEO_READY_FRAMES || self.video_ended;
                let audio_ready = audio_buffered >= AUDIO_READY_SECONDS || audio_done || self.audio_decoder.is_none();
                if video_ready && audio_ready {
                    if stall {
                        self.bench.stall_ended();
                    }
                    self.state = State::Playing;
                    self.bench.playing();
                    self.wall = Some((Instant::now(), self.frozen_clock));
                    if let Some(audio) = &self.audio {
                        audio.shared.set_playing(true);
                    }
                }
            }
            State::Playing => {
                let clock = self.clock();
                let audio_dry = self.audio.as_ref().is_some_and(|audio| audio.shared.take_underrun()) && !audio_done;
                let video_dry = self.pending.is_empty()
                    && !self.video_ended
                    && self.shown_pts.is_some_and(|shown| clock > shown + 2.5 / self.info.fps);
                if self.video_ended && self.pending.is_empty() && (audio_done || self.audio_decoder.is_none() || audio_buffered <= 0.0) {
                    self.frozen_clock = clock;
                    self.state = State::Ended;
                    if let Some(audio) = &self.audio {
                        audio.shared.set_playing(false);
                    }
                } else if audio_dry || video_dry {
                    self.enter_stall();
                }
            }
            State::Paused | State::Ended => {}
        }

        let clock = self.clock();
        let mut show = None;
        while self.pending.len() >= 2 && self.pending[1].pts <= clock {
            self.pending.pop_front();
        }
        if let Some(front) = self.pending.front() {
            let first_after_seek = self.shown_pts.is_none();
            if first_after_seek || front.pts <= clock + 0.5 / self.info.fps {
                let frame = self.pending.pop_front().unwrap();
                self.shown_pts = Some(frame.pts);
                show = Some(frame);
            }
        }
        show
    }
}
