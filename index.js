// Custom app entry. expo-router/entry registers the Activity UI as before;
// we additionally register a headless JS task that brings the P2P worklet
// back up after a device reboot or an in-place app update, when there is no
// Activity (issue #89, proposal 2026-06-09 autostart on boot).
//
// One process, one JS runtime: the headless task and the Activity share the
// worklet's _workletStarted singleton + the ensureBackendStarted start lock,
// so the local Autobase has exactly one writer regardless of which path
// starts it first. The native PearCircleLocationService FGS is the process
// anchor that keeps the worklet alive after this task's promise resolves;
// BackendHeadlessTaskService is the only caller (Android only).
import 'expo-router/entry'
import { AppRegistry } from 'react-native'
import { ensureBackendStarted } from './app/index'

AppRegistry.registerHeadlessTask('PearCircleBackend', () => async () => {
  try {
    await ensureBackendStarted()
  } catch (e) {
    console.warn('headless backend start failed', e?.message ?? String(e))
  }
})
