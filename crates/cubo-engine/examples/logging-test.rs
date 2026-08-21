// Isolate: direct rolling appender (no non_blocking), no custom registry.
use tracing_subscriber::layer::SubscriberExt;

fn main() {
    let dir = std::path::Path::new("/tmp/cubo-logtest2");
    let _ = std::fs::create_dir_all(dir);
    let file = tracing_appender::rolling::daily(dir, "cubo.log");
    let sub = tracing_subscriber::registry().with(
        tracing_subscriber::fmt::layer()
            .with_ansi(false)
            .with_writer(file),
    );
    tracing_subscriber::util::SubscriberInitExt::init(sub);
    tracing::info!(count = 1, "direct rolling tick");
    println!("wrote");
}
