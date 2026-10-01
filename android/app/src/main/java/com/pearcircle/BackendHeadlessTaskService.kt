package com.pearcircle

import android.content.Context
import android.content.Intent
import android.os.Handler
import android.os.Looper
import android.util.Log
import com.facebook.react.HeadlessJsTaskService
import com.facebook.react.bridge.Arguments
import com.facebook.react.jstasks.HeadlessJsTaskConfig

// Hosts the "PearCircleBackend" headless JS task (registered in index.js).
// The task calls ensureBackendStarted(), which brings the Bare worklet and
// the native location IPC plumbing up WITHOUT mounting the WebView UI, so a
// reboot/update resume actually replicates instead of collecting fixes into
// a dead bridge (issue #89). Proposal 2026-06-09.
//
// Single process by design (no android:process in the manifest): the headless
// task and, later, the Activity share one ReactHost / JS runtime, so the
// worklet's _workletStarted singleton + the JS start lock guarantee exactly
// one Autobase writer whichever path starts it first. The single-open hazard
// (two writers corrupting the local view) is the whole reason this stays
// in-process.
//
// Lifecycle: this service only kicks the JS task; it does not itself hold the
// process open. The PearCircleLocationService foreground service is the
// process anchor that keeps the worklet alive after the task's promise
// resolves. ensureStarted is called from that FGS once it is in the
// foreground procstate, so this plain (non-foreground) service start is
// permitted even on Android 12+ where a true background start would be
// refused.
//
// Wake lock: RN's base class takes a partial wake lock on every start and only
// releases it in onDestroy, which runs once the task reports finished. With no
// timeout a task that never finished kept this service alive and the CPU awake
// from boot onwards (seen on a GrapheneOS Pixel: held for 4h of a 9h window,
// still held 1d15h after boot). So the task now has a timeout, and onStartCommand
// arms a hard stop as a backstop for the case where the task never starts at
// all (no React context ever comes up). Stopping the service only releases the
// wake lock; the JS keeps running and the location FGS keeps the process alive.
class BackendHeadlessTaskService : HeadlessJsTaskService() {

    private val handler = Handler(Looper.getMainLooper())
    private val forceStop = Runnable {
        Log.w(TAG, "headless task did not finish in ${FORCE_STOP_MS}ms, stopping to release the wake lock")
        stopSelf()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        super.onStartCommand(intent, flags, startId)
        handler.removeCallbacks(forceStop)
        handler.postDelayed(forceStop, FORCE_STOP_MS)
        // NOT_STICKY: a redelivered intent after a process kill would re-run
        // the task and re-take the wake lock. The location FGS restarts the
        // backend itself on a sticky restart, so redelivery is not needed.
        return START_NOT_STICKY
    }

    override fun onDestroy() {
        handler.removeCallbacks(forceStop)
        super.onDestroy()
    }

    override fun getTaskConfig(intent: Intent?): HeadlessJsTaskConfig {
        return HeadlessJsTaskConfig(
            TASK_KEY,
            Arguments.createMap(),
            // ensureBackendStarted normally resolves in a few seconds. The
            // timeout marks the task finished even if it hangs, so the service
            // stops and the wake lock is released (see the class comment).
            TASK_TIMEOUT_MS,
            // allowedInForeground = true: the location FGS puts us in a
            // foreground procstate, and RN otherwise refuses to run a headless
            // task while the app is considered foreground. We want it to run
            // either way -- it is idempotent if a context already exists.
            true,
        )
    }

    companion object {
        private const val TASK_KEY = "PearCircleBackend"
        private const val TAG = "PearCircleBackend"
        private const val TASK_TIMEOUT_MS = 60_000L
        private const val FORCE_STOP_MS = 90_000L

        // Start the headless task to bring the worklet up. Idempotent at the
        // JS layer (the start lock no-ops if the Activity already started the
        // backend). Wrapped so a refusal logs instead of crashing the FGS.
        fun ensureStarted(ctx: Context) {
            try {
                ctx.startService(Intent(ctx, BackendHeadlessTaskService::class.java))
            } catch (e: Exception) {
                Log.w(TAG, "headless backend start refused: ${e.message}")
            }
        }
    }
}
