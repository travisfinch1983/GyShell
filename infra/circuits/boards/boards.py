import json, sys
from dxfart import View, dxf_art
from build import build, header_pins
D = '/claude/microcontroller_boards/ESP32-P4 documentation/'
LIC = 'AI-Lab built-in. Outline and pin positions traced from Waveshare mechanical drawings; pinout from Waveshare schematic.'
which = sys.argv[1:] or ['nano', 'wifi6', 'devkit']
parts = []

def mk(cfg, view, dxf, pins_dxf):
    art = dxf_art(D + dxf, view)
    pins = []
    for q in pins_dxf:
        x, y = view.tf(q['x_mm'], q['y_mm']); q = dict(q, x_mm=x, y_mm=y); pins.append(q)
    cfg['pins'] = pins; cfg['board'] = dict(view.board, r=cfg.get('r', 1.0))
    return build(cfg, art)

if 'nano' in which:
    v = View(7.87, -7.73, 57.88, 42.28, 2.0, 0)
    P1 = {1:'3V3',2:'5V',3:'GPIO7',4:'5V',5:'GPIO8',6:'GND',7:'GPIO23',8:'GPIO37',9:'GND',10:'GPIO38',11:'GPIO5',12:'GPIO4',13:'GPIO20',
          14:'GND',15:'GPIO21',16:'GPIO22',17:'3V3',18:'GPIO24',19:'GPIO25',20:'GND',21:'GPIO26',22:'GPIO27',23:'GPIO32',24:'GPIO33',25:'GND',26:'GPIO36'}
    P2 = {1:'5V',2:'ESP_LDO_VO4',3:'GND',4:'GND',5:'3V3',6:'GPIO0',7:'GND',8:'GPIO1',9:'GPIO3',10:'GND',11:'GPIO2',12:'GPIO6',13:'GPIO54',
          14:'GPIO53',15:'GPIO47',16:'GPIO48',17:'GPIO46',18:'GND',19:'GPIO45',20:'C6_U0RXD',21:'C6_IO12',22:'C6_U0TXD',23:'C6_IO13',24:'C6_IO9',25:'GND',26:'GND'}
    pins = header_pins('P1', P1, (9.36, 35.71), (2.54, 0), (0, -2.54), 2, ('L', 'R'), 'dual') + \
           header_pins('P2', P2, (53.86, 35.72), (2.54, 0), (0, -2.54), 2, ('L', 'R'), 'dual')
    parts.append(mk(dict(id='waveshare-esp32-p4-nano', name='Waveshare ESP32-P4-NANO', pcb='#17191c', gutters=dict(L=1, R=1), license=LIC,
        description='Waveshare ESP32-P4-NANO (50×50 mm): ESP32-P4 (dual RISC-V 400 MHz, 32 MB PSRAM, 16 MB flash) + ESP32-C6 Wi-Fi 6/BLE over SDIO, 100 M Ethernet, MIPI DSI/CSI, ES8311 codec, USB-C. Two 2×13 headers: P1 (left) and P2 (right, includes C6 pins). 3.3 V logic.',
        tags=['esp32-p4', 'waveshare', 'nano', 'ethernet', 'wifi6', 'esp32-c6', 'mipi'],
        props=dict(logicVoltage=3.3, chip='ESP32-P4', coprocessor='ESP32-C6', i2cDefault=dict(sda='GPIO7', scl='GPIO8'), sizeMm=[50, 50], datasheet='https://docs.waveshare.com/ESP32-P4-NANO')),
        v, 'ESP32-P4-NANO-20260331.dxf', pins))

