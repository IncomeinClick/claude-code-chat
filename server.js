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
app.use(express.json({ limit: "20mb" }));
// Prevent browser from caching index.html (so code updates take effect immediately)
app.use((req, res, next) => {
  if (req.path === "/" || req.path === "/index.html") {
    res.set("Cache-Control", "no-store, no-cache, must-revalidate");
    res.set("Pragma", "no-cache");
  }
  next();
});
app.use(express.static(path.join(__dirname, "public")));

app.get("/api/config", (req, res) => {
  res.json({ displayName: DISPLAY_NAME });
});

// List past Claude sessions for resume picker
app.get("/api/sessions", (req, res) => {
  const authHeader = req.headers.authorization;
  if (!authHeader || !verifyToken(authHeader.replace("Bearer ", ""))) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const sessionDir = path.join(CLAUDE_CWD, ".claude", "projects", "-root");
  const sessions = [];
  const trivialMsgs = new Set(["hi", "hello", "hey", "yo", "sup", "test", "ok", "okay", "thanks", "thank you", "สวัสดี", "ดี", "หวัดดี"]);

  function extractText(msg) {
    if (!msg || typeof msg !== "object") return null;
    const content = msg.content;
    if (typeof content === "string" && content.trim()) return content.trim();
    if (Array.isArray(content)) {
      for (const block of content) {
        if (block && block.type === "text" && block.text && block.text.trim()) return block.text.trim();
      }
    }
    return null;
  }

  try {
    const files = fs.readdirSync(sessionDir).filter(f => f.endsWith(".jsonl") && !f.includes("/"));
    for (const file of files) {
      const sid = file.replace(".jsonl", "");
      const fullPath = path.join(sessionDir, file);
      const mtime = fs.statSync(fullPath).mtime.toISOString();
      let timestamp = null;
      const userMsgs = [];
      let msgCount = 0;

      try {
        const content = fs.readFileSync(fullPath, "utf8");
        for (const line of content.split("\n")) {
          if (!line.trim()) continue;
          let obj;
          try { obj = JSON.parse(line); } catch { continue; }

          if (!timestamp) {
            const ts = obj.timestamp || (obj.snapshot && obj.snapshot.timestamp);
            if (ts) timestamp = ts;
          }

          if (obj.type === "user") {
            msgCount++;
            const text = extractText(obj.message);
            if (text) userMsgs.push(text);
          }
        }

        if (userMsgs.length === 0) continue;

        // Find first meaningful message (skip trivial greetings)
        let topicMsg = userMsgs.find(m => !trivialMsgs.has(m.toLowerCase().replace(/[!.\s]+$/, ""))) || userMsgs[0];
        const lastMsg = userMsgs[userMsgs.length - 1];

        // Build summary: topic + last message (if different)
        let summary = topicMsg.slice(0, 120);
        if (userMsgs.length > 1 && lastMsg !== topicMsg) {
          summary += " → " + lastMsg.slice(0, 80);
        }

        sessions.push({
          id: sid,
          timestamp: timestamp || "unknown",
          lastActive: mtime,
          summary,
          msgCount,
        });
      } catch {}
    }

    sessions.sort((a, b) => (b.lastActive || "").localeCompare(a.lastActive || ""));
    res.json({ sessions: sessions.slice(0, 20) });
  } catch (e) {
    res.json({ sessions: [] });
  }
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

// Re-authentication flow
let reauthState = null; // { proc, url, status, startTime }

app.post("/api/reauth", (req, res) => {
  const authHeader = req.headers.authorization;
  if (!authHeader || !verifyToken(authHeader.replace("Bearer ", ""))) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  // If already running, return current state
  if (reauthState && reauthState.status === "running") {
    return res.json({ status: "running", url: reauthState.url });
  }

  const proc = spawn("python3", [
    path.join(__dirname, "auth-helper.py"), CLAUDE_BIN
  ], { cwd: CLAUDE_CWD, env: cleanEnv(), stdio: ["ignore", "pipe", "pipe"] });

  reauthState = { proc, url: null, status: "running", startTime: Date.now() };

  let buf = "";
  proc.stdout.on("data", (chunk) => {
    buf += chunk.toString();
    const lines = buf.split("\n");
    buf = lines.pop();
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const msg = JSON.parse(line);
        if (msg.status === "url") reauthState.url = msg.url;
        if (msg.status === "done") {
          reauthState.status = msg.exit_code === 0 ? "success" : "failed";
        }
      } catch {}
    }
  });

  proc.on("close", (code) => {
    if (reauthState && reauthState.status === "running") {
      reauthState.status = code === 0 ? "success" : "failed";
    }
    console.log(`[reauth] Process exited: ${code}, status: ${reauthState?.status}`);
  });

  // Safety timeout
  setTimeout(() => {
    if (reauthState?.status === "running") {
      proc.kill();
      reauthState.status = "failed";
    }
  }, 130000);

  res.json({ status: "started" });
});

