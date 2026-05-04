package com.pearcircle

import android.Manifest
import android.content.pm.PackageManager
import android.os.Build
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

class PearCircleLocationModule(private val ctx: ReactApplicationContext)
    : ReactContextBaseJavaModule(ctx) {

    init { instance = this }

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

    // Required by RN even when we deliver via DeviceEventManagerModule.
    @ReactMethod fun addListener(eventName: String) { /* no-op */ }
    @ReactMethod fun removeListeners(count: Int) { /* no-op */ }

    fun emitLocation(lat: Double, lon: Double, accuracy: Double, ts: Double, speed: Double) {
        val payload: WritableMap = Arguments.createMap().apply {
            putDouble("lat", lat)
            putDouble("lon", lon)
            putDouble("accuracy", accuracy)
            putDouble("ts", ts)
            putDouble("speed", speed)
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

    companion object {
        private const val REQ_FINE = 4711
        private const val REQ_NOTIFICATIONS = 4713
        @JvmStatic var instance: PearCircleLocationModule? = null
    }
}
