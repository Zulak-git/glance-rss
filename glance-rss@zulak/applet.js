/**
 * Glance RSS Applet
 * Copyright (C) 2026 Zulak
 * License: GNU GPL v3.0
 */

const Applet = imports.ui.applet;
const Settings = imports.ui.settings;
const St = imports.gi.St;
const Mainloop = imports.mainloop;
const Soup = imports.gi.Soup;
const Util = imports.misc.util;
const PopupMenu = imports.ui.popupMenu;
const GLib = imports.gi.GLib;
const Main = imports.ui.main;
const Tooltips = imports.ui.tooltips;

function MyApplet(metadata, orientation, panel_height, instance_id) {
    this._init(metadata, orientation, panel_height, instance_id);
}

MyApplet.prototype = {
    __proto__: Applet.Applet.prototype,

    _init: function(metadata, orientation, panel_height, instance_id) {
        try {
            Applet.Applet.prototype._init.call(this, orientation, panel_height, instance_id);
            this.settings = new Settings.AppletSettings(this, metadata.uuid, instance_id);
            
            this.layout = new St.BoxLayout({ style_class: "rss-multi-layout", reactive: true });
            this.actor.add_actor(this.layout);
            this.zones = [];
            
            this.clockLabel = new St.Label();
            this.clockBin = new St.Bin({ child: this.clockLabel, y_align: St.Align.MIDDLE, reactive: true });

            this._bindSettings();

            // --- MENU CONTEXTUEL (CLIC DROIT) ---
            this._applet_context_menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
            let refreshItem = new PopupMenu.PopupMenuItem("🔄 Recharger les flux RSS");
            refreshItem.connect('activate', () => this._refreshAllFeeds());
            this._applet_context_menu.addMenuItem(refreshItem);

            // --- PROTECTION DÉMARRAGE (5 SECONDES) ---
            Mainloop.timeout_add(5000, () => {
                this._setupZones();
                this._runLoops();
            });

        } catch (e) { global.logError("Glance RSS Global Error: " + e); }
    },

    _bindSettings: function() {
        let globalProps = ["clock-display-mode", "clock-position", "date-format", "clock-format", "clock-bg-color", "clock-text-color", "clock-font-size"];
        globalProps.forEach(p => {
            this.settings.bindProperty(Settings.BindingDirection.IN, p, p.replace(/-([a-z])/g, (g) => g[1].toUpperCase()), () => this._setupZones(), null);
        });

        for (let i = 1; i <= 10; i++) {
            let props = ["active", "url", "name", "width", "interval", "bg", "txt", "color", "order", "alert", "keywords"];
            props.forEach(p => {
                let sKey = p + "-" + i;
                let lKey = p.replace(/-([a-z])/g, (g) => g[1].toUpperCase()) + i;
                try {
                    this.settings.bindProperty(Settings.BindingDirection.IN, sKey, lKey, () => this._setupZones(), null);
                } catch(e) {}
            });
        }
    },

    // --- NETTOYAGE ET DÉCODAGE DES CARACTÈRES SPÉCIAUX ---
    _sanitizeText: function(text) {
        if (!text) return "";
        return text.replace(/<!\[CDATA\[(.*?)\]\]>/g, '$1') // Gestion CDATA 
                   .replace(/&amp;/g, '&')
                   .replace(/&lt;/g, '<')
                   .replace(/&gt;/g, '>')
                   .replace(/&quot;/g, '"')
                   .replace(/&#039;/g, "'")
                   .replace(/&rsquo;/g, "'")
                   .replace(/&lsquo;/g, "'")
                   .replace(/&hellip;/g, "...")
                   .replace(/&nbsp;/g, " ")
                   // Décodage des entités numériques
                   .replace(/&#(\d+);/g, (match, dec) => String.fromCharCode(dec))
                   .replace(/&#x([0-9a-f]+);/gi, (match, hex) => String.fromCharCode(parseInt(hex, 16)))
                   .replace(/<[^>]*>?/gm, '') // Supprime les balises HTML restantes
                   .trim();
    },

    _setupZones: function() {
        try {
            this.zones.forEach(z => { if (z.rotateTimer) Mainloop.source_remove(z.rotateTimer); });
            this.layout.remove_all_children();
            this.zones = [];

            if (this.clockDisplayMode !== "none" && this.clockPosition === "left") this.layout.add_actor(this.clockBin);
            
            let activeConfigs = [];
            for (let i = 1; i <= 10; i++) {
                if (this["active" + i] && this["url" + i] && this["url" + i] !== "Your RSS link here") {
                    activeConfigs.push({ id: i, order: this["order" + i] || 99 });
                }
            }

            activeConfigs.sort((a, b) => a.order - b.order);

            activeConfigs.forEach(conf => {
                let zone = this._createZoneObject(conf.id);
                this.layout.add_actor(zone.container);
                this.zones.push(zone);
                this._fetchRSS(zone); 
                this._startRotation(zone);
            });

            if (this.clockDisplayMode !== "none" && this.clockPosition === "right") this.layout.add_actor(this.clockBin);
            this._updateClockStyle();
        } catch (e) { global.logError("Setup Zones Error: " + e); }
    },

    _refreshAllFeeds: function() {
        this.zones.forEach(zone => this._fetchRSS(zone));
    },

    _createZoneObject: function(i) {
        let zone = {
            id: i,
            container: new St.BoxLayout({ reactive: true, style: `background-color: ${this["bg"+i]}; margin: 0 4px; border-radius: 4px;` }),
            nameLabel: new St.Label({ 
                text: this["name"+i], 
                style: `background-color: ${this["color"+i]}; padding: 2px 10px; font-weight: bold; color: white; border-radius: 4px 0 0 4px;`,
                reactive: true 
            }),
            newsLabel: new St.Label({ text: "Attente...", style: `color: ${this["txt"+i]};`, reactive: true }),
            articles: [], currentIndex: 0,
            url: this["url" + i], width: this["width" + i],
            interval: this["interval" + i] || 15,
            alertEnabled: this["alert" + i],
            keywords: this["keywords" + i] ? this["keywords" + i].split(';') : []
        };

        zone.nameTooltip = new Tooltips.Tooltip(zone.nameLabel, zone.url);
        let newsBin = new St.Bin({ child: zone.newsLabel, style: `width: ${zone.width}px; padding: 0 10px;`, reactive: true });
        zone.newsTooltip = new Tooltips.Tooltip(newsBin, "Chargement du flux...");

        // Navigation par zone de clic
        newsBin.connect('button-press-event', (actor, event) => {
            if (event.get_button() === 1) {
                let [x, y] = event.get_coords();
                let [binX, binY] = newsBin.get_transformed_position();
                let binWidth = newsBin.get_width();
                let relativeX = x - binX;
                if (relativeX <= 25) this._navRSS(zone, -1);
                else if (relativeX >= (binWidth - 25)) this._navRSS(zone, 1);
                else { this._updateZoneMenu(zone); zone.menu.toggle(); }
                return true; 
            }
            return false;
        });

        zone.nameLabel.connect('button-press-event', (actor, event) => {
            if (event.get_button() === 1) { this._updateZoneMenu(zone); zone.menu.toggle(); return true; }
            return false;
        });

        zone.container.add_actor(zone.nameLabel);
        zone.container.add_actor(newsBin);
        zone.menu = new PopupMenu.PopupMenu(zone.container, 0.0, this._orientation);
        Main.uiGroup.add_actor(zone.menu.actor);
        zone.menu.actor.hide();

        return zone;
    },

    _updateZoneMenu: function(zone) {
        zone.menu.removeAll();
        if (zone.articles.length === 0) {
            zone.menu.addMenuItem(new PopupMenu.PopupMenuItem("Aucun flux chargé"));
            return;
        }

        // Article actuel épinglé en haut du menu 
        let currentArt = zone.articles[zone.currentIndex];
        let mainItem = new PopupMenu.PopupMenuItem("📌 " + currentArt.title);
        mainItem.label.style = "font-weight: bold; color: #ffcc00;";
        mainItem.connect('activate', () => Util.spawnCommandLine(`xdg-open "${currentArt.link}"`));
        zone.menu.addMenuItem(mainItem);
        zone.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        // Liste des 15 derniers articles 
        zone.articles.forEach((art, index) => {
            if (index === zone.currentIndex) return;
            let mi = new PopupMenu.PopupMenuItem(art.title);
            mi.connect('activate', () => Util.spawnCommandLine(`xdg-open "${art.link}"`));
            zone.menu.addMenuItem(mi);
        });
    },

    _fetchRSS: function(zone) {
        let session = Soup.Session.new();
        let message = Soup.Message.new('GET', zone.url);
        // Ajout d'un User-Agent pour éviter d'être bloqué par certains serveurs
        message.request_headers.append('User-Agent', 'GlanceRSS-Applet/1.0 (Linux Mint Cinnamon)');

        session.send_and_read_async(message, 0, null, (session, res) => {
            try {
                let bytes = session.send_and_read_finish(res);
                let xml = bytes.get_data().toString();
                let items = xml.split(/<item>/i);
                zone.articles = [];
                let alertTriggered = false;

                for (let i = 1; i < items.length && i <= 15; i++) {
                    let t = items[i].match(/<title>(.*?)<\/title>/i);
                    let l = items[i].match(/<link>(.*?)<\/link>/i);
                    if (t && l) {
                        let cleanTitle = this._sanitizeText(t[1]);
                        zone.articles.push({ title: cleanTitle, link: l[1].trim() });
                        
                        // Surveillance des mots-clés configurés 
                        if (zone.alertEnabled) {
                            zone.keywords.forEach(kw => {
                                if (kw && cleanTitle.toLowerCase().includes(kw.toLowerCase().trim())) alertTriggered = true;
                            });
                        }
                    }
                }
                
                // Changement de couleur si mot-clé détecté 
                if (alertTriggered) {
                    zone.nameLabel.style = `background-color: #ff0000; padding: 2px 10px; font-weight: bold; color: white; border-radius: 4px 0 0 4px;`;
                } else {
                    zone.nameLabel.style = `background-color: ${this["color"+zone.id]}; padding: 2px 10px; font-weight: bold; color: white; border-radius: 4px 0 0 4px;`;
                }

                if (zone.articles.length > 0) this._updateZoneDisplay(zone);
                else zone.newsLabel.text = "Flux vide";
            } catch (e) { 
                zone.newsLabel.text = "Erreur Flux"; 
            }
        });
    },

    _updateZoneDisplay: function(zone) {
        if (zone.articles.length > 0) {
            let title = zone.articles[zone.currentIndex].title;
            zone.newsLabel.text = title;
            zone.newsTooltip.set_text(title);
        }
    },

    _navRSS: function(zone, step) {
        if (zone.articles.length === 0) return;
        zone.currentIndex = (zone.currentIndex + step + zone.articles.length) % zone.articles.length;
        this._updateZoneDisplay(zone);
    },

    _updateClockStyle: function() {
        if (this.clockDisplayMode === "none") return;
        this.clockBin.style = `background-color: ${this.clockBgColor}; padding: 2px 12px; border-radius: 4px; margin: 0 4px;`;
        this.clockLabel.style = `color: ${this.clockTextColor}; font-size: ${this.clockFontSize}px; font-weight: bold; font-family: monospace;`;
    },

    _startRotation: function(zone) {
        let rotate = () => {
            if (zone.articles.length > 0) {
                zone.currentIndex = (zone.currentIndex + 1) % zone.articles.length;
                this._updateZoneDisplay(zone);
            }
            zone.rotateTimer = Mainloop.timeout_add_seconds(zone.interval, rotate);
        };
        zone.rotateTimer = Mainloop.timeout_add_seconds(zone.interval, rotate);
    },

    _runLoops: function() {
        // Boucle de l'horloge (1s) 
        Mainloop.timeout_add(1000, () => {
            if (this.clockDisplayMode !== "none") {
                let now = GLib.DateTime.new_now_local();
                let t = now.format(this.dateFormat) + " " + now.format(this.clockFormat);
                this.clockLabel.text = t;
            }
            return true;
        });
        // Auto-refresh global (10 min) 
        Mainloop.timeout_add_seconds(600, () => {
            this.zones.forEach(z => this._fetchRSS(z));
            return true;
        });
    }
};

function main(metadata, orientation, panel_height, instance_id) {
    return new MyApplet(metadata, orientation, panel_height, instance_id);
}
