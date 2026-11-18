"""Serve the PWA and relay the current OpenF1 race to browsers."""

import argparse
import json
import os
import ssl
import sys
import threading
import time
from collections import deque
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlencode
from urllib.request import Request, urlopen


OPEN_F1 = 'https://api.openf1.org'
LIMITS = {
    'drivers': 50, 'position': 3000, 'intervals': 5000, 'laps': 2400,
    'race_control': 500, 'car_data': 7500, 'location': 7500,
}
MEDIA = {'car_data', 'location'}


def timestamp(value):
    return datetime.fromisoformat(value.replace('Z', '+00:00'))


def upcoming_race(sessions, now):
    races = [
        race for race in sessions if race.get('session_name') == 'Race'
        and not race.get('is_cancelled') and race.get('date_start') and race.get('date_end')
    ]
    active = [
        race for race in races
        if timestamp(race['date_start']) - timedelta(minutes=15) <= now
        <= timestamp(race['date_end']) + timedelta(hours=3)
    ]
    if active:
        return max(active, key=lambda race: timestamp(race['date_start']))
    return min((race for race in races if timestamp(race['date_start']) > now),
               key=lambda race: timestamp(race['date_start']), default=None)


class Feed:
    def __init__(self):
        self.lock = threading.Lock()
        self.session = None
        self.connected = False
        self.upstream = 'connecting'
        self.revision = self.reset_at = 0
        self.rows = {topic: {} for topic in LIMITS}
        self.events = deque(maxlen=2400)

    def select(self, session):
        with self.lock:
            if session == self.session:
                return
            if (session or {}).get('session_key') != (self.session or {}).get('session_key'):
                for rows in self.rows.values():
                    rows.clear()
                self.events.clear()
                self.reset_at = self.revision + 1
            self.session = session
            self.revision += 1

    def set_connected(self, connected):
        with self.lock:
            if self.connected != connected:
                self.connected = connected
                self.revision += 1

    def add(self, topic, rows):
        with self.lock:
            if self.session is None:
                return
            latest = self.rows[topic]
            for row in rows:
                if row.get('session_key') != self.session['session_key']:
                    continue
                # The REST rows can omit MQTT keys, so use a common identity.
                time_key = row.get('date')
                if time_key:
                    time_key = timestamp(time_key).isoformat(timespec='milliseconds')
                identity = {
                    'drivers': (row.get('driver_number'),),
                    'laps': (row.get('driver_number'), row.get('lap_number')),
                    'race_control': (time_key, row.get('message')),
                }.get(topic, (row.get('driver_number'), time_key))
                previous = latest.get(identity)
                if previous == row or previous and previous.get('_id', 0) > row.get('_id', 0):
                    continue
                latest[identity] = row
                if len(latest) > LIMITS[topic]:
                    del latest[next(iter(latest))]
                self.revision += 1
                self.events.append((self.revision, topic, row))

    def read(self, cursor):
        with self.lock:
            if cursor == self.revision:
                return cursor, None
            floor = self.events[0][0] - 1 if self.events else self.reset_at
            reset = cursor is None or cursor < max(floor, self.reset_at)
            if reset:
                rows = {topic: list(entries.values()) for topic, entries in self.rows.items()}
            else:
                rows = {}
                for revision, topic, row in self.events:
                    if revision > cursor:
                        rows.setdefault(topic, []).append(row)
            return self.revision, {
                'session': self.session, 'connected': self.connected, 'rows': rows,
            }


