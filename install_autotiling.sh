#!/bin/bash
# -----------------------------------------------------------------
# CinnamonAutoTiling - Install Script
# -----------------------------------------------------------------
# Installs CinnamonAutoTiling for Cinnamon 6.6.7 on Linux Mint 22.x
#
# USAGE:
#   sudo bash install_autotiling.sh
#
# UNINSTALL:
#   sudo bash install_autotiling.sh --uninstall
# ----------------------------------------------

set -euo pipefail

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'
CYAN='\033[0;36m'; BOLD='\033[1m'; NC='\033[0m'
info()    { echo -e "${CYAN}[INFO]${NC}  $*"; }
ok()      { echo -e "${GREEN}[OK]${NC}    $*"; }
warn()    { echo -e "${YELLOW}[WARN]${NC}  $*"; }
die()     { echo -e "${RED}[ERROR]${NC} $*" >&2; exit 1; }
section() { echo -e "\n${BOLD}══ $* ══${NC}"; }

[[ $EUID -eq 0 ]] || die "Please run as root:  sudo bash $0"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BACKUP_DIR="$SCRIPT_DIR/backups"
REAL_USER="${SUDO_USER:-$USER}"

SCHEMA_DEST="/usr/share/glib-2.0/schemas/org.cinnamon.muffin.gschema.xml"
WM_JS_DEST="/usr/share/cinnamon/js/ui/windowManager.js"
WMENU_JS_DEST="/usr/share/cinnamon/js/ui/windowMenu.js"
CS_PY_DEST="/usr/share/cinnamon/cinnamon-settings/modules/cs_windows.py"

# --------------------------------------------
# Uninstall mode
# --------------------------------------------
if [[ "${1:-}" == "--uninstall" ]]; then
    section "Uninstalling CinnamonAutoTiling"

    # Pre-flight: check that at least one backup exists before touching anything
    FOUND=0
    for dest in "$SCHEMA_DEST" "$WM_JS_DEST" "$WMENU_JS_DEST" "$CS_PY_DEST"; do
        backup="$BACKUP_DIR/$(basename "$dest").stock"
        [[ -f "$backup" ]] && FOUND=$((FOUND+1))
    done

    if [[ $FOUND -eq 0 ]]; then
        die "No backup files found in $BACKUP_DIR\n\nDid you install using this script? Backups are created automatically during install.\nIf you installed manually, restore the original files yourself, e.g.:\n  sudo apt install --reinstall cinnamon"
    fi

    RESTORED=0
    for dest in "$SCHEMA_DEST" "$WM_JS_DEST" "$WMENU_JS_DEST" "$CS_PY_DEST"; do
        backup="$BACKUP_DIR/$(basename "$dest").stock"
        if [[ -f "$backup" ]]; then
            cp "$backup" "$dest"
            ok "Restored: $(basename "$dest")"
            RESTORED=$((RESTORED+1))
        else
            warn "No backup found for $(basename "$dest") - skipping"
        fi
    done

    glib-compile-schemas /usr/share/glib-2.0/schemas/
    ok "Schemas recompiled."

    for key in auto-tile auto-tile-gap auto-tile-excludelist auto-tile-accent-color auto-tile-border-width; do
        sudo -u "$REAL_USER" gsettings reset org.cinnamon.muffin "$key" 2>/dev/null || true
    done
    ok "GSettings reset to defaults."

    echo ""
    ok "Uninstall complete ($RESTORED file(s) restored). Restart Cinnamon:"
    echo "   Right-click panel -> Troubleshoot -> Restart Cinnamon"
    exit 0
fi

# -------------------------------
# Check required source files
# -------------------------------
section "Checking source files"

MISSING=0
for f in "org.cinnamon.muffin.gschema.xml" "windowManager.js" "windowMenu.js" "cs_windows.py"; do
    if [[ -f "$SCRIPT_DIR/$f" ]]; then
        ok "Found: $f"
    else
        warn "Missing: $SCRIPT_DIR/$f"
        MISSING=1
    fi
