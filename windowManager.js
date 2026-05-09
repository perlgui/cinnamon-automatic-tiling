// -*- mode: js; js-indent-level: 4; indent-tabs-mode: nil -*-

const Cinnamon = imports.gi.Cinnamon;
const Clutter = imports.gi.Clutter;
const Lang = imports.lang;
const Meta = imports.gi.Meta;
const St = imports.gi.St;
const Gio = imports.gi.Gio;
const GLib = imports.gi.GLib;
const Main = imports.ui.main;
const WindowMenu = imports.ui.windowMenu;
const GObject = imports.gi.GObject;
const AppSwitcher = imports.ui.appSwitcher.appSwitcher;
const Dialog = imports.ui.dialog;
const ModalDialog = imports.ui.modalDialog;
const WmGtkDialogs = imports.ui.wmGtkDialogs;
const CloseDialog = imports.ui.closeDialog;
const WorkspaceOsd = imports.ui.workspaceOsd;

const {CoverflowSwitcher} = imports.ui.appSwitcher.coverflowSwitcher;
const {TimelineSwitcher} = imports.ui.appSwitcher.timelineSwitcher;
const {ClassicSwitcher} = imports.ui.appSwitcher.classicSwitcher;

// maps org.cinnamon window-effect-speed
const WINDOW_ANIMATION_TIME_MULTIPLIERS = [
    1.4, // 0 SLOW
    1.0, // 1 DEFAULT
    0.6  // 2 FAST
]

const DIM_TIME = 500;
const UNDIM_TIME = 250;
const DIM_BRIGHTNESS = -0.2;

/* edge zones for tiling/snapping identification
   copied from muffin/src/core/window-private.h

  ___________________________
  | 4          0          5 |
  |                         |
  |                         |
  |                         |
  |                         |
  |  2                   3  |
  |                         |
  |                         |
  |                         |
  |                         |
  | 7          1          6 |
  |_________________________|

*/

const ZONE_TOP = 0;
const ZONE_BOTTOM = 1;
const ZONE_LEFT = 2;
const ZONE_RIGHT = 3;
const ZONE_TL = 4;
const ZONE_TR = 5;
const ZONE_BR = 6;
const ZONE_BL = 7;

var DisplayChangeDialog = GObject.registerClass(
class DisplayChangeDialog extends ModalDialog.ModalDialog {
    _init(wm) {
        super._init();

        this._wm = wm;

        this._countDown = Meta.MonitorManager.get_display_configuration_timeout();

        // Translators: This string should be shorter than 30 characters
        let title = _("Keep these display settings?");
        let description = this._formatCountDown();

        this._content = new Dialog.MessageDialogContent({ title, description });
        this.contentLayout.add_child(this._content);

        /* Translators: this and the following message should be limited in length,
           to avoid ellipsizing the labels.
        */
        this._cancelButton = this.addButton({ label: _("Revert"),
                                              action: this._onFailure.bind(this),
                                              key: Clutter.KEY_Escape });
        this._cancelButton.grab_key_focus();
        this._okButton = this.addButton({ label: _("Keep changes"),
                                          action: this._onSuccess.bind(this) });

        this._timeoutId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 1, this._tick.bind(this));
        GLib.Source.set_name_by_id(this._timeoutId, '[cinnamon] this._tick');
    }

    close(timestamp) {
        if (this._timeoutId > 0) {
            GLib.source_remove(this._timeoutId);
            this._timeoutId = 0;
        }

        super.close(timestamp);
    }

    _formatCountDown() {
        let fmt = ngettext("Reverting to previous display settings in %d second.",
                           "Reverting to previous display settings in %d seconds.");
        return fmt.format(this._countDown);
    }

    _tick() {
        this._countDown--;
        if (this._countDown == 0) {
            /* muffin already takes care of failing at timeout */
            this._timeoutId = 0;
            this.close();
            return GLib.SOURCE_REMOVE;
        }

        this._content.description = this._formatCountDown();
        return GLib.SOURCE_CONTINUE;
    }

    _onFailure() {
        this._wm.complete_display_change(false);
        this.close();
    }

    _onSuccess() {
        this._wm.complete_display_change(true);
        this.close();
    }
});

class WindowDimmer {
    constructor(actor) {
        this._brightnessEffect = new Clutter.BrightnessContrastEffect({
            name: 'dim',
            enabled: false
        });
        actor.add_effect(this._brightnessEffect);
        this.actor = actor;
        this._enabled = true;
    }

    _syncEnabled() {
        let animating = this.actor.get_transition('@effects.dim.brightness') != null;
        let dimmed = this._brightnessEffect.brightness.red != 127;
        this._brightnessEffect.enabled = this._enabled && (animating || dimmed);
    }

    setEnabled(enabled) {
        this._enabled = enabled;
        this._syncEnabled();
    }

    setDimmed(dimmed, animate) {
        let val = 127 * (1 + (dimmed ? 1 : 0) * DIM_BRIGHTNESS);
        let color = Clutter.Color.new(val, val, val, 255);

        this.actor.ease_property('@effects.dim.brightness', color, {
            mode: Clutter.AnimationMode.LINEAR,
            duration: (dimmed ? DIM_TIME : UNDIM_TIME) * (animate ? 1 : 0),
            onComplete: () => this._syncEnabled()
        });

        this._syncEnabled();
    }
};

function getWindowDimmer(actor) {
    let enabled = Meta.prefs_get_attach_modal_dialogs();

     if (enabled) {
        if (!actor._windowDimmer)
            actor._windowDimmer = new WindowDimmer(actor);
        return actor._windowDimmer;
    } else {
        return null;
    }
}

class TilePreview {
    constructor() {
        this.actor = new St.Bin({ style_class: 'tile-preview', important: true });
        global.window_group.add_actor(this.actor);

        this._reset();
        this._showing = false;
        this.anim_time = null
    }

    show(window, tileRect, monitorIndex, animate, anim_time) {
        this.anim_time = anim_time;

        let windowActor = window.get_compositor_private();
        if (!windowActor)
            return;

        if (this._rect && this._rect.equal(tileRect))
            return;

        let changeMonitor = (this._monitorIndex === -1 ||
                             this._monitorIndex != monitorIndex);

        this._monitorIndex = monitorIndex;
        this._rect = tileRect;
        let monitor = Main.layoutManager.monitors[monitorIndex];
        let {x, y, width, height} = tileRect;

        if (!this._showing || changeMonitor) {
            let monitorRect = new Meta.Rectangle({ x: monitor.x,
                                                   y: monitor.y,
                                                   width: monitor.width,
                                                   height: monitor.height });
            let [, rect] = window.get_buffer_rect().intersect(monitorRect);
            this.actor.set_size(rect.width, rect.height);
            this.actor.set_position(rect.x, rect.y);
            this.actor.opacity = 0;
        }

        this._showing = true;
        this.actor.show();

        let props = {
            x,
            y,
            width,
            height,
            opacity: 255,
        };

        if (animate) {
            this.actor.remove_all_transitions();

            Object.assign(props, {
                duration: this.anim_time,
                mode: Clutter.AnimationMode.EASE_OUT_QUAD
            });
            this.actor.ease(props);
            return;
        }

        Object.assign(this.actor, props);
    }

    hide() {
        if (!this._showing)
            return;

        this._showing = false;

        this.actor.remove_all_transitions();
        this.actor.ease({
            opacity: 0,
            duration: this.anim_time,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            onComplete: () => this._reset()
        });
    }

    _reset() {
        this.actor.hide();
        this._rect = null;
        this._monitorIndex = -1;
    }

    destroy() {
        this.actor.destroy();
    }
};

var ResizePopup = GObject.registerClass(
class ResizePopup extends St.Widget {
    _init() {
        super._init({ layout_manager: new Clutter.BinLayout() });
        this._label = new St.Label({
            style_class: 'resize-popup',
            important: true,
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
            x_expand: true,
            y_expand: true
        });
        this.add_child(this._label);
        Main.uiGroup.add_actor(this);
    }

    set(rect, displayW, displayH) {
        /* Translators: This represents the size of a window. The first number is
         * the width of the window and the second is the height. */
        let text = "%d × %d".format(displayW, displayH);
        this._label.set_text(text);

        this.set_position(rect.x, rect.y);
        this.set_size(rect.width, rect.height);
    }
});

