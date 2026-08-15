#!/usr/bin/env bash
# Local Developer ID + notarization + GitHub Releases entrypoint.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="${DSH_RELEASE_ENV:-$ROOT/.env.release}"

if [[ ! -f "$ENV_FILE" ]]; then
  echo "error: missing $ENV_FILE (copy .env.release.example first)" >&2
  exit 1
fi

# shellcheck disable=SC1090
set -a; . "$ENV_FILE"; set +a

# Pulse's established local file uses APPLE_API_KEY for the key ID and
# APPLE_API_KEY_PATH for the .p8 path. Accept that shape so both projects can
# share the same Apple credentials without duplicating secrets.
if [[ -n "${APPLE_SIGNING_IDENTITY:-}" && -z "${MACOS_SIGN_IDENTITY:-}" ]]; then
  export MACOS_SIGN_IDENTITY="$APPLE_SIGNING_IDENTITY"
fi
if [[ -n "${APPLE_API_KEY_PATH:-}" && -n "${APPLE_API_KEY:-}" && -z "${APPLE_API_KEY_ID:-}" ]]; then
  export APPLE_API_KEY_ID="$APPLE_API_KEY"
  export APPLE_API_KEY="$APPLE_API_KEY_PATH"
fi

exec node "$ROOT/scripts/release-mac.mjs"