done
[[ $MISSING -eq 0 ]] || die "One or more required files are missing from $SCRIPT_DIR"

# -----------------------------------
# Check Cinnamon version
# -----------------------------------
section "Checking Cinnamon version"
CINNAMON_VER=$(cinnamon --version 2>/dev/null | awk '{print $2}' || echo "unknown")
info "Cinnamon version: $CINNAMON_VER"
MAJOR=$(echo "$CINNAMON_VER" | cut -d. -f1)
[[ "$MAJOR" == "6" ]] || warn "This package was built for Cinnamon 6.6.7 - your version is $CINNAMON_VER"

# --------------------------------
# Back up stock files
# --------------------------------
section "Backing up stock files"
mkdir -p "$BACKUP_DIR"

backup_file() {
    local src="$1"
    local name
    name=$(basename "$src")
    local backup="$BACKUP_DIR/${name}.stock"
    if [[ ! -f "$backup" ]]; then
        cp "$src" "$backup"
        ok "Backed up: $name"
    else
        info "Backup already exists: ${name}.stock (skipping)"
    fi
}

[[ -f "$SCHEMA_DEST"   ]] && backup_file "$SCHEMA_DEST"
[[ -f "$WM_JS_DEST"    ]] && backup_file "$WM_JS_DEST"
[[ -f "$WMENU_JS_DEST" ]] && backup_file "$WMENU_JS_DEST"
[[ -f "$CS_PY_DEST"    ]] && backup_file "$CS_PY_DEST"

# --------------------------------------------
# Step 1 - Install schema
# --------------------------------------------
section "Step 1 - Installing GSettings schema"

cp "$SCRIPT_DIR/org.cinnamon.muffin.gschema.xml" "$SCHEMA_DEST"
glib-compile-schemas /usr/share/glib-2.0/schemas/
ok "Schema compiled."

for key in auto-tile auto-tile-gap auto-tile-excludelist auto-tile-accent-color auto-tile-border-width; do
    sudo -u "$REAL_USER" gsettings get org.cinnamon.muffin "$key" &>/dev/null \
        && ok "Key: $key" \
        || die "Key missing after schema install: $key"
done

# ---------------------------------------------
# Step 2 - Install windowManager.js
# ---------------------------------------------
section "Step 2 - Installing windowManager.js"
cp "$SCRIPT_DIR/windowManager.js" "$WM_JS_DEST"
ok "windowManager.js installed."

# -------------------------------------------------
# Step 3 - Install windowMenu.js
# -------------------------------------------------
section "Step 3 - Installing windowMenu.js"
cp "$SCRIPT_DIR/windowMenu.js" "$WMENU_JS_DEST"
ok "windowMenu.js installed."

# ------------------------------------------
# Step 4 - Install settings UI
# ------------------------------------------
section "Step 4 - Installing cs_windows.py"
cp "$SCRIPT_DIR/cs_windows.py" "$CS_PY_DEST"
ok "cs_windows.py installed."

# -----------------------------------------------------------------------
# Done
# -----------------------------------------------------------------------
echo ""
echo -e "${GREEN}${BOLD}"
echo "  ╔══════════════════════════════════════════════════════════════╗"
echo "  ║  CinnamonAutoTiling installed successfully!                  ║"
echo "  ║                                                              ║"
printf "  ║  Cinnamon version: %-42s║\n" "$CINNAMON_VER"
echo "  ║                                                              ║"
echo "  ║  Restart Cinnamon to activate:                               ║"
echo "  ║    Right-click panel -> Troubleshoot -> Restart Cinnamon       ║"
echo "  ║                                                              ║"
echo "  ║  Then enable tiling in:                                      ║"
echo "  ║    System Settings -> Windows -> Tiling Preferences            ║"
echo "  ║                                                              ║"
echo "  ║  To uninstall:                                               ║"
echo "  ║    sudo bash install_autotiling.sh --uninstall               ║"
echo "  ╚══════════════════════════════════════════════════════════════╝"
echo -e "${NC}"
