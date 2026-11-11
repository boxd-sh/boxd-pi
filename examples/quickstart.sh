#!/usr/bin/env bash
# A fresh boxd machine for one prompt. The agent runs here; its commands run in the machine.
# --no-session makes the session in-memory, so the extension deletes the machine when pi exits.
source "$(dirname "$0")/_common.sh"

pi_boxd --no-session -p "Show the output of 'uname -a' and 'whoami'. Then write fib.py that prints the \
first 20 Fibonacci numbers, run it, and show me the output."
