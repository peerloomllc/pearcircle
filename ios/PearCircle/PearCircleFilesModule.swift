import Foundation
import UIKit
import UniformTypeIdentifiers

// Files access for account backups (proposal 2026-10-06-owner-continuity,
// part 3). Two things expo-file-system can't do on iOS:
//
//  - exportFile: save through the system "export to Files" picker, which
//    reports whether the user saved or cancelled (the share sheet doesn't).
//  - pickFolder + writeToFolder: pick a folder once, keep a security-scoped
//    bookmark, and rewrite pearcircle-backup.json there later, which is what
//    automatic backup needs. Android does the same through the Storage Access
//    Framework in the shell.
@objc(PearCircleFiles)
class PearCircleFilesModule: NSObject, UIDocumentPickerDelegate {
  private enum Pending {
    case export(RCTPromiseResolveBlock)
    case folder(RCTPromiseResolveBlock)
  }
  private var pending: Pending?

  @objc static func requiresMainQueueSetup() -> Bool { return false }

  // Resolves { saved: Bool }.
  @objc func exportFile(
    _ path: String,
    resolve: @escaping RCTPromiseResolveBlock,
    reject: @escaping RCTPromiseRejectBlock
  ) {
    DispatchQueue.main.async {
      guard let presenter = RCTPresentedViewController() else {
        reject("no_view", "no view controller to present from", nil)
        return
      }
      let url = URL(fileURLWithPath: path)
      let picker = UIDocumentPickerViewController(forExporting: [url], asCopy: true)
      picker.delegate = self
      self.pending = .export(resolve)
      presenter.present(picker, animated: true)
    }
  }

  // Resolves { bookmark: base64, name } or { canceled: true }.
  @objc func pickFolder(
    _ resolve: @escaping RCTPromiseResolveBlock,
    reject: @escaping RCTPromiseRejectBlock
  ) {
    DispatchQueue.main.async {
      guard let presenter = RCTPresentedViewController() else {
        reject("no_view", "no view controller to present from", nil)
        return
      }
      let picker = UIDocumentPickerViewController(forOpeningContentTypes: [UTType.folder])
      picker.delegate = self
      self.pending = .folder(resolve)
      presenter.present(picker, animated: true)
    }
  }

  // Overwrite `filename` inside the bookmarked folder. Resolves { ok: true }
  // plus a fresh `bookmark` when the stored one went stale.
  @objc func writeToFolder(
    _ bookmark: String,
    filename: String,
    contents: String,
    resolve: @escaping RCTPromiseResolveBlock,
    reject: @escaping RCTPromiseRejectBlock
  ) {
    guard let data = Data(base64Encoded: bookmark) else {
      reject("bad_bookmark", "the saved folder is unreadable, pick it again", nil)
      return
    }
    var stale = false
    let folder: URL
    do {
      folder = try URL(resolvingBookmarkData: data, options: [], relativeTo: nil, bookmarkDataIsStale: &stale)
    } catch {
      reject("folder_gone", "the backup folder is no longer available, pick it again", error)
      return
    }
    guard folder.startAccessingSecurityScopedResource() else {
      reject("no_access", "PearCircle lost access to the backup folder, pick it again", nil)
      return
    }
    defer { folder.stopAccessingSecurityScopedResource() }
    let file = folder.appendingPathComponent(filename)
    var coordinatorError: NSError?
    var writeError: Error?
    NSFileCoordinator().coordinate(writingItemAt: file, options: .forReplacing, error: &coordinatorError) { target in
      do { try Data(contents.utf8).write(to: target, options: .atomic) } catch { writeError = error }
    }
    if let err = coordinatorError ?? writeError {
      reject("write_failed", err.localizedDescription, err)
      return
    }
    var result: [String: Any] = ["ok": true]
    if stale, let fresh = try? folder.bookmarkData(options: [], includingResourceValuesForKeys: nil, relativeTo: nil) {
      result["bookmark"] = fresh.base64EncodedString()
    }
    resolve(result)
  }

  func documentPicker(_ controller: UIDocumentPickerViewController, didPickDocumentsAt urls: [URL]) {
    let p = pending
    pending = nil
    switch p {
    case .export(let resolve):
      resolve(["saved": true])
    case .folder(let resolve):
      guard let url = urls.first else { resolve(["canceled": true]); return }
      let access = url.startAccessingSecurityScopedResource()
      defer { if access { url.stopAccessingSecurityScopedResource() } }
      if let data = try? url.bookmarkData(options: [], includingResourceValuesForKeys: nil, relativeTo: nil) {
        resolve(["bookmark": data.base64EncodedString(), "name": url.lastPathComponent])
      } else {
        resolve(["canceled": true, "error": "could not keep access to that folder"])
      }
    case .none:
      break
    }
  }

  func documentPickerWasCancelled(_ controller: UIDocumentPickerViewController) {
    let p = pending
    pending = nil
    switch p {
    case .export(let resolve): resolve(["saved": false])
    case .folder(let resolve): resolve(["canceled": true])
    case .none: break
    }
  }
}
