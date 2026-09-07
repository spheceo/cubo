//! `cubo search` — queries the same catalog Worker the web app uses. The
//! TMDB key stays on Cloudflare; this binary never sees it.

use serde::Deserialize;

#[derive(Deserialize)]
struct SearchResponse {
    #[serde(default)]
    results: Vec<SearchResult>,
}

#[derive(Deserialize)]
struct SearchResult {
    id: u64,
    #[serde(default)]
    media_type: String,
    #[serde(default)]
    title: Option<String>,
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    release_date: Option<String>,
    #[serde(default)]
    first_air_date: Option<String>,
    #[serde(default)]
    vote_average: Option<f64>,
}

pub async fn run(query: &str) {
    let query = query.trim();
    if query.is_empty() {
        eprintln!("Usage: cubo search \"title\"");
        return;
    }

    let client = reqwest::Client::new();
    let response = client
        .get(format!("{}/search/multi", cubo_engine::catalog::catalog_base()))
        .query(&[("query", query), ("include_adult", "false")])
        .send()
        .await;

    let response = match response {
        Ok(response) if response.status().is_success() => response,
        Ok(response) => {
            eprintln!("Search failed: catalog returned {}", response.status());
            return;
        }
        Err(error) => {
            eprintln!("Search failed: could not reach the catalog ({error})");
            return;
        }
    };

    let parsed: SearchResponse = match response.json().await {
        Ok(parsed) => parsed,
        Err(_) => {
            eprintln!("Search failed: unexpected catalog response");
            return;
        }
    };

    let mut shown = 0;
    for result in &parsed.results {
        if result.media_type != "movie" && result.media_type != "tv" {
            continue; // skip people and other entity types
        }
        if shown == 0 {
            println!();
            println!("Results for \"{query}\":");
            println!();
        }
        if shown >= 8 {
            break;
        }

        let title = result
            .title
            .as_deref()
            .or(result.name.as_deref())
            .unwrap_or("Untitled");
        let year = result
            .release_date
            .as_deref()
            .or(result.first_air_date.as_deref())
            .and_then(|date| date.get(..4))
            .unwrap_or("----");
        let kind = if result.media_type == "movie" {
            "movie"
        } else {
            "show "
        };
        let rating = result
            .vote_average
            .map(|value| format!("{value:.1}"))
            .unwrap_or_else(|| "-".to_string());

        println!(
            "  {kind}  {year}  ★{rating:>4}  {title}",
        );
        println!(
            "         watch at http://127.0.0.1:8765/watch/{}/{}",
            result.media_type, result.id
        );
        shown += 1;
    }

    if shown == 0 {
        println!("No results for \"{query}\".");
    }
}
