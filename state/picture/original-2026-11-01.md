# Picture settings before kyoto changed them (2026-11-01, source: smart TV apps / home)
Read from Settings → Picture via uiautomator + screenshots.

| Setting | Original |
|---|---|
| Picture Mode | Standard |
| Contrast | 50 |
| Brightness | 50 |
| Color | 50 |
| Tint | 0 |
| Sharpness | 25 |
| Picture Size | Wide |
| settings global/system: picture_aipq_smart_scene | 1 |
| settings: picture_mode_auto_adaptation | true |

## Changed by kyoto (2026-11-01, via the Picture menu over adb)

| Setting | Before | After |
|---|---|---|
| Picture Mode | Standard | FILMMAKER MODE |
| Sharpness | 25 | 0 (set by Filmmaker Mode) |
| Contrast | 50 | 46 (set by Filmmaker Mode) |
| Motion Enhancement | Film | Off |
| Automatic Light Sensor | ON | OFF |

Already at the recommended values, left alone: Color Temperature Warm1, Noise Reduction Off,
Digital Noise Reduction Off, Active Contrast Off, Gamma BT1886, Backlight 80, Color Space Auto,
Apply Picture Settings = All Sources.
Not adjustable here: Local Dimming (greyed out), Smart Scene (disabled by Filmmaker Mode),
HDMI Input Optimization (only on an HDMI input; already "Picture Quality Optimization").

To undo: Settings → Picture → Picture Mode → Standard, Motion Enhancement → Film,
Backlight → Automatic Light Sensor → On. (Or Picture → Reset for factory defaults.)
