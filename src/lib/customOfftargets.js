let worker = null
let nextRequestId = 1
const requests = new Map()

function ensureWorker() {
  if (worker) return worker
  worker = new Worker(new URL('../workers/customOfftargets.worker.js', import.meta.url), { type: 'module' })
  worker.addEventListener('error', (event) => {
    const error = new Error(event.message || 'Custom off-target worker failed')
    for (const request of requests.values()) {
      request.cleanup()
      request.reject(error)
    }
    requests.clear()
  })
  worker.addEventListener('message', (event) => {
    const message = event.data
    const request = requests.get(message.requestId)
    if (!request) return
    if (message.type === 'progress') {
      request.onProgress?.({ completed: message.completed, total: message.total })
      return
    }
    requests.delete(message.requestId)
    request.cleanup()
    if (message.type === 'result') request.resolve(message.result)
    else if (message.type === 'error') request.reject(new Error(message.detail || 'Custom off-target scan failed'))
  })
  return worker
}

export function setCustomOffTargetReference(records) {
  if (worker) worker.terminate()
  worker = null
  for (const request of requests.values()) {
    request.cleanup()
    request.reject(new DOMException('Reference replaced', 'AbortError'))
  }
  requests.clear()
  ensureWorker().postMessage({
    type: 'init',
    records: records.map(({ name, seq }) => ({ name, seq })),
  })
}

export function fetchCustomOffTargets({ pam, guides }, signal, onProgress) {
  const activeWorker = ensureWorker()
  const requestId = nextRequestId++
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      activeWorker.postMessage({ type: 'cancel', requestId })
      requests.delete(requestId)
      reject(new DOMException('Aborted', 'AbortError'))
    }
    const cleanup = () => signal?.removeEventListener('abort', onAbort)
    if (signal?.aborted) { onAbort(); return }
    signal?.addEventListener('abort', onAbort, { once: true })
    requests.set(requestId, { resolve, reject, onProgress, cleanup })
    activeWorker.postMessage({ type: 'scan', requestId, pam, guides })
  })
}
