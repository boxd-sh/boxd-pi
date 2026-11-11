#!/usr/bin/env bash
# Set a project up once, then fork the session twice. Each fork gets its own copy of the machine
# (disk, memory and running processes), and two agents try two approaches at the same time.
source "$(dirname "$0")/_common.sh"
BASE="$(new_id)"
A="$(new_id)"
B="$(new_id)"

echo "== base: set up the project"
pi_boxd --session-id "$BASE" -p "Write slow.py with a recursive fib(n) and a main that prints \
fib(32) and how long it took. Run it, commit it with git, and reply with the timing."

echo "== two forks, in parallel"
pi_boxd --fork "$BASE" --session-id "$A" -p "Make fib in slow.py fast with functools.lru_cache. Run it, \
commit, and reply with the new timing and the output of 'hostname'." >fork-a.txt &
pi_boxd --fork "$BASE" --session-id "$B" -p "Make fib in slow.py fast with an iterative loop. Run it, \
commit, and reply with the new timing and the output of 'hostname'." >fork-b.txt &
wait
echo "== fork A (lru_cache)"; cat fork-a.txt
echo "== fork B (loop)"; cat fork-b.txt

if [ "${1:-}" != "--keep" ]; then
	for s in "$A" "$B" "$BASE"; do pi_boxd --session-id "$s" -p "/boxd delete --yes" >/dev/null; done
fi
