package com.dsh.phonebridge;

import android.Manifest;
import android.app.Activity;
import android.content.ClipData;
import android.content.ContentResolver;
import android.content.ContentValues;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.database.Cursor;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Environment;
import android.provider.MediaStore;
import android.provider.OpenableColumns;
import android.view.KeyEvent;
import android.view.ViewGroup;
import android.webkit.PermissionRequest;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;
import android.widget.Toast;

import java.io.File;

/**
 * The bridge UI itself is the page served by the Host at
 * {@code <base>/?token=...}; this activity is only the shell that gives it a
 * WebView, camera/gallery file uploads, and a back button.
 */
public final class MainActivity extends Activity {

    private static final int REQ_FILE = 4001;
    private static final int REQ_CAMERA_PERMISSION = 4002;
    private static final int REQ_CAMERA_PERMISSION_FOR_FILE = 4003;
    private static final int REQ_NOTIFICATIONS = 4004;

    private WebView web;
    private ValueCallback<Uri[]> pendingFileCallback;
    private Uri pendingCaptureUri;
    private boolean pendingCaptureIsMediaStore;
    private Intent pendingChooser;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        if (!BridgeConfig.paired(this)) {
            startActivity(new Intent(this, SetupActivity.class));
            finish();
            return;
        }

        FrameLayout root = new FrameLayout(this);
        web = new WebView(this);
        root.addView(web, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        setContentView(root);

        WebSettings settings = web.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setDatabaseEnabled(true);
        settings.setLoadWithOverviewMode(true);
        settings.setUseWideViewPort(true);
        settings.setSupportZoom(false);
        settings.setMediaPlaybackRequiresUserGesture(false);
        settings.setAllowFileAccess(false);
        settings.setAllowContentAccess(true);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP) {
            settings.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        }

        // Pairing lives in SharedPreferences, which the page cannot touch. Expose
        // the one operation the UI genuinely needs: forget this host so the user
        // can point the app at their own computer instead.
        web.addJavascriptInterface(new Object() {
            @android.webkit.JavascriptInterface
            public void unpair() {
                runOnUiThread(new Runnable() {
                    @Override
                    public void run() {
                        BridgeConfig.clear(MainActivity.this);
                        BridgeService.stop(MainActivity.this);
                        startActivity(new Intent(MainActivity.this, SetupActivity.class));
                        finish();
                    }
                });
            }
        }, "PhoneBridge");

