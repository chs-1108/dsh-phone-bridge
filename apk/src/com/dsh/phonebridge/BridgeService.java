package com.dsh.phonebridge;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.os.Build;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.os.PowerManager;

/**
 * Keeps the bridge reachable while the phone is idle.
 *
 * Android freezes a backgrounded activity: its WebView stops running timers, so
 * the poll loop dies and a reply that lands while the screen is off is never
 * seen. A foreground service is the supported way to stay awake - it holds a
 * partial wake lock and puts a notification in the shade so the system knows the
 * work is user-visible rather than something to reclaim.
 *
 * The service does not own the connection itself; it only keeps the process and
 * the WebView alive. The page's own poll loop does the talking.
 */
public class BridgeService extends Service {

    public static final String CHANNEL_ID = "bridge-foreground";
    public static final int NOTIFICATION_ID = 1001;

    private static final String WAKE_TAG = "phone-bridge:webview";

    private PowerManager.WakeLock wakeLock;
    private Handler handler;

    public static void start(Context context) {
        Intent intent = new Intent(context, BridgeService.class);
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                context.startForegroundService(intent);
            } else {
                context.startService(intent);
            }
        } catch (Exception ignored) {
            // Background start restrictions: the activity is in the foreground
            // whenever this is called, so this should not happen.
        }
    }

    public static void stop(Context context) {
        try {
            context.stopService(new Intent(context, BridgeService.class));
        } catch (Exception ignored) {
        }
    }

    @Override
    public void onCreate() {
        super.onCreate();
        handler = new Handler(Looper.getMainLooper());
        createChannel();
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        startForeground(NOTIFICATION_ID, buildNotification());

        if (wakeLock == null) {
            PowerManager pm = (PowerManager) getSystemService(Context.POWER_SERVICE);
            if (pm != null) {
                wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, WAKE_TAG);
                wakeLock.setReferenceCounted(false);
                try {
                    wakeLock.acquire();
                } catch (Exception ignored) {
                    wakeLock = null;
                }
            }
        }

        // START_STICKY: if the system does reclaim us, come back rather than
        // leaving the bridge silently dead until the user reopens the app.
        return START_STICKY;
    }

    @Override
    public void onDestroy() {
        if (wakeLock != null && wakeLock.isHeld()) {
            try {
                wakeLock.release();
            } catch (Exception ignored) {
            }
        }
        wakeLock = null;
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    private void createChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        NotificationManager nm = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        if (nm == null) return;
        NotificationChannel existing = nm.getNotificationChannel(CHANNEL_ID);
        if (existing != null) return;
        NotificationChannel channel = new NotificationChannel(
                CHANNEL_ID,
                getString(R.string.channel_bridge),
                NotificationManager.IMPORTANCE_MIN);
        channel.setDescription(getString(R.string.channel_bridge_desc));
        channel.setShowBadge(false);
        channel.setSound(null, null);
        channel.enableVibration(false);
        channel.setLockscreenVisibility(Notification.VISIBILITY_SECRET);
        nm.createNotificationChannel(channel);
    }

    @SuppressWarnings("deprecation")
    private Notification buildNotification() {
        Intent open = new Intent(this, MainActivity.class);
        open.setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        int flags = PendingIntent.FLAG_UPDATE_CURRENT;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            flags |= PendingIntent.FLAG_IMMUTABLE;
        }
        PendingIntent pending = PendingIntent.getActivity(this, 0, open, flags);

        Notification.Builder builder;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            builder = new Notification.Builder(this, CHANNEL_ID);
        } else {
            builder = new Notification.Builder(this);
        }
        builder.setContentTitle(getString(R.string.notif_bridge_title))
                .setContentText(getString(R.string.notif_bridge_text))
                .setSmallIcon(android.R.drawable.stat_notify_chat)
                .setContentIntent(pending)
                .setOngoing(true)
                .setPriority(Notification.PRIORITY_MIN)
                .setShowWhen(false);
        return builder.build();
    }
}
