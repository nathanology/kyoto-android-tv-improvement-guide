package com.kyoto.home;

import android.content.Context;
import android.content.SharedPreferences;

/**
 * The two Braun-era colour schemes. Light follows the white SK 4 / T 1000 casings; dark follows
 * the black ET 44 / ET 66 calculators and AB alarm clocks. Both use one accent, orange, for focus only.
 */
final class Palette {
    final boolean dark;
    final int casing;  // background
    final int rule;    // hairlines, grille holes, inactive numbers
    final int ink;     // focused text, clock
    final int quiet;   // unfocused text, labels
    final int signal;  // focus dot

    private Palette(boolean dark, int casing, int rule, int ink, int quiet, int signal) {
        this.dark = dark;
        this.casing = casing;
        this.rule = rule;
        this.ink = ink;
        this.quiet = quiet;
        this.signal = signal;
    }

    static final Palette LIGHT = new Palette(false, 0xFFECEAE4, 0xFFC9C6BE, 0xFF262624, 0xFF8E8B84, 0xFFE3591E);
    static final Palette DARK = new Palette(true, 0xFF1B1B1A, 0xFF3A3936, 0xFFE9E6DF, 0xFF85827B, 0xFFEB6426);

    private static final String PREFS = "kyoto";
    private static final String KEY_DARK = "dark";

    /** Dark is the default. */
    static Palette current(Context c) {
        return prefs(c).getBoolean(KEY_DARK, true) ? DARK : LIGHT;
    }

    static void setDark(Context c, boolean dark) {
        prefs(c).edit().putBoolean(KEY_DARK, dark).apply();
    }

    private static SharedPreferences prefs(Context c) {
        return c.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }
}