app.get("/api/reauth/status", (req, res) => {
  const authHeader = req.headers.authorization;
  if (!authHeader || !verifyToken(authHeader.replace("Bearer ", ""))) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  if (!reauthState) return res.json({ status: "idle" });
  res.json({ status: reauthState.status, url: reauthState.url });
});

// Check for detached sessions (Claude still running after WS drop)
app.get("/api/detached", (req, res) => {
  const authHeader = req.headers.authorization;
  if (!authHeader || !verifyToken(authHeader.replace("Bearer ", ""))) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  const ids = Array.from(detachedSessions.keys());
  res.json({ sessions: ids });
});

// Upload endpoint — save pasted images/files to tmp
const UPLOAD_DIR = "/tmp/claude-code-chat-uploads";
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

app.post("/api/upload", (req, res) => {
  const authHeader = req.headers.authorization;
  if (!authHeader || !verifyToken(authHeader.replace("Bearer ", ""))) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  const { data, filename, type } = req.body;
  console.log(`[upload] filename=${filename} type=${type} dataLen=${data ? data.length : 0}`);
  if (!data) return res.status(400).json({ error: "No data" });
  const ext = (filename || "file").split(".").pop() || "png";
  const safeName = `${Date.now()}-${crypto.randomBytes(4).toString("hex")}.${ext}`;
  const filePath = path.join(UPLOAD_DIR, safeName);
  fs.writeFileSync(filePath, Buffer.from(data, "base64"));
  console.log(`[upload] saved: ${filePath}`);
  res.json({ path: filePath, name: safeName });
});

