"""PV の「開いた先」の場面に使う実データを集める（Finder の一覧、エディタのコード、issue）。

  python data.py <out.json>
"""
from __future__ import annotations

import datetime
import json
import os
import subprocess
import sys

REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))


def ls(d: str) -> list[dict]:
    out = []
    for n in sorted(os.listdir(os.path.join(REPO, d))):
        if n.startswith("."):
            continue
        p = os.path.join(REPO, d, n)
        st = os.stat(p)
        out.append({"name": n, "size": st.st_size, "dir": os.path.isdir(p),
                    "mtime": datetime.datetime.fromtimestamp(st.st_mtime).strftime("%Y/%m/%d %H:%M")})
    return out


def main() -> None:
    lines = open(os.path.join(REPO, "hooks/links/linkify.ts"), encoding="utf-8").read().split("\n")
    code = [[i + 1, lines[i]] for i in range(232, min(262, len(lines)))]
    issue = json.loads(subprocess.check_output(["gh", "issue", "view", "50", "--json", "title,state,body,author,number"], cwd=REPO))
    data = {"links": ls("hooks/links"), "scripts": ls("scripts"), "code": code, "issue": issue}
    with open(sys.argv[1], "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False)


if __name__ == "__main__":
    main()
