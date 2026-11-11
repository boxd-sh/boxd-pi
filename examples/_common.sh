# Shared setup for the examples. Source it; don't run it.
#
# Needs pi on PATH, BOXD_API_KEY, and a model key pi can use (for example ANTHROPIC_API_KEY).
# PI_MODEL picks the model (any `pi --model` pattern). From a clone of this repo, set
# PI_BOXD_EXTENSION=. to load the extension from the checkout instead of the installed package.

set -euo pipefail

: "${BOXD_API_KEY:?set BOXD_API_KEY (create one at https://app.boxd.sh)}"

if [ -n "${PI_BOXD_EXTENSION:-}" ]; then
	PI_BOXD_EXTENSION="$(cd "$PI_BOXD_EXTENSION" && pwd)/index.ts"
fi

# A scratch directory per run, so the examples never clone or touch the project you run them from.
WORKDIR="$(mktemp -d)"
cd "$WORKDIR"
SESSIONS="$WORKDIR/sessions"

# pi with the boxd extension on, sessions kept in the scratch directory. stdin is closed because
# pi -p adds piped stdin to the prompt and would wait for it.
pi_boxd() {
	pi ${PI_BOXD_EXTENSION:+-e "$PI_BOXD_EXTENSION"} ${PI_MODEL:+--model "$PI_MODEL"} \
		--boxd --boxd-no-repo --session-dir "$SESSIONS" "$@" </dev/null
}

new_id() {
	node -e 'console.log(crypto.randomUUID())'
}
