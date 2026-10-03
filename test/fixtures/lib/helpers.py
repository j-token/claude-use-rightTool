import time
import urllib.request


def prepare():
    while True:
        try:
            urllib.request.urlopen("http://localhost:8000/health")
            return
        except OSError:
            time.sleep(2)
