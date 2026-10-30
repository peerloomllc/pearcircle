import jsQR from 'jsqr'

// Phones: read one QR code with the camera, inside the page. Resolves with its
// text, or null if the person cancels or refuses the camera.
//
// The camera stream comes from getUserMedia (the shell's WebView allows it on
// the https://localhost/ page) and each frame goes through jsQR, as in PearList.
// No native scanner, so no Google ML Kit in the app.
//
// `call` is the shell bridge (pear.call). `pushBack(fn)` puts fn on App.jsx's
// back stack and returns a function that takes it off, so Android Back closes
// the scanner.
export async function scanQr (call, pushBack) {
  // Android's WebView gives no camera without the app's CAMERA permission,
  // so the shell asks for it first. iOS asks by itself on getUserMedia.
  const { granted } = await call('shell:cameraPermission')
  if (!granted) throw new Error('PearCircle needs the camera to scan a QR code. You can allow it in your phone\'s settings.')
  if (!navigator.mediaDevices?.getUserMedia) throw new Error('This device cannot open the camera here.')

  return new Promise((resolve, reject) => {
    const root = document.createElement('div')
        root.style.cssText = 'position:fixed;inset:0;z-index:100000;background:#000;padding:0;display:block'
    const video = document.createElement('video')
    video.muted = true
    video.playsInline = true
    video.setAttribute('playsinline', '')
    video.style.cssText = 'width:100%;height:100%;object-fit:cover'
    const frame = document.createElement('div')
    frame.style.cssText = 'position:absolute;left:50%;top:50%;width:240px;height:240px;margin:-120px 0 0 -120px;border:3px solid #fff;border-radius:16px;pointer-events:none'
    const hint = document.createElement('div')
    hint.textContent = 'Point at the invite QR'
    hint.style.cssText = 'position:absolute;top:70px;left:50%;transform:translateX(-50%);background:rgba(0,0,0,.6);color:#fff;border-radius:10px;padding:10px 16px;font-size:16px;white-space:nowrap'
    const cancel = document.createElement('button')
    cancel.type = 'button'
        cancel.textContent = 'Cancel'
    cancel.style.cssText = 'position:absolute;bottom:60px;left:50%;transform:translateX(-50%);background:rgba(0,0,0,.6);color:#fff;border:none;border-radius:10px;padding:14px 28px;font-size:16px'
    root.append(video, frame, hint, cancel)
    document.body.appendChild(root)

    const canvas = document.createElement('canvas')
    const ctx = canvas.getContext('2d', { willReadFrequently: true })
    let stream = null
    let raf = null
    let done = false
    const popBack = pushBack(() => { finish(null); return true })
    const finish = (text, err) => {
      if (done) return
      done = true
      popBack()
      if (raf) cancelAnimationFrame(raf)
      if (stream) stream.getTracks().forEach((t) => t.stop())
      root.remove()
      if (err) reject(err)
      else resolve(text)
    }
    cancel.onclick = () => finish(null)

    const tick = () => {
      if (done) return
      if (video.readyState >= 2 && video.videoWidth) {
        canvas.width = video.videoWidth
        canvas.height = video.videoHeight
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height)
        let img = null
        try { img = ctx.getImageData(0, 0, canvas.width, canvas.height) } catch {}
        const found = img && jsQR(img.data, img.width, img.height, { inversionAttempts: 'dontInvert' })
        if (found && found.data) return finish(found.data)
      }
      raf = requestAnimationFrame(tick)
    }

    navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } })
      .then(async (s) => {
        stream = s
        if (done) return s.getTracks().forEach((t) => t.stop())
        video.srcObject = s
        await video.play()
        tick()
      })
      .catch((e) => finish(null, new Error(e && e.name === 'NotAllowedError'
        ? 'PearCircle needs the camera to scan a QR code. You can allow it in your phone\'s settings.'
        : 'Could not open the camera.')))
  })
}
