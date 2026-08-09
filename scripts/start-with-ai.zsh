#!/bin/zsh
set -euo pipefail

SCRIPT_DIR=${0:A:h}
PROJECT_DIR=${SCRIPT_DIR:h}

export PATH="/opt/homebrew/opt/node@22/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"

if [[ "$(node --version 2>/dev/null || true)" != v22.* ]]; then
  echo "CareerOS needs Node 22. Current version: $(node --version 2>/dev/null || echo missing)"
  exit 1
fi

if [[ -z "${OPENAI_API_KEY:-}" ]]; then
  read -r -s "OPENAI_API_KEY?Paste your OpenAI API key: "
  echo
  export OPENAI_API_KEY
fi

if [[ -z "${OPENAI_API_KEY}" ]]; then
  echo "No API key was entered. CareerOS was not started."
  exit 1
fi

export CAREEROS_AI_MODEL="${CAREEROS_AI_MODEL:-gpt-5.6-terra}"
cd "$PROJECT_DIR"
exec corepack pnpm dev
