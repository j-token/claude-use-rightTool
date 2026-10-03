import json
import subprocess
import time

while True:
    out = subprocess.run(["gh", "run", "view", "--json", "status"], capture_output=True, text=True).stdout
    if json.loads(out)["status"] == "completed":
        print("done")
        break
    time.sleep(15)
