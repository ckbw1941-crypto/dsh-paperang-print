#!/usr/bin/env python
"""喵喵机 P2 HD 自动打印：监控一个文件夹，图片/文字文件放进去就自动打印。

用法：
  pythonw mmj_watch.py          # 后台静默运行（推荐，开机自启用这个）
  python  mmj_watch.py --once   # 只跑一轮，便于排查
日志：watch.log（同目录）
"""
import asyncio
import ctypes
import os
import shutil
import sys
import time
import traceback
from pathlib import Path

import mmj_print as M

try:
    from PIL import Image
except ImportError:
    Image = None

BASE = Path(__file__).resolve().parent
DATA = Path(os.environ.get("MMJ_DATA") or BASE)
try:
    DATA.mkdir(parents=True, exist_ok=True)
except Exception:
    pass
WATCH = Path(os.environ.get("MMJ_WATCH_DIR") or (DATA / "\u5f85\u6253\u5370"))
DONE = WATCH / "\u5df2\u6253\u5370"
FAIL = WATCH / "\u5931\u8d25"
LOG = DATA / "watch.log"
PID_FILE = DATA / "watch.pid"

POLL = 2.0
DENSITY = int(os.environ.get("MMJ_DENSITY", "70"))
FEED = int(os.environ.get("MMJ_FEED", "30"))
MAX_ATTEMPTS = 20
RETRY_DELAY = 30.0

TEXT_EXT = {".txt", ".md"}


class BadFile(Exception):
    pass


def move_away(src, dst):
    """把处理过的文件挪走。挪不动（权限/占用）时退回复制+删除，仍失败就返回 False。"""
    try:
        shutil.move(src, dst)
        return True
    except Exception:
        pass
    try:
        shutil.copy2(src, dst)
    except Exception as e:
        log("复制到 %s 失败：%s" % (Path(dst).parent.name, e))
        return False
    try:
        os.remove(src)
        return True
    except Exception:
        return False


# ---------------- 基础工具 ----------------

def say(msg):
    if sys.stdout:
        try:
            print(msg, flush=True)
        except Exception:
            pass


def log(msg):
    line = "[%s] %s\n" % (time.strftime("%m-%d %H:%M:%S"), msg)
    say(msg)
    try:
        if LOG.exists() and LOG.stat().st_size > 1024 * 1024:
            LOG.replace(LOG.with_suffix(".log.old"))
        with open(LOG, "a", encoding="utf-8") as f:
            f.write(line)
    except Exception:
        pass


def pid_alive(pid):
    h = ctypes.windll.kernel32.OpenProcess(0x1000, False, int(pid))
    if h:
        ctypes.windll.kernel32.CloseHandle(h)
        return True
    return False


def take_lock():
    if PID_FILE.exists():
        try:
            old = int(PID_FILE.read_text().strip() or 0)
        except Exception:
            old = 0
        if old and old != os.getpid() and pid_alive(old):
            return False
    PID_FILE.write_text(str(os.getpid()))
    return True


def release_lock():
    try:
        if PID_FILE.exists() and PID_FILE.read_text().strip() == str(os.getpid()):
            PID_FILE.unlink()
    except Exception:
        pass


def unique(path):
    if not path.exists():
        return path
    stem, suffix = path.stem, path.suffix
    for i in range(1, 1000):
        cand = path.with_name("%s-%d%s" % (stem, i, suffix))
        if not cand.exists():
            return cand
    return path.with_name("%s-%d%s" % (stem, int(time.time()), suffix))


def is_doc(img):
    """颜色种类少的图（截图、表格、曲线）按文档处理，字更实；照片则抖动。"""
    try:
        return img.convert("RGB").getcolors(maxcolors=1024) is not None
    except Exception:
        return False


# ---------------- 打印 ----------------

async def print_file(p, density, feed, dither=True):
    ext = p.suffix.lower()
    if ext in M.IMG_EXT:
        img = Image.open(p)
        img.load()
        doc = is_doc(img)
        rows, h = M.image_to_rows(img, doc=doc, dither=dither)
        mode = "文档" if doc else "照片"
    elif ext in TEXT_EXT:
        rows, h = M.text_to_rows(p.read_text(encoding="utf-8", errors="replace"))
        mode = "文字"
    else:
        raise BadFile("不支持的格式 %s" % ext)

    if h > M.MAX_ROWS:
        raise BadFile("内容太长（%d 行 ≈ %.0fcm），已拒绝" % (h, h * 25.4 / 300 / 10))

    pr = M.Printer()
    await pr.connect(tries=1)
    try:
        st = await pr.status()
        if st.get("paper") is False:
            raise RuntimeError("打印机缺纸")
        if st.get("lid") is False:
            raise RuntimeError("打印机上盖没合好")
        secs = await pr.print_bitmap(rows, density=density, post_feed=feed)
    finally:
        await pr.close()
    return h, mode, secs


