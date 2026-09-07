import importlib.util
from pathlib import Path
from collections import namedtuple
import unittest

spec = importlib.util.spec_from_file_location('watch', Path(__file__).with_name('security-watch.py'))
watch = importlib.util.module_from_spec(spec)
spec.loader.exec_module(watch)


class SecurityWatchTests(unittest.TestCase):
    def test_restart_auth_spike_and_disk_pressure(self):
        container = {'Id': 'new', 'State': {'Running': True, 'StartedAt': 'now'}}
        usage = namedtuple('Usage', 'total used free')(10 * 1024**3, 9 * 1024**3, 1024**3)
        result = watch.alerts({'containers': {'gateway': 'old:then'}}, {'gateway': container}, {401: 30, 429: 20}, {'/data': usage}, 100)
        self.assertEqual(set(result), {'restart:gateway', 'http:401', 'http:429', 'disk:/data'})

    def test_baseline_and_low_rate_do_not_alert(self):
        container = {'Id': 'new', 'State': {'Running': True, 'StartedAt': 'now'}}
        self.assertEqual(watch.alerts({}, {'gateway': container}, {401: 3, 429: 1}, {}, 100), {})

    def test_stopped_and_unhealthy_services(self):
        container = {'Id': 'new', 'State': {'Running': True, 'StartedAt': 'now', 'Health': {'Status': 'unhealthy'}}}
        self.assertEqual(set(watch.alerts({}, {'gateway': container, 'caddy': None}, {}, {}, 0)), {'unhealthy:gateway', 'down:caddy'})


if __name__ == '__main__':
    unittest.main()