var WindowManager = class WindowManager {
        MENU_ANIMATION_TIME = 150;
        WORKSPACE_ANIMATION_TIME = 600;
        TILE_PREVIEW_ANIMATION_TIME = 150;
        SIZE_CHANGE_ANIMATION_TIME = 120;
        MAP_ANIMATION_TIME = 120;
        DESTROY_ANIMATION_TIME = 120;
        MINIMIZE_ANIMATION_TIME = 120;

    constructor() {
        this._cinnamonwm = global.window_manager;

        this._minimizing = new Set();
        this._unminimizing = new Set();
        this._mapping = new Set();
        this._resizing = new Set();
        this._resizePending = new Set();
        this._destroying = new Set();
        this._movingWindow = null;
        this._seenWindows = new Set();

        this.wm_settings = new Gio.Settings({schema_id: 'org.cinnamon.muffin'});
        // ── CinnamonAutoTiling: state variables ──────────────────────────────
        this._autoTileWindowAddedId      = null;
        this._autoTileWindowRemovedId    = null;

        this._autoTileResizeIds          = [];
        this._autoTileSavedRects         = null;
        this._autoTileOriginalRects      = null;
        this._autoTileWinById            = null;
        this._autoTileResizing           = false;
        this._autoTileUserResizingId     = null;
        this._autoTileKeybindingsRegistered = false;
        this._autoTile2Layout            = 'vertical';
        this._autoTile3Mirrored          = false;
        this._autoTileSlotOrder          = null;
        this._autoTileSlotOrderByWs      = new Map();
        this._autoTileEdgeTilingWas      = null;
        this._autoTileEdgeTilingListenerId = null;
        this._autoTileWsSwitchPending    = false;
        this._autoTileWsSwitchGen        = 0;
        this._autoTileDragSignalIds      = [];
        this._autoTileDragPollId         = null;
        this._autoTileDraggingWin        = null;
        this._autoTileResizeDebounceId   = null;
        this._autoTileMaximizeBindingWas = null;  // saved Super+Up maximize binding
        this._autoTile2Pos               = 0;      // 2-tile rotation position (0-3)

        // JS focus border manager
        this._tileBorderActors = new Map();
        this._tileBorderFocusId = global.display.connect(
            'notify::focus-window', this._onFocusWindowChanged.bind(this));
        this.wm_settings.connect('changed::auto-tile-border-width',
            this._refreshTileBorder.bind(this));
        this.wm_settings.connect('changed::auto-tile-accent-color',
            this._refreshTileBorder.bind(this));

        this._autoTileSettingId = this.wm_settings.connect('changed::auto-tile',
            this._onAutoTileSettingChanged.bind(this));
        this._autoTileGapSettingId = this.wm_settings.connect('changed::auto-tile-gap',
            () => {
                if (this.wm_settings.get_boolean('auto-tile')) {
                    let workspace = global.workspace_manager.get_active_workspace();
                    if (workspace) this._autoTileWorkspace(workspace);
                }
            });
        this._autoTileExcludeSettingId = this.wm_settings.connect('changed::auto-tile-excludelist',
            () => {
                if (this.wm_settings.get_boolean('auto-tile')) {
                    let workspace = global.workspace_manager.get_active_workspace();
                    if (workspace) this._autoTileWorkspace(workspace);
                }
            });

        // Defer initial state until Cinnamon is fully initialized
        GLib.timeout_add(GLib.PRIORITY_DEFAULT, 500, () => {
            this._onAutoTileSettingChanged(this.wm_settings, 'auto-tile');
            return GLib.SOURCE_REMOVE;
        });
        // ── End CinnamonAutoTiling init ──────────────────────────────────────


        global.settings.connect('changed::desktop-effects', this.onSettingsChanged.bind(this));
        global.settings.connect('changed::desktop-effects-workspace', this.onSettingsChanged.bind(this));
        global.settings.connect('changed::desktop-effects-on-menus', this.onSettingsChanged.bind(this));
        global.settings.connect('changed::desktop-effects-on-dialogs', this.onSettingsChanged.bind(this));

        global.settings.connect('changed::desktop-effects-change-size', this.onSettingsChanged.bind(this));
        global.settings.connect('changed::desktop-effects-close', this.onSettingsChanged.bind(this));
        global.settings.connect('changed::desktop-effects-map', this.onSettingsChanged.bind(this));
        global.settings.connect('changed::desktop-effects-minimize', this.onSettingsChanged.bind(this));
        global.settings.connect('changed::window-effect-speed', this.onSettingsChanged.bind(this));

        this.onSettingsChanged(global.settings, "desktop-effects-workspace");

        this._workspace_osd_array = [];
        this._tilePreview = null;
        this._dimmedWindows = [];
        this._animationBlockCount = 0;
        this._switchData = null;
        this._workspaceOsds = {};

        this._cinnamonwm.connect('kill-window-effects', (cinnamonwm, actor) => {
            this._unminimizeWindowDone(cinnamonwm, actor);
            this._minimizeWindowDone(cinnamonwm, actor);
            this._mapWindowDone(cinnamonwm, actor);
            this._destroyWindowDone(cinnamonwm, actor);
            this._sizeChangeWindowDone(cinnamonwm, actor);
        });

        this._cinnamonwm.connect('show-tile-preview', this._showTilePreview.bind(this));
        this._cinnamonwm.connect('hide-tile-preview', this._hideTilePreview.bind(this));
        this._cinnamonwm.connect('show-window-menu', this._showWindowMenu.bind(this));
        this._cinnamonwm.connect('minimize', this._minimizeWindow.bind(this));
        this._cinnamonwm.connect('unminimize', this._unminimizeWindow.bind(this));
        this._cinnamonwm.connect('size-change', this._sizeChangeWindow.bind(this));
        this._cinnamonwm.connect('size-changed', this._sizeChangedWindow.bind(this));
        this._cinnamonwm.connect('map', this._mapWindow.bind(this));
        this._cinnamonwm.connect('destroy', this._destroyWindow.bind(this));
        this._cinnamonwm.connect('filter-keybinding', this._filterKeybinding.bind(this));
        // CinnamonAutoTiling: keybinding manager compatibility shim
        if (!Main.keybindingManager.addHotKey) {
            Main.keybindingManager.addHotKey = function(name, binding, callback) {
                try { Main.keybindingManager.addHotKeyArray(name, [binding], callback); } catch(e) {}
            };
            Main.keybindingManager.removeHotKey = function(name) {
                try { Main.keybindingManager.removeHotKeyArray(name); } catch(e) {}
            };
        }
        // Guard setBuiltinHandler for Mint-patched builds
        if (typeof Main.keybindingManager.setBuiltinHandler !== 'function') {
            Main.keybindingManager.setBuiltinHandler = function() {};
        }

        global.window_manager.connect('switch-workspace', (c, f, t, d) => this._switchWorkspace(c, f, t, d));

        Meta.keybindings_set_custom_handler('move-to-workspace-left', (d, w, b) => this._moveWindowToWorkspaceLeft(d, w, b));
        Meta.keybindings_set_custom_handler('move-to-workspace-right', (d, w, b) => this._moveWindowToWorkspaceRight(d, w, b));

        Meta.keybindings_set_custom_handler('switch-to-workspace-left', (d, w, b) => this._showWorkspaceSwitcher(d, w, b));
        Meta.keybindings_set_custom_handler('switch-to-workspace-right', (d, w, b) => this._showWorkspaceSwitcher(d, w, b));
        Meta.keybindings_set_custom_handler('switch-to-workspace-up', (d, w, b) => this._showWorkspaceSwitcher(d, w, b));
        Meta.keybindings_set_custom_handler('switch-to-workspace-down', (d, w, b) => this._showWorkspaceSwitcher(d, w, b));
        Meta.keybindings_set_custom_handler('switch-windows', (d, w, b) => this._startAppSwitcher(d, w, b));
        Meta.keybindings_set_custom_handler('switch-group', (d, w, b) => this._startAppSwitcher(d, w, b));
        Meta.keybindings_set_custom_handler('switch-windows-backward', (d, w, b) => this._startAppSwitcher(d, w, b));
        Meta.keybindings_set_custom_handler('switch-group-backward', (d, w, b) => this._startAppSwitcher(d, w, b));
        Meta.keybindings_set_custom_handler('switch-panels', (d, w, b) => this._startAppSwitcher(d, w, b));
        Meta.keybindings_set_custom_handler('switch-panels-backward', (d, w, b) => this._startAppSwitcher(d, w, b));

        global.display.connect('show-resize-popup', this._showResizePopup.bind(this));
        this._cinnamonwm.connect('create-close-dialog', this._createCloseDialog.bind(this));
        this._cinnamonwm.connect('confirm-display-change', this._confirmDisplayChange.bind(this));

        /* TODO: Wacom
        global.display.connect('show-pad-osd', this._showPadOsd.bind(this));
        global.display.connect('show-osd', (display, monitorIndex, iconName, label) => {
            let icon = Gio.Icon.new_for_string(iconName);
            Main.osdWindowManager.show(monitorIndex, icon, label, null);
        });
        */

        Main.overview.connect('showing', () => {
            let {_dimmedWindows} = this;
            for (let i = 0, len = _dimmedWindows.length; i < len; i++) {
                this._undimWindow(_dimmedWindows[i], true);
            }
        });
        Main.overview.connect('hiding', () => {
            let {_dimmedWindows} = this;
            for (let i = 0, len = _dimmedWindows.length; i < len; i++) {
                this._dimWindow(_dimmedWindows[i], true);
            }
        });

        this._windowMenuManager = new WindowMenu.WindowMenuManager();

        // Minimized windows won't be reliable clone sources until they're
        // shown once. If they start minimized, monitor them until they've
        // been shown for the first time. (See windowUtils.js)
        const handleSeen = (metaWindow) => {
            if (this.windowSeen(metaWindow) || metaWindow === null || !Main.isInteresting(metaWindow)) {
                return;
            }

            if (metaWindow.get_workspace().index() !== global.workspace_manager.get_active_workspace_index()) {
                return;
            }

            if (!metaWindow.minimized) {
                this._seenWindows.add(metaWindow);
                return;
            }

            // If not, add it when it gets unminimized.
            let minimize_id = metaWindow.connect("notify::minimized", () => {
                if (!metaWindow.minimized) {
                    this._seenWindows.add(metaWindow);
                }
            });

            metaWindow.connect("unmanaging", () => {
                metaWindow.disconnect(minimize_id);
                this._seenWindows.delete(metaWindow);
            });
        }

        global.display.connect("window-created", (display, metaWindow) => {
            handleSeen(metaWindow);
        });

        global.workspace_manager.connect("workspace-switched", (from, to, direction) => {
            const allWindowActors = Meta.get_window_actors(global.display);
            allWindowActors.forEach((actor) => handleSeen(actor.meta_window));
        });

        const allWindowActors = Meta.get_window_actors(global.display);
        allWindowActors.forEach((actor) => handleSeen(actor.meta_window));
    }

    windowSeen(metaWindow) {
        return this._seenWindows.has(metaWindow);
    }

    _filterKeybinding(shellwm, binding) {
        // TODO: We can use ActionModes to manage what keybindings are
        // available where. For now just disable this, things are handled
        // in Main._stageEventHandler.
        return false;
    }


    // ── JS Tile Focus Border ────────────────────────────────────────────────

    _getTileBorderStyle() {
        let bw = this.wm_settings.get_int('auto-tile-border-width');
        if (bw <= 0) return null;
        let color = this.wm_settings.get_string('auto-tile-accent-color');
        if (!color || color.length === 0) color = '#1e64dc';
        return { width: bw, color: color };
    }

    _removeTileBorder(win) {
        if (!win) return;
        let border = this._tileBorderActors.get(win);
        if (border) {
            try { border.destroy(); } catch(e) {}
            this._tileBorderActors.delete(win);
        }
    }

    _updateTileBorder(win, focused) {
        if (!win || win.window_type !== Meta.WindowType.NORMAL || win.minimized) {
            this._removeTileBorder(win); return;
        }
        let style = this._getTileBorderStyle();
        if (!style) { this._removeTileBorder(win); return; }
        let actor = win.get_compositor_private();
        if (!actor) { this._removeTileBorder(win); return; }
        if (!focused) {
            let border = this._tileBorderActors.get(win);
            if (border) border.hide();
            return;
        }
        let border = this._tileBorderActors.get(win);
        if (!border) {
            border = new St.Widget({ reactive: false, can_focus: false });
            for (let i = 0; i < 4; i++) {
                let strip = new St.Widget({ reactive: false, can_focus: false });
                border.add_child(strip);
            }
            actor.add_child(border);
            this._tileBorderActors.set(win, border);
            win.connect('size-changed', () => {
                if (this._tileBorderActors.has(win)) this._positionTileBorder(win);
            });
            win.connect('unmanaging', () => { this._removeTileBorder(win); });
        }
        this._positionTileBorder(win);
        border.show();
        let parent = border.get_parent();
        if (parent) parent.set_child_above_sibling(border, null);
    }

    _positionTileBorder(win) {
        let border = this._tileBorderActors.get(win);
        if (!border) return;
        let style = this._getTileBorderStyle();
        if (!style) return;
        let bw = style.width;
        let cssColor = `background-color: ${style.color};`;
        let actor = win.get_compositor_private();
        if (!actor) return;
        let frameRect  = win.get_frame_rect();
        let bufferRect = win.get_buffer_rect();
        let ox = frameRect.x - bufferRect.x;
        let oy = frameRect.y - bufferRect.y;
        let fw = frameRect.width;
        let fh = frameRect.height;
        let s = [
            border.get_child_at_index(0),
            border.get_child_at_index(1),
            border.get_child_at_index(2),
            border.get_child_at_index(3),
        ];
        if (s[0]) { s[0].set_position(ox-bw, oy-bw); s[0].set_size(fw+2*bw, bw); s[0].set_style(cssColor); }
        if (s[1]) { s[1].set_position(ox-bw, oy+fh); s[1].set_size(fw+2*bw, bw); s[1].set_style(cssColor); }
        if (s[2]) { s[2].set_position(ox-bw, oy);    s[2].set_size(bw, fh);       s[2].set_style(cssColor); }
        if (s[3]) { s[3].set_position(ox+fw, oy);    s[3].set_size(bw, fh);       s[3].set_style(cssColor); }
    }

    _onFocusWindowChanged() {
        let focusedWin = global.display.get_focus_window();
        this._tileBorderActors.forEach((border, win) => {
            if (win !== focusedWin) try { border.hide(); } catch(e) {}
        });
        if (focusedWin) this._updateTileBorder(focusedWin, true);
    }

    _refreshTileBorder() {
        this._tileBorderActors.forEach((border, win) => {
            try { border.destroy(); } catch(e) {}
        });
        this._tileBorderActors.clear();
        let focusedWin = global.display.get_focus_window();
        if (focusedWin) this._updateTileBorder(focusedWin, true);
    }

    // ── End JS Tile Focus Border ────────────────────────────────────────────



    _onAutoTileSettingChanged(settings, key) {
        let enabled = this.wm_settings.get_boolean('auto-tile');

        if (enabled) {
            // Save and DISABLE Muffin's native edge-tiling while auto-tile is active.
            // Leaving edge-tiling on allows windows to snap to screen edges during drag,
            // which conflicts with auto-tiling.
            if (this._autoTileEdgeTilingWas === null) {
                this._autoTileEdgeTilingWas = this.wm_settings.get_boolean('edge-tiling');
                if (this.wm_settings.get_boolean('edge-tiling')) {
                    this.wm_settings.set_boolean('edge-tiling', false);
                }
            }

            // If the user manually turns edge-tiling back on while auto-tile is active,
            // disable it again.
            if (!this._autoTileEdgeTilingListenerId) {
                this._autoTileEdgeTilingListenerId = this.wm_settings.connect(
                    'changed::edge-tiling', () => {
                        if (!this.wm_settings.get_boolean('auto-tile')) return;
                        if (this.wm_settings.get_boolean('edge-tiling')) {
                            this.wm_settings.set_boolean('edge-tiling', false);
                        }
                    });
            }

            if (!this._autoTileWorkspaceSwitchedId) {
                this._autoTileWorkspaceSwitchedId =
                    global.workspace_manager.connect('active-workspace-changed',
                        this._onAutoTileWorkspaceChanged.bind(this));
            }

            this._connectAutoTileWorkspace();
            this._registerAutoTileKeybindings();

            // Save and clear Super+Up maximize binding to avoid conflict with cycle-ccw
            try {
                let wmKb = imports.gi.Gio.Settings.new('org.gnome.desktop.wm.keybindings');
                let maxBinding = wmKb.get_strv('maximize');
                if (maxBinding.some(b => b.includes('<Super>Up'))) {
                    this._autoTileMaximizeBindingWas = maxBinding;
                    wmKb.set_strv('maximize', maxBinding.filter(b => !b.includes('<Super>Up')));
                }
            } catch(e) {}
            // Clear all push-tile bindings to avoid conflicts
            try {
                let cinKb = imports.gi.Gio.Settings.new('org.cinnamon.desktop.keybindings.wm');
                for (let [key, prop] of [
                    ['push-tile-left',  '_autoTilePushLeftWas'],
                    ['push-tile-right', '_autoTilePushRightWas'],
                    ['push-tile-up',    '_autoTilePushUpWas'],
                    ['push-tile-down',  '_autoTilePushDownWas'],
                ]) {
                    let b = cinKb.get_strv(key);
                    if (b.length > 0) {
                        this[prop] = b;
                        cinKb.set_strv(key, []);
                    }
                }
            } catch(e) {}
            // Clear move-to-monitor bindings (conflict with Super+Shift+Arrow resize)
            try {
                for (let schema of ['org.gnome.desktop.wm.keybindings',
                                    'org.cinnamon.desktop.keybindings.wm']) {
                    let kb = imports.gi.Gio.Settings.new(schema);
                    for (let [key, prop] of [
                        ['move-to-monitor-left',  '_autoTileMonLeftWas'],
                        ['move-to-monitor-right', '_autoTileMonRightWas'],
                        ['move-to-monitor-up',    '_autoTileMonUpWas'],
                        ['move-to-monitor-down',  '_autoTileMonDownWas'],
                    ]) {
                        try {
                            let b = kb.get_strv(key);
                            if (b.length > 0) {
                                this[prop] = this[prop] || b;
                                kb.set_strv(key, []);
                            }
                        } catch(e) {}
                    }
                }
            } catch(e) {}

            // Tile any windows that are already open (e.g. on session restore).
            // We use a two-stage retry: first attempt at 1000ms, then a second
            // at 2500ms. On Cinnamon restart the panel registers its struts
            // asynchronously - if we tile too early get_work_area_for_monitor()
            // returns the full screen rect (no panel), so tiles bleed under the
            // panel and off the bottom edge. The second attempt catches cases
            // where the panel is slow to start (e.g. heavy applets).
            const _autoTileStartup = (attempt) => {
                if (!this.wm_settings.get_boolean('auto-tile')) return;
                let workspace = global.workspace_manager.get_active_workspace();
                if (!workspace) return;
                let mon = global.display.get_primary_monitor();
                let wa  = workspace.get_work_area_for_monitor(mon);
                // If work area equals full screen height the panel struts are
                // probably not registered yet - skip this attempt and let the
                // next one handle it.
                let screenH = global.screen_height || global.display.get_monitor_geometry(mon).height;
                if (wa.height >= screenH - 2 && attempt < 2) return; // retry scheduled below
                this._autoTileWorkspace(workspace);
            };
            GLib.timeout_add(GLib.PRIORITY_DEFAULT, 1000, () => {
                _autoTileStartup(1);
                return GLib.SOURCE_REMOVE;
            });
            GLib.timeout_add(GLib.PRIORITY_DEFAULT, 2500, () => {
                _autoTileStartup(2);
                return GLib.SOURCE_REMOVE;
            });
        } else {
            this._disconnectAutoTileResizeSignals();
            this._disconnectAutoTileWorkspace();
            if (this._autoTileWorkspaceSwitchedId) {
                global.workspace_manager.disconnect(this._autoTileWorkspaceSwitchedId);
                this._autoTileWorkspaceSwitchedId = null;
            }

            if (this._autoTileEdgeTilingListenerId) {
                this.wm_settings.disconnect(this._autoTileEdgeTilingListenerId);
                this._autoTileEdgeTilingListenerId = null;
            }
            this._unregisterAutoTileKeybindings();

            // Restore edge-tiling to whatever it was before auto-tile was enabled
            try {
                if (this._autoTileEdgeTilingWas !== null) {
                    this.wm_settings.set_boolean('edge-tiling', this._autoTileEdgeTilingWas);
                    this._autoTileEdgeTilingWas = null;
                }
            } catch(e) {}

            // Restore Super+Up maximize binding
            try {
                if (this._autoTileMaximizeBindingWas) {
                    let wmKb = imports.gi.Gio.Settings.new('org.gnome.desktop.wm.keybindings');
                    wmKb.set_strv('maximize', this._autoTileMaximizeBindingWas);
                    this._autoTileMaximizeBindingWas = null;
                }
            } catch(e) {}
            // Restore all push-tile bindings
            try {
                let cinKb = imports.gi.Gio.Settings.new('org.cinnamon.desktop.keybindings.wm');
                for (let [key, prop] of [
                    ['push-tile-left',  '_autoTilePushLeftWas'],
                    ['push-tile-right', '_autoTilePushRightWas'],
                    ['push-tile-up',    '_autoTilePushUpWas'],
                    ['push-tile-down',  '_autoTilePushDownWas'],
                ]) {
                    if (this[prop]) {
                        cinKb.set_strv(key, this[prop]);
                        this[prop] = null;
                    }
                }
            } catch(e) {}
            // Restore move-to-monitor bindings
            try {
                for (let schema of ['org.gnome.desktop.wm.keybindings',
                                    'org.cinnamon.desktop.keybindings.wm']) {
                    let kb = imports.gi.Gio.Settings.new(schema);
                    for (let [key, prop] of [
                        ['move-to-monitor-left',  '_autoTileMonLeftWas'],
                        ['move-to-monitor-right', '_autoTileMonRightWas'],
                        ['move-to-monitor-up',    '_autoTileMonUpWas'],
                        ['move-to-monitor-down',  '_autoTileMonDownWas'],
                    ]) {
                        try {
                            if (this[prop]) {
                                kb.set_strv(key, this[prop]);
                                this[prop] = null;
                            }
                        } catch(e) {}
                    }
                }
            } catch(e) {}

            // Restore Super+Up maximize binding
            try {
                if (this._autoTileMaximizeBindingWas) {
                    let wmKb = imports.gi.Gio.Settings.new('org.gnome.desktop.wm.keybindings');
                    wmKb.set_strv('maximize', this._autoTileMaximizeBindingWas);
                    this._autoTileMaximizeBindingWas = null;
                }
            } catch(e) {}
            this._autoTileSlotOrder = null;
            this._autoTileSlotOrderByWs.clear();
            this._autoTileWsSwitchPending    = false;
            this._autoTileWorkspaceSwitching = false;
            this._autoTileWsSwitchGen        = 0;
        }

        // Re-evaluate effect overrides now that the auto-tile state has changed.
        this.onSettingsChanged(global.settings, 'desktop-effects-map');
    }

    _registerAutoTileKeybindings() {
        if (this._autoTileKeybindingsRegistered) return;
        this._autoTileKeybindingsRegistered = true;

        let kbm = Main.keybindingManager;

        kbm.addHotKey('auto-tile-swap-left',  '<Super>Left',
            () => this._autoTileSwapWindows('left'));
        kbm.addHotKey('auto-tile-swap-right', '<Super>Right',
            () => this._autoTileSwapWindows('right'));
        kbm.addHotKey('auto-tile-cycle-cw',   '<Super>Down',
            () => this._autoTileCycleWindows('clockwise'));
        kbm.addHotKey('auto-tile-cycle-ccw',  '<Super>Up',
            () => this._autoTileCycleWindows('counter'));
        kbm.addHotKey('auto-tile-focus-left',  '<Super>h',
            () => this._autoTileFocusNeighbour('left'));
        kbm.addHotKey('auto-tile-focus-right', '<Super>l',
            () => this._autoTileFocusNeighbour('right'));
        kbm.addHotKey('auto-tile-focus-up',    '<Super>k',
            () => this._autoTileFocusNeighbour('up'));
        kbm.addHotKey('auto-tile-focus-down',  '<Super>j',
            () => this._autoTileFocusNeighbour('down'));
        kbm.addHotKey('auto-tile-focus-next', '<Super>Tab',
            () => this._autoTileFocusCycle(1));
        kbm.addHotKey('auto-tile-focus-prev', '<Super><Shift>Tab',
            () => this._autoTileFocusCycle(-1));
        kbm.addHotKey('auto-tile-close', '<Super>w',
            () => {
                let win = global.display.get_focus_window();
                if (win) win.delete(global.get_current_time());
            });
        kbm.addHotKey('auto-tile-minimize', '<Super>m',
            () => {
                let win = global.display.get_focus_window();
                if (win) win.minimize();
            });

        // Super+Shift+Arrow -> keyboard resize (move divider 50px)
        kbm.addHotKey('auto-tile-resize-left',  '<Super><Shift>Left',
            () => this._autoTileKeyboardResize('left'));
        kbm.addHotKey('auto-tile-resize-right', '<Super><Shift>Right',
            () => this._autoTileKeyboardResize('right'));
        kbm.addHotKey('auto-tile-resize-up',    '<Super><Shift>Up',
            () => this._autoTileKeyboardResize('up'));
        kbm.addHotKey('auto-tile-resize-down',  '<Super><Shift>Down',
            () => this._autoTileKeyboardResize('down'));

        // Super+Shift+Arrow are claimed by Muffin's push-tile built-ins at the C
        // level - addHotKey is silently ineffective for them. Override with
        // setBuiltinHandler instead.
        kbm.setBuiltinHandler('push-tile-left',  Meta.KeyBindingAction.PUSH_TILE_LEFT,
            () => this._autoTileKeyboardResize('left'));
        kbm.setBuiltinHandler('push-tile-right', Meta.KeyBindingAction.PUSH_TILE_RIGHT,
            () => this._autoTileKeyboardResize('right'));

        // Super+Page_Up / Page_Down -> switch workspace (previous / next)
        kbm.addHotKey('workspace-prev', '<Super>Page_Up',
            () => {
                let active = global.workspace_manager.get_active_workspace();
                let neighbor = active.get_neighbor(Meta.MotionDirection.LEFT);
                if (active != neighbor) this.moveToWorkspace(neighbor, Meta.MotionDirection.UP);
            });
        kbm.addHotKey('workspace-next', '<Super>Page_Down',
            () => {
                let active = global.workspace_manager.get_active_workspace();
                let neighbor = active.get_neighbor(Meta.MotionDirection.RIGHT);
                if (active != neighbor) this.moveToWorkspace(neighbor, Meta.MotionDirection.DOWN);
            });
    }

    _unregisterAutoTileKeybindings() {
        if (!this._autoTileKeybindingsRegistered) return;
        this._autoTileKeybindingsRegistered = false;

        let kbm = Main.keybindingManager;
        kbm.removeHotKey('auto-tile-swap-left');
        kbm.removeHotKey('auto-tile-swap-right');
        kbm.removeHotKey('auto-tile-cycle-cw');
        kbm.removeHotKey('auto-tile-cycle-ccw');
        kbm.removeHotKey('auto-tile-focus-left');
        kbm.removeHotKey('auto-tile-focus-right');
        kbm.removeHotKey('auto-tile-focus-up');
        kbm.removeHotKey('auto-tile-focus-down');
        kbm.removeHotKey('auto-tile-focus-next');
        kbm.removeHotKey('auto-tile-focus-prev');
        kbm.removeHotKey('auto-tile-close');
        kbm.removeHotKey('auto-tile-minimize');
        kbm.removeHotKey('auto-tile-resize-left');
        kbm.removeHotKey('auto-tile-resize-right');
        kbm.removeHotKey('auto-tile-resize-up');
        kbm.removeHotKey('auto-tile-resize-down');
        kbm.removeHotKey('workspace-prev');
        kbm.removeHotKey('workspace-next');
    }

    _onAutoTileWorkspaceChanged() {
        // ------------------------------------------------------------------
        // Save ALL per-workspace tiling state for the outgoing workspace so
        // it can be restored exactly when we return to it.
        // ------------------------------------------------------------------
        // Mark a switch as pending immediately - this suppresses any
        // window-added retiles that fire while windows slide onto the new
        // workspace (those would run without slot-order and clobber positions).
        this._autoTileWsSwitchPending = true;
        let prevWs = this._autoTileCurrentWorkspace;
        if (prevWs) {
            // Capture focused window ID on the outgoing workspace
            let focusWin = global.display.get_focus_window();
            let focusId  = (focusWin && this._autoTileWinById &&
                            this._autoTileWinById.has(focusWin.get_id()))
                           ? focusWin.get_id() : null;

            this._autoTileSlotOrderByWs.set(prevWs.index(), {
                slotOrder  : this._autoTileSlotOrder ? this._autoTileSlotOrder.slice() : null,
                mirrored   : this._autoTile3Mirrored,
                layout2    : this._autoTile2Layout,
                focusId    : focusId,
                // Save custom tile sizes so keyboard-resized layouts survive
                // workspace switches. Keyed by window id, value is {x,y,w,h}.
                savedRects : this._autoTileSavedRects
                    ? new Map(this._autoTileSavedRects)
                    : null,
            });
        }

        // Reset to defaults before restoring from the incoming workspace
        this._autoTile2Layout   = 'vertical';
        this._autoTile3Mirrored = false;
        this._autoTileSlotOrder = null;

        this._disconnectAutoTileResizeSignals();
        this._disconnectAutoTileWorkspace();
        this._connectAutoTileWorkspace();

        let workspace = global.workspace_manager.get_active_workspace();
        if (!workspace) return;

        // ------------------------------------------------------------------
        // Restore per-workspace tiling state for the incoming workspace.
        // Critically this includes _autoTile3Mirrored - without it the big
        // tile's slot definition flips from right to left, which causes
        // _autoTileWorkspace() to move the big tile to the wrong side.
        // ------------------------------------------------------------------
        let wsIdx    = workspace.index();
        let wsState  = this._autoTileSlotOrderByWs.get(wsIdx) || null;
        let focusIdToRestore = null;
        if (wsState) {
            if (wsState.slotOrder) this._autoTileSlotOrder = wsState.slotOrder.slice();
            this._autoTile3Mirrored  = wsState.mirrored;
            this._autoTile2Layout    = wsState.layout2;
            focusIdToRestore         = wsState.focusId;
            // Restore custom tile sizes. _autoTileWorkspace will use these
            // instead of the default equal-split rects if all IDs still match.
            this._autoTileRestoredRects = wsState.savedRects
                ? new Map(wsState.savedRects)
                : null;
        } else {
            this._autoTileRestoredRects = null;
        }

        // ------------------------------------------------------------------
        // Wait until the workspace-switch animation has fully settled before
        // retiling.  The _autoTileWorkspaceSwitching flag is SET by
        // _switchWorkspace(), which fires on the 'switch-workspace' signal -
        // but that signal arrives AFTER 'active-workspace-changed', so the
        // flag is still false when this function runs.  Polling it is
        // therefore unreliable.  Instead we use a fixed delay that is
        // comfortably longer than WORKSPACE_ANIMATION_TIME (600 ms), so
        // windows have always landed on their final positions by the time
        // _autoTileWorkspace() runs.
        // ------------------------------------------------------------------
        // Increment generation - any previously queued 650ms retile timer
        // will see a stale generation and silently abort, preventing a stale
        // workspace closure from tiling the wrong workspace.
        let myGen = ++this._autoTileWsSwitchGen;

        GLib.timeout_add(GLib.PRIORITY_DEFAULT, 650, () => {
            // Abort if another switch happened while we were waiting
            if (myGen !== this._autoTileWsSwitchGen) return GLib.SOURCE_REMOVE;

            this._autoTileWsSwitchPending = false;
            this._autoTileWorkspaceSwitching = false;
            this._autoTileWorkspace(workspace);

            // Restore focus to the window that was focused when we last left
            // this workspace, so the border lands on the correct tile.
            if (focusIdToRestore && this._autoTileWinById) {
                let winToFocus = this._autoTileWinById.get(focusIdToRestore);
                if (winToFocus) {
                    GLib.timeout_add(GLib.PRIORITY_DEFAULT, 50, () => {
                        try { winToFocus.activate(global.get_current_time()); } catch(e) {}
                        return GLib.SOURCE_REMOVE;
                    });
                }
            }

            return GLib.SOURCE_REMOVE;
        });
    }

    _connectAutoTileWorkspace() {
        let workspace = global.workspace_manager.get_active_workspace();
        if (!workspace) return;

        // Per-window notify::minimized watchers - keyed by window object so we
        // never double-connect and can cleanly disconnect on workspace change.
        if (!this._autoTileMinimizeIds) this._autoTileMinimizeIds = new Map();

        const attachMinimizeWatcher = (win) => {
            if (!win) return;
            if (win.get_window_type() !== Meta.WindowType.NORMAL) return;
            if (win.is_skip_taskbar()) return;
            if (this._autoTileMinimizeIds.has(win)) return; // already watching
            let sigId = win.connect('notify::minimized', () => {
                // Small delay so Muffin has finished updating the window state
                // before we query the workspace window list.
                GLib.timeout_add(GLib.PRIORITY_DEFAULT, 150, () => {
                    let ws = global.workspace_manager.get_active_workspace();
                    if (ws) this._autoTileWorkspace(ws);
                    return GLib.SOURCE_REMOVE;
                });
            });
            this._autoTileMinimizeIds.set(win, sigId);
        };

        // Attach to all windows already on the workspace (including minimized ones)
        workspace.list_windows().forEach(attachMinimizeWatcher);

        if (!this._autoTileWindowAddedId) {
            this._autoTileWindowAddedId = workspace.connect('window-added',
                (ws, win) => {
                    if (!win) return;
                    if (win.get_window_type() !== Meta.WindowType.NORMAL) return;
                    if (win.is_skip_taskbar()) return;
                    // Attach minimize watcher to the new window immediately
                    attachMinimizeWatcher(win);
                    // Ignore window-added events that fire while a workspace
                    // switch is pending - _onAutoTileWorkspaceChanged will do
                    // a clean retile after the animation settles.
                    if (this._autoTileWsSwitchPending) return;
                    GLib.timeout_add(GLib.PRIORITY_DEFAULT, 300, () => {
                        this._autoTileWorkspace(ws);
                        return GLib.SOURCE_REMOVE;
                    });
                });
        }

        if (!this._autoTileWindowRemovedId) {
            this._autoTileWindowRemovedId = workspace.connect('window-removed',
                (ws, win) => {
                    if (!win) return;
                    if (win.get_window_type() !== Meta.WindowType.NORMAL) return;
                    if (win.is_skip_taskbar()) return;
                    if (this._autoTileRetileBlocked) {
                        // A close-slide animation is in progress. Defer the retile
                        // until _destroyWindowDone clears the block, so the
                        // remaining tiles don't snap while the closing window is
                        // still mid-slide.
                        this._autoTilePendingRetileWs = ws;
                        return;
                    }
                    GLib.timeout_add(GLib.PRIORITY_DEFAULT, 100, () => {
                        this._autoTileWorkspace(ws);
                        return GLib.SOURCE_REMOVE;
                    });
                });
        }

        this._autoTileCurrentWorkspace = workspace;
    }

    _disconnectAutoTileWorkspace() {
        let workspace = this._autoTileCurrentWorkspace;
        if (!workspace) return;

        // Disconnect all per-window notify::minimized watchers
        if (this._autoTileMinimizeIds) {
            for (let [win, sigId] of this._autoTileMinimizeIds) {
                try { win.disconnect(sigId); } catch(e) {}
            }
            this._autoTileMinimizeIds = null;
        }

        if (this._autoTileWindowAddedId) {
            workspace.disconnect(this._autoTileWindowAddedId);
            this._autoTileWindowAddedId = null;
        }
        if (this._autoTileWindowRemovedId) {
            workspace.disconnect(this._autoTileWindowRemovedId);
            this._autoTileWindowRemovedId = null;
        }
        this._autoTileCurrentWorkspace = null;
    }

    // ------------------------------------------------------------------
    // Smart resize via size-changed + Meta.LaterType.RESIZE

    _connectAutoTileResizeSignals(tiledWindows) {
        this._autoTileResizeIds = [];

        for (let win of tiledWindows) {
            let winId = win.get_id();
            let sizeId = win.connect('size-changed', (w) => {
                Meta.later_add(Meta.LaterType.RESIZE, () => {
                    this._autoTileSmartResize(w, w.get_id());
                    return false;
                });
            });
            let unmanagedId = win.connect('unmanaging', (w) => {
                let id = w.get_id();
                this._autoTileResizeIds = this._autoTileResizeIds.filter(
                    e => e.winId !== id);
                if (this._autoTileSavedRects)    this._autoTileSavedRects.delete(id);
                if (this._autoTileOriginalRects) this._autoTileOriginalRects.delete(id);
            });
            this._autoTileResizeIds.push({ win, winId, sizeId, unmanagedId });
        }

    }

    _disconnectAutoTileResizeSignals() {
        if (!this._autoTileResizeIds || this._autoTileResizeIds.length === 0)
            return;
        for (let { win, sizeId, unmanagedId } of this._autoTileResizeIds) {
            try { win.disconnect(sizeId); }      catch(e) {}
            try { win.disconnect(unmanagedId); } catch(e) {}
        }
        this._autoTileResizeIds = [];
    }

    _autoTileSmartResize(movedWin, movedId) {
        if (!this._autoTileSavedRects || this._autoTileSavedRects.size === 0) return;
        if (movedId === undefined) movedId = movedWin.get_id();
        if (this._autoTileProgrammaticIds && this._autoTileProgrammaticIds.has(movedId)) return;

        let oldRect = this._autoTileSavedRects.get(movedId);
        if (!oldRect) return;

        let fr = movedWin.get_frame_rect();
        if (fr.x === oldRect.x && fr.y === oldRect.y &&
            fr.width === oldRect.width && fr.height === oldRect.height) return;

        // Update saved rect for mover only
        this._autoTileSavedRects.set(movedId,
            {x: fr.x, y: fr.y, width: fr.width, height: fr.height});

        // Debounce: when resize stops for 150ms, snap neighbours to fill space
        if (this._autoTileResizeDebounceId) {
            GLib.source_remove(this._autoTileResizeDebounceId);
            this._autoTileResizeDebounceId = null;
        }
        this._autoTileResizeDebounceId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 150, () => {
            this._autoTileResizeDebounceId = null;
            try {
                let mfr = movedWin.get_frame_rect();
                let gap = this.wm_settings.get_int('auto-tile-gap');
                let workspace = global.workspace_manager.get_active_workspace();
                if (!workspace) return GLib.SOURCE_REMOVE;
                let mon = global.display.get_primary_monitor();
                let wa = workspace.get_work_area_for_monitor(mon);
                let waLeft = wa.x + gap, waTop = wa.y + gap;
                let waRight = wa.x + wa.width - gap, waBottom = wa.y + wa.height - gap;
                let minW = Math.floor(wa.width / 4);
                let minH = Math.floor(wa.height / 3);

                if (!this._autoTileProgrammaticIds)
                    this._autoTileProgrammaticIds = new Set();

                let tiledWins = this._autoTileGetTiledWindows();
                let others = tiledWins.filter(w => w.get_id() !== movedId);

                for (let win of others) {
                    let saved = this._autoTileSavedRects.get(win.get_id());
                    if (!saved) continue;
                    let nx = saved.x, ny = saved.y, nw = saved.width, nh = saved.height;

                    let isRight = saved.x >= mfr.x + mfr.width / 2;
                    let isLeft  = saved.x + saved.width <= mfr.x + mfr.width / 2;
                    let isBelow = !isRight && !isLeft && saved.y > mfr.y;

                    if (isRight) {
                        // Preserve the neighbour's vertical position - only adjust X/width.
                        // Forcing ny=waTop/nh=full-height here would collapse a 3-tile
                        // vertical split (S1/S2) into a single full-height tile.
                        nx = Math.min(mfr.x + mfr.width, waRight - minW - gap) + gap;
                        nw = waRight - nx;
                        // ny and nh stay as saved - vertical extent is unchanged
                        let maxMoverRight = nx - gap;
                        if (mfr.x + mfr.width > maxMoverRight) {
                            this._autoTileProgrammaticIds.add(movedId);
                            movedWin.move_resize_frame(false, mfr.x, mfr.y,
                                maxMoverRight - mfr.x, mfr.height);
                        }
                    } else if (isLeft) {
                        // Preserve the neighbour's vertical position - only adjust X/width.
                        nw = Math.max(mfr.x - gap - waLeft, minW);
                        nx = waLeft;
                        // ny and nh stay as saved
                        let minMoverLeft = nx + nw + gap;
                        if (mfr.x < minMoverLeft) {
                            this._autoTileProgrammaticIds.add(movedId);
                            movedWin.move_resize_frame(false, minMoverLeft, mfr.y,
                                mfr.x + mfr.width - minMoverLeft, mfr.height);
                        }
                    } else if (isBelow) {
                        // Preserve the neighbour's horizontal position - only adjust Y/height.
                        ny = Math.min(mfr.y + mfr.height, waBottom - minH - gap) + gap;
                        nh = waBottom - ny;
                        // nx and nw stay as saved
                        let maxMoverBottom = ny - gap;
                        if (mfr.y + mfr.height > maxMoverBottom) {
                            this._autoTileProgrammaticIds.add(movedId);
                            movedWin.move_resize_frame(false, mfr.x, mfr.y,
                                mfr.width, maxMoverBottom - mfr.y);
                        }
                    } else {
                        // Preserve the neighbour's horizontal position - only adjust Y/height.
                        nh = Math.max(mfr.y - gap - waTop, minH);
                        ny = waTop;
                        // nx and nw stay as saved
                        let minMoverTop = ny + nh + gap;
                        if (mfr.y < minMoverTop) {
                            this._autoTileProgrammaticIds.add(movedId);
                            movedWin.move_resize_frame(false, mfr.x, minMoverTop,
                                mfr.width, mfr.y + mfr.height - minMoverTop);
                        }
                    }

                    if (nw < minW || nh < minH) continue;
                    this._autoTileProgrammaticIds.add(win.get_id());
                    this._autoTileSavedRects.set(win.get_id(),
                        {x: nx, y: ny, width: nw, height: nh});
                    try { win.move_resize_frame(false, nx, ny, nw, nh); } catch(e) {}
                }

                this._autoTileSavedRects.set(movedId,
                    {x: mfr.x, y: mfr.y, width: mfr.width, height: mfr.height});

                GLib.timeout_add(GLib.PRIORITY_DEFAULT, 80, () => {
                    if (this._autoTileProgrammaticIds)
                        this._autoTileProgrammaticIds.clear();
                    return GLib.SOURCE_REMOVE;
                });
            } catch(e) {
                if (this._autoTileProgrammaticIds)
                    this._autoTileProgrammaticIds.clear();
            }
            return GLib.SOURCE_REMOVE;
        });
    }


    _autoTileGetTiledWindows() {
        let workspace = global.workspace_manager.get_active_workspace();
        if (!workspace) return [];
        return workspace.list_windows().filter(win => {
            if (win.is_skip_taskbar()) return false;
            if (win.get_window_type() !== Meta.WindowType.NORMAL) return false;
            if (win.minimized) return false;
            let wmClass = win.get_wm_class() || '';
            if (wmClass !== '') {
                let excludeList = this.wm_settings.get_strv('auto-tile-excludelist');
                if (excludeList.includes(wmClass)) return false;
            }
            return true;
        });
    }

    _autoTileSwapWindows(direction) {
        if (!this.wm_settings.get_boolean('auto-tile')) return false;
        let tiledWins = this._autoTileGetTiledWindows();
        if (tiledWins.length < 2) return false;
        // --- 3 tile case: toggle mirror and retile ---
        if (tiledWins.length === 3) {
            this._autoTile3Mirrored = !this._autoTile3Mirrored;
            let workspace = global.workspace_manager.get_active_workspace();
            if (workspace) this._autoTileWorkspace(workspace);
            return true;
        }
        // --- 4 tile case: mirror left column left right column ---
        if (tiledWins.length === 4) {
            let workspace    = global.workspace_manager.get_active_workspace();
            let monitorIndex = global.display.get_primary_monitor();
            let workArea     = workspace.get_work_area_for_monitor(monitorIndex);
            let idealRects   = this._computeAutoTileRects(4,
                workArea.x, workArea.y, workArea.width, workArea.height);
            let slotWin = new Array(4);
            for (let win of tiledWins) {
                let fr = win.get_frame_rect();
                let cx = fr.x + fr.width/2;
                let cy = fr.y + fr.height/2;
                let bestS = -1, bestD = Infinity;
                for (let s=0; s<4; s++) {
                    let ir = idealRects[s];
                    let d = Math.hypot(cx-(ir.x+ir.w/2), cy-(ir.y+ir.h/2));
                    if (d < bestD) { bestD = d; bestS = s; }
                }
                slotWin[bestS] = win;
            }
            const mirrorMap = [1, 0, 3, 2];
            if (!this._autoTileProgrammaticIds) this._autoTileProgrammaticIds = new Set();
            for (let s=0; s<4; s++) {
                let win = slotWin[s];
                if (!win) continue;
                let dest = idealRects[mirrorMap[s]];
                this._autoTileProgrammaticIds.add(win.get_id());
                win.move_resize_frame(false, dest.x, dest.y, dest.w, dest.h);
            }
            this._autoTileWorkspace(workspace);
            return true;
        }
        // --- 2 tile case: explicitly swap positions ---
        let focusedWin = global.display.get_focus_window();
        if (!focusedWin) return false;
        let focusIdx = tiledWins.indexOf(focusedWin);
        if (focusIdx < 0) return false;
        let partnerWin = tiledWins[focusIdx === 0 ? 1 : 0];
        let rectA = focusedWin.get_frame_rect();
        let rectB = partnerWin.get_frame_rect();
        if (!this._autoTileProgrammaticIds) this._autoTileProgrammaticIds = new Set();
        this._autoTileProgrammaticIds.add(focusedWin.get_id());
        this._autoTileProgrammaticIds.add(partnerWin.get_id());
        focusedWin.move_resize_frame(false, rectB.x, rectB.y, rectB.width, rectB.height);
        partnerWin.move_resize_frame(false, rectA.x, rectA.y, rectA.width, rectA.height);
        if (this._autoTileSlotOrder) {
            let fi = this._autoTileSlotOrder.indexOf(focusedWin.get_id());
            let pi = this._autoTileSlotOrder.indexOf(partnerWin.get_id());
            if (fi >= 0 && pi >= 0) {
                let tempId = this._autoTileSlotOrder[fi];
                this._autoTileSlotOrder[fi] = this._autoTileSlotOrder[pi];
                this._autoTileSlotOrder[pi] = tempId;
            }
        }
        // Update saved rects BEFORE clearing programmaticIds
        // so smart-resize sees the new positions and doesn't snap back
        if (this._autoTileSavedRects) {
            this._autoTileSavedRects.set(focusedWin.get_id(),
                {x: rectB.x, y: rectB.y, width: rectB.width, height: rectB.height});
            this._autoTileSavedRects.set(partnerWin.get_id(),
                {x: rectA.x, y: rectA.y, width: rectA.width, height: rectA.height});
        }
        if (this._autoTileOriginalRects) {
            this._autoTileOriginalRects.set(focusedWin.get_id(),
                {width: rectB.width, height: rectB.height});
            this._autoTileOriginalRects.set(partnerWin.get_id(),
                {width: rectA.width, height: rectA.height});
        }
        GLib.timeout_add(GLib.PRIORITY_DEFAULT, 150, () => {
            if (focusedWin) focusedWin.activate(global.get_current_time());
            if (this._autoTileProgrammaticIds) this._autoTileProgrammaticIds.clear();
            return GLib.SOURCE_REMOVE;
        });
        return true;
    }

    _autoTileCycleWindows(direction) {
        if (!this.wm_settings.get_boolean('auto-tile')) return false;

        let tiledWins = this._autoTileGetTiledWindows();
        if (tiledWins.length < 2) return false;

        // --- 2-tile: 4-position rotation ---
        if (tiledWins.length === 2) {
            let step = (direction === 'clockwise') ? 1 : -1;
            this._autoTile2Pos = (((this._autoTile2Pos || 0) + step) % 4 + 4) % 4;

            let ws  = global.workspace_manager.get_active_workspace();
            let mon = global.display.get_primary_monitor();
            let wa  = ws.get_work_area_for_monitor(mon);
            let gap = this.wm_settings.get_int('auto-tile-gap');
            let x = wa.x + gap, y = wa.y + gap;
            let w = wa.width - gap * 2, h = wa.height - gap * 2;
            let hw = Math.floor((w - gap) / 2), hw2 = w - hw - gap;
            let hh = Math.floor((h - gap) / 2), hh2 = h - hh - gap;

            // Use stored win0 identity if available, otherwise sort by screen pos
            let win0, win1;
            if (this._autoTile2Win0Id) {
                let w0 = tiledWins.find(w => w.get_id() === this._autoTile2Win0Id);
                let w1 = tiledWins.find(w => w.get_id() !== this._autoTile2Win0Id);
                if (w0 && w1) { win0 = w0; win1 = w1; }
            }
            if (!win0 || !win1) {
                let sorted = tiledWins.slice().sort((a, b) => {
                    let ra = a.get_frame_rect(), rb = b.get_frame_rect();
                    return ra.x !== rb.x ? ra.x - rb.x : ra.y - rb.y;
                });
                win0 = sorted[0]; win1 = sorted[1];
                this._autoTile2Win0Id = win0.get_id();
            }

            let r0, r1;
            switch (this._autoTile2Pos) {
                case 0: r0={x,y,w:hw,h};           r1={x:x+hw+gap,y,w:hw2,h};
                        this._autoTile2Layout='vertical';   break;
                case 1: r0={x,y,w,h:hh};           r1={x,y:y+hh+gap,w,h:hh2};
                        this._autoTile2Layout='horizontal'; break;
                case 2: r0={x:x+hw+gap,y,w:hw2,h}; r1={x,y,w:hw,h};
                        this._autoTile2Layout='vertical';   break;
                case 3: r0={x,y:y+hh+gap,w,h:hh2}; r1={x,y,w,h:hh};
                        this._autoTile2Layout='horizontal'; break;
            }

            if (!this._autoTileProgrammaticIds) this._autoTileProgrammaticIds = new Set();
            this._autoTileProgrammaticIds.add(win0.get_id());
            this._autoTileProgrammaticIds.add(win1.get_id());
            win0.move_resize_frame(false, r0.x, r0.y, r0.w, r0.h);
            win1.move_resize_frame(false, r1.x, r1.y, r1.w, r1.h);
            this._autoTileSlotOrder = [win0.get_id(), win1.get_id()];
            this._autoTile2Win0Id = win0.get_id();

            GLib.timeout_add(GLib.PRIORITY_DEFAULT, 50, () => {
                if (this._autoTileProgrammaticIds) this._autoTileProgrammaticIds.clear();
                return GLib.SOURCE_REMOVE;
            });
            return true;
        }

        // --- 3+ tiles: rotate slot assignments ---
        let workspace    = global.workspace_manager.get_active_workspace();
        let monitorIndex = global.display.get_primary_monitor();
        let workArea     = workspace.get_work_area_for_monitor(monitorIndex);
        let mirrored     = (tiledWins.length === 3) ? (this._autoTile3Mirrored || false) : false;
        let idealRects   = this._computeAutoTileRects(tiledWins.length,
            workArea.x, workArea.y, workArea.width, workArea.height, 'vertical', mirrored);

        let slotOrder = new Array(tiledWins.length);
        let usedSlots = new Set();
        for (let i = 0; i < tiledWins.length; i++) {
            let fr = tiledWins[i].get_frame_rect();
            let cx = fr.x + fr.width  / 2;
            let cy = fr.y + fr.height / 2;
            let bestSlot = -1, bestDist = Infinity;
            for (let s = 0; s < idealRects.length; s++) {
                if (usedSlots.has(s)) continue;
                let ir = idealRects[s];
                let d  = Math.hypot(cx - (ir.x + ir.w/2), cy - (ir.y + ir.h/2));
                if (d < bestDist) { bestDist = d; bestSlot = s; }
            }
            slotOrder[i] = bestSlot;
            usedSlots.add(bestSlot);
        }

        let slotWin = new Array(tiledWins.length);
        for (let i = 0; i < tiledWins.length; i++)
            slotWin[slotOrder[i]] = tiledWins[i];

        let n = tiledWins.length;

        // Clockwise perimeter order:
        // 3-tile: 0(big-left) -> 1(top-right) -> 2(bottom-right) -> 0
        // 4-tile: 0(TL) -> 1(TR) -> 3(BR) -> 2(BL) -> 0
        let cwOrder = (n === 3) ? [0, 1, 2] : [0, 1, 3, 2];

        let nextSlot = new Array(n);
        for (let i = 0; i < cwOrder.length; i++) {
            let from = cwOrder[i];
            let to   = direction === 'clockwise'
                ? cwOrder[(i + 1) % cwOrder.length]
                : cwOrder[(i - 1 + cwOrder.length) % cwOrder.length];
            nextSlot[from] = to;
        }

        if (!this._autoTileProgrammaticIds) this._autoTileProgrammaticIds = new Set();
        for (let win of tiledWins)
            this._autoTileProgrammaticIds.add(win.get_id());

        // Save focused window before cycling - restore after moves
        let focusedWinBeforeCycle = global.display.get_focus_window();

        let newSlotWin = new Array(n);
        for (let s = 0; s < n; s++)
            newSlotWin[nextSlot[s]] = slotWin[s];
        this._autoTileSlotOrder = newSlotWin.map(w => w.get_id());

        for (let s = 0; s < n; s++) {
            let win  = slotWin[s];
            let dest = idealRects[nextSlot[s]];
            win.move_resize_frame(false, dest.x, dest.y, dest.w, dest.h);
        }

        // Re-activate the originally focused window after the move
        GLib.timeout_add(GLib.PRIORITY_DEFAULT, 50, () => {
            if (focusedWinBeforeCycle) {
                try { focusedWinBeforeCycle.activate(global.get_current_time()); } catch(e) {}
            }
            return GLib.SOURCE_REMOVE;
        });

        GLib.timeout_add(GLib.PRIORITY_DEFAULT, 50, () => {
            if (!this._autoTileSavedRects) {
                if (this._autoTileProgrammaticIds) this._autoTileProgrammaticIds.clear();
                return GLib.SOURCE_REMOVE;
            }
            for (let [id, win] of this._autoTileWinById) {
                try {
                    let fr = win.get_frame_rect();
                    this._autoTileSavedRects.set(id,
                        { x: fr.x, y: fr.y, width: fr.width, height: fr.height });
                    this._autoTileOriginalRects.set(id,
                        { width: fr.width, height: fr.height });
                } catch(e) {}
            }
            if (this._autoTileProgrammaticIds) this._autoTileProgrammaticIds.clear();
            return GLib.SOURCE_REMOVE;
        });

        return true;
    }

    _autoTileFocusNeighbour(direction) {
        if (!this.wm_settings.get_boolean('auto-tile')) return false;

        let focusedWin = global.display.get_focus_window();
        if (!focusedWin) return false;

        let tiledWins = this._autoTileGetTiledWindows();
        if (tiledWins.length < 2) return false;

        let fr  = focusedWin.get_frame_rect();
        let fcx = fr.x + fr.width  / 2;
        let fcy = fr.y + fr.height / 2;

        let bestWin  = null;
        let bestDist = Infinity;

        for (let win of tiledWins) {
            if (win === focusedWin) continue;
            let r   = win.get_frame_rect();
            let cx  = r.x + r.width  / 2;
            let cy  = r.y + r.height / 2;
            let dx  = cx - fcx;
            let dy  = cy - fcy;
            let ok  = false;
            let dist;
            if (direction === 'left'  && dx < 0) { ok = true; dist = Math.abs(dx) + Math.abs(dy)*0.5; }
            if (direction === 'right' && dx > 0) { ok = true; dist = Math.abs(dx) + Math.abs(dy)*0.5; }
            if (direction === 'up'    && dy < 0) { ok = true; dist = Math.abs(dy) + Math.abs(dx)*0.5; }
            if (direction === 'down'  && dy > 0) { ok = true; dist = Math.abs(dy) + Math.abs(dx)*0.5; }
            if (ok && dist < bestDist) { bestDist = dist; bestWin = win; }
        }

        if (bestWin) {
            bestWin.activate(global.get_current_time());
            return true;
        }
        return false;
    }

    // Super+Tab / Super+Shift+Tab - cycle focus through tiled windows
    // in left-to-right, top-to-bottom slot order.
    _autoTileFocusCycle(step) {
        if (!this.wm_settings.get_boolean('auto-tile')) return false;

        let tiledWins = this._autoTileGetTiledWindows();
        if (tiledWins.length < 2) return false;

        // Sort windows by slot order if available, otherwise by position
        let ordered;
        if (this._autoTileSlotOrder && this._autoTileWinById) {
            ordered = this._autoTileSlotOrder
                .map(id => this._autoTileWinById.get(id))
                .filter(w => w && tiledWins.includes(w));
        } else {
            // fallback: sort left-to-right, top-to-bottom by tile rect centre
            ordered = tiledWins.slice().sort((a, b) => {
                let ra = a.get_frame_rect(), rb = b.get_frame_rect();
                let cya = ra.y + ra.height / 2, cyb = rb.y + rb.height / 2;
                let cxa = ra.x + ra.width  / 2, cxb = rb.x + rb.width  / 2;
                if (Math.abs(cya - cyb) > 50) return cya - cyb;
                return cxa - cxb;
            });
        }

        let focusedWin = global.display.get_focus_window();
        let idx = ordered.indexOf(focusedWin);
        if (idx < 0) idx = 0;

        let next = (idx + step + ordered.length) % ordered.length;
        ordered[next].activate(global.get_current_time());
        return true;
    }

    // ------------------------------------------------------------------

    _canAutoTileWindow(win, rect) {
        if (!win.allows_resize()) return false;
        if (rect.w < 200 || rect.h < 150) return false;
        let wmClass = win.get_wm_class() || '';
        if (wmClass !== '') {
            let excludeList = this.wm_settings.get_strv('auto-tile-excludelist');
            if (excludeList.includes(wmClass)) return false;
        }
        return true;
    }

    _autoTileWorkspace(workspace) {
        if (!this.wm_settings.get_boolean('auto-tile')) return;
        if (!workspace) return;

        let allWindows = workspace.list_windows().filter(win => {
            if (win.is_skip_taskbar()) return false;
            if (win.get_window_type() !== Meta.WindowType.NORMAL) return false;
            if (win.minimized) return false;
            return true;
        });

        if (allWindows.length === 0) return;

        let display      = global.display;
        let monitorIndex = display.get_primary_monitor();
        let workArea     = workspace.get_work_area_for_monitor(monitorIndex);

        let x = workArea.x;
        let y = workArea.y;
        let w = workArea.width;
        let h = workArea.height;

        const MAX_WINDOWS = 4;

        let tileableWindows = [];
        let floatingWindows = [];
        for (let win of allWindows) {
            if (this._canAutoTileWindow(win, {w, h})) {
                tileableWindows.push(win);
            } else {
                floatingWindows.push(win);
            }
        }

        if (tileableWindows.length > MAX_WINDOWS) {
            let currentIndex = workspace.index();
            let nextIndex = currentIndex + 1;
            if (nextIndex >= global.workspace_manager.n_workspaces)
                global.workspace_manager.append_new_workspace(false,
                    global.get_current_time());
            for (let i = MAX_WINDOWS; i < tileableWindows.length; i++)
                tileableWindows[i].change_workspace_by_index(nextIndex, false);
            tileableWindows = tileableWindows.slice(0, MAX_WINDOWS);
        }

        // Reorder tileableWindows by remembered slot order if available
        if (this._autoTileSlotOrder && this._autoTileSlotOrder.length === tileableWindows.length) {
            let byId = new Map(tileableWindows.map(w => [w.get_id(), w]));
            let ordered = this._autoTileSlotOrder.map(id => byId.get(id)).filter(w => w != null);
            if (ordered.length === tileableWindows.length)
                tileableWindows = ordered;
            else
                this._autoTileSlotOrder = null;
        }

        this._disconnectAutoTileResizeSignals();

        this._autoTileSavedRects    = new Map();
        this._autoTileOriginalRects = new Map();
        this._autoTileWinById       = new Map();

        let layout2  = (tileableWindows.length === 2) ? this._autoTile2Layout : 'vertical';
        let mirrored = (tileableWindows.length === 3) ? (this._autoTile3Mirrored || false) : false;
        let rects    = this._computeAutoTileRects(tileableWindows.length, x, y, w, h, layout2, mirrored);

        this._autoTileSlotOrder = tileableWindows.map(w => w.get_id());

        // If we have saved custom rects from a previous keyboard resize on this
        // workspace (restored by _onAutoTileWorkspaceChanged), use those instead
        // of the default equal-split rects - provided every tiled window still
        // has a saved rect (i.e. no windows were opened/closed since the save).
        let restored = this._autoTileRestoredRects;
        let useRestored = false;
        if (restored && restored.size === tileableWindows.length) {
            useRestored = tileableWindows.every(win => restored.has(win.get_id()));
        }
        this._autoTileRestoredRects = null; // consume it

        for (let i = 0; i < tileableWindows.length; i++) {
            let win = tileableWindows[i];
            let id  = win.get_id();
            let r;
            if (useRestored) {
                let sr = restored.get(id);
                r = { x: sr.x, y: sr.y, w: sr.width, h: sr.height };
            } else {
                r = rects[i];
            }
            if (win.get_maximized())
                win.unmaximize(Meta.MaximizeFlags.BOTH);
            win.move_resize_frame(false, r.x, r.y, r.w, r.h);
            this._autoTileSavedRects.set(id,    { x: r.x, y: r.y, width: r.w, height: r.h });
            this._autoTileOriginalRects.set(id, { width: r.w, height: r.h });
            this._autoTileWinById.set(id, win);
        }

        this._connectAutoTileResizeSignals(tileableWindows);

        for (let win of floatingWindows) {
            if (win.get_maximized())
                win.unmaximize(Meta.MaximizeFlags.BOTH);
        }
    }

    // ------------------------------------------------------------------
    // Keyboard resize - Super+Shift+Arrow moves the divider 50px
    // ------------------------------------------------------------------

    _autoTileKeyboardResize(direction) {
        // Super+Shift+Arrow moves the shared divider in the arrow direction.
        //
        // The key moves ONE physical divider line. Everything on one side of that
        // line expands; everything on the other side shrinks.
        //
        // Multi-tile rules:
        //   3-tile [Big | S1, S2]:
        //     Big focused + Right  -> vertical divider moves right -> Big grows, S1+S2 shrink
        //     Big focused + Left   -> vertical divider moves left  -> Big shrinks, S1+S2 grow
        //     S1 focused + Right   -> vertical divider right -> S1+S2 group expands (co-mover: S2)
        //     S1 focused + Left    -> vertical divider left  -> S1+S2 group shrinks
        //     S1 focused + Down    -> horizontal divider between S1 and S2 -> only S1 and S2 resize
        //     S1 focused + Up      -> same horiz divider, opposite direction
        //
        //   4-tile [TL TR / BL BR]:
        //     TL focused + Right -> TL+BL expand (co-mover: BL), TR+BR shrink
        //     TL focused + Down  -> TL+TR expand (co-mover: TR), BL+BR shrink
        //
        // Algorithm:
        //   1. Find all primaryNeighbours: tiles whose touching edge aligns with
        //      focused tile's edge in 'direction'. These sit across the divider.
        //   2. If none in 'direction', look on opposite side (shrink mode).
        //   3. Find coMovers: tiles NOT across the divider that share the SAME
        //      divider edge as the focused tile (same side, same divider position).
        //   4. Move divider by STEP. Focused + coMovers grow/shrink together.
        //      Primary neighbours grow/shrink together on the other side.

        if (!this.wm_settings.get_boolean('auto-tile')) return;
        let focusWin = global.display.get_focus_window();
        if (!focusWin) return;
        let tiledWins = this._autoTileGetTiledWindows();
        if (tiledWins.length < 2 || !tiledWins.includes(focusWin)) return;

        const STEP = 50;
        const EPS  = 30;
        let gap = this.wm_settings.get_int('auto-tile-gap');
        let workspace = global.workspace_manager.get_active_workspace();
        let mon = global.display.get_primary_monitor();
        let wa = workspace.get_work_area_for_monitor(mon);
        let minW = Math.floor(wa.width  / 4);
        let minH = Math.floor(wa.height / 3);

        let fr = focusWin.get_frame_rect();
        let fx = fr.x, fy = fr.y, fw = fr.width, fh = fr.height;
        let fRight = fx + fw, fBottom = fy + fh;

        const opposite = { right: 'left', left: 'right', up: 'down', down: 'up' };

        // Find all windows whose touching edge aligns with focused tile's 'side' edge.
        const findNeighbours = (side) => {
            let result = [];
            for (let win of tiledWins) {
                if (win === focusWin) continue;
                let r = win.get_frame_rect();
                let gap_dist;
                if      (side === 'right') gap_dist = r.x          - fRight;
                else if (side === 'left')  gap_dist = fx           - (r.x + r.width);
                else if (side === 'down')  gap_dist = r.y          - fBottom;
                else                       gap_dist = fy           - (r.y + r.height);
                if (gap_dist >= -EPS && gap_dist <= gap + EPS)
                    result.push(win);
            }
            return result;
        };

        // Determine sharedSide and primaryNeighbours
        let primaryNeighbours = findNeighbours(direction);
        let sharedSide = direction;
        if (primaryNeighbours.length === 0) {
            primaryNeighbours = findNeighbours(opposite[direction]);
            if (primaryNeighbours.length === 0) return;
            sharedSide = opposite[direction];
        }

        // Current divider position = focused tile's sharedSide edge
        let dividerPos;
        if      (sharedSide === 'right') dividerPos = fRight;
        else if (sharedSide === 'left')  dividerPos = fx;
        else if (sharedSide === 'down')  dividerPos = fBottom;
        else                              dividerPos = fy;

        // Delta: the divider always moves in the key direction.
        // right/down = positive, left/up = negative.
        // Whether this expands or shrinks the focused tile depends on which side
        // of the focused tile the divider is on (sharedSide), but the physical
        // direction of movement is always determined by the key pressed.
        const delta = (direction === 'right' || direction === 'down') ? +STEP : -STEP;

        const primarySet = new Set(primaryNeighbours.map(w => w.get_id()));

        // Co-movers: tiles on the SAME side as focused (not primary neighbours)
        // that share the same divider edge as the focused tile.
        const findCoMovers = () => {
            let result = [];
            for (let win of tiledWins) {
                if (win === focusWin) continue;
                if (primarySet.has(win.get_id())) continue;
                let r = win.get_frame_rect();
                let winEdge;
                if      (sharedSide === 'right') winEdge = r.x + r.width;
                else if (sharedSide === 'left')  winEdge = r.x;
                else if (sharedSide === 'down')  winEdge = r.y + r.height;
                else                              winEdge = r.y;
                if (Math.abs(winEdge - dividerPos) <= EPS)
                    result.push(win);
            }
            return result;
        };
        let coMovers = findCoMovers();

        // Clamp newDividerPos so every tile stays >= minW/minH
        let newDividerPos = dividerPos + delta;

        if (sharedSide === 'right' || sharedSide === 'left') {
            // X-axis divider
            for (let nb of primaryNeighbours) {
                let r = nb.get_frame_rect();
                if (sharedSide === 'right') {
                    // nb is to the right; its right edge is fixed
                    let nbMaxLeft = (r.x + r.width) - gap - minW;
                    newDividerPos = Math.min(newDividerPos, nbMaxLeft);
                } else {
                    // nb is to the left; its left edge is fixed
                    let nbMinRight = r.x + minW + gap;
                    newDividerPos = Math.max(newDividerPos, nbMinRight);
                }
            }
            if (sharedSide === 'right') {
                newDividerPos = Math.max(newDividerPos, fx + minW);
                for (let cm of coMovers) {
                    let r = cm.get_frame_rect();
                    newDividerPos = Math.max(newDividerPos, r.x + minW);
                }
            } else {
                newDividerPos = Math.min(newDividerPos, fRight - minW);
                for (let cm of coMovers) {
                    let r = cm.get_frame_rect();
                    newDividerPos = Math.min(newDividerPos, (r.x + r.width) - minW);
                }
            }
        } else {
            // Y-axis divider
            for (let nb of primaryNeighbours) {
                let r = nb.get_frame_rect();
                if (sharedSide === 'down') {
                    let nbMaxTop = (r.y + r.height) - gap - minH;
                    newDividerPos = Math.min(newDividerPos, nbMaxTop);
                } else {
                    let nbMinBottom = r.y + minH + gap;
                    newDividerPos = Math.max(newDividerPos, nbMinBottom);
                }
            }
            if (sharedSide === 'down') {
                newDividerPos = Math.max(newDividerPos, fy + minH);
                for (let cm of coMovers) {
                    let r = cm.get_frame_rect();
                    newDividerPos = Math.max(newDividerPos, r.y + minH);
                }
            } else {
                newDividerPos = Math.min(newDividerPos, fBottom - minH);
                for (let cm of coMovers) {
                    let r = cm.get_frame_rect();
                    newDividerPos = Math.min(newDividerPos, (r.y + r.height) - minH);
                }
            }
        }

        if (newDividerPos === dividerPos) return;

        // --- Build update list ---
        const updates = [];

        // Focused tile
        let newFx = fx, newFy = fy, newFw = fw, newFh = fh;
        if      (sharedSide === 'right') { newFw = newDividerPos - fx; }
        else if (sharedSide === 'left')  { newFx = newDividerPos; newFw = fRight - newDividerPos; }
        else if (sharedSide === 'down')  { newFh = newDividerPos - fy; }
        else                              { newFy = newDividerPos; newFh = fBottom - newDividerPos; }
        if (newFw < minW || newFh < minH) return;
        updates.push({ win: focusWin, nx: newFx, ny: newFy, nw: newFw, nh: newFh });

        // Co-movers: same sharedSide edge, same delta
        for (let cm of coMovers) {
            let r = cm.get_frame_rect();
            let nx = r.x, ny = r.y, nw = r.width, nh = r.height;
            if      (sharedSide === 'right') { nw = newDividerPos - r.x; }
            else if (sharedSide === 'left')  { nx = newDividerPos; nw = (r.x + r.width) - newDividerPos; }
            else if (sharedSide === 'down')  { nh = newDividerPos - r.y; }
            else                              { ny = newDividerPos; nh = (r.y + r.height) - newDividerPos; }
            if (nw < minW || nh < minH) return;
            updates.push({ win: cm, nx, ny, nw, nh });
        }

        // Primary neighbours: opposite side of divider
        for (let nb of primaryNeighbours) {
            let r = nb.get_frame_rect();
            let nx = r.x, ny = r.y, nw = r.width, nh = r.height;
            if (sharedSide === 'right') {
                nx = newDividerPos + gap; nw = (r.x + r.width) - nx;
            } else if (sharedSide === 'left') {
                nw = newDividerPos - gap - r.x;
            } else if (sharedSide === 'down') {
                ny = newDividerPos + gap; nh = (r.y + r.height) - ny;
            } else {
                nh = newDividerPos - gap - r.y;
            }
            if (nw < minW || nh < minH) return;
            updates.push({ win: nb, nx, ny, nw, nh });
        }

        // --- Commit ---
        if (!this._autoTileProgrammaticIds) this._autoTileProgrammaticIds = new Set();
        for (let {win, nx, ny, nw, nh} of updates) {
            this._autoTileProgrammaticIds.add(win.get_id());
            win.move_resize_frame(false, nx, ny, nw, nh);
            if (this._autoTileSavedRects)
                this._autoTileSavedRects.set(win.get_id(), {x: nx, y: ny, width: nw, height: nh});
        }

        GLib.timeout_add(GLib.PRIORITY_DEFAULT, 300, () => {
            if (this._autoTileProgrammaticIds) this._autoTileProgrammaticIds.clear();
            return GLib.SOURCE_REMOVE;
        });
    }

    // ------------------------------------------------------------------

    _computeAutoTileRects(count, x, y, w, h, layout2 = 'vertical', mirrored = false) {
        let gap  = this.wm_settings.get_int('auto-tile-gap');
        let eg   = gap;

        let rx = x + eg;
        let ry = y + eg;
        let rw = w - eg * 2;
        let rh = h - eg * 2;

        let rects = [];

        let hwg  = Math.floor((rw - gap) / 2);
        let hwg2 = rw - hwg - gap;
        let hhg  = Math.floor((rh - gap) / 2);
        let hhg2 = rh - hhg - gap;

        switch (count) {
            case 1:
                rects.push({x: rx,             y: ry,             w: rw,   h: rh   });
                break;
            case 2:
                if (layout2 === 'horizontal') {
                    rects.push({x: rx,           y: ry,             w: rw,   h: hhg  });
                    rects.push({x: rx,           y: ry+hhg+gap,     w: rw,   h: hhg2 });
                } else {
                    rects.push({x: rx,           y: ry,             w: hwg,  h: rh   });
                    rects.push({x: rx+hwg+gap,   y: ry,             w: hwg2, h: rh   });
                }
                break;
            case 3:
                if (mirrored) {
                    rects.push({x: rx+hwg+gap,   y: ry,             w: hwg2, h: rh   });
                    rects.push({x: rx,           y: ry,             w: hwg,  h: hhg  });
                    rects.push({x: rx,           y: ry+hhg+gap,     w: hwg,  h: hhg2 });
                } else {
                    rects.push({x: rx,           y: ry,             w: hwg,  h: rh   });
                    rects.push({x: rx+hwg+gap,   y: ry,             w: hwg2, h: hhg  });
                    rects.push({x: rx+hwg+gap,   y: ry+hhg+gap,     w: hwg2, h: hhg2 });
                }
                break;
            case 4:
                rects.push({x: rx,             y: ry,             w: hwg,  h: hhg  });
                rects.push({x: rx+hwg+gap,     y: ry,             w: hwg2, h: hhg  });
                rects.push({x: rx,             y: ry+hhg+gap,     w: hwg,  h: hhg2 });
                rects.push({x: rx+hwg+gap,     y: ry+hhg+gap,     w: hwg2, h: hhg2 });
                break;
        }
        return rects;
    }
    onSettingsChanged(settings, key, data=null) {
        if (key === "desktop-effects-workspace") {
            Main.updateAnimationsEnabled();
        }

        this.desktop_effects_windows = Main.animations_enabled && global.settings.get_boolean("desktop-effects");
        this.desktop_effects_menus = Main.animations_enabled && global.settings.get_boolean("desktop-effects-on-menus");
        this.desktop_effects_dialogs = Main.animations_enabled && global.settings.get_boolean("desktop-effects-on-dialogs");
        this.desktop_effects_size_change = this.desktop_effects_windows && global.settings.get_boolean("desktop-effects-change-size");

        this.desktop_effects_close_type = global.settings.get_string("desktop-effects-close");
        this.desktop_effects_map_type = global.settings.get_string("desktop-effects-map");
        this.desktop_effects_minimize_type = global.settings.get_string("desktop-effects-minimize");

        this.window_effect_multiplier = WINDOW_ANIMATION_TIME_MULTIPLIERS[global.settings.get_int("window-effect-speed")];
    }

    _shouldAnimate(actor, types=null) {
        // Check if system is in modal state or in software rendering
        if (Main.modalCount || !Main.animations_enabled) {
            return false;
        }

        let type = actor.meta_window.get_window_type();
        
        if (types !== null) {
            if (!types.includes(type)) {
                return false;
            }
        }

        switch (type) {
            case Meta.WindowType.NORMAL:
                return this.desktop_effects_windows;
            case Meta.WindowType.DIALOG:
            case Meta.WindowType.MODAL_DIALOG:
                return this.desktop_effects_dialogs;
            case Meta.WindowType.MENU:
            case Meta.WindowType.DROPDOWN_MENU:
            case Meta.WindowType.POPUP_MENU:
            default:
                return false;
        }
    }

    _minimizeWindow(cinnamonwm, actor) {
        Main.soundManager.play('minimize');

        if (!this._shouldAnimate(actor) || this.desktop_effects_minimize_type == "none") {
            cinnamonwm.completed_minimize(actor);
            return;
        }
        this._minimizing.add(actor);

        switch (this.desktop_effects_minimize_type) {
            case "traditional":
            {
                let [success, geom] = actor.meta_window.get_icon_geometry();

                if (success) {
                    let rect = actor.meta_window.get_buffer_rect();

                    actor.set_position(rect.x, rect.y);
                    actor.set_scale(1.0, 1.0);

                    let xDest, yDest, xScale, yScale;
                    xDest = geom.x;
                    yDest = geom.y;
                    xScale = geom.width / actor.width;
                    yScale = geom.height / actor.height;

                    actor.ease({
                        scale_x: xScale,
                        scale_y: yScale,
                        x: xDest,
                        y: yDest,
                        duration: this.MINIMIZE_ANIMATION_TIME * this.window_effect_multiplier,
                        mode: Clutter.AnimationMode.EASE_IN_QUAD,
                        onStopped: () => this._minimizeWindowDone(cinnamonwm, actor),
                    });

                    return;
                }
            }
            case "fade":
            { // this fallback for 'traditional' also
                actor.set_scale(1.0, 1.0);
                actor.set_pivot_point(0.5, 0.5);

                actor.ease({
                    opacity: 0,
                    scale_x: 0.88,
                    scale_y: 0.88,
                    duration: this.MINIMIZE_ANIMATION_TIME * this.window_effect_multiplier,
                    mode: Clutter.AnimationMode.EASE_OUT_QUAD,
                    onStopped: () => this._minimizeWindowDone(cinnamonwm, actor),
                });

                return;
            }
            case "fly":
            {
                let xDest = actor.x;
                let workarea = actor.meta_window.get_work_area_current_monitor();

                let yDest = workarea.y + workarea.height;

                // The transition time set is the time if the animation starts/ends at the middle of the screen.
                // Scale it proportional to the actual distance so that the speed of all animations will be constant.
                let dist = Math.abs(actor.y - yDest);
                let time = this.MINIMIZE_ANIMATION_TIME * (dist / yDest * 2);

                actor.ease({
                    x: xDest,
                    y: yDest,
                    duration: time * this.window_effect_multiplier,
                    mode: Clutter.AnimationMode.EASE_IN_SINE,
                    onStopped: () => this._minimizeWindowDone(cinnamonwm, actor),
                });

                return;
            }
            default:
            {
                this._minimizeWindowDone(cinnamonwm, actor);
            }
        }
    }

    _minimizeWindowDone(cinnamonwm, actor) {
        if (this._minimizing.delete(actor)) {
            actor.remove_all_transitions()
            actor.set_pivot_point(0, 0);
            actor.set_scale(1.0, 1.0);
            actor.set_opacity(255);
            cinnamonwm.completed_minimize(actor);
        }
    }

    _unminimizeWindow(cinnamonwm, actor) {
        Main.soundManager.play('minimize');

        if (!this._shouldAnimate(actor) || this.desktop_effects_map_type == "none") {
            cinnamonwm.completed_unminimize(actor);
            return;
        }

        this._unminimizing.add(actor);

        switch (this.desktop_effects_map_type) {
            case "move": // this is really fade.. a move effect would essentially make it look like traditional,
                         // and it looks bad for things like restoring windows from a tray icon with multiple monitors.

            {
                actor.orig_opacity = actor.opacity;
                actor.set_pivot_point(0.5, 0.5);
                actor.scale_x = 0.94;
                actor.scale_y = 0.94;
                actor.opacity = 0;
                actor.show();

                actor.ease({
                    opacity: actor.orig_opacity,
                    scale_x: 1,
                    scale_y: 1,
                    duration: this.MAP_ANIMATION_TIME * this.window_effect_multiplier,
                    mode: Clutter.AnimationMode.EASE_OUT_QUAD,
                    onStopped: () => this._unminimizeWindowDone(cinnamonwm, actor),
                });

                return;
            }
            case "fly":
            {
                // buffer rect will have the true position of the window.
                // if we interrupted a minimize,, the actor's position won't match. If it doesn't,
                // we use that as its starting point, otherwise we use the monitor workarea.

                let rect = actor.meta_window.get_buffer_rect();
                let [xDest, yDest] = [rect.x, rect.y];

                let ySrc;

                if (actor.y === yDest) {
                    let workarea = actor.meta_window.get_work_area_current_monitor();
                    ySrc = workarea.y + workarea.height;
                } else {
                    ySrc = actor.y;
                }

                actor.set_position(xDest, ySrc);

                let dist = Math.abs(ySrc - yDest);
                let time = this.MAP_ANIMATION_TIME * (dist / ySrc * 2);

                actor.show();

                actor.ease({
                    x: xDest,
                    y: yDest,
                    duration: time * this.window_effect_multiplier,
                    mode: Clutter.AnimationMode.EASE_IN_SINE,
                    onStopped: () => this._unminimizeWindowDone(cinnamonwm, actor),
                });

                return;
            }
            case "traditional":
            {
                let [success, geom] = actor.meta_window.get_icon_geometry();
                if (success) {
                    let rect = actor.meta_window.get_buffer_rect();
                    let [xDest, yDest] = [rect.x, rect.y];

                    actor.set_position(geom.x, geom.y);
                    actor.set_scale(geom.width / actor.width,
                                    geom.height / actor.height);
                    actor.show();

                    actor.ease({
                        scale_x: 1.0,
                        scale_y: 1.0,
                        x: xDest,
                        y: yDest,
                        duration: this.MAP_ANIMATION_TIME * this.window_effect_multiplier,
                        mode: Clutter.AnimationMode.EASE_OUT_QUAD,
                        onStopped: () => this._unminimizeWindowDone(cinnamonwm, actor),
                    });
                } else { // fall-back effect. Same as map
                    actor.set_pivot_point(0.5, 0.5);
                    actor.scale_x = 0.94;
                    actor.scale_y = 0.94;
                    actor.opacity = 0;
                    actor.show();

                    actor.ease({
                        opacity: 255,
                        scale_x: 1.0,
                        scale_y: 1.0,
                        duration: this.MAP_ANIMATION_TIME * this.window_effect_multiplier,
                        mode: Clutter.AnimationMode.EASE_OUT_QUAD,
                        onStopped: () => this._unminimizeWindowDone(cinnamonwm, actor),
                    });
                }

                return;
            }
            default:
            {
                this._unminimizeWindowDone(cinnamonwm, actor);
            }
        }
    }

    _unminimizeWindowDone(cinnamonwm, actor) {
        if (this._unminimizing.delete(actor)) {
            actor.remove_all_transitions()
            actor.set_scale(1.0, 1.0);
            actor.set_opacity(255);
            actor.set_pivot_point(0, 0);

            cinnamonwm.completed_unminimize(actor);
        }
    }

    _sizeChangeWindow(cinnamonwm, actor, whichChange, oldFrameRect, _oldBufferRect) {
        switch (whichChange) {
            case Meta.SizeChange.MAXIMIZE:
                Main.soundManager.play('maximize');
                break;
            case Meta.SizeChange.UNMAXIMIZE:
                Main.soundManager.play('unmaximize');
                break;
            case Meta.SizeChange.TILE:
                Main.soundManager.play('tile');
                break;
        }

        if (!this._shouldAnimate(actor, [Meta.WindowType.NORMAL]) || !this.desktop_effects_size_change) {
            cinnamonwm.completed_size_change(actor);
            return;
        }

        if (oldFrameRect.width > 0 && oldFrameRect.height > 0)
            this._prepareAnimationInfo(cinnamonwm, actor, oldFrameRect, whichChange);
        else
            cinnamonwm.completed_size_change(actor);
    }

    _prepareAnimationInfo(cinnamonwm, actor, oldFrameRect, _change) {
        // Position a clone of the window on top of the old position,
        // while actor updates are frozen.
        let actorContent = Cinnamon.util_get_content_for_window_actor(actor, oldFrameRect);
        let actorClone = new St.Widget({ content: actorContent });
        actorClone.set_offscreen_redirect(Clutter.OffscreenRedirect.ALWAYS);
        actorClone.set_position(oldFrameRect.x, oldFrameRect.y);
        actorClone.set_size(oldFrameRect.width, oldFrameRect.height);

        if (this._clearSizeAnimationInfo(actor))
            this._cinnamonwm.completed_size_change(actor);

        let destroyId = actor.connect('destroy', () => {
            this._clearSizeAnimationInfo(actor);
        });

        this._resizePending.add(actor);
        actor.__animationInfo = { clone: actorClone,
                                  oldRect: oldFrameRect,
                                  destroyId };
    }

    _sizeChangedWindow(cinnamonwm, actor) {
        if (!actor.__animationInfo)
            return;
        if (this._resizing.has(actor))
            return;

        let actorClone = actor.__animationInfo.clone;
        let targetRect = actor.meta_window.get_frame_rect();
        let sourceRect = actor.__animationInfo.oldRect;

        let scaleX = targetRect.width / sourceRect.width;
        let scaleY = targetRect.height / sourceRect.height;

        this._resizePending.delete(actor);
        this._resizing.add(actor);

        Main.uiGroup.add_child(actorClone);

        // Now scale and fade out the clone
        actorClone.ease({
            x: targetRect.x,
            y: targetRect.y,
            scale_x: scaleX,
            scale_y: scaleY,
            opacity: 0,
            duration: this.SIZE_CHANGE_ANIMATION_TIME * this.window_effect_multiplier,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
        });

        actor.translation_x = -targetRect.x + sourceRect.x;
        actor.translation_y = -targetRect.y + sourceRect.y;

        // Now set scale the actor to size it as the clone.
        actor.scale_x = 1 / scaleX;
        actor.scale_y = 1 / scaleY;

        // Scale it to its actual new size
        actor.ease({
                scale_x: 1,
                scale_y: 1,
                translation_x: 0,
                translation_y: 0,
                duration: this.SIZE_CHANGE_ANIMATION_TIME * this.window_effect_multiplier,
                mode: Clutter.AnimationMode.EASE_OUT_QUAD,
                onStopped: () => this._sizeChangeWindowDone(cinnamonwm, actor),
        });

        // Now unfreeze actor updates, to get it to the new size.
        // It's important that we don't wait until the animation is completed to
        // do this, otherwise our scale will be applied to the old texture size.
        cinnamonwm.completed_size_change(actor);
    }

    _clearSizeAnimationInfo(actor) {
        if (actor.__animationInfo) {
            actor.__animationInfo.clone.destroy();
            actor.disconnect(actor.__animationInfo.destroyId);
            delete actor.__animationInfo;
            return true;
        }
        return false;
    }

    _sizeChangeWindowDone(cinnamonwm, actor) {
        if (this._resizing.delete(actor)) {
            actor.remove_all_transitions();
            actor.scale_x = 1.0;
            actor.scale_y = 1.0;
            actor.translation_x = 0;
            actor.translation_y = 0;
            this._clearSizeAnimationInfo(actor);
        }

        if (this._resizePending.delete(actor))
            this._cinnamonwm.completed_size_change(actor);
    }

    _filterKeybinding(shellwm, binding) {
        // TODO: We can use ActionModes to manage what keybindings are
        // available where. For now, this allows global keybindings in a non-
        // modal state. 

        return global.stage_input_mode !== Cinnamon.StageInputMode.NORMAL;
    }

    _hasAttachedDialogs(window, ignoreWindow) {
        let count = 0;
        window.foreach_transient(function(win) {
            if (win != ignoreWindow && win.is_attached_dialog())
                count++;
            return false;
        });
        return count != 0;
    }

    _checkDimming(window, ignoreWindow) {
        let shouldDim = this._hasAttachedDialogs(window, ignoreWindow);

        if (shouldDim && !window._dimmed) {
            window._dimmed = true;
            this._dimmedWindows.push(window);
            if (!Main.overview.visible)
                this._dimWindow(window, true);
        } else if (!shouldDim && window._dimmed) {
            window._dimmed = false;
            this._dimmedWindows = this._dimmedWindows.filter(function(win) {
                return win !== window;
            });
            if (!Main.overview.visible)
                this._undimWindow(window, true);
        }
    }

    _dimWindow(window, animate) {
        let actor = window.get_compositor_private();
        if (!actor)
            return;

        let dimmer = getWindowDimmer(actor);
        if (!dimmer)
            return;

        dimmer.setDimmed(true, animate);
    }

    _undimWindow(window, animate) {
        let actor = window.get_compositor_private();
        if (!actor)
            return;

        let dimmer = getWindowDimmer(actor);
        if (!dimmer)
            return;

        dimmer.setDimmed(false, animate);
    }

    _mapWindow(cinnamonwm, actor) {
        actor._windowType = actor.meta_window.get_window_type();
        actor._notifyWindowTypeSignalId =
            actor.meta_window.connect('notify::window-type', () => {
                let type = actor.meta_window.get_window_type();
                if (type === actor._windowType)
                    return;
                if (type === Meta.WindowType.MODAL_DIALOG ||
                    actor._windowType === Meta.WindowType.MODAL_DIALOG) {
                    let parent = actor.get_meta_window().get_transient_for();
                    if (parent)
                        this._checkDimming(parent);
                }

                actor._windowType = type;
            });
        actor.meta_window.connect('unmanaged', window => {
            let parent = window.get_transient_for();
            if (parent)
                this._checkDimming(parent);
        });

        if (actor._windowType === Meta.WindowType.NORMAL) {
            Main.soundManager.play('map');
        }

        if (actor.meta_window.is_attached_dialog()) {
            this._checkDimming(actor.get_meta_window().get_transient_for());
        }

        if (!this._shouldAnimate(actor) || this.desktop_effects_map_type == "none") {
            cinnamonwm.completed_map(actor);
            return;
        }

        this._mapping.add(actor);

        switch (this.desktop_effects_map_type) {
            case "traditional":
            {
                actor.orig_opacity = actor.opacity;
                actor.set_pivot_point(0.5, 0.5);
                actor.x -= 1;
                actor.scale_x = 0.94;
                actor.scale_y = 0.94;
                actor.opacity = 0;
                actor.show();

                actor.ease({
                    opacity: actor.orig_opacity,
                    scale_x: 1,
                    scale_y: 1,
                    x: actor.x + 1,
                    duration: this.MAP_ANIMATION_TIME * this.window_effect_multiplier,
                    mode: Clutter.AnimationMode.EASE_OUT_QUAD,
                    onStopped: () => this._mapWindowDone(cinnamonwm, actor),
                });

                return;
            }
            case "move":
            {
                let [width, height] = actor.get_size();
                let [xDest, yDest] = actor.get_position();
                let [xSrc, ySrc] = global.get_pointer();

                actor.set_position(xSrc, ySrc);
                actor.set_scale(0, 0);
                actor.show();

                actor.ease({
                    scale_x: 1.0,
                    scale_y: 1.0,
                    x: xDest,
                    y: yDest,
                    duration: this.MAP_ANIMATION_TIME * this.window_effect_multiplier,
                    mode: Clutter.AnimationMode.EASE_OUT_QUAD,
                    onStopped: () => this._mapWindowDone(cinnamonwm, actor),
                });

                return;
            }
            case "fly":
            {
                let ySrc = global.stage.get_height();
                let yDest = actor.y;

                actor.set_position(actor.x, ySrc);

                // The transition time set is the time if the animation starts/ends at the middle of the screen.
                // Scale it proportional to the actual distance so that the speed of all animations will be constant.
                let dist = Math.abs(ySrc - yDest);
                let time = this.MAP_ANIMATION_TIME * (dist / ySrc * 2);

                actor.show();

                actor.ease({
                    y: yDest,
                    duration: time * this.window_effect_multiplier,
                    mode: Clutter.AnimationMode.EASE_IN_SINE,
                    onStopped: () => this._mapWindowDone(cinnamonwm, actor),
                });

                return;
            }
            default:
            {
                this._mapWindowDone(cinnamonwm, actor);
            }
        }
    }

    _mapWindowDone(cinnamonwm, actor) {
        if (this._mapping.delete(actor)) {
            actor.remove_all_transitions()
            actor.opacity = 255;
            actor.set_pivot_point(0, 0);
            actor.scale_y = 1;
            actor.scale_x = 1;
            cinnamonwm.completed_map(actor);
        }
    }

    _destroyWindow(cinnamonwm, actor) {
        let window = actor.meta_window;
        if (actor._notifyWindowTypeSignalId > 0) {
            window.disconnect(actor._notifyWindowTypeSignalId);
            actor._notifyWindowTypeSignalId = 0;
        }
        if (window._dimmed) {
            this._dimmedWindows =
                this._dimmedWindows.filter(win => win != window);
        }

        if (actor.meta_window.window_type === Meta.WindowType.NORMAL) {
            Main.soundManager.play('close');
        }

        if (window.is_attached_dialog())
            this._checkDimming(window.get_transient_for(), window);

        if (window.minimized) {
            cinnamonwm.completed_destroy(actor);
            return;
        }

        let types = [Meta.WindowType.NORMAL,
                     Meta.WindowType.DIALOG,
                     Meta.WindowType.MODAL_DIALOG];

        if (!this._shouldAnimate(actor, types) || this.desktop_effects_close_type === "none") {
            cinnamonwm.completed_destroy(actor);
            return;
        }

        this._destroying.add(actor);

        switch (this.desktop_effects_close_type) {
            case "fly":
            {
                let [xSrc, ySrc] = actor.get_position();

                let workarea = actor.meta_window.get_work_area_current_monitor();
                let yDest = workarea.y + workarea.height;
                // The transition time set is the time if the animation starts/ends at the middle of the screen.
                // Scale it proportional to the actual distance so that the speed of all animations will be constant.
                let dist = Math.abs(ySrc - yDest);
                let time = this.DESTROY_ANIMATION_TIME * (dist / yDest * 2);

                actor.ease({
                    y: yDest,
                    duration: time * this.window_effect_multiplier,
                    mode: Clutter.AnimationMode.EASE_IN_SINE,
                    onStopped: () => this._destroyWindowDone(cinnamonwm, actor),
                });

                return;
            }
            case "traditional":
            {
                switch (actor.meta_window.window_type) {
                    case Meta.WindowType.NORMAL:
                    case Meta.WindowType.MODAL_DIALOG:
                    case Meta.WindowType.DIALOG:
                    {
                        actor.set_pivot_point(0.5, 0.5);

                        if (window.is_attached_dialog()) {
                            let parent = window.get_transient_for();
                            actor._parentDestroyId = parent.connect('unmanaged', () => {
                                actor.remove_all_transitions();
                                this._destroyWindowDone(cinnamonwm, actor);
                            });
                        }

                        actor.ease({
                            opacity: 0,
                            scale_x: 0.88,
                            scale_y: 0.88,
                            duration: this.DESTROY_ANIMATION_TIME * this.window_effect_multiplier,
                            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
                            onStopped: () => this._destroyWindowDone(cinnamonwm, actor),
                        });

                        return;
                    }
                    default:
                    {
                        this._destroyWindowDone(cinnamonwm, actor);
                    }
                }
            }
            default:
            {
                this._destroyWindowDone(cinnamonwm, actor);
            }
        }
    }

    _destroyWindowDone(cinnamonwm, actor) {
        if (this._destroying.delete(actor)) {
            const parent = actor.get_meta_window()?.get_transient_for();
            if (parent && actor._parentDestroyId) {
                parent.disconnect(actor._parentDestroyId);
                actor._parentDestroyId = 0;
            }
            cinnamonwm.completed_destroy(actor);
        }
    }

    _switchWorkspace(cinnamonwm, from, to, direction) {
        if (!Main.animations_enabled || Main.modalCount) {
            this.showWorkspaceOSD();
            cinnamonwm.completed_switch_workspace();
            return;
        }

        Main.soundManager.play('switch');
        this.showWorkspaceOSD();

        let windows = global.get_window_actors();

        /* @direction is the direction that the "camera" moves, so the
         * screen contents have to move one screen's worth in the
         * opposite direction.
         */
        let xDest = 0, yDest = 0;
        let {display, screen_width, screen_height} = global;
        let {focus_window} = display;
        let grabOp = display.get_grab_op();


        if (direction === Meta.MotionDirection.UP ||
            direction === Meta.MotionDirection.UP_LEFT ||
            direction === Meta.MotionDirection.UP_RIGHT)
            yDest = screen_height;
        else if (direction === Meta.MotionDirection.DOWN ||
            direction === Meta.MotionDirection.DOWN_LEFT ||
            direction === Meta.MotionDirection.DOWN_RIGHT)
            yDest = -screen_height;

        if (direction === Meta.MotionDirection.LEFT ||
            direction === Meta.MotionDirection.UP_LEFT ||
            direction === Meta.MotionDirection.DOWN_LEFT)
            xDest = screen_width;
        else if (direction === Meta.MotionDirection.RIGHT ||
                 direction === Meta.MotionDirection.UP_RIGHT ||
                 direction === Meta.MotionDirection.DOWN_RIGHT)
            xDest = -screen_width;

        let from_windows = new Set();
        let to_windows = new Set();
        let kill_id = 0;

        let cleanup_window_effect = (window, hide=false) => {
            window.remove_all_transitions();
            window.set_position(window.origX, window.origY);
            window.origX = undefined;
            window.origY = undefined;

            if (hide) {
                window.hide();
            }
        }

        let finish_switch_workspace = (actor) =>
        {
            if (to_windows.delete(actor)) {
                cleanup_window_effect(actor);
            }
            else
            if (from_windows.delete(actor)) {
                cleanup_window_effect(actor, true);
            };

            if (to_windows.size === 0 && from_windows.size === 0) {
                if (kill_id > 0) {
                    this._cinnamonwm.disconnect(kill_id);
                    kill_id = 0;

                    cinnamonwm.completed_switch_workspace();
                }
            }
        };

        for (let i = 0; i < windows.length; i++) {
            let window = windows[i];
            let {meta_window} = window;

            if (!meta_window.showing_on_its_workspace())
                continue;

            // Muffin 5.2 window.showing_on_its_workspace() no longer
            // ends up filtering the desktop window (If I re-add it, it
            // breaks things elsewhere that rely on the new behavior).
            if (meta_window.get_window_type() === Meta.WindowType.DESKTOP ||
                meta_window.get_window_type() === Meta.WindowType.OVERRIDE_OTHER) {
                continue;
            }

            if (meta_window.is_on_all_workspaces()) {
                continue;
            }

            if ((meta_window === this._movingWindow) ||
                ((grabOp === Meta.GrabOp.MOVING ||
                  grabOp === Meta.GrabOp.KEYBOARD_MOVING)
                 && meta_window === focus_window)) {
                /* We are moving this window to the other workspace. In fact,
                 * it is already on the other workspace, so it is hidden. We
                 * force it to show and then don't animate it, so it stays
                 * there while other windows move. */
                window.show_all();
                this._movingWindow = undefined;
            } else if (window.get_workspace() === from) {
                if (window.origX == undefined) {
                    window.origX = window.x;
                    window.origY = window.y;
                }
                from_windows.add(window);
                window.ease({
                    x: window.origX + xDest,
                    y: window.origY + yDest,
                    duration: this.WORKSPACE_ANIMATION_TIME * this.window_effect_multiplier,
                    mode: Clutter.AnimationMode.EASE_IN_OUT_QUAD,
                    onComplete: () => finish_switch_workspace(window)
                });
            } else if (window.get_workspace() === to) {
                if (window.origX == undefined) {
                    window.origX = window.x;
                    window.origY = window.y;
                    window.set_position(window.origX - xDest, window.origY - yDest);
                }
                to_windows.add(window);
                window.show_all();
                window.ease({
                    x: window.origX,
                    y: window.origY,
                    duration: this.WORKSPACE_ANIMATION_TIME * this.window_effect_multiplier,
                    mode: Clutter.AnimationMode.EASE_IN_OUT_QUAD,
                    onComplete: () => finish_switch_workspace(window)
                });
            }
        }

        if (to_windows.size === 0 && from_windows.size === 0) {
            this._cinnamonwm.completed_switch_workspace();
            return;
        }

        kill_id = this._cinnamonwm.connect('kill-switch-workspace', cinnamonwm => {
            let iter = to_windows.forEach((actor) => {
                cleanup_window_effect(actor);
            });
            iter = from_windows.forEach((actor) => {
                cleanup_window_effect(actor, true);
            });

            to_windows.clear();
            from_windows.clear();

            if (kill_id > 0) {
                this._cinnamonwm.disconnect(kill_id);
                kill_id = 0;
            }

            cinnamonwm.completed_switch_workspace();
        });
    }

    _showTilePreview(cinnamonwm, window, tileRect, monitorIndex) {
        // Suppress Muffin's native tile-preview ghost while auto-tiling is active.
        if (this.wm_settings.get_boolean('auto-tile'))
            return;
        if (!this._tilePreview)
            this._tilePreview = new TilePreview();
        this._tilePreview.show(window, tileRect, monitorIndex, Main.animations_enabled, this.TILE_PREVIEW_ANIMATION_TIME * this.window_effect_multiplier);
    }

    _hideTilePreview(cinnamonwm) {
        if (!this._tilePreview)
            return;
        this._tilePreview.hide();
    }

    showWorkspaceOSD() {
        if (global.settings.get_boolean('workspace-osd-visible')) {
            let currentWorkspaceIndex = global.workspace_manager.get_active_workspace_index();
            if (this.wm_settings.get_boolean('workspaces-only-on-primary')) {
                this._showWorkspaceOSDForMonitor(Main.layoutManager.primaryMonitor.index, currentWorkspaceIndex);
            } else {
                for (let i = 0; i < Main.layoutManager.monitors.length; i++) {
                    this._showWorkspaceOSDForMonitor(i, currentWorkspaceIndex);
                }
            }
        }
    }

    _showWorkspaceOSDForMonitor(index, currentWorkspaceIndex) {
        if (this._workspaceOsds[index] === undefined) {
            let osd = new WorkspaceOsd.WorkspaceOsd(index);
            this._workspaceOsds[index] = osd;
            osd.connect('destroy', () => {
                this._workspaceOsds[index] = undefined;
            });
        }

        let text = Main.getWorkspaceName(currentWorkspaceIndex);
        this._workspaceOsds[index].display(currentWorkspaceIndex, text);
    }

    _showWindowMenu(cinnamonwm, window, menu, rect) {
        this._windowMenuManager.showWindowMenuForWindow(window, menu, rect);
    }

    _createAppSwitcher(binding) {
        if (AppSwitcher.getWindowsForBinding(binding).length === 0) return;

        switch (global.settings.get_string('alttab-switcher-style')) {
            case 'coverflow':
                new CoverflowSwitcher(binding);
                break;
            case 'timeline':
                new TimelineSwitcher(binding);
                break;
            default:
                new ClassicSwitcher(binding);
        }
    }

    _startAppSwitcher(display, window, binding) {
        this._createAppSwitcher(binding);
    }

    _shiftWindowToWorkspace(window, direction) {
        if (window.window_type === Meta.WindowType.DESKTOP) {
            return;
        }
        this._movingWindow = window;
        let workspace = global.workspace_manager.get_active_workspace().get_neighbor(direction);
        if (workspace != global.workspace_manager.get_active_workspace()) {
            window.change_workspace(workspace);
            workspace.activate_with_focus(window, global.get_current_time());
        }
    }

    _moveWindowToWorkspaceLeft(display, window, binding) {
        this._shiftWindowToWorkspace(window, Meta.MotionDirection.LEFT);
    }

    _moveWindowToWorkspaceRight(display, window, binding) {
        this._shiftWindowToWorkspace(window, Meta.MotionDirection.RIGHT);
    }

    moveToWorkspace(workspace, direction_hint) {
        let active = global.workspace_manager.get_active_workspace();
        if (workspace != active) {
            if (direction_hint)
                workspace.activate_with_direction_hint(direction_hint, global.get_current_time());
            else
                workspace.activate(global.get_current_time());
        }
    }

    _showWorkspaceSwitcher(display, window, binding) {
        let bindingName = binding.get_name();
        if (bindingName === 'switch-to-workspace-up') {
            Main.expo.toggle();
            return;
        }
        if (bindingName === 'switch-to-workspace-down') {
            Main.overview.toggle();
            return;
        }

        if (global.workspace_manager.n_workspaces === 1)
            return;

        if (bindingName === 'switch-to-workspace-left') {
            this.actionMoveWorkspaceLeft();
        } else if (bindingName === 'switch-to-workspace-right') {
            this.actionMoveWorkspaceRight();
        }
    }

    actionMoveWorkspaceLeft() {
        let active = global.workspace_manager.get_active_workspace();
        let neighbor = active.get_neighbor(Meta.MotionDirection.LEFT)
        if (active != neighbor) {
            this.moveToWorkspace(neighbor, Meta.MotionDirection.LEFT);
        }
    }

    actionMoveWorkspaceRight() {
        let active = global.workspace_manager.get_active_workspace();
        let neighbor = active.get_neighbor(Meta.MotionDirection.RIGHT)
        if (active != neighbor) {
            this.moveToWorkspace(neighbor, Meta.MotionDirection.RIGHT);
        }
    }

    actionMoveWorkspaceUp() {
        global.workspace_manager.get_active_workspace().get_neighbor(Meta.MotionDirection.UP).activate(global.get_current_time());
    }

    actionMoveWorkspaceDown() {
        global.workspace_manager.get_active_workspace().get_neighbor(Meta.MotionDirection.DOWN).activate(global.get_current_time());
    }

    actionFlipWorkspaceLeft() {
        let active = global.workspace_manager.get_active_workspace();
        let neighbor = active.get_neighbor(Meta.MotionDirection.LEFT);
        if (active != neighbor) {
            neighbor.activate(global.get_current_time());
            let [x, y, mods] = global.get_pointer();
            global.set_pointer(global.screen_width - 10, y);
        }
    }

    actionFlipWorkspaceRight() {
        let active = global.workspace_manager.get_active_workspace();
        let neighbor = active.get_neighbor(Meta.MotionDirection.RIGHT);
        if (active != neighbor) {
            neighbor.activate(global.get_current_time());
            let [x, y, mods] = global.get_pointer();
            global.set_pointer(10, y);
        }
    }

    _showResizePopup(display, show, rect, displayW, displayH) {
        if (show) {
            if (!this._resizePopup)
                this._resizePopup = new ResizePopup();

            this._resizePopup.set(rect, displayW, displayH);
        } else {
            if (!this._resizePopup)
                return;

            this._resizePopup.destroy();
            this._resizePopup = null;
        }
    }

    _createCloseDialog(cinnamonwm, window) {
        return new CloseDialog.CloseDialog(window);
    }

    _confirmDisplayChange() {
        let dialog = new DisplayChangeDialog(this._cinnamonwm);
        dialog.open();
    }
    onSettingsChanged(settings, key, data=null) {
        if (key === "desktop-effects-workspace") {
            Main.updateAnimationsEnabled();
        }

        this.desktop_effects_windows = Main.animations_enabled && global.settings.get_boolean("desktop-effects");
        this.desktop_effects_menus = Main.animations_enabled && global.settings.get_boolean("desktop-effects-on-menus");
        this.desktop_effects_dialogs = Main.animations_enabled && global.settings.get_boolean("desktop-effects-on-dialogs");
        this.desktop_effects_size_change = this.desktop_effects_windows && global.settings.get_boolean("desktop-effects-change-size");

        this.desktop_effects_close_type = global.settings.get_string("desktop-effects-close");
        this.desktop_effects_map_type = global.settings.get_string("desktop-effects-map");
        this.desktop_effects_minimize_type = global.settings.get_string("desktop-effects-minimize");

        this.window_effect_multiplier = WINDOW_ANIMATION_TIME_MULTIPLIERS[global.settings.get_int("window-effect-speed")];
    }

    _shouldAnimate(actor, types=null) {
        // Check if system is in modal state or in software rendering
        if (Main.modalCount || !Main.animations_enabled) {
            return false;
        }

        let type = actor.meta_window.get_window_type();
        
        if (types !== null) {
            if (!types.includes(type)) {
                return false;
            }
        }

        switch (type) {
            case Meta.WindowType.NORMAL:
                return this.desktop_effects_windows;
            case Meta.WindowType.DIALOG:
            case Meta.WindowType.MODAL_DIALOG:
                return this.desktop_effects_dialogs;
            case Meta.WindowType.MENU:
            case Meta.WindowType.DROPDOWN_MENU:
            case Meta.WindowType.POPUP_MENU:
            default:
                return false;
        }
    }

    _minimizeWindow(cinnamonwm, actor) {
        Main.soundManager.play('minimize');

        if (!this._shouldAnimate(actor) || this.desktop_effects_minimize_type == "none") {
            cinnamonwm.completed_minimize(actor);
            return;
        }
        this._minimizing.add(actor);

        switch (this.desktop_effects_minimize_type) {
            case "traditional":
            {
                let [success, geom] = actor.meta_window.get_icon_geometry();

                if (success) {
                    let rect = actor.meta_window.get_buffer_rect();

                    actor.set_position(rect.x, rect.y);
                    actor.set_scale(1.0, 1.0);

                    let xDest, yDest, xScale, yScale;
                    xDest = geom.x;
                    yDest = geom.y;
                    xScale = geom.width / actor.width;
                    yScale = geom.height / actor.height;

                    actor.ease({
                        scale_x: xScale,
                        scale_y: yScale,
                        x: xDest,
                        y: yDest,
                        duration: this.MINIMIZE_ANIMATION_TIME * this.window_effect_multiplier,
                        mode: Clutter.AnimationMode.EASE_IN_QUAD,
                        onStopped: () => this._minimizeWindowDone(cinnamonwm, actor),
                    });

                    return;
                }
            }
            case "fade":
            { // this fallback for 'traditional' also
                actor.set_scale(1.0, 1.0);
                actor.set_pivot_point(0.5, 0.5);

                actor.ease({
                    opacity: 0,
                    scale_x: 0.88,
                    scale_y: 0.88,
                    duration: this.MINIMIZE_ANIMATION_TIME * this.window_effect_multiplier,
                    mode: Clutter.AnimationMode.EASE_OUT_QUAD,
                    onStopped: () => this._minimizeWindowDone(cinnamonwm, actor),
                });

                return;
            }
            case "fly":
            {
                let xDest = actor.x;
                let workarea = actor.meta_window.get_work_area_current_monitor();

                let yDest = workarea.y + workarea.height;

                // The transition time set is the time if the animation starts/ends at the middle of the screen.
                // Scale it proportional to the actual distance so that the speed of all animations will be constant.
                let dist = Math.abs(actor.y - yDest);
                let time = this.MINIMIZE_ANIMATION_TIME * (dist / yDest * 2);

                actor.ease({
                    x: xDest,
                    y: yDest,
                    duration: time * this.window_effect_multiplier,
                    mode: Clutter.AnimationMode.EASE_IN_SINE,
                    onStopped: () => this._minimizeWindowDone(cinnamonwm, actor),
                });

                return;
            }
            default:
            {
                this._minimizeWindowDone(cinnamonwm, actor);
            }
        }
    }

    _minimizeWindowDone(cinnamonwm, actor) {
        if (this._minimizing.delete(actor)) {
            actor.remove_all_transitions()
            actor.set_pivot_point(0, 0);
            actor.set_scale(1.0, 1.0);
            actor.set_opacity(255);
            cinnamonwm.completed_minimize(actor);
        }
    }

    _unminimizeWindow(cinnamonwm, actor) {
        Main.soundManager.play('minimize');

        // Retile before the animation starts. The window is still hidden here,
        // so move_resize_frame sets the geometry with no animation race.
        // All tiled windows - including the one that expanded while this window
        // was minimized - are repositioned to the correct layout.
        if (this.wm_settings.get_boolean('auto-tile')) {
            let workspace = global.workspace_manager.get_active_workspace();
            if (workspace) this._autoTileWorkspace(workspace);
        }

        if (!this._shouldAnimate(actor) || this.desktop_effects_map_type == "none") {
            cinnamonwm.completed_unminimize(actor);
            return;
        }

        this._unminimizing.add(actor);

        switch (this.desktop_effects_map_type) {
            case "move": // this is really fade.. a move effect would essentially make it look like traditional,
                         // and it looks bad for things like restoring windows from a tray icon with multiple monitors.

            {
                actor.orig_opacity = actor.opacity;
                actor.set_pivot_point(0.5, 0.5);
                actor.scale_x = 0.94;
                actor.scale_y = 0.94;
                actor.opacity = 0;
                actor.show();

                actor.ease({
                    opacity: actor.orig_opacity,
                    scale_x: 1,
                    scale_y: 1,
                    duration: this.MAP_ANIMATION_TIME * this.window_effect_multiplier,
                    mode: Clutter.AnimationMode.EASE_OUT_QUAD,
                    onStopped: () => this._unminimizeWindowDone(cinnamonwm, actor),
                });

                return;
            }
            case "fly":
            {
                // buffer rect will have the true position of the window.
                // if we interrupted a minimize,, the actor's position won't match. If it doesn't,
                // we use that as its starting point, otherwise we use the monitor workarea.

                let rect = actor.meta_window.get_buffer_rect();
                let [xDest, yDest] = [rect.x, rect.y];

                let ySrc;

                if (actor.y === yDest) {
                    let workarea = actor.meta_window.get_work_area_current_monitor();
                    ySrc = workarea.y + workarea.height;
                } else {
                    ySrc = actor.y;
                }

                actor.set_position(xDest, ySrc);

                let dist = Math.abs(ySrc - yDest);
                let time = this.MAP_ANIMATION_TIME * (dist / ySrc * 2);

                actor.show();

                actor.ease({
                    x: xDest,
                    y: yDest,
                    duration: time * this.window_effect_multiplier,
                    mode: Clutter.AnimationMode.EASE_IN_SINE,
                    onStopped: () => this._unminimizeWindowDone(cinnamonwm, actor),
                });

                return;
            }
            case "traditional":
            {
                let [success, geom] = actor.meta_window.get_icon_geometry();
                if (success) {
                    let rect = actor.meta_window.get_buffer_rect();
                    let [xDest, yDest] = [rect.x, rect.y];

                    actor.set_position(geom.x, geom.y);
                    actor.set_scale(geom.width / actor.width,
                                    geom.height / actor.height);
                    actor.show();

                    actor.ease({
                        scale_x: 1.0,
                        scale_y: 1.0,
                        x: xDest,
                        y: yDest,
                        duration: this.MAP_ANIMATION_TIME * this.window_effect_multiplier,
                        mode: Clutter.AnimationMode.EASE_OUT_QUAD,
                        onStopped: () => this._unminimizeWindowDone(cinnamonwm, actor),
                    });
                } else { // fall-back effect. Same as map
                    actor.set_pivot_point(0.5, 0.5);
                    actor.scale_x = 0.94;
                    actor.scale_y = 0.94;
                    actor.opacity = 0;
                    actor.show();

                    actor.ease({
                        opacity: 255,
                        scale_x: 1.0,
                        scale_y: 1.0,
                        duration: this.MAP_ANIMATION_TIME * this.window_effect_multiplier,
                        mode: Clutter.AnimationMode.EASE_OUT_QUAD,
                        onStopped: () => this._unminimizeWindowDone(cinnamonwm, actor),
                    });
                }

                return;
            }
            default:
            {
                this._unminimizeWindowDone(cinnamonwm, actor);
            }
        }
    }

    _unminimizeWindowDone(cinnamonwm, actor) {
        if (this._unminimizing.delete(actor)) {
            actor.remove_all_transitions()
            actor.set_scale(1.0, 1.0);
            actor.set_opacity(255);
            actor.set_pivot_point(0, 0);

            cinnamonwm.completed_unminimize(actor);
        }
    }

    _sizeChangeWindow(cinnamonwm, actor, whichChange, oldFrameRect, _oldBufferRect) {
        switch (whichChange) {
            case Meta.SizeChange.MAXIMIZE:
                Main.soundManager.play('maximize');
                break;
            case Meta.SizeChange.UNMAXIMIZE:
                Main.soundManager.play('unmaximize');
                break;
            case Meta.SizeChange.TILE:
                Main.soundManager.play('tile');
                break;
        }

        if (!this._shouldAnimate(actor, [Meta.WindowType.NORMAL]) || !this.desktop_effects_size_change) {
            cinnamonwm.completed_size_change(actor);
            return;
        }

        if (oldFrameRect.width > 0 && oldFrameRect.height > 0)
            this._prepareAnimationInfo(cinnamonwm, actor, oldFrameRect, whichChange);
        else
            cinnamonwm.completed_size_change(actor);
    }

    _prepareAnimationInfo(cinnamonwm, actor, oldFrameRect, _change) {
        // Position a clone of the window on top of the old position,
        // while actor updates are frozen.
        let actorContent = Cinnamon.util_get_content_for_window_actor(actor, oldFrameRect);
        let actorClone = new St.Widget({ content: actorContent });
        actorClone.set_offscreen_redirect(Clutter.OffscreenRedirect.ALWAYS);
        actorClone.set_position(oldFrameRect.x, oldFrameRect.y);
        actorClone.set_size(oldFrameRect.width, oldFrameRect.height);

        if (this._clearSizeAnimationInfo(actor))
            this._cinnamonwm.completed_size_change(actor);

        let destroyId = actor.connect('destroy', () => {
            this._clearSizeAnimationInfo(actor);
        });

        this._resizePending.add(actor);
        actor.__animationInfo = { clone: actorClone,
                                  oldRect: oldFrameRect,
                                  destroyId };
    }

    _sizeChangedWindow(cinnamonwm, actor) {
        if (!actor.__animationInfo)
            return;
        if (this._resizing.has(actor))
            return;

        let actorClone = actor.__animationInfo.clone;
        let targetRect = actor.meta_window.get_frame_rect();
        let sourceRect = actor.__animationInfo.oldRect;

        let scaleX = targetRect.width / sourceRect.width;
        let scaleY = targetRect.height / sourceRect.height;

        this._resizePending.delete(actor);
        this._resizing.add(actor);

        Main.uiGroup.add_child(actorClone);

        // Now scale and fade out the clone
        actorClone.ease({
            x: targetRect.x,
            y: targetRect.y,
            scale_x: scaleX,
            scale_y: scaleY,
            opacity: 0,
            duration: this.SIZE_CHANGE_ANIMATION_TIME * this.window_effect_multiplier,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
        });

        actor.translation_x = -targetRect.x + sourceRect.x;
        actor.translation_y = -targetRect.y + sourceRect.y;

        // Now set scale the actor to size it as the clone.
        actor.scale_x = 1 / scaleX;
        actor.scale_y = 1 / scaleY;

        // Scale it to its actual new size
        actor.ease({
                scale_x: 1,
                scale_y: 1,
                translation_x: 0,
                translation_y: 0,
                duration: this.SIZE_CHANGE_ANIMATION_TIME * this.window_effect_multiplier,
                mode: Clutter.AnimationMode.EASE_OUT_QUAD,
                onStopped: () => this._sizeChangeWindowDone(cinnamonwm, actor),
        });

        // Now unfreeze actor updates, to get it to the new size.
        // It's important that we don't wait until the animation is completed to
        // do this, otherwise our scale will be applied to the old texture size.
        cinnamonwm.completed_size_change(actor);
    }

    _clearSizeAnimationInfo(actor) {
        if (actor.__animationInfo) {
            actor.__animationInfo.clone.destroy();
            actor.disconnect(actor.__animationInfo.destroyId);
            delete actor.__animationInfo;
            return true;
        }
        return false;
    }

    _sizeChangeWindowDone(cinnamonwm, actor) {
        if (this._resizing.delete(actor)) {
            actor.remove_all_transitions();
            actor.scale_x = 1.0;
            actor.scale_y = 1.0;
            actor.translation_x = 0;
            actor.translation_y = 0;
            this._clearSizeAnimationInfo(actor);
        }

        if (this._resizePending.delete(actor))
            this._cinnamonwm.completed_size_change(actor);
    }

    _filterKeybinding(shellwm, binding) {
        // TODO: We can use ActionModes to manage what keybindings are
        // available where. For now, this allows global keybindings in a non-
        // modal state. 

        return global.stage_input_mode !== Cinnamon.StageInputMode.NORMAL;
    }

    _hasAttachedDialogs(window, ignoreWindow) {
        let count = 0;
        window.foreach_transient(function(win) {
            if (win != ignoreWindow && win.is_attached_dialog())
                count++;
            return false;
        });
        return count != 0;
    }

    _checkDimming(window, ignoreWindow) {
        let shouldDim = this._hasAttachedDialogs(window, ignoreWindow);

        if (shouldDim && !window._dimmed) {
            window._dimmed = true;
            this._dimmedWindows.push(window);
            if (!Main.overview.visible)
                this._dimWindow(window, true);
        } else if (!shouldDim && window._dimmed) {
            window._dimmed = false;
            this._dimmedWindows = this._dimmedWindows.filter(function(win) {
                return win !== window;
            });
            if (!Main.overview.visible)
                this._undimWindow(window, true);
        }
    }

    _dimWindow(window, animate) {
        let actor = window.get_compositor_private();
        if (!actor)
            return;

        let dimmer = getWindowDimmer(actor);
        if (!dimmer)
            return;

        dimmer.setDimmed(true, animate);
    }

    _undimWindow(window, animate) {
        let actor = window.get_compositor_private();
        if (!actor)
            return;

        let dimmer = getWindowDimmer(actor);
        if (!dimmer)
            return;

        dimmer.setDimmed(false, animate);
    }

    _mapWindow(cinnamonwm, actor) {
        actor._windowType = actor.meta_window.get_window_type();
        actor._notifyWindowTypeSignalId =
            actor.meta_window.connect('notify::window-type', () => {
                let type = actor.meta_window.get_window_type();
                if (type === actor._windowType)
                    return;
                if (type === Meta.WindowType.MODAL_DIALOG ||
                    actor._windowType === Meta.WindowType.MODAL_DIALOG) {
                    let parent = actor.get_meta_window().get_transient_for();
                    if (parent)
                        this._checkDimming(parent);
                }

                actor._windowType = type;
            });
        actor.meta_window.connect('unmanaged', window => {
            let parent = window.get_transient_for();
            if (parent)
                this._checkDimming(parent);
        });

        if (actor._windowType === Meta.WindowType.NORMAL) {
            Main.soundManager.play('map');
        }

        if (actor.meta_window.is_attached_dialog()) {
            this._checkDimming(actor.get_meta_window().get_transient_for());
        }

        if (!this._shouldAnimate(actor) || this.desktop_effects_map_type == "none") {
            cinnamonwm.completed_map(actor);
            return;
        }

        this._mapping.add(actor);

        switch (this.desktop_effects_map_type) {
            case "traditional":
            {
                actor.orig_opacity = actor.opacity;
                actor.set_pivot_point(0.5, 0.5);
                actor.x -= 1;
                actor.scale_x = 0.94;
                actor.scale_y = 0.94;
                actor.opacity = 0;
                actor.show();

                actor.ease({
                    opacity: actor.orig_opacity,
                    scale_x: 1,
                    scale_y: 1,
                    x: actor.x + 1,
                    duration: this.MAP_ANIMATION_TIME * this.window_effect_multiplier,
                    mode: Clutter.AnimationMode.EASE_OUT_QUAD,
                    onStopped: () => this._mapWindowDone(cinnamonwm, actor),
                });

                return;
            }
            case "move":
            {
                let [width, height] = actor.get_size();
                let [xDest, yDest] = actor.get_position();
                let [xSrc, ySrc] = global.get_pointer();

                actor.set_position(xSrc, ySrc);
                actor.set_scale(0, 0);
                actor.show();

                actor.ease({
                    scale_x: 1.0,
                    scale_y: 1.0,
                    x: xDest,
                    y: yDest,
                    duration: this.MAP_ANIMATION_TIME * this.window_effect_multiplier,
                    mode: Clutter.AnimationMode.EASE_OUT_QUAD,
                    onStopped: () => this._mapWindowDone(cinnamonwm, actor),
                });

                return;
            }
            case "fly":
            {
                let ySrc = global.stage.get_height();
                let yDest = actor.y;

                actor.set_position(actor.x, ySrc);

                // The transition time set is the time if the animation starts/ends at the middle of the screen.
                // Scale it proportional to the actual distance so that the speed of all animations will be constant.
                let dist = Math.abs(ySrc - yDest);
                let time = this.MAP_ANIMATION_TIME * (dist / ySrc * 2);

                actor.show();

                actor.ease({
                    y: yDest,
                    duration: time * this.window_effect_multiplier,
                    mode: Clutter.AnimationMode.EASE_IN_SINE,
                    onStopped: () => this._mapWindowDone(cinnamonwm, actor),
                });

                return;
            }
            default:
            {
                this._mapWindowDone(cinnamonwm, actor);
            }
        }
    }

    _mapWindowDone(cinnamonwm, actor) {
        if (this._mapping.delete(actor)) {
            actor.remove_all_transitions()
            actor.opacity = 255;
            actor.set_pivot_point(0, 0);
            actor.scale_y = 1;
            actor.scale_x = 1;
            cinnamonwm.completed_map(actor);
        }
    }

    _destroyWindow(cinnamonwm, actor) {
        let window = actor.meta_window;
        if (actor._notifyWindowTypeSignalId > 0) {
            window.disconnect(actor._notifyWindowTypeSignalId);
            actor._notifyWindowTypeSignalId = 0;
        }
        if (window._dimmed) {
            this._dimmedWindows =
                this._dimmedWindows.filter(win => win != window);
        }

        if (actor.meta_window.window_type === Meta.WindowType.NORMAL) {
            Main.soundManager.play('close');
        }

        if (window.is_attached_dialog())
            this._checkDimming(window.get_transient_for(), window);

        if (window.minimized) {
            cinnamonwm.completed_destroy(actor);
            return;
        }

        let types = [Meta.WindowType.NORMAL,
                     Meta.WindowType.DIALOG,
                     Meta.WindowType.MODAL_DIALOG];

        if (!this._shouldAnimate(actor, types) || this.desktop_effects_close_type === "none") {
            cinnamonwm.completed_destroy(actor);
            return;
        }

        this._destroying.add(actor);

        switch (this.desktop_effects_close_type) {
            case "fly":
            {
                let [xSrc, ySrc] = actor.get_position();

                let workarea = actor.meta_window.get_work_area_current_monitor();
                let yDest = workarea.y + workarea.height;
                // The transition time set is the time if the animation starts/ends at the middle of the screen.
                // Scale it proportional to the actual distance so that the speed of all animations will be constant.
                let dist = Math.abs(ySrc - yDest);
                let time = this.DESTROY_ANIMATION_TIME * (dist / yDest * 2);

                actor.ease({
                    y: yDest,
                    duration: time * this.window_effect_multiplier,
                    mode: Clutter.AnimationMode.EASE_IN_SINE,
                    onStopped: () => this._destroyWindowDone(cinnamonwm, actor),
                });

                return;
            }
            case "traditional":
            {
                switch (actor.meta_window.window_type) {
                    case Meta.WindowType.NORMAL:
                    case Meta.WindowType.MODAL_DIALOG:
                    case Meta.WindowType.DIALOG:
                    {
                        actor.set_pivot_point(0.5, 0.5);

                        if (window.is_attached_dialog()) {
                            let parent = window.get_transient_for();
                            actor._parentDestroyId = parent.connect('unmanaged', () => {
                                actor.remove_all_transitions();
                                this._destroyWindowDone(cinnamonwm, actor);
                            });
                        }

                        actor.ease({
                            opacity: 0,
                            scale_x: 0.88,
                            scale_y: 0.88,
                            duration: this.DESTROY_ANIMATION_TIME * this.window_effect_multiplier,
                            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
                            onStopped: () => this._destroyWindowDone(cinnamonwm, actor),
                        });

                        return;
                    }
                    default:
                    {
                        this._destroyWindowDone(cinnamonwm, actor);
                    }
                }
            }
            default:
            {
                this._destroyWindowDone(cinnamonwm, actor);
            }
        }
    }

    _destroyWindowDone(cinnamonwm, actor) {
        if (this._destroying.delete(actor)) {
            const parent = actor.get_meta_window()?.get_transient_for();
            if (parent && actor._parentDestroyId) {
                parent.disconnect(actor._parentDestroyId);
                actor._parentDestroyId = 0;
            }
            cinnamonwm.completed_destroy(actor);
        }
    }

    _switchWorkspace(cinnamonwm, from, to, direction) {
        if (!Main.animations_enabled || Main.modalCount) {
            this.showWorkspaceOSD();
            cinnamonwm.completed_switch_workspace();
            return;
        }

        Main.soundManager.play('switch');
        this.showWorkspaceOSD();

        let windows = global.get_window_actors();

        /* @direction is the direction that the "camera" moves, so the
         * screen contents have to move one screen's worth in the
         * opposite direction.
         */
        let xDest = 0, yDest = 0;
        let {display, screen_width, screen_height} = global;
        let {focus_window} = display;
        let grabOp = display.get_grab_op();


        if (direction === Meta.MotionDirection.UP ||
            direction === Meta.MotionDirection.UP_LEFT ||
            direction === Meta.MotionDirection.UP_RIGHT)
            yDest = screen_height;
        else if (direction === Meta.MotionDirection.DOWN ||
            direction === Meta.MotionDirection.DOWN_LEFT ||
            direction === Meta.MotionDirection.DOWN_RIGHT)
            yDest = -screen_height;

        if (direction === Meta.MotionDirection.LEFT ||
            direction === Meta.MotionDirection.UP_LEFT ||
            direction === Meta.MotionDirection.DOWN_LEFT)
            xDest = screen_width;
        else if (direction === Meta.MotionDirection.RIGHT ||
                 direction === Meta.MotionDirection.UP_RIGHT ||
                 direction === Meta.MotionDirection.DOWN_RIGHT)
            xDest = -screen_width;

        let from_windows = new Set();
        let to_windows = new Set();
        let kill_id = 0;

        let cleanup_window_effect = (window, hide=false) => {
            window.remove_all_transitions();
            window.set_position(window.origX, window.origY);
            window.origX = undefined;
            window.origY = undefined;

            if (hide) {
                window.hide();
            }
        }

        let finish_switch_workspace = (actor) =>
        {
            if (to_windows.delete(actor)) {
                cleanup_window_effect(actor);
            }
            else
            if (from_windows.delete(actor)) {
                cleanup_window_effect(actor, true);
            };

            if (to_windows.size === 0 && from_windows.size === 0) {
                if (kill_id > 0) {
                    this._cinnamonwm.disconnect(kill_id);
                    kill_id = 0;

                    cinnamonwm.completed_switch_workspace();
                }
            }
        };

        for (let i = 0; i < windows.length; i++) {
            let window = windows[i];
            let {meta_window} = window;

            if (!meta_window.showing_on_its_workspace())
                continue;

            // Muffin 5.2 window.showing_on_its_workspace() no longer
            // ends up filtering the desktop window (If I re-add it, it
            // breaks things elsewhere that rely on the new behavior).
            if (meta_window.get_window_type() === Meta.WindowType.DESKTOP ||
                meta_window.get_window_type() === Meta.WindowType.OVERRIDE_OTHER) {
                continue;
            }

            if (meta_window.is_on_all_workspaces()) {
                continue;
            }

            if ((meta_window === this._movingWindow) ||
                ((grabOp === Meta.GrabOp.MOVING ||
                  grabOp === Meta.GrabOp.KEYBOARD_MOVING)
                 && meta_window === focus_window)) {
                /* We are moving this window to the other workspace. In fact,
                 * it is already on the other workspace, so it is hidden. We
                 * force it to show and then don't animate it, so it stays
                 * there while other windows move. */
                window.show_all();
                this._movingWindow = undefined;
            } else if (window.get_workspace() === from) {
                if (window.origX == undefined) {
                    window.origX = window.x;
                    window.origY = window.y;
                }
                from_windows.add(window);
                window.ease({
                    x: window.origX + xDest,
                    y: window.origY + yDest,
                    duration: this.WORKSPACE_ANIMATION_TIME * this.window_effect_multiplier,
                    mode: Clutter.AnimationMode.EASE_OUT_QUAD,
                    onComplete: () => finish_switch_workspace(window)
                });
            } else if (window.get_workspace() === to) {
                if (window.origX == undefined) {
                    window.origX = window.x;
                    window.origY = window.y;
                    window.set_position(window.origX - xDest, window.origY - yDest);
                }
                to_windows.add(window);
                window.show_all();
                window.ease({
                    x: window.origX,
                    y: window.origY,
                    duration: this.WORKSPACE_ANIMATION_TIME * this.window_effect_multiplier,
                    mode: Clutter.AnimationMode.EASE_OUT_QUAD,
                    onComplete: () => finish_switch_workspace(window)
                });
            }
        }

        if (to_windows.size === 0 && from_windows.size === 0) {
            this._cinnamonwm.completed_switch_workspace();
            return;
        }

        kill_id = this._cinnamonwm.connect('kill-switch-workspace', cinnamonwm => {
            let iter = to_windows.forEach((actor) => {
                cleanup_window_effect(actor);
            });
            iter = from_windows.forEach((actor) => {
                cleanup_window_effect(actor, true);
            });

            to_windows.clear();
            from_windows.clear();

            if (kill_id > 0) {
                this._cinnamonwm.disconnect(kill_id);
                kill_id = 0;
            }

            cinnamonwm.completed_switch_workspace();
        });
    }

    _showTilePreview(cinnamonwm, window, tileRect, monitorIndex) {
        // Suppress Muffin's native tile-preview ghost while auto-tiling is active.
        if (this.wm_settings.get_boolean('auto-tile'))
            return;
        if (!this._tilePreview)
            this._tilePreview = new TilePreview();
        this._tilePreview.show(window, tileRect, monitorIndex, Main.animations_enabled, this.TILE_PREVIEW_ANIMATION_TIME * this.window_effect_multiplier);
    }

    _hideTilePreview(cinnamonwm) {
        if (!this._tilePreview)
            return;
        this._tilePreview.hide();
    }

    showWorkspaceOSD() {
        if (global.settings.get_boolean('workspace-osd-visible')) {
            let currentWorkspaceIndex = global.workspace_manager.get_active_workspace_index();
            if (this.wm_settings.get_boolean('workspaces-only-on-primary')) {
                this._showWorkspaceOSDForMonitor(Main.layoutManager.primaryMonitor.index, currentWorkspaceIndex);
            } else {
                for (let i = 0; i < Main.layoutManager.monitors.length; i++) {
                    this._showWorkspaceOSDForMonitor(i, currentWorkspaceIndex);
                }
            }
        }
    }

    _showWorkspaceOSDForMonitor(index, currentWorkspaceIndex) {
        if (this._workspaceOsds[index] === undefined) {
            let osd = new WorkspaceOsd.WorkspaceOsd(index);
            this._workspaceOsds[index] = osd;
            osd.connect('destroy', () => {
                this._workspaceOsds[index] = undefined;
            });
        }

        let text = Main.getWorkspaceName(currentWorkspaceIndex);
        this._workspaceOsds[index].display(currentWorkspaceIndex, text);
    }

    _showWindowMenu(cinnamonwm, window, menu, rect) {
        this._windowMenuManager.showWindowMenuForWindow(window, menu, rect);
    }

    _createAppSwitcher(binding) {
        if (AppSwitcher.getWindowsForBinding(binding).length === 0) return;

        switch (global.settings.get_string('alttab-switcher-style')) {
            case 'coverflow':
                new CoverflowSwitcher(binding);
                break;
            case 'timeline':
                new TimelineSwitcher(binding);
                break;
            default:
                new ClassicSwitcher(binding);
        }
    }

    _startAppSwitcher(display, window, binding) {
        this._createAppSwitcher(binding);
    }

    _shiftWindowToWorkspace(window, direction) {
        if (window.window_type === Meta.WindowType.DESKTOP) {
            return;
        }
        this._movingWindow = window;
        let workspace = global.workspace_manager.get_active_workspace().get_neighbor(direction);
        if (workspace != global.workspace_manager.get_active_workspace()) {
            window.change_workspace(workspace);
            workspace.activate_with_focus(window, global.get_current_time());
        }
    }

    _moveWindowToWorkspaceLeft(display, window, binding) {
        this._shiftWindowToWorkspace(window, Meta.MotionDirection.LEFT);
    }

    _moveWindowToWorkspaceRight(display, window, binding) {
        this._shiftWindowToWorkspace(window, Meta.MotionDirection.RIGHT);
    }

    moveToWorkspace(workspace, direction_hint) {
        let active = global.workspace_manager.get_active_workspace();
        if (workspace != active) {
            if (direction_hint)
                workspace.activate_with_direction_hint(direction_hint, global.get_current_time());
            else
                workspace.activate(global.get_current_time());
        }
    }

    _showWorkspaceSwitcher(display, window, binding) {
        let bindingName = binding.get_name();
        if (bindingName === 'switch-to-workspace-up') {
            Main.expo.toggle();
            return;
        }
        if (bindingName === 'switch-to-workspace-down') {
            Main.overview.toggle();
            return;
        }

        if (global.workspace_manager.n_workspaces === 1)
            return;

        if (bindingName === 'switch-to-workspace-left') {
            this.actionMoveWorkspaceLeft();
        } else if (bindingName === 'switch-to-workspace-right') {
            this.actionMoveWorkspaceRight();
        }
    }

    actionMoveWorkspaceLeft() {
        let active = global.workspace_manager.get_active_workspace();
        let neighbor = active.get_neighbor(Meta.MotionDirection.LEFT)
        if (active != neighbor) {
            this.moveToWorkspace(neighbor, Meta.MotionDirection.LEFT);
        }
    }

    actionMoveWorkspaceRight() {
        let active = global.workspace_manager.get_active_workspace();
        let neighbor = active.get_neighbor(Meta.MotionDirection.RIGHT)
        if (active != neighbor) {
            this.moveToWorkspace(neighbor, Meta.MotionDirection.RIGHT);
        }
    }

    actionMoveWorkspaceUp() {
        global.workspace_manager.get_active_workspace().get_neighbor(Meta.MotionDirection.UP).activate(global.get_current_time());
    }

    actionMoveWorkspaceDown() {
        global.workspace_manager.get_active_workspace().get_neighbor(Meta.MotionDirection.DOWN).activate(global.get_current_time());
    }

    actionFlipWorkspaceLeft() {
        let active = global.workspace_manager.get_active_workspace();
        let neighbor = active.get_neighbor(Meta.MotionDirection.LEFT);
        if (active != neighbor) {
            neighbor.activate(global.get_current_time());
            let [x, y, mods] = global.get_pointer();
            global.set_pointer(global.screen_width - 10, y);
        }
    }

    actionFlipWorkspaceRight() {
        let active = global.workspace_manager.get_active_workspace();
        let neighbor = active.get_neighbor(Meta.MotionDirection.RIGHT);
        if (active != neighbor) {
            neighbor.activate(global.get_current_time());
            let [x, y, mods] = global.get_pointer();
            global.set_pointer(10, y);
        }
    }

    _showResizePopup(display, show, rect, displayW, displayH) {
        if (show) {
            if (!this._resizePopup)
                this._resizePopup = new ResizePopup();

            this._resizePopup.set(rect, displayW, displayH);
        } else {
            if (!this._resizePopup)
                return;

            this._resizePopup.destroy();
            this._resizePopup = null;
        }
    }

    _createCloseDialog(cinnamonwm, window) {
        return new CloseDialog.CloseDialog(window);
    }

    _confirmDisplayChange() {
        let dialog = new DisplayChangeDialog(this._cinnamonwm);
        dialog.open();
    }
};
