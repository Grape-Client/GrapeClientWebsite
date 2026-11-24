# Where the icons come from

Icons are plain SVG files drawn as CSS masks, so they take the colour of the text around them.

All of them come from All SVG Icons (https://allsvgicons.com), which serves the open-source icon packs at
`https://i.allsvgicons.com/<pack>/<icon>.svg`. `scripts/icon-candidates.py` fetches candidates and builds a sheet to
pick from.

| File | Pack / icon | Pack licence |
|---|---|---|
| home.svg | lucide/house | Lucide, ISC |
| earth.svg | lucide/globe | Lucide, ISC |
| scripts.svg | lucide/file-code | Lucide, ISC |
| play.svg | lucide/play | Lucide, ISC |
| block.svg | mdi/minecraft | Material Design Icons, Apache 2.0 |
| github.svg | simple-icons/github | Simple Icons, CC0 (the mark itself is GitHub's) |
| code.svg | lucide/code-xml | Lucide, ISC |
| settings.svg, search.svg, file.svg, file-up.svg, file-down.svg, copy.svg, eraser.svg, syringe.svg, rotate-cw.svg | lucide, same names | Lucide, ISC |
| chevron-left.svg, chevron-right.svg, chevron-down.svg, x.svg, plus.svg, minus.svg, square.svg | lucide, same names | Lucide, ISC |
| sliders-horizontal.svg, ellipsis-vertical.svg, power.svg, clock.svg, memory-stick.svg, cpu.svg | lucide, same names | Lucide, ISC |
| arrow-up-right.svg | lucide/arrow-up-right | Lucide, ISC |
| check.svg, trash-2.svg, pencil.svg, zap.svg, zap-off.svg, refresh-cw.svg, folder.svg, folder-open.svg, folder-plus.svg, file-plus.svg, triangle-alert.svg, circle-x.svg, file-text.svg, download.svg, ban.svg, layout-list.svg, unplug.svg, square-terminal.svg | lucide, same names | Lucide, ISC |
| win-min.svg, win-max.svg, win-restore.svg, win-close.svg | fluent/subtract-16-regular, maximize-16-regular, square-multiple-16-regular, dismiss-16-regular | Fluent UI System Icons, MIT |

## Client icons (ui/clients)

These are the products' own icons, shown only to tell the detected games apart:

- minecraft.png: Minecraft's window icon, from the game's own assets (`icons/icon_256x256.png`).
- lunar.png: the icon of `Lunar Client.exe`.
- dawn.png: the icon of `Dawn (Feather).exe`.

They belong to Mojang / Microsoft, Moonsworth and Dawn. `scripts/exe-icon.ps1` saves a program's icon as a PNG.

The AI clients shown in Settings > Connections (`ui/clients/claude.png`, `ui/clients/vscode.png`) are the icons of `Claude.exe` and `Code.exe`, saved the same way; they belong to Anthropic and Microsoft.
