# Claude Code Chat

Web chat UI for [Claude Code](https://docs.anthropic.com/en/docs/claude-code) CLI running on a remote server. Access Claude Code from your browser — ideal for VPS, cloud instances, or any headless server where you can't use a terminal directly.

![Dark theme, mobile-friendly](https://img.shields.io/badge/theme-dark-333?style=flat) ![Single file frontend](https://img.shields.io/badge/frontend-single%20HTML-da7756?style=flat)

## Features

- Streaming responses from Claude Code CLI
- Dark theme inspired by Claude.ai
- Mobile-friendly with large tap targets
- File upload via drag-and-drop or button
- Inactivity countdown timer (starts after first message, resets on user activity, turns red under 1 minute, auto-refreshes on timeout)
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
git clone https://github.com/IncomeinClick/claude-code-chat.git
cd claude-code-chat
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

## Claude Code Permissions

Claude Code requires pre-approved permissions to take actions (read/write files, run commands) without interactive confirmation. Since the chat UI can't prompt for approval, permissions must be configured in advance.

This repo includes `.claude/settings.json` with a default allowlist. When `CLAUDE_CWD` points to this project directory, Claude Code will automatically pick up these permissions.

**How it works:**
- `.claude/settings.json` (project-level) — shipped with the repo, applies when Claude runs in this directory
- `~/.claude/settings.json` (user-level) — optional, applies globally for the user regardless of working directory

**If Claude is blocked from taking actions**, either:
1. Set `CLAUDE_CWD` to the project directory (where `.claude/settings.json` lives) in your `.env`
2. Or copy `.claude/settings.json` to `~/.claude/settings.json` on the server

**To customize permissions**, edit `.claude/settings.json`. Format:
```json
{
  "permissions": {
    "allow": [
      "Read",
      "Write",
      "Edit",
      "Bash(git *)",
      "..."
    ]
  }
}
```

See [Claude Code docs](https://docs.anthropic.com/en/docs/claude-code) for the full list of permission patterns.

## Security Notes

- Listens on `127.0.0.1` by default — put behind a reverse proxy with HTTPS for production
- Single-user / small-team use. Not designed for multi-tenant deployment
- `.env` contains secrets — never commit it (already in `.gitignore`)
- Claude Code runs with the permissions of the server process user

## License

MIT
