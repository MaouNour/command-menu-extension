import GLib from 'gi://GLib';
import St from 'gi://St';
import GObject from 'gi://GObject';
import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import { Extension, gettext as _ } from 'resource:///org/gnome/shell/extensions/extension.js';

// Run `cmdLine` in a shell and resolve with its stdout (or null on error).
// Uses Gio.Subprocess so it never blocks the UI thread.
function execCommandAsync(cmdLine) {
  return new Promise((resolve) => {
    try {
      const proc = Gio.Subprocess.new(
        ['/bin/sh', '-c', cmdLine],
        Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_SILENCE
      );
      proc.communicate_utf8_async(null, null, (p, res) => {
        try {
          const [, stdout] = p.communicate_utf8_finish(res);
          resolve(stdout);
        } catch (e) {
          logError(e, 'command-menu2: dynamic item command failed');
          resolve(null);
        }
      });
    } catch (e) {
      logError(e, 'command-menu2: failed to spawn dynamic item command');
      resolve(null);
    }
  });
}

const CommandMenuPopup = GObject.registerClass(
  class CommandMenuPopup extends PanelMenu.Button {
    _init(cmds, settings) {
      super._init(0.5);
      this.commands = cmds;
      this.commandMenuSettings = settings;
      this._dynamicTimers = [];
      this.redrawMenu();
    }

    loadIcon(icon, style_class) {
      if (typeof icon !== 'string' || !icon.length) return null;
      // sys icon
      if (!icon.includes('/'))
        return new St.Icon({ icon_name: icon, style_class });
      // filepath icon
      if (icon.startsWith('~/') || icon.startsWith("$HOME/"))
        icon = GLib.build_filenamev([GLib.get_home_dir(), icon.substring(icon.indexOf('/'))]);
      const file = Gio.File.new_for_path(icon);
      if (!file.query_exists(null)) return new St.Icon({ style_class });
      const gicon = new Gio.FileIcon({ file });
      return new St.Icon({ gicon, style_class });
    }

    // Build a plain clickable row from a {title, icon, command} object.
    // Shared by static items and by items generated dynamically from JSON output.
    createStaticItem(cmd) {
      let item = new PopupMenu.PopupBaseMenuItem();
      let icon = this.loadIcon(cmd.icon, 'popup-menu-icon');
      if (icon) item.add_child(icon);
      let label = new St.Label({
        text: cmd.title,
        x_expand: true,
        y_align: Clutter.ActorAlign.CENTER
      });
      item.add_child(label);
      if (cmd.command) {
        item.connect('activate', () => {
          GLib.spawn_command_line_async(cmd.command);
        });
      }
      return item;
    }

    // Registers a live/dynamic entry. `cmd.exec` is run immediately, and again
    // every `cmd.interval` seconds if set. Its stdout is interpreted as:
    //  - plain text              -> becomes this item's title
    //  - a JSON object            -> {title, icon, command, ...} overrides this item
    //  - a JSON array of objects  -> expands into multiple menu items/labels/separators
    //    at this position (each entry can use "type": "label" | "separator" | "dynamic" too)
    setupDynamicItem(section, cmd, level) {
      // placeholder while waiting on the first run
      section.addMenuItem(this.createStaticItem({
        title: cmd.title || '…',
        icon: cmd.icon,
      }));

      const interval = Number.isFinite(+cmd.interval) && +cmd.interval > 0 ? +cmd.interval : 0;

      const refresh = () => {
        execCommandAsync(cmd.exec).then((output) => {
          if (output === null) return;
          this.renderDynamicOutput(section, cmd, output, level);
        });
        return interval > 0 ? GLib.SOURCE_CONTINUE : GLib.SOURCE_REMOVE;
      };

      refresh();

      if (interval > 0) {
        const sourceId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, interval, refresh);
        this._dynamicTimers.push(sourceId);
      }
    }

    renderDynamicOutput(section, cmd, output, level) {
      section.removeAll();

      const trimmed = output.trim();
      let parsed = null;
      try {
        parsed = JSON.parse(trimmed);
      } catch (e) {
        // not JSON - treat as plain text title below
      }

      if (Array.isArray(parsed)) {
        if (parsed.length === 0) return;
        // reuse the normal item-list renderer so array entries can themselves
        // be separators / labels / submenus / further dynamic entries
        this.populateMenuItems(section, parsed, level);
        return;
      }

      let finalCmd;
      if (parsed && typeof parsed === 'object') {
        finalCmd = { ...cmd, ...parsed };
      } else {
        finalCmd = { ...cmd, title: trimmed };
      }
      if (!finalCmd.title) return;
      section.addMenuItem(this.createStaticItem(finalCmd));
    }

    populateMenuItems(menu, cmds, level) {
      cmds.forEach((cmd) => {
        if (cmd.type === 'separator') {
          menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
          return;
        }

        if (cmd.type === 'dynamic') {
          if (!cmd.exec) return;
          const section = new PopupMenu.PopupMenuSection();
          menu.addMenuItem(section);
          this.setupDynamicItem(section, cmd, level);
          return;
        }

        if (!cmd.title) return;

        if (cmd.type === 'label') {
          const sectionLabel = new PopupMenu.PopupBaseMenuItem({
            reactive: false,
            style_class: 'section-label-menu-item',
          });

          const label = new St.Label({
            text: cmd.title,
            style_class: 'popup-subtitle-menu-item',
            x_expand: true,
            x_align: Clutter.ActorAlign.START,
            y_align: Clutter.ActorAlign.CENTER,
          });

          label.set_style('font-size: 0.8em; padding: 0em; margin: 0em; line-height: 1em;');
          sectionLabel.actor.set_style('padding-top: 0px; padding-bottom: 0px; min-height: 0;');
          sectionLabel.actor.add_child(label);

          menu.addMenuItem(sectionLabel);
          return;
        }

        if (cmd.type === 'submenu' && level === 0) {
          if (!cmd.submenu) return;
          const submenu = new PopupMenu.PopupSubMenuMenuItem(cmd.title);
          if (cmd.icon) {
            const icon = this.loadIcon(cmd.icon, 'popup-menu-icon');
            if (icon) submenu.insert_child_at_index(icon, 1);
          }
          this.populateMenuItems(submenu.menu, cmd.submenu, level + 1);
          menu.addMenuItem(submenu);
          return;
        }

        if (!cmd.command) return;

        menu.addMenuItem(this.createStaticItem(cmd));
      });
    }

    redrawMenu() {
      // add popup menu title
      let menuTitle = this.commands.title ?? "";
      let box = new St.BoxLayout();

      let icon = this.loadIcon(this.commands.icon, 'system-status-icon');
      if (!icon && menuTitle === "") { // fallback icon
        icon = new St.Icon({
          icon_name: 'utilities-terminal-symbolic',
          style_class: 'system-status-icon',
        });
      }
      if (icon) box.add_child(icon);

      let text = new St.Label({
        text: menuTitle,
        y_expand: true,
        y_align: Clutter.ActorAlign.CENTER
      });
      if (icon && menuTitle) {
        text.set_style('padding-right: 7px;'); // roughly center icon/label
      }

      box.add_child(text);
      this.add_child(box);

      // populate menu items
      if ((!Array.isArray(this.commands.menu) || this.commands.menu.length === 0)) {
        this.commands.menu = [{
          title: "Customize This Menu...",
          icon: 'preferences-system-symbolic',
          command: "gnome-extensions prefs command-menu2@goldentree1.github.com"
        }];
      }
      this.populateMenuItems(this.menu, this.commands.menu, 0);
    }

    destroy() {
      this._dynamicTimers.forEach((id) => GLib.source_remove(id));
      this._dynamicTimers = [];
      super.destroy();
    }
  });

