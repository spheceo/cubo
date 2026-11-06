#!/usr/bin/env bash
# Other traffic on the benchmark link: a steady download of COMPETE_MBPS
# through the throttle proxy (like seeding uploads or another device on the
# same link). Runs until killed.
#
#   COMPETE_MBPS=3 scripts/bench/competitor.sh <url>
set -euo pipefail
url="${1:?usage: $0 <large http url>}"
rate_kbytes=$(( ${COMPETE_MBPS:?} * 1000 / 8 ))
while true; do
  curl -s --proxy http://127.0.0.1:8791 --limit-rate "${rate_kbytes}k" -o /dev/null "$url" || sleep 1
done
