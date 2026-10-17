package com.dsh.phonebridge;

import android.app.Activity;
import android.content.Intent;
import android.graphics.ImageFormat;
import android.hardware.Camera;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.util.Log;
import android.view.Surface;
import android.view.SurfaceHolder;
import android.view.SurfaceView;
import android.view.ViewGroup;
import android.widget.FrameLayout;
import android.widget.TextView;

import com.google.zxing.BarcodeFormat;
import com.google.zxing.BinaryBitmap;
import com.google.zxing.DecodeHintType;
import com.google.zxing.MultiFormatReader;
import com.google.zxing.NotFoundException;
import com.google.zxing.PlanarYUVLuminanceSource;
import com.google.zxing.Result;
import com.google.zxing.common.HybridBinarizer;

import java.util.ArrayList;
import java.util.EnumMap;
import java.util.List;
import java.util.Map;

/** Minimal QR scanner: camera preview + zxing core decoding. */
@SuppressWarnings("deprecation")
public final class ScanActivity extends Activity implements SurfaceHolder.Callback, Camera.PreviewCallback {

    static final String EXTRA_RESULT = "scan_result";
    private static final String TAG = "phone-bridge-scan";

    private SurfaceView preview;
    private TextView hint;
    private Camera camera;
    private MultiFormatReader reader;
    private volatile boolean handled;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        FrameLayout root = new FrameLayout(this);
        preview = new SurfaceView(this);
        root.addView(preview, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));

        hint = new TextView(this);
        hint.setText("把电脑屏幕上的二维码放进取景框");
        hint.setTextColor(0xffffffff);
        hint.setBackgroundColor(0x99000000);
        hint.setPadding(24, 18, 24, 18);
        FrameLayout.LayoutParams hp = new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        hp.gravity = android.view.Gravity.CENTER_HORIZONTAL | android.view.Gravity.BOTTOM;
        hp.bottomMargin = 64;
        root.addView(hint, hp);

        setContentView(root);
        preview.getHolder().addCallback(this);
    }

    @Override
    protected void onResume() {
        super.onResume();
        handled = false;
    }

    @Override
    protected void onPause() {
        releaseCamera();
        super.onPause();
    }

    private void releaseCamera() {
        Camera c = camera;
        camera = null;
        if (c != null) {
            try {
                c.setPreviewCallback(null);
                c.stopPreview();
            } catch (Exception ignored) {
                // camera already gone
            }
            try {
                c.release();
            } catch (Exception ignored) {
                // camera already gone
            }
        }
    }

    @Override
    public void surfaceCreated(SurfaceHolder holder) {
        try {
            camera = Camera.open();
        } catch (Exception e) {
            hint.setText("无法打开相机：" + e.getMessage());
            return;
        }
        if (camera == null) {
            hint.setText("无法打开相机");
            return;
        }
        try {
            Camera.Parameters params = camera.getParameters();
            params.setPreviewFormat(ImageFormat.NV21);
            Camera.Size size = pickSize(params.getSupportedPreviewSizes());
            if (size != null) {
                params.setPreviewSize(size.width, size.height);
            }
            List<String> modes = params.getSupportedFocusModes();
            if (modes != null && modes.contains(Camera.Parameters.FOCUS_MODE_CONTINUOUS_PICTURE)) {
                params.setFocusMode(Camera.Parameters.FOCUS_MODE_CONTINUOUS_PICTURE);
            }
            camera.setParameters(params);
            camera.setPreviewDisplay(holder);
            camera.setDisplayOrientation(displayOrientation());
            camera.setPreviewCallback(this);
            camera.startPreview();
        } catch (Exception e) {
            hint.setText("相机初始化失败：" + e.getMessage());
            releaseCamera();
        }
    }

    private Camera.Size pickSize(List<Camera.Size> sizes) {
        if (sizes == null || sizes.isEmpty()) {
            return null;
        }
        Camera.Size best = null;
        for (Camera.Size s : sizes) {
            if (s.width >= 640 && s.width <= 1280) {
                if (best == null || s.width < best.width) {
                    best = s;
                }
            }
        }
        return best != null ? best : sizes.get(0);
    }

    private int displayOrientation() {
        Camera.CameraInfo info = new Camera.CameraInfo();
        Camera.getCameraInfo(0, info);
        int rotation = getWindowManager().getDefaultDisplay().getRotation();
        int degrees = 0;
        switch (rotation) {
            case Surface.ROTATION_90:
                degrees = 90;
                break;
            case Surface.ROTATION_180:
                degrees = 180;
                break;
            case Surface.ROTATION_270:
                degrees = 270;
                break;
            default:
                degrees = 0;
                break;
        }
        int result;
        if (info.facing == Camera.CameraInfo.CAMERA_FACING_FRONT) {
            result = (info.orientation + degrees) % 360;
            result = (360 - result) % 360;
        } else {
            result = (info.orientation - degrees + 360) % 360;
        }
        return result;
    }

    @Override
    public void surfaceChanged(SurfaceHolder holder, int format, int width, int height) {
        // preview already running
    }

    @Override
    public void surfaceDestroyed(SurfaceHolder holder) {
        releaseCamera();
    }

    @Override
    public void onPreviewFrame(byte[] data, Camera cam) {
        if (handled || data == null || cam == null) {
            return;
        }
        Camera.Size size;
        try {
            size = cam.getParameters().getPreviewSize();
        } catch (Exception e) {
            return;
        }
        if (size == null) {
            return;
        }
        final String text = decode(data, size.width, size.height);
        if (text != null && !text.isEmpty()) {
            handled = true;
            new Handler(Looper.getMainLooper()).post(new Runnable() {
                @Override
                public void run() {
                    Intent out = new Intent();
                    out.putExtra(EXTRA_RESULT, text);
                    setResult(RESULT_OK, out);
                    finish();
                }
            });
        }
    }

    private String decode(byte[] data, int width, int height) {
        MultiFormatReader r = reader;
        if (r == null) {
            r = new MultiFormatReader();
            Map<DecodeHintType, Object> hints = new EnumMap<DecodeHintType, Object>(DecodeHintType.class);
            List<BarcodeFormat> formats = new ArrayList<BarcodeFormat>();
            formats.add(BarcodeFormat.QR_CODE);
            hints.put(DecodeHintType.POSSIBLE_FORMATS, formats);
            hints.put(DecodeHintType.TRY_HARDER, Boolean.TRUE);
            r.setHints(hints);
            reader = r;
        }
        try {
            PlanarYUVLuminanceSource source =
                    new PlanarYUVLuminanceSource(data, width, height, 0, 0, width, height, false);
            BinaryBitmap bitmap = new BinaryBitmap(new HybridBinarizer(source));
            Result result = r.decodeWithState(bitmap);
            if (result != null && result.getText() != null) {
                return result.getText();
            }
        } catch (NotFoundException e) {
            // no QR in this frame
        } catch (Exception e) {
            Log.w(TAG, "decode failed: " + e);
        } finally {
            try {
                reader.reset();
            } catch (Exception ignored) {
                // nothing to reset
            }
        }
        return null;
    }
}
