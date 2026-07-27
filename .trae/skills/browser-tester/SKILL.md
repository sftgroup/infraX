---
name: "browser-tester"
description: "Browser automation and E2E testing for InfraX Web3 platform. Uses playwright-cli (page ops) + chrome-devtools-mcp (deep DevTools). Invoke when user asks to test InfraX pages, run E2E flows, debug frontend, or inspect network/console."
allowed-tools: Bash(playwright-cli:*) Bash(npx:*) Bash(chrome-devtools-mcp:*)
---

# InfraX Browser Tester

Combines **playwright-cli** (page automation) and **chrome-devtools-mcp** (DevTools deep inspection) for browser-based testing of the InfraX platform.

## Quick start

```bash
# Launch browser and navigate to InfraX
playwright-cli open http://43.156.99.215:9111

# Take snapshot to see page structure
playwright-cli snapshot

# Click elements by ref (from snapshot)
playwright-cli click e15

# Run JavaScript in page
playwright-cli eval "document.title"

# Close browser
playwright-cli close
```

## Installed tools

| Tool | Location | Purpose |
|------|----------|---------|
| `playwright-cli` | global | Page automation (click, type, snapshot, eval) |
| `chrome-devtools-mcp` | global (npx) | DevTools deep inspection (network, console, performance) |
| Chromium | `/root/.cache/ms-playwright/chromium-1232` | Browser engine |

## InfraX test config

### URLs

```
Production:   http://43.156.99.215:9111
Landing:      http://43.156.99.215:9111/landing.html
Connect:      http://43.156.99.215:9111/connect.html
Admin:        http://43.156.99.215:9111/admin-login.html
Dashboard:    http://43.156.99.215:9111/index.html
```

### Test wallet (Private Key)

```
EOA:       0x2ba20a76af1297d4ef9bd242866f690aceaab9f1
PK:        0xb1eb7c5b3ad9ea36d62e744c4bd07dfb99b0605c2675faaaf8f9c4121ecd8644
MPC Addr:  0xA39fDC3396e74979045C961484FaFe014Aa4B579
```

### Admin credentials

```
Username:  admin
Password:  a87cefd6e1ce487334a67b0c
```

## playwright-cli — Page automation

### Lifecycle

```bash
# Open browser
playwright-cli open
playwright-cli open http://43.156.99.215:9111

# Profile-based (persistent sessions)
playwright-cli open --persistent
playwright-cli open --profile=/tmp/infrax-profile

# Close
playwright-cli close
playwright-cli close-all
```

### Page interaction

```bash
playwright-cli goto http://43.156.99.215:9111/connect.html
playwright-cli snapshot                      # get page refs
playwright-cli click e15                     # click by ref
playwright-cli click "#btn"                  # click by CSS selector
playwright-cli type "text"                   # type into focused input
playwright-cli fill e7 "value" --submit      # fill & submit
playwright-cli select e9 "option-value"      # select dropdown
playwright-cli snapshot --filename=after.yml # save snapshot
playwright-cli find "Sign in"                # search snapshot text
playwright-cli eval "document.title"         # run JS
playwright-cli eval "el => el.textContent" e5
```

### Navigation + Tabs

```bash
playwright-cli go-back
playwright-cli reload
playwright-cli tab-new http://43.156.99.215:9111/admin.html
playwright-cli tab-list
playwright-cli tab-select 0
playwright-cli tab-close 1
```

### State management

```bash
playwright-cli state-save auth.json
playwright-cli state-load auth.json
playwright-cli cookie-list
playwright-cli cookie-set token abc123
playwright-cli localstorage-set key value
playwright-cli localstorage-get key
```

### DevTools (lightweight)

```bash
playwright-cli console               # all console messages
playwright-cli console warning       # filter by level
playwright-cli requests              # network requests
playwright-cli request 5             # details of request #5
playwright-cli screenshot            # full page screenshot
playwright-cli screenshot e15        # element screenshot
```

## chrome-devtools-mcp — Deep inspection

### Launch as MCP server

