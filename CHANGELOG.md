# Changelog

All notable changes to this project are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses [Semantic Versioning](https://semver.org/).

## [0.9.0] - 2026-11-09

### Added

- Dyson fan speed following the heart rate (default) or power training zone, live.
- One fan speed per zone (0 = off, 1-10), editable in the settings, with a speed test through every zone.
- Cooling curve: the fan rises within seconds, holds its speed after an effort (longer after a longer effort), then eases off one step at a time, and does not hunt on zone boundaries. *After the effort* setting: off, short, normal (default), long.
- Airflow direction while riding: a dial on the main screen and in the settings, like the MyDyson app's, points the air at one fixed angle; or the fan does as set on it. Restored exactly at the end (fixed direction or sweep). Fans whose stored settings lack the angle capability (typed by hand or imported) get it detected from their state. Guided direction search in three steps: a ±20° sweep 3° at a time until Stop, then ±3° degree by degree until Stop, then ±1° and Done; allows for the reaction time, and the dial takes over at any time.
- Automatic stop: after 2 minutes without a measurement (strap taken off, trainer stopped or out of range), the fan goes back to how it was, as on a pause, or is turned off when *Put the fan back* is unchecked. The next measurement drives it again.
- Heater and night mode turned off while riding on Hot+Cool fans; fan state (power, speed, auto mode, heater, night mode) restored on pause and quit.
- First-run setup: Dyson account login with the emailed code to read the fan's local key (no password or token kept), fan choice, connection check on the local network, heart rate or power, max HR or FTP, sensor search. Manual entry of a fan's local key.
- Local control through the fan's own MQTT broker with [dyson-control](https://github.com/cheziyi/dyson-control): found by mDNS, or at a fixed address.
- Room temperature and humidity from the fan on the main screen.
- Status messages with automatic retries: Bluetooth off or not allowed, sensor not found, connection lost, no data, no skin contact, fan unreachable or refusing its key.
- Desktop app in a native window (system webview), with a browser fallback; English and French interface.
- Demo mode (simulated sensor) and sandbox mode (no hardware, simulated Dyson account).
- Portable bundles with an embedded Node.js runtime for macOS (arm64, x64), Windows (x64) and Linux (x64, arm64), and Debian packages (amd64, arm64) for Debian, Ubuntu and Raspberry Pi OS.
