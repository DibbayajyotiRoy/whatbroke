"""Settings loader: a background refresh worker resolves overrides."""
import threading

DEFAULTS = {"timeout": 30, "retries": 3}


def load_settings(overrides, results):
    """Fill `results` with every known setting, applying overrides."""
    for key in sorted(DEFAULTS):
        results[key] = overrides.get(key, DEFAULTS[key])


def refresh(overrides):
    """Resolve settings on a worker thread, the way the real service does."""
    results = {}
    worker = threading.Thread(target=load_settings, args=(overrides, results))
    worker.start()
    worker.join()
    return results
