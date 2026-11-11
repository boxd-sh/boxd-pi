# Security

Please don't report security problems in public issues.

Report them privately through
[GitHub's vulnerability reporting](https://github.com/boxd-sh/boxd-pi/security/advisories/new),
or email [contact@boxd.sh](mailto:contact@boxd.sh). Include what you found, how
to reproduce it, and the version of `@boxd-sh/pi` you use. We'll confirm we
received it and keep you posted while we fix it.

## What reaches the machine

The machine runs whatever the agent runs, as a user with sudo. Treat
everything in it as controlled by the agent.

- Your boxd API key stays on your computer. Machines are created isolated:
  no boxd credentials inside, and not on your org's private network.
- Of your environment, only Pi's `PI_*` session variables go with a command.
- **Your GitHub token goes to the machine twice: for the clone, and for every
  `/boxd push`.** Git runs in the machine, so the token (from `gh auth token`
  on your computer) is in that one command's environment. It is not written
  to the machine's git config or disk, and it is only used when the repo is
  on `https://github.com`.

The clone runs on a new machine, before the agent has done anything in it.
A push is different. By then the agent has worked in the machine, and a
process there that wants your token can take it while the push runs: for
example through a changed `git` binary or a git setting that routes the
request elsewhere. The extension narrows this, and can't close it:

- the push runs with git hooks off (`core.hooksPath=/dev/null`);
- the token is sent only if `origin` in the machine is still the URL the
  extension cloned, and the push goes to that URL. If `origin` was changed,
  `/boxd push` stops and sends nothing;
- a workspace that was not cloned (`--boxd-no-repo`) never gets the token.

So `/boxd push` gives your token to the machine for the length of that
command. If you don't trust what ran in the machine, don't use `/boxd push`.
Fetch the work another way, or use a `gh` login with a fine-grained token that
can only write to that one repo.

Preview URLs (`preview_url`, `/boxd url`) are public to anyone who has the
link.

## Supported versions

Fixes go into the latest release.

## Scope

This repo holds the `@boxd-sh/pi` package and its examples. Issues in boxd
itself, such as the API or the machines, can go to the same addresses.

## Running agents safely

With `--boxd`, Pi's agent can run any command in its machine. That machine is
a full VM with its own kernel, so a command can't reach your own computer, but
it can reach the internet and anything the machine can.

- Every machine the extension creates or forks is isolated: it is not on your
  org's private network and has no boxd credentials inside. Your boxd API key
  stays on your computer, and only Pi's `PI_*` variables go with a command.
- For a private GitHub repo, your `gh` token goes with the clone and with
  `/boxd push`, for that one command. It is not written to the machine, but a
  process running in the machine at that moment could read it. Leave out
  `--boxd-repo` and use `--boxd-no-repo` if you don't want that.
- Preview URLs are public to anyone with the link. Don't serve anything
  secret on them.
- Machines of saved sessions stay hibernated until you delete them. Use
  `/boxd delete`, or `--no-session` for a machine that goes when Pi exits.
- Before a risky step, save a checkpoint of the machine
  (`client.machines.checkpoints` in the boxd SDK, or the boxd console) so you
  can go back to it.
