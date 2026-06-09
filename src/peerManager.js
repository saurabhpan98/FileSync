import { Peer } from 'peerjs';

const CHUNK_SIZE = 14 * 1024; // 14KB per chunk

// MIME type fallback from extension (handles empty file.type from mobile browsers)
const MIME_MAP = {
  jpg:'image/jpeg',jpeg:'image/jpeg',png:'image/png',gif:'image/gif',webp:'image/webp',
  svg:'image/svg+xml',bmp:'image/bmp',tiff:'image/tiff',ico:'image/x-icon',heic:'image/heic',
  mp4:'video/mp4',webm:'video/webm',mov:'video/quicktime',avi:'video/x-msvideo',mkv:'video/x-matroska',
  mp3:'audio/mpeg',wav:'audio/wav',ogg:'audio/ogg',flac:'audio/flac',aac:'audio/aac',m4a:'audio/mp4',
  pdf:'application/pdf',zip:'application/zip',rar:'application/x-rar-compressed','7z':'application/x-7z-compressed',tar:'application/x-tar',gz:'application/gzip',
  doc:'application/msword',docx:'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls:'application/vnd.ms-excel',xlsx:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ppt:'application/vnd.ms-powerpoint',pptx:'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  txt:'text/plain',html:'text/html',htm:'text/html',css:'text/css',js:'text/javascript',json:'application/json',
  apk:'application/vnd.android.package-archive',ipa:'application/x-itunes-ipa',
  dmg:'application/x-apple-diskimage',exe:'application/x-msdownload',sh:'application/x-sh',bat:'application/x-msdos-program',
  csv:'text/csv',xml:'application/xml',psd:'image/vnd.adobe.photoshop',
  ttf:'font/ttf',otf:'font/otf',woff:'font/woff',woff2:'font/woff2',eot:'application/vnd.ms-fontobject',
  rtf:'application/rtf',epub:'application/epub+zip',
};

function guessMimeType(fileName, declaredType) {
  if (declaredType && declaredType !== '') return declaredType;
  const ext = fileName.split('.').pop().toLowerCase();
  return MIME_MAP[ext] || 'application/octet-stream';
}

export function generatePin() {
  return String(Math.floor(100000 + Math.random() * 900000));
}

// TextEncoder/TextDecoder for reliable UTF-8 encoding
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8');

// Binary framing protocol:
// Byte 0 = message type: 0x00 = JSON control, 0x01 = raw file data
// Byte 1.. = payload
const TYPE_JSON  = 0x00;
const TYPE_CHUNK = 0x01;

export class PeerConnection {
  constructor(onStateChange, onFileReceived, onProgress) {
    this.peer = null; this.conn = null;
    this.onStateChange = onStateChange;
    this.onFileReceived = onFileReceived;
    this.onProgress = onProgress;
    this.receiveBuffers = new Map();    // fileId -> [ArrayBuffer, ...]
    this.receiveExpected = new Map();   // fileId -> { total, name, mimeType }
    this.receiveReceived = new Map();   // fileId -> total bytes received
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
        if (err.type === 'unavailable-id') reject(new Error('PIN already in use'));
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
        const conn = this.peer.connect(`fs-s-${pin}`, {
          reliable: true,
          serialization: 'binary',
          ordered: true,
        });
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
    const ids = [];
    for (const file of fileList) {
      const fileId = crypto.randomUUID();
      ids.push({ fileId, name: file.name, size: file.size });
      this._sendFile(file, fileId);
    }
    return ids;
  }

  disconnect() {
    if (this.conn) { try { this.conn.close(); } catch(_){} this.conn = null; }
    if (this.peer) { try { this.peer.destroy(); } catch(_){} this.peer = null; }
    this.receiveBuffers.clear(); this.receiveExpected.clear();
    this.receiveReceived.clear();
    this.currentReceiveId = null; this.onStateChange('disconnected');
  }

  _setupConnection() {
    this.conn.on('close', () => this.onStateChange('disconnected'));
    this.conn.on('error', () => this.onStateChange('error'));
    this.conn.on('data', (data) => this._handleData(data));
  }

