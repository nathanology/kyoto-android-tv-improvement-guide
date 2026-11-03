package com.kyoto.home;

import java.util.List;

/** Same T 3 screen, listing every installed TV app. Back returns home. */
public class AllAppsActivity extends HomeActivity {
    @Override protected List<Apps.Entry> entries() { return Apps.all(this); }

    @Override protected boolean isHome() { return false; }
}
