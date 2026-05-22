import Foundation
import CoreLocation
import CoreMotion
import Network
import UIKit
import React

// iOS counterpart to Android's PearCircleLocationModule + LocationService.
// On iOS the OS itself handles the "foreground service" role: with the
// `location` UIBackgroundMode set in Info.plist and Always authorization
// granted, CLLocationManager keeps delivering updates while the app is
// suspended. There is no separate Service to stand up.
//
// Emit contract matches Android exactly so the worklet's IPC handlers
// (`location:update`, `network:changed` in src/bare.js) need zero
// changes:
//   PearCircleLocation:update
//     { lat, lon, accuracy, ts, speed, battery, isCharging }
//   PearCircleLocation:network:changed
//     { transport, netHandle }
@objc(PearCircleLocation)
class PearCircleLocationModule: RCTEventEmitter, CLLocationManagerDelegate {

  private static let UPDATE_EVENT = "PearCircleLocation:update"
  private static let NETWORK_EVENT = "PearCircleLocation:network:changed"
  private static let REGION_ENTER_EVENT = "PearCircleLocation:region:enter"
  private static let REGION_EXIT_EVENT = "PearCircleLocation:region:exit"
  private static let MOTION_EVENT = "PearCircleLocation:motion:changed"
  private static let DEBOUNCE_SECONDS: TimeInterval = 2.0
  // CoreMotion smoothing (proposal 2026-05-21 Q4, reusing the 2026-05-03
  // isMoving decision): a raw classification must repeat this many
  // consecutive activity callbacks before it flips the value emitted to
  // JS, filtering CoreMotion's brief low-confidence flickers.
  private static let MOTION_SMOOTHING_SAMPLES = 3
  // Cold-start launch path: when iOS revives the app from a region
  // crossing while the user had it force-quit, didEnterRegion can fire
  // before the JS bundle finishes booting and attaches the
  // NativeEventEmitter listener. Buffer up to this many events so the
  // first crossing isn't lost; cap the queue so a runaway scenario
  // (JS never attaches) can't grow unbounded.
  private static let REGION_BUFFER_MAX = 64

  private var manager: CLLocationManager?
  private var hasListeners = false
  // Adaptive location mode (proposal 2026-05-16). Worklet drives this
  // via setMode("idle" | "tracking"). Both modes leave the SLC
  // subscription on so iOS keeps waking us for ~500m cell-tower moves
  // even when continuous delivery is stopped. Default "tracking" keeps
  // behavior identical to pre-adaptive until the worklet's first
  // setMode call lands.
  private var currentMode: String = "tracking"
  // FIFO of region events that fired while no JS listener was attached.
  // Flushed in startObserving when the shell side wires up the
  // NativeEventEmitter listener.
  private var bufferedRegionEvents: [(name: String, body: [String: Any])] = []

  // CoreMotion activity monitoring (proposal 2026-05-21). Feeds the
  // worklet a trip-detector-independent "device started moving" signal
  // so it can leave SLC-only "idle" mode promptly, closing the
  // idle-trap. Runs on the always-on motion coprocessor at negligible
  // battery cost. motionEmittedMoving is the smoothed state last sent
  // to JS; motionPendingMoving / motionPendingCount implement the
  // N-consistent-samples smoothing (see MOTION_SMOOTHING_SAMPLES).
  private var motionManager: CMMotionActivityManager?
  private var motionUpdatesActive = false
  private var motionEmittedMoving = false
  private var motionPendingMoving: Bool?
  private var motionPendingCount = 0

  // Resolver for an in-flight startUpdates() call that's blocked on
  // the user's response to the location-permission dialog. didChange
  // fires later with the result; we resolve(true|false) at that point.
  // If a second startUpdates() arrives before the first resolves we
  // resolve the prior one as false rather than leaking it.
  private var pendingResolve: RCTPromiseResolveBlock?

  // Network-change debounce. iOS emits a burst of NWPathMonitor
  // callbacks during a single transition (interface up, address
  // assigned, default route changed, ...). We collapse them with a
  // 2s debounce, identical to the Android side. lastTransport guards
  // against emitting when the actual stack didn't change. The
  // monotonic netSeq stands in for Android's network handle so the
  // worklet has a numeric tag to log.
  private var pathMonitor: NWPathMonitor?
  private let pathQueue = DispatchQueue(label: "com.pearcircle.netpath")
  private var debounceItem: DispatchWorkItem?
  private var hasSeenInitialPath = false
  private var lastTransport: String?
  private var netSeq: Int64 = 0

