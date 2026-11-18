# F1 Race Radar

A mobile-first F1 second-screen PWA for replaying 1v1 battles from the 2026 season. It includes a GP picker, driver portraits, team liveries, synchronized GPS and telemetry, branded duel and lap pickers, and 1x–8x playback.

## Run locally

Use Python 3.10 or newer. The build uses only the Python standard library.

```sh
python build.py
python -m http.server 8000 --bind 127.0.0.1 --directory dist
```

Open [1v1 Radar](http://127.0.0.1:8000/#radar). The checked-in `dist/` is also ready to serve on an HTTPS static host. The app manifest launches 1v1 Radar when installed. To generate the single-file preview as well, run `python build.py --standalone`.

## Data and assets

- [OpenF1](https://openf1.org/docs/) supplies replay timing, GPS and car telemetry.
- [Jolpica](https://api.jolpi.ca/docs/) supplies results and standings.
- The bundled 2026 race catalog and GP Brasil snapshot allow the app shell and saved race timing to open offline. Other GP data and telemetry outside the saved windows load on demand.
- Team car artwork and driver portraits come from the [Formula 1 teams](https://www.formula1.com/en/teams) and [driver standings](https://www.formula1.com/en/results/2026/drivers) pages. The build uses the supplied Formula 1 fonts and logo.

`src/` contains the editable app, bundled data and assets. `build.py` generates `dist/`, including the PWA manifest and service worker.