```bash
# Headless, no sandbox (for server env)
npx chrome-devtools-mcp@latest \
  --headless \
  --chrome-arg='--no-sandbox' \
  --chrome-arg='--disable-setuid-sandbox' \
  --viewport=1280x720 \
  --isolated
```

### Key capabilities

| Category | Feature |
|----------|---------|
| Network | Full request/response headers, bodies, timing |
| Console | All console messages with stack traces |
| Performance | Core Web Vitals, JS profiling, traces |
| Screenshots | Full page and element screenshots |
| Elements | DOM inspection, style debugging |
| Navigation | Page load tracking, redirect chains |

### Tips for InfraX testing

- Use `--isolated` for clean sessions (no cached state contamination)
- Use `--viewport=1280x720` for consistent screenshots
- Combine with playwright-cli `console` + `requests` for quick checks
- For deep network analysis, use chrome-devtools-mcp's network tools

## InfraX E2E test flows

### Flow 1: Private Key login → Dashboard

```bash
# Open connect page
playwright-cli open http://43.156.99.215:9111/index.html
playwright-cli snapshot

# Switch to Private Key tab, enter key, connect
playwright-cli click <private-key-tab-ref>
playwright-cli fill <input-ref> "0xb1eb7c5b3ad9ea36d62e744c4bd07dfb99b0605c2675faaaf8f9c4121ecd8644" --submit
playwright-cli snapshot  # should show Dashboard
```

### Flow 2: Module navigation

```bash
playwright-cli click <mpc-nav-ref>     # MPC Wallet
playwright-cli snapshot
playwright-cli click <waas-nav-ref>    # WaaS B2B
playwright-cli snapshot
playwright-cli click <safe-nav-ref>    # Safe Vault
playwright-cli snapshot
playwright-cli click <dc-nav-ref>      # Data Center
playwright-cli snapshot
playwright-cli click <pay-nav-ref>     # Payment
playwright-cli snapshot
```

### Flow 3: Admin login

```bash
playwright-cli tab-new http://43.156.99.215:9111/admin-login.html
playwright-cli fill <username-ref> "admin"
playwright-cli fill <password-ref> "a87cefd6e1ce487334a67b0c" --submit
playwright-cli snapshot  # should show Admin Dashboard
```

### Flow 4: Debug with console + network

```bash
playwright-cli open --persistent
# login and navigate...
playwright-cli console
playwright-cli requests
playwright-cli eval "document.querySelectorAll('.error').length"
```

## Wrapper scripts

### `test-login.sh`

```bash
#!/bin/bash
# Quick login test with playwright-cli
playwright-cli open http://43.156.99.215:9111/index.html
sleep 2
playwright-cli snapshot
```

### `test-all-modules.sh`

```bash
#!/bin/bash
# Navigate all 5 modules and snapshot each
MODULES=("nc" "mpc" "waas" "safe" "dc" "pay")
for mod in "${MODULES[@]}"; do
  playwright-cli click "[data-page='${mod}']"
  playwright-cli snapshot --filename="snapshot-${mod}.yml"
done
```

## Environment

| Variable | Default | Purpose |
|----------|---------|---------|
| `INFRAX_URL` | `http://43.156.99.215:9111` | Target InfraX instance |
| `INFRAX_PK` | `0xb1eb7c5...cd8644` | Test wallet private key |
| `ADMIN_PASS` | from systemd env | Admin password |

## Known limitations

- MetaMask popups cannot be automated (requires real wallet interaction)
- Headless mode may behave differently for Web3 wallet connections
- Safe Vault deployment requires blockchain signature — not fully automatable
- Sandbox environment (`--no-sandbox`) required on server

## References

- `test-reports/INFRAX_TEST_P7_USER_JOURNEYS.md` — full E2E test scenarios
- `test-reports/INFRAX_TEST_P1_ONBOARDING.md` — onboarding flow
- `test-reports/E2E_TEST_REPORT.md` — historical test results
- `~/.claude/skills/playwright-cli/SKILL.md` — full playwright-cli reference
- `~/.claude/skills/playwright-cli/references/` — detailed sub-topics
