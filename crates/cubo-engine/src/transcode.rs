//! ffprobe for playback sessions: which codecs a source carries, which audio
//! track to use, how long it runs and its chapters. The tight probe caps keep
//! cold-torrent startup fast; the remux itself lives in `remuxer.rs`.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tokio::process::Command;
use tokio::sync::Mutex;

const PROBE_TIMEOUT: Duration = Duration::from_secs(45);

/// A timeout is the only probe failure worth retrying: the swarm keeps
/// fetching while ffprobe stalls, so the second attempt lands on warm pieces.
enum ProbeError {
    TimedOut,
    Failed(String),
}

/// Codecs the remux path can pass through with `-c:v copy`. HEVC remuxes to
/// fMP4 with an `hvc1` tag; the client only routes HEVC here after detecting
/// decode support, so anything else (AV1, …) is still refused and the client
/// falls to the next source.
const COPYABLE_VIDEO: [&str; 2] = ["h264", "hevc"];
/// Audio codecs browsers decode natively; everything else becomes AAC.
const COPYABLE_AUDIO: [&str; 3] = ["aac", "mp3", "opus"];

#[derive(Debug, Clone)]
pub struct MediaProbe {
    pub video_codec: Option<String>,
    /// Codec of the audio stream the remux will actually use.
    pub audio_codec: Option<String>,
    /// Absolute index of the chosen audio stream, for `-map 0:N`. Releases
    /// with several audio tracks often list a dub first, so the remux must
    /// never blindly take `0:a:0`.
    pub audio_stream_index: Option<u32>,
    /// Every audio track in the file, in container order, so a session can
    /// honour the viewer's language choice and report what else is there.
    pub audio_tracks: Vec<AudioTrack>,
    pub duration_seconds: Option<f64>,
    /// ffprobe's container name list, e.g. `matroska,webm` or
    /// `mov,mp4,m4a,3gp,3g2,mj2`.
    pub format_name: Option<String>,
    /// Container chapters — named ones ("Intro", "Credits", "OP"/"ED") give
    /// exact, provider-independent skip windows.
    pub chapters: Vec<Chapter>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioTrack {
    /// Absolute stream index (`-map 0:N`).
    pub index: u32,
    pub codec: Option<String>,
    /// ISO 639-1 code when the tag is recognisable ("ger" → "de"), else the
    /// raw lowercase tag; `None` for untagged or `und` tracks.
    pub language: Option<String>,
    pub default: bool,
}

#[derive(Debug, Clone)]
pub struct Chapter {
    pub start_seconds: f64,
    pub end_seconds: f64,
    pub title: String,
}

#[derive(Debug, Clone, Copy)]
pub struct SkipSegment {
    pub start: f64,
    pub end: f64,
}

/// A chapter (or crowd-sourced equivalent) with its section type, for the
/// player's dev timeline overlay.
#[derive(Debug, Clone)]
pub struct SkipSection {
    pub start: f64,
    pub end: f64,
    pub kind: &'static str,
    pub label: String,
}

/// Classifies one chapter title into a section kind. `chapter` is the
/// catch-all for real but generic markers ("Scene 2", "Chapter 4") — the
/// dev overlay still shows them so label coverage is visible at a glance.
fn chapter_kind(title: &str) -> &'static str {
    let title = title.trim().to_ascii_lowercase();
    let tagged = |prefix: &str| {
        title.starts_with(prefix)
            && title[prefix.len()..]
                .chars()
                .all(|ch| ch.is_ascii_digit() || ch.is_whitespace())
    };
    if title.contains("intro")
        || title.contains("opening")
        || tagged("op")
        || title.contains("title sequence")
        || title.contains("main title")
    {
        return "intro";
    }
    if title.contains("recap") || title.contains("previously") || title.contains("last time") {
        return "recap";
    }
    if title.contains("post credit")
        || title.contains("post-credit")
        || title.contains("postcredit")
        || title.contains("mid credit")
        || title.contains("mid-credit")
        || title.contains("after credit")
        || title.contains("stinger")
    {
        return "postcredits";
    }
    if title.contains("credits")
        || title.contains("ending")
        || tagged("ed")
        || title.contains("outro")
        || title.contains("closing")
    {
        return "credits";
    }
    if title.contains("preview")
        || title.contains("next time")
        || title.contains("coming up")
        || title.contains("next on")
    {
        return "preview";
    }
    "chapter"
}