  _handleData(rawData) {
    // rawData comes as ArrayBuffer (binary serialization)
    let data;
    if (rawData instanceof ArrayBuffer) {
      data = rawData;
    } else if (rawData instanceof Uint8Array) {
      data = rawData.buffer.slice(rawData.byteOffset, rawData.byteOffset + rawData.byteLength);
    } else if (rawData instanceof Blob) {
      // This shouldn't happen with binary serialization but handle it
      rawData.arrayBuffer().then((ab) => this._handleData(ab));
      return;
    } else if (typeof rawData === 'string') {
      // Fallback: treat string as UTF-8 JSON
      try {
        const msg = JSON.parse(rawData);
        if (msg.type === 'file-start') this._handleFileStart(msg);
        else if (msg.type === 'file-end') this._finalizeFile(msg.fileId);
      } catch {}
      return;
    } else {
      return;
    }

    const view = new Uint8Array(data);
    const msgType = view[0];
    const payload = data.slice(1); // slice creates a new ArrayBuffer

    if (msgType === TYPE_JSON) {
      const text = decoder.decode(new Uint8Array(payload));
      try {
        const msg = JSON.parse(text);
        if (msg.type === 'file-start') this._handleFileStart(msg);
        else if (msg.type === 'file-end') this._finalizeFile(msg.fileId);
      } catch (e) {
        console.error('[FileSync] JSON parse error:', e);
      }
    } else if (msgType === TYPE_CHUNK) {
      if (this.currentReceiveId && this.receiveBuffers.has(this.currentReceiveId)) {
        this.receiveBuffers.get(this.currentReceiveId).push(payload);
        const newTotal = this.receiveReceived.get(this.currentReceiveId) + payload.byteLength;
        this.receiveReceived.set(this.currentReceiveId, newTotal);
        const exp = this.receiveExpected.get(this.currentReceiveId);
        if (exp) {
          this.onProgress(this.currentReceiveId, {
            progress: Math.min((newTotal / exp.total) * 100, 100),
            status: 'receiving',
            name: exp.name,
            size: exp.total,
          });
        }
      }
    }
  }

  _handleFileStart(msg) {
    const mimeType = guessMimeType(msg.fileName, msg.mimeType);
    this.currentReceiveId = msg.fileId;
    this.receiveBuffers.set(msg.fileId, []);
    this.receiveReceived.set(msg.fileId, 0);
    this.receiveExpected.set(msg.fileId, {
      total: msg.fileSize,
      name: msg.fileName,
      mimeType: mimeType,
    });
    console.log(`[FileSync] Receiving: ${msg.fileName} (${msg.fileSize} bytes, MIME: ${mimeType})`);
    this.onProgress(msg.fileId, { progress: 0, status: 'receiving', name: msg.fileName, size: msg.fileSize });
  }

  _finalizeFile(fileId) {
    const chunks = this.receiveBuffers.get(fileId);
    const exp = this.receiveExpected.get(fileId);
    const received = this.receiveReceived.get(fileId);
    if (!chunks || !exp) return;

    const actualSize = received || chunks.reduce((s, c) => s + c.byteLength, 0);

    console.log(`[FileSync] File received: ${exp.name} | Expected: ${exp.total} bytes | Got: ${actualSize} bytes | MIME: ${exp.mimeType}`);

    if (actualSize !== exp.total) {
      console.error(`[FileSync] ⚠️ SIZE MISMATCH: expected ${exp.total}, received ${actualSize}`);
    }

    // Build Blob from ArrayBuffer chunks
    const blob = new Blob(chunks, { type: exp.mimeType });

    // Create File object with explicit type and extension
    const file = new File([blob], exp.name, {
      type: exp.mimeType,
      lastModified: Date.now(),
    });

    // Store metadata separately in case File.type is lost by the browser
    file._mimeType = exp.mimeType;
    file._size = actualSize;

    console.log(`[FileSync] File object: name="${file.name}", type="${file.type}", size=${file.size}`);

    this.onFileReceived(file);

    this.receiveBuffers.delete(fileId);
    this.receiveExpected.delete(fileId);
    this.receiveReceived.delete(fileId);
    this.currentReceiveId = null;
    this.onProgress(fileId, { progress: 100, status: 'received', name: exp.name, size: actualSize });
  }

  _sendFile(file, fileId) {
    const mimeType = guessMimeType(file.name, file.type);
    console.log(`[FileSync] Sending: ${file.name} | Size: ${file.size} bytes | MIME: ${mimeType}`);

    // Send file-start as framed JSON
    const jsonMsg = JSON.stringify({
      type: 'file-start',
      fileId,
      fileName: file.name,
      fileSize: file.size,
      mimeType: mimeType,
    });
    this._sendFramed(TYPE_JSON, encoder.encode(jsonMsg));

    this.onProgress(fileId, { progress: 0, status: 'sending', name: file.name, size: file.size });

    file.arrayBuffer().then((ab) => {
      let offset = 0;
      const send = () => {
        if (offset >= ab.byteLength) {
          // Send file-end marker
          const endMsg = JSON.stringify({ type: 'file-end', fileId });
          this._sendFramed(TYPE_JSON, encoder.encode(endMsg));
          this.onProgress(fileId, { progress: 100, status: 'sent', name: file.name, size: file.size });
          return;
        }
        const end = Math.min(offset + CHUNK_SIZE, ab.byteLength);
        const chunk = ab.slice(offset, end);
        this._sendFramed(TYPE_CHUNK, new Uint8Array(chunk));
        offset = end;
        this.onProgress(fileId, { progress: (offset / ab.byteLength) * 100, status: 'sending', name: file.name, size: file.size });
        setTimeout(send, 3);
      };
      send();
    });
  }

  // Send data with 1-byte type prefix
  _sendFramed(type, payload) {
    if (!this.conn?.open) return;
    const frame = new Uint8Array(payload.length + 1);
    frame[0] = type;
    frame.set(payload, 1);
    this.conn.send(frame.buffer);
  }
}
