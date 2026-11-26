#!/usr/bin/env python
"""喵喵机 P2 HD 电脑蓝牙打印（BLE / A5 协议）

用法:
  python mmj_print.py 图片1.png 图片2.jpg        # 打印图片（照片用抖动）
  python mmj_print.py --doc 论文截图.png         # 按文档处理（纯黑白，字更实）
  python mmj_print.py --text "要打印的文字"      # 打印文字
  python mmj_print.py --density 85 图.jpg        # 调浓度 0-100（默认 70）
  python mmj_print.py --feed 40 图.jpg           # 打完多走纸 40 行（约 3.4mm）
"""
import argparse
import asyncio
import json
import os
import struct
import sys
import time
import zlib
from pathlib import Path

import numpy as np

try:
    from PIL import Image, ImageDraw, ImageFont
except ImportError:
    sys.exit("缺少 Pillow，请先安装: pip install pillow")

ADDR = os.environ.get("MMJ_ADDR", "").strip()  # 留空就自动扫描名字像 Paperang 的设备
WR = "0000ff02-c243-40b9-ac41-a10ba3ad5d1a"
NT = "0000ff01-c243-40b9-ac41-a10ba3ad5d1a"
ST = "0000ff03-c243-40b9-ac41-a10ba3ad5d1a"
SEED = 0x35769521
ROW_BYTES = 72          # 576 点 @ 300dpi
WIDTH_PX = ROW_BYTES * 8
MAX_ROWS = 12000        # 约 1 米，防止误打印超长图

IMG_EXT = {".png", ".jpg", ".jpeg", ".bmp", ".webp", ".gif", ".tif", ".tiff"}

DATA_DIR = Path(os.environ.get("MMJ_DATA") or Path(__file__).resolve().parent)
try:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
except Exception:
    pass
SETTINGS = DATA_DIR / "settings.json"
DEFAULT_DENSITY = 70
DEFAULT_FEED = 30
DEFAULT_DITHER = True


def load_settings():
    """全局默认设置，GUI 和自动打印共享。文件坏了就用默认值。"""
    out = {"density": DEFAULT_DENSITY, "feed": DEFAULT_FEED, "dither": DEFAULT_DITHER}
    try:
        data = json.loads(SETTINGS.read_text(encoding="utf-8"))
    except Exception:
        return out
    for k in ("density", "feed"):
        v = data.get(k)
        if isinstance(v, (int, float)):
            out[k] = int(v)
    if isinstance(data.get("dither"), bool):
        out["dither"] = data["dither"]
    out["density"] = max(0, min(100, out["density"]))
    out["feed"] = max(0, min(300, out["feed"]))
    return out


def save_settings(density, feed, dither=DEFAULT_DITHER):
    SETTINGS.write_text(
        json.dumps(
            {"density": int(density), "feed": int(feed), "dither": bool(dither)},
            ensure_ascii=False,
            indent=2,
        ),
        encoding="utf-8")


# ---------------- A5 协议 ----------------

def build(cmd, content=b"", msg_type=1):
    payload = (struct.pack(">H", cmd) + bytes([msg_type])
               + struct.pack("<H", len(content)) + content)
    return (b"\xA5\x01" + struct.pack("<H", len(payload)) + payload
            + struct.pack("<I", zlib.crc32(payload, SEED) & 0xFFFFFFFF) + b"\x5A")


def parse_tlv(data):
    out = {}
    while data:
        if len(data) < 3:
            return None
        key, size = data[0], struct.unpack_from("<H", data, 1)[0]
        if size > len(data) - 3:
            return None
        out[key] = data[3:3 + size]
        data = data[3 + size:]
    return out


def bitmap_content(rows, order, row_bytes=ROW_BYTES):
    inner = struct.pack("<BHHBH", 1, row_bytes, 0, 0, len(rows)) + rows
    return struct.pack("<HH", order, len(inner)) + inner


class Parser:
    def __init__(self):
        self.buf = bytearray()

    def feed(self, data):
        self.buf.extend(data)
        frames = []
        while len(self.buf) >= 4:
            if self.buf[0] != 0xA5 or self.buf[1] not in (0, 1):
                del self.buf[0]
                continue
            size = struct.unpack_from("<H", self.buf, 2)[0]
            if size < 5:
                del self.buf[0]
                continue
            total = size + 9
            if len(self.buf) < total:
                break
            payload = bytes(self.buf[4:4 + size])
            crc = struct.unpack_from("<I", self.buf, 4 + size)[0]
            inner = struct.unpack_from("<H", payload, 3)[0]
            if (self.buf[total - 1] != 0x5A
                    or crc != (zlib.crc32(payload, SEED) & 0xFFFFFFFF)
                    or inner != size - 5):
                del self.buf[0]
                continue
            frames.append((int.from_bytes(payload[:2], "big"), payload[2], payload[5:]))
            del self.buf[:total]
        return frames