/// Every chapter as a typed section, keeping the container's own labels.
/// Unlike `chapter_skip_segments` there are no position bounds — the dev
/// overlay should show what the file actually declares, mislabeled or not.
pub fn chapter_sections(chapters: &[Chapter]) -> Vec<SkipSection> {
    chapters
        .iter()
        .filter(|chapter| {
            chapter.start_seconds.is_finite()
                && chapter.end_seconds.is_finite()
                && chapter.end_seconds > chapter.start_seconds
        })
        .map(|chapter| SkipSection {
            start: chapter.start_seconds,
            end: chapter.end_seconds,
            kind: chapter_kind(&chapter.title),
            label: chapter.title.clone(),
        })
        .collect()
}

/// Maps named container chapters to skip windows. Returns (intro, credits).
/// Names are release-dependent, so anything unrecognized is ignored and the
/// API fallbacks in the skip-segments endpoint cover the gap. Sanity bounds
/// keep a mislabeled chapter from producing an absurd skip: an intro must sit
/// in the first half, credits must start past the 40% mark.
pub fn chapter_skip_segments(
    chapters: &[Chapter],
    duration_seconds: f64,
) -> (Option<SkipSegment>, Option<SkipSegment>) {
    let mut intro = None;
    let mut credits = None;
    for chapter in chapters {
        if !chapter.start_seconds.is_finite()
            || !chapter.end_seconds.is_finite()
            || chapter.end_seconds <= chapter.start_seconds
        {
            continue;
        }
        // The position bounds guard against a mislabeled mid-file chapter;
        // an unknown duration skips them — a chapter literally named "Intro"
        // is trustworthy on its own.
        match chapter_kind(&chapter.title) {
            "intro"
                if intro.is_none()
                    && (duration_seconds <= 0.0
                        || chapter.start_seconds < duration_seconds * 0.5) =>
            {
                intro = Some(SkipSegment {
                    start: chapter.start_seconds,
                    end: chapter.end_seconds,
                });
            }
            "credits"
                if credits.is_none()
                    && (duration_seconds <= 0.0
                        || chapter.start_seconds > duration_seconds * 0.4) =>
            {
                credits = Some(SkipSegment {
                    start: chapter.start_seconds,
                    end: chapter.end_seconds,
                });
            }
            _ => {}
        }
    }
    (intro, credits)
}

impl MediaProbe {
    pub fn video_copyable(&self) -> bool {
        self.video_codec
            .as_deref()
            .is_some_and(|codec| COPYABLE_VIDEO.contains(&codec))
    }

    pub fn audio_copyable(&self) -> bool {
        match self.audio_codec.as_deref() {
            None => true,
            Some(codec) => COPYABLE_AUDIO.contains(&codec),
        }
    }

    /// True when the chosen audio is the file's first audio track — the one
    /// a browser plays when it opens the file directly.
    pub fn audio_is_first(&self) -> bool {
        self.audio_tracks
            .first()
            .is_none_or(|track| Some(track.index) == self.audio_stream_index)
    }

