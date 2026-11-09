(async () => {
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  const waitFor = async (fn, ms) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (fn()) return true; await sleep(100); } return false; };
  const ready = await waitFor(() => document.getElementById('byteCap').textContent !== '—', 9000);
  const out = { protocol: location.protocol, ready };
  document.getElementById('playBtn').click();
  out.playOk = await waitFor(() => document.querySelectorAll('#frameStrip i').length > 0, 12000);
  out.playStatus = document.getElementById('statusText').textContent;
  out.meta = document.getElementById('sendMeta').textContent;
  // microphone on file:// must fail gracefully
  document.getElementById('micBtn').click();
  await sleep(1500);
  out.micStatus = document.getElementById('statusText').textContent;
  out.micLabel = document.getElementById('micLabel').textContent;
  return JSON.stringify(out, null, 1);
})()
