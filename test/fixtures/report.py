import csv
import sys

rows = list(csv.DictReader(open(sys.argv[1], encoding="utf-8")))
total = sum(float(r["amount"]) for r in rows)
print(f"{len(rows)} rows, total {total:.2f}")