    /// Switches to the viewer's chosen audio language (ISO 639-1, e.g. "de"
    /// for a German original, "en" for an English dub). When the file has
    /// no such track, the container's default (then the first) track plays
    /// rather than the English preference, which would be the dub. Without
    /// a choice the probe's own pick stands.
    pub fn with_audio_language(mut self, language: Option<&str>) -> Self {
        let Some(wanted) = language.and_then(language_code) else {
            return self;
        };
        let track = self
            .audio_tracks
            .iter()
            .find(|track| track.language.as_deref() == Some(wanted))
            .or_else(|| self.audio_tracks.iter().find(|track| track.default))
            .or_else(|| self.audio_tracks.first());
        if let Some(track) = track {
            self.audio_stream_index = Some(track.index);
            self.audio_codec = track.codec.clone();
        }
        self
    }
}

/// ISO 639-1 code for a language tag or name: "ger", "deu", "German" and
/// "de" all give "de". `None` for unknown or undetermined tags.
pub fn language_code(tag: &str) -> Option<&'static str> {
    const CODES: &[(&str, &[&str])] = &[
        ("en", &["en", "eng", "english"]),
        ("de", &["de", "ger", "deu", "german", "deutsch"]),
        ("fr", &["fr", "fre", "fra", "french"]),
        ("es", &["es", "spa", "spanish", "castellano"]),
        ("it", &["it", "ita", "italian"]),
        ("pt", &["pt", "por", "portuguese"]),
        ("ru", &["ru", "rus", "russian"]),
        ("uk", &["uk", "ukr", "ukrainian"]),
        ("pl", &["pl", "pol", "polish"]),
        ("nl", &["nl", "dut", "nld", "dutch"]),
        ("sv", &["sv", "swe", "swedish"]),
        ("da", &["da", "dan", "danish"]),
        ("no", &["no", "nb", "nn", "nor", "nob", "nno", "norwegian"]),
        ("fi", &["fi", "fin", "finnish"]),
        ("is", &["is", "ice", "isl", "icelandic"]),
        ("cs", &["cs", "cze", "ces", "czech"]),
        ("hu", &["hu", "hun", "hungarian"]),
        ("ro", &["ro", "rum", "ron", "romanian"]),
        ("el", &["el", "gre", "ell", "greek"]),
        ("tr", &["tr", "tur", "turkish"]),
        ("he", &["he", "heb", "hebrew"]),
        ("ar", &["ar", "ara", "arabic"]),
        ("fa", &["fa", "per", "fas", "persian"]),
        ("hi", &["hi", "hin", "hindi"]),
        ("ta", &["ta", "tam", "tamil"]),
        ("te", &["te", "tel", "telugu"]),
        ("ml", &["ml", "mal", "malayalam"]),
        ("th", &["th", "tha", "thai"]),
        ("vi", &["vi", "vie", "vietnamese"]),
        ("id", &["id", "ind", "indonesian"]),
        ("ms", &["ms", "may", "msa", "malay"]),
        ("tl", &["tl", "tgl", "fil", "tagalog", "filipino"]),
        ("ja", &["ja", "jpn", "japanese"]),
        ("ko", &["ko", "kor", "korean"]),
        ("zh", &["zh", "chi", "zho", "cn", "chinese", "mandarin", "cmn"]),
    ];
    let tag = tag.trim().to_ascii_lowercase();
    CODES
        .iter()
        .find(|(_, names)| names.contains(&tag.as_str()))
        .map(|(code, _)| *code)
}

fn audio_tracks(streams: &[FfprobeStream]) -> Vec<AudioTrack> {
    streams
        .iter()
        .filter(|stream| stream.codec_type.as_deref() == Some("audio"))
        .filter_map(|stream| {
            let language = stream.tags.language.as_deref().and_then(|tag| {
                language_code(tag).map(str::to_owned).or_else(|| {
                    let tag = tag.trim().to_ascii_lowercase();
                    (!tag.is_empty() && tag != "und").then_some(tag)
                })
            });
            Some(AudioTrack {
                index: stream.index?,
                codec: stream.codec_name.clone(),
                language,
                default: stream.disposition.default == Some(1),
            })
        })
        .collect()
}

