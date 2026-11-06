//! Audio output (CoreAudio through cpal), which is also the playback
//! clock: media time is the seek position plus the samples the device has
//! actually consumed. When audio runs dry the clock stops with it, so the
//! picture waits instead of drifting.

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use anyhow::{anyhow, Result};
use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use ringbuf::traits::{Consumer, Observer, Producer, Split};
use ringbuf::{HeapCons, HeapProd, HeapRb};

/// Decoded audio held ahead of the device.
const RING_SECONDS: usize = 3;

pub struct Shared {
    pub rate: u32,
    /// Stereo frames the device consumed since the last seek.
    played: AtomicU64,
    /// Output real audio (otherwise silence, and the clock holds).
    playing: AtomicBool,
    flush: AtomicBool,
    /// The device asked for more than was buffered while playing.
    underrun: AtomicBool,
    generation: AtomicU64,
    producer: Mutex<HeapProd<f32>>,
}

pub struct AudioOut {
    _stream: cpal::Stream,
    pub shared: Arc<Shared>,
}

impl AudioOut {
    pub fn open(muted: bool) -> Result<Self> {
        let host = cpal::default_host();
        let device = host.default_output_device().ok_or_else(|| anyhow!("no audio output device"))?;
        let supported = device.default_output_config()?;
        let channels = supported.channels() as usize;
        let rate = supported.sample_rate();
        let config = cpal::StreamConfig {
            channels: supported.channels(),
            sample_rate: rate,
            buffer_size: cpal::BufferSize::Default,
        };
        let ring = HeapRb::<f32>::new(rate as usize * 2 * RING_SECONDS);
        let (producer, mut consumer): (HeapProd<f32>, HeapCons<f32>) = ring.split();
        let shared = Arc::new(Shared {
            rate,
            played: AtomicU64::new(0),
            playing: AtomicBool::new(false),
            flush: AtomicBool::new(false),
            underrun: AtomicBool::new(false),
            generation: AtomicU64::new(0),
            producer: Mutex::new(producer),
        });
        let state = shared.clone();
        let mut stereo: Vec<f32> = Vec::new();
        let stream = device.build_output_stream::<f32, _, _>(
            config,
            move |data: &mut [f32], _| {
                if state.flush.swap(false, Ordering::AcqRel) {
                    consumer.clear();
                }
                if !state.playing.load(Ordering::Acquire) {
                    data.fill(0.0);
                    return;
                }
                let frames = data.len() / channels;
                stereo.resize(frames * 2, 0.0);
                let got = consumer.pop_slice(&mut stereo[..frames * 2]);
                if got < frames * 2 {
                    state.underrun.store(true, Ordering::Release);
                    stereo[got..].fill(0.0);
                }
                if muted {
                    stereo.fill(0.0);
                }
                for (out, pair) in data.chunks_exact_mut(channels).zip(stereo.chunks_exact(2)) {
                    if channels == 1 {
                        out[0] = (pair[0] + pair[1]) * 0.5;
                    } else {
                        out[0] = pair[0];
                        out[1] = pair[1];
                        out[2..].fill(0.0);
                    }
                }
                state.played.fetch_add((got / 2) as u64, Ordering::AcqRel);
            },
            |error| eprintln!("cubo-player: audio output error: {error}"),
            None,
        )?;
        stream.play()?;
        Ok(Self { _stream: stream, shared })
    }
}

impl Shared {
    /// Seconds of media the device has played since the last reset.
    pub fn played_seconds(&self) -> f64 {
        self.played.load(Ordering::Acquire) as f64 / self.rate as f64
    }

    pub fn buffered_seconds(&self) -> f64 {
        self.producer.lock().unwrap().occupied_len() as f64 / 2.0 / self.rate as f64
    }

    pub fn set_playing(&self, playing: bool) {
        self.playing.store(playing, Ordering::Release);
    }

    pub fn take_underrun(&self) -> bool {
        self.underrun.swap(false, Ordering::AcqRel)
    }

    /// Drops buffered audio and restarts the clock (a seek). Feeders from
    /// before the reset stop at their next block.
    pub fn reset(&self) {
        self.playing.store(false, Ordering::Release);
        self.generation.fetch_add(1, Ordering::AcqRel);
        // A stale feeder checks the generation before every push; give one
        // mid-push time to finish so its block is flushed too.
        std::thread::sleep(Duration::from_millis(10));
        self.flush.store(true, Ordering::Release);
        // The device callback performs the flush; wait for it (a few ms).
        for _ in 0..100 {
            if !self.flush.load(Ordering::Acquire) {
                break;
            }
            std::thread::sleep(Duration::from_millis(2));
        }
        self.played.store(0, Ordering::Release);
        self.underrun.store(false, Ordering::Release);
    }

    /// A sink for the decoder: pushes blocks, waiting while the ring is
    /// full; returns false once a reset made this feeder stale.
    pub fn feeder(self: &Arc<Self>) -> impl FnMut(&[f32]) -> bool + Send + 'static {
        let shared = self.clone();
        let generation = shared.generation.load(Ordering::Acquire);
        move |mut samples: &[f32]| loop {
            if shared.generation.load(Ordering::Acquire) != generation {
                return false;
            }
            let pushed = shared.producer.lock().unwrap().push_slice(samples);
            samples = &samples[pushed..];
            if samples.is_empty() {
                return true;
            }
            std::thread::sleep(Duration::from_millis(5));
        }
    }
}
