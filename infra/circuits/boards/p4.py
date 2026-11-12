"""ESP32-P4 pin knowledge (Espressif ESP32-P4 datasheet v1.x, Table 2-x + Section 3) + Waveshare board wiring."""
def p4_gpio(n, board_notes=None):
    fn, flags, notes = [], [], []
    if n == 0: fn += ['XTAL_32K_N']
    if n == 1: fn += ['XTAL_32K_P']
    if 2 <= n <= 5: fn += [['MTCK','MTDI','MTMS','MTDO'][n-2]]; flags.append('jtag')
    if 2 <= n <= 15: fn += [f'TOUCH_CHANNEL{n-1}']
    if n <= 15: fn += [f'LP_GPIO{n}']
    if 16 <= n <= 23: fn += [f'ADC1_CH{n-16}']
    if n in (24, 25): fn += [f'USB1P1_{"N" if n==24 else "P"}0 (USB Serial/JTAG D{"-" if n==24 else "+"})']; flags.append('usb'); notes.append('Defaults to the USB Serial/JTAG controller; reconfigure before using as GPIO.')
    if n in (26, 27): fn += [f'USB1P1_{"N" if n==26 else "P"}1 (USB 1.1 OTG D{"-" if n==26 else "+"})']
    if 49 <= n <= 54: fn += [f'ADC2_CH{n-49}']
    if n in (51, 52): fn += ['ANA_COMP0']
    if n in (53, 54): fn += ['ANA_COMP1']
    if n == 37: fn += ['U0TXD']; flags.append('uart0'); notes.append('UART0 TX — boot log / USB-UART bridge.')
    if n == 38: fn += ['U0RXD']; flags.append('uart0'); notes.append('UART0 RX — USB-UART bridge.')
    if n in (34, 35, 36, 37, 38):
        flags.append('strapping')
        notes.append({34: 'Strapping: JTAG signal source.', 35: 'Strapping: boot mode (BOOT button). LOW at reset = download mode.',
                      36: 'Strapping: boot mode + ROM log printing.', 37: 'Strapping: boot mode.', 38: 'Strapping: boot mode.'}[n])
    if n == 7: fn += ['I2C SDA (board default)']
    if n == 8: fn += ['I2C SCL (board default)']
    if n in (7, 8): notes.append('Shared I2C bus: the on-board ES8311 codec (and camera/touch connectors) sit on it — add devices, do not repurpose.')
    if n == 53: notes.append('Drives PA_CTRL (speaker amplifier enable) on Waveshare P4 boards.')
    if board_notes and n in board_notes: notes.append(board_notes[n])
    return fn, flags, ' '.join(notes)

def spec(name, num):
    """name from the header table -> PinDef-ish dict (no position)."""
    import re
    m = re.fullmatch(r'GPIO(\d+)', name)
    if m:
        n = int(m.group(1)); fn, flags, notes = p4_gpio(n)
        return dict(id=name, name=name, type='gpio', functions=fn, flags=flags, notes=notes)
    if name == 'GND': return dict(id='GND', name='GND', type='ground')
    if name in ('3V3', 'ESP_3V3'): return dict(id='3V3', name='3V3', type='power', voltage=3.3, notes='3.3 V rail output (on-board regulator).')
    if name in ('5V', 'VCC_5V'): return dict(id='5V', name='5V', type='power', voltage=5, notes='5 V rail (USB / external 5 V in).')
    if name == 'VBUS': return dict(id='VBUS', name='VBUS', type='power', voltage=5, notes='USB-C 5 V (VBUS).')
    if name == 'VSYS': return dict(id='VSYS', name='VSYS', type='power', voltage=5, notes='System 5 V input (feeds the 3.3 V regulator).')
    if name == '3V3_EN': return dict(id='3V3_EN', name='3V3_EN', type='input', flags=['reset'], notes='3.3 V regulator enable (pull LOW to turn the board off).')
    if name in ('RUN', 'EN'): return dict(id='EN', name=name, type='input', flags=['reset'], notes='ESP_EN — chip enable / reset (active LOW).')
    if name == 'ESP_LDO_VO4': return dict(id='LDO_VO4', name='LDO_VO4', type='power', notes='ESP32-P4 internal LDO channel 4 output (software-adjustable). Low current.')
    if name.startswith('C6_'):
        n = name[3:]
        d = dict(id=name, name=name, type='gpio', notes='Pin of the on-board ESP32-C6 (Wi-Fi coprocessor), NOT the P4.')
        if n == 'IO9': d['flags'] = ['strapping']; d['notes'] += ' C6 strapping pin (LOW at reset = C6 download mode).'
        if n in ('U0RXD', 'RXD'): d['functions'] = ['C6 U0RXD']
        if n in ('U0TXD', 'TXD'): d['functions'] = ['C6 U0TXD']
        return d
    raise ValueError(name)