#[derive(Deserialize)]
struct FfprobeOutput {
    #[serde(default)]
    streams: Vec<FfprobeStream>,
    #[serde(default)]
    format: FfprobeFormat,
    #[serde(default)]
    chapters: Vec<FfprobeChapter>,
}

#[derive(Deserialize)]
struct FfprobeChapter {
    start_time: Option<String>,
    end_time: Option<String>,
    #[serde(default)]
    tags: FfprobeChapterTags,
}

#[derive(Default, Deserialize)]
struct FfprobeChapterTags {
    title: Option<String>,
}

#[derive(Default, Deserialize)]
struct FfprobeFormat {
    duration: Option<String>,
    format_name: Option<String>,
}

#[derive(Deserialize)]
struct FfprobeStream {
    index: Option<u32>,
    codec_type: Option<String>,
    codec_name: Option<String>,
    #[serde(default)]
    tags: FfprobeTags,
    #[serde(default)]
    disposition: FfprobeDisposition,
}

#[derive(Default, Deserialize)]
struct FfprobeTags {
    language: Option<String>,
}

#[derive(Default, Deserialize)]
struct FfprobeDisposition {
    default: Option<u8>,
}

/// Picks the audio track the viewer most likely wants: English first, then
/// whatever the container marks as default, then the first audio stream.
fn pick_audio_stream(streams: &[FfprobeStream]) -> Option<&FfprobeStream> {
    let is_audio = |stream: &&FfprobeStream| stream.codec_type.as_deref() == Some("audio");
    let is_english = |stream: &&FfprobeStream| {
        matches!(
            stream
                .tags
                .language
                .as_deref()
                .map(str::to_ascii_lowercase)
                .as_deref(),
            Some("eng" | "en" | "english")
        )
    };
    streams
        .iter()
        .filter(is_audio)
        .find(is_english)
        .or_else(|| {
            streams
                .iter()
                .filter(is_audio)
                .find(|stream| stream.disposition.default == Some(1))
        })
        .or_else(|| streams.iter().find(is_audio))
}


/// Finds ffmpeg/ffprobe and probes sources. Probe results are kept per
/// `torrent:file` for the skip-segments endpoint (chapters).
pub struct TranscodeManager {
    ffmpeg: Option<PathBuf>,
    ffprobe: Option<PathBuf>,
    probes: Mutex<HashMap<String, MediaProbe>>,
}

impl Default for TranscodeManager {
    fn default() -> Self {
        Self::new()
    }
}

impl TranscodeManager {
    pub fn new() -> Self {
        Self {
            ffmpeg: find_tool("ffmpeg"),
            ffprobe: find_tool("ffprobe"),
            probes: Mutex::new(HashMap::new()),
        }
    }

    pub fn ffmpeg_path(&self) -> Option<&Path> {
        self.ffmpeg.as_deref()
    }

    pub fn available(&self) -> bool {
        self.ffmpeg.is_some() && self.ffprobe.is_some()
    }

    pub async fn probe(&self, input_url: &str) -> Result<MediaProbe, String> {
        let ffprobe = self.ffprobe.as_ref().ok_or("ffprobe is not available")?;
        // A cold torrent can legitimately need more than one timeout window:
        // the killed attempt already pulled the header pieces into the cache,
        // so an immediate retry usually finishes fast.
        match self.probe_once(ffprobe, input_url).await {
            Err(ProbeError::TimedOut) => {
                tracing::info!(target: "probe", "source probe timed out; retrying once");
                self.probe_once(ffprobe, input_url).await
            }
            result => result,
        }
        .map_err(|error| match error {
            ProbeError::TimedOut => "probing the source timed out".to_string(),
            ProbeError::Failed(error) => error,
        })
    }

