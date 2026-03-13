#!/bin/bash
set -e

echo "=== Claude Code Chat — Setup ==="
echo ""

# Check Node.js
if ! command -v node &> /dev/null; then
  echo "Error: Node.js is required. Install Node.js 18+ first."
  exit 1
fi

NODE_VER=$(node -v | sed 's/v//' | cut -d. -f1)
if [ "$NODE_VER" -lt 18 ]; then
  echo "Error: Node.js 18+ required. You have $(node -v)."
  exit 1
fi
echo "Node.js $(node -v) OK"

# Check Claude Code CLI
if ! command -v claude &> /dev/null; then
  echo "Error: Claude Code CLI not found."
  echo "Install it: npm install -g @anthropic-ai/claude-code"
  echo "Then login: claude auth login"
  exit 1
fi
echo "Claude CLI OK"

# Check if claude is authenticated
if ! claude -p "echo test" &> /dev/null; then
  echo ""
  echo "Warning: Claude Code may not be authenticated."
  echo "Run: claude auth login"
  echo ""
fi

INSTALL_DIR="$(cd "$(dirname "$0")/.." && pwd)"
HOME_DIR="$HOME"

echo ""
echo "Install directory: $INSTALL_DIR"
echo ""

# Install dependencies
echo "Installing dependencies..."
cd "$INSTALL_DIR"
npm install --production
echo ""

# Generate .env if it doesn't exist
if [ -f "$INSTALL_DIR/.env" ]; then
  echo ".env already exists, skipping credential setup."
else
  echo "--- Credential Setup ---"
  echo ""

  read -p "Login username: " TC_USER
  read -s -p "Login password: " TC_PASS
  echo ""
  read -p "Display name in UI [Claude Code]: " TC_NAME
  TC_NAME="${TC_NAME:-Claude Code}"

  JWT_SECRET=$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")
  PASS_HASH=$(node -e "require('bcryptjs').hash(process.argv[1],10).then(console.log)" "$TC_PASS")

  cat > "$INSTALL_DIR/.env" << ENVEOF
JWT_SECRET=$JWT_SECRET
USERNAME=$TC_USER
PASSWORD_HASH=$PASS_HASH
PORT=3456
BIND_HOST=127.0.0.1
CLAUDE_BIN=claude
CLAUDE_CWD=$HOME_DIR
DISPLAY_NAME=$TC_NAME
INACTIVITY_TIMEOUT=1800
ENVEOF

  echo ".env created."
fi

echo ""

# Systemd service
read -p "Install systemd service? [y/N] " INSTALL_SVC
if [[ "$INSTALL_SVC" =~ ^[Yy] ]]; then
  SVC_FILE="/etc/systemd/system/claude-code-chat.service"
  sed "s|__INSTALL_DIR__|$INSTALL_DIR|g; s|__HOME_DIR__|$HOME_DIR|g" \
    "$INSTALL_DIR/setup/claude-code-chat.service" | sudo tee "$SVC_FILE" > /dev/null
  sudo systemctl daemon-reload
  sudo systemctl enable claude-code-chat
  sudo systemctl start claude-code-chat
  echo "Service installed and started."
fi

echo ""

# Nginx
read -p "Install nginx config? [y/N] " INSTALL_NGX
if [[ "$INSTALL_NGX" =~ ^[Yy] ]]; then
  read -p "Domain name (e.g. chat.example.com): " DOMAIN
  NGX_FILE="/etc/nginx/sites-available/claude-code-chat"
  sed "s|__DOMAIN__|$DOMAIN|g" \
    "$INSTALL_DIR/setup/nginx-claude-code-chat.conf" | sudo tee "$NGX_FILE" > /dev/null
  sudo ln -sf "$NGX_FILE" /etc/nginx/sites-enabled/claude-code-chat
  sudo nginx -t && sudo systemctl reload nginx
  echo "Nginx configured for $DOMAIN"
  echo ""
  echo "For HTTPS, run: sudo certbot --nginx -d $DOMAIN"
fi

echo ""
echo "=== Setup Complete ==="
echo ""
echo "To start manually: cd $INSTALL_DIR && npm start"
echo "Default port: 3456"
echo ""
