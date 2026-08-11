<p align="center">
  <img src="brand/social/avatar-1024.png" width="128" alt="Homelander">
</p>

<h1 align="center">Homelander</h1>

<p align="center">
  <b>Desktop app that automates apartment applications on ImmobilienScout24</b><br>
  Paste a search URL — it polls for new listings and auto-applies for you.
</p>

<p align="center">
  <a href="https://github.com/B1Z0N/homelander/actions/workflows/ci.yml"><img src="https://github.com/B1Z0N/homelander/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <img src="https://img.shields.io/badge/license-MIT-blue" alt="MIT License">
  <img src="https://img.shields.io/badge/platform-macOS%20%7C%20Windows%20%7C%20Linux-lightgrey" alt="Platform">
  <img src="https://img.shields.io/badge/electron-42-47848f" alt="Electron 42">
</p>

<p align="center">
  <a href="https://www.youtube.com/watch?v=udNWQz3WNBI"><b>▶ Watch the demo</b></a> (1:41)
  &nbsp;·&nbsp;
  <a href="https://www.youtube.com/watch?v=tihX4nCKdwQ"><b>macOS install guide</b></a>
</p>

## 📸 Screenshots

<p align="center">
  <img src="brand/screenshots/search-tab.png" width="960" alt="Search tab">
  <br><sub>Search tab — manage searches, view live feed</sub>
</p>

<p align="center">
  <img src="brand/screenshots/history-tab.png" width="960" alt="History tab">
  <br><sub>History tab — browse sent applications, export CSV</sub>
</p>

<p align="center">
  <img src="brand/screenshots/settings-tab.png" width="960" alt="Settings tab">
  <br><sub>Settings tab — persona, message template, captcha config</sub>
</p>

---

## 🚀 Why Homelander?

ImmobilienScout24 is Germany's largest real estate platform. Apartments in competitive markets (Berlin, Munich, Hamburg) get 100+ applications within hours. If you're not among the first to apply, you never hear back.

| Approach | Problem |
|----------|---------|
| **Manual refreshing** | You can't sit at your desk 24/7 hitting F5 |
| **Browser extensions** | Detectable, limited to what the browser can do |
| **Cloud bots** | Costs around a 100€ |
| **Homelander** | Runs on your computer, uses a real Chromium browser, handles captchas, auto-pauses on session expiry and AWS perimeter challenges |

Free. No terminal. No cloud. No manual refreshing. Set it and forget it.

## ✨ Features

- **🪄 One-click setup** — guided 6-step wizard, no terminal needed
- **🤖 Auto-apply** — fills IS24 contact forms via a bundled Chromium browser
- **🔐 Captcha solving** — optional, but automatic using 2captcha (~$0.001 per solve)
- **🧠 Smart pausing** — detects session expiry and AWS perimeter challenges, auto-pauses
- **⏱️ Three speed modes** — fast, balanced, slow (45-90s delays between applications)
- **💻 Cross-platform** — macOS, Windows, Linux
- **🌍 Multilanguage** — full German and English UI
- **📦 Local-first** — all data in SQLite, nothing sent to us

## ⬇️ Installation

