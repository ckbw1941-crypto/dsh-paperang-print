# 喵喵机打印 · dsh-paperang-print

把**作业帮喵喵机 P2 HD**（57mm 热敏打印机）接到电脑上，在 DSH 左侧菜单里直接打印文字和图片，不用再开手机 App。

这个插件没有界面之外的服务：Host 侧启动本地 Python 脚本，通过蓝牙低功耗（BLE）的 FF00 服务直连打印机，用 A5 协议发送点阵数据。不经过任何云端，不联网。

## 能做什么

- **打印文字**：写内容、选字号，直接出纸。
- **粘贴图片直接打印**：`Ctrl+V` 把截图/复制来的图片贴进面板，或把图片文件拖进去，全程不落盘。
- **打印前预览**：把图片按当前设置二值化成真实点阵，显示 576 点宽、预计行数与毫米数，确认后再打。
- **灰阶开关**：开 = Floyd–Steinberg 抖动（照片过渡自然），关 = 纯黑白阈值（字更硬）。
- **缩放 / 旋转**：20%–100% 缩放让内容变短，左右自动留白；左右转 90° 把竖图横着打。
- **浓度与走纸**：0–100 浓度、尾部走纸行数，保存后面板打印和自动打印都生效。
- **自动打印文件夹**：开关一开，文件夹里出现的图片/文本自动打印，打完移到 `已打印`，坏文件进 `失败`。
- **打印机状态**：电量、固件版本、序列号、分辨率、纸张、上盖。
- **手势彩蛋**：双击面板左上角图标打一张随机彩蛋图；连点标题 5 下也是彩蛋。包里自带 4 张示例图，第一次用会自动放进 `彩蛋` 文件夹。

## 安装

在 DSH 的「插件」页面安装本仓库（源码安装），或使用命令行：

```
dsh plugin add https://github.com/ckbw1941-crypto/dsh-paperang-print
```

装好后左侧菜单出现「喵喵机打印」。**第一次使用前**，在面板里点「准备打印环境」（Host 侧会在数据目录下建一个 Python 虚拟环境并安装 `bleak`、`Pillow`、`numpy`，需要能访问 PyPI，约 1–2 分钟）。本机已有 Python 3.10+ 的话也可以直接在插件配置里填 `pythonPath` 指过去。

## 前提

- 打印机**开机**、离电脑近，并且已和这台电脑**蓝牙配对**过（系统设置里配对一次即可）。
- 同一时刻只能有一个程序连着打印机：手机 App 连着时电脑连不上。
- 纸宽 57mm，有效宽度 576 点（300dpi）。图片等比缩放到 576 宽。
- 开发与实测都在 **Windows 11** 上完成；底层是跨平台的 `bleak`，macOS / Linux 理论上可用，但没实测。

## 配置

插件行 `config` 全部可选：

```json
{
  "dataDir": "C:\\Users\\me\\AppData\\Local\\dsh-paperang",
  "pythonPath": "C:\\Python312\\python.exe",
  "address": "17:6F:01:02:FE:7B"
}
```

- `dataDir`：放 `settings.json`、`待打印/`、`已打印/`、`失败/`、`watch.log` 和虚拟环境的目录，默认 `%LOCALAPPDATA%\dsh-paperang`。
- `pythonPath`：指定解释器，默认依次尝试 `dataDir/venv`、PATH 里的 `python`。
- `address`：打印机 BLE 地址，留空则扫描名字里带 `Paperang` 的设备。

面板里还有「打印通道」「数据目录」等自查信息，出问题时先看那里。

## 工作原理

```
浏览器面板 → connection RPC /paperang（缺失时回落 webServer 前缀路由）
           → Host 侧 spawn py/mmj_bridge.py（stdin 传一行 JSON）
           → py/mmj_print.py → bleak → BLE FF00 (write ff02 / notify ff01,ff03) → A5 帧
```

- 帧格式：`A5 01 | len(LE16) | payload | crc32(payload, seed 0x35769521)(LE32) | 5A`；payload 内层为 `command(BE16) | msgType | contentLen(LE16) | content`。
- 打印时序：浓度 `0x0511` → 纸张类型 `0x0520` → 开始 `0x0519` → 位图块 `0x051B`（序号递增，72 字节/行）→ 结束 `0x051A`。开始到结束之间不插入查询，P2 HD 固件不逐块回 ack。
- 位图 MSB 在前、1 为黑；576 点宽 = 72 字节/行。

A5 协议参考：[Orangray-MDJX/paperang-p1-connect](https://github.com/Orangray-MDJX/paperang-p1-connect)（P1 抓包实现）。经典蓝牙 SPP 在这台 P2 HD 上收到任意字节就断链，所以只走 BLE。

## 隐私

- 图片只从面板内存发给本地 Python，不写盘、不上传（选了「按路径打印」时由本地脚本读该文件）。
- 唯一的联网行为是首次「准备打印环境」时 `pip install` 三个依赖。
- 不收集任何数据，没有遥测。

## 已知限制

- 不做系统打印队列（不能 `Ctrl+P`），打印入口在面板、文件夹、命令行三处。
- 一次打印最大 12000 行（约 1 米纸）。
- 未在 P1/P2/P2s/P3 上验证；其他型号的 A5 细节可能不同。

## 许可

MIT。与作业帮 / 喵喵机官方无关，是社区逆向实现。

---

## English

Print on a Paperang (喵喵机) P2 HD thermal printer from DSH — text, pasted images with a real bitmap preview, and a watched folder that prints automatically. The plugin ships a small Python bridge that talks BLE FF00 with the A5 protocol; nothing leaves the machine (only `pip install` touches the network, once).

Install the repository as a DSH plugin, open 「喵喵机打印」 in the sidebar, press “Prepare environment” once, and pair the printer in Windows Bluetooth settings beforehand. Tested on Windows 11; the transport is `bleak`, so macOS/Linux should work in principle but is untested. MIT licensed, unaffiliated with the vendor.
