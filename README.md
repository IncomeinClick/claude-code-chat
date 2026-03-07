# Tim Chat

Web chat UI for [Claude Code](https://docs.anthropic.com/en/docs/claude-code) CLI. Talk to Claude Code from your browser instead of the terminal.

![Dark theme, mobile-friendly](https://img.shields.io/badge/theme-dark-333?style=flat) ![Single file frontend](https://img.shields.io/badge/frontend-single%20HTML-da7756?style=flat)

## Features

- Streaming responses from Claude Code CLI
- Dark theme inspired by Claude.ai
- Mobile-friendly with large tap targets
- File upload via drag-and-drop or button
- Session timer and inactivity timeout
- Copy button on responses
- Tool use indicators (see what Claude is doing)
- JWT authentication with bcrypt password hashing
- Single HTML file frontend — no build step

## Prerequisites

- **Node.js 18+**
- **Claude Code CLI** installed and authenticated
  ```bash
  npm install -g @anthropic-ai/claude-code
  claude auth login
  ```

## Quick Start

```bash
git clone https://github.com/IncomeinClick/tim-chat.git
cd tim-chat
bash setup/install.sh
```

The install script will:
1. Install npm dependencies
2. Prompt for login credentials
3. Generate `.env` with hashed password and JWT secret
4. Optionally install systemd service and nginx config

## Manual Setup

```bash
# Install dependencies
npm install

# Generate JWT secret
npm run gen-secret
# Copy the output

# Hash your password
npm run hash-password "your-password"
# Copy the output

# Create .env from template
cp .env.example .env
# Edit .env and fill in JWT_SECRET, USERNAME, PASSWORD_HASH

# Start
npm start
```

## Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `JWT_SECRET` | — | Random 64-char hex string for signing tokens |
| `USERNAME` | — | Login username |
| `PASSWORD_HASH` | — | bcrypt hash of login password |
| `PORT` | `3456` | Server port |
| `BIND_HOST` | `127.0.0.1` | Listen address (`0.0.0.0` for direct access) |
| `CLAUDE_BIN` | `claude` | Path to Claude Code binary |
| `CLAUDE_CWD` | `$HOME` | Working directory for Claude sessions |
| `INACTIVITY_TIMEOUT` | `1800` | Seconds before idle session closes |

## Nginx + HTTPS

Template config is in `setup/nginx-tim-chat.conf`. To set up:

```bash
# Copy and edit the config
sudo cp setup/nginx-tim-chat.conf /etc/nginx/sites-available/tim-chat
sudo sed -i 's/__DOMAIN__/chat.example.com/g' /etc/nginx/sites-available/tim-chat
sudo ln -s /etc/nginx/sites-available/tim-chat /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx

# Add SSL
sudo certbot --nginx -d chat.example.com
```

## Architecture

```
Browser  <--WebSocket-->  Node.js server  <--stdin/stdout-->  Claude Code CLI
                          (Express + WS)                      (stream-json mode)
```

- **Backend:** Express serves the static HTML + handles JWT auth. WebSocket spawns Claude Code CLI per session using `--input-format stream-json --output-format stream-json`.
- **Frontend:** Single `public/index.html` file. No framework, no build step. Vanilla JS + CSS.
- **Auth:** JWT token stored in localStorage, bcrypt-hashed password in `.env`.

## Security Notes

- Listens on `127.0.0.1` by default — put behind a reverse proxy with HTTPS for production
- Single-user / small-team use. Not designed for multi-tenant deployment
- `.env` contains secrets — never commit it (already in `.gitignore`)
- Claude Code runs with the permissions of the server process user

## License

MIT
