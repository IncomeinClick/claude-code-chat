#!/bin/bash
set -e

# Colors (safe for both Linux and Mac)
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m' # No Color

info()  { printf "${CYAN}▸${NC} %s\n" "$1"; }
ok()    { printf "${GREEN}✓${NC} %s\n" "$1"; }
warn()  { printf "${YELLOW}!${NC} %s\n" "$1"; }
fail()  { printf "${RED}✗${NC} %s\n" "$1"; exit 1; }

# Detect OS
IS_MAC=false
IS_LINUX=false
if [[ "$(uname)" == "Darwin" ]]; then
  IS_MAC=true
elif [[ "$(uname)" == "Linux" ]]; then
  IS_LINUX=true
fi

echo ""
echo "╔══════════════════════════════════════╗"
echo "║     Claude Code Chat — Setup         ║"
echo "╚══════════════════════════════════════╝"
echo ""

# Parse command-line args
ARG_USER=""
ARG_PASS=""
ARG_NAME=""
ARG_PORT=""
ARG_DOMAIN=""
ARG_SERVICE=""
ARG_NGINX=""

usage() {
  echo "Usage: bash setup/install.sh [OPTIONS]"
  echo ""
  echo "Options:"
  echo "  --user USERNAME       Login username"
  echo "  --password PASSWORD   Login password"
  echo "  --name DISPLAY_NAME   Display name in UI (default: Claude Code)"
  echo "  --port PORT           Server port (default: 3456)"
  echo "  --domain DOMAIN       Domain for nginx config"
  echo "  --service             Install systemd service (Linux only)"
  echo "  --nginx               Install nginx config (requires --domain)"
  echo "  -h, --help            Show this help"
  echo ""
  echo "Examples:"
  echo "  # Interactive (prompts for everything):"
  echo "  bash setup/install.sh"
  echo ""
  echo "  # Non-interactive with all options:"
  echo "  bash setup/install.sh --user admin --password secret123 --service --nginx --domain chat.example.com"
  exit 0
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --user)       ARG_USER="$2"; shift 2 ;;
    --password)   ARG_PASS="$2"; shift 2 ;;
    --name)       ARG_NAME="$2"; shift 2 ;;
    --port)       ARG_PORT="$2"; shift 2 ;;
    --domain)     ARG_DOMAIN="$2"; shift 2 ;;
    --service)    ARG_SERVICE="yes"; shift ;;
    --nginx)      ARG_NGINX="yes"; shift ;;
    -h|--help)    usage ;;
    *)            warn "Unknown option: $1"; shift ;;
  esac
done

# ── Check Node.js ──
if ! command -v node &> /dev/null; then
  fail "Node.js is required. Install Node.js 18+ first."
fi

NODE_VER=$(node -v | sed 's/v//' | cut -d. -f1)
if [ "$NODE_VER" -lt 18 ]; then
  fail "Node.js 18+ required. You have $(node -v)."
fi
ok "Node.js $(node -v)"

# ── Check Claude Code CLI ──
if ! command -v claude &> /dev/null; then
  fail "Claude Code CLI not found. Install: npm install -g @anthropic-ai/claude-code"
fi
ok "Claude CLI found"

# Check auth (non-blocking)
if ! claude -p "echo test" &> /dev/null 2>&1; then
  warn "Claude Code may not be authenticated. Run: claude auth login"
fi

# ── Resolve install directory ──
INSTALL_DIR="$(cd "$(dirname "$0")/.." && pwd)"
HOME_DIR="$HOME"

echo ""
info "Install directory: $INSTALL_DIR"
echo ""

# ── Install dependencies ──
info "Installing dependencies..."
cd "$INSTALL_DIR"
npm install --production 2>&1 | tail -1
ok "Dependencies installed"
echo ""

# ── Credential Setup ──
if [ -f "$INSTALL_DIR/.env" ]; then
  ok ".env already exists — skipping credential setup"
else
  echo "── Credential Setup ──"
  echo ""

  # Username
  if [ -n "$ARG_USER" ]; then
    TC_USER="$ARG_USER"
  else
    printf "  Login username: "
    read TC_USER
  fi

  if [ -z "$TC_USER" ]; then
    fail "Username cannot be empty"
  fi

  # Password
  if [ -n "$ARG_PASS" ]; then
    TC_PASS="$ARG_PASS"
  else
    printf "  Login password: "
    # read -s works on both bash and zsh on Mac/Linux
    read -s TC_PASS
    echo ""
  fi

  if [ -z "$TC_PASS" ]; then
    fail "Password cannot be empty"
  fi

  # Display name
  if [ -n "$ARG_NAME" ]; then
    TC_NAME="$ARG_NAME"
  else
    printf "  Display name [Claude Code]: "
    read TC_NAME
  fi
  TC_NAME="${TC_NAME:-Claude Code}"

  TC_PORT="${ARG_PORT:-3456}"

  info "Generating credentials..."
  JWT_SECRET=$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")
  PASS_HASH=$(node -e "require('bcryptjs').hash(process.argv[1],10).then(console.log)" "$TC_PASS")

  cat > "$INSTALL_DIR/.env" << ENVEOF
