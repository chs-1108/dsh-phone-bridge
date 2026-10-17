package com.dsh.phonebridge;

import android.content.Context;
import android.content.SharedPreferences;

/** Persisted pairing state: the tunnel base URL and the bridge token. */
final class BridgeConfig {

    private static final String PREFS = "phone_bridge";
    private static final String KEY_BASE = "base_url";
    private static final String KEY_TOKEN = "token";
    private static final String KEY_THINKING = "show_thinking";
    /**
     * Set once the user explicitly asks to forget this host. Without it a build
     * that carries build-time defaults can never be un-paired: baseUrl() falls
     * back to DEFAULT_BASE when the stored value is missing, so removing the keys
     * left paired() true and the setup screen bounced straight back to the chat.
     */
    private static final String KEY_UNPAIRED = "unpaired";

    /**
     * Build-time defaults. When this build is compiled for one specific host (the
     * Tailscale / tunnel address of the PC running DSH), the app starts already
     * paired and never shows the setup screen. Leave both empty for a generic
     * build that pairs by scanning the QR code.
     */
    private static final String DEFAULT_BASE = BuildDefaults.BASE_URL;
    private static final String DEFAULT_TOKEN = BuildDefaults.TOKEN;

    private BridgeConfig() {
    }

    private static SharedPreferences prefs(Context ctx) {
        return ctx.getApplicationContext().getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    static String baseUrl(Context ctx) {
        if (prefs(ctx).getBoolean(KEY_UNPAIRED, false)) return "";
        String v = prefs(ctx).getString(KEY_BASE, "");
        if (v == null || v.trim().isEmpty()) {
            return DEFAULT_BASE;
        }
        return v.trim();
    }

    static String token(Context ctx) {
        if (prefs(ctx).getBoolean(KEY_UNPAIRED, false)) return "";
        String v = prefs(ctx).getString(KEY_TOKEN, "");
        if (v == null || v.trim().isEmpty()) {
            return DEFAULT_TOKEN;
        }
        return v.trim();
    }

    static boolean paired(Context ctx) {
        return baseUrl(ctx).length() > 0 && token(ctx).length() > 0;
    }

    static boolean showThinking(Context ctx) {
        return prefs(ctx).getBoolean(KEY_THINKING, false);
    }

    static void setShowThinking(Context ctx, boolean value) {
        prefs(ctx).edit().putBoolean(KEY_THINKING, value).apply();
    }

    static void save(Context ctx, String baseUrl, String token) {
        // Same reason as clear(): the caller starts MainActivity straight away,
        // and MainActivity checks paired() before it will show the chat.
        prefs(ctx).edit()
                .putString(KEY_BASE, baseUrl == null ? "" : baseUrl.trim())
                .putString(KEY_TOKEN, token == null ? "" : token.trim())
                .remove(KEY_UNPAIRED)
                .commit();
    }

    /**
     * Forgets the current host.
     *
     * commit() rather than apply(): the caller launches SetupActivity right
     * afterwards, and SetupActivity reads this state in its own onCreate to
     * decide whether to show the pairing screen or bounce straight back to
     * MainActivity. apply() writes to memory now but to disk on a background
     * thread, and the in-memory copy is only guaranteed visible to the same
     * SharedPreferences instance - a second getSharedPreferences() from another
     * activity could still read the old values, which made "clear pairing"
     * land back on the chat screen.
     */
    static void clear(Context ctx) {
        // KEY_UNPAIRED is what actually makes the app forget: it also suppresses
        // the build-time defaults, which would otherwise restore the old host the
        // moment the stored keys are gone. save() removes it again.
        prefs(ctx).edit()
                .remove(KEY_BASE)
                .remove(KEY_TOKEN)
                .putBoolean(KEY_UNPAIRED, true)
                .commit();
    }

    /**
     * Normalizes whatever the user scanned or typed into a base URL ending at the
     * bridge route prefix, e.g. {@code http://100.101.102.103:19387/phone-bridge}.
     */
    static String normalizeBase(String raw) {
        if (raw == null) {
            return "";
        }
        String v = raw.trim();
        if (v.isEmpty()) {
            return "";
        }
        int hash = v.indexOf('#');
        if (hash >= 0) {
            v = v.substring(0, hash);
        }
        int q = v.indexOf('?');
        if (q >= 0) {
            v = v.substring(0, q);
        }
        while (v.endsWith("/")) {
            v = v.substring(0, v.length() - 1);
        }
        return v;
    }

    /** Extracts the token from a pairing URL fragment ({@code #t=...}) or query. */
    static String tokenFromPairUrl(String raw) {
        if (raw == null) {
            return "";
        }
        String v = raw.trim();
        int marker = v.indexOf("#t=");
        if (marker < 0) {
            marker = v.indexOf("?t=");
        }
        if (marker < 0) {
            marker = v.indexOf("&t=");
        }
        if (marker < 0) {
            return "";
        }
        String rest = v.substring(marker + 3);
        int end = rest.length();
        for (int i = 0; i < rest.length(); i++) {
            char c = rest.charAt(i);
            if (c == '&' || c == '#' || c == ' ') {
                end = i;
                break;
            }
        }
        return rest.substring(0, end).trim();
    }
}