export default class CommandMenuExtension extends Extension {
  constructor(metadata) {
    super(metadata);
    this.cmdMenus = [];
    this._settings = null;
    this._settingsIds = [];
  }

  reloadExtension() {
    this.cmdMenus.forEach(m => m.destroy());
    this.cmdMenus = [];
    this.#loadMenus();
  }

  enable() {
    this._settings = this.getSettings();
    this._settingsIds.push(this._settings.connect('changed::restart-counter', () => {
      this.reloadExtension();
    }));
    this._settingsIds.push(this._settings.connect('changed::config-filepath', () => {
      this.reloadExtension();
    }));
    this.#loadMenus();
  }

  disable() {
    this._settingsIds.forEach(s => this._settings.disconnect(s));
    this._settingsIds = [];
    this.cmdMenus.forEach(m => m.destroy());
    this.cmdMenus = [];
    this._settings = null;
  }

  #loadMenus() {
    // load cmds
    let filePath = this._settings.get_string('config-filepath');
    if (filePath.startsWith('~/')) filePath = GLib.build_filenamev([GLib.get_home_dir(), filePath.substring(2)]);
    const file = Gio.file_new_for_path(filePath);
    const menus = [];
    try {
      let [ok, contents, _] = file.load_contents(null);
      if (!ok) throw Error();
      const decoder = new TextDecoder();
      const json = JSON.parse(decoder.decode(contents));
      if (json instanceof Array && json.length && (json[0] instanceof Array || (json[0] instanceof Object && json[0]['menu'] instanceof Array))) {
        json.forEach(j => menus.push(parseMenu(j)));
      } else {
        menus.push(parseMenu(json));
      }
    } catch (err) {
      if (!file.query_exists(null)) {
        logError(err, `${this.uuid}: failed to parse command menu`);
      }
      menus.push({ menu: [] });
    }

    // add menus to panel
    menus.forEach((menu, i) => {
      const popup = new CommandMenuPopup(menu, this._settings);
      const index = Number.isInteger(+menu.index) ? +menu.index : 1;
      const pos = ['left', 'center', 'right'].includes(menu.position) ? menu.position : 'left';
      Main.panel.addToStatusArea(`commandMenu2_${i}`, popup, index, pos);
      this.cmdMenus.push(popup);
    });

    function parseMenu(obj) {
      if (obj instanceof Object && obj.menu instanceof Array) { // object menu
        return { ...obj, menu: [...obj.menu] };
      } else if (obj instanceof Array) { // simple array menu
        return { menu: [...obj] };
      } else {
        return { menu: [] };
      }
    }
  }
}
