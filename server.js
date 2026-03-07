const http = require("http");
const express = require("express");
const { WebSocketServer } = require("ws");
const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");
const jwt = require("jsonwebtoken");
const bcrypt = require("bcryptjs");
const crypto = require("crypto");

// Load env
const envFile = fs.readFileSync(path.join(__dirname, ".env"), "utf8");
const env = {};
for (const line of envFile.split("\n")) {
  const i = line.indexOf("=");
  if (i > 0) env[line.slice(0, i).trim()] = line.slice(i + 1).trim();
}

const JWT_SECRET = env.JWT_SECRET;
const USERNAME = env.USERNAME;
const PASSWORD_HASH = env.PASSWORD_HASH;
const PORT = parseInt(env.PORT) || 3456;
const CLAUDE_BIN = env.CLAUDE_BIN || "claude";
const CLAUDE_CWD = env.CLAUDE_CWD || process.env.HOME || "/root";
const BIND_HOST = env.BIND_HOST || "127.0.0.1";
const INACTIVITY_TIMEOUT = (parseInt(env.INACTIVITY_TIMEOUT) || 1800) * 1000;
const DISPLAY_NAME = env.DISPLAY_NAME || "Claude Code";

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

app.get("/api/config", (req, res) => {
  res.json({ displayName: DISPLAY_NAME });
});

app.post("/api/login", async (req, res) => {
  const { username, password } = req.body;
  if (username !== USERNAME) return res.status(401).json({ error: "Invalid credentials" });
  const valid = await bcrypt.compare(password, PASSWORD_HASH);
  if (!valid) return res.status(401).json({ error: "Invalid credentials" });
  const token = jwt.sign({ user: username }, JWT_SECRET, { expiresIn: "24h" });
  res.json({ token });
});

function verifyToken(token) {
  try { return jwt.verify(token, JWT_SECRET); } catch { return null; }
}

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: "/ws" });
const sessions = new Map();

function cleanEnv() {
  const e = { ...process.env, HOME: CLAUDE_CWD };
  delete e.CLAUDECODE;
  delete e.CLAUDE_CODE_SESSION;
  return e;
}

function safeSend(ws, data) {
  if (ws.readyState === 1) ws.send(JSON.stringify(data));
}

wss.on("connection", (ws, req) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const token = url.searchParams.get("token");
  const user = verifyToken(token);
  if (!user) { ws.close(4001, "Unauthorized"); return; }

  const sessionId = crypto.randomUUID();
  console.log(`[${sessionId}] Connected: ${user.user}`);

  const session = {
    id: sessionId, ws, claude: null,
    startTime: Date.now(), lastActivity: Date.now(),
    inactivityTimer: null,
  };
  sessions.set(sessionId, session);
  safeSend(ws, { type: "session_start", sessionId, startTime: session.startTime, timeoutMs: INACTIVITY_TIMEOUT });

  session.claude = null;

  function spawnClaude() {
    const proc = spawn(CLAUDE_BIN, [
      "-p",
      "--output-format", "stream-json",
      "--input-format", "stream-json",
      "--include-partial-messages",
      "--verbose",
    ], {
      cwd: CLAUDE_CWD,
      env: cleanEnv(),
      stdio: ["pipe", "pipe", "pipe"],
    });

    let buffer = "";
    proc.stdout.on("data", (chunk) => {
      buffer += chunk.toString();
      const lines = buffer.split("\n");
      buffer = lines.pop();
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const event = JSON.parse(line);
          safeSend(ws, { type: "claude", event });
        } catch {}
      }
    });

    proc.stderr.on("data", (chunk) => {
      const msg = chunk.toString();
      if (msg.trim()) {
        console.error(`[${sessionId}] stderr: ${msg.trim()}`);
        safeSend(ws, { type: "stderr", text: msg });
      }
    });

    proc.on("close", (code) => {
      console.log(`[${sessionId}] Claude exited: ${code}`);
      safeSend(ws, { type: "exit", code });
    });

    return proc;
  }

  function sendToClaudeInput(text) {
    const msg = JSON.stringify({
      type: "user",
      message: { role: "user", content: text },
    }) + "\n";
    if (session.claude?.stdin?.writable) {
      session.claude.stdin.write(msg);
    }
  }

  function resetInactivityTimer() {
    if (session.inactivityTimer) clearTimeout(session.inactivityTimer);
    session.inactivityTimer = setTimeout(() => {
      safeSend(ws, { type: "timeout" });
      if (session.claude) session.claude.kill();
      ws.close(4002, "Inactivity timeout");
    }, INACTIVITY_TIMEOUT);
  }
  resetInactivityTimer();

  ws.on("message", (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    session.lastActivity = Date.now();
    resetInactivityTimer();

    if (msg.type === "chat") {
      if (!session.claude) {
        session.claude = spawnClaude();
      }
      sendToClaudeInput(msg.content);
    } else if (msg.type === "end_session") {
      if (session.claude) session.claude.kill();
      safeSend(ws, { type: "exit", code: 0 });
      ws.close(1000, "Session ended");
    }
  });

  ws.on("close", () => {
    console.log(`[${sessionId}] Disconnected`);
    if (session.inactivityTimer) clearTimeout(session.inactivityTimer);
    if (session.claude) session.claude.kill();
    sessions.delete(sessionId);
  });
});

server.listen(PORT, BIND_HOST, () => {
  console.log(`Tim Chat server running on ${BIND_HOST}:${PORT}`);
});
