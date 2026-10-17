package com.dsh.phonebridge;

import android.content.ContentProvider;
import android.content.ContentValues;
import android.database.Cursor;
import android.database.MatrixCursor;
import android.net.Uri;
import android.os.ParcelFileDescriptor;
import android.provider.OpenableColumns;

import java.io.File;
import java.io.FileNotFoundException;

/**
 * Serves a single cache file to the system camera app so photo capture can
 * return a full-resolution image without pulling in a support library
 * FileProvider.
 */
public final class CaptureProvider extends ContentProvider {

    static final String AUTHORITY = "com.dsh.phonebridge.capture";
    static final String FILE_NAME = "capture.jpg";

    static File captureFile(android.content.Context ctx) {
        File dir = new File(ctx.getCacheDir(), "capture");
        if (!dir.exists()) {
            //noinspection ResultOfMethodCallIgnored
            dir.mkdirs();
        }
        return new File(dir, FILE_NAME);
    }

    static Uri captureUri(android.content.Context ctx) {
        return Uri.parse("content://" + AUTHORITY + "/" + FILE_NAME);
    }

    @Override
    public boolean onCreate() {
        return true;
    }

    @Override
    public ParcelFileDescriptor openFile(Uri uri, String mode) throws FileNotFoundException {
        if (getContext() == null) {
            throw new FileNotFoundException("no context");
        }
        File file = captureFile(getContext());
        // The camera app opens this in "w" mode to write the captured JPEG (or
        // "rw" for read-modify-write). Opening READ_ONLY unconditionally makes
        // every capture fail, so translate the requested mode instead.
        int flags;
        if (mode != null && mode.contains("w")) {
            if (mode.contains("t")) {
                flags = ParcelFileDescriptor.MODE_READ_WRITE | ParcelFileDescriptor.MODE_TRUNCATE;
            } else {
                flags = ParcelFileDescriptor.MODE_READ_WRITE;
            }
        } else if (mode != null && mode.contains("r")) {
            flags = ParcelFileDescriptor.MODE_READ_ONLY;
        } else {
            flags = ParcelFileDescriptor.MODE_READ_WRITE;
        }
        return ParcelFileDescriptor.open(file, flags);
    }

    @Override
    public String getType(Uri uri) {
        return "image/jpeg";
    }

    /**
     * The WebView (and any ContentResolver consumer) asks for
     * {@link OpenableColumns#DISPLAY_NAME} and {@code _size} before accepting an
     * uploaded URI. Returning null here makes the picker treat the capture as an
     * unusable URI and silently drop the photo, so answer these columns.
     */
    @Override
    public Cursor query(Uri uri, String[] projection, String selection, String[] selectionArgs,
                        String sortOrder) {
        if (projection == null) {
            projection = new String[]{OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE};
        }
        MatrixCursor cursor = new MatrixCursor(projection, 1);
        MatrixCursor.RowBuilder row = cursor.newRow();
        File file = getContext() == null ? null : captureFile(getContext());
        for (String column : projection) {
            if (OpenableColumns.DISPLAY_NAME.equals(column)) {
                row.add(FILE_NAME);
            } else if (OpenableColumns.SIZE.equals(column)) {
                row.add(file != null && file.exists() ? file.length() : 0L);
            } else {
                row.add(null);
            }
        }
        return cursor;
    }

    @Override
    public Uri insert(Uri uri, ContentValues values) {
        return null;
    }

    @Override
    public int delete(Uri uri, String selection, String[] selectionArgs) {
        if (getContext() == null) {
            return 0;
        }
        File file = captureFile(getContext());
        return file.delete() ? 1 : 0;
    }

    @Override
    public int update(Uri uri, ContentValues values, String selection, String[] selectionArgs) {
        return 0;
    }
}
