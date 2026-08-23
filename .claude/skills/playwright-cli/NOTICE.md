# Source

`SKILL.md` and `references/` in this directory are vendored verbatim from
[microsoft/playwright-cli](https://github.com/microsoft/playwright-cli)
(`skills/playwright-cli/`, commit `2f85a94b7b885dbf4a5d34462f253a8746a690c9`).
Apache-2.0 licensed. The actual `playwright-cli` binary comes from the
`@playwright/cli` devDependency in `backend/package.json` -- this skill
folder is only the usage documentation.

Check upstream periodically for updates; this copy will not update itself.

## Making it run in a Claude Code sandbox session

`playwright-cli open` defaults to launching the real Chrome browser
channel, which isn't installed in this kind of sandbox (only the bundled
Chromium at `/opt/pw-browsers/chromium` is). Root-in-a-container also
trips Chromium's sandbox unless it's explicitly disabled. Neither of
these belongs in a config committed to the repo -- `executablePath`
pointing at this specific container's browser path, and disabling
Chromium's own sandbox, would silently misconfigure (and de-sandbox) a
real contributor's local machine, so `.playwright/` is gitignored and this
file exists instead so the fix doesn't need rediscovering from scratch.

From `backend/`, before the first `playwright-cli` command each session:

```bash
mkdir -p .playwright
cat > .playwright/cli.config.json <<'EOF'
{
  "browser": {
    "browserName": "chromium",
    "launchOptions": {
      "executablePath": "/opt/pw-browsers/chromium",
      "chromiumSandbox": false
    }
  }
}
EOF
```

Then `playwright-cli open <url>` (no `--browser` flag -- the config
supplies it) works against `localhost` targets. External sites may still
fail with `ERR_TUNNEL_CONNECTION_FAILED` under this environment's egress
proxy; that's a network-policy issue, not a `playwright-cli` one, and
doesn't affect verifying this app's own dev server or the static
marketing site.
