# Publishing

Nothing here is published yet.

1. Check everything, against real boxd too:

   ```sh
   npm ci
   npm run check
   BOXD_E2E=1 BOXD_API_KEY=... npm run test:live
   ```

   `npm run check` runs Biome (lint and format), `tsc`, the unit tests and an
   offline load test. The live test runs against production unless
   `BOXD_BASE_URL` is set, and deletes every machine it creates.

2. Run the three examples with a real model, from the checkout:

   ```sh
   export BOXD_API_KEY=... ANTHROPIC_API_KEY=... PI_BOXD_EXTENSION=.
   ./examples/quickstart.sh
   ./examples/persistent-session.sh
   ./examples/parallel-forks.sh
   ```

   Then check in the boxd console that none of their machines is left.

3. Pack and look at the tarball:

   ```sh
   npm pack --dry-run
   npm pack
   ```

   It holds `index.ts`, `src/`, `README.md`, `CHANGELOG.md`, `LICENSE` and
   `package.json`, and nothing else.

4. Install the tarball the way users do and run the README quick start from
   it, so you test what users get:

   ```sh
   pi install ./boxd-sh-pi-0.1.0.tgz   # or into a fresh npm project
   cd "$(mktemp -d)"
   pi --boxd --boxd-no-repo --no-session -p "Run uname -a and tell me where you are."
   ```

5. Set the date in `CHANGELOG.md`. The first release ships `0.1.0` as it
   stands in `package.json`; bump `version` there for every later release.

6. Switch the README banner to its full URL,
   `https://raw.githubusercontent.com/boxd-sh/boxd-pi/main/assets/banner.png`:
   npm doesn't show relative images. `pi.image` in `package.json` already
   uses it, and both work once the repo is public.

7. Publish, then tag:

   ```sh
   npm publish --access public
   git tag v0.1.0 && git push --tags
   ```

8. Check that `pi install npm:@boxd-sh/pi` works, and that the package shows
   up with its banner in the [Pi package gallery](https://pi.dev/packages)
   (it lists npm packages with the `pi-package` keyword).
