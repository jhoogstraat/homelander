# Changelog

All notable changes to Homelander are documented here. Format follows [Keep a Changelog](https://keepachangelog.com/).

## [Unreleased]

### Added
- IS24 radius searches (`/Suche/radius/…?geocoordinates=lat;lon;km`) are now supported — the circle is sent to the mobile API as `searchType=radius` + `geocoordinates`, and the preview shows its centre and radius (e.g. `Hamburg, Altona · 1 km Umkreis`)
- Experimental Linux builds (x64 `.deb` + `.AppImage`), first published on the v1.5.1 release; Linux enabled in the release workflow matrix
- Screenshots section in README (Search, History, Settings)
- Installation section in README with platform table, macOS `xattr -cr`, Windows SmartScreen note
- Donation support: `.github/FUNDING.yml` (GitHub Sponsors, Buy Me a Coffee, Ko-fi)
- Donation section in README with styled badge buttons
- Donation card in Settings tab (between Language and Clean All Data)

### Changed
- README restructured: Screenshots → Why → Features → Installation → Disclaimer → …
- Disclaimer strengthened: hobby/portfolio project, not for actual IS24 use, strictly prohibited
- `{{name}}` now resolves to `Vorname Nachname` only (no Herr/Frau / Anrede)

### Removed
- Captcha wall auto-pause: removed `consecutiveCaptchas` counter, 5-failure pause, auto-resume, `captcha_wall` IPC emission

### Fixed
- The Suchen tab re-read its searches in a tight loop instead of every 30 seconds: the refresh effect depended on the `filters` array it replaced, and every IPC read returns a fresh array, so each update retriggered the effect immediately — burning CPU on back-to-back SQLite reads and renderer re-renders (thanks @jhoogstraat)
- Radius search URLs were rejected with "Nicht unterstützte Filter: centerofsearchaddress, geocoordinates" and, worse, previewed as "Deutschlandweit" — the location constraint was dropped entirely
- Radius links missing their map coordinates are now blocked with an actionable message instead of building a request the mobile API answers with 412
- Map-drawn (shape) search links are blocked up front rather than silently failing at request time
- Search names derived from a radius URL read "Radius · wohnung zur Miete"; they now use the search centre
- Errors in the Add Search dialog always rendered in English because `t` was not passed to `userErrorText`, even though the German strings existed
- `{{name}}` template resolution now consistent between Settings preview, Setup wizard preview, and actual daemon messages

## [1.3.3] - 2026-06-25

### Added
- `--disable-gpu` flag on macOS to prevent SwiftShader GPU compositor zombie on screen lock

### Changed
- Removed UA spoofing — use natural Chrome for Testing identity
- GPU compositing flags scoped to Windows-only

### Fixed
- Clicking X now quits the app instead of hiding to background
- Perimeter captcha: don't use `return` in `finally` block (overrode captcha result)
- Perimeter captcha: stay on captcha page, don't redirect to IS24
- Perimeter captcha: don't navigate to `about:blank`

## [1.3.2] - 2026-06-20

### Fixed
- Detach daemon from parent Job Object + elevate OS priority to prevent Windows background throttling
- Disable Windows EcoQoS power throttling + force 1ms timer resolution via Win32 API
- Add CalculateNativeWinOcclusion flag for Windows virtual-desktop resilience

## [1.3.1] - 2026-06-15

### Fixed
- Clean all data now deletes logs, Chrome profiles, and support bundles
- Also delete `debug/` directory on clean all data
- Re-verify move-in date at end of form fill
- Prevent empty history list on double-clicking same outcome filter

## [1.3.0] - 2026-06-10

### Added
- Echo daemon events to stderr for CLI dev visibility
- CDP HTTP ping before each apply round and listing
- SVG flags for language picker
- AWS WAF perimeter captcha detection, pause + notify in status bar

### Changed
- Notifications: removed SENT/FAIL/captcha_wall, added perimeter_captcha
- Chrome bundled into installer (no runtime download)

### Fixed
- Prevent macOS Space-switch CDP timeouts (App Nap + stdout backpressure)
- Close shared DB handle before unlinking in `data:clean`
- SVG flags — proper 3:2 aspect ratio, Union Jack clip-path
- Fix EBUSY on data clean (await daemon exit + db.close)
- CI: auto-bump package.json version from release tag input

## [1.2.2] - 2026-06-01

### Added
- SVG icons, uniform badges

### Fixed
- Windows virtual-desktop anti-deadlock flags

## [1.2.1] - 2026-05-28

### Fixed
- Parentheses around `??`/`||` in JSX to fix build
- Scope per-filter 'Processed X/Y' denominator to today

## [1.2.0] - 2026-05-25

### Added
- Bundle Chromium in installer — remove runtime download step

## [1.1.x] - 2026-05 (series)

### Added
- Chromium download progress wired to setup wizard (1.1.22)
- Directory walk for Chrome executable — finds chrome.exe wherever it extracts (1.1.21)
- Chrome startup diagnostics — log executable path, PID, file existence (1.1.18)
- Homelander key icon in setup wizard header

### Fixed
- Route `ensureChromiumInstalled` logs to chrome.log (1.1.20)
- `_logToFile` require() broken in ESM — logs never written (1.1.19)
- `--enable-logging --log-file` for Chromium spawn on Windows (1.1.17)
- Include Chrome crash info + chrome.log in support bundle
- 🐞 tooltip now anchored to right edge — no longer overflows screen
