#!/usr/bin/python3

import gi
gi.require_version('Gtk', '3.0')
gi.require_version('Gdk', '3.0')
gi.require_version('CDesktopEnums', '3.0')
gi.require_version('Wnck', '3.0')
from gi.repository import Gio, Gtk, Gdk, CDesktopEnums, Wnck
from bin.SettingsWidgets import SidePage
from xapp.GSettingsWidgets import *


class Module:
    name = "windows"
    category = "prefs"
    comment = _("Manage window preferences")

    def __init__(self, content_box):
        keywords = _("windows, titlebar, edge, switcher, window list, attention, focus, tile, tiling, snap, snapping")
        sidePage = SidePage(_("Windows"), "cs-windows", keywords, content_box, module=self)
        self.sidePage = sidePage

    def on_module_selected(self):
        if not self.loaded:
            print("Loading Windows module")

            self.sidePage.stack = SettingsStack()
            self.sidePage.add_widget(self.sidePage.stack)

            page = SettingsPage()
            self.sidePage.stack.add_titled(page, "titlebar", _("Titlebar"))

            size_group = Gtk.SizeGroup.new(Gtk.SizeGroupMode.HORIZONTAL)

            settings = page.add_section(_("Buttons"))

            button_options = []
            if Gtk.Widget.get_default_direction() == Gtk.TextDirection.RTL:
                button_options.append([":minimize,maximize,close", _("Left")])
                button_options.append(["close,maximize,minimize:", _("Right")])
            else:
                button_options.append([":minimize,maximize,close", _("Right")])
                button_options.append(["close,maximize,minimize:", _("Left")])
            button_options.append([":close", _("Gnome")])
            button_options.append(["close:", _("Gnome Left")])
            button_options.append(["close:minimize,maximize", _("Classic Mac")])

            widget = GSettingsComboBox(_("Buttons layout"), "org.cinnamon.desktop.wm.preferences", "button-layout", button_options, size_group=size_group)
            settings.add_row(widget)

            settings = page.add_section(_("Actions"))

            action_options = [["toggle-shade", _("Toggle Shade")], ["toggle-maximize", _("Toggle Maximize")],
                              ["toggle-maximize-horizontally", _("Toggle Maximize Horizontally")], ["toggle-maximize-vertically", _("Toggle Maximize Vertically")],
                              ["toggle-stuck", _("Toggle on all workspaces")], ["toggle-above", _("Toggle always on top")],
                              ["minimize", _("Minimize")], ["menu", _("Menu")], ["lower", _("Lower")], ["none", _("None")]]

            widget = GSettingsComboBox(_("Action on title bar double-click"), "org.cinnamon.desktop.wm.preferences", "action-double-click-titlebar", action_options, size_group=size_group)
            settings.add_row(widget)

            widget = GSettingsComboBox(_("Action on title bar middle-click"), "org.cinnamon.desktop.wm.preferences", "action-middle-click-titlebar", action_options, size_group=size_group)
            settings.add_row(widget)

            widget = GSettingsComboBox(_("Action on title bar right-click"), "org.cinnamon.desktop.wm.preferences", "action-right-click-titlebar", action_options, size_group=size_group)
            settings.add_row(widget)

            scroll_options = [["none", _("Nothing")],["shade", _("Shade and unshade")],["opacity", _("Adjust opacity")]]

            widget = GSettingsComboBox(_("Action on title bar with mouse scroll"), "org.cinnamon.desktop.wm.preferences", "action-scroll-titlebar", scroll_options, size_group=size_group)
            settings.add_row(widget)

            spin = GSettingsSpinButton(_("Minimum opacity"), "org.cinnamon.desktop.wm.preferences", "min-window-opacity", _("%"))
            settings.add_reveal_row(spin)

            spin.revealer.settings = Gio.Settings("org.cinnamon.desktop.wm.preferences")
            spin.revealer.settings.bind_with_mapping("action-scroll-titlebar", spin.revealer, "reveal-child", Gio.SettingsBindFlags.GET, lambda x: x == "opacity", None)

            page = SettingsPage()
            self.sidePage.stack.add_titled(page, "behavior", _("Behavior"))

            settings = page.add_section(_("Window Focus"))

            focus_options = [["click", _("Click")], ["sloppy", _("Sloppy")], ["mouse", _("Mouse")]]
            widget = GSettingsComboBox(_("Window focus mode"), "org.cinnamon.desktop.wm.preferences", "focus-mode", focus_options)
            widget.set_tooltip_text(_("The window focus mode indicates how windows are activated. It has three possible values; \"click\" means windows must be clicked in order to focus them, \"sloppy\" means windows are focused when the mouse enters the window, and \"mouse\" means windows are focused when the mouse enters the window and unfocused when the mouse leaves the window."))
            settings.add_row(widget)

            widget = GSettingsSwitch(_("Automatically raise focused windows"), "org.cinnamon.desktop.wm.preferences", "auto-raise")
            settings.add_reveal_row(widget)

            widget.revealer.settings = Gio.Settings("org.cinnamon.desktop.wm.preferences")
            widget.revealer.settings.bind_with_mapping("focus-mode", widget.revealer, "reveal-child", Gio.SettingsBindFlags.GET, lambda x: x in ("sloppy", "mouse"), None)

            widget = GSettingsSwitch(_("Bring windows which require attention to the current workspace"), "org.cinnamon.muffin", "bring-windows-to-current-workspace")
            settings.add_row(widget)

            widget = Switch(_("Give focus to new windows launched from a terminal"))
            widget.set_tooltip_text(_("Normally, all windows created by the user are given initial focus. "
                                      "This controls whether or not to include programs launched from a terminal."))
            settings.add_row(widget)

            gsettings = widget.get_settings("org.cinnamon.desktop.wm.preferences")
            real_switch = widget.content_widget
            self.updating = False

            def update_switch(settings, key):
                if self.updating:
                    return
                self.updating = True
                real_switch.set_active(gsettings.get_enum(key) == CDesktopEnums.FocusNewWindows.SMART)
                self.updating = False

            def update_setting(widget, pspec):
                if self.updating:
                    return
                self.updating = True
                gsettings.set_enum("focus-new-windows",
                                   CDesktopEnums.FocusNewWindows.SMART if real_switch.get_active() else CDesktopEnums.FocusNewWindows.STRICT)
                self.updating = False

            real_switch.connect("notify::active", update_setting)
            gsettings.connect("changed::focus-new-windows", update_switch)
            update_switch(gsettings, "focus-new-windows")

            widget = GSettingsSwitch(_("Attach dialog windows to the parent window"), "org.cinnamon.muffin", "attach-modal-dialogs")
            settings.add_row(widget)

            settings = page.add_section(_("Moving and Resizing Windows"))

            size_group = Gtk.SizeGroup.new(Gtk.SizeGroupMode.HORIZONTAL)

            placement_options = [["automatic", _("Automatic")], ["pointer", _("Cursor")], ["manual", _("Manual")], ["center", _("Center")]]
            widget = GSettingsComboBox(_("Location of newly opened windows"), "org.cinnamon.muffin", "placement-mode", placement_options, size_group=size_group)
            settings.add_row(widget)

            special_key_options = [["", _("Disabled")], ["<Alt>", "<Alt>"],["<Super>", "<Super>"],["<Control>", "<Control>"]]
            widget = GSettingsComboBox(_("Special key to move and resize windows"), "org.cinnamon.desktop.wm.preferences", "mouse-button-modifier", special_key_options, size_group=size_group)
            widget.set_tooltip_text(_("While the special key is pressed, windows can be dragged with the left mouse button and resized with the right mouse button."))
            settings.add_row(widget)

            widget = GSettingsRange(_("Draggable border width"), "org.cinnamon.muffin", "draggable-border-width", _("Narrower"), _("Wider"),
                                    2, 64, show_value=False)
            widget.content_widget.set_tooltip_text(_("This adjusts the width of that portion of the window border used for resizing."))
            widget.add_mark(10, Gtk.PositionType.TOP, None)
            settings.add_row(widget)

            page = SettingsPage()
            self.sidePage.stack.add_titled(page, "alttab", _("Alt-Tab"))

            settings = page.add_section(_("Alt-Tab"))

            alttab_styles = [
                ["icons", _("Icons only")],
                ["thumbnails", _("Thumbnails only")],
                ["icons+thumbnails", _("Icons and thumbnails")],
                ["icons+preview", _("Icons and window preview")],
                ["preview", _("Window preview (no icons)")],
                ["coverflow", _("Coverflow (3D)")],
                ["timeline", _("Timeline (3D)")]
            ]
            widget = GSettingsComboBox(_("Alt-Tab switcher style"), "org.cinnamon", "alttab-switcher-style", alttab_styles)
            settings.add_row(widget)

            widget = GSettingsSwitch(_("Display the alt-tab switcher on the primary monitor instead of the active one"), "org.cinnamon", "alttab-switcher-enforce-primary-monitor")
            settings.add_row(widget)

            widget = GSettingsSwitch(_("Move minimized windows to the end of the alt-tab switcher"), "org.cinnamon", "alttab-minimized-aware")
            settings.add_row(widget)

            widget = GSettingsSpinButton(_("Delay before displaying the alt-tab switcher"), "org.cinnamon", "alttab-switcher-delay", units=_("milliseconds"), mini=0, maxi=1000, step=50, page=150)
            settings.add_row(widget)

            widget = GSettingsSwitch(_("Show windows from all workspaces"), "org.cinnamon", "alttab-switcher-show-all-workspaces")
            settings.add_row(widget)

            widget = GSettingsSwitch(_("Show windows from current monitor"), "org.cinnamon", "alttab-switcher-show-current-monitor")
            settings.add_row(widget)

            widget = GSettingsSwitch(_("Warp mouse pointer to the new focused window"), "org.cinnamon", "alttab-switcher-warp-mouse-pointer")
            settings.add_row(widget)

            page = SettingsPage()
            self.sidePage.stack.add_titled(page, "tiling", _("Tiling"))

            settings = page.add_section(_("Tiling Preferences"))

            muffin_settings = Gio.Settings("org.cinnamon.muffin")
            self._tiling_updating = False

            mode_box = SettingsWidget()
            mode_box.set_border_width(0)
            mode_inner = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=20)
            mode_inner.set_margin_start(0)

            radio_none   = Gtk.RadioButton.new_with_label(None, _("No tiling"))
            radio_manual = Gtk.RadioButton.new_with_label_from_widget(radio_none, _("Manual tiling"))
            radio_auto   = Gtk.RadioButton.new_with_label_from_widget(radio_none, _("Automatic tiling"))

            mode_inner.pack_start(radio_none,   False, False, 0)
            mode_inner.pack_start(radio_manual, False, False, 0)
            mode_inner.pack_start(radio_auto,   False, False, 0)
            mode_box.pack_start(mode_inner, True, True, 0)
            settings.add_row(mode_box)

            def update_radios(*args):
                if self._tiling_updating:
                    return
                self._tiling_updating = True
                is_auto   = muffin_settings.get_boolean("auto-tile")
                is_manual = muffin_settings.get_boolean("edge-tiling") and not is_auto
                radio_auto.set_active(is_auto)
                radio_manual.set_active(is_manual)
                radio_none.set_active(not is_auto and not is_manual)
                self._tiling_updating = False

            def on_radio_none_toggled(widget):
                if self._tiling_updating or not widget.get_active():
                    return
                self._tiling_updating = True
                muffin_settings.set_boolean("auto-tile",   False)
                muffin_settings.set_boolean("edge-tiling", False)
                self._tiling_updating = False

            def on_radio_manual_toggled(widget):
                if self._tiling_updating or not widget.get_active():
                    return
                self._tiling_updating = True
                muffin_settings.set_boolean("auto-tile",   False)
                muffin_settings.set_boolean("edge-tiling", True)
                self._tiling_updating = False

            def on_radio_auto_toggled(widget):
                if self._tiling_updating or not widget.get_active():
                    return
                self._tiling_updating = True

                muffin_settings.set_boolean("auto-tile", True)
                self._tiling_updating = False

            radio_none.connect("toggled",   on_radio_none_toggled)
            radio_manual.connect("toggled", on_radio_manual_toggled)
            radio_auto.connect("toggled",   on_radio_auto_toggled)
            muffin_settings.connect("changed::auto-tile",   update_radios)
            muffin_settings.connect("changed::edge-tiling", update_radios)
            update_radios()

            switch = GSettingsSwitch(_("Maximize, instead of tile, when dragging a window to the top edge"), "org.cinnamon.muffin", "tile-maximize")
            settings.add_reveal_row(switch, "org.cinnamon.muffin", "edge-tiling")

            excl_box = SettingsWidget()
            excl_box.set_border_width(0)
            excl_inner = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=10)
            excl_inner.set_margin_start(20)
            excl_btn = Gtk.Button(label=_("Manage tiling exclusions..."))
            excl_inner.pack_start(excl_btn, False, False, 0)
            excl_box.pack_start(excl_inner, True, True, 0)
            settings.add_reveal_row(excl_box, "org.cinnamon.muffin", "auto-tile")

            def on_manage_exclusions(widget):
                dialog = Gtk.Dialog(title=_("Manage Tiling Exclusions"),
                                    transient_for=widget.get_toplevel(),
                                    modal=True)
                dialog.set_default_size(500, 400)
                dialog.add_button(_("Close"), Gtk.ResponseType.CLOSE)

                content = dialog.get_content_area()
                content.set_spacing(6)
                content.set_margin_start(12)
                content.set_margin_end(12)
                content.set_margin_top(12)
                content.set_margin_bottom(12)

                label = Gtk.Label(label=_("Applications excluded from automatic tiling (by WM class):"))
                label.set_halign(Gtk.Align.START)
                content.pack_start(label, False, False, 0)

                list_store = Gtk.ListStore(str)
                for wmc in muffin_settings.get_strv("auto-tile-excludelist"):
                    list_store.append([wmc])

                tree = Gtk.TreeView(model=list_store)
                renderer = Gtk.CellRendererText()
                col = Gtk.TreeViewColumn(_("WM Class"), renderer, text=0)
                tree.append_column(col)

                scroll = Gtk.ScrolledWindow()
                scroll.set_policy(Gtk.PolicyType.AUTOMATIC, Gtk.PolicyType.AUTOMATIC)
                scroll.set_min_content_height(150)
                scroll.add(tree)
                content.pack_start(scroll, True, True, 0)

                open_label = Gtk.Label(label=_("Add from open windows:"))
                open_label.set_halign(Gtk.Align.START)
                content.pack_start(open_label, False, False, 0)

                open_store = Gtk.ListStore(str, str)
                screen = Wnck.Screen.get_default()
                screen.force_update()
                seen = set()
                for w in screen.get_windows():
                    wmc = w.get_class_group_name() or ''
                    name = w.get_name() or ''
                    if wmc and wmc not in seen:
                        seen.add(wmc)
                        open_store.append(["%s  [%s]" % (name, wmc), wmc])

                open_combo = Gtk.ComboBox(model=open_store)
                r1 = Gtk.CellRendererText()
                open_combo.pack_start(r1, True)
                open_combo.add_attribute(r1, "text", 0)

                content.pack_start(open_combo, False, False, 0)

                add_open_btn = Gtk.Button(label=_("Add selected window"))
                content.pack_start(add_open_btn, False, False, 0)

                manual_label = Gtk.Label(label=_("Or enter WM class manually:"))
                manual_label.set_halign(Gtk.Align.START)
                content.pack_start(manual_label, False, False, 0)

                manual_box = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=6)
                manual_entry = Gtk.Entry()
                manual_entry.set_placeholder_text(_("e.g. firefox"))
                add_manual_btn = Gtk.Button(label=_("Add"))
                manual_box.pack_start(manual_entry, True, True, 0)
                manual_box.pack_start(add_manual_btn, False, False, 0)
                content.pack_start(manual_box, False, False, 0)

                remove_btn = Gtk.Button(label=_("Remove selected"))
                content.pack_start(remove_btn, False, False, 0)

                def save_list():
                    new_list = [row[0] for row in list_store]
                    muffin_settings.set_strv("auto-tile-excludelist", new_list)

                def on_add_open(widget):
                    it = open_combo.get_active_iter()
                    if it:
                        wmc = open_store[it][1]
                        existing = [row[0] for row in list_store]
                        if wmc not in existing:
                            list_store.append([wmc])
                            save_list()

                def on_add_manual(widget):
                    wmc = manual_entry.get_text().strip()
                    if wmc:
                        existing = [row[0] for row in list_store]
                        if wmc not in existing:
                            list_store.append([wmc])
                            save_list()
                        manual_entry.set_text("")

                def on_remove(widget):
                    sel = tree.get_selection()
                    model, it = sel.get_selected()
                    if it:
                        model.remove(it)
                        save_list()

                add_open_btn.connect("clicked", on_add_open)
                add_manual_btn.connect("clicked", on_add_manual)
                manual_entry.connect("activate", on_add_manual)
                remove_btn.connect("clicked", on_remove)

                content.show_all()
                dialog.run()
                dialog.destroy()

            excl_btn.connect("clicked", on_manage_exclusions)

            gap_box = SettingsWidget()
            gap_box.set_border_width(0)
            gap_inner = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=10)
            gap_inner.set_margin_start(20)
            gap_label = Gtk.Label(label=_("Gap between tiles (pixels):"))
            gap_label.set_halign(Gtk.Align.START)
            gap_spin = Gtk.SpinButton.new_with_range(0, 50, 1)
            gap_spin.set_value(muffin_settings.get_int("auto-tile-gap"))
            gap_spin.set_tooltip_text(_("Set to 0 for no gap. Changes apply immediately."))
            gap_inner.pack_start(gap_label, False, False, 0)
            gap_inner.pack_start(gap_spin,  False, False, 0)
            gap_box.pack_start(gap_inner, True, True, 0)
            settings.add_reveal_row(gap_box, "org.cinnamon.muffin", "auto-tile")

            def on_gap_changed(widget):
                muffin_settings.set_int("auto-tile-gap", widget.get_value_as_int())

            gap_spin.connect("value-changed", on_gap_changed)

            def on_gap_setting_changed(gsettings, key):
                if key == "auto-tile-gap":
                    gap_spin.set_value(gsettings.get_int("auto-tile-gap"))

            muffin_settings.connect("changed", on_gap_setting_changed)

            color_box = SettingsWidget()
            color_box.set_border_width(0)
            color_inner = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=10)
            color_inner.set_margin_start(20)
            color_label = Gtk.Label(label=_("Tile border accent color:"))
            color_label.set_halign(Gtk.Align.START)

            color_button = Gtk.ColorButton()
            color_button.set_use_alpha(False)
            color_button.set_tooltip_text(_("Choose accent color for tiled window borders. Clear to use theme color."))

            reset_color_btn = Gtk.Button(label=_("Use theme color"))
            reset_color_btn.set_tooltip_text(_("Reset to automatic theme-based color"))

            color_inner.pack_start(color_label,     False, False, 0)
            color_inner.pack_start(color_button,    False, False, 0)
            color_inner.pack_start(reset_color_btn, False, False, 0)
            color_box.pack_start(color_inner, True, True, 0)
            settings.add_reveal_row(color_box, "org.cinnamon.muffin", "auto-tile")

            def hex_to_rgba(hex_str):
                hex_str = hex_str.strip().lstrip('#')
                if len(hex_str) == 6:
                    try:
                        r = int(hex_str[0:2], 16) / 255.0
                        g = int(hex_str[2:4], 16) / 255.0
                        b = int(hex_str[4:6], 16) / 255.0
                        return Gdk.RGBA(r, g, b, 1.0)
                    except ValueError:
                        pass
                return None

            def update_color_button():
                val = muffin_settings.get_string("auto-tile-accent-color").strip()
                if val:
                    rgba = hex_to_rgba(val)
                    if rgba:
                        color_button.set_rgba(rgba)
                else:

                    color_button.set_rgba(Gdk.RGBA(0.5, 0.5, 0.5, 1.0))

            update_color_button()

            def on_color_set(widget):
                rgba = widget.get_rgba()
                r = int(rgba.red   * 255)
                g = int(rgba.green * 255)
                b = int(rgba.blue  * 255)
                hex_color = "#{:02x}{:02x}{:02x}".format(r, g, b)
                muffin_settings.set_string("auto-tile-accent-color", hex_color)

            def on_reset_color(widget):
                muffin_settings.set_string("auto-tile-accent-color", "")
                update_color_button()

            def on_accent_setting_changed(gsettings, key):
                if key == "auto-tile-accent-color":
                    update_color_button()

            color_button.connect("color-set", on_color_set)
            reset_color_btn.connect("clicked", on_reset_color)
            muffin_settings.connect("changed", on_accent_setting_changed)

            border_box = SettingsWidget()
            border_box.set_border_width(0)
            border_inner = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=10)
            border_inner.set_margin_start(20)
            border_label = Gtk.Label(label=_("Tile border width (pixels):"))
            border_label.set_halign(Gtk.Align.START)
            border_spin = Gtk.SpinButton.new_with_range(0, 10, 1)
            try:
                border_spin.set_value(muffin_settings.get_int("auto-tile-border-width"))
            except Exception:
                border_spin.set_value(3)
            border_spin.set_tooltip_text(_("Width of the focus border around active tiled window. 0 = no border."))
            border_inner.pack_start(border_label, False, False, 0)
            border_inner.pack_start(border_spin,  False, False, 0)
            border_box.pack_start(border_inner, True, True, 0)
            settings.add_reveal_row(border_box, "org.cinnamon.muffin", "auto-tile")

            def on_border_width_changed(widget):
                try:
                    muffin_settings.set_int("auto-tile-border-width", widget.get_value_as_int())
                except Exception:
                    pass

            border_spin.connect("value-changed", on_border_width_changed)

            def on_border_setting_changed(gsettings, key):
                if key == "auto-tile-border-width":
                    try:
                        border_spin.set_value(gsettings.get_int("auto-tile-border-width"))
                    except Exception:
                        pass

            muffin_settings.connect("changed", on_border_setting_changed)