    async fn probe_once(
        &self,
        ffprobe: &Path,
        input_url: &str,
    ) -> Result<MediaProbe, ProbeError> {
        let output = tokio::time::timeout(
            PROBE_TIMEOUT,
            Command::new(ffprobe)
                .args([
                    "-v",
                    "error",
                    "-print_format",
                    "json",
                    "-show_streams",
                    "-show_format",
                    "-show_chapters",
                    // Stream info for MKV lives in the header; a 20M budget
                    // made cold starts wait on megabytes of torrent data that
                    // add nothing. These caps bound the worst case tightly.
                    "-analyzeduration",
                    "10M",
                    "-probesize",
                    "5M",
                ])
                .arg(input_url)
                .stdin(Stdio::null())
                .stderr(Stdio::null())
                .kill_on_drop(true)
                .output(),
        )
        .await
        .map_err(|_| ProbeError::TimedOut)?
        .map_err(|error| ProbeError::Failed(format!("could not run ffprobe: {error}")))?;

        if !output.status.success() {
            return Err(ProbeError::Failed("ffprobe could not read the source".into()));
        }
        let parsed: FfprobeOutput = serde_json::from_slice(&output.stdout).map_err(|error| {
            ProbeError::Failed(format!("unexpected ffprobe output: {error}"))
        })?;

        let video_codec = parsed
            .streams
            .iter()
            .find(|stream| stream.codec_type.as_deref() == Some("video"))
            .and_then(|stream| stream.codec_name.clone());
        let audio = pick_audio_stream(&parsed.streams);
        let duration_seconds = parsed
            .format
            .duration
            .as_deref()
            .and_then(|duration| duration.parse::<f64>().ok())
            .filter(|duration| duration.is_finite() && *duration > 0.0);
        tracing::info!(
            target: "probe",
            video_codec = video_codec.as_deref().unwrap_or("-"),
            audio_codec = audio.and_then(|stream| stream.codec_name.clone()).as_deref().unwrap_or("-"),
            audio_stream_index = audio.and_then(|stream| stream.index).unwrap_or(u32::MAX),
            duration_seconds = duration_seconds.unwrap_or(0.0),
            "source probe complete"
        );
        let chapters = parsed
            .chapters
            .iter()
            .filter_map(|chapter| {
                Some(Chapter {
                    start_seconds: chapter.start_time.as_deref()?.parse().ok()?,
                    end_seconds: chapter.end_time.as_deref()?.parse().ok()?,
                    title: chapter.tags.title.clone().unwrap_or_default(),
                })
            })
            .collect();
        Ok(MediaProbe {
            video_codec,
            audio_codec: audio.and_then(|stream| stream.codec_name.clone()),
            audio_stream_index: audio.and_then(|stream| stream.index),
            audio_tracks: audio_tracks(&parsed.streams),
            duration_seconds,
            format_name: parsed.format.format_name.clone(),
            chapters,
        })
    }

    /// A probe some session already ran for `key` (`torrent:file`).
    pub async fn cached_probe(&self, key: &str) -> Option<MediaProbe> {
        self.probes.lock().await.get(key).cloned()
    }

    /// Stores a probe for later skip-segment lookups.
    pub async fn remember_probe(&self, key: &str, probe: MediaProbe) {
        let mut probes = self.probes.lock().await;
        // A handful of entries covers previews plus the active title.
        if probes.len() >= 16 {
            probes.clear();
        }
        probes.insert(key.to_owned(), probe);
    }

    /// Forgets every probe (cache clear).
    pub async fn clear_cache(&self) {
        self.probes.lock().await.clear();
    }
}

/// Locates a bundled or system ffmpeg tool. The directory next to the CLI
/// executable is checked first so a release sidecar wins over system installs.
pub(crate) fn find_tool(name: &str) -> Option<PathBuf> {
    let file_name = if cfg!(windows) {
        format!("{name}.exe")
    } else {
        name.to_owned()
    };

    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            let candidate = dir.join(&file_name);
            if candidate.is_file() {
                return Some(candidate);
            }
        }
    }

    let mut candidates: Vec<PathBuf> = Vec::new();
    for dir in ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin"] {
        candidates.push(Path::new(dir).join(&file_name));
    }
    if let Some(path) = std::env::var_os("PATH") {
        for dir in std::env::split_paths(&path) {
            candidates.push(dir.join(&file_name));
        }
    }
    candidates.into_iter().find(|candidate| candidate.is_file())
}

