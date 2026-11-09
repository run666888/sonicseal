# SonicSeal 电台版 — ESP32-C3 + HC-12

两台小板子，一块接一块，中间走 433 MHz。你在 A 板敲一句英文，B 板的屏幕上出现它；
中间那段无线电波是密文，别人捡到天线也解不开。

所有代码都已写完并在电脑上自测通过，**还差把文件烧进板子**——这一步需要你插 USB。

---

## 一、要买的东西

| 数量 | 东西 | 搜索关键词 | 参考价 |
|---|---|---|---|
| 2 | 主控板 | `WeAct ESP32-C3 Core` 或 `ESP32-C3 SuperMini 已焊排针` | ¥25 / 块 |
| 2 | 无线串口 | `HC-12 433MHz 无线串口模块 SMA 弹簧天线` | ¥20 / 个 |
| 2 | 屏幕（可选） | `0.96寸 OLED SSD1306 I2C 4针` | ¥10 / 块 |
| 1 把 | 杜邦线 | `母对母 杜邦线 20cm` | ¥5 |

合计约 ¥120。**不要买 CP2102/CP2104 的板子**（多数 CH340 也不稳），
WeAct C3 用的是芯片自带 USB，插上就能认，不用装驱动。

---

## 二、接线（每块板都一样）

```
ESP32-C3          HC-12
---------         -------
5V       ──────►  VCC        ← 一定接 5V，3V3 发射功率不够，距离差一大截
GND      ──────►  GND
GPIO4    ──────►  RXD        ← 注意是交叉：板子的 TX 接模块的 RXD
GPIO3    ──────►  TXD        ← 板子的 RX 接模块的 TXD
GPIO5    ──────►  SET        （可选，只有要改频道时才需要）
```

OLED（如果有，4 针 I2C）：

```
ESP32-C3          OLED
---------         ----
3V3      ──────►  VCC
GND      ──────►  GND
GPIO6    ──────►  SDA
GPIO7    ──────►  SCL
```

两块板的接线完全相同；两块 HC-12 拿到手就出厂同频道，**不用改**。

---

## 三、烧固件（一次性，约 2 分钟）

固件已经下好并校验过了：`firmware/esp32c3-micropython.bin`（MicroPython 1.25，ESP32-C3 / 4MB）。

1. USB 线插上板子，看设备管理器里多出来的串口（比如 `COM3`）。
2. 烧录（按你的实际端口替换 `COM3`）：

```powershell
& "D:\miniconda\envs\dl-py312\Scripts\esptool.exe" --chip esp32c3 --port COM3 erase_flash
& "D:\miniconda\envs\dl-py312\Scripts\esptool.exe" --chip esp32c3 --port COM3 --baud 460800 write_flash -z 0x0 D:\run_keys\firmware\esp32c3-micropython.bin
```

> esptool 5.x 的可执行文件叫 `esptool.exe`，没有 `esptool.py`，别被网上的教程带歪。
> 如果提示无法连接，按住板子上的 BOOT 再点一下 RESET，松开 BOOT 后重试。

3. 传文件（把代码放进板子）：

```powershell
cd D:\run_keys
& "D:\miniconda\envs\dl-py312\Scripts\mpremote.exe" connect COM3 cp firmware/config.py :config.py
& "D:\miniconda\envs\dl-py312\Scripts\mpremote.exe" connect COM3 cp firmware/main.py :main.py
& "D:\miniconda\envs\dl-py312\Scripts\mpremote.exe" connect COM3 cp firmware/lib/aes_pure.py :aes_pure.py
& "D:\miniconda\envs\dl-py312\Scripts\mpremote.exe" connect COM3 cp firmware/lib/ss_gcm.py :ss_gcm.py
& "D:\miniconda\envs\dl-py312\Scripts\mpremote.exe" connect COM3 cp firmware/lib/ss_envelope.py :ss_envelope.py
& "D:\miniconda\envs\dl-py312\Scripts\mpremote.exe" connect COM3 cp firmware/lib/ss_link.py :ss_link.py
& "D:\miniconda\envs\dl-py312\Scripts\mpremote.exe" connect COM3 cp firmware/lib/ss_node.py :ss_node.py
& "D:\miniconda\envs\dl-py312\Scripts\mpremote.exe" connect COM3 cp firmware/lib/ssd1306_min.py :ssd1306_min.py
```

（想让开机就自动跑，`main.py` 这个名字已经对了：MicroPython 上电就执行它。）

4. 打开串口看一看（任意串口助手，**115200 8N1**，或者直接 `mpremote connect COM3 repl`）：

```
SonicSeal radio node
  uart1  9600 baud  tx=4 rx=3
  key    none (clear text)
  type "help" for commands
```

5. 自检（不用第二块板也能验）：

```
test
```

应当回 `self-test ok: 1 frame(s), ...`。这一步跑的是真加解密，能过说明板子、
加密模块、帧格式全都正常。

---

