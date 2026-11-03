package com.kyoto.home;

import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.graphics.Typeface;
import android.graphics.drawable.ColorDrawable;
import android.graphics.drawable.Drawable;
import android.graphics.drawable.GradientDrawable;
import android.graphics.drawable.LayerDrawable;
import android.media.tv.TvContract;
import android.media.tv.TvInputInfo;
import android.media.tv.TvInputManager;
import android.os.Bundle;
import android.provider.Settings;
import android.text.format.DateFormat;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.KeyEvent;
import android.view.View;
import android.view.ViewGroup;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextClock;
import android.widget.TextView;

import java.util.ArrayList;
import java.util.Collections;
import java.util.Date;
import java.util.List;
import java.util.Locale;

/**
 * Kyoto Home, direction B ("T 3", after Braun's 1958 pocket radio).
 *
 *  ┌──────────────────────────────────────────────────────────────┐
 *  │  ━━━━━━━━━━━━━━━━━━━━━━━━━━━          ·  ·  ·  ·             │
 *  │  ● Netflix                 01      ·  ·  ·  ·  ·  ·          │
 *  │    YouTube                 02     ·  ·  grille  ·  ·         │
 *  │    …                                ·  ·  ·  ·  ·            │
 *  │    PBS                     10                                │
 *  │  hdmi 1  hdmi 2 … all apps settings        9:41              │
 *  │                                       sunday 1 november      │
 *  └──────────────────────────────────────────────────────────────┘
 *
 * Up/down moves through the list, down from the last row reaches the bottom labels,
 * OK opens. The only colour is the orange focus dot. No animation, no images.
 */
public class HomeActivity extends Activity {
    private LinearLayout list;
    private LinearLayout sub;
    private TextView date;
    private int focusedRow = 0;
    private final List<View> rows = new ArrayList<>();
    private Palette pal;
    /** Set when the theme toggle recreated the activity, so focus returns to the toggle. */
    private static boolean focusThemeToggle = false;

    private final BroadcastReceiver ticker = new BroadcastReceiver() {
        @Override public void onReceive(Context c, Intent i) { updateDate(); }
    };

    /** Overridden by AllAppsActivity. */
    protected List<Apps.Entry> entries() { return Apps.home(this); }

