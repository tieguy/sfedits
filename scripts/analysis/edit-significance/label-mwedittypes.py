#!/usr/bin/env python3
"""Label a cohort's edits with mwedittypes SimpleEditTypes.
Usage: label-mwedittypes.py <cohort> <lang>   (lang: en | es)
Reads <cohort>/edits.json + pairs-cache/, appends to <cohort>/labels.jsonl (resumable).
"""
import json
import os
import sys

from mwedittypes import SimpleEditTypes

DATA_ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                         "../../../data/edit-significance-validation")

def main():
    if len(sys.argv) != 3:
        print("usage: label-mwedittypes.py <cohort> <lang>", file=sys.stderr)
        sys.exit(1)
    cohort, lang = sys.argv[1], sys.argv[2]
    cdir = os.path.join(DATA_ROOT, cohort)
    cache = os.path.join(cdir, "pairs-cache")
    out_path = os.path.join(cdir, "labels.jsonl")

    with open(os.path.join(cdir, "edits.json")) as f:
        edits = json.load(f)

    done = set()
    if os.path.exists(out_path):
        with open(out_path) as f:
            for line in f:
                try:
                    done.add(json.loads(line)["revid"])
                except Exception:
                    pass

    n = 0
    with open(out_path, "a") as out:
        for e in edits:
            if e["revid"] in done:
                continue
            try:
                with open(os.path.join(cache, f"{e['parentid']}.txt")) as f:
                    prev = f.read()
                with open(os.path.join(cache, f"{e['revid']}.txt")) as f:
                    curr = f.read()
            except FileNotFoundError:
                continue
            if not prev or not curr:
                rec = {"revid": e["revid"], "title": e["title"], "error": "missing-content"}
            else:
                try:
                    diff = SimpleEditTypes("wikitext", prev, curr, lang=lang).get_diff()
                    rec = {"revid": e["revid"], "title": e["title"], "types": diff}
                except Exception as ex:
                    rec = {"revid": e["revid"], "title": e["title"], "error": str(ex)[:200]}
            out.write(json.dumps(rec) + "\n")
            n += 1
            if n % 100 == 0:
                out.flush()
                print(f"{n} labeled", file=sys.stderr)
    print(f"done: {n} newly labeled")

if __name__ == "__main__":
    main()
