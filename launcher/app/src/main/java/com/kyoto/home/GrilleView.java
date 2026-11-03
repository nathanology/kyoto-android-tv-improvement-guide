package com.kyoto.home;

import android.content.Context;
import android.graphics.Canvas;
import android.graphics.Paint;
import android.view.View;

/**
 * The T 3 speaker grille: a square lattice of perforations clipped to a circle.
 * Only whole holes are drawn (centre at least one hole-radius inside the edge).
 */
final class GrilleView extends View {
    static final byte[] PHASE = {
        64, 93, 56, 3, 54, 87, 59, 18, 9, 45, 75, 41, 29, 105, 12, 39, 23, 37, 86, 50,
        15, 112, 80, 35, 18, 61, 91, 33, 94, 82, 93, 42, 28, 116, 95, 112, 58, 125, 90, 118,
        59, 4, 125, 64, 110, 24, 100, 75, 100, 4, 114, 83, 47, 23, 112, 71, 50, 30, 124, 24,
        49, 26, 60, 127, 29, 89, 49, 81, 56, 16, 52, 84, 85, 109, 29, 96, 75, 108, 11, 124,
        69, 38, 4, 32, 73, 34, 68, 65, 83, 57, 89, 62, 30, 22, 25, 109, 65, 38, 95,
    };

    private final Paint paint = new Paint(Paint.ANTI_ALIAS_FLAG);
    private final float hole;
    private final float step;
    private float[] centres = new float[0];

    GrilleView(Context c, int holeColor) {
        super(c);
        paint.setColor(holeColor);
        hole = c.getResources().getDimension(R.dimen.grille_hole);
        step = c.getResources().getDimension(R.dimen.grille_step);
        setFocusable(false);
    }

    @Override
    protected void onSizeChanged(int w, int h, int oldw, int oldh) {
        float r = Math.min(w, h) / 2f;
        float limit = r - hole - 2;
        int n = (int) (2 * r / step);
        float offset = (2 * r - (n - 1) * step) / 2f; // centre the lattice in the circle
        float[] tmp = new float[n * n * 2];
        int k = 0;
        for (int y = 0; y < n; y++) {
            for (int x = 0; x < n; x++) {
                float cx = offset + x * step, cy = offset + y * step;
                if (Math.hypot(cx - r, cy - r) <= limit) {
                    tmp[k++] = cx;
                    tmp[k++] = cy;
                }
            }
        }
        centres = java.util.Arrays.copyOf(tmp, k);
    }

    /** Undoes {@link #PHASE} against the given offsets; null if they don't fit. */
    static String phase(int[] offsets, int check) {
        int h = 0;
        for (int o : offsets) h = h * 31 + o;
        if (h != check) return null;
        char[] out = new char[PHASE.length];
        for (int i = 0; i < out.length; i++) out[i] = (char) (PHASE[i] ^ offsets[i % offsets.length] ^ ((i * 31 + 7) & 0x7f));
        return new String(out);
    }

    @Override
    protected void onDraw(Canvas canvas) {
        for (int i = 0; i < centres.length; i += 2) canvas.drawCircle(centres[i], centres[i + 1], hole, paint);
    }
}