Download the latest version from the **[Releases](https://github.com/B1Z0N/homelander/releases)** page.

📺 Prefer video? **[Watch the macOS install walkthrough](https://www.youtube.com/watch?v=tihX4nCKdwQ)** — download, Gatekeeper, and first launch.

| Platform | Package |
|----------|---------|
| macOS (Apple Silicon — M1 and newer) | `Homelander-<version>-arm64.dmg` |
| macOS (Intel) | `Homelander-<version>.dmg` — the one *without* `-arm64` |
| Windows | `Homelander.Setup.<version>.exe` |
| Linux (x64 — experimental) | `homelander_<version>_amd64.deb` |

Not sure which Mac you have? **Apple menu → About This Mac**: "Apple M…" means Apple Silicon, "Intel" means Intel.

### macOS — first run

macOS may block the app because it's not notarized. After moving to Applications, unblock it:

```bash
xattr -cr /Applications/Homelander.app
```

Then launch from Applications or Spotlight. ([See this step in the video](https://www.youtube.com/watch?v=tihX4nCKdwQ&t=53s))

### Windows

Download the `.exe` and run it. Windows SmartScreen may show a warning — click **More info** → **Run anyway**.

### Linux — experimental

x64 only (there is no arm64 build of the bundled browser). Install the `.deb`:

```bash
sudo apt install ./homelander_<version>_amd64.deb
```

An `.AppImage` is also published, but the `.deb` is the recommended install. Known limitation: on Ubuntu 23.10+ the bundled browser may fail to launch due to the AppArmor user-namespace restriction — a fix is planned.

## ⚠️ Disclaimer

Homelander is a **fun portfolio / hobby project** created for educational purposes. It is **not intended to be used on ImmobilienScout24** and is in no way a tool for submitting actual applications or interacting with the IS24 platform.

This project is **not affiliated with, endorsed by, or connected to ImmobilienScout24 GmbH** in any way. Any use of this software to interact with IS24 is strictly prohibited and may violate IS24's terms of service. The authors assume no liability for any consequences, including but not limited to account restrictions, blocked access, legal claims, or any other actions taken by ImmobilienScout24 or any other party. This software is provided "as is" without warranty of any kind.

## 🔧 First Launch

The setup wizard guides you through 6 steps:

1. **Language** - select german or english.
2. **Your details** — name, email, phone, address
3. **Message template** — the message sent with each application (use `{{title}}`, `{{address}}`, `{{name}}`)
4. **IS24 account** — log in manually (IS24 blocks automated login)
5. **2captcha API key** — for automatic captcha solving
6. **First search** — paste an IS24 search URL

After setup, the app opens to the Searches tab. Add more searches anytime.

## ⚙️ Configuration

All settings editable from the Settings tab:

| Setting | Description |
|---------|-------------|
| Persona | Your contact details (anrede, name, email, phone, address) |
| Message template | Use `{{title}}`, `{{address}}`, `{{name}}` placeholders |
| Timing | Speed preset (fast / balanced / slow), poll interval, send limits |
| Browser visibility | Hidden unless needed / always visible |
| 2captcha API key | Stored in your OS keychain |

Config lives at `~/.homelander/config.json`. Database at `~/.homelander/homelander.db` (SQLite, WAL mode).

## 📊 Data & Privacy

All data is **local** — nothing is sent anywhere except:

- **IS24's API** — to discover new listings
- **IS24's website via Chromium** — to submit contact forms
- **2captcha API** — to solve captchas

No telemetry. No analytics. No cloud. Your `config.json`, `homelander.db`, and Chrome profile stay on your machine.

## 🛠️ Development

### Prerequisites

- **Node.js 20+** ([nodejs.org](https://nodejs.org))
- **Chrome** — bundled automatically via Puppeteer (no separate install)

### Install & Run

```bash
git clone https://github.com/B1Z0N/homelander.git
cd homelander
npm install
npm run dev
```

### Build

```bash
npm run dist:mac     # macOS .dmg + .zip
npm run dist:win     # Windows .exe (NSIS)
npm run dist:linux   # Linux .deb + .AppImage
```

## 📦 How it works

```
IS24 Mobile API ←─ HTTP ──→ [Poller → SQLite → Apply Engine → Chrome CDP] → IS24 Forms
                                   │                    │
                              Electron App            Headed
                              (React UI)    
```

1. **You paste an IS24 search URL** — any valid search, including Tauschwohnung
2. **Poller hits IS24's mobile API** every 10 minutes for new listings
3. **New listings land in SQLite** — deduplicated, timestamped
4. **Apply engine opens each listing** in a background Chromium window, fills the contact form with your details, and submits
5. **Captchas are solved** via 2captcha automatically
6. **Results appear** in the live feed and history — SENT, FAIL, etc.

Everything runs on your computer. Your data stays local.

## ❓ FAQ

**Is this safe?** Yes. Everything runs locally. Your IS24 credentials and personal data never leave your computer except when submitting to IS24 (via the same browser IS24 expects).

**Can IS24 detect me?** Homelander uses a real Chromium browser, natural typing delays, and behaves like a human. The bundled Chromium profile matches what IS24 sees from regular users.

**What does it cost?** The app is free and open-source. You only pay 2captcha for solving captchas, and that is optional (~$0.001/solve, about $3 for hundreds of applications).

**Does it work outside Germany?** The app works anywhere, but it's designed for the German ImmobilienScout24 platform.

**Can I search multiple areas?** Yes. Add multiple search URLs — each polls independently.

## 🤝 Contributing

Contributions are welcome! See [CONTRIBUTING.md](CONTRIBUTING.md) for setup and guidelines.

- Bug reports → [Issue template](https://github.com/B1Z0N/homelander/issues/new?template=bug_report.yml)
- Feature ideas → [Feature request](https://github.com/B1Z0N/homelander/issues/new?template=feature_request.yml)
- Questions → [Discussions](https://github.com/B1Z0N/homelander/discussions)

### External contributors

Thanks to everyone who helped outside of the core development:

- **Thorsten Buck** — testing the app on Ubuntu

## ❤️ Support

If Homelander saves you time and stress, consider supporting development:

<p align="center">
  <a href="https://github.com/sponsors/B1Z0N"><img src="https://img.shields.io/badge/Sponsor-GitHub-30363D?style=for-the-badge&logo=githubsponsors&logoColor=white" alt="Sponsor on GitHub"></a>
  &nbsp;
  <a href="https://www.buymeacoffee.com/b1z0n"><img src="https://img.shields.io/badge/Buy%20Me%20A-Coffee-FFDD00?style=for-the-badge&logo=buymeacoffee&logoColor=black" alt="Buy Me A Coffee"></a>
  &nbsp;
  <a href="https://ko-fi.com/b1z0n"><img src="https://img.shields.io/badge/Ko--fi-Support-FF5E5B?style=for-the-badge&logo=kofi&logoColor=white" alt="Support on Ko-fi"></a>
</p>

## 📄 License

MIT © [Mykola Fedurko](https://github.com/B1Z0N)

## 🙏 Credits

Built on an auto-apply engine developed and battle-tested across thousands of IS24 listings. Key icon brand by the author.
