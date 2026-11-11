#!/usr/bin/env bash
# One machine per pi session, kept with it. The first run sets up a project and starts a server in
# the background. Quitting pi hibernates the machine, memory included. A public preview URL wakes it,
# and the second run resumes the session: same machine, same files, the server still running.
#
#   ./persistent-session.sh          # deletes the machine at the end
#   ./persistent-session.sh --keep   # keeps it (hibernated); resume with the printed command
source "$(dirname "$0")/_common.sh"
SESSION="$(new_id)"

echo "== run 1: set up, start a server, get a preview URL"
pi_boxd --session-id "$SESSION" -p "Create notes.md with one line: 'started by run 1'. Commit it with \
git. Then start 'python3 -m http.server 8000' in the background, check it answers, and call \
preview_url for port 8000. Reply with just the preview URL on the last line." | tee run1.txt
URL="$(grep -oE 'https://p8000\.[A-Za-z0-9.-]+' run1.txt | tail -n 1)"

echo "== pi has quit and the machine is hibernating. Opening $URL"
# The route's certificate can take up to a minute the first time. The request wakes the machine.
code=000
for _ in $(seq 1 90); do
	code="$(curl -s -o /dev/null -w '%{http_code}' "$URL/notes.md" || true)"
	[ "$code" = 200 ] && break
	sleep 2
done
echo "GET $URL/notes.md -> $code"

echo "== run 2: resume the session"
pi_boxd --session-id "$SESSION" -p "Show notes.md and 'git log --oneline'. Is anything listening on \
port 8000? Show the process with 'pgrep -af http.server'."

if [ "${1:-}" = "--keep" ]; then
	echo "Kept. Resume with: pi --boxd --session-dir $SESSIONS --session-id $SESSION (from $WORKDIR)"
else
	pi_boxd --session-id "$SESSION" -p "/boxd delete --yes" >/dev/null
fi
