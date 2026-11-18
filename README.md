# F1 Race Radar

![Isometric preview of the F1 Race Radar desktop dashboard and mobile 1v1 radar during the Brazilian GP](docs/media/race-radar-cover.webp)

**A mobile-first replay app for the 2026 Formula 1 season.** Follow two drivers from lights out to the finish with the gap, car positions, and telemetry synced to the same replay clock.

[MVP features](#mvp-features) · [Screenshots](#screenshots) · [Run locally](#run-locally) · [Project structure](#project-structure) · [Credits](#credits-and-disclaimer)

## MVP features

- **1v1 Radar** — Pick a battle between adjacent drivers and follow the time gap and estimated distance with driver portraits and team liveries.
- **Race replay** — Browse completed 2026 Grands Prix, starting with the latest available race. Jump to any lap or the finish, scrub the timeline, and switch between **1×, 2×, 4×, and 8×**.
- **Synced telemetry** — Compare speed, throttle, braking, and gear. The radar interpolates car movement and readouts between recorded samples as playback speed changes.
- **Race analysis** — See GPS positions on the circuit, race classification, lap pace, gap history, and sector deltas.
- **Installable PWA** — Add the app to your home screen from a supported browser over HTTPS. It opens straight to 1v1 Radar and caches the app shell and bundled Brazilian GP snapshot for offline use.

## Screenshots

Liam Lawson and Charles Leclerc battle for P8 at Interlagos on lap 67 of the 2026 Brazilian GP.

<p align="center">
  <a href="docs/media/mobile-radar.png"><img src="docs/media/mobile-radar.png" alt="Mobile 1v1 radar with the Lawson–Leclerc gap, telemetry gauges, replay speeds, and lap slider" width="260"></a>
  <a href="docs/media/mobile-lap-picker.png"><img src="docs/media/mobile-lap-picker.png" alt="Mobile lap picker with lap 67 selected and a Finish option" width="260"></a>
</p>

<details>
<summary>Desktop dashboard with telemetry and circuit map</summary>

![Full desktop dashboard showing the battle list, 1v1 radar, telemetry traces, Interlagos map, and lap analysis](docs/media/desktop-radar.png)

</details>

## Run locally

Requires Python 3.10 or newer. The build uses the Python standard library.

```sh
python build.py
python -m http.server 8000 --bind 127.0.0.1 --directory dist
```

Open [1v1 Radar](http://127.0.0.1:8000/#radar). Run `python build.py --standalone` to also generate a single-file preview.

### Install on a phone

Serve the checked-in `dist/` directory on an HTTPS static host. Open it in Chrome on Android or Safari on iOS and choose **Install app** or **Add to Home Screen** from the browser menu. The app opens directly to 1v1 Radar.

## Project structure

| Path | Contents |
| --- | --- |
| [`src/`](src/) | Radar UI, replay logic, bundled race data, and app assets |
| [`dist/`](dist/) | Ready-to-serve PWA with its manifest and service worker |
| [`docs/media/`](docs/media/) | Isometric cover and full-resolution screenshots |
| [`build.py`](build.py) | Python script that builds the static app |

## Data sources

| Source | Data |
| --- | --- |
| [OpenF1](https://openf1.org/docs/) | Archived timing, GPS, and car telemetry |
| [Jolpica F1](https://api.jolpi.ca/docs/) | Race results and driver standings |

The bundled Brazilian GP snapshot includes race timing and selected telemetry windows. Additional races and telemetry load on demand, subject to upstream availability.

## Credits and disclaimer

> [!NOTE]
> F1 Race Radar is an unofficial personal project, independent of Formula 1. All Formula 1 assets used in the app and this README, including the logo, fonts, driver portraits, and team liveries, belong to Formula 1 and their respective rights holders.

Team liveries and driver portraits come from the [Formula 1 teams](https://www.formula1.com/en/teams) and [2026 driver standings](https://www.formula1.com/en/results/2026/drivers) pages.
