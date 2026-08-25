import { Html5Qrcode } from 'html5-qrcode';

let instance = null;
let active = false;

export async function startScanner({ elementId, onResult, onError }) {
  try {
    instance = new Html5Qrcode(elementId, { verbose: false });
    active = true;
    await instance.start(
      { facingMode: 'environment' },
      { fps: 10, qrbox: { width: 240, height: 150 } },
      (decodedText) => onResult(decodedText),
      () => {} // ruído de frame sem leitura — ignorar
    );
  } catch (err) {
    active = false;
    onError(err);
  }
}

export async function stopScanner() {
  if (instance && active) {
    try { await instance.stop(); instance.clear(); } catch (e) { /* ignora */ }
  }
  instance = null;
  active = false;
}

export function isScannerActive() {
  return active;
}