  override init() {
    super.init()
    // Battery monitoring must be enabled before batteryLevel /
    // batteryState read anything other than -1 / .unknown. Apple
    // requires this on the main thread.
    DispatchQueue.main.async {
      UIDevice.current.isBatteryMonitoringEnabled = true
    }
    startPathMonitor()
  }

  deinit {
    pathMonitor?.cancel()
    motionManager?.stopActivityUpdates()
  }

  override static func requiresMainQueueSetup() -> Bool { return true }

  override func supportedEvents() -> [String] {
    return [
      PearCircleLocationModule.UPDATE_EVENT,
      PearCircleLocationModule.NETWORK_EVENT,
      PearCircleLocationModule.REGION_ENTER_EVENT,
      PearCircleLocationModule.REGION_EXIT_EVENT,
      PearCircleLocationModule.MOTION_EVENT,
    ]
  }

  override func startObserving() {
    hasListeners = true
    // Drain any region events that fired while !hasListeners. Capture
    // and clear before sending so a re-entrant stopObserving from
    // inside sendEvent (shouldn't happen, but defensively) doesn't
    // re-append into the buffer we're iterating.
    let pending = bufferedRegionEvents
    bufferedRegionEvents.removeAll()
    for event in pending {
      sendEvent(withName: event.name, body: event.body)
    }
  }
  override func stopObserving() { hasListeners = false }

  // MARK: - JS-exposed API

