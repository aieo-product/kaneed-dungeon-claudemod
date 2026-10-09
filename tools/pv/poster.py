from playwright.sync_api import sync_playwright
import render
with sync_playwright() as p:
    b, page, info = render.open_page(p, 1600, 900)
    page.evaluate("PV.render(11.2); document.querySelectorAll('.sub').forEach(e => e.remove()); document.getElementById('progress').style.display='none'")
    page.screenshot(path=str(render.OUT / 'pv-poster.jpg'), type='jpeg', quality=88)
    b.close()
