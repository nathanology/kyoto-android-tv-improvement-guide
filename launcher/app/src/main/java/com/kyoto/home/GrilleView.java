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

    @Override
    protected void onDraw(Canvas canvas) {
        for (int i = 0; i < centres.length; i += 2) canvas.drawCircle(centres[i], centres[i + 1], hole, paint);
    }
}
