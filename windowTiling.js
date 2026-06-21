// -*- mode: js; js-indent-level: 4; indent-tabs-mode: nil -*-

const Clutter = imports.gi.Clutter;
const Meta = imports.gi.Meta;
const St = imports.gi.St;
const Gio = imports.gi.Gio;
const GLib = imports.gi.GLib;
const Pango = imports.gi.Pango;
const Main = imports.ui.main;

var WindowTiling = class WindowTiling {

    constructor(wm, wm_settings) {
        this._wm = wm;
        this.wm_settings = wm_settings;
        this._autoTileWindowAddedId = null;
        this._autoTileWindowRemovedId = null;
        this._autoTileResizeIds = [];
        this._autoTileSavedRects = null;
        this._autoTileOriginalRects = null;
        this._autoTileWinById = null;
        this._autoTileResizing = false;
        this._autoTileUserResizingId = null;
        this._autoTileWinMinSizes = new Map();
        this._autoTileGrabOpBeginId = null;
        this._autoTileGrabOpEndId = null;
        this._autoTileDragHandles = [];
        this._autoTileDraggableBorderWas = null;
        this._autoTilePlacementModeWas = null;
        this._autoTileCursorPollId = null;
        this._autoTileKeybindingsRegistered = false;
        this._autoTile2Layout = 'vertical';
        this._autoTile3Mirrored = false;
        this._autoTileColumnsMode = false;
        this._autoTileStripe = null;   
        this._autoTileStripeConfirming = false; 
        this._autoTileSlotOrder = null;
        this._autoTileSlotOrderByWs = new Map();
        this._autoTileEdgeTilingWas = null;
        this._autoTileEdgeTilingListenerId = null;
        this._autoTileWsSwitchPending = false;
        this._autoTileWsSwitchGen = 0;
        this._autoTileDragSignalIds = [];
        this._autoTileDragPollId = null;
        this._autoTileDraggingWin = null;
        this._autoTileSwapDragWin = null;
        this._autoTileSwapDragOrigRect = null;
        this._autoTileSwapDropOverlay = null;
        this._autoTileSwapDropTarget = null;
        this._autoTileSwapPollId = null;
        this._autoTileSwapInProgress = false;
        this._autoTileResizeDebounceId = null;
        this._autoTileExternalResetDebounceId = null;
        this._autoTileMaximizeBindingWas = null; 
        this._autoTile2Pos = 0; 
        this._autoTileCycleIdx = new Map(); 
        this._autoTileCyclePending = false;  
        this._autoTileCycleEndId = null; 
        this._autoTilePreviewWin = null; 
        this._autoTilePreviewIdx = -1;
        this._autoTilePreviewRect = null;
        this._autoTilePreviewPool = null;
        this._autoTilePreviewAnchorWin = null;

        this._tileBorderActors = new Map();
        this._tileBorderSuppressed = false; 
        this._tileBorderNewWindowPending = false;
        this._tileBorderFocusId = global.display.connect(
            'notify::focus-window', this._onFocusWindowChanged.bind(this));
        this.wm_settings.connect('changed::auto-tile-border-width',
            this._refreshTileBorder.bind(this));
        this.wm_settings.connect('changed::auto-tile-accent-color',
            this._refreshTileBorder.bind(this));

        this._autoTileSettingId = this.wm_settings.connect('changed::auto-tile',
            this._onAutoTileSettingChanged.bind(this));
        this.wm_settings.connect('changed::auto-tile-columns', () => {
            if (this.wm_settings.get_boolean('auto-tile')) {
                this._autoTileColumnsMode = this.wm_settings.get_boolean('auto-tile-columns');
                let workspace = global.workspace_manager.get_active_workspace();
                if (workspace) this._autoTileWorkspace(workspace);
            }
        });
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

        GLib.timeout_add(GLib.PRIORITY_DEFAULT, 500, () => {
            this._onAutoTileSettingChanged(this.wm_settings, 'auto-tile');
            this._autoTileColumnsMode = this.wm_settings.get_boolean('auto-tile-columns');
            return GLib.SOURCE_REMOVE;
        });
    }

    suppressBorder() {
        this._tileBorderSuppressed = true;
        this._hideAllTileBorders();
    }

    onWindowDestroyed() {
        if (this._autoTilePendingRetileWs) {
            let ws = this._autoTilePendingRetileWs;
            this._autoTilePendingRetileWs = null;
            GLib.timeout_add(GLib.PRIORITY_DEFAULT, 100, () => {
                this._autoTileWorkspace(ws);
                return GLib.SOURCE_REMOVE;
            });
        }
    }

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
            try { border.destroy(); } catch (e) { }
            this._tileBorderActors.delete(win);
        }
    }

    _hideAllTileBorders() {
        this._tileBorderActors.forEach((border) => {
            try { border.hide(); } catch (e) { }
        });
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

        let suppressed = this._tileBorderSuppressed;

        let border = this._tileBorderActors.get(win);
        let isNew = !border;
        if (!border) {
            border = new St.Widget({ reactive: false, can_focus: false });
            for (let i = 0; i < 4; i++) {
                let strip = new St.Widget({ reactive: false, can_focus: false });
                border.add_child(strip);
            }

            global.window_group.add_child(border);
            this._tileBorderActors.set(win, border);

            win.connect('size-changed', () => {
                if (this._tileBorderSuppressed) return;
                if (this._tileBorderActors.has(win)) this._positionTileBorder(win);
            });
            win.connect('position-changed', () => {
                if (this._tileBorderSuppressed) return;
                if (this._tileBorderActors.has(win)) this._positionTileBorder(win);
            });
            win.connect('unmanaging', () => { this._removeTileBorder(win); });

            let actorAllocId = actor.connect('notify::allocation', () => {
                if (this._tileBorderSuppressed) return;
                if (this._tileBorderActors.has(win)) this._positionTileBorder(win);
            });
            win.connect('unmanaging', () => {
                try { actor.disconnect(actorAllocId); } catch (e) { }
            });
        }

        this._positionTileBorder(win);

        if (!suppressed) {
            border.show();
            global.window_group.set_child_above_sibling(border, null);
        }

        if (isNew && !suppressed) {

            for (let delay of [50, 150, 350, 600, 1000]) {
                GLib.timeout_add(GLib.PRIORITY_DEFAULT, delay, () => {
                    if (this._tileBorderSuppressed) return GLib.SOURCE_REMOVE;
                    if (this._tileBorderActors.has(win)) {
                        this._positionTileBorder(win);
                        try {
                            global.window_group.set_child_above_sibling(border, null);
                        } catch (e) { }
                    }
                    return GLib.SOURCE_REMOVE;
                });
            }
        }
    }

    _positionTileBorder(win) {
        let border = this._tileBorderActors.get(win);
        if (!border) return;
        let style = this._getTileBorderStyle();
        if (!style) return;
        let bw = style.width;
        let cssColor = `background-color: ${style.color};`;
        let frameRect = win.get_frame_rect();
        let x = frameRect.x;
        let y = frameRect.y;
        let fw = frameRect.width;
        let fh = frameRect.height;

        border.set_position(x - bw, y - bw);
        border.set_size(fw + 2 * bw, fh + 2 * bw);

        let s = [
            border.get_child_at_index(0), 
            border.get_child_at_index(1), 
            border.get_child_at_index(2), 
            border.get_child_at_index(3), 
        ];
        if (s[0]) { s[0].set_position(0, 0); s[0].set_size(fw + 2 * bw, bw); s[0].set_style(cssColor); }
        if (s[1]) { s[1].set_position(0, bw + fh); s[1].set_size(fw + 2 * bw, bw); s[1].set_style(cssColor); }
        if (s[2]) { s[2].set_position(0, bw); s[2].set_size(bw, fh); s[2].set_style(cssColor); }
        if (s[3]) { s[3].set_position(bw + fw, bw); s[3].set_size(bw, fh); s[3].set_style(cssColor); }
    }

    _onFocusWindowChanged() {
        if (this._tileBorderSuppressed) return;
        let focusedWin = global.display.get_focus_window();
        this._tileBorderActors.forEach((border, win) => {
            if (win !== focusedWin) try { border.hide(); } catch (e) { }
        });
        if (focusedWin) this._updateTileBorder(focusedWin, true);
    }

    _refreshTileBorder() {
        this._tileBorderSuppressed = false;
        this._tileBorderActors.forEach((border, win) => {
            try { border.destroy(); } catch (e) { }
        });
        this._tileBorderActors.clear();
        let focusedWin = global.display.get_focus_window();
        if (focusedWin) this._updateTileBorder(focusedWin, true);
    }

    _onAutoTileSettingChanged(settings, key) {
        let enabled = this.wm_settings.get_boolean('auto-tile');

        if (enabled) {

            if (this._autoTileEdgeTilingWas === null) {
                this._autoTileEdgeTilingWas = this.wm_settings.get_boolean('edge-tiling');
                if (this.wm_settings.get_boolean('edge-tiling'))
                    this.wm_settings.set_boolean('edge-tiling', false);
            }

            if (this._autoTileDraggableBorderWas === null) {
                this._autoTileDraggableBorderWas = this.wm_settings.get_int('draggable-border-width');
                this.wm_settings.set_int('draggable-border-width', 0);
            }

            if (this._autoTilePlacementModeWas === null) {
                this._autoTilePlacementModeWas = this.wm_settings.get_string('placement-mode');
                if (this._autoTilePlacementModeWas !== 'automatic')
                    this.wm_settings.set_string('placement-mode', 'automatic');
            }

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

            if (!this._autoTileCursorPollId) {
                this._autoTileCursorPollId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 50, () => {
                    if (!this.wm_settings.get_boolean('auto-tile')) {
                        this._autoTileCursorPollId = null;
                        return GLib.SOURCE_REMOVE;
                    }

                    try {
                        let currentOp = global.display.get_grab_op();
                        let isMoving = currentOp === Meta.GrabOp.MOVING;
                        if (isMoving && !this._autoTileSwapDragWin) {
                       
                            let focusWin = global.display.get_focus_window();
                            if (focusWin) {
                                let mon = focusWin.get_monitor();
                                let tiledWins = this._autoTileGetTiledWindows(mon);
                                if (tiledWins.includes(focusWin) && this._autoTileSavedRects) {
                                    let origRect = this._autoTileSavedRects.get(focusWin.get_id());
                                    if (origRect) {
                                        this._autoTileSwapDragWin = focusWin;
                                        this._autoTileSwapDragOrigRect = { ...origRect };
                                        this._autoTileSwapDropTarget = null;
                                        this._autoTileSwapInProgress = true;
                                        this._autoTileSwapPollId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 32, () => {
                                            if (!this._autoTileSwapDragWin) {
                                                this._autoTileSwapPollId = null;
                                                return GLib.SOURCE_REMOVE;
                                            }
                                            try {
                                                let [px, py] = global.get_pointer();
                                                let target = this._autoTileSwapFindTarget(px, py, this._autoTileSwapDragWin, mon);
                                                if (target !== this._autoTileSwapDropTarget) {
                                                    this._autoTileSwapDropTarget = target;
                                                    this._autoTileSwapUpdateOverlay(target);
                                                }
                                            } catch (e) { }
                                            return GLib.SOURCE_CONTINUE;
                                        });
                                    }
                                }
                            }
                        } else if (!isMoving && this._autoTileSwapDragWin) {
           
                            if (this._autoTileSwapPollId) {
                                GLib.source_remove(this._autoTileSwapPollId);
                                this._autoTileSwapPollId = null;
                            }
                            this._autoTileSwapFinish();
                        }
                    } catch (e) { }

                    let dragging = this._autoTileDragHandles.some(h => h._dragging);
                    if (dragging) return GLib.SOURCE_CONTINUE;
                    try {
                        let [px, py] = global.get_pointer();
                        let overHandle = this._autoTileDragHandles.some(h => {
                            let hx = h.get_x(), hy = h.get_y();
                            let hw = h.get_width(), hh = h.get_height();
                            return px >= hx && px <= hx + hw &&
                                py >= hy && py <= hy + hh;
                        });
                        global.display.set_cursor(overHandle
                            ? Meta.Cursor.POINTING_HAND
                            : Meta.Cursor.DEFAULT);
                    } catch (e) { }
                    return GLib.SOURCE_CONTINUE;
                });
            }

            if (!this._autoTileGrabOpBeginId) {
         
                this._autoTileGrabOpBeginId = true; 
            }

            if (!this._autoTileGrabOpEndId) {
                this._autoTileGrabOpEndId = global.display.connect('grab-op-end',
                    (display, grabOp, win) => {
                        this._autoTileWinMinSizes.clear();
               
                    });
            }

            this._connectAutoTileWorkspace();
            this._registerAutoTileKeybindings();

            try {
                let wmKb = imports.gi.Gio.Settings.new('org.gnome.desktop.wm.keybindings');
                let maxBinding = wmKb.get_strv('maximize');
                if (maxBinding.some(b => b.includes('<Super>Up'))) {
                    this._autoTileMaximizeBindingWas = maxBinding;
                    wmKb.set_strv('maximize', maxBinding.filter(b => !b.includes('<Super>Up')));
                }
            } catch (e) { }

            try {
                let cinKb = imports.gi.Gio.Settings.new('org.cinnamon.desktop.keybindings.wm');
                for (let [key, prop] of [
                    ['push-tile-left', '_autoTilePushLeftWas'],
                    ['push-tile-right', '_autoTilePushRightWas'],
                    ['push-tile-up', '_autoTilePushUpWas'],
                    ['push-tile-down', '_autoTilePushDownWas'],
                ]) {
                    let b = cinKb.get_strv(key);
                    if (b.length > 0) {
                        this[prop] = b;
                        cinKb.set_strv(key, []);
                    }
                }
            } catch (e) { }

            try {
                for (let schema of ['org.gnome.desktop.wm.keybindings',
                    'org.cinnamon.desktop.keybindings.wm']) {
                    let kb = imports.gi.Gio.Settings.new(schema);
                    for (let [key, prop] of [
                        ['move-to-monitor-left', '_autoTileMonLeftWas'],
                        ['move-to-monitor-right', '_autoTileMonRightWas'],
                        ['move-to-monitor-up', '_autoTileMonUpWas'],
                        ['move-to-monitor-down', '_autoTileMonDownWas'],
                    ]) {
                        try {
                            let b = kb.get_strv(key);
                            if (b.length > 0) {
                                this[prop] = this[prop] || b;
                                kb.set_strv(key, []);
                            }
                        } catch (e) { }
                    }
                }
            } catch (e) { }

            const _autoTileStartup = (attempt) => {
                if (!this.wm_settings.get_boolean('auto-tile')) return;
                let workspace = global.workspace_manager.get_active_workspace();
                if (!workspace) return;
                let mon = (global.display.get_focus_window() ? global.display.get_focus_window().get_monitor() : global.display.get_primary_monitor());
                let wa = workspace.get_work_area_for_monitor(mon);
                let screenH = global.screen_height || global.display.get_monitor_geometry(mon).height;
                if (wa.height >= screenH - 2 && attempt < 2) return; 
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

            if (this._autoTileGrabOpBeginId) {
    
                this._autoTileGrabOpBeginId = null;
            }
            if (this._autoTileGrabOpEndId) {
                global.display.disconnect(this._autoTileGrabOpEndId);
                this._autoTileGrabOpEndId = null;
            }
            this._autoTileSwapCancel();
            this._autoTileWinMinSizes.clear();
            this._autoTileDestroyDragHandles();
            this._autoTileStripeClose();

            if (this._autoTileCursorPollId) {
                GLib.source_remove(this._autoTileCursorPollId);
                this._autoTileCursorPollId = null;
            }

            if (this._autoTileEdgeTilingListenerId) {
                this.wm_settings.disconnect(this._autoTileEdgeTilingListenerId);
                this._autoTileEdgeTilingListenerId = null;
            }
            this._unregisterAutoTileKeybindings();

            try {
                if (this._autoTileEdgeTilingWas !== null) {
                    this.wm_settings.set_boolean('edge-tiling', this._autoTileEdgeTilingWas);
                    this._autoTileEdgeTilingWas = null;
                }
            } catch (e) { }

            try {
                if (this._autoTileDraggableBorderWas !== null) {
                    this.wm_settings.set_int('draggable-border-width', this._autoTileDraggableBorderWas);
                    this._autoTileDraggableBorderWas = null;
                }
            } catch (e) { }

            try {
                if (this._autoTilePlacementModeWas !== null) {
                    this.wm_settings.set_string('placement-mode', this._autoTilePlacementModeWas);
                    this._autoTilePlacementModeWas = null;
                }
            } catch (e) { }

            try {
                if (this._autoTileMaximizeBindingWas) {
                    let wmKb = imports.gi.Gio.Settings.new('org.gnome.desktop.wm.keybindings');
                    wmKb.set_strv('maximize', this._autoTileMaximizeBindingWas);
                    this._autoTileMaximizeBindingWas = null;
                }
            } catch (e) { }

            try {
                let cinKb = imports.gi.Gio.Settings.new('org.cinnamon.desktop.keybindings.wm');
                for (let [key, prop] of [
                    ['push-tile-left', '_autoTilePushLeftWas'],
                    ['push-tile-right', '_autoTilePushRightWas'],
                    ['push-tile-up', '_autoTilePushUpWas'],
                    ['push-tile-down', '_autoTilePushDownWas'],
                ]) {
                    if (this[prop]) {
                        cinKb.set_strv(key, this[prop]);
                        this[prop] = null;
                    }
                }
            } catch (e) { }

            try {
                for (let schema of ['org.gnome.desktop.wm.keybindings',
                    'org.cinnamon.desktop.keybindings.wm']) {
                    let kb = imports.gi.Gio.Settings.new(schema);
                    for (let [key, prop] of [
                        ['move-to-monitor-left', '_autoTileMonLeftWas'],
                        ['move-to-monitor-right', '_autoTileMonRightWas'],
                        ['move-to-monitor-up', '_autoTileMonUpWas'],
                        ['move-to-monitor-down', '_autoTileMonDownWas'],
                    ]) {
                        try {
                            if (this[prop]) {
                                kb.set_strv(key, this[prop]);
                                this[prop] = null;
                            }
                        } catch (e) { }
                    }
                }
            } catch (e) { }

            try {
                if (this._autoTileMaximizeBindingWas) {
                    let wmKb = imports.gi.Gio.Settings.new('org.gnome.desktop.wm.keybindings');
                    wmKb.set_strv('maximize', this._autoTileMaximizeBindingWas);
                    this._autoTileMaximizeBindingWas = null;
                }
            } catch (e) { }
            this._autoTileSlotOrder = null;
            this._autoTileSlotOrderByMonitor = null;
            this._autoTile3MirroredByMonitor = null;
            this._autoTileSlotOrderByWs.clear();
            this._autoTileWsSwitchPending = false;
            this._autoTileWorkspaceSwitching = false;
            this._autoTileWsSwitchGen = 0;
        }
        this._wm.onSettingsChanged(global.settings, 'desktop-effects-map');
    }

    _registerAutoTileKeybindings() {
        if (this._autoTileKeybindingsRegistered) return;
        this._autoTileKeybindingsRegistered = true;

        let kbm = Main.keybindingManager;

        kbm.addHotKey('auto-tile-swap-left', '<Super>Left',
            () => this._autoTileSwapWindows('left'));
        kbm.addHotKey('auto-tile-swap-right', '<Super>Right',
            () => this._autoTileSwapWindows('right'));
        kbm.addHotKey('auto-tile-cycle-cw', '<Super>Down',
            () => this._autoTileCycleWindows('clockwise'));
        kbm.addHotKey('auto-tile-cycle-ccw', '<Super>Up',
            () => this._autoTileCycleWindows('counter'));
        kbm.addHotKey('auto-tile-focus-left', '<Super>h',
            () => this._autoTileFocusNeighbour('left'));
        kbm.addHotKey('auto-tile-focus-right', '<Super>l',
            () => this._autoTileFocusNeighbour('right'));
        kbm.addHotKey('auto-tile-focus-up', '<Super>k',
            () => this._autoTileFocusNeighbour('up'));
        kbm.addHotKey('auto-tile-focus-down', '<Super>j',
            () => this._autoTileFocusNeighbour('down'));
        kbm.addHotKey('auto-tile-focus-next', '<Super>Tab',
            () => this._autoTileFocusCycle(1));
        kbm.addHotKey('auto-tile-focus-prev', '<Super><Shift>Tab',
            () => this._autoTileFocusCycle(-1));
        kbm.addHotKey('auto-tile-close', '<Super>w',
            () => {
                if (this._autoTileStripe) { this._autoTileStripeClose(); return; }
                let win = global.display.get_focus_window();
                if (win) win.delete(global.get_current_time());
            });
        kbm.addHotKey('auto-tile-minimize', '<Super>m',
            () => {

                if (this._autoTilePreviewWin) {
                    this._autoTilePreviewCancel();
                    return; 
                }
                let win = global.display.get_focus_window();
                if (win) win.minimize();
            });

        kbm.addHotKey('auto-tile-resize-left', '<Super><Shift>Left',
            () => this._autoTileKeyboardResize('left'));
        kbm.addHotKey('auto-tile-resize-right', '<Super><Shift>Right',
            () => this._autoTileKeyboardResize('right'));
        kbm.addHotKey('auto-tile-resize-up', '<Super><Shift>Up',
            () => this._autoTileKeyboardResize('up'));
        kbm.addHotKey('auto-tile-resize-down', '<Super><Shift>Down',
            () => this._autoTileKeyboardResize('down'));
        kbm.setBuiltinHandler('push-tile-left', Meta.KeyBindingAction.PUSH_TILE_LEFT,
            () => this._autoTileKeyboardResize('left'));
        kbm.setBuiltinHandler('push-tile-right', Meta.KeyBindingAction.PUSH_TILE_RIGHT,
            () => this._autoTileKeyboardResize('right'));
        kbm.addHotKey('auto-tile-cycle-minimized-left', '<Primary><Super>Left',
            () => this._autoTileCycleMinimized('left'));
        kbm.addHotKey('auto-tile-cycle-minimized-right', '<Primary><Super>Right',
            () => this._autoTileCycleMinimized('right'));
        kbm.addHotKey('auto-tile-preview-up', '<Primary><Super>Up',
            () => this._autoTilePreviewMinimized('up'));
        kbm.addHotKey('auto-tile-preview-down', '<Primary><Super>Down',
            () => this._autoTilePreviewMinimized('down'));
        kbm.addHotKey('auto-tile-preview-confirm', '<Primary><Super>space',
            () => this._autoTilePreviewConfirm());
        kbm.addHotKey('auto-tile-preview-cancel', '<Primary><Super>Escape',
            () => this._autoTilePreviewCancel());
        kbm.addHotKey('auto-tile-focus-next-monitor', '<Super>f',
            () => this._autoTileFocusNextMonitor());
        kbm.addHotKey('auto-tile-move-to-monitor', '<Super><Shift>m',
            () => this._autoTileMoveToNextMonitor());
        kbm.addHotKey('workspace-prev', '<Super>Page_Up',
            () => {
                let active = global.workspace_manager.get_active_workspace();
                let neighbor = active.get_neighbor(Meta.MotionDirection.LEFT);
                if (active != neighbor) this._wm.moveToWorkspace(neighbor, Meta.MotionDirection.UP);
            });
        kbm.addHotKey('workspace-next', '<Super>Page_Down',
            () => {
                let active = global.workspace_manager.get_active_workspace();
                let neighbor = active.get_neighbor(Meta.MotionDirection.RIGHT);
                if (active != neighbor) this._wm.moveToWorkspace(neighbor, Meta.MotionDirection.DOWN);
            });
        kbm.addHotKey('auto-tile-toggle-columns', '<Super>q',
            () => this._autoTileToggleColumns());
        kbm.addHotKey('auto-tile-stripe-open', '<Super>y',
            () => this._autoTileStripeToggle());
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
        kbm.removeHotKey('auto-tile-cycle-minimized-left');
        kbm.removeHotKey('auto-tile-cycle-minimized-right');
        kbm.removeHotKey('auto-tile-preview-up');
        kbm.removeHotKey('auto-tile-preview-down');
        kbm.removeHotKey('auto-tile-preview-confirm');
        kbm.removeHotKey('auto-tile-preview-cancel');
        kbm.removeHotKey('auto-tile-focus-next-monitor');
        kbm.removeHotKey('auto-tile-move-to-monitor');
        kbm.removeHotKey('workspace-prev');
        kbm.removeHotKey('workspace-next');
        kbm.removeHotKey('auto-tile-toggle-columns');
        kbm.removeHotKey('auto-tile-stripe-open');
    }

    _onAutoTileWorkspaceChanged() {
        this._autoTileDestroyDragHandles();

        if (!this._autoTileStripeConfirming) this._autoTileStripeClose();
        this._autoTileWsSwitchPending = true;
        let prevWs = this._autoTileCurrentWorkspace;
        if (prevWs) {

            let focusWin = global.display.get_focus_window();
            let focusId = (focusWin && this._autoTileWinById &&
                this._autoTileWinById.has(focusWin.get_id()))
                ? focusWin.get_id() : null;

            this._autoTileSlotOrderByWs.set(prevWs.index(), {
                slotOrder: this._autoTileSlotOrder ? this._autoTileSlotOrder.slice() : null,
                mirrored: this._autoTile3Mirrored,
                layout2: this._autoTile2Layout,
                columnsMode: this._autoTileColumnsMode,
                focusId: focusId,

                savedRects: this._autoTileSavedRects
                    ? new Map(this._autoTileSavedRects)
                    : null,
                slotOrderByMonitor: this._autoTileSlotOrderByMonitor
                    ? Object.assign({}, this._autoTileSlotOrderByMonitor)
                    : {},
                mirroredByMonitor: this._autoTile3MirroredByMonitor
                    ? Object.assign({}, this._autoTile3MirroredByMonitor)
                    : {},
            });
        }

        this._autoTile2Layout = 'vertical';
        this._autoTile3Mirrored = false;
        this._autoTileColumnsMode = false;
        this._autoTileSlotOrder = null;
        this._autoTileSlotOrderByMonitor = {};
        this._autoTile3MirroredByMonitor = {};
        this._disconnectAutoTileResizeSignals();
        this._disconnectAutoTileWorkspace();
        this._connectAutoTileWorkspace();

        let workspace = global.workspace_manager.get_active_workspace();
        if (!workspace) return;
        let wsIdx = workspace.index();
        let wsState = this._autoTileSlotOrderByWs.get(wsIdx) || null;
        let focusIdToRestore = null;
        if (wsState) {
            if (wsState.slotOrder) this._autoTileSlotOrder = wsState.slotOrder.slice();
            this._autoTile3Mirrored = wsState.mirrored;
            this._autoTile2Layout = wsState.layout2;
            this._autoTileColumnsMode = wsState.columnsMode || false;
            focusIdToRestore = wsState.focusId;
            this._autoTileRestoredRects = wsState.savedRects
                ? new Map(wsState.savedRects)
                : null;
            this._autoTileSlotOrderByMonitor = wsState.slotOrderByMonitor
                ? Object.assign({}, wsState.slotOrderByMonitor)
                : {};
            this._autoTile3MirroredByMonitor = wsState.mirroredByMonitor
                ? Object.assign({}, wsState.mirroredByMonitor)
                : {};
        } else {
            this._autoTileRestoredRects = null;
        }
        let myGen = ++this._autoTileWsSwitchGen;
        let animMs = 700;
        try {
            let mult = this._wm.window_effect_multiplier || 1.0;
            animMs = Math.ceil(this._wm.WORKSPACE_ANIMATION_TIME * mult) + 80;
        } catch (e) { }

        GLib.timeout_add(GLib.PRIORITY_DEFAULT, animMs, () => {

            if (myGen !== this._autoTileWsSwitchGen) return GLib.SOURCE_REMOVE;

            this._autoTileWsSwitchPending = false;
            this._autoTileWorkspaceSwitching = false;
            this._autoTileWorkspace(workspace);

            if (focusIdToRestore && this._autoTileWinById) {
                let winToFocus = this._autoTileWinById.get(focusIdToRestore);
                if (winToFocus) {
                    GLib.timeout_add(GLib.PRIORITY_DEFAULT, 50, () => {
                        try { winToFocus.activate(global.get_current_time()); } catch (e) { }
                        this._refreshTileBorder();
                        return GLib.SOURCE_REMOVE;
                    });
                } else {
                    this._refreshTileBorder();
                }
            } else {
                this._refreshTileBorder();
            }

            return GLib.SOURCE_REMOVE;
        });
    }

    _connectAutoTileWorkspace() {
        let workspace = global.workspace_manager.get_active_workspace();
        if (!workspace) return;
        if (!this._autoTileMinimizeIds) this._autoTileMinimizeIds = new Map();

        const attachMinimizeWatcher = (win) => {
            if (!win) return;
            if (win.get_window_type() !== Meta.WindowType.NORMAL) return;
            if (win.is_skip_taskbar()) return;
            if (this._autoTileMinimizeIds.has(win)) return; 
            let sigId = win.connect('notify::minimized', () => {

                if (win.minimized) {

                    this.suppressBorder();

                    try {
                        let ws = global.workspace_manager.get_active_workspace();
                        if (ws && !this._autoTileCyclePending) {
                            let monitorIndex = win.get_monitor();
                            let wa = ws.get_work_area_for_monitor(monitorIndex);
                            let peers = ws.list_windows().filter(w => {
                                if (w.is_skip_taskbar()) return false;
                                if (w.get_window_type() !== Meta.WindowType.NORMAL) return false;
                                if (w.minimized) return false; 
                                if (w.get_monitor() !== monitorIndex) return false;
                                let wmClass = w.get_wm_class() || '';
                                if (wmClass !== '') {
                                    let excl = this.wm_settings.get_strv('auto-tile-excludelist');
                                    if (excl.includes(wmClass)) return false;
                                }
                                if (!w.allows_resize()) return false;
                                return true;
                            });
                            let n = peers.length;
                            if (n >= 1 && n <= 4) {
                                let ordered = peers.slice().sort((a, b) =>
                                    a.get_stable_sequence() - b.get_stable_sequence());
                                let layout2 = (n === 2) ? this._autoTile2Layout : 'vertical';
                                let mirrored = (n === 3) ? (this._autoTile3MirroredByMonitor &&
                                    this._autoTile3MirroredByMonitor[monitorIndex]) || false : false;
                                let rects = this._computeAutoTileRects(
                                    n, wa.x, wa.y, wa.width, wa.height, layout2, mirrored);
                                if (!this._autoTileProgrammaticIds)
                                    this._autoTileProgrammaticIds = new Set();
                                for (let i = 0; i < ordered.length && i < rects.length; i++) {
                                    let r = rects[i];
                                    let w2 = ordered[i];
                                    this._autoTileProgrammaticIds.add(w2.get_id());
                                    try { w2.move_resize_frame(false, r.x, r.y, r.w, r.h); } catch (e) { }
                                }
                                GLib.timeout_add(GLib.PRIORITY_DEFAULT, 400, () => {
                                    if (this._autoTileProgrammaticIds) {
                                        for (let w2 of peers)
                                            this._autoTileProgrammaticIds.delete(w2.get_id());
                                    }
                                    return GLib.SOURCE_REMOVE;
                                });
                            }
                        }
                    } catch (e) { }
                }

                if (!win.minimized) {
 
                    try {
                        let ws = global.workspace_manager.get_active_workspace();
                        if (ws && !this._autoTileCyclePending) {
                            let monitorIndex = win.get_monitor();
                            let wa = ws.get_work_area_for_monitor(monitorIndex);
                            let peers = ws.list_windows().filter(w => {
                                if (w.is_skip_taskbar()) return false;
                                if (w.get_window_type() !== Meta.WindowType.NORMAL) return false;
                                if (w.minimized) return false;
                                if (w.get_monitor() !== monitorIndex) return false;
                                let wmClass = w.get_wm_class() || '';
                                if (wmClass !== '') {
                                    let excludeList = this.wm_settings.get_strv('auto-tile-excludelist');
                                    if (excludeList.includes(wmClass)) return false;
                                }
                                return true;
                            });
                            let n = peers.length;
                            if (n >= 1 && n <= 4) {
                                let ordered = peers.slice().sort((a, b) =>
                                    a.get_stable_sequence() - b.get_stable_sequence());
                                let idx = ordered.indexOf(win);
                                if (idx >= 0) {
                                    if (this._autoTileColumnsMode) {
                          
                                        let actor = win.get_compositor_private();
                                        if (actor) actor.opacity = 0;
                                    } else {
                                        let layout2 = (n === 2) ? this._autoTile2Layout : 'vertical';
                                        let mirrored = (n === 3) ? (this._autoTile3MirroredByMonitor &&
                                            this._autoTile3MirroredByMonitor[monitorIndex]) || false : false;
                                        let rects = this._computeAutoTileRects(
                                            n, wa.x, wa.y, wa.width, wa.height, layout2, mirrored);
                                        if (idx < rects.length) {
                                            let r = rects[idx];
                                            if (!this._autoTileProgrammaticIds)
                                                this._autoTileProgrammaticIds = new Set();
                                            this._autoTileProgrammaticIds.add(win.get_id());
                                            win.move_resize_frame(false, r.x, r.y, r.w, r.h);
                                            GLib.timeout_add(GLib.PRIORITY_DEFAULT, 300, () => {
                                                if (this._autoTileProgrammaticIds)
                                                    this._autoTileProgrammaticIds.delete(win.get_id());
                                                return GLib.SOURCE_REMOVE;
                                            });
                                        }
                                    }
                                }
                            }
                        }
                    } catch (e) { }
                }

                GLib.timeout_add(GLib.PRIORITY_DEFAULT, 150, () => {
                    if (this._autoTileCyclePending) return GLib.SOURCE_REMOVE;
                    let ws = global.workspace_manager.get_active_workspace();
                    if (ws) this._autoTileWorkspace(ws);
                    return GLib.SOURCE_REMOVE;
                });
            });
            this._autoTileMinimizeIds.set(win, sigId);
        };

        workspace.list_windows().forEach(attachMinimizeWatcher);

        if (!this._autoTileWindowAddedId) {
            this._autoTileWindowAddedId = workspace.connect('window-added',
                (ws, win) => {
                    if (!win) return;
                    if (win.get_window_type() !== Meta.WindowType.NORMAL) return;
                    if (win.is_skip_taskbar()) return;

                    attachMinimizeWatcher(win);

                    if (this._autoTileWsSwitchPending) return;
                    if (this._autoTileCyclePending) return;
                    if (this._autoTileSwapInProgress) return;

                    this.suppressBorder();

                    GLib.timeout_add(GLib.PRIORITY_DEFAULT, 300, () => {
                        if (this._autoTileCyclePending) return GLib.SOURCE_REMOVE;
                        if (this._autoTileSwapInProgress) return GLib.SOURCE_REMOVE;
                        this._autoTileWorkspace(ws);
                        return GLib.SOURCE_REMOVE;
                    });

                    GLib.timeout_add(GLib.PRIORITY_DEFAULT, 800, () => {
                        if (this._autoTileCyclePending) return GLib.SOURCE_REMOVE;
                        if (this._autoTileWsSwitchPending) return GLib.SOURCE_REMOVE;
                        if (this._autoTileSwapInProgress) return GLib.SOURCE_REMOVE;
                 
                        let winId = win.get_id();
                        let alreadyTiled = this._autoTileWinById &&
                            this._autoTileWinById.has(winId);
                        let nowTileable = !win.minimized &&
                            win.get_window_type() === Meta.WindowType.NORMAL &&
                            !win.is_skip_taskbar() &&
                            win.allows_resize();
                        if (!alreadyTiled && nowTileable) {
                            this._autoTileWorkspace(ws);
                        }
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
        this._autoTileDestroyDragHandles();

        if (this._autoTileMinimizeIds) {
            for (let [win, sigId] of this._autoTileMinimizeIds) {
                try { win.disconnect(sigId); } catch (e) { }
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

    _autoTileProbeMinSize(win) {
        let id = win.get_id();
        if (this._autoTileWinMinSizes.has(id)) return; 

        try {
            let before = win.get_frame_rect();

            if (!this._autoTileProgrammaticIds)
                this._autoTileProgrammaticIds = new Set();
            this._autoTileProgrammaticIds.add(id);

            win.move_resize_frame(false, before.x, before.y, 1, 1);
            let probed = win.get_frame_rect();

            win.move_resize_frame(false, before.x, before.y, before.width, before.height);

            this._autoTileWinMinSizes.set(id, {
                minW: probed.width + 2,
                minH: probed.height + 2,
            });

            GLib.timeout_add(GLib.PRIORITY_DEFAULT, 80, () => {
                if (this._autoTileProgrammaticIds)
                    this._autoTileProgrammaticIds.delete(id);
                return GLib.SOURCE_REMOVE;
            });
        } catch (e) {

            let workspace = global.workspace_manager.get_active_workspace();
            if (workspace) {
                let mon = (global.display.get_focus_window() ? global.display.get_focus_window().get_monitor() : global.display.get_primary_monitor());
                let wa = workspace.get_work_area_for_monitor(mon);
                this._autoTileWinMinSizes.set(id, {
                    minW: Math.floor(wa.width / 4),
                    minH: Math.floor(wa.height / 3),
                });
            }
        }
    }

    _autoTileSwapFindTarget(px, py, dragWin, mon) {
        if (!this._autoTileSavedRects) return null;
        let tiledWins = this._autoTileGetTiledWindows(mon);
        for (let win of tiledWins) {
            if (win === dragWin) continue;
            let r = this._autoTileSavedRects.get(win.get_id());
            if (!r) continue;
            if (px >= r.x && px <= r.x + r.width &&
                py >= r.y && py <= r.y + r.height)
                return win;
        }
        return null;
    }

    _autoTileSwapUpdateOverlay(targetWin) {
        if (this._autoTileSwapDropOverlay) {
            try { this._autoTileSwapDropOverlay.destroy(); } catch (e) {}
            this._autoTileSwapDropOverlay = null;
        }
        if (!targetWin || !this._autoTileSavedRects) return;
        let r = this._autoTileSavedRects.get(targetWin.get_id());
        if (!r) return;

        let color = this.wm_settings.get_string('auto-tile-accent-color') || '#3064dc';
        let overlay = new St.Widget({ reactive: false });
        overlay.set_style('background-color: ' + color + ';');
        overlay.set_opacity(89);
        overlay.set_position(r.x, r.y);
        overlay.set_size(r.width, r.height);
        try {
            global.window_group.add_actor(overlay);
            global.window_group.set_child_above_sibling(overlay, null);
            this._autoTileSwapDropOverlay = overlay;
        } catch (e) {
            try { overlay.destroy(); } catch (e2) {}
        }
    }

    _autoTileSwapCancel() {
        if (this._autoTileSwapPollId) {
            GLib.source_remove(this._autoTileSwapPollId);
            this._autoTileSwapPollId = null;
        }
        if (this._autoTileSwapDropOverlay) {
            try { this._autoTileSwapDropOverlay.destroy(); } catch (e) {}
            this._autoTileSwapDropOverlay = null;
        }
        this._autoTileSwapDragWin = null;
        this._autoTileSwapDragOrigRect = null;
        this._autoTileSwapDropTarget = null;
        this._autoTileSwapInProgress = false;
    }

    _autoTileSwapFinish() {
        let dragWin = this._autoTileSwapDragWin;
        if (!dragWin) {
            this._autoTileSwapCancel();
            return;
        }

        let mon = dragWin.get_monitor();
        let targetWin = null;
        try {
            let [px, py] = global.get_pointer();
            targetWin = this._autoTileSwapFindTarget(px, py, dragWin, mon);
        } catch (e) { global.log('AutoTile swapFinish error: ' + e); }

        this._autoTileSwapInProgress = false;
        this._autoTileSwapCancel();

        let dragId = dragWin.get_id();
        let ws = global.workspace_manager.get_active_workspace();

        if (targetWin) {
            let targetId = targetWin.get_id();
            let mon = dragWin.get_monitor();
            if (!this._autoTileSlotOrderByMonitor) this._autoTileSlotOrderByMonitor = {};

            let slotOrder = this._autoTileSlotOrderByMonitor[mon]
                ? this._autoTileSlotOrderByMonitor[mon].slice()
                : (this._autoTileSlotOrder ? this._autoTileSlotOrder.slice() : null);
            if (slotOrder) {
                let di = slotOrder.indexOf(dragId);
                let ti = slotOrder.indexOf(targetId);
                if (di >= 0 && ti >= 0) {
                    let tmp = slotOrder[di];
                    slotOrder[di] = slotOrder[ti];
                    slotOrder[ti] = tmp;
                    this._autoTileSlotOrderByMonitor[mon] = slotOrder;
                    this._autoTileSlotOrder = slotOrder;
                }
            }
        }
        if (ws) this._autoTileWorkspace(ws);
    }

    _autoTileDestroyDragHandles() {
        for (let h of this._autoTileDragHandles) {
            try {
                if (h._pollId) {
                    GLib.source_remove(h._pollId);
                    h._pollId = null;
                }
                h._dragging = false;
                h.destroy();
            } catch (e) { }
        }
        this._autoTileDragHandles = [];
        try { global.display.set_cursor(Meta.Cursor.DEFAULT); } catch (e) { }
    }

    _autoTileCreateDragHandles() {
        this._autoTileDestroyDragHandles();
        if (!this._autoTileSavedRects) return;

        let tiledWins = this._autoTileGetTiledWindows(global.display.get_focus_window() ? global.display.get_focus_window().get_monitor() : global.display.get_primary_monitor());
        if (tiledWins.length < 2) return;

        let gap = this.wm_settings.get_int('auto-tile-gap');
        let n = tiledWins.length;

        let slotWins = [];
        if (this._autoTileSlotOrder && this._autoTileWinById) {
            for (let id of this._autoTileSlotOrder) {
                let w = this._autoTileWinById.get(id);
                if (w) slotWins.push(w);
            }
        } else {
            slotWins = tiledWins.slice();
        }
        if (slotWins.length < 2) return;

        let rects = slotWins.map(w => this._autoTileSavedRects.get(w.get_id()));
        if (rects.some(r => !r)) return;

        let handles = [];
        if (this._autoTileColumnsMode) {
  
            for (let i = 0; i < slotWins.length - 1; i++) {
                let r = rects[i];
                handles.push({
                    x: r.x + r.width, y: r.y,
                    w: gap || 4, h: r.height,
                    axis: 'x',
                    leftWins:  [slotWins[i]],
                    rightWins: [slotWins[i + 1]],
                    colMode: true,
                    colLeftIdx:  i,
                    colRightIdx: i + 1,
                });
            }
        } else if (n === 2) {
            let layout = this._autoTile2Layout || 'vertical';
            if (layout === 'vertical') {
            
                handles.push({
                    x: rects[0].x + rects[0].width, y: rects[0].y,
                    w: gap, h: rects[0].height,
                    axis: 'x',
                    leftWins: [slotWins[0]],
                    rightWins: [slotWins[1]]
                });
            } else {
                handles.push({
                    x: rects[0].x, y: rects[0].y + rects[0].height,
                    w: rects[0].width, h: gap,
                    axis: 'y', wins: [slotWins[0], slotWins[1]]
                });
            }
        } else if (n === 3) {
            let mirrored = this._autoTile3Mirrored || false;
            let hx = !mirrored ? rects[0].x + rects[0].width : rects[1].x + rects[1].width;
            handles.push({
                x: hx, y: rects[0].y, w: gap, h: rects[0].height,
                axis: 'x',
                leftWins: !mirrored ? [slotWins[0]] : [slotWins[1], slotWins[2]],
                rightWins: !mirrored ? [slotWins[1], slotWins[2]] : [slotWins[0]]
            });
            handles.push({
                x: rects[1].x, y: rects[1].y + rects[1].height,
                w: rects[1].width, h: gap,
                axis: 'y', wins: [slotWins[1], slotWins[2]]
            });
        } else if (n === 4) {
            handles.push({
                x: rects[0].x + rects[0].width, y: rects[0].y,
                w: gap, h: rects[0].height + gap + rects[2].height,
                axis: 'x',
                leftWins: [slotWins[0], slotWins[2]],
                rightWins: [slotWins[1], slotWins[3]]
            });
            handles.push({
                x: rects[0].x, y: rects[0].y + rects[0].height,
                w: rects[0].width, h: gap,
                axis: 'y', wins: [slotWins[0], slotWins[2]]
            });
            handles.push({
                x: rects[1].x, y: rects[1].y + rects[1].height,
                w: rects[1].width, h: gap,
                axis: 'y', wins: [slotWins[1], slotWins[3]]
            });
        }

        for (let hdef of handles) {
            try {
                let hitArea = new St.Widget({
                    reactive: true,
                    style: 'background-color: transparent;'
                });
                hitArea.set_position(hdef.x, hdef.y);
                hitArea.set_size(hdef.w, hdef.h);
                hitArea._hdef = hdef;
                hitArea._dragging = false;
                hitArea._pollId = null;

                global.window_group.add_actor(hitArea);
                global.window_group.set_child_above_sibling(hitArea, null);
                this._autoTileDragHandles.push(hitArea);

                hitArea.connect('button-press-event', (actor, event) => {
                    if (event.get_button() !== 1) return Clutter.EVENT_PROPAGATE;
                    let [px, py] = event.get_coords();
                    actor._dragging = true;
                    let allHdefWins = hdef.axis === 'x'
                        ? [...hdef.leftWins, ...hdef.rightWins]
                        : hdef.wins;
                    let startRects = new Map();
                    for (let win of allHdefWins) {
                        let fr = win.get_frame_rect();
                        startRects.set(win.get_id(),
                            { x: fr.x, y: fr.y, width: fr.width, height: fr.height });
                    }
                    for (let win of allHdefWins) {
                        if (!this._autoTileWinMinSizes.has(win.get_id()))
                            this._autoTileProbeMinSize(win);
                    }
                    this._autoTileSuspendResizeSignals();
                    let watchdogId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 10000, () => {
                        if (actor._dragging) {
                            actor._dragging = false;
                            if (actor._pollId) {
                                GLib.source_remove(actor._pollId);
                                actor._pollId = null;
                            }
                            global.display.set_cursor(Meta.Cursor.DEFAULT);
                            this._autoTileResumeResizeSignals();
                            GLib.timeout_add(GLib.PRIORITY_DEFAULT, 50, () => {
                                this._autoTileCreateDragHandles();
                                return GLib.SOURCE_REMOVE;
                            });
                        }
                        return GLib.SOURCE_REMOVE;
                    });
                    let hdefSnap = actor._hdef;
                    let startPtrSnap = { x: px, y: py };
                    let startRectsSnap = startRects;
                    actor._pollId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 16, () => {
                        if (!actor._dragging) {
                            actor._pollId = null;
                            return GLib.SOURCE_REMOVE;
                        }
                        try {
                            let [cx, cy, mods] = global.get_pointer();
                            if (!(mods & Clutter.ModifierType.BUTTON1_MASK)) {
                                actor._dragging = false;
                                actor._pollId = null;
                                global.display.set_cursor(Meta.Cursor.DEFAULT);
                                this._autoTileResumeResizeSignals();
                                GLib.timeout_add(GLib.PRIORITY_DEFAULT, 50, () => {
                                    this._autoTileCreateDragHandles();
                                    return GLib.SOURCE_REMOVE;
                                });
                                return GLib.SOURCE_REMOVE;
                            }
                            let gap2 = this.wm_settings.get_int('auto-tile-gap');
                            let workspace2 = global.workspace_manager.get_active_workspace();
                            let mon2 = (global.display.get_focus_window() ? global.display.get_focus_window().get_monitor() : global.display.get_primary_monitor());
                            let wa2 = workspace2 ? workspace2.get_work_area_for_monitor(mon2) : null;
                            let withinRange = true;
                            if (wa2) {
                                if (hdefSnap.axis === 'x') {
                                    let minX = -Infinity;
                                    for (let wl of hdefSnap.leftWins) {
                                        let sl = this._autoTileWinMinSizes.get(wl.get_id());
                                        let rl = startRectsSnap.get(wl.get_id());
                                        if (sl && rl)
                                            minX = Math.max(minX, rl.x + (sl.minW || 200));
                                    }
                                    let maxX = Infinity;
                                    let r1s = startRectsSnap.get(hdefSnap.rightWins[0].get_id());
                                    let rightEdge = r1s ? r1s.x + r1s.width : Infinity;
                                    for (let wr of hdefSnap.rightWins) {
                                        let sr = this._autoTileWinMinSizes.get(wr.get_id());
                                        if (sr)
                                            maxX = Math.min(maxX, rightEdge - (sr.minW || 200) - gap2);
                                    }
                                    if (minX === -Infinity) minX = 0;
                                    if (maxX === Infinity) maxX = minX;
                                    withinRange = cx >= minX && cx <= maxX;
                                } else {
                                    let w0 = hdefSnap.wins[0];
                                    let w1 = hdefSnap.wins[1];
                                    let s0 = this._autoTileWinMinSizes.get(w0.get_id());
                                    let s1 = this._autoTileWinMinSizes.get(w1.get_id());
                                    let r0s = startRectsSnap.get(w0.get_id());
                                    let r1s = startRectsSnap.get(w1.get_id());
                                    if (r0s && r1s && s0 && s1) {
                                        let minY = r0s.y + (s0.minH || 150);
                                        let maxY = (r1s.y + r1s.height) - (s1.minH || 150) - gap2;
                                        withinRange = cy >= minY && cy <= maxY;
                                    }
                                }
                            }
                            global.display.set_cursor(withinRange
                                ? Meta.Cursor.POINTING_HAND
                                : Meta.Cursor.DEFAULT);
                            this._autoTileDragHandleMotion(
                                hdefSnap, startPtrSnap, startRectsSnap, cx, cy);
                        } catch (e) {
                            global.log('AutoTile drag error: ' + e);
                            actor._dragging = false;
                            actor._pollId = null;
                            global.display.set_cursor(Meta.Cursor.DEFAULT);
                            this._autoTileResumeResizeSignals();
                            GLib.timeout_add(GLib.PRIORITY_DEFAULT, 50, () => {
                                this._autoTileCreateDragHandles();
                                return GLib.SOURCE_REMOVE;
                            });
                            return GLib.SOURCE_REMOVE;
                        }
                        return GLib.SOURCE_CONTINUE;
                    });
                    return Clutter.EVENT_STOP;
                });

                hitArea.connect('button-release-event', (actor, event) => {
                    if (!actor._dragging) return Clutter.EVENT_PROPAGATE;
                    actor._dragging = false;
                    if (actor._pollId) {
                        GLib.source_remove(actor._pollId);
                        actor._pollId = null;
                    }
                    global.display.set_cursor(Meta.Cursor.DEFAULT);
                    GLib.timeout_add(GLib.PRIORITY_DEFAULT, 80, () => {
                        this._autoTileSnapCompensate(hdef);
                        GLib.timeout_add(GLib.PRIORITY_DEFAULT, 80, () => {
                            this._autoTileResumeResizeSignals();
                            this._autoTileCreateDragHandles();
                            return GLib.SOURCE_REMOVE;
                        });
                        return GLib.SOURCE_REMOVE;
                    });
                    return Clutter.EVENT_STOP;
                });

            } catch (e) {
                global.log('AutoTile handle error: ' + e);
            }
        }
    }

    _autoTileSnapCompensate(hdef) {
        if (!hdef || !this._autoTileSavedRects) return;
        try {
            let gap = this.wm_settings.get_int('auto-tile-gap');
            let workspace = global.workspace_manager.get_active_workspace();
            if (!workspace) return;
            let mon = (global.display.get_focus_window()
                ? global.display.get_focus_window().get_monitor()
                : global.display.get_primary_monitor());
            let wa = workspace.get_work_area_for_monitor(mon);
            let waLeft = wa.x + gap;
            let waRight = wa.x + wa.width - gap;
            let waBottom = wa.y + wa.height - gap;

            if (hdef.axis === 'x') {

                let fl = hdef.leftWins[0].get_frame_rect();
                let newDivX = fl.x + fl.width;
                for (let wl of hdef.leftWins) {
                    let fl2 = wl.get_frame_rect();
                    this._autoTileSavedRects.set(wl.get_id(),
                        { x: waLeft, y: fl2.y, width: fl2.width, height: fl2.height });
                }
                for (let wr of hdef.rightWins) {
                    let fr2 = wr.get_frame_rect();
                    let nx = newDivX + gap;
                    let nw = waRight - nx;
                    if (nw < 1) continue;
                    this._autoTileSavedRects.set(wr.get_id(),
                        { x: nx, y: fr2.y, width: nw, height: fr2.height });
                    try { wr.move_resize_frame(false, nx, fr2.y, nw, fr2.height); } catch (e) { }
                }
            } else {

                let win0 = hdef.wins[0], win1 = hdef.wins[1];
                let f0 = win0.get_frame_rect();
                let ny1 = f0.y + f0.height + gap;
                let nh1 = waBottom - ny1;
                if (nh1 < 1) return;
                this._autoTileSavedRects.set(win0.get_id(),
                    { x: f0.x, y: f0.y, width: f0.width, height: f0.height });
                let f1 = win1.get_frame_rect();
                this._autoTileSavedRects.set(win1.get_id(),
                    { x: f1.x, y: ny1, width: f1.width, height: nh1 });
                try { win1.move_resize_frame(false, f1.x, ny1, f1.width, nh1); } catch (e) { }
            }
        } catch (e) {
            global.log('AutoTile snapCompensate error: ' + e);
        }
    }

    _autoTileSuspendResizeSignals() {
        if (!this._autoTileResizeIds) return;
        for (let entry of this._autoTileResizeIds) {
            if (entry.sizeId !== null) {
                try { entry.win.disconnect(entry.sizeId); } catch (e) { }
                entry.sizeIdSuspended = entry.sizeId;
                entry.sizeId = null;
            }
        }
    }

    _autoTileResumeResizeSignals() {
        if (!this._autoTileResizeIds) return;
        for (let entry of this._autoTileResizeIds) {
            if (entry.sizeId === null && entry.sizeIdSuspended !== undefined) {
                try {
                    entry.sizeId = entry.win.connect('size-changed', (w) => {
                        Meta.later_add(Meta.LaterType.RESIZE, () => {
                            this._autoTileSmartResize(w, w.get_id());
                            return false;
                        });
                    });
                } catch (e) { }
                delete entry.sizeIdSuspended;
            }
        }
    }

    _autoTileDragHandleMotion(hdef, startPtr, startRects, cx, cy) {
        if (!hdef || !startPtr || !startRects) return;

        let dx = cx - startPtr.x;
        let dy = cy - startPtr.y;

        let gap = this.wm_settings.get_int('auto-tile-gap');
        let workspace = global.workspace_manager.get_active_workspace();
        if (!workspace) return;
        let mon = (global.display.get_focus_window() ? global.display.get_focus_window().get_monitor() : global.display.get_primary_monitor());
        let wa = workspace.get_work_area_for_monitor(mon);

        const _minW = (win) => {
            let s = this._autoTileWinMinSizes.get(win.get_id());
            return s ? s.minW : 200;
        };
        const _minH = (win) => {
            let s = this._autoTileWinMinSizes.get(win.get_id());
            return s ? s.minH : 150;
        };

        if (hdef.axis === 'x') {

            let leftWins = hdef.leftWins;
            let rightWins = hdef.rightWins;

            let r1 = startRects.get(rightWins[0].get_id());
            if (!r1) return;
            let rightEdge = r1.x + r1.width;

            let r0 = startRects.get(leftWins[0].get_id());
            if (!r0) return;
            let leftEdge = r0.x;

            let refW0 = r0.width;
            let newDivX = leftEdge + refW0 + dx;

            let minDivX = leftEdge;
            for (let wl of leftWins)
                minDivX = Math.max(minDivX, leftEdge + _minW(wl));

            let maxDivX = rightEdge - gap;
            for (let wr of rightWins)
                maxDivX = Math.min(maxDivX, rightEdge - gap - _minW(wr));

            newDivX = Math.max(newDivX, minDivX);
            newDivX = Math.min(newDivX, maxDivX);

            let nx_right = newDivX + gap;
            let newLeftW = newDivX - leftEdge;
            let newRightW = rightEdge - nx_right;

            for (let wl of leftWins) {
                let cur = wl.get_frame_rect();
                if (newLeftW !== cur.width || leftEdge !== cur.x) {
                    if (this._autoTileSavedRects) this._autoTileSavedRects.set(wl.get_id(),
                        { x: leftEdge, y: cur.y, width: newLeftW, height: cur.height });
                    try { wl.move_resize_frame(false, leftEdge, cur.y, newLeftW, cur.height); } catch (e) { }
                }
            }

            for (let wr of rightWins) {
                let cur = wr.get_frame_rect();
                if (nx_right !== cur.x || newRightW !== cur.width) {
                    if (this._autoTileSavedRects) this._autoTileSavedRects.set(wr.get_id(),
                        { x: nx_right, y: cur.y, width: newRightW, height: cur.height });
                    try { wr.move_resize_frame(false, nx_right, cur.y, newRightW, cur.height); } catch (e) { }
                }
            }
        } else {

            let win0 = hdef.wins[0], win1 = hdef.wins[1];
            let r0 = startRects.get(win0.get_id());
            let r1 = startRects.get(win1.get_id());
            if (!r0 || !r1) return;

            let minH0 = _minH(win0), minH1 = _minH(win1);

            let totalH = (r1.y + r1.height) - r0.y;

            let nh0 = r0.height + dy;
            nh0 = Math.max(nh0, minH0);
            nh0 = Math.min(nh0, totalH - gap - minH1);

            let ny1 = r0.y + nh0 + gap;
            let nh1 = (r1.y + r1.height) - ny1;

            if (nh0 !== r0.height) {
                if (this._autoTileSavedRects) this._autoTileSavedRects.set(win0.get_id(),
                    { x: r0.x, y: r0.y, width: r0.width, height: nh0 });
                try { win0.move_resize_frame(false, r0.x, r0.y, r0.width, nh0); } catch (e) { }
            }
            if (ny1 !== r1.y || nh1 !== r1.height) {
                if (this._autoTileSavedRects) this._autoTileSavedRects.set(win1.get_id(),
                    { x: r1.x, y: ny1, width: r1.width, height: nh1 });
                try { win1.move_resize_frame(false, r1.x, ny1, r1.width, nh1); } catch (e) { }
            }
        }
    }

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
                if (this._autoTileSavedRects) this._autoTileSavedRects.delete(id);
                if (this._autoTileOriginalRects) this._autoTileOriginalRects.delete(id);
            });
            this._autoTileResizeIds.push({ win, winId, sizeId, unmanagedId });
        }

    }

    _disconnectAutoTileResizeSignals() {
        if (!this._autoTileResizeIds || this._autoTileResizeIds.length === 0)
            return;
        for (let { win, sizeId, unmanagedId } of this._autoTileResizeIds) {
            try { win.disconnect(sizeId); } catch (e) { }
            try { win.disconnect(unmanagedId); } catch (e) { }
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

        let wDeviation = Math.abs(fr.width - oldRect.width) / Math.max(oldRect.width, 1);
        let hDeviation = Math.abs(fr.height - oldRect.height) / Math.max(oldRect.height, 1);
        if (wDeviation > 0.20 || hDeviation > 0.20) {
            if (!this._autoTileExternalResetDebounceId) {
                this._autoTileExternalResetDebounceId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 200, () => {
                    this._autoTileExternalResetDebounceId = null;
                    let ws = global.workspace_manager.get_active_workspace();
                    if (ws) this._autoTileWorkspace(ws);
                    GLib.timeout_add(GLib.PRIORITY_DEFAULT, 150, () => {
                        this._refreshTileBorder();
                        return GLib.SOURCE_REMOVE;
                    });
                    return GLib.SOURCE_REMOVE;
                });
            }
            return;
        }

        this._autoTileSavedRects.set(movedId,
            { x: fr.x, y: fr.y, width: fr.width, height: fr.height });

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
                let mon = (global.display.get_focus_window() ? global.display.get_focus_window().get_monitor() : global.display.get_primary_monitor());
                let wa = workspace.get_work_area_for_monitor(mon);
                let waLeft = wa.x + gap, waTop = wa.y + gap;
                let waRight = wa.x + wa.width - gap, waBottom = wa.y + wa.height - gap;

                const _getMinW = (win) => {
                    let s = this._autoTileWinMinSizes.get(win.get_id());
                    return s ? s.minW : Math.floor(wa.width / 4);
                };
                const _getMinH = (win) => {
                    let s = this._autoTileWinMinSizes.get(win.get_id());
                    return s ? s.minH : Math.floor(wa.height / 3);
                };

                let minW = _getMinW(movedWin);
                let minH = _getMinH(movedWin);

                if (!this._autoTileProgrammaticIds)
                    this._autoTileProgrammaticIds = new Set();
                let smartResizeIds = []; 

                let tiledWins = this._autoTileGetTiledWindows(global.display.get_focus_window() ? global.display.get_focus_window().get_monitor() : global.display.get_primary_monitor());
                let others = tiledWins.filter(w => w.get_id() !== movedId);

                if (this._autoTileColumnsMode && this._autoTileSlotOrderByMonitor) {
                    let mon = movedWin.get_monitor();
                    let slotOrder = (this._autoTileSlotOrderByMonitor[mon])
                        || this._autoTileSlotOrder;
                    if (slotOrder) {
                        let movedIdx = slotOrder.indexOf(movedId);
                        if (movedIdx >= 0) {
                            let adjacentIds = new Set();
                            if (movedIdx + 1 < slotOrder.length) adjacentIds.add(slotOrder[movedIdx + 1]);
                            if (movedIdx - 1 >= 0) adjacentIds.add(slotOrder[movedIdx - 1]);
                            others = others.filter(w => adjacentIds.has(w.get_id()));
                        }
                    }
                }

                for (let win of others) {
                    let saved = this._autoTileSavedRects.get(win.get_id());
                    if (!saved) continue;
                    let nx = saved.x, ny = saved.y, nw = saved.width, nh = saved.height;
                    let nMinW = _getMinW(win);
                    let nMinH = _getMinH(win);

                    let isRight = saved.x >= mfr.x + mfr.width / 2;
                    let isLeft = saved.x + saved.width <= mfr.x + mfr.width / 2;
                    let isBelow = !isRight && !isLeft && saved.y > mfr.y;

                    if (isRight) {
                        nx = mfr.x + mfr.width + gap;
  
                        let rightBound = this._autoTileColumnsMode
                            ? saved.x + saved.width
                            : waRight;
                        nw = rightBound - nx;

                        if (nw < nMinW) {
                            nw = nMinW;
                            nx = rightBound - nMinW;
                            let newMoverRight = nx - gap;
                            let newMoverW = newMoverRight - mfr.x;
                            if (newMoverW >= minW) {
                                this._autoTileProgrammaticIds.add(movedId);
                                smartResizeIds.push(movedId);
                                movedWin.move_resize_frame(false, mfr.x, mfr.y, newMoverW, mfr.height);
                                mfr = movedWin.get_frame_rect();
                            } else {
                                continue;
                            }
                        }
                    } else if (isLeft) {
 
                        let leftBound = this._autoTileColumnsMode
                            ? saved.x
                            : waLeft;
                        nx = leftBound;
                        nw = mfr.x - gap - leftBound;

                        if (nw < nMinW) {
                            nw = nMinW;
                            let newMoverLeft = leftBound + nMinW + gap;
                            let newMoverW = mfr.x + mfr.width - newMoverLeft;
                            if (newMoverW >= minW) {
                                this._autoTileProgrammaticIds.add(movedId);
                                smartResizeIds.push(movedId);
                                movedWin.move_resize_frame(false, newMoverLeft, mfr.y, newMoverW, mfr.height);
                                mfr = movedWin.get_frame_rect();
                            } else {
                                continue;
                            }
                        }
                    } else if (isBelow) {

                        ny = mfr.y + mfr.height + gap;
                        nh = waBottom - ny;

                        if (nh < nMinH) {
                            nh = nMinH;
                            ny = waBottom - nMinH;
                            let newMoverBottom = ny - gap;
                            let newMoverH = newMoverBottom - mfr.y;
                            if (newMoverH >= minH) {
                                this._autoTileProgrammaticIds.add(movedId);
                                movedWin.move_resize_frame(false, mfr.x, mfr.y, mfr.width, newMoverH);
                                mfr = movedWin.get_frame_rect();
                            } else {
                                continue;
                            }
                        }
                    } else {

                        ny = waTop;
                        nh = mfr.y - gap - waTop;

                        if (nh < nMinH) {
                            nh = nMinH;
                            let newMoverTop = waTop + nMinH + gap;
                            let newMoverH = mfr.y + mfr.height - newMoverTop;
                            if (newMoverH >= minH) {
                                this._autoTileProgrammaticIds.add(movedId);
                                movedWin.move_resize_frame(false, mfr.x, newMoverTop, mfr.width, newMoverH);
                                mfr = movedWin.get_frame_rect();
                            } else {
                                continue;
                            }
                        }
                    }

                    if (nw < nMinW || nh < nMinH) continue;
                    this._autoTileProgrammaticIds.add(win.get_id());
                    smartResizeIds.push(win.get_id());
                    this._autoTileSavedRects.set(win.get_id(),
                        { x: nx, y: ny, width: nw, height: nh });
                    try { win.move_resize_frame(false, nx, ny, nw, nh); } catch (e) { }
                }

                this._autoTileSavedRects.set(movedId,
                    { x: mfr.x, y: mfr.y, width: mfr.width, height: mfr.height });

                GLib.timeout_add(GLib.PRIORITY_DEFAULT, 80, () => {
                    if (this._autoTileProgrammaticIds) {
                        for (let id of smartResizeIds)
                            this._autoTileProgrammaticIds.delete(id);
                    }
                    return GLib.SOURCE_REMOVE;
                });
            } catch (e) {

                if (this._autoTileProgrammaticIds)
                    this._autoTileProgrammaticIds.clear();
            }
            return GLib.SOURCE_REMOVE;
        });
    }

    _autoTileGetTiledWindows(monitorIndex) {

        if (monitorIndex === undefined) {
            let fw = global.display.get_focus_window();
            monitorIndex = fw ? fw.get_monitor() : global.display.get_primary_monitor();
        }
        let workspace = global.workspace_manager.get_active_workspace();
        if (!workspace) return [];
        return workspace.list_windows().filter(win => {
            if (win.is_skip_taskbar()) return false;
            if (win.get_window_type() !== Meta.WindowType.NORMAL) return false;
            if (win.minimized) return false;
            if (win.get_monitor() !== monitorIndex) return false;
            let wmClass = win.get_wm_class() || '';
            if (wmClass !== '') {
                let excludeList = this.wm_settings.get_strv('auto-tile-excludelist');
                if (excludeList.includes(wmClass)) return false;
            }
            return true;
        });
    }

    _autoTileFocusNextMonitor() {
        if (!this.wm_settings.get_boolean('auto-tile')) return;
        let nMonitors = global.display.get_n_monitors();
        if (nMonitors < 2) return;
        let currentWin = global.display.get_focus_window();
        let currentMon = currentWin ? currentWin.get_monitor()
            : global.display.get_primary_monitor();
        let targetMon = (currentMon + 1) % nMonitors;
        let workspace = global.workspace_manager.get_active_workspace();
        if (!workspace) return;
        let candidates = workspace.list_windows().filter(win => {
            if (win.get_window_type() !== Meta.WindowType.NORMAL) return false;
            if (win.is_skip_taskbar()) return false;
            if (win.minimized) return false;
            if (win.get_monitor() !== targetMon) return false;
            return true;
        });
        if (candidates.length === 0) return;

        let targetWin = candidates[0];
        targetWin.activate(global.get_current_time());

        let fr = targetWin.get_frame_rect();
        global.set_pointer(
            Math.round(fr.x + fr.width / 2),
            Math.round(fr.y + fr.height / 2));
    }

    _autoTileMoveToNextMonitor() {
        if (!this.wm_settings.get_boolean('auto-tile')) return;
        let win = global.display.get_focus_window();
        if (!win) return;
        if (win.get_window_type() !== Meta.WindowType.NORMAL) return;
        if (win.is_skip_taskbar()) return;
        let nMonitors = global.display.get_n_monitors();
        if (nMonitors < 2) return;
        let currentMon = win.get_monitor();
        let targetMon = (currentMon + 1) % nMonitors;
        let workspace = global.workspace_manager.get_active_workspace();
        let sourceWa = workspace.get_work_area_for_monitor(currentMon);
        let targetWa = workspace.get_work_area_for_monitor(targetMon);
   
        let fr = win.get_frame_rect();
        let mapped = this._mapRectBetweenWorkAreas(fr, sourceWa, targetWa);
        if (!this._autoTileProgrammaticIds) this._autoTileProgrammaticIds = new Set();
        this._autoTileProgrammaticIds.add(win.get_id());
        win.move_resize_frame(false, mapped.x, mapped.y, mapped.width, mapped.height);
        if (this._autoTileSlotOrderByMonitor) {
            delete this._autoTileSlotOrderByMonitor[currentMon];
            delete this._autoTileSlotOrderByMonitor[targetMon];
        }
        GLib.timeout_add(GLib.PRIORITY_DEFAULT, 80, () => {
            if (this._autoTileProgrammaticIds)
                this._autoTileProgrammaticIds.delete(win.get_id());
            if (workspace) this._autoTileWorkspace(workspace);
            GLib.timeout_add(GLib.PRIORITY_DEFAULT, 120, () => {
                try { win.activate(global.get_current_time()); } catch (e) { }
                return GLib.SOURCE_REMOVE;
            });
            return GLib.SOURCE_REMOVE;
        });
    }

    _autoTileSwapWindows(direction) {
        if (!this.wm_settings.get_boolean('auto-tile')) return false;
        let focusedWin = global.display.get_focus_window();
        let monitorIndex = focusedWin ? focusedWin.get_monitor()
            : global.display.get_primary_monitor();
        let tiledWins = this._autoTileGetTiledWindows(monitorIndex);
        if (tiledWins.length < 2) return false;
        let workspace = global.workspace_manager.get_active_workspace();
        let workArea = workspace ? workspace.get_work_area_for_monitor(monitorIndex) : null;
        if (!workArea) return false;

        if (this._autoTileColumnsMode) {
            if (!focusedWin || !tiledWins.includes(focusedWin)) return false;
            let slotOrder = (this._autoTileSlotOrderByMonitor &&
                this._autoTileSlotOrderByMonitor[monitorIndex])
                ? this._autoTileSlotOrderByMonitor[monitorIndex].slice()
                : tiledWins.map(w => w.get_id());
            let focusId = focusedWin.get_id();
            let idx = slotOrder.indexOf(focusId);
            if (idx < 0) return false;
            let n = slotOrder.length;
            let newIdx = direction === 'left'
                ? (idx - 1 + n) % n
                : (idx + 1) % n;
      
            [slotOrder[idx], slotOrder[newIdx]] = [slotOrder[newIdx], slotOrder[idx]];
            if (!this._autoTileSlotOrderByMonitor)
                this._autoTileSlotOrderByMonitor = {};
            this._autoTileSlotOrderByMonitor[monitorIndex] = slotOrder;
            this._autoTileSlotOrder = slotOrder;
            if (workspace) this._autoTileWorkspace(workspace);
            return true;
        }
        if (tiledWins.length === 3) {
            if (!this._autoTile3MirroredByMonitor) this._autoTile3MirroredByMonitor = {};
            if (focusedWin && tiledWins.includes(focusedWin)) {
                let monSlotOrder = (this._autoTileSlotOrderByMonitor &&
                    this._autoTileSlotOrderByMonitor[monitorIndex])
                    ? this._autoTileSlotOrderByMonitor[monitorIndex].slice()
                    : tiledWins.map(w => w.get_id());
                let focusId = focusedWin.get_id();
                let focusPos = monSlotOrder.indexOf(focusId);
                if (focusPos > 0) {
                    monSlotOrder.splice(focusPos, 1);
                    monSlotOrder.unshift(focusId);
                    if (!this._autoTileSlotOrderByMonitor)
                        this._autoTileSlotOrderByMonitor = {};
                    this._autoTileSlotOrderByMonitor[monitorIndex] = monSlotOrder;
                    this._autoTileSlotOrder = monSlotOrder;
                }
            }

            this._autoTile3MirroredByMonitor[monitorIndex] =
                !(this._autoTile3MirroredByMonitor[monitorIndex] || false);
            this._autoTile3Mirrored = this._autoTile3MirroredByMonitor[monitorIndex];
            if (workspace) this._autoTileWorkspace(workspace);
            return true;
        }
        if (tiledWins.length === 4) {
            let idealRects = this._computeAutoTileRects(4,
                workArea.x, workArea.y, workArea.width, workArea.height);
            let slotWin = new Array(4);
            for (let win of tiledWins) {
                let fr = win.get_frame_rect();
                let cx = fr.x + fr.width / 2;
                let cy = fr.y + fr.height / 2;
                let bestS = -1, bestD = Infinity;
                for (let s = 0; s < 4; s++) {
                    let ir = idealRects[s];
                    let d = Math.hypot(cx - (ir.x + ir.w / 2), cy - (ir.y + ir.h / 2));
                    if (d < bestD) { bestD = d; bestS = s; }
                }
                slotWin[bestS] = win;
            }
            const mirrorMap = [1, 0, 3, 2];
            if (!this._autoTileProgrammaticIds) this._autoTileProgrammaticIds = new Set();
            for (let s = 0; s < 4; s++) {
                let win = slotWin[s];
                if (!win) continue;
                let dest = idealRects[mirrorMap[s]];
                this._autoTileProgrammaticIds.add(win.get_id());
                win.move_resize_frame(false, dest.x, dest.y, dest.w, dest.h);
            }
            this._autoTileWorkspace(workspace);
            return true;
        }
        if (!focusedWin) return false;
        let focusIdx = tiledWins.indexOf(focusedWin);
        if (focusIdx < 0) return false;
        let partnerWin = tiledWins[focusIdx === 0 ? 1 : 0];

        {
            let layout2 = this._autoTile2Layout || 'vertical';
            let idealRects2 = this._computeAutoTileRects(2,
                workArea.x, workArea.y, workArea.width, workArea.height, layout2);
            let fId = focusedWin.get_id();
            let pId = partnerWin.get_id();
            const centroidOf = (win) => {
                let sr = this._autoTileSavedRects ? this._autoTileSavedRects.get(win.get_id()) : null;
                let r = sr || win.get_frame_rect();
                return { cx: r.x + r.width / 2, cy: r.y + r.height / 2 };
            };
            let fc = centroidOf(focusedWin);
            let fSlot = (Math.hypot(fc.cx - (idealRects2[0].x + idealRects2[0].w / 2),
                fc.cy - (idealRects2[0].y + idealRects2[0].h / 2)) <=
                Math.hypot(fc.cx - (idealRects2[1].x + idealRects2[1].w / 2),
                    fc.cy - (idealRects2[1].y + idealRects2[1].h / 2))) ? 0 : 1;
            let pSlot = 1 - fSlot;
            let rectForF = idealRects2[pSlot];
            let rectForP = idealRects2[fSlot];

            if (!this._autoTileProgrammaticIds) this._autoTileProgrammaticIds = new Set();
            this._autoTileProgrammaticIds.add(fId);
            this._autoTileProgrammaticIds.add(pId);
            focusedWin.move_resize_frame(false, rectForF.x, rectForF.y, rectForF.w, rectForF.h);
            partnerWin.move_resize_frame(false, rectForP.x, rectForP.y, rectForP.w, rectForP.h);

            if (this._autoTileSlotOrder) {
                let fi = this._autoTileSlotOrder.indexOf(fId);
                let pi = this._autoTileSlotOrder.indexOf(pId);
                if (fi >= 0 && pi >= 0) {
                    let tmp = this._autoTileSlotOrder[fi];
                    this._autoTileSlotOrder[fi] = this._autoTileSlotOrder[pi];
                    this._autoTileSlotOrder[pi] = tmp;
                }
            }

            if (this._autoTileSavedRects) {
                this._autoTileSavedRects.set(fId,
                    { x: rectForF.x, y: rectForF.y, width: rectForF.w, height: rectForF.h });
                this._autoTileSavedRects.set(pId,
                    { x: rectForP.x, y: rectForP.y, width: rectForP.w, height: rectForP.h });
            }
            if (this._autoTileOriginalRects) {
                this._autoTileOriginalRects.set(fId, { width: rectForF.w, height: rectForF.h });
                this._autoTileOriginalRects.set(pId, { width: rectForP.w, height: rectForP.h });
            }
            let swapIds = [fId, pId];
            GLib.timeout_add(GLib.PRIORITY_DEFAULT, 150, () => {
                if (focusedWin) focusedWin.activate(global.get_current_time());
                if (this._autoTileProgrammaticIds) {
                    for (let id of swapIds)
                        this._autoTileProgrammaticIds.delete(id);
                }
                return GLib.SOURCE_REMOVE;
            });
        }
        return true;
    }

    _autoTileCycleWindows(direction) {
        if (!this.wm_settings.get_boolean('auto-tile')) return false;

        let tiledWins = this._autoTileGetTiledWindows(global.display.get_focus_window() ? global.display.get_focus_window().get_monitor() : global.display.get_primary_monitor());
        if (tiledWins.length < 2) return false;

        if (tiledWins.length === 2) {
            let step = (direction === 'clockwise') ? 1 : -1;
            this._autoTile2Pos = (((this._autoTile2Pos || 0) + step) % 4 + 4) % 4;

            let ws = global.workspace_manager.get_active_workspace();
            let mon = (global.display.get_focus_window() ? global.display.get_focus_window().get_monitor() : global.display.get_primary_monitor());
            let wa = ws.get_work_area_for_monitor(mon);
            let gap = this.wm_settings.get_int('auto-tile-gap');
            let x = wa.x + gap, y = wa.y + gap;
            let w = wa.width - gap * 2, h = wa.height - gap * 2;
            let hw = Math.floor((w - gap) / 2), hw2 = w - hw - gap;
            let hh = Math.floor((h - gap) / 2), hh2 = h - hh - gap;

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
                case 0: r0 = { x, y, w: hw, h }; r1 = { x: x + hw + gap, y, w: hw2, h };
                    this._autoTile2Layout = 'vertical'; break;
                case 1: r0 = { x, y, w, h: hh }; r1 = { x, y: y + hh + gap, w, h: hh2 };
                    this._autoTile2Layout = 'horizontal'; break;
                case 2: r0 = { x: x + hw + gap, y, w: hw2, h }; r1 = { x, y, w: hw, h };
                    this._autoTile2Layout = 'vertical'; break;
                case 3: r0 = { x, y: y + hh + gap, w, h: hh2 }; r1 = { x, y, w, h: hh };
                    this._autoTile2Layout = 'horizontal'; break;
            }

            if (!this._autoTileProgrammaticIds) this._autoTileProgrammaticIds = new Set();
            this._autoTileProgrammaticIds.add(win0.get_id());
            this._autoTileProgrammaticIds.add(win1.get_id());

            this._autoTileDestroyDragHandles();

            win0.move_resize_frame(false, r0.x, r0.y, r0.w, r0.h);
            win1.move_resize_frame(false, r1.x, r1.y, r1.w, r1.h);
            this._autoTileSlotOrder = [win0.get_id(), win1.get_id()];
            this._autoTile2Win0Id = win0.get_id();

            if (!this._autoTileSlotOrderByMonitor) this._autoTileSlotOrderByMonitor = {};
            this._autoTileSlotOrderByMonitor[mon] = this._autoTileSlotOrder;

            if (this._autoTileSavedRects) {
                this._autoTileSavedRects.set(win0.get_id(),
                    { x: r0.x, y: r0.y, width: r0.w, height: r0.h });
                this._autoTileSavedRects.set(win1.get_id(),
                    { x: r1.x, y: r1.y, width: r1.w, height: r1.h });
            }

            GLib.timeout_add(GLib.PRIORITY_DEFAULT, 50, () => {
                if (this._autoTileProgrammaticIds) this._autoTileProgrammaticIds.clear();

                if (this._autoTileSavedRects) {
                    for (let [id, win] of (this._autoTileWinById || new Map())) {
                        try {
                            let fr = win.get_frame_rect();
                            this._autoTileSavedRects.set(id,
                                { x: fr.x, y: fr.y, width: fr.width, height: fr.height });
                            if (this._autoTileOriginalRects)
                                this._autoTileOriginalRects.set(id,
                                    { width: fr.width, height: fr.height });
                        } catch (e) { }
                    }
                }
                this._autoTileCreateDragHandles();
                return GLib.SOURCE_REMOVE;
            });
            return true;
        }

        let workspace = global.workspace_manager.get_active_workspace();
        let monitorIndex = (global.display.get_focus_window() ? global.display.get_focus_window().get_monitor() : global.display.get_primary_monitor());
        let workArea = workspace.get_work_area_for_monitor(monitorIndex);
        let mirrored = (tiledWins.length === 3) ? (this._autoTile3Mirrored || false) : false;
        let layout2 = (tiledWins.length === 2) ? (this._autoTile2Layout || 'vertical') : 'vertical';
        let idealRects = this._computeAutoTileRects(tiledWins.length,
            workArea.x, workArea.y, workArea.width, workArea.height, layout2, mirrored);

        let slotOrder = new Array(tiledWins.length);
        let usedSlots = new Set();
        for (let i = 0; i < tiledWins.length; i++) {
            let fr = tiledWins[i].get_frame_rect();
            let cx = fr.x + fr.width / 2;
            let cy = fr.y + fr.height / 2;
            let bestSlot = -1, bestDist = Infinity;
            for (let s = 0; s < idealRects.length; s++) {
                if (usedSlots.has(s)) continue;
                let ir = idealRects[s];
                let d = Math.hypot(cx - (ir.x + ir.w / 2), cy - (ir.y + ir.h / 2));
                if (d < bestDist) { bestDist = d; bestSlot = s; }
            }
            slotOrder[i] = bestSlot;
            usedSlots.add(bestSlot);
        }

        let slotWin = new Array(tiledWins.length);
        for (let i = 0; i < tiledWins.length; i++)
            slotWin[slotOrder[i]] = tiledWins[i];

        let n = tiledWins.length;

        let cwOrder = (n === 3) ? [0, 1, 2] : [0, 1, 3, 2];

        let nextSlot = new Array(n);
        for (let i = 0; i < cwOrder.length; i++) {
            let from = cwOrder[i];
            let to = direction === 'clockwise'
                ? cwOrder[(i + 1) % cwOrder.length]
                : cwOrder[(i - 1 + cwOrder.length) % cwOrder.length];
            nextSlot[from] = to;
        }

        if (!this._autoTileProgrammaticIds) this._autoTileProgrammaticIds = new Set();
        for (let win of tiledWins)
            this._autoTileProgrammaticIds.add(win.get_id());

        let focusedWinBeforeCycle = global.display.get_focus_window();

        let newSlotWin = new Array(n);
        for (let s = 0; s < n; s++)
            newSlotWin[nextSlot[s]] = slotWin[s];
        this._autoTileSlotOrder = newSlotWin.map(w => w.get_id());

        if (!this._autoTileSlotOrderByMonitor) this._autoTileSlotOrderByMonitor = {};
        this._autoTileSlotOrderByMonitor[monitorIndex] = this._autoTileSlotOrder;

        this._autoTileDestroyDragHandles();

        for (let s = 0; s < n; s++) {
            let win = slotWin[s];
            let dest = idealRects[nextSlot[s]];
            win.move_resize_frame(false, dest.x, dest.y, dest.w, dest.h);
        }

        if (this._autoTileSavedRects) {
            for (let s = 0; s < n; s++) {
                let win = slotWin[s];
                let dest = idealRects[nextSlot[s]];
                this._autoTileSavedRects.set(win.get_id(),
                    { x: dest.x, y: dest.y, width: dest.w, height: dest.h });
            }
        }

        GLib.timeout_add(GLib.PRIORITY_DEFAULT, 50, () => {
            if (focusedWinBeforeCycle) {
                try { focusedWinBeforeCycle.activate(global.get_current_time()); } catch (e) { }
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
                } catch (e) { }
            }
            if (this._autoTileProgrammaticIds) this._autoTileProgrammaticIds.clear();
            this._autoTileCreateDragHandles();
            return GLib.SOURCE_REMOVE;
        });

        return true;
    }

    _autoTileFocusNeighbour(direction) {
        if (!this.wm_settings.get_boolean('auto-tile')) return false;

        let focusedWin = global.display.get_focus_window();
        if (!focusedWin) return false;

        let tiledWins = this._autoTileGetTiledWindows(global.display.get_focus_window() ? global.display.get_focus_window().get_monitor() : global.display.get_primary_monitor());
        if (tiledWins.length < 2) return false;

        let fr = focusedWin.get_frame_rect();
        let fcx = fr.x + fr.width / 2;
        let fcy = fr.y + fr.height / 2;

        let bestWin = null;
        let bestDist = Infinity;

        for (let win of tiledWins) {
            if (win === focusedWin) continue;
            let r = win.get_frame_rect();
            let cx = r.x + r.width / 2;
            let cy = r.y + r.height / 2;
            let dx = cx - fcx;
            let dy = cy - fcy;
            let ok = false;
            let dist;
            if (direction === 'left' && dx < 0) { ok = true; dist = Math.abs(dx) + Math.abs(dy) * 0.5; }
            if (direction === 'right' && dx > 0) { ok = true; dist = Math.abs(dx) + Math.abs(dy) * 0.5; }
            if (direction === 'up' && dy < 0) { ok = true; dist = Math.abs(dy) + Math.abs(dx) * 0.5; }
            if (direction === 'down' && dy > 0) { ok = true; dist = Math.abs(dy) + Math.abs(dx) * 0.5; }
            if (ok && dist < bestDist) { bestDist = dist; bestWin = win; }
        }

        if (bestWin) {
            bestWin.activate(global.get_current_time());
            return true;
        }
        return false;
    }

    _autoTileFocusCycle(step) {
        if (!this.wm_settings.get_boolean('auto-tile')) return false;

        let focusedWin = global.display.get_focus_window();
        let monitorIndex = focusedWin ? focusedWin.get_monitor()
            : global.display.get_primary_monitor();

        let tiledWins = this._autoTileGetTiledWindows(monitorIndex);
        if (tiledWins.length < 2) return false;

        let slotOrder = (this._autoTileSlotOrderByMonitor &&
            this._autoTileSlotOrderByMonitor[monitorIndex])
            ? this._autoTileSlotOrderByMonitor[monitorIndex]
            : this._autoTileSlotOrder;

        let ordered;
        if (slotOrder && this._autoTileWinById) {
            ordered = slotOrder
                .map(id => this._autoTileWinById.get(id))
                .filter(w => w && tiledWins.includes(w));
        } else {

            ordered = tiledWins.slice().sort((a, b) => {
                let ra = a.get_frame_rect(), rb = b.get_frame_rect();
                let cya = ra.y + ra.height / 2, cyb = rb.y + rb.height / 2;
                let cxa = ra.x + ra.width / 2, cxb = rb.x + rb.width / 2;
                if (Math.abs(cya - cyb) > 50) return cya - cyb;
                return cxa - cxb;
            });
        }

        if (ordered.length < 2) return false;

        let idx = ordered.indexOf(focusedWin);
        if (idx < 0) idx = 0;

        let next = (idx + step + ordered.length) % ordered.length;
        ordered[next].activate(global.get_current_time());
        return true;
    }

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

        if (allWindows.length === 0) {
            this._autoTileDestroyDragHandles();
            return;
        }

        let nMonitors = global.display.get_n_monitors();
        for (let m = 0; m < nMonitors; m++) {
            let wa = workspace.get_work_area_for_monitor(m);
            let monWins = allWindows.filter(win => win.get_monitor() === m);
            if (monWins.length === 0) continue;
            this._autoTileMonitor(workspace, m, monWins, wa.x, wa.y, wa.width, wa.height);
        }
        this._autoTileRestoredRects = null;
    }

    _autoTileMonitor(workspace, monitorIndex, allWindows, x, y, w, h) {
        if (!this.wm_settings.get_boolean('auto-tile')) return;

        const MAX_WINDOWS = 4;

        if (!this._autoTileSlotOrderByMonitor) this._autoTileSlotOrderByMonitor = {};
        if (!this._autoTile3MirroredByMonitor) this._autoTile3MirroredByMonitor = {};
        let monSlotOrder = this._autoTileSlotOrderByMonitor[monitorIndex] || null;
        let monMirrored = this._autoTile3MirroredByMonitor[monitorIndex] || false;

        let tileableWindows = [];
        let floatingWindows = [];
        for (let win of allWindows) {
            if (this._canAutoTileWindow(win, { w, h })) {
                tileableWindows.push(win);
            } else {
                floatingWindows.push(win);
            }
        }

        if (tileableWindows.length > MAX_WINDOWS) {
            let evictWin = null;
            if (monSlotOrder && monSlotOrder.length > 0) {
                let byId = new Map(tileableWindows.map(ww => [ww.get_id(), ww]));
                evictWin = byId.get(monSlotOrder[0]) || tileableWindows[0];
            } else {
                evictWin = tileableWindows[0];
            }
            if (!this._autoTileProgrammaticIds) this._autoTileProgrammaticIds = new Set();
            this._autoTileProgrammaticIds.add(evictWin.get_id());
            evictWin.minimize();
            GLib.timeout_add(GLib.PRIORITY_DEFAULT, 300, () => {
                if (this._autoTileProgrammaticIds)
                    this._autoTileProgrammaticIds.delete(evictWin.get_id());
                return GLib.SOURCE_REMOVE;
            });
            tileableWindows = tileableWindows.filter(ww => ww !== evictWin);
            if (monSlotOrder)
                monSlotOrder = monSlotOrder.filter(id => id !== evictWin.get_id());
            if (this._autoTileCycleIdx)
                this._autoTileCycleIdx.delete(workspace.index());
        }

        let exactMatch = false;
        if (monSlotOrder && monSlotOrder.length === tileableWindows.length) {
            let byId = new Map(tileableWindows.map(ww => [ww.get_id(), ww]));
            let ordered = monSlotOrder.map(id => byId.get(id)).filter(ww => ww != null);
            if (ordered.length === tileableWindows.length) {
                tileableWindows = ordered;
                exactMatch = true;
            }
            else
                monSlotOrder = null;
        }

        if (!exactMatch) {

            tileableWindows.sort((a, b) =>
                a.get_stable_sequence() - b.get_stable_sequence());
        }

        monSlotOrder = tileableWindows.map(ww => ww.get_id());
        this._autoTileSlotOrderByMonitor[monitorIndex] = monSlotOrder;
        let fw0 = global.display.get_focus_window();
        if (monitorIndex === (fw0 ? fw0.get_monitor() : global.display.get_primary_monitor()))
            this._autoTileSlotOrder = monSlotOrder;

        this._disconnectAutoTileResizeSignals();

        if (!this._autoTileSavedRects) this._autoTileSavedRects = new Map();
        if (!this._autoTileOriginalRects) this._autoTileOriginalRects = new Map();
        if (!this._autoTileWinById) this._autoTileWinById = new Map();
        for (let win of allWindows) {
            this._autoTileSavedRects.delete(win.get_id());
            this._autoTileOriginalRects.delete(win.get_id());
            this._autoTileWinById.delete(win.get_id());
        }

        let layout2 = (tileableWindows.length === 2) ? this._autoTile2Layout : 'vertical';
        let mirrored = (tileableWindows.length === 3) ? monMirrored : false;
        let rects = this._autoTileColumnsMode
            ? this._computeColumnRects(tileableWindows.length, x, y, w, h)
            : this._computeAutoTileRects(tileableWindows.length, x, y, w, h, layout2, mirrored);

        this._autoTileSlotOrder = monSlotOrder;

        let restored = this._autoTileRestoredRects;
        let useRestored = false;
        if (restored && exactMatch) {
            useRestored = tileableWindows.every(win => restored.has(win.get_id()));
        }

        if (!this._autoTileProgrammaticIds) this._autoTileProgrammaticIds = new Set();
        for (let win of tileableWindows)
            this._autoTileProgrammaticIds.add(win.get_id());

        let hasNewWindow = tileableWindows.some(win => {
            let actor = win.get_compositor_private();
            return actor && actor._autoTilePendingMap;
        });

        let monGeom = global.display.get_monitor_geometry(monitorIndex);
        let monLeft = monGeom.x;
        let monTop = monGeom.y;
        let monRight = monGeom.x + monGeom.width;
        let monBottom = monGeom.y + monGeom.height;
        let EXPAND_MS = 380;
        let CROSSFADE_MS = 200;

        for (let i = 0; i < tileableWindows.length; i++) {
            let win = tileableWindows[i];
            let id = win.get_id();
            let r;
            if (useRestored) {
                let sr = restored.get(id);
                r = { x: sr.x, y: sr.y, w: sr.width, h: sr.height };
            } else {
                r = rects[i];
            }
            if (win.get_maximized())
                win.unmaximize(Meta.MaximizeFlags.BOTH);

            let actor = win.get_compositor_private();

            if (actor && actor._autoTilePendingMap) {
          
                win.move_resize_frame(false, r.x, r.y, r.w, r.h);
                delete actor._autoTilePendingMap;

                let cx = r.x + r.w / 2;
                let cy = r.y + r.h / 2;
                let distLeft = cx - monLeft;
                let distRight = monRight - cx;
                let distTop = cy - monTop;
                let distBottom = monBottom - cy;
                let minDist = Math.min(distLeft, distRight, distTop, distBottom);

                let pivotX = 0.5, pivotY = 0.5;
                let startScaleX = 1, startScaleY = 1;

                if (minDist === distLeft) {
                    pivotX = 0; pivotY = 0.5;
                    startScaleX = 0.02;
                } else if (minDist === distRight) {
                    pivotX = 1; pivotY = 0.5;
                    startScaleX = 0.02;
                } else if (minDist === distTop) {
                    pivotX = 0.5; pivotY = 0;
                    startScaleY = 0.02;
                } else {
                    pivotX = 0.5; pivotY = 1;
                    startScaleY = 0.02;
                }

                actor.remove_all_transitions();
                actor.set_pivot_point(pivotX, pivotY);
                actor.scale_x = startScaleX;
                actor.scale_y = startScaleY;
                actor.opacity = 255;
                actor.show();

                actor.ease({
                    scale_x: 1.0,
                    scale_y: 1.0,
                    duration: EXPAND_MS,
                    mode: Clutter.AnimationMode.EASE_OUT_EXPO,
                    onStopped: () => {
                        actor.set_pivot_point(0, 0);
                        actor.scale_x = 1;
                        actor.scale_y = 1;
                    },
                });

            } else if (hasNewWindow && actor) {

                actor.remove_all_transitions();
                actor.opacity = 0;
                win.move_resize_frame(false, r.x, r.y, r.w, r.h);
                actor.ease({
                    opacity: 255,
                    duration: CROSSFADE_MS,
                    mode: Clutter.AnimationMode.EASE_OUT_QUAD,
                });

            } else {
           
                win.move_resize_frame(false, r.x, r.y, r.w, r.h);
            }

            this._autoTileSavedRects.set(id, { x: r.x, y: r.y, width: r.w, height: r.h });
            this._autoTileOriginalRects.set(id, { width: r.w, height: r.h });
            this._autoTileWinById.set(id, win);
        }

        this._autoTileDestroyDragHandles();
        this._connectAutoTileResizeSignals(tileableWindows);

        for (let win of floatingWindows) {
            if (win.get_maximized())
                win.unmaximize(Meta.MaximizeFlags.BOTH);

            let actor = win.get_compositor_private();
            if (actor && actor._autoTilePendingMap) {
                delete actor._autoTilePendingMap;
                actor.remove_all_transitions();
                actor.set_pivot_point(0.5, 0.5);
                actor.scale_x = 0.94;
                actor.scale_y = 0.94;
                actor.opacity = 0;
                actor.show();
                actor.ease({
                    opacity: 255,
                    scale_x: 1,
                    scale_y: 1,
                    duration: 200,
                    mode: Clutter.AnimationMode.EASE_OUT_QUAD,
                    onStopped: () => {
                        actor.set_pivot_point(0, 0);
                        actor.scale_x = 1;
                        actor.scale_y = 1;
                    },
                });
            }
        }

        {
            let refreshDelay = hasNewWindow ? EXPAND_MS + 50 : 50;
            GLib.timeout_add(GLib.PRIORITY_DEFAULT, refreshDelay, () => {
                this._tileBorderNewWindowPending = false;
                this._refreshTileBorder();
                return GLib.SOURCE_REMOVE;
            });
        }

        if (tileableWindows.length >= 2) {
            GLib.timeout_add(GLib.PRIORITY_DEFAULT, 100, () => {
                this._autoTileCreateDragHandles();
                return GLib.SOURCE_REMOVE;
            });
        }

        GLib.timeout_add(GLib.PRIORITY_DEFAULT, 300, () => {
            if (this._autoTileProgrammaticIds) {
                for (let win of tileableWindows)
                    this._autoTileProgrammaticIds.delete(win.get_id());
            }
            return GLib.SOURCE_REMOVE;
        });
    }

    _autoTilePreviewMinimized(direction) {
        if (!this.wm_settings.get_boolean('auto-tile')) return;

        let workspace = global.workspace_manager.get_active_workspace();
        if (!workspace) return;

        let tiledWins = this._autoTileGetTiledWindows(global.display.get_focus_window() ? global.display.get_focus_window().get_monitor() : global.display.get_primary_monitor());

        if (this._autoTilePreviewWin) return;

        let effectiveCount = tiledWins.length;
        if (effectiveCount >= 4) return;

        if (effectiveCount === 0) {
            let pool = workspace.list_windows().filter(win => {
                if (win.get_window_type() !== Meta.WindowType.NORMAL) return false;
                if (win.is_skip_taskbar()) return false;
                if (!win.minimized) return false;
                let wmClass = win.get_wm_class() || '';
                if (wmClass !== '') {
                    let excl = this.wm_settings.get_strv('auto-tile-excludelist');
                    if (excl.includes(wmClass)) return false;
                }
                return true;
            });
            pool.sort((a, b) => a.get_stable_sequence() - b.get_stable_sequence());
            if (pool.length === 0) return;

            this._autoTilePreviewPool = pool;
            this._autoTilePreviewIdx = 0;
            let incoming = pool[0];
            let iid = incoming.get_id();

            let monitorIndex = global.display.get_primary_monitor();
            let workArea = workspace.get_work_area_for_monitor(monitorIndex);
            let rect = { x: workArea.x, y: workArea.y,
                         width: workArea.width, height: workArea.height };

            if (!this._autoTileSavedRects) this._autoTileSavedRects = new Map();
            if (!this._autoTileOriginalRects) this._autoTileOriginalRects = new Map();
            if (!this._autoTileWinById) this._autoTileWinById = new Map();
            this._autoTileSavedRects.set(iid, rect);
            this._autoTileOriginalRects.set(iid, { width: rect.width, height: rect.height });
            this._autoTileWinById.set(iid, incoming);
            this._autoTileSlotOrder = [iid];

            this._autoTilePreviewWin = incoming;
            this._autoTileCyclePending = true;

            if (!this._autoTileProgrammaticIds) this._autoTileProgrammaticIds = new Set();
            this._autoTileProgrammaticIds.add(iid);

            incoming.unminimize();

            GLib.timeout_add(GLib.PRIORITY_DEFAULT, 80, () => {
                try {
                    incoming.move_resize_frame(false,
                        rect.x, rect.y, rect.width, rect.height);
                } catch (e) { }
                GLib.timeout_add(GLib.PRIORITY_DEFAULT, 80, () => {
                    try { incoming.activate(global.get_current_time()); } catch (e) { }
                    if (this._autoTileProgrammaticIds)
                        this._autoTileProgrammaticIds.delete(iid);
                    return GLib.SOURCE_REMOVE;
                });
                return GLib.SOURCE_REMOVE;
            });
            return;
        }

        if (effectiveCount === 1) {
            let currentWin = tiledWins[0];

            let pool = workspace.list_windows().filter(win => {
                if (win.get_window_type() !== Meta.WindowType.NORMAL) return false;
                if (win.is_skip_taskbar()) return false;
                if (!win.minimized) return false;
                let wmClass = win.get_wm_class() || '';
                if (wmClass !== '') {
                    let excl = this.wm_settings.get_strv('auto-tile-excludelist');
                    if (excl.includes(wmClass)) return false;
                }
                return true;
            });
            pool.sort((a, b) => a.get_id() - b.get_id());
            if (pool.length === 0) return;

            this._autoTilePreviewPool = pool;
            this._autoTilePreviewAnchorWin = currentWin;

            if (this._autoTilePreviewIdx < 0) {
                this._autoTilePreviewIdx = direction === 'up' ? 0 : pool.length - 1;
            } else {
                if (direction === 'up') {
                    this._autoTilePreviewIdx =
                        (this._autoTilePreviewIdx + 1) % pool.length;
                } else {
                    this._autoTilePreviewIdx =
                        (this._autoTilePreviewIdx - 1 + pool.length) % pool.length;
                }
            }

            let incoming = pool[this._autoTilePreviewIdx];

            let prevPreview = this._autoTilePreviewWin;
            if (prevPreview && prevPreview !== incoming) {
                if (!this._autoTileProgrammaticIds) this._autoTileProgrammaticIds = new Set();
                this._autoTileProgrammaticIds.add(prevPreview.get_id());
                prevPreview.minimize();
                GLib.timeout_add(GLib.PRIORITY_DEFAULT, 80, () => {
                    if (this._autoTileProgrammaticIds)
                        this._autoTileProgrammaticIds.delete(prevPreview.get_id());
                    return GLib.SOURCE_REMOVE;
                });
            }

            this._autoTilePreviewWin = incoming;

            this._autoTileCyclePending = true;
            if (!this._autoTileProgrammaticIds) this._autoTileProgrammaticIds = new Set();
            let cid = currentWin.get_id();
            let iid = incoming.get_id();
            this._autoTileProgrammaticIds.add(cid);
            this._autoTileProgrammaticIds.add(iid);

            if (incoming.minimized) incoming.unminimize();

            GLib.timeout_add(GLib.PRIORITY_DEFAULT, 80, () => {
                let monitorIndex = (global.display.get_focus_window() ? global.display.get_focus_window().get_monitor() : global.display.get_primary_monitor());
                let workArea = workspace.get_work_area_for_monitor(monitorIndex);
                let layout2 = this._autoTile2Layout || 'vertical';
                let rects = this._computeAutoTileRects(2,
                    workArea.x, workArea.y, workArea.width, workArea.height, layout2);

                try {
                    currentWin.move_resize_frame(false,
                        rects[0].x, rects[0].y, rects[0].w, rects[0].h);
                } catch (e) { }
                try {
                    incoming.move_resize_frame(false,
                        rects[1].x, rects[1].y, rects[1].w, rects[1].h);
                } catch (e) { }

                if (!this._autoTileSavedRects) this._autoTileSavedRects = new Map();
                this._autoTileSavedRects.set(cid,
                    { x: rects[0].x, y: rects[0].y, width: rects[0].w, height: rects[0].h });
                this._autoTileSavedRects.set(iid,
                    { x: rects[1].x, y: rects[1].y, width: rects[1].w, height: rects[1].h });

                if (!this._autoTileWinById) this._autoTileWinById = new Map();
                this._autoTileWinById.set(cid, currentWin);
                this._autoTileWinById.set(iid, incoming);
                this._autoTileSlotOrder = [cid, iid];
                if (!this._autoTileOriginalRects) this._autoTileOriginalRects = new Map();
                this._autoTileOriginalRects.set(cid, { width: rects[0].w, height: rects[0].h });
                this._autoTileOriginalRects.set(iid, { width: rects[1].w, height: rects[1].h });

                this._disconnectAutoTileResizeSignals();
                this._autoTileDestroyDragHandles();
                this._connectAutoTileResizeSignals([currentWin, incoming]);
                GLib.timeout_add(GLib.PRIORITY_DEFAULT, 50, () => {
                    this._autoTileCreateDragHandles();
                    return GLib.SOURCE_REMOVE;
                });

                GLib.timeout_add(GLib.PRIORITY_DEFAULT, 80, () => {
                    try { currentWin.activate(global.get_current_time()); } catch (e) { }
                    return GLib.SOURCE_REMOVE;
                });
                return GLib.SOURCE_REMOVE;
            });
            return;
        }

        if (effectiveCount === 2) {

            let pool = workspace.list_windows().filter(win => {
                if (win.get_window_type() !== Meta.WindowType.NORMAL) return false;
                if (win.is_skip_taskbar()) return false;
                if (!win.minimized) return false;
                let wmClass = win.get_wm_class() || '';
                if (wmClass !== '') {
                    let excl = this.wm_settings.get_strv('auto-tile-excludelist');
                    if (excl.includes(wmClass)) return false;
                }
                return true;
            });
            pool.sort((a, b) => a.get_id() - b.get_id());
            if (pool.length === 0) return;

            if (this._autoTilePreviewIdx < 0) {
                this._autoTilePreviewIdx = direction === 'up' ? 0 : pool.length - 1;
            } else {
                if (direction === 'up') {
                    this._autoTilePreviewIdx = (this._autoTilePreviewIdx + 1) % pool.length;
                } else {
                    this._autoTilePreviewIdx = (this._autoTilePreviewIdx - 1 + pool.length) % pool.length;
                }
            }

            let incoming = pool[this._autoTilePreviewIdx];

            let prevPreview = this._autoTilePreviewWin;
            if (prevPreview && prevPreview !== incoming) {
                if (!this._autoTileProgrammaticIds) this._autoTileProgrammaticIds = new Set();
                this._autoTileProgrammaticIds.add(prevPreview.get_id());
                prevPreview.minimize();
                GLib.timeout_add(GLib.PRIORITY_DEFAULT, 80, () => {
                    if (this._autoTileProgrammaticIds)
                        this._autoTileProgrammaticIds.delete(prevPreview.get_id());
                    return GLib.SOURCE_REMOVE;
                });
            }

            this._autoTilePreviewPool = pool;
            this._autoTilePreviewAnchorWin = tiledWins[0];

            this._autoTilePreviewWin = incoming;
            this._autoTileCyclePending = true;
            if (!this._autoTileProgrammaticIds) this._autoTileProgrammaticIds = new Set();

            let existingIds = tiledWins.map(w => w.get_id());
            let iid = incoming.get_id();
            existingIds.forEach(id => this._autoTileProgrammaticIds.add(id));
            this._autoTileProgrammaticIds.add(iid);

            if (incoming.minimized) incoming.unminimize();

            GLib.timeout_add(GLib.PRIORITY_DEFAULT, 80, () => {
                let monitorIndex = (global.display.get_focus_window() ? global.display.get_focus_window().get_monitor() : global.display.get_primary_monitor());
                let workArea = workspace.get_work_area_for_monitor(monitorIndex);

                let rects = this._computeAutoTileRects(3,
                    workArea.x, workArea.y, workArea.width, workArea.height,
                    'vertical', true);

                let ordered = [];
                if (this._autoTileSlotOrder) {
                    let byId = new Map(tiledWins.map(w => [w.get_id(), w]));
                    ordered = this._autoTileSlotOrder
                        .map(id => byId.get(id)).filter(w => w != null);
                }
                if (ordered.length !== 2) ordered = tiledWins.slice();

                try {
                    ordered[0].move_resize_frame(false,
                        rects[1].x, rects[1].y, rects[1].w, rects[1].h);
                } catch (e) { }
                try {
                    ordered[1].move_resize_frame(false,
                        rects[2].x, rects[2].y, rects[2].w, rects[2].h);
                } catch (e) { }

                try {
                    incoming.move_resize_frame(false,
                        rects[0].x, rects[0].y, rects[0].w, rects[0].h);
                } catch (e) { }

                if (!this._autoTileSavedRects) this._autoTileSavedRects = new Map();
                if (!this._autoTileOriginalRects) this._autoTileOriginalRects = new Map();
                if (!this._autoTileWinById) this._autoTileWinById = new Map();

                this._autoTileSavedRects.set(ordered[0].get_id(),
                    { x: rects[1].x, y: rects[1].y, width: rects[1].w, height: rects[1].h });
                this._autoTileSavedRects.set(ordered[1].get_id(),
                    { x: rects[2].x, y: rects[2].y, width: rects[2].w, height: rects[2].h });
                this._autoTileSavedRects.set(iid,
                    { x: rects[0].x, y: rects[0].y, width: rects[0].w, height: rects[0].h });

                this._autoTileOriginalRects.set(ordered[0].get_id(),
                    { width: rects[1].w, height: rects[1].h });
                this._autoTileOriginalRects.set(ordered[1].get_id(),
                    { width: rects[2].w, height: rects[2].h });
                this._autoTileOriginalRects.set(iid,
                    { width: rects[0].w, height: rects[0].h });

                this._autoTileWinById.set(ordered[0].get_id(), ordered[0]);
                this._autoTileWinById.set(ordered[1].get_id(), ordered[1]);
                this._autoTileWinById.set(iid, incoming);

                this._autoTileSlotOrder = [
                    ordered[0].get_id(), ordered[1].get_id(), iid
                ];

                this._disconnectAutoTileResizeSignals();
                this._autoTileDestroyDragHandles();
                this._connectAutoTileResizeSignals([ordered[0], ordered[1], incoming]);
                GLib.timeout_add(GLib.PRIORITY_DEFAULT, 50, () => {
                    this._autoTileCreateDragHandles();
                    return GLib.SOURCE_REMOVE;
                });

                let focusWin = global.display.get_focus_window();
                if (!focusWin || !tiledWins.includes(focusWin))
                    focusWin = ordered[0];
                GLib.timeout_add(GLib.PRIORITY_DEFAULT, 80, () => {
                    try { focusWin.activate(global.get_current_time()); } catch (e) { }
                    return GLib.SOURCE_REMOVE;
                });
                return GLib.SOURCE_REMOVE;
            });
            return;
        }

        if (effectiveCount === 3) {
      
            let pool = workspace.list_windows().filter(win => {
                if (win.get_window_type() !== Meta.WindowType.NORMAL) return false;
                if (win.is_skip_taskbar()) return false;
                if (!win.minimized) return false;
                let wmClass = win.get_wm_class() || '';
                if (wmClass !== '') {
                    let excl = this.wm_settings.get_strv('auto-tile-excludelist');
                    if (excl.includes(wmClass)) return false;
                }
                return true;
            });
            pool.sort((a, b) => a.get_id() - b.get_id());
            if (pool.length === 0) return;

            if (this._autoTilePreviewIdx < 0) {
                this._autoTilePreviewIdx = direction === 'up' ? 0 : pool.length - 1;
            } else {
                if (direction === 'up') {
                    this._autoTilePreviewIdx = (this._autoTilePreviewIdx + 1) % pool.length;
                } else {
                    this._autoTilePreviewIdx = (this._autoTilePreviewIdx - 1 + pool.length) % pool.length;
                }
            }

            let incoming = pool[this._autoTilePreviewIdx];

            let prevPreview = this._autoTilePreviewWin;
            if (prevPreview && prevPreview !== incoming) {
                if (!this._autoTileProgrammaticIds) this._autoTileProgrammaticIds = new Set();
                this._autoTileProgrammaticIds.add(prevPreview.get_id());
                prevPreview.minimize();
                GLib.timeout_add(GLib.PRIORITY_DEFAULT, 80, () => {
                    if (this._autoTileProgrammaticIds)
                        this._autoTileProgrammaticIds.delete(prevPreview.get_id());
                    return GLib.SOURCE_REMOVE;
                });
            }

            this._autoTilePreviewPool = pool;
            this._autoTilePreviewAnchorWin = tiledWins[0];

            this._autoTilePreviewWin = incoming;
            this._autoTileCyclePending = true;
            if (!this._autoTileProgrammaticIds) this._autoTileProgrammaticIds = new Set();

            let iid = incoming.get_id();
            tiledWins.forEach(w => this._autoTileProgrammaticIds.add(w.get_id()));
            this._autoTileProgrammaticIds.add(iid);

            if (incoming.minimized) incoming.unminimize();

            GLib.timeout_add(GLib.PRIORITY_DEFAULT, 80, () => {
                let monitorIndex = (global.display.get_focus_window() ? global.display.get_focus_window().get_monitor() : global.display.get_primary_monitor());
                let workArea = workspace.get_work_area_for_monitor(monitorIndex);

                let rects = this._computeAutoTileRects(4,
                    workArea.x, workArea.y, workArea.width, workArea.height);

                let ordered = [];
                if (this._autoTileSlotOrder) {
                    let byId = new Map(tiledWins.map(w => [w.get_id(), w]));
                    ordered = this._autoTileSlotOrder
                        .map(id => byId.get(id)).filter(w => w != null);
                }
                if (ordered.length !== 3) ordered = tiledWins.slice();

                for (let i = 0; i < 3; i++) {
                    try {
                        ordered[i].move_resize_frame(false,
                            rects[i].x, rects[i].y, rects[i].w, rects[i].h);
                    } catch (e) { }
                }
                try {
                    incoming.move_resize_frame(false,
                        rects[3].x, rects[3].y, rects[3].w, rects[3].h);
                } catch (e) { }

                if (!this._autoTileSavedRects) this._autoTileSavedRects = new Map();
                if (!this._autoTileOriginalRects) this._autoTileOriginalRects = new Map();
                if (!this._autoTileWinById) this._autoTileWinById = new Map();

                for (let i = 0; i < 3; i++) {
                    let wid = ordered[i].get_id();
                    this._autoTileSavedRects.set(wid,
                        { x: rects[i].x, y: rects[i].y, width: rects[i].w, height: rects[i].h });
                    this._autoTileOriginalRects.set(wid,
                        { width: rects[i].w, height: rects[i].h });
                    this._autoTileWinById.set(wid, ordered[i]);
                }
                this._autoTileSavedRects.set(iid,
                    { x: rects[3].x, y: rects[3].y, width: rects[3].w, height: rects[3].h });
                this._autoTileOriginalRects.set(iid,
                    { width: rects[3].w, height: rects[3].h });
                this._autoTileWinById.set(iid, incoming);

                this._autoTileSlotOrder = [
                    ordered[0].get_id(), ordered[1].get_id(), ordered[2].get_id(), iid
                ];

                this._disconnectAutoTileResizeSignals();
                this._autoTileDestroyDragHandles();
                this._connectAutoTileResizeSignals([...ordered, incoming]);
                GLib.timeout_add(GLib.PRIORITY_DEFAULT, 50, () => {
                    this._autoTileCreateDragHandles();
                    return GLib.SOURCE_REMOVE;
                });

                let focusWin = global.display.get_focus_window();
                if (!focusWin || !tiledWins.includes(focusWin))
                    focusWin = ordered[0];
                GLib.timeout_add(GLib.PRIORITY_DEFAULT, 80, () => {
                    try { focusWin.activate(global.get_current_time()); } catch (e) { }
                    return GLib.SOURCE_REMOVE;
                });
                return GLib.SOURCE_REMOVE;
            });
            return;
        }
    }

    _autoTilePreviewConfirm() {
        if (!this._autoTilePreviewWin) return;

        let win = this._autoTilePreviewWin;
        let workspace = global.workspace_manager.get_active_workspace();

        let tiledWins = this._autoTileGetTiledWindows(global.display.get_focus_window() ? global.display.get_focus_window().get_monitor() : global.display.get_primary_monitor());
        let confirmedCount = tiledWins.length; 

        if (confirmedCount === 3) {
            this._autoTile3Mirrored = true;
        }

        this._autoTilePreviewWin = null;
        this._autoTilePreviewRect = null;
        this._autoTilePreviewPool = null;
        this._autoTilePreviewAnchorWin = null;
        this._autoTileCyclePending = false;
        let iid = win.get_id();
        if (this._autoTileProgrammaticIds)
            this._autoTileProgrammaticIds.delete(iid);
        this._autoTilePreviewIdx = -1;

        GLib.timeout_add(GLib.PRIORITY_DEFAULT, 50, () => {
            if (this._autoTileProgrammaticIds)
                this._autoTileProgrammaticIds.clear();
            if (workspace) this._autoTileWorkspace(workspace);
            GLib.timeout_add(GLib.PRIORITY_DEFAULT, 80, () => {
                try { win.activate(global.get_current_time()); } catch (e) { }
                return GLib.SOURCE_REMOVE;
            });
            return GLib.SOURCE_REMOVE;
        });
    }

    _autoTilePreviewCancel() {
        if (!this._autoTilePreviewWin) return;

        let previewWin = this._autoTilePreviewWin;
        let workspace = global.workspace_manager.get_active_workspace();

        let tiledWins = this._autoTileGetTiledWindows(global.display.get_focus_window() ? global.display.get_focus_window().get_monitor() : global.display.get_primary_monitor());
        let returnCount = tiledWins.length - 1; 

        this._autoTilePreviewWin = null;
        this._autoTilePreviewRect = null;
        this._autoTilePreviewIdx = -1;
        this._autoTilePreviewPool = null;
        this._autoTilePreviewAnchorWin = null;
        this._autoTileCyclePending = false;

        if (returnCount !== 3) this._autoTile3Mirrored = false;

        if (!this._autoTileProgrammaticIds) this._autoTileProgrammaticIds = new Set();
        this._autoTileProgrammaticIds.add(previewWin.get_id());

        previewWin.minimize();

        GLib.timeout_add(GLib.PRIORITY_DEFAULT, 80, () => {
            if (this._autoTileProgrammaticIds)
                this._autoTileProgrammaticIds.delete(previewWin.get_id());

            if (workspace) this._autoTileWorkspace(workspace);
            return GLib.SOURCE_REMOVE;
        });
    }

    _autoTilePreviewCycle(direction) {
        let workspace = global.workspace_manager.get_active_workspace();
        if (!workspace || !this._autoTilePreviewWin) return;

        if (this._autoTilePreviewAnchorWin) {
            let pool = this._autoTilePreviewPool;
            if (!pool || pool.length < 2) return;

            let prevWin = this._autoTilePreviewWin;
            let prevId = prevWin.get_id();

            let tiledWins = this._autoTileGetTiledWindows(
                global.display.get_focus_window()
                    ? global.display.get_focus_window().get_monitor()
                    : global.display.get_primary_monitor()
            ).filter(w => w !== prevWin);

            if (direction === 'right') {
                this._autoTilePreviewIdx = (this._autoTilePreviewIdx + 1) % pool.length;
            } else {
                this._autoTilePreviewIdx = (this._autoTilePreviewIdx - 1 + pool.length) % pool.length;
            }

            let incoming = pool[this._autoTilePreviewIdx];
            if (incoming === prevWin) return;

            this._autoTilePreviewWin = incoming;

            if (!this._autoTileProgrammaticIds) this._autoTileProgrammaticIds = new Set();
            let iid = incoming.get_id();
            this._autoTileProgrammaticIds.add(prevId);
            this._autoTileProgrammaticIds.add(iid);
            tiledWins.forEach(w => this._autoTileProgrammaticIds.add(w.get_id()));

            if (incoming.minimized) incoming.unminimize();

            GLib.timeout_add(GLib.PRIORITY_DEFAULT, 80, () => {
                let monitorIndex = (global.display.get_focus_window()
                    ? global.display.get_focus_window().get_monitor()
                    : global.display.get_primary_monitor());
                let workArea = workspace.get_work_area_for_monitor(monitorIndex);

                let totalCount = tiledWins.length + 1;
                let layout2 = this._autoTile2Layout || 'vertical';
                let rects = this._computeAutoTileRects(totalCount,
                    workArea.x, workArea.y, workArea.width, workArea.height,
                    layout2, totalCount === 3);

                let ordered = [];
                if (this._autoTileSlotOrder) {
                    let byId = new Map(tiledWins.map(w => [w.get_id(), w]));
                    ordered = this._autoTileSlotOrder
                        .filter(id => id !== prevId)
                        .map(id => byId.get(id))
                        .filter(w => w != null);
                }
                if (ordered.length !== tiledWins.length) ordered = tiledWins.slice();

                if (!this._autoTileSavedRects) this._autoTileSavedRects = new Map();
                if (!this._autoTileOriginalRects) this._autoTileOriginalRects = new Map();
                if (!this._autoTileWinById) this._autoTileWinById = new Map();

                for (let i = 0; i < ordered.length; i++) {
                    try {
                        ordered[i].move_resize_frame(false,
                            rects[i].x, rects[i].y, rects[i].w, rects[i].h);
                    } catch (e) { }
                    let wid = ordered[i].get_id();
                    this._autoTileSavedRects.set(wid,
                        { x: rects[i].x, y: rects[i].y, width: rects[i].w, height: rects[i].h });
                    this._autoTileOriginalRects.set(wid, { width: rects[i].w, height: rects[i].h });
                    this._autoTileWinById.set(wid, ordered[i]);
                }

                let lastRect = rects[ordered.length];
                try {
                    incoming.move_resize_frame(false,
                        lastRect.x, lastRect.y, lastRect.w, lastRect.h);
                } catch (e) { }
                this._autoTileSavedRects.set(iid,
                    { x: lastRect.x, y: lastRect.y, width: lastRect.w, height: lastRect.h });
                this._autoTileOriginalRects.set(iid, { width: lastRect.w, height: lastRect.h });
                this._autoTileWinById.set(iid, incoming);
                this._autoTileSavedRects.delete(prevId);
                this._autoTileWinById.delete(prevId);

                this._autoTileSlotOrder = [...ordered.map(w => w.get_id()), iid];

                prevWin.minimize();

                this._disconnectAutoTileResizeSignals();
                this._autoTileDestroyDragHandles();
                this._connectAutoTileResizeSignals([...ordered, incoming]);
                GLib.timeout_add(GLib.PRIORITY_DEFAULT, 50, () => {
                    this._autoTileCreateDragHandles();
                    return GLib.SOURCE_REMOVE;
                });

                GLib.timeout_add(GLib.PRIORITY_DEFAULT, 80, () => {
                    if (this._autoTileProgrammaticIds) {
                        this._autoTileProgrammaticIds.delete(prevId);
                        this._autoTileProgrammaticIds.delete(iid);
                        tiledWins.forEach(w => this._autoTileProgrammaticIds.delete(w.get_id()));
                    }

                    let focusTarget = ordered[0] || tiledWins[0];
                    if (focusTarget) {
                        try { focusTarget.activate(global.get_current_time()); } catch (e) { }
                    }
                    return GLib.SOURCE_REMOVE;
                });
                return GLib.SOURCE_REMOVE;
            });
            return;
        }

        let pool = this._autoTilePreviewPool;
        if (!pool || pool.length === 0) {
     
            pool = workspace.list_windows().filter(win => {
                if (win.get_window_type() !== Meta.WindowType.NORMAL) return false;
                if (win.is_skip_taskbar()) return false;
                let wmClass = win.get_wm_class() || '';
                if (wmClass !== '') {
                    let excl = this.wm_settings.get_strv('auto-tile-excludelist');
                    if (excl.includes(wmClass)) return false;
                }
                return true;
            });
            pool.sort((a, b) => a.get_stable_sequence() - b.get_stable_sequence());
            this._autoTilePreviewPool = pool;
        }
        if (pool.length < 2) return;

        let prevWin = this._autoTilePreviewWin;

        if (direction === 'right') {
            this._autoTilePreviewIdx = (this._autoTilePreviewIdx + 1) % pool.length;
        } else {
            this._autoTilePreviewIdx = (this._autoTilePreviewIdx - 1 + pool.length) % pool.length;
        }

        let incoming = pool[this._autoTilePreviewIdx];
        if (incoming === prevWin) return;

        let previewRect = this._autoTileSavedRects
            ? this._autoTileSavedRects.get(prevWin.get_id())
            : null;
        if (!previewRect) return;

        this._autoTilePreviewWin = incoming;

        if (!this._autoTileProgrammaticIds) this._autoTileProgrammaticIds = new Set();
        let pid = prevWin.get_id();
        let iid = incoming.get_id();
        this._autoTileProgrammaticIds.add(pid);
        this._autoTileProgrammaticIds.add(iid);

        if (incoming.minimized) incoming.unminimize();

        GLib.timeout_add(GLib.PRIORITY_DEFAULT, 80, () => {

            try {
                incoming.move_resize_frame(false,
                    previewRect.x, previewRect.y,
                    previewRect.width, previewRect.height);
            } catch (e) { }

            prevWin.minimize();

            if (this._autoTileSavedRects) {
                this._autoTileSavedRects.set(iid, previewRect);
                this._autoTileSavedRects.delete(pid);
            }
            if (this._autoTileWinById) {
                this._autoTileWinById.set(iid, incoming);
                this._autoTileWinById.delete(pid);
            }

            if (this._autoTileSlotOrder) {
                let si = this._autoTileSlotOrder.indexOf(pid);
                if (si >= 0) this._autoTileSlotOrder[si] = iid;
            }

            GLib.timeout_add(GLib.PRIORITY_DEFAULT, 80, () => {
                if (this._autoTileProgrammaticIds) {
                    this._autoTileProgrammaticIds.delete(pid);
                    this._autoTileProgrammaticIds.delete(iid);
                }

                let tiledWins = this._autoTileGetTiledWindows(global.display.get_focus_window() ? global.display.get_focus_window().get_monitor() : global.display.get_primary_monitor());
                let focusTarget = tiledWins.find(w => w !== incoming);
                if (focusTarget) {
                    try { focusTarget.activate(global.get_current_time()); } catch (e) { }
                }
                return GLib.SOURCE_REMOVE;
            });
            return GLib.SOURCE_REMOVE;
        });
    }

    _autoTileCycleMinimized(direction) {
        if (!this.wm_settings.get_boolean('auto-tile')) return;

        if (this._autoTilePreviewWin) {
            this._autoTilePreviewCycle(direction);
            return;
        }

        let workspace = global.workspace_manager.get_active_workspace();
        if (!workspace) return;

        let wsIdx = workspace.index();

        let allWins = workspace.list_windows().filter(win => {
            if (win.get_window_type() !== Meta.WindowType.NORMAL) return false;
            if (win.is_skip_taskbar()) return false;
            let wmClass = win.get_wm_class() || '';
            if (wmClass !== '') {
                let excl = this.wm_settings.get_strv('auto-tile-excludelist');
                if (excl.includes(wmClass)) return false;
            }
            return true;
        });
        allWins.sort((a, b) => a.get_stable_sequence() - b.get_stable_sequence());

        if (allWins.length < 2) return;

        let tiledWins = this._autoTileGetTiledWindows(global.display.get_focus_window() ? global.display.get_focus_window().get_monitor() : global.display.get_primary_monitor());

        if (tiledWins.length === 1) {
            let currentWin = tiledWins[0];

            let curRingIdx = allWins.findIndex(w => w === currentWin);
            if (curRingIdx < 0) return;

            let idx = this._autoTileCycleIdx.has(wsIdx)
                ? this._autoTileCycleIdx.get(wsIdx)
                : curRingIdx;

            let steps = 0;
            do {
                if (direction === 'right') idx = (idx + 1) % allWins.length;
                else idx = (idx - 1 + allWins.length) % allWins.length;
                steps++;
            } while (allWins[idx] === currentWin && steps < allWins.length);

            if (allWins[idx] === currentWin) return; 
            this._autoTileCycleIdx.set(wsIdx, idx);

            let incoming = allWins[idx];

            if (!this._autoTileProgrammaticIds) this._autoTileProgrammaticIds = new Set();
            let cid = currentWin.get_id();
            let iid = incoming.get_id();
            this._autoTileProgrammaticIds.add(cid);
            this._autoTileProgrammaticIds.add(iid);

            if (incoming.minimized) incoming.unminimize();
            currentWin.minimize();

            GLib.timeout_add(GLib.PRIORITY_DEFAULT, 80, () => {
                this._autoTileWorkspace(workspace);
                GLib.timeout_add(GLib.PRIORITY_DEFAULT, 80, () => {
                    try { incoming.activate(global.get_current_time()); } catch (e) { }
                    if (this._autoTileProgrammaticIds) {
                        this._autoTileProgrammaticIds.delete(cid);
                        this._autoTileProgrammaticIds.delete(iid);
                    }
                    return GLib.SOURCE_REMOVE;
                });
                return GLib.SOURCE_REMOVE;
            });
            return;
        }

        if (tiledWins.length === 2) {

            let focusWin = global.display.get_focus_window();
            if (!focusWin || !tiledWins.includes(focusWin)) return;
            let focusId = focusWin.get_id();

            let partnerWin = tiledWins.find(w => w !== focusWin);
            if (!partnerWin) return;

            let hasMinimized = allWins.some(w => w.minimized);
            if (!hasMinimized) return;

            let ring = allWins.filter(w => w.get_id() !== focusId);
            if (ring.length === 0) return;

            let partnerRingIdx = ring.findIndex(w => w === partnerWin);

            let idx = this._autoTileCycleIdx.has(wsIdx)
                ? this._autoTileCycleIdx.get(wsIdx)
                : (partnerRingIdx >= 0 ? partnerRingIdx : 0);

            let steps = 0;
            do {
                if (direction === 'right') idx = (idx + 1) % ring.length;
                else idx = (idx - 1 + ring.length) % ring.length;
                steps++;
            } while (ring[idx] === partnerWin && steps < ring.length);

            if (ring[idx] === partnerWin) return; 
            this._autoTileCycleIdx.set(wsIdx, idx);

            let incoming = ring[idx];

            let partnerRect = this._autoTileSavedRects
                ? this._autoTileSavedRects.get(partnerWin.get_id())
                : null;
            if (!partnerRect) {
                let fr = partnerWin.get_frame_rect();
                partnerRect = { x: fr.x, y: fr.y, width: fr.width, height: fr.height };
            }
      
            let focusRect = this._autoTileSavedRects
                ? this._autoTileSavedRects.get(focusId)
                : null;
            if (!focusRect) {
                let fr = focusWin.get_frame_rect();
                focusRect = { x: fr.x, y: fr.y, width: fr.width, height: fr.height };
            }

            if (!this._autoTileProgrammaticIds) this._autoTileProgrammaticIds = new Set();
            let pid = partnerWin.get_id();
            let iid = incoming.get_id();
            this._autoTileProgrammaticIds.add(focusId);
            this._autoTileProgrammaticIds.add(pid);
            this._autoTileProgrammaticIds.add(iid);
            this._autoTileCyclePending = true;

            if (this._autoTileCycleEndId) {
                GLib.source_remove(this._autoTileCycleEndId);
                this._autoTileCycleEndId = null;
            }

            if (incoming.minimized) incoming.unminimize();

            GLib.timeout_add(GLib.PRIORITY_DEFAULT, 80, () => {
                try {
                    incoming.move_resize_frame(false,
                        partnerRect.x, partnerRect.y,
                        partnerRect.width, partnerRect.height);
                } catch (e) { }

                partnerWin.minimize();

                try {
                    focusWin.move_resize_frame(false,
                        focusRect.x, focusRect.y,
                        focusRect.width, focusRect.height);
                } catch (e) { }

                if (this._autoTileSavedRects) {
                    this._autoTileSavedRects.set(iid,
                        {
                            x: partnerRect.x, y: partnerRect.y,
                            width: partnerRect.width, height: partnerRect.height
                        });
                    this._autoTileSavedRects.set(focusId, focusRect);
                    this._autoTileSavedRects.delete(pid);
                }
                if (this._autoTileSlotOrder) {
                    let si = this._autoTileSlotOrder.indexOf(pid);
                    if (si >= 0) this._autoTileSlotOrder[si] = iid;
                }
                if (this._autoTileWinById) {
                    this._autoTileWinById.set(iid, incoming);
                    this._autoTileWinById.delete(pid);
                }

                if (this._autoTileCycleEndId) {
                    GLib.source_remove(this._autoTileCycleEndId);
                    this._autoTileCycleEndId = null;
                }
                this._autoTileCycleEndId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 350, () => {
                    this._autoTileCycleEndId = null;
                    this._autoTileCyclePending = false;
                    try { focusWin.activate(global.get_current_time()); } catch (e) { }
                    if (this._autoTileProgrammaticIds) {
                        this._autoTileProgrammaticIds.delete(focusId);
                        this._autoTileProgrammaticIds.delete(pid);
                        this._autoTileProgrammaticIds.delete(iid);
                    }
                    return GLib.SOURCE_REMOVE;
                });
                return GLib.SOURCE_REMOVE;
            });
            return;
        }
    }

    _autoTileKeyboardResize(direction) {

        if (!this.wm_settings.get_boolean('auto-tile')) return;
        let focusWin = global.display.get_focus_window();
        if (!focusWin) return;
        let mon = focusWin.get_monitor();
        let tiledWins = this._autoTileGetTiledWindows(mon);
        if (tiledWins.length < 2 || !tiledWins.includes(focusWin)) return;

        const STEP = 50;
        const EPS  = 30;
        let gap       = this.wm_settings.get_int('auto-tile-gap');
        let workspace = global.workspace_manager.get_active_workspace();
        let wa        = workspace.get_work_area_for_monitor(mon);
        let waLeft    = wa.x + gap;
        let waTop     = wa.y + gap;
        let waRight   = wa.x + wa.width - gap;
        let waBottom  = wa.y + wa.height - gap;

        const _getMinW = (win) => {
            let s = this._autoTileWinMinSizes.get(win.get_id());
            return s ? s.minW : Math.floor(wa.width / 4);
        };
        const _getMinH = (win) => {
            let s = this._autoTileWinMinSizes.get(win.get_id());
            return s ? s.minH : Math.floor(wa.height / 3);
        };

        for (let tw of tiledWins) {
            if (!this._autoTileWinMinSizes.has(tw.get_id()))
                this._autoTileProbeMinSize(tw);
        }

        let minW = _getMinW(focusWin);
        let minH = _getMinH(focusWin);

        let fr   = focusWin.get_frame_rect();
        let fx   = fr.x, fy = fr.y, fw = fr.width, fh = fr.height;
        let fRight  = fx + fw;
        let fBottom = fy + fh;

        if (this._autoTileColumnsMode && (direction === 'left' || direction === 'right')) {
            let slotOrder = (this._autoTileSlotOrderByMonitor &&
                this._autoTileSlotOrderByMonitor[mon])
                ? this._autoTileSlotOrderByMonitor[mon]
                : this._autoTileSlotOrder;
            if (!slotOrder) return;
            let focusId  = focusWin.get_id();
            let focusIdx = slotOrder.indexOf(focusId);
            if (focusIdx < 0) return;

            let savedF = this._autoTileSavedRects ? this._autoTileSavedRects.get(focusId) : null;
            let rf = savedF ? { x: savedF.x, width: savedF.width } : { x: fx, width: fw };

            let hasRight = focusIdx + 1 < slotOrder.length;
            let hasLeft  = focusIdx - 1 >= 0;

            let movingRightBorder = (direction === 'right') ? hasRight : !hasLeft;
            let nbIdx = movingRightBorder ? focusIdx + 1 : focusIdx - 1;
            if (nbIdx < 0 || nbIdx >= slotOrder.length) return;

            let nbId    = slotOrder[nbIdx];
            let nb      = tiledWins.find(w => w.get_id() === nbId);
            if (!nb) return;
            let nbMinW  = _getMinW(nb);
            let savedNb = this._autoTileSavedRects ? this._autoTileSavedRects.get(nbId) : null;
            let rnb     = savedNb ? { x: savedNb.x, width: savedNb.width }
                                  : { x: nb.get_frame_rect().x, width: nb.get_frame_rect().width };

            let delta;
            if (movingRightBorder) {
                delta = (direction === 'right') ? +STEP : -STEP; 
            } else {
                delta = (direction === 'left') ? -STEP : +STEP; 
            }

            if (movingRightBorder) {
                let nbRight    = rnb.x + rnb.width;
                let newDivider = rf.x + rf.width + delta;
                newDivider = Math.min(newDivider, nbRight - nbMinW - gap);
                newDivider = Math.max(newDivider, rf.x + minW);
                if (newDivider === rf.x + rf.width) return;
                let newFw  = newDivider - rf.x;
                let newNbX = newDivider + gap;
                let newNbW = nbRight - newNbX;
                if (newFw < minW || newNbW < nbMinW) return;
                this._applyColumnKeyboardResize(focusWin, rf.x, fy, newFw, fh,
                    nb, newNbX, nb.get_frame_rect().y, newNbW, nb.get_frame_rect().height);
            } else {
                let nbLeft     = rnb.x;
                let newDivider = rf.x + delta;
                newDivider = Math.max(newDivider, nbLeft + nbMinW + gap);
                newDivider = Math.min(newDivider, rf.x + rf.width - minW);
                if (newDivider === rf.x) return;
                let newFw  = rf.x + rf.width - newDivider;
                let newNbW = newDivider - gap - nbLeft;
                if (newFw < minW || newNbW < nbMinW) return;
                this._applyColumnKeyboardResize(focusWin, newDivider, fy, newFw, fh,
                    nb, nbLeft, nb.get_frame_rect().y, newNbW, nb.get_frame_rect().height);
            }
            return;
        }

        const opposite = { right: 'left', left: 'right', up: 'down', down: 'up' };

        const findNeighbours = (side) => {
            let result = [];
            for (let win of tiledWins) {
                if (win === focusWin) continue;
                let r = win.get_frame_rect();
                let gap_dist;
                if (side === 'right') gap_dist = r.x - fRight;
                else if (side === 'left') gap_dist = fx - (r.x + r.width);
                else if (side === 'down') gap_dist = r.y - fBottom;
                else gap_dist = fy - (r.y + r.height);
                if (gap_dist >= -EPS && gap_dist <= gap + EPS) {

                    if (side === 'down' || side === 'up') {
                        let overlapLeft = Math.max(fx, r.x);
                        let overlapRight = Math.min(fRight, r.x + r.width);
                        if (overlapRight - overlapLeft < EPS) continue;
                    }
                    result.push(win);
                }
            }
            return result;
        };

        let primaryNeighbours = findNeighbours(direction);
        let sharedSide = direction;
        if (primaryNeighbours.length === 0) {
            primaryNeighbours = findNeighbours(opposite[direction]);
            if (primaryNeighbours.length === 0) return;
            sharedSide = opposite[direction];
        }

        let dividerPos;
        if (sharedSide === 'right') dividerPos = fRight;
        else if (sharedSide === 'left') dividerPos = fx;
        else if (sharedSide === 'down') dividerPos = fBottom;
        else dividerPos = fy;

        const delta = (direction === 'right' || direction === 'down') ? +STEP : -STEP;

        const primarySet = new Set(primaryNeighbours.map(w => w.get_id()));

        const findCoMovers = () => {
            if (sharedSide === 'down' || sharedSide === 'up') return [];
            let result = [];
            for (let win of tiledWins) {
                if (win === focusWin) continue;
                if (primarySet.has(win.get_id())) continue;
                let r = win.get_frame_rect();
                let winEdge;
                if (sharedSide === 'right') winEdge = r.x + r.width;
                else winEdge = r.x;
                if (Math.abs(winEdge - dividerPos) <= EPS)
                    result.push(win);
            }
            return result;
        };
        let coMovers = findCoMovers();

        let newDividerPos = dividerPos + delta;

        if (sharedSide === 'right' || sharedSide === 'left') {
     
            for (let nb of primaryNeighbours) {
                let nbMinW = _getMinW(nb);
                if (sharedSide === 'right') {
                    newDividerPos = Math.min(newDividerPos, waRight - nbMinW);
                } else {
                    newDividerPos = Math.max(newDividerPos, waLeft + nbMinW);
                }
            }
            if (sharedSide === 'right') {
                newDividerPos = Math.max(newDividerPos, waLeft + minW);
                for (let cm of coMovers)
                    newDividerPos = Math.max(newDividerPos, waLeft + _getMinW(cm));
            } else {
                newDividerPos = Math.min(newDividerPos, waRight - minW);
                for (let cm of coMovers)
                    newDividerPos = Math.min(newDividerPos, waRight - _getMinW(cm));
            }
        } else {
 
            let nb = primaryNeighbours[0];
            let nbr = nb.get_frame_rect();
            if (sharedSide === 'down') {
                let focusFarEdge = fy;
                let nbFarEdge = nbr.y + nbr.height;
                newDividerPos = Math.max(newDividerPos, focusFarEdge + minH);
                newDividerPos = Math.min(newDividerPos, nbFarEdge - _getMinH(nb) - gap);
            } else {
                let focusFarEdge = fBottom;
                let nbFarEdge = nbr.y;
                newDividerPos = Math.min(newDividerPos, focusFarEdge - minH);
                newDividerPos = Math.max(newDividerPos, nbFarEdge + _getMinH(nb) + gap);
            }
        }

        if (newDividerPos === dividerPos) return;

        const updates = [];

        let newFx = fx, newFy = fy, newFw = fw, newFh = fh;
        if (sharedSide === 'right') {
            newFx = waLeft;
            newFw = newDividerPos - waLeft;
        } else if (sharedSide === 'left') {
            newFx = newDividerPos;
            newFw = waRight - newDividerPos;
        } else if (sharedSide === 'down') {
            newFy = fy;
            newFh = newDividerPos - fy;
        } else {
            newFy = newDividerPos;
            newFh = fBottom - newDividerPos;
        }
        if (newFw < minW || newFh < minH) return;
        updates.push({ win: focusWin, nx: newFx, ny: newFy, nw: newFw, nh: newFh });

        for (let cm of coMovers) {
            let saved = this._autoTileSavedRects ? this._autoTileSavedRects.get(cm.get_id()) : null;
            let r = saved || cm.get_frame_rect();
            let nx = r.x, ny = r.y, nw = r.width, nh = r.height;
            if (sharedSide === 'right') {
                nx = waLeft;
                nw = newDividerPos - waLeft;
            } else {
                nx = newDividerPos;
                nw = waRight - newDividerPos;
            }
            if (nw < _getMinW(cm) || nh < _getMinH(cm)) return;
            updates.push({ win: cm, nx, ny, nw, nh });
        }

        for (let nb of primaryNeighbours) {
            let saved = this._autoTileSavedRects ? this._autoTileSavedRects.get(nb.get_id()) : null;
            let r = saved || nb.get_frame_rect();
            let nx = r.x, ny = r.y, nw = r.width, nh = r.height;
            if (sharedSide === 'right') {
                nx = newDividerPos + gap;
                nw = waRight - nx;
            } else if (sharedSide === 'left') {
                nx = waLeft;
                nw = newDividerPos - gap - waLeft;
            } else if (sharedSide === 'down') {
                ny = newDividerPos + gap;
                nh = (r.y + r.height) - ny;
            } else {
                nh = newDividerPos - gap - r.y;
            }
            if (nw < _getMinW(nb) || nh < _getMinH(nb)) return;
            updates.push({ win: nb, nx, ny, nw, nh });
        }

        if (!this._autoTileProgrammaticIds) this._autoTileProgrammaticIds = new Set();
        let committedIds = [];
        for (let { win, nx, ny, nw, nh } of updates) {
            let id = win.get_id();
            this._autoTileProgrammaticIds.add(id);
            committedIds.push(id);
            win.move_resize_frame(false, nx, ny, nw, nh);
            if (this._autoTileSavedRects)
                this._autoTileSavedRects.set(id, { x: nx, y: ny, width: nw, height: nh });
        }

        if (sharedSide === 'down' || sharedSide === 'up') {
            let syntheticHdef = {
                axis: 'y',
                wins: sharedSide === 'down'
                    ? [focusWin, primaryNeighbours[0]]
                    : [primaryNeighbours[0], focusWin],
            };
            GLib.timeout_add(GLib.PRIORITY_DEFAULT, 80, () => {
                this._autoTileSuspendResizeSignals();
                this._autoTileSnapCompensate(syntheticHdef);
                GLib.timeout_add(GLib.PRIORITY_DEFAULT, 80, () => {
                    this._autoTileResumeResizeSignals();
                    return GLib.SOURCE_REMOVE;
                });
                return GLib.SOURCE_REMOVE;
            });
        }

        GLib.timeout_add(GLib.PRIORITY_DEFAULT, 300, () => {
            if (this._autoTileProgrammaticIds) {
                for (let id of committedIds)
                    this._autoTileProgrammaticIds.delete(id);
            }
            return GLib.SOURCE_REMOVE;
        });
    }

    _integerRect(rect) {
        return {
            x: Math.round(rect.x),
            y: Math.round(rect.y),
            width:  Math.round(rect.width),
            height: Math.round(rect.height),
        };
    }

    _clampRect(rect, available, minW = 100, minH = 80) {
        let maxW = Math.max(available.width,  minW);
        let maxH = Math.max(available.height, minH);
        let w  = Math.min(maxW, Math.max(minW, rect.width));
        let h  = Math.min(maxH, Math.max(minH, rect.height));
        let maxX = available.x + available.width  - w;
        let maxY = available.y + available.height - h;
        let x  = Math.min(Math.max(rect.x, available.x), Math.max(available.x, maxX));
        let y  = Math.min(Math.max(rect.y, available.y), Math.max(available.y, maxY));
        return { x, y, width: w, height: h };
    }

    _computeSlot(start, totalSize, margin, total, index, span = 1) {
        let effective = Math.max(0, totalSize - (total - 1) * margin);
        let bStart = Math.round(effective * index / total);
        let bEnd   = Math.round(effective * (index + span) / total);
        return {
            pos:  start + bStart + index * margin,
            size: bEnd - bStart + (span - 1) * margin,
        };
    }

    _mapRectBetweenWorkAreas(rect, source, target) {
        if (source.width <= 0 || source.height <= 0)
            return this._clampRect(this._integerRect(rect), target);
        let mapped = {
            x:      target.x + (rect.x - source.x) / source.width  * target.width,
            y:      target.y + (rect.y - source.y) / source.height * target.height,
            width:  rect.width  / source.width  * target.width,
            height: rect.height / source.height * target.height,
        };
        return this._clampRect(this._integerRect(mapped), target);
    }

    _applyColumnKeyboardResize(focusWin, fx, fy, fw, fh, nb, nbx, nby, nbw, nbh) {
        if (!this._autoTileProgrammaticIds) this._autoTileProgrammaticIds = new Set();
        let fId  = focusWin.get_id();
        let nbId = nb.get_id();
        this._autoTileProgrammaticIds.add(fId);
        this._autoTileProgrammaticIds.add(nbId);
        focusWin.move_resize_frame(false, fx, fy, fw, fh);
        nb.move_resize_frame(false, nbx, nby, nbw, nbh);
        if (this._autoTileSavedRects) {
            this._autoTileSavedRects.set(fId,  { x: fx,  y: fy,  width: fw,  height: fh  });
            this._autoTileSavedRects.set(nbId, { x: nbx, y: nby, width: nbw, height: nbh });
        }
        GLib.timeout_add(GLib.PRIORITY_DEFAULT, 300, () => {
            if (this._autoTileProgrammaticIds) {
                this._autoTileProgrammaticIds.delete(fId);
                this._autoTileProgrammaticIds.delete(nbId);
            }
            return GLib.SOURCE_REMOVE;
        });
    }

    _autoTileStripeToggle() {
        if (this._autoTileStripe) {
            this._autoTileStripeClose();
        } else {
            this._autoTileStripeOpen();
        }
    }

    _autoTileStripeOpen() {
        if (this._autoTileStripe) return;

        let focusWin = global.display.get_focus_window();
        let mon = focusWin ? focusWin.get_monitor() : global.display.get_primary_monitor();
        let workspace = global.workspace_manager.get_active_workspace();
        let wa = global.display.get_monitor_geometry(mon);

        let wins = [];
        let nWs = global.workspace_manager.get_n_workspaces();
        for (let wi = 0; wi < nWs; wi++) {
            let ws = global.workspace_manager.get_workspace_by_index(wi);
            if (ws === workspace) continue;
            for (let w of ws.list_windows()) {
                if (w.get_window_type() !== Meta.WindowType.NORMAL) continue;
                if (w.is_skip_taskbar()) continue;
                if (w.get_monitor() !== mon) continue;
                wins.push(w);
            }
        }
        if (wins.length === 0) return;

        const THUMB_H  = Math.round(wa.height * 0.42);
        const THUMB_W  = Math.round(THUMB_H * 16 / 9);
        const PAD      = 20;
        const LABEL_H  = 28;
        const STRIPE_H = THUMB_H + PAD * 2;
        const STRIPE_Y = Math.round(wa.y + (wa.height - STRIPE_H) / 2);
        const totalW   = PAD + wins.length * (THUMB_W + PAD);

        let bg = new Clutter.Actor({
            x: wa.x, y: STRIPE_Y,
            width: wa.width, height: STRIPE_H,
            reactive: true,
        });
        let bgCanvas = new Clutter.Canvas();
        bgCanvas.set_size(wa.width, STRIPE_H);
        bgCanvas.connect('draw', (cvs, ctx, w, h) => {
            ctx.setSourceRGBA(0.06, 0.06, 0.09, 0.93);
            ctx.rectangle(0, 0, w, h);
            ctx.fill();
            ctx.setSourceRGBA(0.3, 0.85, 1.0, 0.7);
            ctx.setLineWidth(2);
            ctx.moveTo(0, 1);      ctx.lineTo(w, 1);      ctx.stroke();
            ctx.moveTo(0, h - 1);  ctx.lineTo(w, h - 1);  ctx.stroke();
            return true;
        });
        bg.set_content(bgCanvas);
        bgCanvas.invalidate();

        let clip = new Clutter.Actor({ x: 0, y: 0, width: wa.width, height: STRIPE_H });
        clip.set_clip(0, 0, wa.width, STRIPE_H);
        bg.add_child(clip);
        let inner = new Clutter.Actor({ x: 0, y: 0 });
        clip.add_child(inner);

        let thumbActors = [];
        for (let i = 0; i < wins.length; i++) {
            let win = wins[i];
            let tx  = PAD + i * (THUMB_W + PAD);

            let container = new Clutter.Actor({ x: tx, y: PAD, width: THUMB_W, height: THUMB_H });

            let thumbBg = new Clutter.Canvas();
            thumbBg.set_size(THUMB_W, THUMB_H);
            thumbBg.connect('draw', (cvs, ctx, w, h) => {
                ctx.setSourceRGBA(0.15, 0.15, 0.18, 1.0);
                ctx.rectangle(0, 0, w, h); ctx.fill();
                return true;
            });
            let thumbBgActor = new Clutter.Actor({ width: THUMB_W, height: THUMB_H });
            thumbBgActor.set_content(thumbBg);
            thumbBg.invalidate();
            container.add_child(thumbBgActor);

            let titleBg = new Clutter.Actor({
                x: 0, y: THUMB_H - 28, width: THUMB_W, height: 28,
                background_color: new Clutter.Color({ red: 0, green: 0, blue: 0, alpha: 160 }),
            });
            container.add_child(titleBg);
            let label = new St.Label({
                text: win.get_title() || '',
                style: 'font-size:12px; color:#ddeeff; padding: 4px 6px;',
                x: 0, y: THUMB_H - 28, width: THUMB_W,
            });
            label.clutter_text.ellipsize = Pango.EllipsizeMode.END;
            container.add_child(label);

            inner.add_child(container);
            thumbActors.push({ actor: container, win, tx });
        }

        GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            for (let i = 0; i < wins.length; i++) {
                try {
                    let win = wins[i];
                    let actor = win.get_compositor_private();
                    if (!actor) continue;

                    let wasVisible = actor.visible;
                    if (!wasVisible) actor.show();

                    let aw = actor.get_width(), ah = actor.get_height();
                    if (aw <= 0 || ah <= 0) {
                        if (!wasVisible) actor.hide();
                        continue;
                    }
                    let ar = aw / ah;
                    let cw, ch;
                    if (ar >= THUMB_W / THUMB_H) {
                        cw = THUMB_W; ch = Math.round(THUMB_W / ar);
                    } else {
                        ch = THUMB_H; cw = Math.round(THUMB_H * ar);
                    }
                    let clone = new Clutter.Clone({ source: actor });
                    clone.set_size(cw, ch);
                    clone.set_position(Math.round((THUMB_W - cw) / 2), Math.round((THUMB_H - ch) / 2));
                    thumbActors[i].actor.insert_child_at_index(clone, 1);

                    if (!wasVisible) actor.hide();
                } catch(e) {}
            }
            return GLib.SOURCE_REMOVE;
        });

        let selCanvas = new Clutter.Canvas();
        selCanvas.set_size(THUMB_W + 8, THUMB_H - LABEL_H + 8);
        selCanvas.connect('draw', (cvs, ctx, w, h) => {
            ctx.save();
            ctx.setOperator(1); 
            ctx.setSourceRGBA(0, 0, 0, 0);
            ctx.paint();
            ctx.restore();
            ctx.setSourceRGBA(0.3, 0.85, 1.0, 0.95);
            ctx.setLineWidth(3);
            ctx.rectangle(1.5, 1.5, w - 3, h - 3); ctx.stroke();
            return true;
        });
        let selBorder = new Clutter.Actor({ width: THUMB_W + 8, height: THUMB_H - LABEL_H + 8 });
        selBorder.set_content(selCanvas);
        selCanvas.invalidate();
        inner.add_child(selBorder);

        let state = {
            wins, thumbActors, bg, inner, selBorder, selCanvas,
            mon, wa, workspace,
            THUMB_W, THUMB_H, LABEL_H, PAD, STRIPE_H, STRIPE_Y, totalW,
            scrollX: 0, selectedIdx: 0,
            settleId: null,
            scrollSigId: null, clickSigId: null,
            canvasRefs: [bgCanvas, selCanvas],
            stageCaptureId: null,
        };
        this._autoTileStripe = state;
        this._autoTileStripeUpdateSel(state);

        global.stage.add_child(bg);

        let kbm = Main.keybindingManager;
        kbm.addHotKey('stripe-close',    'Escape',   () => this._autoTileStripeClose());
        kbm.addHotKey('stripe-confirm',  'Return',   () => this._autoTileStripeConfirm(this._autoTileStripe));
        kbm.addHotKey('stripe-confirm2', 'KP_Enter', () => this._autoTileStripeConfirm(this._autoTileStripe));
        kbm.addHotKey('stripe-left',     'Left',     () => this._autoTileStripeMove(-1));
        kbm.addHotKey('stripe-right',    'Right',    () => this._autoTileStripeMove(1));

        state.scrollSigId = bg.connect('scroll-event', (actor, event) => {
            let dir = event.get_scroll_direction();
            let dx = (dir === Clutter.ScrollDirection.RIGHT || dir === Clutter.ScrollDirection.DOWN)
                     ? +(THUMB_W + PAD) / 2.5
                     : -(THUMB_W + PAD) / 2.5;
            this._autoTileStripeScrollBy(state, dx);
            return Clutter.EVENT_STOP;
        });

        state.clickSigId = bg.connect('button-press-event', (actor, event) => {
            let [ok, px, py] = event.get_coords();
            let lx = px - wa.x - state.scrollX;
            for (let i = 0; i < state.thumbActors.length; i++) {
                let { tx } = state.thumbActors[i];
                if (lx >= tx && lx <= tx + THUMB_W) {
                    if (i === state.selectedIdx) {
                        this._autoTileStripeConfirm(state);
                    } else {
                        state.selectedIdx = i;
                        this._autoTileStripeSnapTo(state, i);
                    }
                    return Clutter.EVENT_STOP;
                }
            }
            return Clutter.EVENT_STOP;
        });
    }

    _autoTileStripeMove(delta) {
        let state = this._autoTileStripe;
        if (!state) return;
        state.selectedIdx = Math.max(0, Math.min(state.wins.length - 1, state.selectedIdx + delta));
        this._autoTileStripeSnapTo(state, state.selectedIdx);
    }

    _autoTileStripeUpdateSel(state) {
        let { thumbActors, selBorder, selCanvas, selectedIdx, THUMB_W, PAD } = state;
        if (!thumbActors.length) return;
        let idx = Math.max(0, Math.min(selectedIdx, thumbActors.length - 1));
        let { tx } = thumbActors[idx];
        selBorder.set_position(tx - 4, PAD - 4);
        selCanvas.invalidate();
    }

    _autoTileStripeScrollBy(state, dx) {
        let { wa, THUMB_W, PAD, totalW } = state;
        let maxScroll = Math.max(0, totalW - wa.width);
        state.velocity = 0;
        if (state.settleId) {
            GLib.source_remove(state.settleId);
            state.settleId = null;
        }
        state.scrollX = Math.max(-maxScroll, Math.min(0, state.scrollX - dx));
        state.inner.set_x(state.scrollX);

        let centre = -state.scrollX + wa.width / 2;
        let best = 0, bestDist = Infinity;
        for (let i = 0; i < state.thumbActors.length; i++) {
            let { tx } = state.thumbActors[i];
            let dist = Math.abs(tx + THUMB_W / 2 - centre);
            if (dist < bestDist) { bestDist = dist; best = i; }
        }
        state.selectedIdx = best;
        this._autoTileStripeUpdateSel(state);

        if (state.settleId) { GLib.source_remove(state.settleId); state.settleId = null; }
        state.settleId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 150, () => {
            state.settleId = null;
            this._autoTileStripeSnapTo(state, state.selectedIdx);
            return GLib.SOURCE_REMOVE;
        });
    }

    _autoTileStripeSnapTo(state, idx) {
        let { wa, THUMB_W, PAD, totalW } = state;
        let maxScroll = Math.max(0, totalW - wa.width);
        let { tx } = state.thumbActors[idx];
        let target = -(tx + THUMB_W / 2 - wa.width / 2);
        target = Math.min(0, Math.max(-maxScroll, target));

        if (state.settleId) { GLib.source_remove(state.settleId); state.settleId = null; }

        const EASE = 0.22, THRESH = 0.5;
        state.settleId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 16, () => {
            let diff = target - state.scrollX;
            if (Math.abs(diff) < THRESH) {
                state.scrollX = target;
                state.inner.set_x(state.scrollX);
                this._autoTileStripeUpdateSel(state);
                state.settleId = null;
                return GLib.SOURCE_REMOVE;
            }
            state.scrollX += diff * EASE;
            state.inner.set_x(state.scrollX);
            this._autoTileStripeUpdateSel(state);
            return GLib.SOURCE_CONTINUE;
        });
    }

    _autoTileStripeConfirm(state) {
        if (!state) return;
        let { wins, selectedIdx, workspace } = state;
        let win = wins[selectedIdx];
        if (!win) return;

        this._autoTileStripeConfirming = true;
        win.change_workspace(workspace);
        win.activate(global.get_current_time());
        this._autoTileStripeConfirming = false;

        state.wins.splice(selectedIdx, 1);
        if (state.wins.length === 0) {
            this._autoTileStripeClose();
            return;
        }
        state.selectedIdx = Math.min(selectedIdx, state.wins.length - 1);
        this._autoTileStripeRebuild(state);
    }

    _autoTileStripeRebuild(state) {
        let { wins, inner, selBorder, THUMB_W, THUMB_H, LABEL_H, PAD, totalW } = state;

        inner.remove_all_children();

        let thumbActors = [];
        let newTotalW = PAD + wins.length * (THUMB_W + PAD);
        state.totalW = newTotalW;

        for (let i = 0; i < wins.length; i++) {
            let win = wins[i];
            let tx  = PAD + i * (THUMB_W + PAD);

            let container = new Clutter.Actor({ x: tx, y: PAD, width: THUMB_W, height: THUMB_H });

            let thumbBg = new Clutter.Canvas();
            thumbBg.set_size(THUMB_W, THUMB_H);
            thumbBg.connect('draw', (cvs, ctx, w, h) => {
                ctx.setSourceRGBA(0.15, 0.15, 0.18, 1.0);
                ctx.rectangle(0, 0, w, h); ctx.fill();
                return true;
            });
            let thumbBgActor = new Clutter.Actor({ width: THUMB_W, height: THUMB_H });
            thumbBgActor.set_content(thumbBg);
            thumbBg.invalidate();
            container.add_child(thumbBgActor);

            let actor = win.get_compositor_private();
            if (actor) {
                try {
                    let wasVisible = actor.visible;
                    if (!wasVisible) actor.show();
                    let aw = actor.get_width(), ah = actor.get_height();
                    if (aw > 0 && ah > 0) {
                        let ar = aw / ah, cw, ch;
                        if (ar >= THUMB_W / THUMB_H) {
                            cw = THUMB_W; ch = Math.round(THUMB_W / ar);
                        } else {
                            ch = THUMB_H; cw = Math.round(THUMB_H * ar);
                        }
                        let clone = new Clutter.Clone({ source: actor });
                        clone.set_size(cw, ch);
                        clone.set_position(Math.round((THUMB_W - cw) / 2), Math.round((THUMB_H - ch) / 2));
                        container.add_child(clone);
                    }
                    if (!wasVisible) actor.hide();
                } catch(e) {}
            }

            let titleBg = new Clutter.Actor({
                x: 0, y: THUMB_H - LABEL_H, width: THUMB_W, height: LABEL_H,
                background_color: new Clutter.Color({ red: 0, green: 0, blue: 0, alpha: 160 }),
            });
            container.add_child(titleBg);
            let label = new St.Label({
                text: win.get_title() || '',
                style: 'font-size:12px; color:#ddeeff; padding: 4px 6px;',
                x: 0, y: THUMB_H - LABEL_H, width: THUMB_W,
            });
            label.clutter_text.ellipsize = Pango.EllipsizeMode.END;
            container.add_child(label);

            inner.add_child(container);
            thumbActors.push({ actor: container, win, tx });
        }

        inner.add_child(selBorder);

        state.thumbActors = thumbActors;
        state.scrollX = 0;
        inner.set_x(0);
        this._autoTileStripeUpdateSel(state);
    }

    _autoTileStripeClose() {
        let state = this._autoTileStripe;
        if (!state) return;
        this._autoTileStripe = null;

        if (state.settleId) { GLib.source_remove(state.settleId); state.settleId = null; }

        let kbm = Main.keybindingManager;
        for (let name of ['stripe-close','stripe-confirm','stripe-confirm2',
                          'stripe-left','stripe-right']) {
            try { kbm.removeHotKey(name); } catch(e) {}
        }

        try { if (state.scrollSigId) state.bg.disconnect(state.scrollSigId); } catch(e) {}
        try { if (state.clickSigId)  state.bg.disconnect(state.clickSigId);  } catch(e) {}

        state.canvasRefs = [];
        try { global.stage.remove_child(state.bg); } catch(e) {}
        try { state.bg.destroy(); } catch(e) {}
    }

    _autoTileToggleColumns() {
        if (!this.wm_settings.get_boolean('auto-tile')) return;
        this._autoTileColumnsMode = !this._autoTileColumnsMode;
        let ws = global.workspace_manager.get_active_workspace();
        if (ws) this._autoTileWorkspace(ws);
    }

    _computeColumnRects(count, x, y, w, h) {
        let gap = this.wm_settings.get_int('auto-tile-gap');
        let eg  = gap;
        let rx  = x + eg, ry = y + eg;
        let rw  = w - eg * 2, rh = h - eg * 2;
        let rects = [];
        for (let i = 0; i < count; i++) {
            let effective = Math.max(0, rw - (count - 1) * gap);
            let bStart    = Math.round(effective * i / count);
            let bEnd      = Math.round(effective * (i + 1) / count);
            let colX      = rx + bStart + i * gap;
            let colW      = bEnd - bStart;
            rects.push({ x: colX, y: ry, w: colW, h: rh });
        }
        return rects;
    }

    _computeAutoTileRects(count, x, y, w, h, layout2 = 'vertical', mirrored = false) {
        let gap = this.wm_settings.get_int('auto-tile-gap');
        let eg  = gap;
        let rx  = x + eg, ry = y + eg;
        let rw  = w - eg * 2, rh = h - eg * 2;

        const slotX = (idx, span = 1) => this._computeSlot(rx, rw, gap, 2, idx, span);
        const slotY = (idx, span = 1) => this._computeSlot(ry, rh, gap, 2, idx, span);

        let rects = [];

        switch (count) {
            case 1: {
                rects.push({ x: rx, y: ry, w: rw, h: rh });
                break;
            }
            case 2: {
                if (layout2 === 'horizontal') {
                    let r0 = slotY(0), r1 = slotY(1);
                    rects.push({ x: rx,        y: r0.pos, w: rw,        h: r0.size });
                    rects.push({ x: rx,        y: r1.pos, w: rw,        h: r1.size });
                } else {
                    let c0 = slotX(0), c1 = slotX(1);
                    rects.push({ x: c0.pos, y: ry, w: c0.size, h: rh });
                    rects.push({ x: c1.pos, y: ry, w: c1.size, h: rh });
                }
                break;
            }
            case 3: {
                let c0 = slotX(0), c1 = slotX(1);
                let r0 = slotY(0), r1 = slotY(1);
                if (mirrored) {
     
                    rects.push({ x: c1.pos, y: ry,     w: c1.size, h: rh        });
                    rects.push({ x: c0.pos, y: r0.pos, w: c0.size, h: r0.size   });
                    rects.push({ x: c0.pos, y: r1.pos, w: c0.size, h: r1.size   });
                } else {
          
                    rects.push({ x: c0.pos, y: ry,     w: c0.size, h: rh        });
                    rects.push({ x: c1.pos, y: r0.pos, w: c1.size, h: r0.size   });
                    rects.push({ x: c1.pos, y: r1.pos, w: c1.size, h: r1.size   });
                }
                break;
            }
            case 4: {
                let c0 = slotX(0), c1 = slotX(1);
                let r0 = slotY(0), r1 = slotY(1);
                rects.push({ x: c0.pos, y: r0.pos, w: c0.size, h: r0.size });
                rects.push({ x: c1.pos, y: r0.pos, w: c1.size, h: r0.size });
                rects.push({ x: c0.pos, y: r1.pos, w: c0.size, h: r1.size });
                rects.push({ x: c1.pos, y: r1.pos, w: c1.size, h: r1.size });
                break;
            }
        }
        return rects;
    }
};
