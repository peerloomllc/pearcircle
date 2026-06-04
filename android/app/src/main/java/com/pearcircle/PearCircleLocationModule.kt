package com.pearcircle

import android.Manifest
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import android.net.Uri
import android.content.IntentFilter
import android.location.Location
import android.location.LocationManager
import android.os.BatteryManager
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.os.PowerManager
import android.provider.Settings
import android.util.Log
import androidx.core.content.ContextCompat
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.WritableMap
import com.facebook.react.modules.core.DeviceEventManagerModule
import com.facebook.react.modules.core.PermissionAwareActivity
import com.facebook.react.modules.core.PermissionListener
import com.google.android.gms.common.ConnectionResult
import com.google.android.gms.common.GoogleApiAvailability
import com.google.android.gms.location.CurrentLocationRequest
import com.google.android.gms.location.LocationServices
import com.google.android.gms.location.Priority
import com.google.android.gms.tasks.CancellationTokenSource

class PearCircleLocationModule(private val ctx: ReactApplicationContext)
    : ReactContextBaseJavaModule(ctx) {

    init {
        instance = this
        registerNetworkCallback()
    }

    override fun getName() = "PearCircleLocation"

    @ReactMethod
    fun startUpdates(promise: Promise) {
        if (!hasFineLocation()) {
            requestFineLocation { granted ->
                if (!granted) { promise.resolve(false); return@requestFineLocation }
                ensureNotificationsAndStart(promise)
            }
            return
        }
        ensureNotificationsAndStart(promise)
    }

    @ReactMethod
    fun stopUpdates(promise: Promise) {
        PearCircleLocationService.stop(ctx)
        promise.resolve(true)
    }

    // Battery optimization is the OEM/Doze gate that pauses the
    // foreground location service after extended idle. Asking the
    // user to exempt the app keeps sharing reliable but is opt-in
    // because exemption is a real privacy/battery posture change.
    @ReactMethod
    fun isIgnoringBatteryOptimizations(promise: Promise) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.M) {
            // Pre-Doze; the concept doesn't apply.
            promise.resolve(true)
            return
        }
        val pm = ctx.getSystemService(Context.POWER_SERVICE) as PowerManager
        promise.resolve(pm.isIgnoringBatteryOptimizations(ctx.packageName))
    }

    @ReactMethod
    fun requestIgnoreBatteryOptimizations(promise: Promise) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.M) {
            promise.resolve(true)
            return
        }
        val intent = Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS).apply {
            data = Uri.parse("package:" + ctx.packageName)
            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        }
        try {
            ctx.startActivity(intent)
            promise.resolve(true)
        } catch (e: Throwable) {
            promise.reject("ACTIVITY_NOT_FOUND", e.message ?: "Unable to open battery optimization dialog")
        }
    }

    // Required by RN even when we deliver via DeviceEventManagerModule.
    @ReactMethod fun addListener(eventName: String) { /* no-op */ }
    @ReactMethod fun removeListeners(count: Int) { /* no-op */ }

    // Cross-platform parity with the iOS PearCircleLocationModule.swift
    // getAuthorizationStatus. Returns one of:
    //   'always'         FINE + BACKGROUND_LOCATION both granted (or
    //                    background isn't required on pre-Q devices)
    //   'whenInUse'      FINE granted but BACKGROUND_LOCATION not.
    //                    Android calls this "Allow only while using the
    //                    app" in Settings.
    //   'denied'         FINE not granted (Android can't cleanly
    //                    distinguish notDetermined from denied without
    //                    activity-scoped permission rationale, so we
    //                    fold both into 'denied' from the UI's point
    //                    of view — the banner copy works either way).
    // Pure read; never triggers a dialog. Used by the shell to drive
    // the home banner that nudges users to Settings → "Allow all the
    // time".
    @ReactMethod
    fun getAuthorizationStatus(promise: Promise) {
        val fine = hasFineLocation()
        if (!fine) { promise.resolve("denied"); return }
        val bgRequired = Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q
        val bgGranted = !bgRequired ||
            ContextCompat.checkSelfPermission(ctx, Manifest.permission.ACCESS_BACKGROUND_LOCATION) ==
                PackageManager.PERMISSION_GRANTED
        promise.resolve(if (bgGranted) "always" else "whenInUse")
    }

    // Direct path to upgrade from "Allow only while using the app" to
    // "Allow all the time" — Android-only equivalent of iOS's
    // settings deep-link, but cleaner because we can hand the user
    // straight to the OS-managed background-location upgrade flow
    // rather than the generic app-info page.
    //   Android 10 (API 29): system dialog with "Allow all the time"
    //     and "Allow only while using the app" choices.
    //   Android 11+ (API 30+): the system silently denies the runtime
    //     request and surfaces a "Set in Settings" screen that opens
    //     directly to this app's Location permission detail, not the
    //     two-clicks-deep app-permissions list.
    // Requires FINE to already be granted; otherwise the request
    // can't succeed and the caller should fall back to the generic
    // app settings page.
    @ReactMethod
    fun requestBackgroundLocation(promise: Promise) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) {
            // Pre-Q: background location isn't a separate runtime permission.
            promise.resolve(true)
            return
        }
        if (!hasFineLocation()) {
            promise.resolve(false)  // caller falls back to openSettings
            return
        }
        val activity = getCurrentActivity() as? PermissionAwareActivity
        if (activity == null) { promise.resolve(false); return }
        val listener = PermissionListener { _, _, results ->
            promise.resolve(results.isNotEmpty() && results[0] == PackageManager.PERMISSION_GRANTED)
            true
        }
        activity.requestPermissions(
            arrayOf(Manifest.permission.ACCESS_BACKGROUND_LOCATION),
            REQ_BACKGROUND,
            listener,
        )
    }

    // One-shot fresh fix on app-foreground, parity with iOS's
    // requestSingleFix (foreground-refresh, 2026-05-29). The shell calls
    // this on every AppState 'active'. On Android the foreground service
    // already streams updates every ~10s while sharing is enabled, but
    // this still earns its keep: it delivers an immediate fix the moment
    // the app is opened (no up-to-10s wait), and it covers the window
    // where the service isn't running yet (just-launched, or Doze killed
    // it). getCurrentLocation actively obtains a fix rather than handing
    // back a stale cached one (maxUpdateAge=0), and routes it through the
    // same emitLocation -> location:update path the service uses. No-op
    // (resolve false) without location permission or if the request fails.
    @ReactMethod
    fun requestSingleFix(promise: Promise) {
        if (!hasFineLocation()) { promise.resolve(false); return }
        // Fused requires Google Play Services. On de-Googled ROMs
        // (LineageOS/GrapheneOS without microG) it never delivers a fix,
        // so fall back to the platform LocationManager. Proposal
        // 2026-06-03.
        if (gmsAvailable(ctx)) {
            fusedSingleFix(promise)
        } else {
            platformSingleFix(promise)
        }
    }

    private fun fusedSingleFix(promise: Promise) {
        val client = LocationServices.getFusedLocationProviderClient(ctx)
        val request = CurrentLocationRequest.Builder()
            .setPriority(Priority.PRIORITY_HIGH_ACCURACY)
            .setMaxUpdateAgeMillis(0L)
            .build()
        val cts = CancellationTokenSource()
        try {
            client.getCurrentLocation(request, cts.token)
                .addOnSuccessListener { loc ->
                    if (loc != null) {
                        emitToJs(loc)
                        promise.resolve(true)
                    } else {
                        // Provider couldn't produce a fresh fix in time.
                        // This is the common case on GrapheneOS with
                        // sandboxed Play: gmsAvailable() is true, so we are
                        // on the fused path, but the fused provider routes
                        // to a GPS-only OsLocationProvider that can't lock
                        // indoors while stationary, and there is no network
                        // provider. Rather than emit nothing (which leaves
                        // peers seeing a days-old position), fall back to
                        // the platform last-known fix so we republish the
                        // last real position. Proposal 2026-06-03
                        // (last-known fallback).
                        emitLastKnownOrFalse(promise)
                    }
                }
                .addOnFailureListener { emitLastKnownOrFalse(promise) }
        } catch (e: SecurityException) {
            promise.resolve(false)
        }
    }

    // Emit the freshest platform last-known fix if one exists, else
    // resolve false. Shared fallback for both the fused and platform
    // one-shot paths when an active fix can't be acquired (indoors /
    // GPS-only / no network provider). Republishing a last-known fix is
    // strictly better than emitting nothing: a stationary user keeps
    // showing their real last position instead of freezing for days.
    // The fix's own loc.time is preserved (honest staleness), so peers
    // see when it was actually taken. Proposal 2026-06-03.
    private fun emitLastKnownOrFalse(promise: Promise) {
        val last = platformLastKnown()
        if (last != null) { emitToJs(last); promise.resolve(true) }
        else promise.resolve(false)
    }

    // Freshest getLastKnownLocation across GPS + NETWORK. Null when no
    // provider has ever produced a fix this boot.
    private fun platformLastKnown(): Location? {
        val lm = ctx.getSystemService(Context.LOCATION_SERVICE) as? LocationManager ?: return null
        var best: Location? = null
        for (p in listOf(LocationManager.GPS_PROVIDER, LocationManager.NETWORK_PROVIDER)) {
            if (!lm.allProviders.contains(p)) continue
            try {
                val loc = lm.getLastKnownLocation(p) ?: continue
                if (best == null || loc.time > best!!.time) best = loc
            } catch (e: SecurityException) { /* skip provider */ }
        }
        return best
    }

    // GMS-free one-shot fix via the platform LocationManager. GPS is
    // primary; NETWORK is used only when GPS is absent (on de-Googled
    // devices NETWORK usually has no backend). API 30+ uses the active,
    // timeout-bounded getCurrentLocation; API 29 emits the freshest
    // last-known fix so the map shows something immediately, and leaves
    // fresh streaming fixes to the foreground service. Resolve false
    // (non-fatal) on any miss — the service stream is authoritative.
    private fun platformSingleFix(promise: Promise) {
        val lm = ctx.getSystemService(Context.LOCATION_SERVICE) as? LocationManager
        if (lm == null) { promise.resolve(false); return }
        val provider = when {
            lm.allProviders.contains(LocationManager.GPS_PROVIDER) -> LocationManager.GPS_PROVIDER
            lm.allProviders.contains(LocationManager.NETWORK_PROVIDER) -> LocationManager.NETWORK_PROVIDER
            else -> { promise.resolve(false); return }
        }
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
                lm.getCurrentLocation(
                    provider,
                    null,
                    ContextCompat.getMainExecutor(ctx),
                    java.util.function.Consumer { loc ->
                        if (loc != null) { emitToJs(loc); promise.resolve(true) }
                        else emitLastKnownOrFalse(promise)
                    },
                )
            } else {
                val last = lm.getLastKnownLocation(provider)
                if (last != null) { emitToJs(last); promise.resolve(true) }
                else promise.resolve(false)
            }
        } catch (e: SecurityException) {
            promise.resolve(false)
        }
    }

    // Read the current battery level + charging state and forward a
    // location through emitLocation. Shared by the foreground service's
    // streaming callback and requestSingleFix so both surface identical
    // battery metadata.
    fun emitToJs(loc: Location) {
        // BATTERY_PROPERTY_CAPACITY is a near-zero-cost system call;
        // returns Int.MIN_VALUE on unsupported devices, so anything
        // outside 0..100 becomes null.
        val bm = ctx.getSystemService(Context.BATTERY_SERVICE) as? BatteryManager
        val cap = bm?.getIntProperty(BatteryManager.BATTERY_PROPERTY_CAPACITY) ?: -1
        val battery: Double? = if (cap in 0..100) cap.toDouble() else null
        // Charging state via the sticky ACTION_BATTERY_CHANGED broadcast;
        // registerReceiver(null, ...) reads the last intent without
        // subscribing. STATUS_FULL counts as charging so a plugged-in
        // fully-charged device still shows the bolt.
        val battStatusIntent = ctx.registerReceiver(null, IntentFilter(Intent.ACTION_BATTERY_CHANGED))
        val status = battStatusIntent?.getIntExtra(BatteryManager.EXTRA_STATUS, -1) ?: -1
        val isCharging = status == BatteryManager.BATTERY_STATUS_CHARGING ||
            status == BatteryManager.BATTERY_STATUS_FULL
        emitLocation(
            loc.latitude,
            loc.longitude,
            loc.accuracy.toDouble(),
            loc.time.toDouble(),
            loc.speed.toDouble(),
            battery,
            isCharging,
        )
    }

    fun emitLocation(lat: Double, lon: Double, accuracy: Double, ts: Double, speed: Double, battery: Double?, isCharging: Boolean) {
        val payload: WritableMap = Arguments.createMap().apply {
            putDouble("lat", lat)
            putDouble("lon", lon)
            putDouble("accuracy", accuracy)
            putDouble("ts", ts)
            putDouble("speed", speed)
            if (battery != null) putDouble("battery", battery) else putNull("battery")
            putBoolean("isCharging", isCharging)
        }
        try {
            ctx.getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
                .emit("PearCircleLocation:update", payload)
        } catch (_: Throwable) {
            // React context torn down; service will retry on next callback.
        }
    }

    private fun ensureNotificationsAndStart(promise: Promise) {
        // Android 13+ requires POST_NOTIFICATIONS at runtime for the
        // foreground-service notification to be visible. Service still
        // runs without it, but the user can't see / dismiss the
        // notification, which surprises people. Request once; treat
        // denial as non-fatal.
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU && !hasNotifications()) {
            requestNotifications {
                PearCircleLocationService.start(ctx)
                promise.resolve(true)
            }
            return
        }
        PearCircleLocationService.start(ctx)
        promise.resolve(true)
    }

    private fun hasFineLocation(): Boolean =
        ContextCompat.checkSelfPermission(ctx, Manifest.permission.ACCESS_FINE_LOCATION) ==
            PackageManager.PERMISSION_GRANTED

    private fun hasNotifications(): Boolean =
        Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU ||
            ContextCompat.checkSelfPermission(ctx, Manifest.permission.POST_NOTIFICATIONS) ==
                PackageManager.PERMISSION_GRANTED

    private fun requestFineLocation(cb: (Boolean) -> Unit) {
        val activity = getCurrentActivity() as? PermissionAwareActivity
        if (activity == null) { cb(false); return }
        val listener = PermissionListener { _, _, results ->
            cb(results.isNotEmpty() && results[0] == PackageManager.PERMISSION_GRANTED)
            true
        }
        activity.requestPermissions(
            arrayOf(
                Manifest.permission.ACCESS_FINE_LOCATION,
                Manifest.permission.ACCESS_COARSE_LOCATION,
            ),
            REQ_FINE,
            listener,
        )
    }

    private fun requestNotifications(cb: () -> Unit) {
        val activity = getCurrentActivity() as? PermissionAwareActivity
        if (activity == null) { cb(); return }
        val listener = PermissionListener { _, _, _ -> cb(); true }
        activity.requestPermissions(
            arrayOf(Manifest.permission.POST_NOTIFICATIONS),
            REQ_NOTIFICATIONS,
            listener,
        )
    }

    // Default-network change handling. Hyperswarm's DHT announcement is
    // tied to the local IP at the time of the announce; when the device
    // moves between wifi and cell, peers can't find us until Hyperswarm's
    // internal periodic re-announce eventually fires (minute-ish in the
    // 2026-05-07 cold-start investigation). Detect default-network
    // changes here, debounce 2s to coalesce the burst Android emits
    // during a single transition, and emit one event per real network
    // identity change. The worklet's `network:changed` handler responds
    // by calling `_swarm.flush()` so the announce happens promptly on
    // the new network.
    // Initialized lazily inside registerNetworkCallback() rather than as
    // a `by lazy` delegate, because `init {}` runs before the delegate
    // field is wired up — the resulting NPE wasted a smoke-test iteration
    // before the diagnostic Log.w surfaced it.
    private var connectivity: ConnectivityManager? = null
    private val debounceHandler = Handler(Looper.getMainLooper())
    private var pendingEmit: Runnable? = null
    private var lastNetHandle: Long? = null
    private var hasSeenInitialNetwork = false
    private var networkCallback: ConnectivityManager.NetworkCallback? = null

    private fun registerNetworkCallback() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.N) {
            Log.w(TAG, "registerNetworkCallback: skipped, API < N")
            return
        }
        if (networkCallback != null) {
            Log.w(TAG, "registerNetworkCallback: already registered")
            return
        }
        val cm = try {
            ctx.getSystemService(Context.CONNECTIVITY_SERVICE) as? ConnectivityManager
        } catch (e: Throwable) {
            Log.w(TAG, "registerNetworkCallback: getSystemService threw: ${e.message}")
            null
        }
        if (cm == null) {
            Log.w(TAG, "registerNetworkCallback: ConnectivityManager unavailable")
            return
        }
        connectivity = cm
        val cb = object : ConnectivityManager.NetworkCallback() {
            override fun onAvailable(network: Network) {
                val handle = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) network.networkHandle else 0L
                Log.w(TAG, "onAvailable handle=$handle prev=$lastNetHandle hasSeenInitial=$hasSeenInitialNetwork")
                if (lastNetHandle == handle) return
                lastNetHandle = handle
                // Skip the first onAvailable across the lifetime of this
                // module instance: it's the network the worklet is already
                // running on at app start. Re-announcing on the initial
                // network is wasted work. After wifi off -> on cycles,
                // hasSeenInitialNetwork stays true so the new onAvailable
                // correctly emits a change.
                if (!hasSeenInitialNetwork) {
                    hasSeenInitialNetwork = true
                    Log.w(TAG, "onAvailable: marking initial, skipping emit")
                    return
                }
                Log.w(TAG, "onAvailable: scheduling debounced emit")
                scheduleDebouncedEmit(network)
            }
            override fun onLost(network: Network) {
                Log.w(TAG, "onLost handle=${if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) network.networkHandle else 0L}")
                pendingEmit?.let { debounceHandler.removeCallbacks(it) }
                pendingEmit = null
                lastNetHandle = null
            }
        }
        try {
            cm.registerDefaultNetworkCallback(cb)
            networkCallback = cb
            Log.w(TAG, "registerNetworkCallback: registered")
        } catch (e: Throwable) {
            Log.w(TAG, "registerNetworkCallback: failed: ${e.message}")
        }
    }

    private fun scheduleDebouncedEmit(network: Network) {
        pendingEmit?.let { debounceHandler.removeCallbacks(it) }
        val r = Runnable {
            pendingEmit = null
            emitNetworkChanged(network)
        }
        pendingEmit = r
        debounceHandler.postDelayed(r, DEBOUNCE_MS)
    }

    private fun emitNetworkChanged(network: Network) {
        val cm = connectivity
        val caps = if (cm != null) {
            try { cm.getNetworkCapabilities(network) } catch (_: Throwable) { null }
        } else null
        val transport = when {
            caps == null -> "unknown"
            caps.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) -> "wifi"
            caps.hasTransport(NetworkCapabilities.TRANSPORT_CELLULAR) -> "cellular"
            caps.hasTransport(NetworkCapabilities.TRANSPORT_ETHERNET) -> "ethernet"
            caps.hasTransport(NetworkCapabilities.TRANSPORT_VPN) -> "vpn"
            else -> "unknown"
        }
        val handle = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) network.networkHandle else 0L
        Log.w(TAG, "emitNetworkChanged transport=$transport handle=$handle")
        val payload: WritableMap = Arguments.createMap().apply {
            putString("transport", transport)
            putDouble("netHandle", handle.toDouble())
        }
        try {
            ctx.getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
                .emit("PearCircleLocation:network:changed", payload)
            Log.w(TAG, "emitNetworkChanged: emitted to JS")
        } catch (e: Throwable) {
            Log.w(TAG, "emitNetworkChanged: emit failed: ${e.message}")
        }
    }

    companion object {
        private const val TAG = "PearCircleLocation"
        private const val REQ_FINE = 4711
        private const val REQ_BACKGROUND = 4712
        private const val REQ_NOTIFICATIONS = 4713
        private const val DEBOUNCE_MS = 2000L
        @JvmStatic var instance: PearCircleLocationModule? = null

        // True only when Google Play Services is present and usable, so
        // FusedLocationProvider will actually deliver fixes. The detection
        // code lives in play-services-base (bundled in our APK), so this
        // runs even on devices where GMS is not installed; it returns
        // false there, routing callers to the LocationManager fallback.
        // Proposal 2026-06-03.
        @JvmStatic
        fun gmsAvailable(ctx: Context): Boolean = try {
            GoogleApiAvailability.getInstance().isGooglePlayServicesAvailable(ctx) == ConnectionResult.SUCCESS
        } catch (e: Throwable) {
            false
        }
    }
}