class Printer:
    def __init__(self):
        self.parser = Parser()
        self.pending = None
        self.mtu = 185
        self.client = None

    # ---- 连接 ----
    async def connect(self, tries=3):
        from bleak import BleakClient, BleakScanner
        dev = None
        target = ADDR or None
        if not target:
            found = await BleakScanner.discover(timeout=10)
            for item in found:
                name = (getattr(item, "name", "") or "").strip()
                upper = name.upper()
                if "PAPERANG" in upper or "\u55b5\u55b5" in name or upper.startswith("P2"):
                    target = item.address
                    dev = item
                    print("  \u627e\u5230\u6253\u5370\u673a\uff1a%s\uff08%s\uff09" % (name, item.address))
                    break
            if dev is None:
                raise RuntimeError(
                    "\u6ca1\u626b\u5230\u55b5\u55b5\u673a\u3002\u8bf7\u786e\u8ba4\u6253\u5370\u673a\u5df2\u5f00\u673a\u3001"
                    "\u7535\u8111\u84dd\u7259\u5df2\u6253\u5f00\u3001\u79bb\u7535\u8111\u8fd1\u4e00\u70b9\uff0c\u4e5f\u6ca1\u88ab\u624b\u673a\u8fde\u7740\u3002"
                )
        for i in range(tries):
            dev = await BleakScanner.find_device_by_address(target, timeout=12)
            if dev:
                break
            print(f"  第 {i + 1} 次没扫到打印机，重试…")
        if dev is None:
            raise RuntimeError("没找到打印机。请确认：打印机已开机、蓝牙已打开、离电脑近一点、没被手机连着。")
        self.client = BleakClient(dev, timeout=25)
        await self.client.connect()
        for u in (NT, ST):
            await self.client.start_notify(u, self._on_notify)
        await asyncio.sleep(0.3)
        try:
            self.mtu = self.client.mtu_size
        except Exception:
            pass
        return True

    async def close(self):
        if self.client:
            try:
                await self.client.disconnect()
            except Exception:
                pass

    def _on_notify(self, _sender, data):
        for cmd, mtype, content in self.parser.feed(bytes(data)):
            if self.pending and mtype == 2 and cmd == self.pending[0] and not self.pending[1].done():
                self.pending[1].set_result(content)

    # ---- 命令 ----
    async def command(self, cmd, content=b"", timeout=10):
        fut = asyncio.get_running_loop().create_future()
        self.pending = (cmd, fut)
        try:
            await self.client.write_gatt_char(WR, build(cmd, content), response=True)
            return await asyncio.wait_for(fut, timeout)
        finally:
            self.pending = None

    async def ack(self, cmd, content=b"", timeout=10):
        return await self.command(cmd, content, timeout=timeout)

    async def query(self, cmd, timeout=6):
        content = await self.command(cmd, timeout=timeout)
        values = parse_tlv(content)
        if not values or 1 not in values:
            raise RuntimeError(f"命令 0x{cmd:04X} 无有效返回: {content.hex()}")
        return values[1]

    async def status(self):
        out = {}
        try:
            out["version"] = (await self.query(0x0115)).decode("ascii", "ignore").strip("\x00")
            out["sn"] = (await self.query(0x0102)).decode("ascii", "ignore").strip("\x00")
            raw = await self.query(0x010B)
            out["battery"] = int.from_bytes(raw[:2], "little") / 10 if len(raw) >= 2 else None
            raw = await self.query(0x0504)
            out["dpi"] = int.from_bytes(raw[:2], "little") if len(raw) == 2 else None
            out["lid"] = (await self.query(0x050C)) == b"\x01"
            out["paper"] = (await self.query(0x050D)) == b"\x01"
        except Exception:
            pass
        return out

    async def feed(self, lines):
        await self.ack(0x0516, struct.pack("<H", int(lines)))

    # ---- 打印 ----
    async def print_bitmap(self, rows, density=70, post_feed=0):
        if not rows or len(rows) % ROW_BYTES:
            raise RuntimeError("位图数据必须是整行")
        total_rows = len(rows) // ROW_BYTES
        overhead = 21
        chunk_rows = max(1, (self.mtu - 3 - overhead) // ROW_BYTES)
        chunk = chunk_rows * ROW_BYTES

        await self.ack(0x0511, bytes([max(0, min(100, int(density)))]))   # 浓度
        await self.ack(0x0520, b"\x00\x00")                                # 纸张类型
        await self.ack(0x0519)                                             # 开始
        t0 = time.time()
        order = 1
        n = (len(rows) + chunk - 1) // chunk
        for off in range(0, len(rows), chunk):
            frame = build(0x051B, bitmap_content(rows[off:off + chunk], order))
            await self.client.write_gatt_char(WR, frame, response=True)
            if total_rows > 200 and (order % 50 == 0 or order == n):
                print(f"  发送中 {order}/{n}  {time.time() - t0:.1f}s")
            order += 1
        await asyncio.sleep(0.8)
        await self.ack(0x051A, timeout=90)                                 # 结束/出纸
        if post_feed:
            try:
                await self.feed(post_feed)
            except Exception:
                pass
        return time.time() - t0


# ---------------- 图像处理 ----------------

def find_font(size):
    for name in ("msyh.ttc", "msyhl.ttc", "simhei.ttf", "simsun.ttc"):
        p = Path("C:/Windows/Fonts") / name
        if p.exists():
            try:
                return ImageFont.truetype(str(p), size)
            except Exception:
                continue
    return ImageFont.load_default()


def image_to_rows(src, doc=False, dither=True, scale=1.0, rotate=0):
    """把图片转成打印机行数据。

    doc=True  截图/文字类，走固定阈值，线条更硬
    dither=True  照片类，Floyd–Steinberg 抖动，模拟灰阶
    dither=False 纯黑白阈值，不用灰阶
    scale    0.2~1.0，按比例缩小内容宽度（左右留白），用来把长图打短一点
    rotate   90/180/270 顺时针旋转（只按 90 的整数倍取整）
    """
    img = src if isinstance(src, Image.Image) else Image.open(src)
    if getattr(img, "n_frames", 1) > 1:
        img.seek(0)
    img = img.convert("L")
    turn = int(rotate or 0) % 360
    turn = turn - (turn % 90)
    if turn:
        # PIL 的 rotate 是逆时针，取负号表示顺时针
        img = img.rotate(-turn, expand=True)
    w, h = img.size
    if w <= 0 or h <= 0:
        raise RuntimeError("图片尺寸异常")
    try:
        ratio = float(scale)
    except (TypeError, ValueError):
        ratio = 1.0
    ratio = max(0.2, min(1.0, ratio))
    target_w = max(1, int(round(WIDTH_PX * ratio)))
    new_h = max(1, int(round(h * (target_w / w))))
    img = img.resize((target_w, new_h), Image.LANCZOS)
    if doc:
        arr = np.array(img)
        mask = arr < 165
    elif not dither:
        arr = np.array(img)
        mask = arr < 128
    else:
        bw = img.convert("1", dither=Image.Dither.FLOYDSTEINBERG)
        mask = np.array(bw) == 0
    if target_w < WIDTH_PX:
        # 居中贴到 576 点宽的白底上，行数据仍然每行 72 字节
        canvas = np.zeros((new_h, WIDTH_PX), dtype=bool)
        left = (WIDTH_PX - target_w) // 2
        canvas[:, left:left + target_w] = mask
        mask = canvas
    return np.packbits(mask, axis=1).tobytes(), mask.shape[0]


def text_to_rows(text, font_size=30, margin=16):
    font = find_font(font_size)
    line_h = int(font_size * 1.55)
    max_w = WIDTH_PX - 2 * margin
    lines = []
    for raw in text.splitlines() or [""]:
        cur = ""
        for ch in raw:
            if font.getlength(cur + ch) <= max_w:
                cur += ch
            else:
                lines.append(cur)
                cur = ch
        lines.append(cur)
    if not lines:
        lines = [""]
    h = line_h * len(lines) + 2 * margin
    img = Image.new("L", (WIDTH_PX, h), 255)
    d = ImageDraw.Draw(img)
    y = margin
    for ln in lines:
        d.text((margin, y), ln, font=font, fill=0)
        y += line_h
    mask = np.array(img) < 165
    return np.packbits(mask, axis=1).tobytes(), h


# ---------------- 入口 ----------------

async def run(args):
    cfg = load_settings()
    density = args.density if args.density is not None else cfg["density"]
    feed = args.feed if args.feed is not None else cfg["feed"]
    dither = cfg["dither"] if not args.no_dither else False

    jobs = []
    for f in args.files:
        p = Path(f)
        if not p.exists():
            print(f"跳过（找不到文件）: {f}")
            continue
        if p.suffix.lower() not in IMG_EXT:
            print(f"跳过（不是图片格式）: {p.name}")
            continue
        rows, h = image_to_rows(p, doc=args.doc, dither=dither)
        jobs.append((p.name, rows, h))
    if args.text:
        rows, h = text_to_rows(args.text, args.font_size)
        jobs.append(("文字", rows, h))
    if args.clip:
        try:
            from PIL import ImageGrab
            data = ImageGrab.grabclipboard()
        except Exception as e:
            print(f"读取剪贴板失败: {e}")
            data = None
        if isinstance(data, Image.Image):
            rows, h = image_to_rows(data, doc=args.doc, dither=dither)
            jobs.append(("剪贴板图片", rows, h))
        elif isinstance(data, list) and data:
            for f in data:
                p = Path(f)
                if p.suffix.lower() in IMG_EXT and p.exists():
                    rows, h = image_to_rows(p, doc=args.doc, dither=dither)
                    jobs.append((p.name, rows, h))
        elif data is None and not args.files and not args.text:
            print("剪贴板里没有图片。可以先截图（Win+Shift+S）再运行 --clip。")

    if not jobs:
        print("没有可打印的内容。用法：把图片拖到这个窗口/图标上，或用 --text 打印文字。")
        return 1

    total_rows = sum(h for _, _, h in jobs)
    if total_rows > MAX_ROWS:
        print(f"内容太长（{total_rows} 行 ≈ {total_rows * 25.4 / 300 / 10:.0f}cm），请改成更短的图。")
        return 1

    pr = Printer()
    print(f"正在连接打印机…（浓度 {density}，尾部走纸 {feed} 行）")
    await pr.connect()
    st = await pr.status()
    if st:
        bits = []
        if st.get("sn"):
            bits.append(st["sn"])
        if st.get("battery") is not None:
            bits.append(f"电量 {st['battery']:.0f}%")
        if st.get("dpi"):
            bits.append(f"{st['dpi']}dpi")
        if st.get("lid") is False:
            bits.append("⚠ 上盖未合好")
        if st.get("paper") is False:
            bits.append("⚠ 缺纸")
        print("设备: " + " / ".join(bits))
        if st.get("paper") is False:
            print("检测到缺纸，已中止。")
            await pr.close()
            return 1
    try:
        for name, rows, h in jobs:
            mm = h * 25.4 / 300
            print(f"打印 {name}（{h} 行 ≈ {mm:.0f}mm）…")
            secs = await pr.print_bitmap(rows, density=density, post_feed=feed)
            print(f"  完成，用时 {secs:.1f}s")
    finally:
        await pr.close()
    print("全部打印任务已发送完毕。")
    return 0


def main():
    ap = argparse.ArgumentParser(description="喵喵机 P2 HD 电脑蓝牙打印")
    ap.add_argument("files", nargs="*", help="要打印的图片文件")
    ap.add_argument("--text", help="打印一段文字")
    ap.add_argument("--clip", action="store_true", help="打印剪贴板里的图片（配合 Win+Shift+S 截图）")
    ap.add_argument("--doc", action="store_true", help="按文档处理（阈值更硬，适合截图）")
    ap.add_argument("--no-dither", action="store_true", help="关掉灰阶抖动，只打纯黑白")
    ap.add_argument("--density", type=int, default=None, help=f"打印浓度 0-100，不填用设置里的值（默认 {DEFAULT_DENSITY}）")
    ap.add_argument("--feed", type=int, default=None, help=f"打完多走纸的行数，不填用设置里的值（默认 {DEFAULT_FEED}，约 2.5mm）")
    ap.add_argument("--font-size", type=int, default=30, help="文字字号，默认 30")
    args = ap.parse_args()
    if not args.files and not args.text and not args.clip:
        ap.print_help()
        return 0
    try:
        return asyncio.run(run(args))
    except KeyboardInterrupt:
        return 130
    except Exception as e:
        print(f"\n出错了: {type(e).__name__}: {e}")
        return 1


if __name__ == "__main__":
    sys.exit(main())
