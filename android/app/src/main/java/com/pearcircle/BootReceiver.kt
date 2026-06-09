package com.pearcircle

import android.Manifest
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.util.Log
import androidx.core.content.ContextCompat

// Resumes background location sharing after a device reboot or an in-place
// app update, so the user does not have to reopen the app to get sharing
// going again (issue #89). Proposal 2026-06-09 (autostart on boot).
//
// Gating, cheapest check first so we never spin anything up needlessly:
//   1. autostart_enabled  -- the shell's "sharing enabled anywhere" mirror,
//      read natively from SharedPreferences so we don't pay to start the JS
//      context just to discover sharing is off everywhere.
//   2. location permission -- a revoked grant means the FGS would be refused
//      with a SecurityException, so bail early.
//
// Starting the foreground service from a BOOT_COMPLETED / MY_PACKAGE_REPLACED
// broadcast is one of the documented Android 12+ exemptions to the
// background-FGS-start restriction. We still wrap the start so an OEM that
// refuses it surfaces as a log line, not a crash. The service is the process
// anchor; bringing the Bare worklet up headlessly on top of it is wired
// separately (see proposals/2026-06-09-autostart-on-boot.md, Design).
//
// Stopped-state caveat: a freshly installed app that has never been opened,
// or one the user force-stopped, receives no broadcasts at all until the app
// is launched once. That is an OS rule, not something this receiver can work
// around; it is a documented non-goal.
class BootReceiver : BroadcastReceiver() {

    override fun onReceive(context: Context, intent: Intent) {
        val action = intent.action ?: return
        if (action != Intent.ACTION_BOOT_COMPLETED &&
            action != Intent.ACTION_MY_PACKAGE_REPLACED) {
            return
        }

        if (!PearCircleLocationModule.isAutostartEnabled(context)) {
            Log.i(TAG, "autostart gate off; not resuming after $action")
            return
        }
        if (!hasLocationPermission(context)) {
            Log.i(TAG, "location permission absent; not resuming after $action")
            return
        }

        try {
            // fromBoot = true: no Activity behind this start, so the FGS must
            // bring the worklet up headlessly (BackendHeadlessTaskService),
            // otherwise location streams into a dead bridge. Proposal 2026-06-09.
            PearCircleLocationService.start(context, fromBoot = true)
            Log.i(TAG, "resumed foreground service after $action")
        } catch (e: Exception) {
            // ForegroundServiceStartNotAllowedException (API 31+) or a
            // SecurityException on an OEM that declines the boot exemption.
            // The user can still resume by opening the app.
            Log.w(TAG, "could not start FGS after $action: ${e.message}")
        }
    }

    private fun hasLocationPermission(ctx: Context): Boolean {
        val fine = ContextCompat.checkSelfPermission(ctx, Manifest.permission.ACCESS_FINE_LOCATION) ==
            PackageManager.PERMISSION_GRANTED
        val coarse = ContextCompat.checkSelfPermission(ctx, Manifest.permission.ACCESS_COARSE_LOCATION) ==
            PackageManager.PERMISSION_GRANTED
        return fine || coarse
    }

    companion object {
        private const val TAG = "PearCircleBoot"
    }
}
