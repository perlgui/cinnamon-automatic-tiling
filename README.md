# Cinnamon Automatic Tiling v. 0.2

Automatic window tiling for the Linux Mint Cinnamon desktop environment.

> *This implementation is functional but some behaviours may be unstable or incomplete.*

---

## Requirements

- Linux Mint 22.x
- Cinnamon 6.6.x

Other Cinnamon 6.x versions may work but are untested. The installer will warn you if your version differs from 6.6.7.

---

## Install

```bash
git clone https://github.com/perlgui/cinnamon-automatic-tiling.git
cd cinnamon-automatic-tiling
sudo bash install_autotiling.sh
```

---

The installer will:

1. Check that all source files are present
2. Warn if your Cinnamon version differs from 6.6.7
3. Back up the original system files to `./backups/` (first run only)
4. Install the schema and recompile GLib schemas
5. Install the three JS files and one Python file
6. Verify that all new GSettings keys are readable

Important! After installation, restart Cinnamon:

**Right-click the panel -> Troubleshoot -> Restart Cinnamon**

Important! Then enable tiling in:

**System Settings -> Windows -> Tiling -> Tiling Preferences**

---

Important! In System Settings --> Workspaces check Allow cycling through workspaces
---

## Uninstall

```bash
sudo bash install_autotiling.sh --uninstall
```

This restores all original system files from `./backups/` and resets the new GSettings keys to their defaults.

**Restore original files manually**

```bash
sudo cp backups/windowManager.js.stock /usr/share/cinnamon/js/ui/windowManager.js
sudo rm -f /usr/share/cinnamon/js/ui/windowTiling.js
sudo cp backups/windowMenu.js.stock    /usr/share/cinnamon/js/ui/windowMenu.js
sudo cp backups/cs_windows.py.stock    /usr/share/cinnamon/cinnamon-settings/modules/cs_windows.py
sudo cp backups/org.cinnamon.muffin.gschema.xml.stock /usr/share/glib-2.0/schemas/org.cinnamon.muffin.gschema.xml
sudo glib-compile-schemas /usr/share/glib-2.0/schemas/
```

---

## Configuration

All settings are in **System Settings -> Windows -> Tiling -> Tiling Preferences**.

| Setting | Description |
|---|---|
| Tiling mode | None / Manual edge-tiling / Automatic tiling |
| Gap between tiles | 0–50 px gap between windows and screen edges |
| Tile border accent colour | Colour of the focus border on the active tiled window; leave empty to use the GTK theme colour |
| Tile border width | 0–10 px; set to 0 to disable the border entirely |
| Tiling exclusions | Per-app exclusion list -> excluded windows float freely |

### Excluding an app at runtime

Right-click the titlebar of any window -> **Exclude from Tiling**. The exclusion is saved immediately and the layout reflows.

---

## Backup location

Original system files are saved to `./backups/` on the first install run:

```
backups/
  org.cinnamon.muffin.gschema.xml.stock
  windowManager.js.stock
  windowMenu.js.stock
  cs_windows.py.stock
```

`windowTiling.js` is a new file with no system counterpart; it is removed (not restored) on uninstall.

Subsequent installs skip the backup step so your originals are always preserved.

---


## How to use Cinnamon automatic tiling

**First**, go to **System Settings -> Windows -> Tiling** and enable automatic tiling.

<img width="1860" height="960" alt="11" src="https://github.com/user-attachments/assets/d44d3ea6-b0a4-4400-b827-751680694582" />

**Second**, adjust the gap width between tiles, choose a colour for the focused window border, and set the border width.

**Third**, exclude any applications that should not be tiled. These are typically applications with small windows (calculators, etc.) and applications you normally use in full-screen mode (Inkscape, GIMP, digital audio workstations, Blender, video editors, and so on). You can exclude an application either through **Manage tiling exclusions…** in **System Settings -> Windows -> Tiling**, or by right-clicking its titlebar and checking **Exclude from Tiling**.