if 'wifi6' in which:
    v = View(610.40, 244.33, 681.45, 265.34, 1.5, 90)
    H = {1:'GPIO52',2:'GPIO51',3:'GND',4:'GPIO31',5:'GPIO30',6:'GPIO29',7:'GPIO28',8:'GND',9:'GPIO50',10:'GPIO49',11:'GPIO5',12:'GPIO4',13:'GND',
         14:'GPIO3',15:'GPIO2',16:'GPIO8',17:'GPIO7',18:'GND',19:'GPIO24',20:'GPIO25',21:'GPIO48',22:'GPIO47',23:'GND',24:'GPIO46',25:'GPIO33',
         26:'GPIO32',27:'GPIO27',28:'GND',29:'GPIO26',30:'RUN',31:'GPIO23',32:'GPIO22',33:'GND',34:'GPIO21',35:'GPIO20',36:'3V3',37:'3V3_EN',
         38:'GND',39:'VSYS',40:'VBUS'}
    # pin1 at (614.93,245.94); pins 1-20 run +x along y=245.94; pins 40..21 along y=263.72
    pins = header_pins('J1', H, (614.93, 245.94), (0, 17.78), (2.54, 0), 2, ('L', 'R'), 'pico')
    C6 = {1:'C6_IO9',2:'GND',3:'C6_RXD',4:'C6_TXD'}
    pins += header_pins('C6 UART', C6, (653.46, 251.02), (0, 0), (0, 2.54), 1, ('B', 'B'), 'single')
    parts.append(mk(dict(id='waveshare-esp32-p4-wifi6', name='Waveshare ESP32-P4-WIFI6', pcb='#17191c', gutters=dict(L=1, R=1), license=LIC,
        description='Waveshare ESP32-P4-WIFI6 (71×21 mm, Pico-style 2×20 pinout): ESP32-P4 + ESP32-C6-MINI (Wi-Fi 6/BLE over SDIO), MIPI DSI/CSI, ES8311 codec, USB-C. 4-pin C6 UART header (IO9/GND/RXD/TXD) for flashing the C6. 3.3 V logic.',
        tags=['esp32-p4', 'waveshare', 'wifi6', 'esp32-c6', 'pico', 'mipi'],
        props=dict(logicVoltage=3.3, chip='ESP32-P4', coprocessor='ESP32-C6', i2cDefault=dict(sda='GPIO7', scl='GPIO8'), sizeMm=[21, 71], datasheet='https://docs.waveshare.com/ESP32-P4-WIFI6')),
        v, 'ESP32-P4-WIFI6_-G-+¦¯¦t-+-20260109.dxf', pins))

if 'devkit' in which:
    v = View(148.9, 261.78, 233.9, 317.78, 5.0, 0)
    J = {1:'3V3',2:'5V',3:'GPIO7',4:'5V',5:'GPIO8',6:'GND',7:'GPIO23',8:'GPIO37',9:'GND',10:'GPIO38',11:'GPIO21',12:'GPIO22',13:'GPIO20',14:'GND',
         15:'GPIO6',16:'GPIO5',17:'3V3',18:'GPIO4',19:'GPIO3',20:'GND',21:'GPIO2',22:'GPIO1',23:'GPIO0',24:'GPIO36',25:'GND',26:'GPIO32',27:'GPIO24',
         28:'GPIO25',29:'GPIO33',30:'GND',31:'GPIO26',32:'GPIO54',33:'GPIO48',34:'GND',35:'GPIO53',36:'GPIO46',37:'GPIO47',38:'GPIO27',39:'GND',40:'GPIO45'}
    pins = header_pins('J1', J, (157.27, 313.01), (0, 2.54), (2.54, 0), 2, ('B', 'T'), 'dual')
    parts.append(mk(dict(id='waveshare-esp32-p4-module-dev-kit', name='Waveshare ESP32-P4-Module-DEV-KIT', pcb='#17191c', gutters=dict(T=1), license=LIC,
        description='Waveshare ESP32-P4-Module-DEV-KIT (85×56 mm, Raspberry Pi footprint): ESP32-P4 module + ESP32-C6 Wi-Fi 6/BLE, 4× USB-A, 100 M Ethernet (PoE header), MIPI DSI/CSI, ES8311 codec, RTC battery, two USB-C. 40-pin header follows the Raspberry Pi layout (SDA/SCL on GPIO7/8, UART on GPIO37/38, SPI on 0/2/3/36/32). 3.3 V logic.',
        tags=['esp32-p4', 'waveshare', 'dev-kit', 'raspberry-pi', 'ethernet', 'wifi6', 'esp32-c6', 'mipi', 'usb-host'],
        props=dict(logicVoltage=3.3, chip='ESP32-P4', coprocessor='ESP32-C6', i2cDefault=dict(sda='GPIO7', scl='GPIO8'), sizeMm=[85, 56], datasheet='https://docs.waveshare.com/ESP32-P4-Module-DEV-KIT')),
        v, 'ESP32-P4-Module-DEV-KIT--G-+¦¯¦t-+-20250427.dxf', pins))

