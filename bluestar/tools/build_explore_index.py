"""Builds bluestar/explore-index.json: every game in BlueStar's Explore catalog, as [[appId, name], ...].

The admin panel searches it to hide or add any game. Input is the catalog SQLite that BlueStar-Catalog
publishes (catalog.sqlite.zst, decompressed). Usage: python build_explore_index.py catalog.sqlite out.json
"""
import json
import sqlite3
import sys


def main(db_path: str, out_path: str) -> None:
    con = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
    rows = con.execute("SELECT app_id, name FROM apps WHERE lower(app_type) = 'game' ORDER BY app_id").fetchall()
    games = [[int(a), str(n)[:200]] for a, n in rows if a and n and 0 < int(a) <= 0xFFFFFFFF]
    assert len(games) > 1000, f"suspiciously small catalog ({len(games)} games); refusing to overwrite"
    with open(out_path, "w", encoding="utf-8", newline="\n") as f:
        json.dump(games, f, ensure_ascii=False, separators=(",", ":"))
        f.write("\n")
    print(f"{len(games)} games -> {out_path}")


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])
