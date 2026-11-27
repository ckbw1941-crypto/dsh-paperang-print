#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""喵喵机打印面板的 JSON 桥。

用法：python mmj_bridge.py '{"op":"status"}'
  或把同样的 JSON 从 stdin 传进来。
输出：一行 JSON —— {"ok":true,"value":{...}} 或 {"ok":false,"error":{"code":..,"message":..}}
"""
import asyncio
import base64
import inspect
import io
import json
import os
import random
import shutil
import sys
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
DATA = Path(os.environ.get("MMJ_DATA") or HERE)
try:
    DATA.mkdir(parents=True, exist_ok=True)
except Exception:
    pass
sys.path.insert(0, str(HERE))

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
    sys.stdin.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

WATCH_DIR = Path(os.environ.get("MMJ_WATCH_DIR") or (DATA / "\u5f85\u6253\u5370"))
DONE_DIR = DATA / "\u5df2\u6253\u5370"
FAIL_DIR = DATA / "\u5931\u8d25"
LOG = DATA / "watch.log"
PIDF = DATA / "watch.pid"
IMG_EXT = {".png", ".jpg", ".jpeg", ".bmp", ".webp", ".gif"}
EGG_DIR = DATA / "彩蛋"


def _M():
    import mmj_print as M
    return M


def reply(value):
    sys.stdout.write(json.dumps({"ok": True, "value": value}, ensure_ascii=False) + "\n")


def fail(code, message):
    sys.stdout.write(json.dumps({"ok": False, "error": {"code": code, "message": str(message)}},
                                ensure_ascii=False) + "\n")


def _sniff(p):
    try:
        s = p.stat()
        return s.st_size, int(s.st_mtime)
    except Exception:
        return 0, 0


def pid_alive(pid):
    try:
        import ctypes
        h = ctypes.windll.kernel32.OpenProcess(0x1000, False, int(pid))
        if not h:
            return False
        ctypes.windll.kernel32.CloseHandle(h)
        return True
    except Exception:
        return False


# ---------------- 打印 ----------------

# 常驻 worker 里复用同一条蓝牙连接：连续打印 / 查询省掉 1~3 秒重连
SESSION = {"printer": None, "at": 0.0}
SESSION_IDLE = 20.0


async def _open():
    M = _M()
    p = M.Printer()
    await p.connect(tries=2)
    return p


async def _drop_session():
    p = SESSION.get("printer")
    SESSION["printer"] = None
    SESSION["at"] = 0.0
    if p is not None:
        try:
            await p.close()
        except Exception:
            pass


async def _printer():
    now = time.time()
    p = SESSION.get("printer")
    if p is not None and (now - SESSION["at"]) < SESSION_IDLE:
        try:
            if p.client is not None and p.client.is_connected:
                SESSION["at"] = now
                return p
        except Exception:
            pass
    await _drop_session()
    p = await _open()
    SESSION["printer"] = p
    SESSION["at"] = time.time()
    return p


async def _run(job):
    p = await _printer()
    try:
        value = await job(p)
        SESSION["at"] = time.time()
        return value
    except Exception:
        # 打印失败不自动重试（会重复出纸），但把坏连接丢掉，下次重新连
        await _drop_session()
        raise


def _pil_open_b64(text):
    from PIL import Image
    s = str(text or "").strip()
    if not s:
        raise RuntimeError("没有图片数据")
    if s.startswith("data:"):
        s = s.split(",", 1)[-1]
    data = base64.b64decode(s)
    if not data:
        raise RuntimeError("图片数据是空的")
    return Image.open(io.BytesIO(data))


def rows_to_image(rows, h):
    """把打印机行数据还原成 576 宽的黑白图，用于预览。"""
    import numpy as np
    from PIL import Image
    M = _M()
    pack = np.frombuffer(rows, dtype=np.uint8).reshape(h, -1)
    bits = np.unpackbits(pack, axis=1)[:, : M.WIDTH_PX]
    arr = np.where(bits == 1, 0, 255).astype("uint8")
    return Image.fromarray(arr, mode="L")


def _rotate_of(payload):
    """把 payload 里的 rotate 归一成 0/90/180/270（顺时针）。"""
    try:
        value = int(payload.get("rotate") or 0) % 360
    except (TypeError, ValueError):
        return 0
    return value - (value % 90)


def _rows_for(payload):
    """返回 (rows, 行数, 名称)。

    支持 text / image_b64（浏览器粘贴或拖进来的图）/ clip（系统剪贴板）/ path。
    dither=False 表示关掉灰阶抖动，只做黑白阈值。
    """
    M = _M()
    cfg = M.load_settings()
    doc = bool(payload.get("doc"))
    if isinstance(payload.get("dither"), bool):
        dither = payload["dither"]
    else:
        dither = cfg["dither"]
    try:
        scale = float(payload.get("scale") or 1.0)
    except (TypeError, ValueError):
        scale = 1.0
    scale = max(0.2, min(1.0, scale))
    rotate = _rotate_of(payload)
    if payload.get("text"):
        text = str(payload["text"])
        if not text.strip():
            raise RuntimeError("文字是空的")
        rows, h = M.text_to_rows(text, int(payload.get("font_size") or 30))
        return rows, h, "文字(%d 字)" % len(text.strip())
    if payload.get("image_b64"):
        img = _pil_open_b64(payload["image_b64"])
        name = str(payload.get("name") or "").strip() or "粘贴的图片"
        rows, h = M.image_to_rows(img, doc=doc, dither=dither, scale=scale, rotate=rotate)
        return rows, h, name
    if payload.get("clip"):
        from PIL import ImageGrab
        data = ImageGrab.grabclipboard()
        if data is None:
            raise RuntimeError("剪贴板里没有图片")
        if isinstance(data, list):
            if not data:
                raise RuntimeError("剪贴板里没有图片")
            rows, h = M.image_to_rows(data[0], doc=doc, dither=dither, scale=scale, rotate=rotate)
            return rows, h, Path(data[0]).name
        rows, h = M.image_to_rows(data, doc=doc, dither=dither, scale=scale, rotate=rotate)
        return rows, h, "剪贴板截图"
    raw = str(payload.get("path") or "").strip().strip('"').strip("'")
    if not raw:
        raise RuntimeError("没有给图片路径")
    path = Path(raw)
    if not path.exists():
        raise RuntimeError("找不到文件：%s" % path)
    if path.suffix.lower() not in IMG_EXT:
        raise RuntimeError("不是图片格式：%s" % path.name)
    rows, h = M.image_to_rows(path, doc=doc, dither=dither, scale=scale, rotate=rotate)
    return rows, h, path.name


async def op_print(payload):
    M = _M()
    cfg = M.load_settings()
    density = int(payload.get("density") if payload.get("density") is not None else cfg["density"])
    feed = int(payload.get("feed") if payload.get("feed") is not None else cfg["feed"])
    density = max(0, min(100, density))
    feed = max(0, min(300, feed))
    rows, h, name = _rows_for(payload)

    async def job(p):
        st = await p.status()
        if st.get("lid") is False:
            raise RuntimeError("上盖没合上，合上再试一次")
        if st.get("paper") is False:
            raise RuntimeError("打印机里没有纸")
        return await p.print_bitmap(rows, density=density, post_feed=feed)

    secs = await _run(job)
    return {"name": name, "rows": h, "density": density, "feed": feed, "seconds": round(secs, 1)}


async def op_status(_payload):
    st = await _run(lambda p: p.status())
    st["connected"] = bool(st)
    return st


def make_strip(density):
    from PIL import Image, ImageDraw
    M = _M()
    W = M.WIDTH_PX
    img = Image.new("L", (W, 250), 255)
    d = ImageDraw.Draw(img)
    d.text((16, 12), "浓度测试  当前 %d" % density, font=M.find_font(26), fill=0)
    levels = [0, 64, 128, 192, 232]
    x, w = 16, (W - 32) // len(levels)
    for i, g in enumerate(levels):
        d.rectangle([x + i * w, 58, x + i * w + w - 8, 152], fill=g)
    d.text((16, 162), "左黑右浅；黑块边缘应清晰不发糊", font=M.find_font(20), fill=0)
    d.line([16, 198, W - 16, 198], fill=0, width=2)
    d.text((16, 210), "1 2 3 4 5 6 7 8 9 0  A B C D E F", font=M.find_font(20), fill=0)
    return img


async def op_test(payload):
    M = _M()
    cfg = M.load_settings()
    density = int(payload.get("density") if payload.get("density") is not None else cfg["density"])
    density = max(0, min(100, density))
    feed = int(cfg["feed"])
    rows, h = M.image_to_rows(make_strip(density), doc=False)

    async def job(p):
        return await p.print_bitmap(rows, density=density, post_feed=feed)

    secs = await _run(job)
    return {"name": "浓度测试条", "rows": h, "density": density, "feed": feed, "seconds": round(secs, 1)}


# ---------------- 设置 / 队列 / 日志 ----------------

def op_settings(_payload):
    M = _M()
    cfg = M.load_settings()
    cfg["watch_dir"] = str(WATCH_DIR)
    cfg["log"] = str(LOG)
    return cfg


def op_save(payload):
    M = _M()
    cfg = M.load_settings()
    density = max(0, min(100, int(payload.get("density") or cfg["density"])))
    feed = max(0, min(300, int(payload.get("feed") or cfg["feed"])))
    dither = payload["dither"] if isinstance(payload.get("dither"), bool) else cfg["dither"]
    M.save_settings(density, feed, dither)
    return M.load_settings()


def op_queue(_payload):
    pending = []
    if WATCH_DIR.exists():
        items = [p for p in WATCH_DIR.iterdir() if p.is_file() and not p.name.startswith(".")]
        items.sort(key=lambda p: _sniff(p)[1], reverse=True)
        for p in items[:15]:
            size, mtime = _sniff(p)
            pending.append({"name": p.name, "size": size, "mtime": mtime})
    done, failed = [], []
    for folder, bucket in ((DONE_DIR, done), (FAIL_DIR, failed)):
        if folder.exists():
            items = [p for p in folder.iterdir() if p.is_file()]
            items.sort(key=lambda p: _sniff(p)[1], reverse=True)
            for p in items[:6]:
                size, mtime = _sniff(p)
                bucket.append({"name": p.name, "mtime": mtime})
    return {"pending": pending, "done": done, "failed": failed, "dir": str(WATCH_DIR)}


def op_log(_payload):
    lines = []
    if LOG.exists():
        try:
            text = LOG.read_text("utf-8", "ignore")
            lines = [ln for ln in text.splitlines() if ln.strip()][-16:]
        except Exception as exc:
            lines = ["读取日志失败：%s" % exc]
    return {"lines": lines}


def op_watch(_payload):
    pid = None
    try:
        pid = int(PIDF.read_text("utf-8", "ignore").strip())
    except Exception:
        pid = None
    running = bool(pid and pid_alive(pid))
    return {"running": running, "pid": pid if running else None}


def op_preview(payload):
    """只做转换，不连打印机：返回二值化后的预览图和尺寸信息。"""
    M = _M()
    cfg = M.load_settings()
    rows, h, name = _rows_for(payload)
    img = rows_to_image(rows, h)
    limit = 2400
    shown = h
    if h > limit:
        img = img.resize((M.WIDTH_PX, limit), 0)
        shown = limit
    buf = io.BytesIO()
    img.save(buf, format="PNG", optimize=True)
    b64 = base64.b64encode(buf.getvalue()).decode("ascii")
    return {
        "name": name,
        "rows": h,
        "shown_rows": shown,
        "mm": round(h * 25.4 / 300.0, 1),
        "width": M.WIDTH_PX,
        "density": int(cfg["density"]),
        "feed": int(cfg["feed"]),
        "dither": payload["dither"] if isinstance(payload.get("dither"), bool) else bool(cfg["dither"]),
        "scale": round(max(0.2, min(1.0, float(payload.get("scale") or 1.0))) * 100) if payload.get("image_b64") or payload.get("clip") or payload.get("path") else 100,
        "rotate": _rotate_of(payload) if (payload.get("image_b64") or payload.get("clip") or payload.get("path")) else 0,
        "preview": "data:image/png;base64," + b64,
    }


def op_grab(_payload):
    """把系统剪贴板里的图片取出来交给面板，不进磁盘。"""
    from PIL import Image, ImageGrab
    data = ImageGrab.grabclipboard()
    if data is None:
        raise RuntimeError("剪贴板里没有图片")
    if isinstance(data, list):
        if not data:
            raise RuntimeError("剪贴板里没有图片")
        img = Image.open(data[0])
        name = Path(data[0]).name
    else:
        img = data
        name = "剪贴板截图"
    buf = io.BytesIO()
    img.convert("RGB").save(buf, format="PNG")
    return {
        "name": name,
        "image_b64": "data:image/png;base64," + base64.b64encode(buf.getvalue()).decode("ascii"),
        "width": img.size[0],
        "height": img.size[1],
    }


async def _print_image(path, payload):
    """把一张图片打成小票，返回打印统计。"""
    M = _M()
    cfg = M.load_settings()
    density = int(payload.get("density") if payload.get("density") is not None else cfg["density"])
    density = max(0, min(100, density))
    feed = int(cfg["feed"])
    doc = bool(payload.get("doc"))
    dither = payload.get("dither")
    dither = bool(cfg["dither"]) if dither is None else bool(dither)
    rows, h = M.image_to_rows(path, doc=doc, dither=dither)

    async def job(printer):
        st = await printer.status()
        if st.get("lid") is False:
            raise RuntimeError("上盖没合上，合上再试一次")
        if st.get("paper") is False:
            raise RuntimeError("打印机里没有纸")
        return await printer.print_bitmap(rows, density=density, post_feed=feed)

    secs = await _run(job)
    return {"rows": h, "density": density, "seconds": round(secs, 1)}


BUNDLED_EGGS = Path(__file__).resolve().parent.parent / "assets" / "eggs"


def _ensure_eggs():
    """彩蛋文件夹不存在或为空时，把包里自带的示例图放进去（不覆盖用户已有内容）。"""
    EGG_DIR.mkdir(parents=True, exist_ok=True)
    existing = [p for p in EGG_DIR.iterdir() if p.is_file() and p.suffix.lower() in IMG_EXT]
    if existing or not BUNDLED_EGGS.is_dir():
        return 0
    copied = 0
    try:
        for src in sorted(BUNDLED_EGGS.iterdir()):
            if src.is_file() and src.suffix.lower() in IMG_EXT:
                try:
                    shutil.copy2(src, EGG_DIR / src.name)
                    copied += 1
                except Exception:
                    pass
    except Exception:
        return copied
    return copied


async def op_egg(payload):
    """彩蛋：从 <数据目录>/彩蛋 里随机挑一张图打出来。"""
    copied = _ensure_eggs()
    if copied:
        print("彩蛋文件夹是空的，已放入 %d 张自带图" % copied)
    candidates = [p for p in sorted(EGG_DIR.iterdir()) if p.is_file() and p.suffix.lower() in IMG_EXT]
    if not candidates:
        raise RuntimeError("彩蛋文件夹里还没有图：%s" % EGG_DIR)
    want = str(payload.get("name") or "").strip()
    pick = None
    if want:
        for p in candidates:
            if p.name == want:
                pick = p
                break
    if pick is None:
        pick = random.choice(candidates)
    out = await _print_image(pick, payload)
    return {
        "name": pick.name,
        "rows": out["rows"],
        "density": out["density"],
        "seconds": out["seconds"],
        "count": len(candidates),
        "dir": str(EGG_DIR),
    }


def _shortcut_dir():
    d = DATA / "快捷"
    try:
        d.mkdir(parents=True, exist_ok=True)
    except Exception:
        pass
    return d


def _shortcut_file():
    d = _shortcut_dir()
    try:
        items = sorted(d.iterdir())
    except Exception:
        return None
    for p in items:
        if p.is_file() and p.suffix.lower() in IMG_EXT:
            return p
    return None


def op_shortcut_set(payload):
    """面板里点「设为连按 3 下要打印的图」：把当前图片存成快捷图。"""
    from PIL import Image

    text = payload.get("image_b64")
    if not text:
        path = str(payload.get("path") or "").strip()
        if not path:
            raise RuntimeError("没有可保存的图片")
        img = Image.open(path)
    else:
        img = _pil_open_b64(text)
    img = img.convert("RGB")
    d = _shortcut_dir()
    for old in d.iterdir():
        if old.is_file() and old.suffix.lower() in IMG_EXT:
            try:
                old.unlink()
            except Exception:
                pass
    name = "快捷.png"
    target = d / name
    img.save(target, "PNG")
    return {"name": target.name, "path": str(target), "width": img.width, "height": img.height, "dir": str(d)}


def op_shortcut_info(_payload):
    p = _shortcut_file()
    return {"set": p is not None, "name": p.name if p else "", "path": str(p) if p else "", "dir": str(_shortcut_dir())}


async def op_shortcut_print(payload):
    """连按 3 下打印的那张图。"""
    p = _shortcut_file()
    if p is None:
        raise RuntimeError("还没有设置连按 3 下的图：面板里粘贴图片后点「设为连按 3 下要打印的图」")
    out = await _print_image(p, payload)
    return {"name": p.name, "rows": out["rows"], "density": out["density"], "seconds": out["seconds"]}


# ---------------- 入口 ----------------

OPS = {
    "status": op_status,
    "print": op_print,
    "preview": op_preview,
    "grab": op_grab,
    "egg": op_egg,
    "shortcutSet": op_shortcut_set,
    "shortcutInfo": op_shortcut_info,
    "shortcutPrint": op_shortcut_print,
    "test": op_test,
    "settings": op_settings,
    "save": op_save,
    "queue": op_queue,
    "log": op_log,
    "watch": op_watch,
}


def _readable(text):
    return any("\u4e00" <= ch <= "\u9fff" for ch in str(text))


def _failure(exc):
    detail = "%s: %s" % (type(exc).__name__, exc)
    plain = str(exc)
    low = detail.lower()
    if "no device" in low or "not found" in low or "没有找到" in detail:
        return {"code": "offline", "message": "没找到打印机：确认开机、蓝牙已开、离电脑近一点，别被手机占着"}
    if "上盖" in detail or "没有纸" in detail:
        return {"code": "printer", "message": plain if _readable(plain) else detail}
    if "timeout" in low or "超时" in detail:
        return {"code": "timeout", "message": "打印机没有回应（%s）" % (plain if _readable(plain) else detail)}
    return {"code": "failed", "message": plain if _readable(plain) else detail}


def message(raw, loop=None):
    try:
        payload = json.loads(raw)
        if not isinstance(payload, dict):
            raise ValueError("需要 JSON 对象")
    except Exception as exc:
        return {"ok": False, "error": {"code": "bad-request", "message": "参数不是合法 JSON：%s" % exc}}
    op = str(payload.get("op") or "")
    handler = OPS.get(op)
    if handler is None:
        return {"ok": False, "error": {"code": "bad-request", "message": "未知操作：%s" % op}}
    try:
        if inspect.iscoroutinefunction(handler):
            value = loop.run_until_complete(handler(payload)) if loop is not None else asyncio.run(handler(payload))
        else:
            value = handler(payload)
        return {"ok": True, "value": value}
    except Exception as exc:
        return {"ok": False, "error": _failure(exc)}


def emit(msg, stream=None):
    target = stream if stream is not None else sys.stdout
    target.write(json.dumps(msg, ensure_ascii=False) + "\n")
    target.flush()


def serve():
    """常驻模式：stdin 一行一个请求，stdout 一行一个响应，事件循环与已导入的库全程复用。"""
    out = sys.stdout
    # 打印动作里的 print（如"找到打印机…"）全部改走 stderr，别污染一行一条的 JSON 协议
    sys.stdout = sys.stderr
    loop = asyncio.new_event_loop()
    asyncio.set_event_loop(loop)
    try:
        for line in sys.stdin:
            text = line.strip()
            if not text:
                continue
            emit(message(text, loop), out)
    finally:
        try:
            loop.run_until_complete(_drop_session())
        except Exception:
            pass
        sys.stdout = out


def main():
    if "--serve" in sys.argv[1:]:
        serve()
        return
    raw = sys.argv[1] if len(sys.argv) > 1 else ""
    if not raw.strip():
        try:
            if not sys.stdin.isatty():
                raw = sys.stdin.read()
        except Exception:
            raw = ""
    if not raw.strip():
        raw = "{}"
    emit(message(raw))


if __name__ == "__main__":
    main()