#[cfg(test)]
mod tests {
    mod audio_language {
        use super::super::{language_code, AudioTrack, MediaProbe};

        fn track(index: u32, codec: &str, language: Option<&str>, default: bool) -> AudioTrack {
            AudioTrack {
                index,
                codec: Some(codec.into()),
                language: language.map(str::to_owned),
                default,
            }
        }

        /// Dark's KONTRAST dual release: German original first, English dub
        /// second. The probe's own pick is the English track.
        fn dual() -> MediaProbe {
            MediaProbe {
                video_codec: Some("hevc".into()),
                audio_codec: Some("aac".into()),
                audio_stream_index: Some(2),
                audio_tracks: vec![
                    track(1, "eac3", Some("de"), true),
                    track(2, "aac", Some("en"), false),
                ],
                duration_seconds: Some(3000.0),
                format_name: Some("matroska,webm".into()),
                chapters: vec![],
            }
        }

        #[test]
        fn tags_and_names_normalise_to_iso_639_1() {
            assert_eq!(language_code("ger"), Some("de"));
            assert_eq!(language_code("DEU"), Some("de"));
            assert_eq!(language_code("de"), Some("de"));
            assert_eq!(language_code("English"), Some("en"));
            assert_eq!(language_code("und"), None);
        }

        #[test]
        fn original_choice_picks_the_original_track() {
            let probe = dual().with_audio_language(Some("de"));
            assert_eq!(probe.audio_stream_index, Some(1));
            assert_eq!(probe.audio_codec.as_deref(), Some("eac3"));
            assert!(probe.audio_is_first());
        }

        #[test]
        fn english_choice_picks_the_dub() {
            let probe = dual().with_audio_language(Some("en"));
            assert_eq!(probe.audio_stream_index, Some(2));
            assert_eq!(probe.audio_codec.as_deref(), Some("aac"));
            assert!(!probe.audio_is_first());
        }

        #[test]
        fn missing_language_falls_back_to_the_default_track() {
            let probe = dual().with_audio_language(Some("fr"));
            assert_eq!(probe.audio_stream_index, Some(1));
        }

        #[test]
        fn no_choice_keeps_the_probe_pick() {
            assert_eq!(dual().with_audio_language(None).audio_stream_index, Some(2));
        }
    }

    mod chapters {
        use super::super::{chapter_skip_segments, Chapter};

        fn chapter(start: f64, end: f64, title: &str) -> Chapter {
            Chapter {
                start_seconds: start,
                end_seconds: end,
                title: title.to_owned(),
            }
        }

        #[test]
        fn named_intro_and_credits_are_picked() {
            // Silo S03E05's real chapter layout.
            let chapters = [
                chapter(0.0, 250.333, "Scene 1"),
                chapter(250.333, 348.125, "Intro"),
                chapter(348.125, 3092.0, "Scene 2"),
                chapter(3092.0, 3153.76, "Credits"),
            ];
            let (intro, credits) = chapter_skip_segments(&chapters, 3153.76);
            let intro = intro.expect("intro");
            assert_eq!(intro.start, 250.333);
            assert_eq!(intro.end, 348.125);
            let credits = credits.expect("credits");
            assert_eq!(credits.start, 3092.0);
            assert_eq!(credits.end, 3153.76);
        }

        #[test]
        fn generic_chapter_names_are_ignored() {
            let chapters = [
                chapter(0.0, 300.0, "Chapter 1"),
                chapter(300.0, 600.0, "Scene 2"),
                chapter(600.0, 900.0, "Chapter 3"),
            ];
            let (intro, credits) = chapter_skip_segments(&chapters, 900.0);
            assert!(intro.is_none());
            assert!(credits.is_none());
        }