# ---------------- 主循环 ----------------

class Stability:
    """文件写盘没完成时不要动它：等大小和修改时间稳定。"""

    def __init__(self):
        self.seen = {}

    def ready(self, p):
        try:
            st = p.stat()
        except Exception:
            return False
        key = (st.st_size, st.st_mtime)
        prev = self.seen.get(str(p))
        self.seen[str(p)] = key
        if prev != key:
            return False
        return time.time() - st.st_mtime > 1.0


async def main_async(once=False):
    WATCH.mkdir(parents=True, exist_ok=True)
    DONE.mkdir(parents=True, exist_ok=True)
    FAIL.mkdir(parents=True, exist_ok=True)

    stab = Stability()
    attempts = {}
    next_try = {}
    skip = set()
    cycles = 0
    cfg = M.load_settings()
    log("自动打印已启动，监控目录：%s（浓度 %d，尾部走纸 %d 行，灰阶%s）"
        % (WATCH, cfg["density"], cfg["feed"], "开" if cfg.get("dither", True) else "关"))
    say("把图片或 txt 放进上面这个文件夹就会自动打印。按 Ctrl+C 退出。")

    while True:
        cfg = M.load_settings()   # 改设置后不用重启，下一轮就生效
        try:
            files = [p for p in sorted(WATCH.iterdir())
                     if p.is_file() and not p.name.startswith((".", "~$"))]
        except Exception as e:
            log("读取监控目录失败: %s" % e)
            files = []

        for p in files:
            key = str(p)
            if key in skip:
                continue
            if not stab.ready(p):
                continue
            if next_try.get(key, 0) > time.time():
                continue
            try:
                h, mode, secs = await print_file(p, density=cfg["density"], feed=cfg["feed"], dither=cfg.get("dither", True))
                dest = unique(DONE / p.name)
                moved = move_away(key, str(dest))
                attempts.pop(key, None)
                next_try.pop(key, None)
                log("✅ 已打印 %s（%s，%d 行 ≈ %.0fmm，浓度 %d，%.1fs）"
                    % (p.name, mode, h, h * 25.4 / 300, cfg["density"], secs))
                if not moved:
                    skip.add(key)
                    log("⚠ 已打印，但这个文件没法从待打印文件夹挪走（权限或占用），已跳过")
            except BadFile as e:
                move_away(key, str(unique(FAIL / p.name)))
                log("❌ 无法处理 %s：%s" % (p.name, e))
            except Exception as e:
                n = attempts.get(key, 0) + 1
                attempts[key] = n
                brief = "%s: %s" % (type(e).__name__, e)
                if n >= MAX_ATTEMPTS:
                    move_away(key, str(unique(FAIL / p.name)))
                    log("❌ 放弃 %s（连续失败 %d 次）：%s" % (p.name, n, brief))
                    attempts.pop(key, None)
                    next_try.pop(key, None)
                else:
                    next_try[key] = time.time() + RETRY_DELAY
                    log("⏳ %s 第 %d 次失败，%d 秒后重试：%s"
                        % (p.name, n, int(RETRY_DELAY), brief))

        if once:
            cycles += 1
            if cycles >= 3:
                return 0
            await asyncio.sleep(1.5)
            continue
        await asyncio.sleep(POLL)


def main():
    once = "--once" in sys.argv
    if not take_lock():
        say("已经有一个自动打印在运行了（见 watch.pid）。要重启请先运行「停止自动打印.bat」。")
        return 0
    try:
        return asyncio.run(main_async(once=once))
    except KeyboardInterrupt:
        log("收到退出信号，自动打印已停止。")
        return 0
    except Exception:
        log("自动打印异常退出：\n" + traceback.format_exc())
        return 1
    finally:
        release_lock()


if __name__ == "__main__":
    sys.exit(main())
