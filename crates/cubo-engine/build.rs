use std::env;
use std::fs;
use std::path::{Path, PathBuf};

fn main() {
    let out = PathBuf::from(env::var("OUT_DIR").expect("OUT_DIR")).join("cubo-web");
    let _ = fs::remove_dir_all(&out);
    fs::create_dir_all(&out).expect("create embedded web dir");

    let manifest = PathBuf::from(env::var("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR"));
    let dist = manifest.join("../../apps/web/dist");
    println!("cargo:rerun-if-changed={}", dist.display());
    if dist.join("index.html").is_file() {
        copy_dir(&dist, &out);
    } else {
        fs::write(
            out.join("index.html"),
            "<!doctype html><meta charset=utf-8><title>cubo</title>\
             <p>Build the web app first: <code>bun --filter @cubo/web build</code></p>",
        )
        .expect("write stub index");
    }
}

fn copy_dir(src: &Path, dest: &Path) {
    for entry in fs::read_dir(src).expect("read web dist") {
        let entry = entry.expect("dist entry");
        let to = dest.join(entry.file_name());
        if entry.file_type().expect("entry type").is_dir() {
            fs::create_dir_all(&to).expect("create dest dir");
            copy_dir(&entry.path(), &to);
        } else {
            fs::copy(entry.path(), to).expect("copy web file");
        }
    }
}
