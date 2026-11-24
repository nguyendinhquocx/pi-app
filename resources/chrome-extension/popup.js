const isZh = /^zh\b/i.test(navigator.language || '')

const LABELS = {
  unpaired: 'Not paired yet.',
  connecting: 'Connecting to LiX…',
  connected: 'Connected. The AI can now open tabs in its own window.',
  disconnected: 'LiX is not reachable (is it running, with My Chrome turned on?). Retrying…',
  rejected: 'LiX rejected the code. Copy a fresh one.',
}

$('togglePairBtn').onclick = () => {
  forceShowPair = !forceShowPair
  void render()
}

$('borrowBtn').onclick = async () => {
  await rpc('popup.borrowActive')
  void render()
}

$('detachBtn').onclick = async () => {
  await rpc('popup.detachAll')
  $('msg').textContent = T.detachedToast
  void render()
}

$('returnAllBtn').onclick = async () => {
  await rpc('popup.returnAll')
  void render()
}

$('save').onclick = async () => {
  const m = /^pi-bridge:(\d{2,5}):([A-Za-z0-9_-]{16,128})$/.exec($('code').value.trim())
  if (!m) {
    $('msg').textContent = T.badCode
    return
  }
  await chrome.storage.local.set({ port: Number(m[1]), token: m[2] })
  $('code').value = ''
  forceShowPair = false
  setTimeout(render, 500)
}

chrome.storage.onChanged.addListener(() => void render())
void render()
