#!/usr/bin/env python3
"""PTY helper for claude auth login. Captures OAuth URL and reports status as JSON."""
import pty, os, sys, select, re, json, signal, time

def strip_ansi(s):
    return re.sub(r'\x1b\[[0-9;]*[A-Za-z]|\x1b\[\?[0-9;]*[A-Za-z]', '', s)

def main():
    claude_bin = sys.argv[1] if len(sys.argv) > 1 else 'claude'
    env = dict(os.environ)
    env.pop('CLAUDECODE', None)
    env.pop('CLAUDE_CODE_SESSION', None)

    pid, fd = pty.fork()
    if pid == 0:
        os.execvpe(claude_bin, [claude_bin, 'auth', 'login'], env)
        sys.exit(1)

    url_found = False
    output = ''
    start = time.time()
    timeout = 120

    while time.time() - start < timeout:
        r, _, _ = select.select([fd], [], [], 1.0)
        if r:
            try:
                data = os.read(fd, 4096)
                if not data:
                    break
                output += strip_ansi(data.decode('utf-8', errors='replace'))
                if not url_found:
                    match = re.search(r'(https://claude\.ai/oauth/authorize\S+)', output)
                    if match:
                        url = match.group(1).rstrip('\r\n')
                        print(json.dumps({"status": "url", "url": url}), flush=True)
                        url_found = True
            except OSError:
                break

        # Check if child exited
        try:
            wpid, wstatus = os.waitpid(pid, os.WNOHANG)
            if wpid != 0:
                code = os.WEXITSTATUS(wstatus) if os.WIFEXITED(wstatus) else 1
                print(json.dumps({"status": "done", "exit_code": code}), flush=True)
                try:
                    os.close(fd)
                except:
                    pass
                return
        except ChildProcessError:
            break

    # Timeout or error
    try:
        os.kill(pid, signal.SIGTERM)
        time.sleep(0.5)
        os.kill(pid, signal.SIGKILL)
    except ProcessLookupError:
        pass
    try:
        os.waitpid(pid, 0)
    except:
        pass
    try:
        os.close(fd)
    except:
        pass
    print(json.dumps({"status": "done", "exit_code": -1}), flush=True)

if __name__ == '__main__':
    main()
