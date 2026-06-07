import { Peer } from 'peerjs';

const CHUNK_SIZE = 8 * 1024; // 8KB — safe chunk size

export function generatePin() {
  return String(Math.floor(100000 + Math.random() * 900000));
}

function arrayBufferToBase64(buffer) {
  let binary = '';
  const bytes = new Uint8Array(buffer);
  const len = bytes.byteLength;
  for (let i = 0; i < len; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

function base64ToArrayBuffer(base64) {
  const binary = atob(base64);
  const len = binary.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

export class PeerConnection {
  constructor(onStateChange, onFileReceived, onProgress) {
    this.peer = null;
    this.conn = null;
    this.onStateChange = onStateChange;
    this.onFileReceived = onFileReceived;
    this.onProgress = onProgress;
    this.receiveBuffers = new Map();
    this.receiveExpected = new Map();
    this.currentReceiveId = null;
  }

  async startSender(pin) {
    return new Promise((resolve, reject) => {
      this.peer = new Peer(`fs-s-${pin}`, { debug: 0 });
      this.peer.on('open', () => { this.onStateChange('waiting'); resolve(pin); });
      this.peer.on('connection', (conn) => {
        this.conn = conn;
        this._setupConnection();
        conn.on('open', () => this.onStateChange('connected'));
      });
      this.peer.on('error', (err) => {
        if (err.type === 'unavailable-id') reject(new Error('PIN in use'));
        else reject(err);
      });
      setTimeout(() => {
        if (this.peer && !this.conn) { this.peer.destroy(); reject(new Error('Timed out')); }
      }, 180000);
    });
  }

  async startReceiver(pin) {
    return new Promise((resolve, reject) => {
      this.peer = new Peer(`fs-r-${generatePin()}`, { debug: 0 });
      this.peer.on('open', () => {
        this.onStateChange('connecting');
        const conn = this.peer.connect(`fs-s-${pin}`, { reliable: true, serialization: 'json' });
        this.conn = conn;
        this._setupConnection();
        conn.on('open', () => { this.onStateChange('connected'); resolve(); });
        conn.on('error', () => reject(new Error('Connection failed')));
      });
      this.peer.on('error', (err) => {
        if (err.type === 'peer-unavailable') reject(new Error('Sender not found'));
        else reject(err);
      });
      setTimeout(() => {
        if (this.peer?.open && !this.conn?.open) { this.peer.destroy(); reject(new Error('Timed out')); }
      }, 30000);
    });
  }

  async sendFiles(fileList) {
    if (!this.conn?.open) throw new Error('Not connected');
    for (const file of fileList) this._sendFile(file, crypto.randomUUID());
  }

  disconnect() {
    if (this.conn) { try { this.conn.close(); } catch(_){} this.conn = null; }
    if (this.peer) { try { this.peer.destroy(); } catch(_){} this.peer = null; }
    this.receiveBuffers.clear(); this.receiveExpected.clear();
    this.currentReceiveId = null; this.onStateChange('disconnected');
  }

  _setupConnection() {
    this.conn.on('close', () => this.onStateChange('disconnected'));
    this.conn.on('error', () => this.onStateChange('error'));
    this.conn.on('data', (d) => this._handleData(d));
  }

  _handleData(data) {
    if (typeof data === 'string') {
      let msg; try { msg = JSON.parse(data); } catch { return; }

      if (msg.type === 'file-start') {
        this.currentReceiveId = msg.fileId;
        this.receiveBuffers.set(msg.fileId, []);
        this.receiveExpected.set(msg.fileId, {
          total: msg.fileSize, name: msg.fileName, mimeType: msg.mimeType || 'application/octet-stream'
        });
        this.onProgress(msg.fileId, { progress: 0, status: 'receiving' });
      } else if (msg.type === 'file-chunk') {
        const id = msg.fileId;
        const chunks = this.receiveBuffers.get(id);
        if (!chunks) return;
        const ab = base64ToArrayBuffer(msg.data);
        chunks.push(ab);
        this._updateProgress(id);
      } else if (msg.type === 'file-end') {
        this._finalizeFile(msg.fileId);
      }
    }
  }

  _updateProgress(fileId) {
    const exp = this.receiveExpected.get(fileId);
    if (!exp) return;
    const chunks = this.receiveBuffers.get(fileId);
    if (!chunks) return;
    const recv = chunks.reduce((s, c) => s + c.byteLength, 0);
    this.onProgress(fileId, { progress: Math.min((recv / exp.total) * 100, 100), status: 'receiving' });
  }

  _finalizeFile(fileId) {
    const chunks = this.receiveBuffers.get(fileId);
    const exp = this.receiveExpected.get(fileId);
    if (!chunks || !exp) return;

    const receivedSize = chunks.reduce((s, c) => s + c.byteLength, 0);

    if (receivedSize !== exp.total) {
      console.error(`Size mismatch! Expected ${exp.total}, got ${receivedSize}`);
    }

    const blob = new Blob(chunks, { type: exp.mimeType });
    const file = new File([blob], exp.name, { type: exp.mimeType });
    this.onFileReceived(file);

    this.receiveBuffers.delete(fileId);
    this.receiveExpected.delete(fileId);
    this.currentReceiveId = null;
    this.onProgress(fileId, { progress: 100, status: 'received' });
  }

  _sendFile(file, fileId) {
    this.conn.send(JSON.stringify({
      type: 'file-start', fileId,
      fileName: file.name, fileSize: file.size,
      mimeType: file.type || 'application/octet-stream',
    }));
    this.onProgress(fileId, { progress: 0, status: 'sending' });

    file.arrayBuffer().then((ab) => {
      let offset = 0;
      const send = () => {
        if (offset >= ab.byteLength) {
          this.conn.send(JSON.stringify({ type: 'file-end', fileId }));
          this.onProgress(fileId, { progress: 100, status: 'sent' });
          return;
        }
        const end = Math.min(offset + CHUNK_SIZE, ab.byteLength);
        const chunk = ab.slice(offset, end);
        this.conn.send(JSON.stringify({
          type: 'file-chunk', fileId, data: arrayBufferToBase64(chunk)
        }));
        offset = end;
        this.onProgress(fileId, { progress: (offset / ab.byteLength) * 100, status: 'sending' });
        setTimeout(send, 2);
      };
      send();
    });
  }
}