        #[test]
        fn anime_op_ed_labels_match() {
            let chapters = [
                chapter(0.0, 90.0, "Prologue"),
                chapter(90.0, 180.0, "OP"),
                chapter(180.0, 1300.0, "Part A"),
                chapter(1300.0, 1390.0, "ED 2"),
            ];
            let (intro, credits) = chapter_skip_segments(&chapters, 1400.0);
            assert_eq!(intro.map(|s| (s.start, s.end)), Some((90.0, 180.0)));
            assert_eq!(credits.map(|s| (s.start, s.end)), Some((1300.0, 1390.0)));
        }

        #[test]
        fn opening_title_sequence_and_closing_match() {
            let chapters = [
                chapter(10.0, 100.0, "Opening Titles"),
                chapter(800.0, 900.0, "Closing"),
            ];
            let (intro, credits) = chapter_skip_segments(&chapters, 900.0);
            assert!(intro.is_some());
            assert!(credits.is_some());
        }

        #[test]
        fn intro_past_the_halfway_mark_is_rejected() {
            // A chapter named "Intro" two thirds in is a mislabel, not an
            // actual title sequence.
            let chapters = [chapter(700.0, 800.0, "Intro")];
            let (intro, _) = chapter_skip_segments(&chapters, 900.0);
            assert!(intro.is_none());
        }

        #[test]
        fn credits_too_early_are_rejected() {
            let chapters = [chapter(100.0, 200.0, "Credits")];
            let (_, credits) = chapter_skip_segments(&chapters, 900.0);
            assert!(credits.is_none());
        }

        #[test]
        fn invalid_ranges_and_values_are_skipped() {
            let chapters = [
                chapter(200.0, 100.0, "Intro"), // reversed
                chapter(f64::NAN, 300.0, "Opening"),
                chapter(50.0, f64::INFINITY, "Intro"),
                chapter(10.0, 90.0, "Intro"),
            ];
            let (intro, _) = chapter_skip_segments(&chapters, 900.0);
            assert_eq!(intro.map(|s| (s.start, s.end)), Some((10.0, 90.0)));
        }

        #[test]
        fn unknown_duration_still_matches_named_chapters() {
            let chapters = [
                chapter(250.0, 348.0, "Intro"),
                chapter(3000.0, 3100.0, "Credits"),
            ];
            let (intro, credits) = chapter_skip_segments(&chapters, 0.0);
            assert!(intro.is_some());
            assert!(credits.is_some());
        }

        #[test]
        fn first_named_match_wins() {
            let chapters = [
                chapter(10.0, 60.0, "Intro"),
                chapter(70.0, 120.0, "Opening"),
            ];
            let (intro, _) = chapter_skip_segments(&chapters, 900.0);
            assert_eq!(intro.map(|s| (s.start, s.end)), Some((10.0, 60.0)));
        }
    }

    #[cfg(unix)]
    mod subprocess {
        use super::super::*;
        use std::os::unix::fs::PermissionsExt;

        struct Fixture(PathBuf);

        impl Fixture {
            fn new() -> Self {
                let dir = std::env::temp_dir().join(format!("cubo-probe-{}", uuid::Uuid::new_v4()));
                std::fs::create_dir_all(&dir).unwrap();
                Self(dir)
            }

