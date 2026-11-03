package com.kyoto.home;

import android.content.Context;
import android.content.Intent;
import android.content.pm.ApplicationInfo;
import android.content.pm.PackageManager;
import android.content.pm.ResolveInfo;

import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.Locale;

/** Which apps appear, in what order, and how to open them. */
final class Apps {
    static final class Entry {
        final String pkg;
        final String label;
        Entry(String pkg, String label) { this.pkg = pkg; this.label = label; }
    }

    private Apps() {}

    /** Home list from res/values/strings.xml: "pkg[,fallback]|Label", skipping anything not installed. */
    static List<Entry> home(Context c) {
        PackageManager pm = c.getPackageManager();
        List<Entry> out = new ArrayList<>();
        for (String line : c.getResources().getStringArray(R.array.home_apps)) {
            int bar = line.indexOf('|');
            if (bar < 0) continue;
            String label = line.substring(bar + 1);
            for (String pkg : line.substring(0, bar).split(",")) {
                if (launchIntent(pm, pkg.trim()) != null) {
                    out.add(new Entry(pkg.trim(), label));
                    break;
                }
            }
        }
        return out;
    }

    /** Every launchable TV app except this one, sorted by name. */
    static List<Entry> all(Context c) {
        PackageManager pm = c.getPackageManager();
        Intent probe = new Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_LEANBACK_LAUNCHER);
        List<Entry> out = new ArrayList<>();
        for (ResolveInfo ri : pm.queryIntentActivities(probe, 0)) {
            ApplicationInfo ai = ri.activityInfo.applicationInfo;
            if (ai.packageName.equals(c.getPackageName()) || !ai.enabled) continue;
            out.add(new Entry(ai.packageName, String.valueOf(ri.loadLabel(pm))));
        }
        Collections.sort(out, (a, b) -> a.label.toLowerCase(Locale.ROOT).compareTo(b.label.toLowerCase(Locale.ROOT)));
        return out;
    }

    static Intent launchIntent(PackageManager pm, String pkg) {
        try {
            if (!pm.getApplicationInfo(pkg, 0).enabled) return null;
        } catch (PackageManager.NameNotFoundException e) {
            return null;
        }
        Intent i = pm.getLeanbackLaunchIntentForPackage(pkg);
        if (i == null) i = pm.getLaunchIntentForPackage(pkg);
        return i;
    }
}
