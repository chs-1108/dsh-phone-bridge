package com.dsh.phonebridge;

/**
 * Build-time constants for this specific APK.
 *
 * <p>These are generated per-build so the resulting app is already paired with
 * one host and skips the setup / QR-scan screen entirely. An empty string means
 * "no default" — the app then falls back to the manual pairing flow.
 *
 * <p>Rebuild with a different host by running {@code build-apk.ps1 -BaseUrl
 * <url> -Token <token>}, which rewrites this file before javac runs. The values
 * are intentionally left blank in source control so no real host address or
 * pairing token is published.
 */
final class BuildDefaults {

    /** Base URL ending at the bridge route prefix, e.g. http://100.x.y.z:19387/phone-bridge */
    static final String BASE_URL = "";

    /** Bridge token from the host's phone-bridge state.json. */
    static final String TOKEN = "";

    private BuildDefaults() {
    }
}