            fn script(&self, name: &str, body: &str) -> PathBuf {
                let path = self.0.join(name);
                std::fs::write(&path, format!("#!/bin/sh\n{body}\n")).unwrap();
                std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o700)).unwrap();
                path
            }
        }

        impl Drop for Fixture {
            fn drop(&mut self) {
                let _ = std::fs::remove_dir_all(&self.0);
            }
        }

        async fn assert_process_exits(pid_file: &Path) {
            let pid: i32 = std::fs::read_to_string(pid_file)
                .unwrap()
                .trim()
                .parse()
                .unwrap();
            tokio::time::timeout(Duration::from_secs(3), async {
                // Signal zero checks existence without sending a signal.
                while unsafe { libc::kill(pid, 0) } == 0 {
                    tokio::time::sleep(Duration::from_millis(10)).await;
                }
            })
            .await
            .expect("cancelled ffprobe was left running");
        }

        #[tokio::test]
        async fn cancelling_source_probe_kills_the_subprocess() {
            let fixture = Fixture::new();
            let mut manager = TranscodeManager::new();
            manager.ffprobe = Some(fixture.script(
                "ffprobe",
                r#"for input do :; done
printf '%s' "$$" > "$input"
exec sleep 30"#,
            ));
            let pid_file = fixture.0.join("pid");
            assert!(tokio::time::timeout(
                Duration::from_secs(2),
                manager.probe(pid_file.to_str().unwrap()),
            )
            .await
            .is_err());
            assert_process_exits(&pid_file).await;
        }

        #[tokio::test]
        async fn source_probe_reads_named_chapters() {
            let fixture = Fixture::new();
            let mut manager = TranscodeManager::new();
            manager.ffprobe = Some(fixture.script(
                "ffprobe",
                r#"cat <<'JSON'
{"streams":[{"codec_type":"video","codec_name":"h264"},{"codec_type":"audio","codec_name":"aac","index":1}],
 "format":{"duration":"3153.760"},
 "chapters":[
   {"start_time":"0","end_time":"250.333","tags":{"title":"Scene 1"}},
   {"start_time":"250.333","end_time":"348.125","tags":{"title":"Intro"}},
   {"start_time":"348.125","end_time":"3092.0","tags":{"title":"Scene 2"}},
   {"start_time":"3092.0","end_time":"3153.760","tags":{"title":"Credits"}},
   {"start_time":"not-a-number","end_time":"1","tags":{"title":"Broken"}}
 ]}
JSON"#,
            ));
            let probe = manager.probe("unused").await.unwrap();
            assert_eq!(probe.duration_seconds, Some(3153.76));
            assert_eq!(probe.chapters.len(), 4);
            assert_eq!(probe.chapters[1].title, "Intro");
            assert_eq!(probe.chapters[1].start_seconds, 250.333);
            let (intro, credits) = super::super::chapter_skip_segments(
                &probe.chapters,
                probe.duration_seconds.unwrap(),
            );
            assert_eq!(intro.map(|s| (s.start, s.end)), Some((250.333, 348.125)));
            assert_eq!(credits.map(|s| (s.start, s.end)), Some((3092.0, 3153.76)));
        }

        #[tokio::test]
        async fn source_probe_lists_audio_tracks_and_honours_the_choice() {
            // ffprobe's output for a German-first, English-second MKV.
            let fixture = Fixture::new();
            let mut manager = TranscodeManager::new();
            manager.ffprobe = Some(fixture.script(
                "ffprobe",
                r#"cat <<'JSON'
{"streams":[
  {"index":0,"codec_type":"video","codec_name":"h264","tags":{},"disposition":{"default":0}},
  {"index":1,"codec_type":"audio","codec_name":"eac3","tags":{"language":"ger"},"disposition":{"default":1}},
  {"index":2,"codec_type":"audio","codec_name":"aac","tags":{"language":"eng"},"disposition":{"default":0}}
 ],
 "format":{"duration":"2.0"}}
JSON"#,
            ));
            let probe = manager.probe("unused").await.unwrap();
            let languages: Vec<_> = probe.audio_tracks.iter().map(|track| track.language.as_deref()).collect();
            assert_eq!(languages, [Some("de"), Some("en")]);
            // Without a choice the English-first default stands.
            assert_eq!(probe.audio_stream_index, Some(2));
            let original = probe.clone().with_audio_language(Some("de"));
            assert_eq!((original.audio_stream_index, original.audio_codec.as_deref()), (Some(1), Some("eac3")));
            assert!(!original.audio_copyable());
        }

    }
}
