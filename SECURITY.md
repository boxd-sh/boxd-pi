# Security

Please don't report security problems in public issues.

Report them privately through
[GitHub's vulnerability reporting](https://github.com/boxd-sh/boxd-pi/security/advisories/new),
or email [contact@boxd.sh](mailto:contact@boxd.sh). Include what you found, how
to reproduce it, and the version of `@boxd-sh/pi` you use. We'll confirm we
received it and keep you posted while we fix it.

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
