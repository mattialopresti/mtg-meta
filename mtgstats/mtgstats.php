<?php
/**
 * Plugin Name:       MTG Stats
 * Plugin URI:        https://github.com/mattialopresti/mtg-meta
 * Description:       Metagame analytics for Magic: The Gathering tournaments. Imports events from Melee (directly or through MTGODecklistCache), detects archetypes automatically and publishes a dashboard with the [mtgstats] shortcode.
 * Version:           1.0.0
 * Requires at least: 5.8
 * Requires PHP:      7.4
 * Author:            Mattia Lopresti
 * License:           GPL-2.0-or-later
 * Text Domain:       mtgstats
 * Domain Path:       /languages
 */

if (!defined('ABSPATH')) {
    exit;
}

define('MTGSTATS_VERSION', '1.0.0');
define('MTGSTATS_FILE', __FILE__);

final class MTGStats_Plugin
{
    const OPT = 'mtgstats_settings';
    const NS = 'mtgstats/v1';
    const ID_RE = '[a-z0-9][a-z0-9-]{2,139}';

    /** Percorsi melee.gg consentiti al proxy (solo quelli usati dall'importatore) */
    const MELEE_PATHS = '#^/(Tournament/View/\d+|Match/GetRoundMatches/\d+|Standing/GetRoundStandings|Decklist/View/[0-9a-fA-F-]{36})$#';

    public static function init()
    {
        register_activation_hook(MTGSTATS_FILE, array(__CLASS__, 'ensure_storage'));
        add_action('init', array(__CLASS__, 'load_textdomain'));
        add_action('init', array(__CLASS__, 'register_assets'));
        add_action('rest_api_init', array(__CLASS__, 'register_routes'));
        add_action('admin_menu', array(__CLASS__, 'admin_menu'));
        add_shortcode('mtgstats', array(__CLASS__, 'shortcode'));
        add_filter('plugin_action_links_' . plugin_basename(MTGSTATS_FILE), array(__CLASS__, 'action_links'));
    }

    // -------------------------------------------------------------------------
    // Archiviazione: wp-content/uploads/mtgstats/{index.json, t/*.json, rules/*.json}
    // -------------------------------------------------------------------------

    public static function storage()
    {
        $u = wp_upload_dir(null, false);
        return array(
            'dir' => trailingslashit($u['basedir']) . 'mtgstats',
            'url' => set_url_scheme(trailingslashit($u['baseurl']) . 'mtgstats'),
        );
    }

    public static function ensure_storage()
    {
        $s = self::storage();
        foreach (array('', '/t', '/rules') as $sub) {
            wp_mkdir_p($s['dir'] . $sub);
            if (!file_exists($s['dir'] . $sub . '/index.php')) {
                file_put_contents($s['dir'] . $sub . '/index.php', "<?php\n// Silence is golden.\n");
            }
        }
        if (!file_exists($s['dir'] . '/index.json')) {
            self::write_json($s['dir'] . '/index.json', array('updated' => gmdate('c'), 'tournaments' => array()));
        }
    }