## 四、两块板配对

两块板必须**同一把密钥**、**同一个频道**。频道出厂就一致，密钥这样生成：

```powershell
python D:\run_keys\firmware\tools\make-key.py
```

它打印两行，把 `KEY_HEX = '...'` 那一行填进两块板的 `firmware/config.py`，
然后重新 `cp` 一次 config.py 到两块板。填好后 `status` 里会显示 `key=yes`。

想临时改密钥不重新烧：直接串口里敲

```
key 00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff
```

（64 个十六进制字符；敲 `key off` 就回到明文模式。）

---

## 五、用起来

两块板各接一个串口终端，在 A 的上位机窗口里：

```
send Meet me by the old lighthouse at nine.
```

B 那边立刻打印：

```
> [AES-GCM] Meet me by the old lighthouse at nine.
```

屏幕（如果装了 OLED）也会显示这句话。

| 命令 | 作用 |
|---|---|
| `send <英文>` | 加密并发送 |
| `key <64 hex>` / `key off` | 换密钥 / 关加密 |
| `status` | 收发计数、密钥状态 |
| `test` | 本机加解密自检 |
| `help` | 命令列表 |

---

## 六、和网页互通

网页版（`node serve.cjs` → <http://localhost:8787>）和设备用的是**同一套帧格式**。
在网页的密钥框里填：

```
key:00112233...（同样是 64 位 hex，前面加 key: 前缀）
```

网页就知道该走原始密钥、跳过 21 万轮 PBKDF2。不过设备**只能收 433**，网页**只能发声音**，
两边之间还差一个"翻译器"——也就是下一步要做的 USB 串口桥（用浏览器 Web Serial
把声学帧写进板子，或者反过来把板子的电台帧送回网页）。

顺带一提：加密强度没打折。设备上省掉的只是"从口令派生密钥"这一步
（PBKDF2 在那块芯片上要 60–90 秒），真正保护消息的 AES-256-GCM 一模一样。

---

## 七、出问题先看这里

| 现象 | 原因 / 处理 |
|---|---|
| 串口一片空白 | 换根数据线；确认选的是 CDC 口不是蓝牙口；波特率 115200 |
| 敲 `test` 报 `ImportError: aes_pure` | 文件没传全，重跑第三节第 3 步 |
| 两块板收不到对方 | 先 `status` 看 `sent` 有没有涨；两块 HC-12 天线要立起来、别贴着金属桌面；距离先拉到 1 米 |
| 收到了但打印 `[?]` 或乱码 | 两块板密钥不一致（`status` 里 `key=` 必须都是 yes） |
| 屏不亮 | `config.py` 里 `OLED_ENABLED = False` 先关掉，别让它挡住主流程 |
| 一插拔就重启/乱发 | 供电不够：HC-12 发射瞬时电流接近 100 mA，换一个好点的 USB 口 |

---

## 八、距离与安全

- **距离**：城市里两堵墙大约 30–80 米；开阔地 100–300 米；把天线竖直、抬高、别贴金属，
  是最有效的三件事。HC-12 的最大发射功率是 100 mW，属于免许可频段，别接到外置功放上。
- **安全**：AES-256-GCM + 每条消息随机盐，中途改一个比特都会认证失败。
  密钥在代码里是明文（`config.py`），捡到板子的人能读出来，
  所以真在意的话还要开 ESP32 的 Flash 加密（`espefuse.py` 那套），这属于进阶步骤。
- **别发很长的**：单条消息上限 19380 字节，但 HC-12 带宽只有 9600 bps，
  一句话（几十字节）眨眼就到，几千字就要等十几秒。

---

## 九、代码地图

| 文件 | 干什么 | 在哪测过 |
|---|---|---|
| `firmware/main.py` | 板子入口：串口命令、收信显示、OLED | `test/main-smoke.py`（模拟硬件跑通） |
| `firmware/config.py` | 引脚、波特率、密钥 | — |
| `firmware/lib/ss_envelope.py` | 帧格式（与网页 v2 逐字节一致） | `test/cross-verify.py` |
| `firmware/lib/ss_gcm.py` | AES-256-GCM | `test/verify-crypto.py` |
| `firmware/lib/aes_pure.py` | 纯 Python AES（有硬件加速时不用它） | FIPS-197 向量 |
| `firmware/lib/ss_link.py` | SLIP 分帧（无线串口没有包边界） | `test/link-test.py` |
| `firmware/lib/ss_node.py` | 收发逻辑、命令、断线重试 | `test/node-test.py`（两块"板"互通） |
| `firmware/lib/ssd1306_min.py` | 最小 OLED 驱动 | 只有语法检查，等真屏 |

跑一遍全部自测：

```powershell
python D:\run_keys\test\verify-crypto.py
python D:\run_keys\test\cross-verify.py
python D:\run_keys\test\link-test.py
python D:\run_keys\test\node-test.py
python D:\run_keys\test\main-smoke.py
```