JWT_SECRET=$JWT_SECRET
USERNAME=$TC_USER
PASSWORD_HASH=$PASS_HASH
PORT=$TC_PORT
BIND_HOST=127.0.0.1
CLAUDE_BIN=claude
CLAUDE_CWD=$HOME_DIR
DISPLAY_NAME=$TC_NAME
INACTIVITY_TIMEOUT=1800
ENVEOF

  ok ".env created"
fi

echo ""

# ── Identity Setup (soul.md, CLAUDE.md, memory.md) ──
# Resolve CLAUDE_CWD from .env or use HOME
if [ -f "$INSTALL_DIR/.env" ]; then
  CLAUDE_CWD=$(grep '^CLAUDE_CWD=' "$INSTALL_DIR/.env" | cut -d= -f2)
fi
CLAUDE_CWD="${CLAUDE_CWD:-$HOME_DIR}"

if [ -f "$CLAUDE_CWD/soul.md" ]; then
  ok "Identity files already exist — skipping"
else
  echo "── Identity Setup ──"
  echo ""
  echo "  Choose a personality for your AI assistant:"
  echo ""
  echo "  1) Professional — Direct, precise, efficient"
  echo "  2) Friendly — Warm, encouraging, patient"
  echo "  3) Mentor — Teaching-oriented, explains why"
  echo "  4) Casual — Relaxed, conversational"
  echo "  5) Skip — I'll set it up later"
  echo ""
  printf "  Choice [1]: "
  read PERSONALITY_CHOICE
  PERSONALITY_CHOICE="${PERSONALITY_CHOICE:-1}"

  # Resolve display name
  SOUL_NAME="${TC_NAME:-Claude Code}"
  if [ -z "$TC_NAME" ] && [ -f "$INSTALL_DIR/.env" ]; then
    SOUL_NAME=$(grep '^DISPLAY_NAME=' "$INSTALL_DIR/.env" | cut -d= -f2)
    SOUL_NAME="${SOUL_NAME:-Claude Code}"
  fi

  case "$PERSONALITY_CHOICE" in
    1)
      cat > "$CLAUDE_CWD/soul.md" << SOULEOF
# Soul — $SOUL_NAME

You are $SOUL_NAME, a highly capable AI assistant.

## Personality
- Direct and precise — lead with the answer, skip filler
- Efficient — favor concise solutions over lengthy explanations
- Confident — give clear recommendations when asked
- Professional tone — respectful but not overly formal

## Behavior
- When given a task, do it. Don't ask unnecessary clarifying questions
- High-confidence answers only — verify in code, never guess
- Summarize what was done after each task
- Communicate in the user's language
SOULEOF
      ;;
    2)
      cat > "$CLAUDE_CWD/soul.md" << SOULEOF
# Soul — $SOUL_NAME

You are $SOUL_NAME, a warm and helpful AI assistant.

## Personality
- Friendly and encouraging — celebrate wins, be positive about progress
- Patient — explain things clearly without judgment
- Approachable — use a conversational tone
- Supportive — offer suggestions gently

## Behavior
- Check in with the user when uncertain about direction
- Explain what you're doing and why in simple terms
- Offer alternatives when a direct approach won't work
- Communicate in the user's language
SOULEOF
      ;;
    3)
      cat > "$CLAUDE_CWD/soul.md" << SOULEOF
# Soul — $SOUL_NAME

You are $SOUL_NAME, an AI mentor and technical guide.

## Personality
- Teaching-oriented — explain the "why" behind decisions
- Thorough — provide context and background when relevant
- Encouraging — build understanding, don't just give answers
- Knowledgeable — share best practices and patterns

## Behavior
- When fixing bugs, explain the root cause
- When writing code, briefly explain design choices
- Suggest improvements the user can learn from
- Communicate in the user's language
SOULEOF
      ;;
    4)
      cat > "$CLAUDE_CWD/soul.md" << SOULEOF
# Soul — $SOUL_NAME

You are $SOUL_NAME, a chill AI assistant.

## Personality
- Relaxed and conversational — talk like a colleague, not a service
- Brief — keep it short, skip formalities
- Practical — focus on getting things done
- Honest — say when something is a bad idea

## Behavior
- Don't over-explain — the user knows what they're doing
- Keep responses short unless detail is needed
- Be direct about tradeoffs and limitations
- Communicate in the user's language
SOULEOF
      ;;
    5)
      info "Skipping identity setup"
      ;;
    *)
      warn "Invalid choice — skipping identity setup"
      ;;
  esac

  if [[ "$PERSONALITY_CHOICE" =~ ^[1-4]$ ]]; then
    # Create CLAUDE.md
    cat > "$CLAUDE_CWD/CLAUDE.md" << CLAUDEEOF