  @objc func startUpdates(
    _ resolve: @escaping RCTPromiseResolveBlock,
    reject: @escaping RCTPromiseRejectBlock
  ) {
    DispatchQueue.main.async {
      let mgr = self.ensureManager()
      let status: CLAuthorizationStatus
      if #available(iOS 14.0, *) {
        status = mgr.authorizationStatus
      } else {
        status = CLLocationManager.authorizationStatus()
      }
      switch status {
      case .notDetermined:
        if let prior = self.pendingResolve {
          prior(false)
        }
        self.pendingResolve = resolve
        // Always > WhenInUse for background sharing; iOS may show
        // WhenInUse first and prompt for the Always upgrade later
        // through its own provisional flow.
        mgr.requestAlwaysAuthorization()
      case .restricted, .denied:
        resolve(false)
      case .authorizedWhenInUse:
        // Foreground updates work; background callbacks won't fire
        // until the user upgrades to Always. Start anyway and request
        // the upgrade -- iOS suppresses the duplicate dialog itself.
        mgr.requestAlwaysAuthorization()
        self.startUpdatesNow(mgr)
        resolve(true)
      case .authorizedAlways:
        self.startUpdatesNow(mgr)
        resolve(true)
      @unknown default:
        resolve(false)
      }
    }
  }

  @objc func stopUpdates(
    _ resolve: @escaping RCTPromiseResolveBlock,
    reject: @escaping RCTPromiseRejectBlock
  ) {
    DispatchQueue.main.async {
      // Stop BOTH continuous and SLC. The FGS-lifecycle caller (mute
      // every circle) wants the radio fully idle; leaving SLC on would
      // still wake the worklet for nothing. CoreMotion activity
      // monitoring stops too -- with sharing off there is no escalation
      // for it to drive.
      self.manager?.stopUpdatingLocation()
      self.manager?.stopMonitoringSignificantLocationChanges()
      self.stopActivityUpdates()
      resolve(true)
    }
  }

  // Read the current authorization status without triggering a dialog.
  // Used by the shell to decide whether to show the priming screen and
  // by the home banner to nudge users stuck below Always toward the
  // iOS Settings deep-link.
  @objc func getAuthorizationStatus(
    _ resolve: @escaping RCTPromiseResolveBlock,
    reject: @escaping RCTPromiseRejectBlock
  ) {
    DispatchQueue.main.async {
      let mgr = self.ensureManager()
      let status: CLAuthorizationStatus
      if #available(iOS 14.0, *) {
        status = mgr.authorizationStatus
      } else {
        status = CLLocationManager.authorizationStatus()
      }
      let s: String
      switch status {
      case .notDetermined:        s = "notDetermined"
      case .restricted:           s = "restricted"
      case .denied:               s = "denied"
      case .authorizedWhenInUse:  s = "whenInUse"
      case .authorizedAlways:     s = "always"
      @unknown default:           s = "unknown"
      }
      resolve(s)
    }
  }

  // Deep-link into the iOS Settings app's PearCircle entry. Apple allows
  // this URL; it's the canonical "send the user to fix this permission"
  // path. Resolves true on a successful open.
  @objc func openSettings(
    _ resolve: @escaping RCTPromiseResolveBlock,
    reject: @escaping RCTPromiseRejectBlock
  ) {
    DispatchQueue.main.async {
      guard let url = URL(string: UIApplication.openSettingsURLString) else {
        resolve(false)
        return
      }
      UIApplication.shared.open(url, options: [:]) { ok in
        resolve(ok)
      }
    }
  }

  // Replace the set of CLCircularRegions we monitor with the supplied
  // list. Apple caps each app at 20 simultaneously-monitored regions
  // (shared with iBeacon); the caller is expected to enforce the cap
  // before invoking. Each entry is `{ id: String, lat: Double,
  // lon: Double, radius: Double }`; radius is in meters. We stop
  // monitoring any region whose identifier isn't in the new set, then
  // start fresh monitoring for the new set. CLLocationManager keeps
  // monitored regions persistent across app launches at the OS level,
  // so this is the canonical way to reconcile the registered set on
  // every launch: call setMonitoredRegions with the desired list and
  // the OS does the diff. Returns the count of regions now registered.
  @objc func setMonitoredRegions(
    _ regions: NSArray,
    resolve: @escaping RCTPromiseResolveBlock,
    reject: @escaping RCTPromiseRejectBlock
  ) {
    DispatchQueue.main.async {
      let mgr = self.ensureManager()
      // Apple requires location authorization (when in use is enough
      // for region monitoring to register, but didEnterRegion only
      // fires reliably with Always). We still register what we can.
      let desired: [(id: String, lat: Double, lon: Double, radius: Double)] = regions.compactMap { raw in
        guard let dict = raw as? [String: Any],
              let id = dict["id"] as? String,
              let lat = (dict["lat"] as? NSNumber)?.doubleValue,
              let lon = (dict["lon"] as? NSNumber)?.doubleValue,
              let radius = (dict["radius"] as? NSNumber)?.doubleValue,
              radius > 0 else {
          return nil
        }
        return (id, lat, lon, radius)
      }
      let desiredIds = Set(desired.map { $0.id })
      // Stop monitoring anything that's been dropped from the set or
      // is a non-circular region (defensive; only CLCircularRegion
      // entries should exist, but the OS may have leftover types).
      for region in mgr.monitoredRegions where !desiredIds.contains(region.identifier) {
        mgr.stopMonitoring(for: region)
      }
      // Start (or refresh) monitoring for each desired region. Apple
      // tolerates startMonitoring on an already-monitored identifier
      // by replacing the registration, which lets us pick up edits
      // (radius change, recenter) on the same id without a stop+start
      // ceremony.
      let monitoredById: [String: CLRegion] = Dictionary(uniqueKeysWithValues: mgr.monitoredRegions.map { ($0.identifier, $0) })
      for entry in desired {
        // If the region exists with identical geometry, leave it
        // alone to avoid bouncing the OS state (and the brief gap
        // where neither registration is active).
        if let existing = monitoredById[entry.id] as? CLCircularRegion,
           existing.center.latitude == entry.lat,
           existing.center.longitude == entry.lon,
           existing.radius == entry.radius {
          continue
        }
        // If geometry changed, stop the old one first so the new
        // registration doesn't collide.
        if let existing = monitoredById[entry.id] {
          mgr.stopMonitoring(for: existing)
        }
        let region = CLCircularRegion(
          center: CLLocationCoordinate2D(latitude: entry.lat, longitude: entry.lon),
          radius: entry.radius,
          identifier: entry.id
        )
        region.notifyOnEntry = true
        region.notifyOnExit = true
        mgr.startMonitoring(for: region)
      }
      resolve(["count": mgr.monitoredRegions.count])
    }
  }

  // Inspect what CLLocationManager currently has registered. Useful
  // for tests and debug surfaces, and for reconciling the JS-side
  // desired set against the OS-side reality.
  @objc func getMonitoredRegions(
    _ resolve: @escaping RCTPromiseResolveBlock,
    reject: @escaping RCTPromiseRejectBlock
  ) {
    DispatchQueue.main.async {
      let mgr = self.ensureManager()
      var out: [[String: Any]] = []
      for region in mgr.monitoredRegions {
        guard let circular = region as? CLCircularRegion else { continue }
        out.append([
          "id": circular.identifier,
          "lat": circular.center.latitude,
          "lon": circular.center.longitude,
          "radius": circular.radius,
        ])
      }
      resolve(out)
    }
  }

  // MARK: - CLLocationManagerDelegate

  // iOS 14+ delegate.
  @available(iOS 14.0, *)
  func locationManagerDidChangeAuthorization(_ manager: CLLocationManager) {
    handleAuthChange(manager: manager, status: manager.authorizationStatus)
  }

  // Pre-iOS 14 delegate. Kept for completeness; deployment target is
  // 15.1 today but the bridging header doesn't strip it.
  func locationManager(
    _ manager: CLLocationManager,
    didChangeAuthorization status: CLAuthorizationStatus
  ) {
    handleAuthChange(manager: manager, status: status)
  }

  func locationManager(
    _ manager: CLLocationManager,
    didUpdateLocations locations: [CLLocation]
  ) {
    guard let loc = locations.last else { return }
    emitLocation(loc)
  }

  func locationManager(_ manager: CLLocationManager, didFailWithError error: Error) {
    NSLog("PearCircleLocation: didFailWithError %@", error.localizedDescription)
  }

  // CLCircularRegion enter/exit callbacks. Fires both while the app is
  // running and when iOS revives the app from a force-quit / terminated
  // state on a boundary cross. emitOrBufferRegion routes through the
  // bridge if JS is listening; otherwise queues for the cold-start
  // flush in startObserving so the first crossing isn't lost while the
  // RN bundle is still booting.
  func locationManager(_ manager: CLLocationManager, didEnterRegion region: CLRegion) {
    emitOrBufferRegion(name: PearCircleLocationModule.REGION_ENTER_EVENT, id: region.identifier)
  }

  func locationManager(_ manager: CLLocationManager, didExitRegion region: CLRegion) {
    emitOrBufferRegion(name: PearCircleLocationModule.REGION_EXIT_EVENT, id: region.identifier)
  }

  // OS-side failure to start or maintain a region monitor. Usually
  // means we exceeded the 20-region cap, the user revoked Always
  // authorization, or the region geometry was invalid. Logged so the
  // first incident surfaces in device logs; not propagated to JS
  // because the JS classifier still covers the foreground case.
  func locationManager(_ manager: CLLocationManager, monitoringDidFailFor region: CLRegion?, withError error: Error) {
    NSLog("PearCircleLocation: monitoringDidFailFor %@ -- %@", region?.identifier ?? "<nil>", error.localizedDescription)
  }

  // MARK: - Helpers

  private func ensureManager() -> CLLocationManager {
    if let m = manager { return m }
    let m = CLLocationManager()
    m.delegate = self
    // NearestTenMeters keeps the radio in a much lower-power mode than
    // Best (which pins the GPS chip on). 10m is plenty for friend-on-
    // a-map rendering, trip polylines, and the geofence layer (region
    // monitoring runs on its own OS-managed pipeline and is unaffected
    // by this knob).
    m.desiredAccuracy = kCLLocationAccuracyNearestTenMeters
    m.distanceFilter = 10
    // Let iOS pause continuous delivery when the device is stationary;
    // it resumes automatically on detected motion. SLC stays subscribed
    // underneath (proposal 2026-05-16 adaptive modes), so a paused
    // device is still woken on ~500m cell-tower moves, and the
    // swarm-connected dot -- not a periodic location republish -- now
    // carries the "this peer is live" signal (2026-05-17
    // swarm-live-signal change). Was previously false; that combined
    // with Best accuracy kept the GPS chip hot 24/7 and was the
    // dominant battery drain reported by users.
    m.pausesLocationUpdatesAutomatically = true
    // allowsBackgroundLocationUpdates needs UIBackgroundModes "location"
    // in Info.plist (set) and Always authorization at runtime; iOS
    // silently ignores the flag otherwise.
    m.allowsBackgroundLocationUpdates = true
    m.showsBackgroundLocationIndicator = true
    manager = m
    return m
  }

  private func startUpdatesNow(_ mgr: CLLocationManager) {
    // SLC runs in BOTH adaptive modes (proposal 2026-05-16). It's the
    // steady-state subscription that keeps the worklet alive on cell-
    // tower transitions while continuous delivery is stopped. Cheap
    // (<1% battery) and required for "idle" mode to deliver anything.
    mgr.startMonitoringSignificantLocationChanges()
    if currentMode == "tracking" {
      mgr.startUpdatingLocation()
    }
    // CoreMotion activity monitoring (proposal 2026-05-21). Started
    // alongside location so a trip beginning while the worklet is in
    // "idle" mode is noticed promptly instead of ~500m in.
    startActivityUpdatesIfAvailable()
  }

  // MARK: - CoreMotion activity monitoring

  // Begin CoreMotion activity updates if the device has the motion
  // coprocessor. The first call triggers the Motion & Fitness
  // permission dialog; if the user denies it the handler simply never
  // reports motion and the trip-phase / foreground escalations still
  // cover the idle-trap. Idempotent.
  private func startActivityUpdatesIfAvailable() {
    guard CMMotionActivityManager.isActivityAvailable() else { return }
    if motionUpdatesActive { return }
    let mgr = motionManager ?? CMMotionActivityManager()
    motionManager = mgr
    motionUpdatesActive = true
    mgr.startActivityUpdates(to: OperationQueue.main) { [weak self] activity in
      guard let self = self, let activity = activity else { return }
      self.handleActivityUpdate(activity)
    }
  }

  private func stopActivityUpdates() {
    guard motionUpdatesActive else { return }
    motionManager?.stopActivityUpdates()
    motionUpdatesActive = false
    // Reset the smoothing state so a later restart re-derives from
    // scratch rather than carrying a stale pending count.
    motionPendingMoving = nil
    motionPendingCount = 0
  }

  // Classify one CMMotionActivity sample. A sample counts as "moving"
  // only for an active mode of transport (walking / running / cycling /
  // automotive) reported at medium-or-higher confidence (Q4). Stationary,
  // unknown, and any low-confidence sample read as not-moving.
  private func rawMoving(_ activity: CMMotionActivity) -> Bool {
    guard activity.confidence != .low else { return false }
    return activity.walking || activity.running || activity.cycling || activity.automotive
  }

  // Apply the N-consistent-samples smoothing and emit a motion:changed
  // event only when the smoothed value actually flips.
  private func handleActivityUpdate(_ activity: CMMotionActivity) {
    let raw = rawMoving(activity)
    if raw == motionEmittedMoving {
      // Sample agrees with what JS already knows; drop any pending flip.
      motionPendingMoving = nil
      motionPendingCount = 0
      return
    }
    if motionPendingMoving == raw {
      motionPendingCount += 1
    } else {
      motionPendingMoving = raw
      motionPendingCount = 1
    }
    if motionPendingCount >= PearCircleLocationModule.MOTION_SMOOTHING_SAMPLES {
      motionPendingMoving = nil
      motionPendingCount = 0
      motionEmittedMoving = raw
      emitMotionChanged(raw)
    }
  }

  private func emitMotionChanged(_ moving: Bool) {
    guard hasListeners else { return }
    sendEvent(withName: PearCircleLocationModule.MOTION_EVENT, body: ["moving": moving])
  }

  // Apply a worklet-requested mode change. "idle" stops continuous
  // delivery and leaves SLC running; "tracking" adds continuous back
  // on top. Idempotent — repeat calls to the same mode are no-ops.
  // Called via the location:mode:set IPC route in app/index.tsx.
  @objc func setMode(
    _ mode: NSString,
    resolve: @escaping RCTPromiseResolveBlock,
    reject: @escaping RCTPromiseRejectBlock
  ) {
    DispatchQueue.main.async {
      let m = mode as String
      guard m == "idle" || m == "tracking" else {
        resolve(false)
        return
      }
      if m == self.currentMode {
        resolve(true)
        return
      }
      self.currentMode = m
      guard let mgr = self.manager else {
        // startUpdates not called yet; mode will apply on next start.
        resolve(true)
        return
      }
      if m == "tracking" {
        mgr.startUpdatingLocation()
      } else {
        mgr.stopUpdatingLocation()
      }
      resolve(true)
    }
  }

  private func handleAuthChange(manager: CLLocationManager, status: CLAuthorizationStatus) {
    let resolve = pendingResolve
    pendingResolve = nil
    switch status {
    case .authorizedAlways, .authorizedWhenInUse:
      startUpdatesNow(manager)
      resolve?(true)
    case .denied, .restricted:
      resolve?(false)
    case .notDetermined:
      // Still pending; restash so the next callback resolves.
      pendingResolve = resolve
    @unknown default:
      resolve?(false)
    }
  }

  private func emitOrBufferRegion(name: String, id: String) {
    let payload: [String: Any] = [
      "id": id,
      "ts": Date().timeIntervalSince1970 * 1000,
    ]
    if hasListeners {
      sendEvent(withName: name, body: payload)
      return
    }
    // No JS listener attached yet (cold-start launch or stopObserving
    // window). Buffer for the next startObserving flush, with a cap
    // so a stuck launch can't pin memory.
    bufferedRegionEvents.append((name: name, body: payload))
    if bufferedRegionEvents.count > PearCircleLocationModule.REGION_BUFFER_MAX {
      bufferedRegionEvents.removeFirst(bufferedRegionEvents.count - PearCircleLocationModule.REGION_BUFFER_MAX)
    }
  }

  private func emitLocation(_ loc: CLLocation) {
    guard hasListeners else { return }
    let level = UIDevice.current.batteryLevel
    let battery: Any = level >= 0 ? Int(round(level * 100)) : NSNull()
    let state = UIDevice.current.batteryState
    // Treat .full as charging so a plugged-in 100%-charged device
    // shows the bolt, matching Android's BATTERY_STATUS_FULL handling.
    let isCharging = state == .charging || state == .full
    let accuracy = loc.horizontalAccuracy >= 0 ? loc.horizontalAccuracy : 0
    let speed = loc.speed >= 0 ? loc.speed : 0
    let payload: [String: Any] = [
      "lat": loc.coordinate.latitude,
      "lon": loc.coordinate.longitude,
      "accuracy": accuracy,
      "ts": loc.timestamp.timeIntervalSince1970 * 1000,
      "speed": speed,
      "battery": battery,
      "isCharging": isCharging,
    ]
    sendEvent(withName: PearCircleLocationModule.UPDATE_EVENT, body: payload)
  }

  // MARK: - Network change

  private func startPathMonitor() {
    let monitor = NWPathMonitor()
    pathMonitor = monitor
    monitor.pathUpdateHandler = { [weak self] path in
      self?.onPathUpdate(path)
    }
    monitor.start(queue: pathQueue)
  }

  private func onPathUpdate(_ path: NWPath) {
    let transport = transportName(path)
    if !hasSeenInitialPath {
      // Skip the first satisfied path: it's the network we're already
      // running on. Re-announcing on cold-start is wasted work.
      hasSeenInitialPath = true
      lastTransport = transport
      return
    }
    if lastTransport == transport { return }
    lastTransport = transport
    debounceItem?.cancel()
    let work = DispatchWorkItem { [weak self] in
      self?.emitNetworkChanged(transport)
    }
    debounceItem = work
    pathQueue.asyncAfter(deadline: .now() + PearCircleLocationModule.DEBOUNCE_SECONDS, execute: work)
  }

  private func transportName(_ path: NWPath) -> String {
    if path.status != .satisfied { return "unknown" }
    if path.usesInterfaceType(.wifi) { return "wifi" }
    if path.usesInterfaceType(.cellular) { return "cellular" }
    if path.usesInterfaceType(.wiredEthernet) { return "ethernet" }
    if path.usesInterfaceType(.other) { return "vpn" }
    return "unknown"
  }

  private func emitNetworkChanged(_ transport: String) {
    guard hasListeners else { return }
    netSeq += 1
    let payload: [String: Any] = [
      "transport": transport,
      "netHandle": Double(netSeq),
    ]
    sendEvent(withName: PearCircleLocationModule.NETWORK_EVENT, body: payload)
  }
}