for p in parts:
    json.dump(p, open(f'out/{p["id"]}.json', 'w'))
    open(f'out/{p["id"]}.svg', 'w').write(p['svg'])
    print(p['id'], p['width'], p['height'], len(p['pins']), 'pins', len(p['svg']) // 1024, 'KB')

if 'eth' in which:
    from pdfart import PdfView, pdf_art
    v = PdfView(108.7, 48.765, 185.9, 69.765, 1.5, -90)
    H = {1:'GPIO54',2:'GPIO19',3:'GND',4:'GPIO18',5:'GPIO17',6:'GPIO16',7:'GPIO15',8:'GND',9:'GPIO14',10:'GPIO6',11:'GPIO5',12:'GPIO4',13:'GND',
         14:'GPIO3',15:'GPIO2',16:'GPIO8',17:'GPIO7',18:'GND',19:'GPIO24',20:'GPIO25',21:'GPIO48',22:'GPIO47',23:'GND',24:'GPIO46',25:'GPIO33',
         26:'GPIO32',27:'GPIO27',28:'GND',29:'GPIO26',30:'RUN',31:'GPIO23',32:'GPIO22',33:'GND',34:'GPIO21',35:'GPIO20',36:'3V3',37:'3V3_EN',
         38:'GND',39:'VSYS',40:'VBUS'}
    pins = header_pins('J1', H, (181.42, 50.37), (0, 17.78), (-2.54, 0), 2, ('L', 'R'), 'pico')
    art = pdf_art(D + 'ESP32-P4-ETH_外形尺寸图-20251219.pdf', v)
    pp = []
    for q in pins:
        x, y = v.tf(q['x_mm'], q['y_mm']); pp.append(dict(q, x_mm=x, y_mm=y))
    cfg = dict(id='waveshare-esp32-p4-eth', name='Waveshare ESP32-P4-ETH', pcb='#17191c', gutters=dict(L=1, R=1), license=LIC,
        description='Waveshare ESP32-P4-ETH (78×21 mm, Pico-style 2×20 pinout): ESP32-P4 + 100 M Ethernet (IP101, RJ45 with optional PoE module header), MIPI DSI/CSI, ES8311 codec, USB-C. No Wi-Fi. 3.3 V logic.',
        tags=['esp32-p4', 'waveshare', 'ethernet', 'poe', 'pico', 'mipi'],
        props=dict(logicVoltage=3.3, chip='ESP32-P4', i2cDefault=dict(sda='GPIO7', scl='GPIO8'), sizeMm=[21, 78], datasheet='https://docs.waveshare.com/ESP32-P4-ETH'))
    cfg['pins'] = pp; cfg['board'] = dict(v.board, r=1.0)
    p = build(cfg, art); parts.append(p)
    json.dump(p, open(f'out/{p["id"]}.json', 'w')); open(f'out/{p["id"]}.svg', 'w').write(p['svg'])
    print(p['id'], p['width'], p['height'], len(p['pins']), 'pins', len(p['svg']) // 1024, 'KB')