    /** Home ignores Back; the all-apps screen closes on it. */
    protected boolean isHome() { return true; }

    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);
        pal = Palette.current(this);
        getWindow().setBackgroundDrawable(new ColorDrawable(pal.casing));
        setContentView(buildLayout());
    }

    @Override
    protected void onResume() {
        super.onResume();
        populate();
        IntentFilter f = new IntentFilter(Intent.ACTION_TIME_TICK);
        f.addAction(Intent.ACTION_TIME_CHANGED);
        f.addAction(Intent.ACTION_TIMEZONE_CHANGED);
        f.addAction(Intent.ACTION_DATE_CHANGED);
        registerReceiver(ticker, f);
        updateDate();
    }

    @Override
    protected void onPause() {
        super.onPause();
        unregisterReceiver(ticker);
    }

    // ---- layout --------------------------------------------------------------------------

    private View buildLayout() {
        FrameLayout root = new FrameLayout(this);
        int mx = px(R.dimen.margin_x), my = px(R.dimen.margin_y);

        LinearLayout left = new LinearLayout(this);
        left.setOrientation(LinearLayout.VERTICAL);
        FrameLayout.LayoutParams lp = new FrameLayout.LayoutParams(px(R.dimen.list_width), ViewGroup.LayoutParams.MATCH_PARENT);
        lp.setMargins(mx, my, 0, my);
        root.addView(left, lp);

        View topRule = new View(this);
        topRule.setBackgroundColor(pal.ink);
        left.addView(topRule, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, dp(1)));

        // The list scrolls only if there are more rows than fit (all-apps screen).
        ScrollView scroll = new ScrollView(this);
        scroll.setVerticalScrollBarEnabled(false);
        // Without this, ScrollView scrolls a fading-edge's worth past the focused row,
        // which pushed Netflix and the top rule out of view.
        scroll.setVerticalFadingEdgeEnabled(false);
        scroll.setFadingEdgeLength(0);
        scroll.setFocusable(false);
        list = new LinearLayout(this);
        list.setOrientation(LinearLayout.VERTICAL);
        scroll.addView(list);
        left.addView(scroll, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, px(R.dimen.row_height) * 10 + dp(1)));

        // The bottom row lives in the root, not the list column, so it may run wider than the list.
        sub = new LinearLayout(this);
        sub.setOrientation(LinearLayout.HORIZONTAL);
        FrameLayout.LayoutParams sp = new FrameLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        sp.topMargin = my + dp(1) + px(R.dimen.row_height) * 10 + dp(1) + px(R.dimen.sub_gap);
        sp.leftMargin = mx - dotSlot(); // label text aligns with the list's left edge; the dot hangs in the margin
        root.addView(sub, sp);

        GrilleView grille = new GrilleView(this, pal.rule);
        FrameLayout.LayoutParams gp = new FrameLayout.LayoutParams(px(R.dimen.grille), px(R.dimen.grille), Gravity.TOP | Gravity.END);
        gp.setMargins(0, my, mx, 0);
        root.addView(grille, gp);

        LinearLayout clock = new LinearLayout(this);
        clock.setOrientation(LinearLayout.VERTICAL);
        clock.setGravity(Gravity.CENTER_HORIZONTAL);
        TextClock time = new TextClock(this);
        time.setFormat12Hour("h:mm");
        time.setFormat24Hour("H:mm");
        time.setTextColor(pal.ink);
        time.setTextSize(TypedValue.COMPLEX_UNIT_PX, px(R.dimen.text_clock));
        time.setTypeface(getResources().getFont(R.font.inter_extralight));
        time.setGravity(Gravity.CENTER_HORIZONTAL);
        time.setLetterSpacing(-0.04f);
        time.setIncludeFontPadding(false);
        clock.addView(time);
        date = label("");
        LinearLayout.LayoutParams dp = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        dp.topMargin = dp(7);
        clock.addView(date, dp);
        FrameLayout.LayoutParams cp = new FrameLayout.LayoutParams(px(R.dimen.grille), ViewGroup.LayoutParams.WRAP_CONTENT, Gravity.BOTTOM | Gravity.END);
        cp.setMargins(0, 0, mx, my);
        root.addView(clock, cp);
        return root;
    }

    private void populate() {
        list.removeAllViews();
        rows.clear();
        List<Apps.Entry> apps = entries();
        for (int i = 0; i < apps.size(); i++) {
            View row = row(apps.get(i), i + 1);
            rows.add(row);
            list.addView(row);
        }
        sub.removeAllViews();
        if (isHome()) {
            for (Input in : hdmiInputs()) sub.addView(subLabel(in.label, v -> openInput(in.id)));
            sub.addView(subLabel(getString(R.string.all_apps), v -> startActivity(new Intent(this, AllAppsActivity.class))));
            sub.addView(subLabel(getString(R.string.settings), v -> open(new Intent(Settings.ACTION_SETTINGS))));
            sub.addView(subLabel(getString(pal.dark ? R.string.light_mode : R.string.dark_mode), v -> toggleTheme()));
        } else {
            sub.addView(subLabel(getString(R.string.back), v -> finish()));
        }
        wireFocus();
        View target = rows.isEmpty() ? sub.getChildAt(0) : rows.get(Math.min(focusedRow, rows.size() - 1));
        if (focusThemeToggle && isHome()) {
            focusThemeToggle = false;
            target = sub.getChildAt(sub.getChildCount() - 1);
        }
        if (target != null) target.requestFocus();
    }

    /** Down from the last row → first bottom label; up from any bottom label → last row. */
    private void wireFocus() {
        if (rows.isEmpty() || sub.getChildCount() == 0) return;
        View last = rows.get(rows.size() - 1);
        View firstSub = sub.getChildAt(0);
        last.setId(View.generateViewId());
        firstSub.setId(View.generateViewId());
        last.setNextFocusDownId(firstSub.getId());
        for (int i = 0; i < sub.getChildCount(); i++) sub.getChildAt(i).setNextFocusUpId(last.getId());
    }

    private View row(Apps.Entry e, int n) {
        LinearLayout row = new LinearLayout(this);
        row.setOrientation(LinearLayout.HORIZONTAL);
        row.setGravity(Gravity.CENTER_VERTICAL);
        row.setFocusable(true);
        row.setMinimumHeight(px(R.dimen.row_height));

        View dot = new View(this);
        dot.setBackground(circle(pal.signal));
        dot.setVisibility(View.INVISIBLE);
        LinearLayout.LayoutParams dl = new LinearLayout.LayoutParams(px(R.dimen.dot), px(R.dimen.dot));
        dl.leftMargin = dp(4);
        dl.rightMargin = px(R.dimen.row_indent) - px(R.dimen.dot) - dp(4);
        row.addView(dot, dl);

        TextView name = new TextView(this);
        name.setText(e.label);
        name.setTextSize(TypedValue.COMPLEX_UNIT_PX, px(R.dimen.text_row));
        name.setLetterSpacing(-0.01f);
        name.setSingleLine(true);
        name.setTextColor(pal.quiet);
        row.addView(name, new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f));

        TextView num = new TextView(this);
        num.setText(String.format(Locale.ROOT, "%02d", n));
        num.setTextSize(TypedValue.COMPLEX_UNIT_PX, px(R.dimen.text_num));
        num.setLetterSpacing(0.06f);
        num.setTextColor(pal.rule);
        row.addView(num);

        row.setBackground(hairline());

        Typeface regular = getResources().getFont(R.font.inter_regular);
        Typeface medium = getResources().getFont(R.font.inter_medium);
        name.setTypeface(regular);
        num.setTypeface(regular);
        row.setOnFocusChangeListener((v, has) -> {
            dot.setVisibility(has ? View.VISIBLE : View.INVISIBLE);
            name.setTextColor(has ? pal.ink : pal.quiet);
            name.setTypeface(has ? medium : regular);
            num.setTextColor(has ? pal.quiet : pal.rule);
            if (has) focusedRow = rows.indexOf(v);
        });
        row.setOnClickListener(v -> {
            Intent i = Apps.launchIntent(getPackageManager(), e.pkg);
            if (i != null) open(i);
        });
        return row;
    }

    private TextView subLabel(String text, View.OnClickListener onClick) {
        TextView t = label(text);
        t.setFocusable(true);
        t.setSingleLine(true);
        t.setPadding(0, dp(6), 0, dp(6));
        GradientDrawable dot = circle(pal.signal);
        int d = px(R.dimen.dot_small);
        dot.setBounds(0, 0, d, d);
        t.setCompoundDrawablePadding(dotSlot() - d);
        // The dot's space is always reserved so neighbouring labels never shift.
        dot.setAlpha(0);
        t.setCompoundDrawables(dot, null, null, null);
        t.setOnFocusChangeListener((v, has) -> {
            t.setTextColor(has ? pal.ink : pal.quiet);
            dot.setAlpha(has ? 255 : 0);
        });
        t.setOnClickListener(onClick);
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        lp.rightMargin = px(R.dimen.sub_gap) - dotSlot(); // the next label's dot slot completes the gap
        t.setLayoutParams(lp);
        return t;
    }

    private TextView label(String text) {
        TextView t = new TextView(this);
        t.setText(text);
        t.setTextSize(TypedValue.COMPLEX_UNIT_PX, px(R.dimen.text_label));
        t.setLetterSpacing(0.04f);
        t.setTextColor(pal.quiet);
        t.setTypeface(getResources().getFont(R.font.inter_regular));
        return t;
    }

    /** 1px rule along the bottom edge of a row. */
    private LayerDrawable hairline() {
        GradientDrawable line = new GradientDrawable();
        line.setColor(pal.rule);
        LayerDrawable ld = new LayerDrawable(new Drawable[]{line});
        ld.setLayerGravity(0, Gravity.BOTTOM | Gravity.FILL_HORIZONTAL);
        ld.setLayerHeight(0, 1);
        return ld;
    }

    private static GradientDrawable circle(int color) {
        GradientDrawable g = new GradientDrawable();
        g.setShape(GradientDrawable.OVAL);
        g.setColor(color);
        return g;
    }

    private void updateDate() {
        // Fixed "sunday 1 november" order, as in the approved design.
        date.setText(DateFormat.format("EEEE d MMMM", new Date()).toString().toLowerCase(Locale.getDefault()));
    }

    // ---- inputs & launching --------------------------------------------------------------

    private static final class Input {
        final String id;
        final String label;
        Input(String id, String label) { this.id = id; this.label = label; }
    }

    /** HDMI inputs, numbered in hardware order (HW2 → hdmi 1 on this Hisense). */
    private List<Input> hdmiInputs() {
        List<Input> out = new ArrayList<>();
        TvInputManager tim = getSystemService(TvInputManager.class);
        if (tim == null) return out;
        List<TvInputInfo> hdmi = new ArrayList<>();
        try {
            for (TvInputInfo info : tim.getTvInputList()) {
                if (info.getType() == TvInputInfo.TYPE_HDMI && info.getParentId() == null) hdmi.add(info);
            }
        } catch (SecurityException ignored) {
            return out;
        }
        Collections.sort(hdmi, (a, b) -> a.getId().compareTo(b.getId()));
        for (int i = 0; i < hdmi.size(); i++) out.add(new Input(hdmi.get(i).getId(), "hdmi " + (i + 1)));
        return out;
    }

    private void openInput(String inputId) {
        open(new Intent(Intent.ACTION_VIEW, TvContract.buildChannelUriForPassthroughInput(inputId)));
    }

    private void open(Intent i) {
        i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        try {
            startActivity(i);
        } catch (ActivityNotFoundException | SecurityException ignored) {
            // Nothing sensible to show; the row simply does nothing.
        }
    }

    private void toggleTheme() {
        Palette.setDark(this, !pal.dark);
        focusThemeToggle = true;
        recreate();
    }

    // ---- keys ----------------------------------------------------------------------------

    @Override
    public boolean onKeyDown(int keyCode, KeyEvent event) {
        switch (keyCode) {
            case KeyEvent.KEYCODE_SEARCH:
            case KeyEvent.KEYCODE_VOICE_ASSIST:
            case KeyEvent.KEYCODE_ASSIST:
                startVoiceSearch();
                return true;
            default:
                return super.onKeyDown(keyCode, event);
        }
    }

    /** Hand the remote's mic button to Google voice search (katniss). */
    private void startVoiceSearch() {
        Intent[] tries = {
            new Intent(Intent.ACTION_ASSIST),
            new Intent("android.search.action.GLOBAL_SEARCH"),
        };
        for (Intent i : tries) {
            i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            try {
                startActivity(i);
                return;
            } catch (ActivityNotFoundException ignored) {
                // try the next one
            }
        }
    }

    @Override
    public void onBackPressed() {
        if (!isHome()) super.onBackPressed();
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        // Pressing Home while already home returns focus to the top of the list.
        focusedRow = 0;
    }

    // ---- units ---------------------------------------------------------------------------

    /** Width reserved before each bottom label for its focus dot (dot + gap). */
    private int dotSlot() { return px(R.dimen.dot_small) + dp(6); }

    private int px(int dimenRes) { return getResources().getDimensionPixelSize(dimenRes); }

    private int dp(int v) { return Math.round(v * getResources().getDisplayMetrics().density); }
}