        web.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                Uri uri = request.getUrl();
                String scheme = uri.getScheme() == null ? "" : uri.getScheme();
                if (scheme.startsWith("http")) {
                    return false;
                }
                try {
                    startActivity(new Intent(Intent.ACTION_VIEW, uri));
                } catch (Exception ignored) {
                    // no handler installed
                }
                return true;
            }
        });

        web.setWebChromeClient(new WebChromeClient() {
            @Override
            public void onPermissionRequest(final PermissionRequest request) {
                runOnUiThread(new Runnable() {
                    @Override
                    public void run() {
                        request.grant(request.getResources());
                    }
                });
            }

            @Override
            public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback,
                                             FileChooserParams params) {
                if (pendingFileCallback != null) {
                    pendingFileCallback.onReceiveValue(null);
                }
                pendingFileCallback = callback;
                // onShowFileChooser can arrive off the main thread; launching
                // activities and requestPermissions both require it.
                runOnUiThread(new Runnable() {
                    @Override
                    public void run() {
                        openChooser(params);
                    }
                });
                return true;
            }
        });

        web.loadUrl(entryUrl());

        // Run as a foreground service so the WebView keeps its timers when the
        // phone goes idle. Android otherwise freezes a backgrounded page and the
        // poll loop stops, which is why replies stopped arriving once the screen
        // was off.
        BridgeService.start(this);
        requestNotificationPermissionIfNeeded();

        // Ask for the camera and media-read permissions up front so the first tap
        // on "拍照" opens the camera directly and the captured file can be read
        // back on API 33+. Posted instead of called inline so the dialog does not
        // race WebView setup for the window.
        if (!missingPermissions().isEmpty()) {
            web.postDelayed(new Runnable() {
                @Override
                public void run() {
                    java.util.List<String> missing = missingPermissions();
                    if (!isFinishing() && !missing.isEmpty()) {
                        requestPermissions(missing.toArray(new String[0]), REQ_CAMERA_PERMISSION);
                    }
                }
            }, 600);
        }
    }

    /**
     * The runtime permissions this build needs. CAMERA drives the capture intent;
     * READ_MEDIA_IMAGES (API 33+) lets us read the MediaStore entry the camera
     * wrote. Older releases grant gallery access implicitly through the picker.
     */
    private java.util.List<String> missingPermissions() {
        java.util.List<String> missing = new java.util.ArrayList<>();
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.M) {
            return missing;
        }
        if (checkSelfPermission(Manifest.permission.CAMERA) != PackageManager.PERMISSION_GRANTED) {
            missing.add(Manifest.permission.CAMERA);
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU
                && checkSelfPermission(Manifest.permission.READ_MEDIA_IMAGES)
                != PackageManager.PERMISSION_GRANTED) {
            missing.add(Manifest.permission.READ_MEDIA_IMAGES);
        }
        return missing;
    }

    private String entryUrl() {
        String base = BridgeConfig.baseUrl(this);
        String token = BridgeConfig.token(this);
        String sep = base.contains("?") ? "&" : "?";
        return base + "/" + sep + "token=" + Uri.encode(token);
    }

    private void openChooser(WebChromeClient.FileChooserParams params) {
        Intent chooser;
        try {
            chooser = params.createIntent();
        } catch (Exception e) {
            chooser = new Intent(Intent.ACTION_GET_CONTENT);
            chooser.setType("image/*");
        }
        Intent cameraIntent = buildCameraIntent();
        if (cameraIntent != null) {
            Intent combined = new Intent(Intent.ACTION_CHOOSER);
            combined.putExtra(Intent.EXTRA_INTENT, chooser);
            combined.putExtra(Intent.EXTRA_INITIAL_INTENTS, new Intent[]{cameraIntent});
            combined.putExtra(Intent.EXTRA_TITLE, "选择图片");
            chooser = combined;
        }
        // The chooser itself needs no permission, but the camera entry is useless
        // without CAMERA on API 23+. Prompt first and remember the chooser so the
        // user's tap still lands on the camera after granting.
        if (!missingPermissions().isEmpty() && cameraIntent != null) {
            pendingChooser = chooser;
            requestPermissions(missingPermissions().toArray(new String[0]), REQ_CAMERA_PERMISSION);
            return;
        }
        launchChooser(chooser);
    }

    private void launchChooser(Intent chooser) {
        try {
            startActivityForResult(chooser, REQ_FILE);
        } catch (Exception e) {
            cancelFileCallback();
            toast("无法打开图片选择器：" + e.getMessage());
        }
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] grantResults) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);
        if (requestCode == REQ_CAMERA_PERMISSION) {
            Intent chooser = pendingChooser;
            pendingChooser = null;
            boolean granted = grantResults.length > 0
                    && grantResults[0] == PackageManager.PERMISSION_GRANTED;
            if (chooser == null) {
                // Up-front request on launch: nothing to continue, just report.
                if (!granted) {
                    toast("未授予相机权限，仍可从相册选择图片");
                }
                return;
            }
            if (!granted) {
                toast("已拒绝相机权限，仍可从相册选择图片");
            }
            // Launch either way: the gallery branch works without CAMERA.
            launchChooser(chooser);
        } else if (requestCode == REQ_CAMERA_PERMISSION_FOR_FILE) {
            if (pendingFileCallback != null) {
                pendingFileCallback.onReceiveValue(null);
                pendingFileCallback = null;
            }
        }
    }

    private Intent buildCameraIntent() {
        if (!getPackageManager().hasSystemFeature(PackageManager.FEATURE_CAMERA_ANY)) {
            return null;
        }
        Intent intent = new Intent(MediaStore.ACTION_IMAGE_CAPTURE);

        // Write the capture into MediaStore rather than a private provider. Every
        // camera app on the device can already write there with no URI grant, so
        // this sidesteps the grant plumbing that silently left the file empty on
        // some OEM cameras (notably MIUI).
        Uri output = createImageOutputUri();
        if (output != null) {
            pendingCaptureUri = output;
            pendingCaptureIsMediaStore = true;
            intent.putExtra(MediaStore.EXTRA_OUTPUT, output);
            intent.addFlags(Intent.FLAG_GRANT_WRITE_URI_PERMISSION
                    | Intent.FLAG_GRANT_READ_URI_PERMISSION);
            intent.setClipData(ClipData.newRawUri("output", output));
            return intent;
        }

        // Fallback: our own provider, for devices where MediaStore is unavailable.
        File target = CaptureProvider.captureFile(this);
        pendingCaptureUri = CaptureProvider.captureUri(this);
        pendingCaptureIsMediaStore = false;
        intent.putExtra(MediaStore.EXTRA_OUTPUT, pendingCaptureUri);
        intent.addFlags(Intent.FLAG_GRANT_WRITE_URI_PERMISSION
                | Intent.FLAG_GRANT_READ_URI_PERMISSION);
        intent.setClipData(ClipData.newRawUri("output", pendingCaptureUri));
        //noinspection ResultOfMethodCallIgnored
        target.delete();
        return intent;
    }

    /**
     * Creates an empty pending entry in the shared MediaStore so a camera app can
     * write its full-resolution result there. Returns null when the device has no
     * usable external image volume.
     */
    private Uri createImageOutputUri() {
        ContentValues values = new ContentValues();
        values.put(MediaStore.Images.Media.DISPLAY_NAME, "dsh-bridge-" + System.currentTimeMillis() + ".jpg");
        values.put(MediaStore.Images.Media.MIME_TYPE, "image/jpeg");
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            values.put(MediaStore.Images.Media.RELATIVE_PATH, Environment.DIRECTORY_PICTURES);
        }
        try {
            return getContentResolver().insert(MediaStore.Images.Media.EXTERNAL_CONTENT_URI, values);
        } catch (Exception e) {
            return null;
        }
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode != REQ_FILE) {
            return;
        }
        ValueCallback<Uri[]> callback = pendingFileCallback;
        pendingFileCallback = null;
        Uri capture = pendingCaptureUri;
        boolean captureIsMediaStore = pendingCaptureIsMediaStore;
        pendingCaptureUri = null;
        pendingCaptureIsMediaStore = false;
        if (callback == null) {
            return;
        }
        if (resultCode != RESULT_OK) {
            // A cancelled capture may still have created an empty MediaStore row.
            if (capture != null && captureIsMediaStore) {
                discardMediaStoreEntry(capture);
            }
            callback.onReceiveValue(null);
            return;
        }
        Uri[] result = null;
        if (data != null && data.getData() != null) {
            result = new Uri[]{data.getData()};
        } else if (data != null && data.getClipData() != null) {
            int count = data.getClipData().getItemCount();
            result = new Uri[count];
            for (int i = 0; i < count; i++) {
                result[i] = data.getClipData().getItemAt(i).getUri();
            }
        } else if (capture != null) {
            if (captureIsMediaStore) {
                // The camera wrote into the shared MediaStore (data is null when
                // EXTRA_OUTPUT is used). Verify it actually landed before handing
                // the URI to the WebView.
                if (mediaStoreEntryHasBytes(capture)) {
                    result = new Uri[]{capture};
                } else {
                    discardMediaStoreEntry(capture);
                }
            } else {
                File file = CaptureProvider.captureFile(this);
                if (file.exists() && file.length() > 0) {
                    result = new Uri[]{capture};
                }
            }
        }
        if (result != null) {
            grantReadToWebView(result);
        }
        callback.onReceiveValue(result);
    }

    /** True when a MediaStore row exists and has non-zero size. */
    private boolean mediaStoreEntryHasBytes(Uri uri) {
        Cursor cursor = null;
        try {
            cursor = getContentResolver().query(uri,
                    new String[]{OpenableColumns.SIZE}, null, null, null);
            if (cursor != null && cursor.moveToFirst()) {
                long size = cursor.getLong(0);
                return size > 0;
            }
        } catch (Exception ignored) {
            // treat as missing
        } finally {
            if (cursor != null) {
                cursor.close();
            }
        }
        return false;
    }

    /** Removes a MediaStore row that no photo was written into. */
    private void discardMediaStoreEntry(Uri uri) {
        try {
            getContentResolver().delete(uri, null, null);
        } catch (Exception ignored) {
            // best effort
        }
    }

    /**
     * A content:// URI is only readable by the receiving process if the read
     * grant travels with it. The camera path returns our own provider URI, which
     * the WebView renderer cannot open unless these flags are granted explicitly
     * (gallery URIs arrive with FLAG_GRANT_READ_URI_PERMISSION already set by the
     * system, so this is a no-op there).
     */
    private void grantReadToWebView(Uri[] uris) {
        for (Uri uri : uris) {
            if (uri == null || !ContentResolver.SCHEME_CONTENT.equals(uri.getScheme())) {
                continue;
            }
            try {
                grantUriPermission(getPackageName(), uri, Intent.FLAG_GRANT_READ_URI_PERMISSION);
            } catch (Exception ignored) {
                // Provider may not support granting; the URI still carries its own flags.
            }
        }
    }

    private void cancelFileCallback() {
        if (pendingFileCallback != null) {
            pendingFileCallback.onReceiveValue(null);
            pendingFileCallback = null;
        }
    }

    @Override
    public boolean onKeyDown(int keyCode, KeyEvent event) {
        if (keyCode == KeyEvent.KEYCODE_BACK && web != null && web.canGoBack()) {
            web.goBack();
            return true;
        }
        return super.onKeyDown(keyCode, event);
    }

    private void toast(String text) {
        Toast.makeText(this, text, Toast.LENGTH_SHORT).show();
    }

    /**
     * The foreground service cannot show its notification on Android 13+ without
     * the runtime notification permission. Without the notification the service
     * is not allowed to run, so ask when the app opens.
     */
    private void requestNotificationPermissionIfNeeded() {
        if (Build.VERSION.SDK_INT < 33) return;
        if (checkSelfPermission("android.permission.POST_NOTIFICATIONS")
                == android.content.pm.PackageManager.PERMISSION_GRANTED) {
            return;
        }
        web.postDelayed(new Runnable() {
            @Override
            public void run() {
                if (!isFinishing()) {
                    requestPermissions(
                            new String[] { "android.permission.POST_NOTIFICATIONS" },
                            REQ_NOTIFICATIONS);
                }
            }
        }, 900);
    }

    @Override
    protected void onResume() {
        super.onResume();
        // Pausing the activity froze the page's timers. Resuming them and firing
        // a visibilitychange makes the poll loop pick up immediately instead of
        // waiting for the next scheduled tick.
        if (web != null) {
            web.onResume();
            web.resumeTimers();
            web.evaluateJavascript(
                    "(function(){try{window.dispatchEvent(new Event('online'))}catch(e){}})()",
                    null);
        }
        BridgeService.start(this);
    }

    @Override
    protected void onPause() {
        super.onPause();
        // Deliberately NOT calling web.onPause(): that is what suspended the
        // JavaScript timers and killed the poll loop. The activity is leaving the
        // foreground, but the page must keep running so replies keep arriving.
    }

    @Override
    protected void onDestroy() {
        // Only tear the page down when the activity is really going away, and keep
        // the service running so the connection survives.
        if (isFinishing() && web != null) {
            try {
                web.loadUrl("about:blank");
                web.destroy();
            } catch (Exception ignored) {
            }
            web = null;
        }
        super.onDestroy();
    }
}
