"""Grailed listing helper: autofill via a bookmarklet in your normal Chrome.

One-time setup:
    uv run list_grailed.py bookmarklet   # copies the bookmarklet to your clipboard
    Chrome: Bookmarks bar > right-click > Add page... > Name "Grailed Autofill", URL = paste

Each session:
    uv run list_grailed.py
    For each "pictured" item: on grailed.com/sell/new click "Grailed Autofill", review, Publish,
    then press Enter in the terminal to mark it listed and move on.
"""
import json
import subprocess
import sys
import threading
import urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import pandas as pd

ROOT = Path(__file__).parent
DB = ROOT / "database.csv"
IMAGES = ROOT / "images"
AUTOFILL_JS = ROOT / "autofill.js"
SELL_URL = "https://www.grailed.com/sell/new"
PORT = 8765

# Appended to every listing's description
DESCRIPTION_FOOTER = """**BUNDLE DEALS AVAILABLE**

Buy more, save more!

- 2 items = 10% OFF
- 3 items = 15% OFF
- 4+ items = 20% OFF

Message me for bundle deals. Open to reasonable offers!"""

# DB value -> Grailed's wording
COLOR_MAP = {"Grey": "Gray", "Navy": "Blue", "Indigo": "Blue", "Light Blue": "Blue"}
COUNTRY_MAP = {"USA": "United States", "US": "United States", "UK": "United Kingdom"}
STYLES = ["Luxury", "Vintage", "Avant-Garde", "Streetwear", "Workwear",
          "Gorpcore", "Sportswear", "Basics", "Western"]
IMAGE_EXTS = {".jpg", ".jpeg", ".png", ".webp"}

current_item: dict = {}


def item_id(v) -> str:
    return str(int(float(v)))  # 1.0 -> "1"


def photos_for(iid: str) -> list[Path]:
    files = [p for p in (IMAGES / iid).iterdir() if p.suffix.lower() in IMAGE_EXTS]
    files.sort(key=lambda p: (not p.stem.isdigit(), int(p.stem) if p.stem.isdigit() else 0, p.name))
    return files


def num(v: str) -> str:
    return str(int(float(v))) if v.strip() else ""


def to_item(row: pd.Series) -> dict:
    s = lambda c: str(row[c]).strip()
    iid = item_id(row["id"])
    return {
        "id": iid,
        "department": s("department"),
        "category": s("category"),
        "subcategory": s("subcategory"),
        "designer": s("designer"),
        "size": s("size"),
        "title": s("title"),
        "color": COLOR_MAP.get(s("color"), s("color")),
        "condition": s("condition"),
        "description": f"{s('description')}\n\n{DESCRIPTION_FOOTER}".strip(),
        "style": s("listing_style") if "listing_style" in row else
                 next((st for st in STYLES if st.lower() in s("style").lower()), ""),
        "country": COUNTRY_MAP.get(s("country_of_origin"), s("country_of_origin")),
        "price": num(s("price_usd")),
        "accept_offers": s("accept_offers") == "True",
        "smart_pricing": s("smart_pricing_enabled") == "True",
        "floor_price": num(s("floor_price_usd")),
        "photos": [f"/photos/{iid}/{p.name}" for p in photos_for(iid)],
    }


class Handler(BaseHTTPRequestHandler):
    def _cors(self):
        self.send_header("Access-Control-Allow-Origin", "https://www.grailed.com")
        self.send_header("Access-Control-Allow-Private-Network", "true")
        self.send_header("Access-Control-Allow-Headers", "*")

    def do_OPTIONS(self):
        self.send_response(204)
        self._cors()
        self.end_headers()

    def do_GET(self):
        path = urllib.parse.unquote(self.path.split("?")[0])
        if path == "/item.json":
            body, ctype = json.dumps(current_item).encode(), "application/json"
        elif path.startswith("/photos/"):
            _, _, iid, name = path.split("/", 3)
            f = (IMAGES / iid / name).resolve()
            if not f.is_file() or IMAGES.resolve() not in f.parents:
                return self.send_error(404)
            body, ctype = f.read_bytes(), "image/png" if f.suffix.lower() == ".png" else "image/jpeg"
        else:
            return self.send_error(404)
        self.send_response(200)
        self._cors()
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *args):
        pass


def copy(text: str) -> None:
    subprocess.run("pbcopy", input=text, text=True, check=True)


def bookmarklet() -> str:
    return "javascript:" + urllib.parse.quote(AUTOFILL_JS.read_text(), safe="")


def main() -> None:
    if sys.argv[1:] == ["bookmarklet"]:
        copy(bookmarklet())
        print("Bookmarklet copied. In Chrome: Bookmarks bar > right-click > Add page... >"
              " Name: Grailed Autofill, URL: paste.")
        return

    global current_item
    df = pd.read_csv(DB, dtype=str, keep_default_na=False)
    todo = df[df["status"].str.strip().str.lower() == "pictured"]
    print(f"{len(todo)} item(s) ready to list")

    server = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()

    for idx, row in todo.iterrows():
        iid = item_id(row["id"])
        if not (IMAGES / iid).is_dir():
            print(f"[{iid}] no images/{iid} folder, skipping")
            continue
        current_item = to_item(row)
        copy(json.dumps(current_item))  # fallback if the page can't reach localhost
        subprocess.run(["open", str(IMAGES / iid)])  # in case photos need dragging in
        subprocess.run(["open", "-a", "Google Chrome", SELL_URL])
        print(f"\n[{iid}] {current_item['title']}  ({len(current_item['photos'])} photos)")
        ans = input("  Click 'Grailed Autofill', review, Publish.\n"
                    "  Enter = mark listed / s = skip / q = quit: ").strip().lower()
        if ans == "q":
            break
        if ans == "s":
            continue
        df.loc[idx, "status"] = "listed"
        df.to_csv(DB, index=False)

    server.shutdown()
    print("Done.")


if __name__ == "__main__":
    main()
