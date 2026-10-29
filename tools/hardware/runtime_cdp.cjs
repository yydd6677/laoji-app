// Inspection transport only. A CDP timeout never cancels/restarts native work.
async function openCdp(WebSocketType, url, { connectMs = 5000, requestMs = 5000 } = {}) {
  const ws = new WebSocketType(url);
  const pending = new Map(); let sequence = 0;
  const lost = () => Error('Inspection connection closed; native work may still be running');
  const failPending = error => {
    for (const item of pending.values()) { clearTimeout(item.timer); item.reject(error); }
    pending.clear();
  };
  ws.addEventListener('close', () => failPending(lost()));
  ws.addEventListener('error', () => failPending(lost()));
  ws.addEventListener('message', event => {
    let value; try { value = JSON.parse(event.data); } catch { return; }
    const item = pending.get(value.id); if (!item) return;
    clearTimeout(item.timer); pending.delete(value.id); item.resolve(value);
  });
  await new Promise((resolve, reject) => {
    const finish = error => {
      clearTimeout(timer);
      ws.removeEventListener('open', opened); ws.removeEventListener('error', failed); ws.removeEventListener('close', failed);
      if (error) { ws.close(); reject(error); } else resolve();
    };
    const opened = () => finish(); const failed = () => finish(lost());
    const timer = setTimeout(() => finish(Error('Inspection connection did not open')), connectMs);
    ws.addEventListener('open', opened); ws.addEventListener('error', failed); ws.addEventListener('close', failed);
  });
  return {
    isOpen: () => ws.readyState === 1,
    evaluate: expression => new Promise((resolve, reject) => {
      if (ws.readyState !== 1) { reject(lost()); return; }
      const id = ++sequence;
      const timer = setTimeout(() => {
        pending.delete(id); reject(Error('Inspection response timed out; native work may still be running'));
      }, requestMs);
      pending.set(id, { resolve, reject, timer });
      try { ws.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, returnByValue: true } })); }
      catch (error) { clearTimeout(timer); pending.delete(id); reject(error); }
    }),
    close: () => { failPending(lost()); ws.close(); },
  };
}
module.exports = { openCdp };