# CLAUDE.md

## About
This server runs Claude Code Chat, a web interface for Claude Code CLI.

## Identity
- Assistant name: $SOUL_NAME
- Identity file: soul.md (personality and behavior rules)
- Memory file: memory.md (session history)

## Rules
- Read soul.md at the start of every session for personality guidance
- Update memory.md at the end of every session with what was done
- Communicate in the user's language
- High confidence answers only — verify before responding
- Keep responses concise — the user may be on mobile
CLAUDEEOF

    # Create memory.md
    cat > "$CLAUDE_CWD/memory.md" << MEMEOF
# Memory

## Session Log
_No sessions yet. This file will be updated at the end of each session._
MEMEOF

    ok "Identity files created (soul.md, CLAUDE.md, memory.md)"
  fi
fi

echo ""

# ── Systemd Service (Linux only) ──
if [ "$IS_MAC" = true ]; then
  if [ "$ARG_SERVICE" = "yes" ]; then
    warn "systemd is not available on macOS — skipping service install"
    echo ""
    info "To run on startup on macOS, you can:"
    echo "  1. Use 'pm2': pm2 start npm --name claude-chat -- start"
    echo "  2. Or add to Login Items / create a launchd plist"
    echo ""
  fi
else
  # Linux — ask or use flag
  INSTALL_SVC="$ARG_SERVICE"
  if [ -z "$INSTALL_SVC" ]; then
    printf "  Install systemd service? [y/N] "
    read INSTALL_SVC
  fi

  if [[ "$INSTALL_SVC" =~ ^[Yy] ]]; then
    SVC_FILE="/etc/systemd/system/claude-code-chat.service"
    # Use compatible sed: works on both GNU and BSD
    sed -e "s|__INSTALL_DIR__|$INSTALL_DIR|g" -e "s|__HOME_DIR__|$HOME_DIR|g" \
      "$INSTALL_DIR/setup/claude-code-chat.service" | sudo tee "$SVC_FILE" > /dev/null
    sudo systemctl daemon-reload
    sudo systemctl enable claude-code-chat
    sudo systemctl start claude-code-chat
    ok "Systemd service installed and started"
  fi
fi

echo ""

# ── Nginx ──
INSTALL_NGX="$ARG_NGINX"
if [ -z "$INSTALL_NGX" ]; then
  if command -v nginx &> /dev/null; then
    printf "  Install nginx config? [y/N] "
    read INSTALL_NGX
  fi
fi

if [[ "$INSTALL_NGX" =~ ^[Yy] ]]; then
  # Get domain
  DOMAIN="$ARG_DOMAIN"
  if [ -z "$DOMAIN" ]; then
    printf "  Domain name (e.g. chat.example.com): "
    read DOMAIN
  fi

  if [ -z "$DOMAIN" ]; then
    warn "No domain provided — skipping nginx config"
  else
    NGX_FILE="/etc/nginx/sites-available/claude-code-chat"

    # macOS nginx may not have sites-available
    if [ ! -d "/etc/nginx/sites-available" ]; then
      sudo mkdir -p /etc/nginx/sites-available /etc/nginx/sites-enabled
    fi

    sed -e "s|__DOMAIN__|$DOMAIN|g" \
      "$INSTALL_DIR/setup/nginx-claude-code-chat.conf" | sudo tee "$NGX_FILE" > /dev/null
    sudo ln -sf "$NGX_FILE" /etc/nginx/sites-enabled/claude-code-chat
    sudo nginx -t && sudo systemctl reload nginx 2>/dev/null || sudo nginx -s reload 2>/dev/null || true
    ok "Nginx configured for $DOMAIN"
    echo ""
    info "For HTTPS: sudo certbot --nginx -d $DOMAIN"
  fi
fi

# ── Claude Code Permissions ──
info "Setting up Claude Code permissions..."
CLAUDE_DIR="$HOME_DIR/.claude"
mkdir -p "$CLAUDE_DIR"
if [ ! -f "$CLAUDE_DIR/settings.json" ]; then
  cat > "$CLAUDE_DIR/settings.json" << 'SETTINGSEOF'
{
  "permissions": {
    "allow": [
      "Bash(*)",
      "Read(*)",
      "Write(*)",
      "Edit(*)",
      "Glob(*)",
      "Grep(*)",
      "Agent(*)"
    ]
  }
}
SETTINGSEOF
  ok "Claude Code permissions configured (all tools auto-approved)"
else
  ok "Claude Code permissions already exist — skipping"
fi

echo ""
echo "╔══════════════════════════════════════╗"
echo "║         Setup Complete!              ║"
echo "╚══════════════════════════════════════╝"
echo ""
info "Start manually: cd $INSTALL_DIR && npm start"
info "Default port: ${ARG_PORT:-3456}"

echo ""