**Fourth**, use the grouped-window-list-modified applet if you want (that's optional). Just copy it to ~/.local/share/cinnamon/applets and enable it in System Settings -> Applets instead of the default grouped-window-list applet. Why? With this modified applet, each minimised application gets assigned a number, so it is easy to minimise and unminimise it with the Super + Number key combo. If you have, say, 9 applications minimised and you want to unminimise number 7, you don't need to count or guess - just press Super + 7. If you prefer not to use Super + Number, you can use Ctrl + Super + Up/Down Arrow to enter preview mode, cycle through minimised windows with Ctrl + Super + Left/Right Arrow, and pick the one you want with the Space key.


### Layout progression

- **1 window** -> fills the full screen (minus gaps and panels).

<img width="3840" height="2160" alt="1" src="https://github.com/user-attachments/assets/057d681c-e5cb-450d-9aa9-78cf1e6272c5" />


- **2 windows** -> both windows tile side by side at 1/2 screen each (vertical split, toggleable to horizontal).

<img width="3840" height="2160" alt="2" src="https://github.com/user-attachments/assets/0e35223e-3549-480e-ba96-cf0388d05b12" />


- **3 windows in grid layout** -> one 1/2-screen master tile and two 1/4-screen stack tiles (mirrorable).

<img width="3840" height="2160" alt="3" src="https://github.com/user-attachments/assets/15a1d68a-91c2-473d-bb6c-132073417b97" />

Resized:

<img width="3840" height="2160" alt="8" src="https://github.com/user-attachments/assets/99a16e97-21ff-4c6a-ae13-33743ed0efda" />


- **3 windows in column layout** -> three 1/3 identical tiles.

<img width="3840" height="2160" alt="4" src="https://github.com/user-attachments/assets/6344150c-c2f5-4ccc-b716-a9619678c7ed" />

The central tile expanded:

<img width="3840" height="2160" alt="7" src="https://github.com/user-attachments/assets/3ce14359-cec7-41ae-8c3a-4107fa3481d0" />


- **4 windows in grid layout** -> all windows tile in a 2×2 grid, each covering 1/4 of the screen.

<img width="3840" height="2160" alt="5" src="https://github.com/user-attachments/assets/eabaf1b0-e88b-4d30-b3bb-76cf2fed985c" />

<img width="3840" height="2160" alt="9" src="https://github.com/user-attachments/assets/0eafb1e0-2e2e-42e9-90c1-7e4b448f74a7" />

- **4 windows in column layout** -> all windows tile side by side in columns, each covering 1/4 of the screen.

<img width="3840" height="2160" alt="6" src="https://github.com/user-attachments/assets/2a4ce3b0-afb4-4059-84b4-74acf2f2bb18" />


- **5th window and beyond** -> the newest window tiles with the three most recent windows; the oldest tiled window is automatically minimised. This continues for each subsequent window opened.

The same logic applies in reverse when unminimising: if space is available, windows retile from 1 -> 2 -> 3 -> 4. If four tiles are already occupied, the unminimised window pushes the oldest tile into the minimised state and takes its place.

- **Tile preview stripe**

Super+Y toggles tile preview stripe for easy moving of tiles from other workspaces

<img width="3840" height="2160" alt="12" src="https://github.com/user-attachments/assets/f8c477de-89a2-47a1-8934-dd97af5e26b5" />


---

## Multi-monitor support

Each monitor manages its own independent tile grid. Windows on monitor 1 tile among themselves; windows on monitor 2 tile among themselves. The two grids never interfere with each other. Each monitor can simultaneously hold up to four tiles, so a two-monitor setup gives you up to eight tiled windows at once per workspace and many more if minimized.

All monitors share the same set of workspaces. When you switch to a different workspace, every monitor switches together, and each monitor retiles its own windows for that workspace independently. This makes workspaces a powerful way to organise your work by context: put your office applications (email, calendar, word processor) on workspace 1, your development tools on workspace 2, and your graphics applications on workspace 3. One keypress switches your entire working environment across all monitors simultaneously, which is far more coherent than juggling unrelated applications across monitors on different workspace stacks.

This is the same philosophy as traditional virtual desktops, just extended naturally across multiple screens. Some tiling compositors such as Hyprland support per-monitor independent workspaces, where each monitor can show a different workspace at the same time. That can sound appealing, and some people might prefer that kind of setup, but in practice it means switching workspace on one monitor leaves the other in a completely unrelated context, which tends to be disorienting and makes it harder to maintain a coherent workflow per workspace.

The one consequence worth being aware of is that you cannot have different workspaces visible on different monitors at the same time. If you want Gimp on one monitor and Inkscape on another, place them on the same workspace - they tile independently and will not interfere with each other.

Layout state - slot order and mirror state for the 3-tile layout - is tracked per monitor and per workspace, so each monitor remembers its own tile arrangement when you return to a workspace.

### Switching focus between monitors

Press `Super + F` to move keyboard focus to the next monitor. The cursor warps automatically to the centre of the focused window on the target monitor, so your mouse and keyboard focus stay in sync. Monitors cycle in order: if you have two monitors, `Super + F` toggles between them; with three or more monitors it cycles through them in sequence.

You can also click any window on another monitor to focus it normally.

### Moving a window to another monitor

Press `Super + Shift + M` to send the currently focused window to the next monitor. The window is moved into the target monitor's tile grid, both grids retile automatically, and focus follows the window to its new monitor.

### Native move-to-monitor shortcuts suppressed

Cinnamon and GNOME include built-in keybindings for moving windows between monitors (`move-to-monitor-left/right/up/down`). While automatic tiling is active, these shortcuts are suppressed, because moving a window via those shortcuts bypasses the tiling engine and leaves both grids in an inconsistent state. Use `Super + Shift + M` instead, it moves the window and retiles both monitors correctly.

---


## Keyboard shortcuts

| Shortcut | Action |
|---|---|
| `Super + Q` | Change layout from grid to column and from column to grid |
| `Super + Y` | Toggle tile preview strip (Esc to close it) |
| `Super + Tab` | Change tile focus |
| `Super + W` | Close tile |
| `Super + M` | Minimise tile |
| `Super + Up / Down` | Cycle / rotate grid tile layout |
| `Super + Left / Right` | Mirror tiles in grid layout |
| `Super + Left / Right` | Cycle tiles in column layout |
| `Super + Shift + Left / Right/ Up / Down` | Resize tiles |
| `Super + 1-9` | Unminimise / minimise window by number |
| `Ctrl + Super + Up / Down` | Preview minimised windows |
| `Ctrl + Super + Left / Right` | Cycle previewed windows |
| `Ctrl + Super + Space` | Tile the previewed window |
| `Ctrl + Super + Esc` | Escape preview |
| `Super + F` | Move focus to next monitor (cursor warps to focused window) |
| `Super + Shift + M` | Move focused window to next monitor |
| `Ctrl + Alt + Left / Right` | Switch workspaces horizontally |
| `Super + Page Up / Page Down` | Switch workspaces vertically *(requires "Allow cycling through workspaces" in System Settings -> Workspaces)* |

> For smooth workspace switching with transition effects, enable **Effects** in **System Settings -> Effects**. Without effects enabled, workspace switching is instant.

---


## Why automatic tiling?

Automatic tiling has several advantages over manual window management:

- **No wasted time on manual placement.** In an automatic tiling setup, new windows slot in automatically and all windows resize and reposition together, keeping you in flow. Manually dragging and resizing windows one by one is a constant low-level tax on attention.
- **Keyboard-driven workflow.** Tiling pairs naturally with keyboard navigation. You move focus, swap windows, and resize splits without touching the mouse, which is substantially faster for any workflow.
- **Efficient use of screen space.** Every pixel is used by default. Floating windows constantly waste space with overlapping or poorly sized windows that you have to arrange manually.
- **Symmetry and consistency.** A symmetrical user interface is visually calm and predictable.
- **Multi-monitor clarity.** With a per-monitor tiling scope, each screen has its own coherent layout and nothing drifts across boundaries accidentally.

---

## Why this hybrid approach for the Cinnamon desktop?

In my opinion keeping the best of both worlds is the right approach. In this implementation you can disable tiling completely, enable manual tiling if you prefer it, or enable automatic tiling. Even when automatic tiling is enabled, the desktop is fully preserved and accessible. You can minimise all tiled windows and do whatever you want on your desktop, e.g. launch context menus or access drives, files, and folders. You can open as many windows as you want on each workspace and have them minimised on the panel, from where they can easily be retiled.

The main counterargument for floating is that some applications (digital audio workstations, video editors, small utilities, dialogs, etc.) genuinely don't belong in a tile grid. This is exactly why this hybrid approach (tiling layered on top of a traditional desktop, not replacing it) is arguably the most pragmatic design: you get the productivity benefits of tiling for your working windows while retaining floating behaviour for everything that would be awkward to tile.

---

## Not all applications are suitable for automatic tiling

Some applications enforce a minimum window size that is too large to fit in half (or a quarter) of the screen. When the tiling engine tries to resize them, they refuse to shrink beyond their minimum size constraint and end up overlapping other tiles. These poorly coded applications can and should be excluded from tiling. When it comes to terminals, Kitty and Alacritty (and some other terminal emulators) are suited well for tiling.

Unlike dedicated tiling compositors such as Hyprland or Niri, which run as the Wayland compositor itself and can override application size constraints at the protocol level, this implementation runs inside Cinnamon on top of the Muffin window manager. Muffin respects the minimum size hints that applications declare, so there is no way to force a window smaller than it allows.

Once Cinnamon and Muffin are fully ported to Wayland, it will be possible to force applications to shrink beyond their minimum size constraint, although for the vast majority of applications it is pointless to tile them into a quarter of the screen. That is why this implementation does not allow more than four tiles on each workspace. An option to tile more than four terminal emulators per workspace may eventually be added, but for other applications that is rarely useful.

The solution for the applications whose minimum window size is too large is to either exclude these applications from tiling or move them to another workspace. You can exclude them at runtime by right-clicking the titlebar and selecting **Exclude from Tiling**, or by adding the application's WM class to the exclusion list in **System Settings -> Windows -> Tiling -> Tiling Preferences**. Excluded windows float freely and do not participate in the automatic layout.

---


## Troubleshooting

**Tiling doesn't activate after install**
Restart Cinnamon (right-click panel -> Troubleshoot -> Restart Cinnamon) and confirm **Auto-tiling** is selected in **System Settings -> Windows -> Tiling Preferences**.

**GSettings key errors on install**
Run `sudo glib-compile-schemas /usr/share/glib-2.0/schemas/` manually, then retry.

**A window won't tile**
Open **System Settings -> Windows -> Tiling Preferences -> Manage tiling exclusions** and check whether its WM class is in the exclusion list.

