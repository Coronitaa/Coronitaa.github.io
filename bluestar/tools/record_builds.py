"""Records each new Steam build of the catalog's games in bluestar/builds/<appId>.json.

Steam only publishes the current build of each branch, so the history the panel offers as presets is
the one this script collects over time (run hourly by .github/workflows/bluestar-data.yml).
Data from api.steamcmd.net is validated (digits only) before it is written.
Usage: python record_builds.py <path to bluestar/>   [extra appIds...]
"""
import json
import os
import re
import sys
import time
import urllib.request

DIGITS = re.compile(r"^[0-9]{1,20}$")
MAX_BUILDS = 200


def fetch(app_id: int) -> dict | None:
    req = urllib.request.Request(f"https://api.steamcmd.net/v1/info/{app_id}", headers={"User-Agent": "bluestar-build-recorder"})
    with urllib.request.urlopen(req, timeout=30) as r:
        data = json.load(r)
    return data.get("data", {}).get(str(app_id))


def current_builds(info: dict) -> list[dict]:
    """One entry per public (unencrypted) branch: build id plus the Windows/shared depot manifests."""
    depots = info.get("depots", {})
    out = []
    for branch, b in (depots.get("branches") or {}).items():
        build_id = str(b.get("buildid", ""))
        if not DIGITS.match(build_id) or str(b.get("pwdrequired", "0")) == "1" or not re.match(r"^[A-Za-z0-9_.-]{1,64}$", branch):
            continue
        manifests = {}
        for depot_id, d in depots.items():
            if not depot_id.isdigit() or not isinstance(d, dict):
                continue
            oslist = (d.get("config") or {}).get("oslist", "")
            if oslist and "windows" not in oslist:
                continue
            gid = str(((d.get("manifests") or {}).get(branch) or {}).get("gid", ""))
            if DIGITS.match(gid):
                manifests[depot_id] = gid
        if manifests:
            updated = str(b.get("timeupdated", "0"))
            out.append({
                "buildId": build_id,
                "branch": branch,
                "timeUpdated": int(updated) if updated.isdigit() else None,
                "manifests": manifests,
            })
    return out


def record(root: str, app_id: int) -> bool:
    info = fetch(app_id)
    if not info:
        return False
    path = os.path.join(root, "builds", f"{app_id}.json")
    history = {"appId": app_id, "builds": []}
    if os.path.exists(path):
        with open(path, encoding="utf-8") as f:
            history = json.load(f)
    known = {(b["branch"], b["buildId"]) for b in history["builds"]}
    now = int(time.time())
    added = [dict(b, seenAt=now) for b in current_builds(info) if (b["branch"], b["buildId"]) not in known]
    if not added:
        return False
    history["builds"] = (added + history["builds"])[:MAX_BUILDS]
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8", newline="\n") as f:
        json.dump(history, f, indent=1)
        f.write("\n")
    print(f"{app_id}: +{len(added)} build(s)")
    return True


def main() -> None:
    root = sys.argv[1]
    with open(os.path.join(root, "catalog.json"), encoding="utf-8") as f:
        catalog = json.load(f)
    app_ids = {g["appId"] for g in catalog.get("games", []) if not g.get("hidden")}
    app_ids |= {int(a) for a in sys.argv[2:] if a.isdigit()}
    for app_id in sorted(app_ids):
        try:
            record(root, app_id)
        except Exception as e:  # one game failing must not stop the rest
            print(f"{app_id}: {e}")
        time.sleep(1)


if __name__ == "__main__":
    main()
