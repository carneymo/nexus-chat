#!/usr/bin/env python3
"""Host-side, read-only Docker monitor. Emits local JSON alerts to journald."""
import argparse
import datetime as dt
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import time


def command(*args):
    result = subprocess.run(args, check=True, capture_output=True, text=True, timeout=10)
    return result.stdout + result.stderr


def alerts(previous, containers, counts, disks, total):
    findings = {}
    for service, container in containers.items():
        if not container or not container['State']['Running']:
            findings['down:' + service] = service + ' is not running'
            continue
        state = container['State']
        identity = container['Id'] + ':' + state['StartedAt']
        if previous.get('containers', {}).get(service) not in (None, identity):
            findings['restart:' + service] = service + ' process restarted or container was replaced'
        if state.get('Health', {}).get('Status') == 'unhealthy':
            findings['unhealthy:' + service] = service + ' health check is failing'
    for status in (401, 429):
        count = counts.get(status, 0)
        minimum = int(os.environ.get('NEXUS_ALERT_' + str(status) + '_COUNT', '20'))
        if count >= minimum and count / max(total, 1) >= 0.2:
            findings['http:' + str(status)] = str(count) + ' HTTP ' + str(status) + ' responses in the last five minutes (at least 20% of responses)'
    for path, usage in disks.items():
        percent = usage.used / usage.total * 100
        if percent >= float(os.environ.get('NEXUS_DISK_PERCENT', '85')) or usage.free < 1024 ** 3:
            findings['disk:' + path] = path + ': ' + str(round(percent, 1)) + '% used; ' + str(usage.free) + ' bytes available'
    return findings


def emit(event, key, message):
    print(json.dumps({'level': 'warning' if event == 'security-alert' else 'info',
                      'event': event, 'key': key, 'message': message,
                      'time': dt.datetime.now(dt.timezone.utc).isoformat()}), flush=True)


def run(project, state_file):
    now = time.time()
    try:
        previous = json.loads(state_file.read_text())
    except FileNotFoundError:
        previous = {}
    containers = {}
    rows = {}
    disks = {'/': shutil.disk_usage('/')}
    for service in ('gateway', 'caddy'):
        identity = command('docker', 'compose', '--project-directory', project, 'ps', '-aq', service).strip()
        if not identity:
            containers[service] = None
            continue
        if len(identity.splitlines()) != 1:
            raise RuntimeError('Expected one container for ' + service)
        container = json.loads(command('docker', 'inspect', identity))[0]
        containers[service] = container
        for mount in container.get('Mounts', []):
            source = mount.get('Source')
            if source and os.path.isdir(source):
                disks[source] = shutil.disk_usage(source)
        if service == 'gateway':
            # Request IDs deduplicate overlapping Docker log reads. No bodies or credentials are retained.
            lines = command('docker', 'logs', '--since', '5m', '--tail', '20000', identity)
            for line in lines.splitlines():
                try:
                    row = json.loads(line)
                except ValueError:
                    continue
                if isinstance(row, dict) and 'requestId' in row and 'status' in row:
                    rows[row['requestId']] = row['status']
    counts = {status: list(rows.values()).count(status) for status in (401, 429)}
    findings = alerts(previous, containers, counts, disks, len(rows))
    active = previous.get('active', {})
    next_active = {}
    for key, message in findings.items():
        if key not in active or now - active[key] >= 900 or key.startswith('restart:'):
            emit('security-alert', key, message)
            next_active[key] = now
        else:
            next_active[key] = active[key]
    for key in active.keys() - findings.keys():
        emit('security-recovered', key, 'Condition cleared')
    snapshot = {'containers': {name: value['Id'] + ':' + value['State']['StartedAt']
                               for name, value in containers.items() if value}, 'active': next_active}
    state_file.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(mode='w', dir=state_file.parent, delete=False) as stream:
        json.dump(snapshot, stream)
        temporary = stream.name
    os.chmod(temporary, 0o600)
    os.replace(temporary, state_file)


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--project-directory', default='/home/ubuntu/nexus')
    parser.add_argument('--state', default='/var/lib/nexus-security/watch-state.json')
    args = parser.parse_args()
    try:
        run(args.project_directory, Path(args.state))
    except Exception as error:
        # Never print subprocess output: it could contain unrelated private application logs.
        emit('security-alert', 'monitor-error', 'Monitor failed: ' + type(error).__name__)
        raise SystemExit(1)