    private static function write_json($path, $data)
    {
        $json = wp_json_encode($data, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
        if ($json === false) {
            return false;
        }
        $tmp = $path . '.tmp';
        if (file_put_contents($tmp, $json, LOCK_EX) === false) {
            return false;
        }
        return rename($tmp, $path);
    }

    private static function read_index()
    {
        $s = self::storage();
        $file = $s['dir'] . '/index.json';
        $data = file_exists($file) ? json_decode((string) file_get_contents($file), true) : null;
        if (!is_array($data) || !isset($data['tournaments']) || !is_array($data['tournaments'])) {
            $data = array('updated' => gmdate('c'), 'tournaments' => array());
        }
        return $data;
    }

    /** Modifica l'indice in modo atomico (lock su file) */
    private static function update_index($callback)
    {
        self::ensure_storage();
        $s = self::storage();
        $lock = fopen($s['dir'] . '/.lock', 'c');
        if ($lock) {
            flock($lock, LOCK_EX);
        }
        $index = self::read_index();
        $index['tournaments'] = array_values(call_user_func($callback, $index['tournaments']));
        $index['updated'] = gmdate('c');
        $ok = self::write_json($s['dir'] . '/index.json', $index);
        if ($lock) {
            flock($lock, LOCK_UN);
            fclose($lock);
        }
        return $ok ? $index : false;
    }

    // -------------------------------------------------------------------------
    // Impostazioni
    // -------------------------------------------------------------------------

    public static function settings()
    {
        $defaults = array('aliases' => array(), 'customRules' => array(), 'conflict' => 'simpler', 'prior' => 10, 'accent' => '');
        $s = get_option(self::OPT, array());
        return array_merge($defaults, is_array($s) ? $s : array());
    }

    // -------------------------------------------------------------------------
    // REST API
    // -------------------------------------------------------------------------

    public static function can_manage()
    {
        return current_user_can('manage_options');
    }

    public static function register_routes()
    {
        register_rest_route(self::NS, '/settings', array(
            array('methods' => 'GET', 'callback' => array(__CLASS__, 'rest_get_settings'), 'permission_callback' => array(__CLASS__, 'can_manage')),
            array('methods' => 'POST', 'callback' => array(__CLASS__, 'rest_save_settings'), 'permission_callback' => array(__CLASS__, 'can_manage')),
        ));
        register_rest_route(self::NS, '/tournaments', array(
            'methods' => 'POST', 'callback' => array(__CLASS__, 'rest_save_tournament'), 'permission_callback' => array(__CLASS__, 'can_manage'),
        ));
        register_rest_route(self::NS, '/tournaments/(?P<id>' . self::ID_RE . ')', array(
            'methods' => 'DELETE', 'callback' => array(__CLASS__, 'rest_delete_tournament'), 'permission_callback' => array(__CLASS__, 'can_manage'),
        ));
        register_rest_route(self::NS, '/rules/(?P<format>[A-Za-z0-9_-]{2,60})', array(
            'methods' => 'POST', 'callback' => array(__CLASS__, 'rest_save_rules'), 'permission_callback' => array(__CLASS__, 'can_manage'),
        ));
        register_rest_route(self::NS, '/melee', array(
            'methods' => 'POST', 'callback' => array(__CLASS__, 'rest_melee_proxy'), 'permission_callback' => array(__CLASS__, 'can_manage'),
        ));
    }

    public static function rest_get_settings()
    {
        return rest_ensure_response(self::settings());
    }

    public static function rest_save_settings(WP_REST_Request $req)
    {
        $p = $req->get_json_params();
        $aliases = array();
        if (isset($p['aliases']) && is_array($p['aliases'])) {
            foreach ($p['aliases'] as $from => $to) {
                $from = sanitize_text_field((string) $from);
                $to = sanitize_text_field((string) $to);
                if ($from !== '' && $to !== '') {
                    $aliases[$from] = $to;
                }
            }
        }
        $rules = array();
        if (isset($p['customRules']) && is_array($p['customRules'])) {
            foreach ($p['customRules'] as $rule) {
                if (is_array($rule) && !empty($rule['Name']) && !empty($rule['Conditions']) && is_array($rule['Conditions'])) {
                    $rules[] = $rule;
                }
            }
        }
        $settings = array(
            'aliases' => $aliases,
            'customRules' => $rules,
            'conflict' => (isset($p['conflict']) && $p['conflict'] === 'none') ? 'none' : 'simpler',
            'prior' => isset($p['prior']) ? max(0, min(100, (int) $p['prior'])) : 10,
            'accent' => isset($p['accent']) ? (string) sanitize_hex_color((string) $p['accent']) : '',
        );
        update_option(self::OPT, $settings, false);
        return rest_ensure_response($settings);
    }

    public static function rest_save_tournament(WP_REST_Request $req)
    {
        $t = json_decode($req->get_body(), true);
        if (!is_array($t) || empty($t['id']) || !preg_match('/^' . self::ID_RE . '$/', (string) $t['id'])) {
            return new WP_Error('mtgstats_bad_id', __('Invalid tournament ID', 'mtgstats'), array('status' => 400));
        }
        if (empty($t['players']) || !is_array($t['players']) || !isset($t['cards']) || !is_array($t['cards']) || !isset($t['rounds']) || !is_array($t['rounds'])) {
            return new WP_Error('mtgstats_bad_data', __('Invalid tournament structure', 'mtgstats'), array('status' => 400));
        }
        $t['name'] = sanitize_text_field(isset($t['name']) ? (string) $t['name'] : 'Tournament');
        $t['date'] = (isset($t['date']) && preg_match('/^\d{4}-\d{2}-\d{2}$/', (string) $t['date'])) ? $t['date'] : gmdate('Y-m-d');
        $t['format'] = sanitize_text_field(isset($t['format']) ? (string) $t['format'] : '');
        $t['source'] = sanitize_text_field(isset($t['source']) ? (string) $t['source'] : '');
        $t['uri'] = isset($t['uri']) ? esc_url_raw((string) $t['uri'], array('http', 'https')) : '';

        self::ensure_storage();
        $s = self::storage();
        $file = 't/' . $t['id'] . '.json';
        if (!self::write_json($s['dir'] . '/' . $file, $t)) {
            return new WP_Error('mtgstats_write', __('Could not write the file in uploads/mtgstats', 'mtgstats'), array('status' => 500));
        }
        $unknown = 0;
        foreach ($t['players'] as $p) {
            if (is_array($p) && (!isset($p['a']) || $p['a'] === 'Unknown')) {
                $unknown++;
            }
        }
        $entry = array(
            'id' => $t['id'],
            'name' => $t['name'],
            'date' => $t['date'],
            'format' => $t['format'],
            'source' => $t['source'],
            'uri' => $t['uri'],
            'players' => count($t['players']),
            'unknown' => $unknown,
            'file' => $file,
            'saved' => gmdate('c'),
        );
        $index = self::update_index(function ($list) use ($entry) {
            $list = array_filter($list, function ($x) use ($entry) {
                return isset($x['id']) && $x['id'] !== $entry['id'];
            });
            $list[] = $entry;
            usort($list, function ($a, $b) {
                return strcmp($b['date'], $a['date']);
            });
            return $list;
        });
        if ($index === false) {
            return new WP_Error('mtgstats_write', __('Could not update index.json', 'mtgstats'), array('status' => 500));
        }
        return rest_ensure_response(array('ok' => true, 'entry' => $entry));
    }

    public static function rest_delete_tournament(WP_REST_Request $req)
    {
        $id = (string) $req['id'];
        $s = self::storage();
        $path = $s['dir'] . '/t/' . $id . '.json';
        if (file_exists($path)) {
            wp_delete_file($path);
        }
        self::update_index(function ($list) use ($id) {
            return array_filter($list, function ($x) use ($id) {
                return isset($x['id']) && $x['id'] !== $id;
            });
        });
        return rest_ensure_response(array('ok' => true));
    }

    /** Copia locale delle regole MTGOFormatData (evita di riscaricarle a ogni import) */
    public static function rest_save_rules(WP_REST_Request $req)
    {
        $data = json_decode($req->get_body(), true);
        if (!is_array($data) || !isset($data['archetypes']) || !is_array($data['archetypes'])) {
            return new WP_Error('mtgstats_bad_rules', __('Invalid rules', 'mtgstats'), array('status' => 400));
        }
        self::ensure_storage();
        $s = self::storage();
        $name = preg_replace('/[^A-Za-z0-9_-]/', '', (string) $req['format']);
        if (!self::write_json($s['dir'] . '/rules/' . $name . '.json', $data)) {
            return new WP_Error('mtgstats_write', __('Could not save the rules', 'mtgstats'), array('status' => 500));
        }
        return rest_ensure_response(array('ok' => true));
    }

    /**
     * Proxy verso melee.gg: il browser non puo chiamarlo direttamente (CORS).
     * Solo per amministratori e solo per i percorsi in MELEE_PATHS.
     */
    public static function rest_melee_proxy(WP_REST_Request $req)
    {
        $p = $req->get_json_params();
        $path = isset($p['path']) ? (string) $p['path'] : '';
        $method = (isset($p['method']) && strtoupper($p['method']) === 'POST') ? 'POST' : 'GET';
        if (!preg_match(self::MELEE_PATHS, $path)) {
            return new WP_Error('mtgstats_proxy', __('Path not allowed', 'mtgstats'), array('status' => 400));
        }
        $args = array(
            'method' => $method,
            'timeout' => 45,
            'redirection' => 2,
            'headers' => array(
                'User-Agent' => 'Mozilla/5.0 (compatible; MTGStats/' . MTGSTATS_VERSION . '; +' . home_url('/') . ')',
                'Accept' => $method === 'POST' ? 'application/json' : 'text/html',
                'X-Requested-With' => 'XMLHttpRequest',
            ),
        );
        if ($method === 'POST') {
            $args['headers']['Content-Type'] = 'application/x-www-form-urlencoded; charset=UTF-8';
            $args['body'] = isset($p['body']) ? (string) $p['body'] : '';
        }
        $res = wp_remote_request('https://melee.gg' . $path, $args);
        if (is_wp_error($res)) {
            return new WP_Error('mtgstats_proxy', $res->get_error_message(), array('status' => 502));
        }
        return rest_ensure_response(array(
            'status' => wp_remote_retrieve_response_code($res),
            'body' => wp_remote_retrieve_body($res),
        ));
    }

    // -------------------------------------------------------------------------
    // Asset, shortcode e pagina admin
    // -------------------------------------------------------------------------

    public static function register_assets()
    {
        $url = plugins_url('assets/', MTGSTATS_FILE);
        // Version = plugin version + file modification time: browsers and caches always get the current file
        $ver = function ($file) {
            $path = plugin_dir_path(MTGSTATS_FILE) . 'assets/' . $file;
            return MTGSTATS_VERSION . (file_exists($path) ? '.' . filemtime($path) : '');
        };
        wp_register_script('mtgstats-i18n', $url . 'i18n.js', array(), $ver('i18n.js'), true);
        wp_register_script('mtgstats-core', $url . 'core.js', array('mtgstats-i18n'), $ver('core.js'), true);
        wp_register_script('mtgstats-melee', $url . 'melee.js', array('mtgstats-core'), $ver('melee.js'), true);
        wp_register_script('mtgstats-advanced', $url . 'advanced.js', array('mtgstats-core'), $ver('advanced.js'), true);
        wp_register_script('mtgstats-viewer', $url . 'viewer.js', array('mtgstats-core', 'mtgstats-advanced'), $ver('viewer.js'), true);
        wp_register_script('mtgstats-admin', $url . 'admin.js', array('mtgstats-core', 'mtgstats-melee', 'mtgstats-viewer'), $ver('admin.js'), true);
        wp_register_style('mtgstats-viewer', $url . 'viewer.css', array(), $ver('viewer.css'));
        wp_register_style('mtgstats-admin', $url . 'admin.css', array('mtgstats-viewer'), $ver('admin.css'));
    }

    /**
     * [mtgstats format="Modern" days="30" tournaments="id1,id2" tabs="meta,mu,pos,trend,conv,cards,players,data" theme="auto|light|dark" accent="#2a78d6" prior="10" lang="en|it"]
     */
    public static function shortcode($atts)
    {
        $set = self::settings();
        $a = shortcode_atts(array(
            'format' => '',
            'days' => '30',
            'tournaments' => '',
            'tabs' => '',
            'theme' => 'auto',
            'accent' => (string) $set['accent'],
            'prior' => (string) $set['prior'],
            'lang' => '',
        ), $atts, 'mtgstats');
        $lang = in_array($a['lang'], array('en', 'it'), true) ? $a['lang'] : self::language(determine_locale());
        wp_enqueue_style('mtgstats-viewer');
        wp_enqueue_script('mtgstats-viewer');
        $s = self::storage();
        return sprintf(
            '<div class="mtgstats-app" data-src="%s" data-format="%s" data-days="%s" data-tournaments="%s" data-tabs="%s" data-theme="%s" data-accent="%s" data-prior="%s" data-lang="%s"><noscript>%s</noscript></div>',
            esc_attr($s['url']),
            esc_attr($a['format']),
            esc_attr($a['days']),
            esc_attr($a['tournaments']),
            esc_attr($a['tabs']),
            esc_attr(in_array($a['theme'], array('light', 'dark', 'auto'), true) ? $a['theme'] : 'auto'),
            esc_attr((string) sanitize_hex_color($a['accent'])),
            esc_attr((string) max(0, (int) $a['prior'])),
            esc_attr($lang),
            esc_html__('Enable JavaScript to see the statistics.', 'mtgstats')
        );
    }

    /** Interface language for the dashboard and the admin panel: Italian for it_* locales, English otherwise */
    public static function language($locale)
    {
        return strpos((string) $locale, 'it') === 0 ? 'it' : 'en';
    }

    public static function load_textdomain()
    {
        load_plugin_textdomain('mtgstats', false, dirname(plugin_basename(MTGSTATS_FILE)) . '/languages');
    }

    public static function admin_menu()
    {
        $hook = add_menu_page('MTG Stats', 'MTG Stats', 'manage_options', 'mtgstats', array(__CLASS__, 'render_admin'), 'dashicons-chart-bar', 58);
        add_action('load-' . $hook, array(__CLASS__, 'admin_assets'));
    }

    public static function admin_assets()
    {
        self::ensure_storage();
        add_action('admin_enqueue_scripts', function () {
            $s = self::storage();
            wp_enqueue_style('mtgstats-admin');
            wp_enqueue_script('mtgstats-admin');
            wp_add_inline_script('mtgstats-admin', 'window.MTGStatsAdminConfig = ' . wp_json_encode(array(
                'restUrl' => esc_url_raw(rest_url(self::NS)),
                'nonce' => wp_create_nonce('wp_rest'),
                'dataUrl' => $s['url'],
                'settings' => self::settings(),
                'version' => MTGSTATS_VERSION,
                'lang' => self::language(get_user_locale()),
            )) . ';', 'before');
        });
    }

    public static function render_admin()
    {
        echo '<div class="wrap"><h1>MTG Stats</h1><div id="mtgstats-admin"><p>' . esc_html__('Loading…', 'mtgstats') . '</p></div></div>';
    }

    public static function action_links($links)
    {
        array_unshift($links, '<a href="' . esc_url(admin_url('admin.php?page=mtgstats')) . '">' . esc_html__('Manage', 'mtgstats') . '</a>');
        return $links;
    }
}

MTGStats_Plugin::init();
