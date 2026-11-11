# Changelog

## 0.1.0 (unreleased)

Initial release.

- `pi --boxd` runs Pi's `bash`, `read`, `write`, `edit`, `ls`, `find` and
  `grep`, and user `!` commands, in a boxd machine while the agent runs on
  your computer. A tool never falls back to your computer.
- One isolated machine per Pi session: reattached and woken on resume, forked
  with its running processes when you fork the session, hibernated when you
  quit, deleted when an in-memory session (`--no-session`) ends.
- Clones the checkout's `origin` at your branch, another repo
  (`--boxd-repo`, `--boxd-branch`) or starts an empty workspace
  (`--boxd-no-repo`). Uses your `gh` token for GitHub, for that one command.
- `--boxd-size`, `--boxd-region`, `--boxd-org` and `--boxd-snapshot` for new
  machines.
- `preview_url` tool and `/boxd url <port>` for public HTTPS links to servers
  in the machine.
- `/boxd status`, `/boxd hibernate`, `/boxd push [branch]` and
  `/boxd delete [--yes]`.
- Three examples (`examples/`): a quick start, a persistent session that
  hibernates between runs, and two agents working on two forks in parallel.
