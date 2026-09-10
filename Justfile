# Cubo task runner. `just` lists recipes.

# Run Cubo Core. Uses :8765, or the next free port if persist already owns it.
dev:
    cargo run -p cubo-cli -- serve --no-open

# Stop a background `cubo persist` (does not run as part of `just dev`)
stop-persist:
    #!/usr/bin/env sh
    set -eu
    uid="$(id -u)"
    stopped=0
    if command -v launchctl >/dev/null 2>&1 && \
       launchctl print "gui/${uid}/com.spheceo.cubo" >/dev/null 2>&1; then
        echo "Stopping background Cubo (cubo persist) so this build can bind :8765."
        launchctl bootout "gui/${uid}/com.spheceo.cubo" >/dev/null 2>&1 || true
        stopped=1
    fi
    if command -v systemctl >/dev/null 2>&1 && \
       systemctl --user is-active --quiet cubo.service 2>/dev/null; then
        echo "Stopping background Cubo (cubo persist) so this build can bind :8765."
        systemctl --user stop cubo.service
        stopped=1
    fi
    if [ "$stopped" -eq 1 ]; then
        sleep 0.4
        echo "Run \`cubo persist\` when you want the background service back."
    fi

# Vite app at :4200
web:
    bun --filter '@cubo/web' dev

# Marketing site at :4300
site:
    bun --filter '@cubo/site' dev

# Vite app and marketing site together
apps:
    bun --filter '@cubo/web' --filter '@cubo/site' dev

# Typecheck every TypeScript package
typecheck:
    bun run --filter '*' typecheck

# Production build of the web app and marketing site
build:
    bun run --filter '*' build

# Compile the Rust workspace
check:
    cargo check

# Run the Rust workspace tests
test:
    cargo test