class OpenF1Relay:
    def __init__(self, username, password, feed, mqtt):
        self.username = username
        self.password = password
        self.feed = feed
        self.mqtt = mqtt
        self.token = ''
        self.refresh_at = 0
        self.client = None
        self.backfill = threading.Event()

    def authenticate(self):
        data = urlencode({'username': self.username, 'password': self.password}).encode()
        request = Request(OPEN_F1 + '/token', data, {'Content-Type': 'application/x-www-form-urlencoded'})
        with urlopen(request, timeout=15) as response:
            credentials = json.load(response)
        self.token = credentials['access_token']
        self.refresh_at = time.monotonic() + max(1, float(credentials['expires_in']) - 75)

    def get(self, topic, **params):
        url = f'{OPEN_F1}/v1/{topic}?{urlencode(params)}'
        # OpenF1 time filters have a comparison operator in the query key.
        url = url.replace('date%3E=', 'date%3E')
        request = Request(url, headers={'Authorization': f'Bearer {self.token}'})
        with urlopen(request, timeout=20) as response:
            return json.load(response)

    def start_mqtt(self):
        self.stop_mqtt()
        client = self.mqtt.Client(self.mqtt.CallbackAPIVersion.VERSION2)
        client.username_pw_set(self.username, self.token)
        client.tls_set_context(ssl.create_default_context())
        client.reconnect_delay_set(1, 30)

        def connected(client, userdata, flags, reason, properties):
            if not reason.is_failure:
                client.subscribe([(f'v1/{topic}', 0) for topic in LIMITS])
                self.feed.set_connected(True)
                self.backfill.set()

        def disconnected(client, userdata, flags, reason, properties):
            self.feed.set_connected(False)

        def message(client, userdata, event):
            try:
                self.feed.add(event.topic.removeprefix('v1/'), [json.loads(event.payload)])
            except (KeyError, AttributeError, TypeError, ValueError):
                print('Ignored an invalid OpenF1 stream row', file=sys.stderr)

        client.on_connect = connected
        client.on_disconnect = disconnected
        client.on_message = message
        client.connect_async('mqtt.openf1.org', 8883, keepalive=30)
        client.loop_start()
        self.client = client

    def stop_mqtt(self):
        if self.client:
            self.client.disconnect()
            self.client.loop_stop()
            self.client = None
        self.feed.set_connected(False)

    def seed(self, session, now, topics):
        def load(topic):
            filters = {'session_key': session['session_key']}
            if topic in MEDIA or topic == 'intervals':
                age = 35 if topic in MEDIA else 600
                filters['date>'] = (now - timedelta(seconds=age)).isoformat()
            try:
                self.feed.add(topic, self.get(topic, **filters))
                return None
            except (OSError, ValueError):
                return topic

        with ThreadPoolExecutor(max_workers=2) as pool:
            return {topic for topic in pool.map(load, topics) if topic}

    def run(self):
        discover_at = retry_seed_at = 0
        session = None
        active_key = None
        pending = set()
        meeting_names = {}
        while True:
            try:
                refreshed = time.monotonic() >= self.refresh_at
                if refreshed:
                    self.authenticate()
                now = datetime.now(timezone.utc)
                if time.monotonic() >= discover_at:
                    races = self.get('sessions', year=now.year, session_name='Race')
                    self.feed.upstream = 'ready'
                    session = upcoming_race(races, now)
                    if session:
                        meeting = session['meeting_key']
                        if meeting not in meeting_names:
                            try:
                                rows = self.get('meetings', meeting_key=meeting)
                                meeting_names[meeting] = rows[0].get('meeting_name') if rows else None
                            except OSError:
                                pass
                        session = {**session, 'meeting_name': meeting_names.get(meeting)}
                    self.feed.select(session)
                    discover_at = time.monotonic() + 45
                active = session and timestamp(session['date_start']) - timedelta(minutes=15) <= now \
                    <= timestamp(session['date_end']) + timedelta(hours=3)
                if active:
                    key = session['session_key']
                    if refreshed or not self.client:
                        self.start_mqtt()
                    if self.backfill.is_set() or key != active_key:
                        active_key = key
                        self.backfill.clear()
                        pending = set(LIMITS)
                        retry_seed_at = 0
                    if pending and time.monotonic() >= retry_seed_at:
                        pending = self.seed(session, now, pending)
                        retry_seed_at = time.monotonic() + 35
                elif self.client:
                    active_key = None
                    self.stop_mqtt()
            except (OSError, KeyError, ValueError) as error:
                self.feed.upstream = 'retrying'
                print(f'OpenF1 relay retrying after {type(error).__name__}', file=sys.stderr)
                time.sleep(15)
            time.sleep(2)


class RadarHandler(SimpleHTTPRequestHandler):
    protocol_version = 'HTTP/1.1'

    def do_GET(self):
        if self.path == '/api/live/status':
            configured = self.server.live_configured
            payload = json.dumps({
                'configured': configured,
                'openf1': self.server.feed.upstream if configured else 'disabled',
            }).encode()
            self.send_response(200)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Cache-Control', 'no-store')
            self.send_header('Content-Length', str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)
        elif self.path == '/api/live' and self.server.live_configured:
            if not self.server.stream_slots.acquire(blocking=False):
                self.send_error(503, 'Live viewer limit reached')
                return
            try:
                self.stream_updates()
            finally:
                self.server.stream_slots.release()
        else:
            try:
                super().do_GET()
            except (BrokenPipeError, ConnectionResetError):
                self.close_connection = True

    def stream_updates(self):
        self.send_response(200)
        self.send_header('Content-Type', 'text/event-stream')
        self.send_header('Cache-Control', 'no-store')
        self.send_header('X-Accel-Buffering', 'no')
        self.send_header('Connection', 'close')
        self.end_headers()
        self.close_connection = True
        self.connection.settimeout(8)
        cursor = None
        heartbeat = 0
        try:
            while True:
                cursor, update = self.server.feed.read(cursor)
                if update is not None:
                    encoded = json.dumps(update, separators=(',', ':'), allow_nan=False)
                    self.wfile.write(f'data: {encoded}\n\n'.encode())
                    heartbeat = time.monotonic()
                elif time.monotonic() - heartbeat > 12:
                    self.wfile.write(b': keep-alive\n\n')
                    heartbeat = time.monotonic()
                self.wfile.flush()
                time.sleep(1)
        except (OSError, ValueError):
            pass


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--host', default='127.0.0.1')
    parser.add_argument('--port', type=int, default=int(os.environ.get('PORT', '8000')))
    args = parser.parse_args()
    feed = Feed()
    username = os.environ.get('OPENF1_USERNAME')
    password = os.environ.get('OPENF1_PASSWORD')
    if bool(username) != bool(password):
        parser.error('Set both OPENF1_USERNAME and OPENF1_PASSWORD for live viewing.')
    static = Path(__file__).resolve().parent / 'dist'
    with ThreadingHTTPServer((args.host, args.port), partial(RadarHandler, directory=static)) as server:
        server.feed = feed
        server.live_configured = bool(username)
        server.stream_slots = threading.BoundedSemaphore(64)
        if username:
            import paho.mqtt.client as mqtt
            relay = OpenF1Relay(username, password, feed, mqtt)
            threading.Thread(target=relay.run, daemon=True).start()
        print(f'Race Radar at http://{args.host}:{server.server_port}', flush=True)
        try:
            server.serve_forever()
        except KeyboardInterrupt:
            pass


if __name__ == '__main__':
    main()