// Session history — read Claude session JSONL for replay on reconnect
app.get("/api/session-history/:sessionId", (req, res) => {
  const authHeader = req.headers.authorization;
  if (!authHeader || !verifyToken(authHeader.replace("Bearer ", ""))) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  const sid = req.params.sessionId;
  // Sanitize to prevent path traversal
  if (sid.includes("/") || sid.includes("..")) return res.status(400).json({ error: "Invalid session ID" });
  const sessionFile = path.join(CLAUDE_CWD, ".claude", "projects", "-root", `${sid}.jsonl`);
  if (!fs.existsSync(sessionFile)) return res.json({ messages: [] });

  try {
    const content = fs.readFileSync(sessionFile, "utf8");
    const messages = [];
    for (const line of content.split("\n")) {
      if (!line.trim()) continue;
      let obj;
      try { obj = JSON.parse(line); } catch { continue; }

      if (obj.type === "user") {
        let text = null;
        const c = obj.message?.content;
        if (typeof c === "string") text = c;
        else if (Array.isArray(c)) {
          for (const b of c) { if (b.type === "text" && b.text) { text = b.text; break; } }
        }
        if (text) messages.push({ role: "user", text });
      } else if (obj.type === "assistant") {
        let text = null;
        const c = obj.message?.content;
        if (typeof c === "string") text = c;
        else if (Array.isArray(c)) {
          const texts = [];
          for (const b of c) { if (b.type === "text" && b.text) texts.push(b.text); }
          if (texts.length) text = texts.join("\n");
        }
        if (text) messages.push({ role: "assistant", text });
      }
    }
    // Return last 30 messages to keep payload reasonable
    res.json({ messages: messages.slice(-30) });
  } catch {
    res.json({ messages: [] });
  }
});

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: "/ws" });
const sessions = new Map();
const detachedSessions = new Map(); // sessions kept alive after WS disconnect
const DETACH_GRACE_MS = 30 * 60 * 1000; // keep Claude alive 30 min after disconnect

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

  const resumeId = url.searchParams.get("resume") || null;
  const reattachId = url.searchParams.get("reattach") || null;
  const sessionId = crypto.randomUUID();

  // Try to reattach to a detached session (Claude still running after WS drop)
  let session;
  if (reattachId && detachedSessions.has(reattachId)) {
    const detached = detachedSessions.get(reattachId);
    clearTimeout(detached.graceTimer);
    detachedSessions.delete(reattachId);
    console.log(`[${detached.id}] Reattached (was detached)`);

    session = detached;
    session.ws = ws;
    sessions.set(detached.id, session);

    safeSend(ws, { type: "session_start", sessionId: session.id, startTime: session.startTime, timeoutMs: INACTIVITY_TIMEOUT });
    safeSend(ws, { type: "reattached", bufferedEvents: session.detachBuffer || [], claudeRunning: !!session.claude });
    session.detachBuffer = null;

    // Replay current state — if Claude is still running, client should show thinking
    if (session.claude) {
      safeSend(ws, { type: "claude", event: { type: "system", subtype: "init", session_id: session.claudeSessionId } });
    }
  } else {
    console.log(`[${sessionId}] Connected: ${user.user}${resumeId ? ` (resume: ${resumeId})` : ""}`);

    session = {
      id: sessionId, ws, claude: null, claudeSessionId: null,
      startTime: Date.now(), lastActivity: Date.now(),
      inactivityTimer: null, resumeId, stopping: false,
      detachBuffer: null, graceTimer: null,
    };
    sessions.set(sessionId, session);
    safeSend(ws, { type: "session_start", sessionId, startTime: session.startTime, timeoutMs: INACTIVITY_TIMEOUT });
  }

  function sessionSend(data) {
    // If WS is detached, buffer events for replay on reattach
    if (session.detachBuffer) {
      session.detachBuffer.push(data);
      // Cap buffer to prevent memory issues
      if (session.detachBuffer.length > 500) session.detachBuffer.shift();
      return;
    }
    safeSend(session.ws, data);
  }

  function spawnClaude() {
    const args = [
      "-p",
      "--output-format", "stream-json",
      "--input-format", "stream-json",
      "--include-partial-messages",
      "--verbose",
      "--permission-mode", "auto",
    ];
    if (session.resumeId) args.push("--resume", session.resumeId);
    const proc = spawn(CLAUDE_BIN, args, {
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
          // Capture Claude session ID for reconnection
          if (event.type === "system" && event.subtype === "init" && event.session_id) {
            session.claudeSessionId = event.session_id;
          }
          sessionSend({ type: "claude", event });
        } catch {}
      }
    });

    proc.stderr.on("data", (chunk) => {
      const msg = chunk.toString();
      if (msg.trim()) {
        console.error(`[${session.id}] stderr: ${msg.trim()}`);
        sessionSend({ type: "stderr", text: msg });
      }
    });

    proc.on("close", (code) => {
      console.log(`[${session.id}] Claude exited: ${code}`);
      session.claude = null;
      if (session.stopping) {
        session.stopping = false;
        // Preserve session so next message resumes the same conversation
        if (session.claudeSessionId) {
          session.resumeId = session.claudeSessionId;
        }
        sessionSend({ type: "stopped" });
      } else {
        sessionSend({ type: "exit", code });
      }
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
      sessionSend({ type: "timeout" });
      if (session.claude) session.claude.kill();
      if (session.ws.readyState === 1) session.ws.close(4002, "Inactivity timeout");
    }, INACTIVITY_TIMEOUT);
  }

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
    } else if (msg.type === "stop") {
      if (session.claude) {
        session.stopping = true;
        session.claude.kill("SIGINT");
      }
    } else if (msg.type === "end_session") {
      if (session.claude) session.claude.kill();
      sessionSend({ type: "exit", code: 0 });
      ws.close(1000, "Session ended");
    }
  });

  ws.on("close", () => {
    if (session.inactivityTimer) clearTimeout(session.inactivityTimer);
    sessions.delete(session.id);

    // If Claude is still running, detach instead of killing
    if (session.claude) {
      console.log(`[${session.id}] WS dropped — detaching (Claude still running, grace: ${DETACH_GRACE_MS/1000}s)`);
      session.detachBuffer = [];
      session.graceTimer = setTimeout(() => {
        console.log(`[${session.id}] Grace period expired — killing Claude`);
        if (session.claude) session.claude.kill();
        detachedSessions.delete(session.id);
      }, DETACH_GRACE_MS);
      detachedSessions.set(session.id, session);
    } else {
      console.log(`[${session.id}] Disconnected (no active Claude)`);
    }
  });
});

server.listen(PORT, BIND_HOST, () => {
  console.log(`Claude Code Chat server running on ${BIND_HOST}:${PORT}`);
});
