# 🔐 SwiftSync — QR & PIN-Based P2P File Transfer

**SwiftSync** is a secure, serverless, peer-to-peer file transfer application. One device generates a 6-digit PIN, the other enters it (or scans a QR code), and files transfer directly via **WebRTC** — no servers, no databases, no uploads.

**[🚀 Live Demo](https://saurabhpan98.github.io/SwiftSync/)**

---

## 📖 Table of Contents

- [How It Works](#-how-it-works)
- [Architecture & Tech Stack](#-architecture--tech-stack)
- [Security Deep Dive](#-security-deep-dive)
- [Can FileSync Be Hacked?](#-can-filesync-be-hacked)
- [Features](#-features)
- [Getting Started](#-getting-started)
- [Project Structure](#-project-structure)
- [FAQ](#-faq)
- [License](#-license)

---

## 🧠 How It Works

### The Flow

```
┌─────────────────┐                    ┌─────────────────┐
│   Device A      │                    │   Device B      │
│  (Sender)       │                    │  (Receiver)     │
│                 │                    │                 │
│ 1. Clicks       │                    │ 2. Enters PIN   │
│    "Send"       │    6-digit PIN     │    or scans QR  │
│    Gets PIN     │ ◄────────────────► │                 │
│                 │                    │                 │
│ 3. WebRTC       │    Direct P2P     │ 4. Receives     │
│    Connection   │ ◄════════════════►│    Files         │
│                 │                    │                 │
│ 5. Sends Files  │    Encrypted      │ 6. Downloads    │
│    via Data     │    Binary Data    │    via Browser   │
│    Channel      │                    │                 │
└─────────────────┘                    └─────────────────┘
```

### Step-by-Step

1. **Generate PIN**: Sender clicks "Send — Generate PIN" and gets a random 6-digit PIN
2. **Share PIN**: Sender shares the PIN verbally or via QR code
3. **PeerJS Signaling**: Both devices connect to the **PeerJS cloud signaling server** using the PIN as a rendezvous point
4. **WebRTC Handshake**: Browsers negotiate a direct peer-to-peer connection using ICE/STUN/TURN
5. **Direct Transfer**: Files stream directly between browsers via WebRTC Data Channels
6. **No Uploads**: Files never touch any server — they go directly from one device to the other

---

## 🏗 Architecture & Tech Stack

| Layer | Technology | Purpose |
|-------|-----------|---------|
| **Frontend Framework** | React 18 | UI components and state management |
| **Build Tool** | Vite 5 | Fast dev server and production builds |
| **Styling** | TailwindCSS 3 | Utility-first CSS |
| **P2P Connection** | PeerJS (WebRTC abstraction) | Peer-to-peer data channels |
| **QR Codes** | qrcode.react | QR code generation |
| **PWA Support** | vite-plugin-pwa | Installable as a native-like app |
| **Hosting** | GitHub Pages | Static deployment |

### Binary Framing Protocol

FileSync uses a custom **binary framing protocol** over WebRTC Data Channels:

```
┌──────────────┬──────────────────────────┐
│  Byte 0      │  Bytes 1..N              │
│  Type        │  Payload                 │
├──────────────┼──────────────────────────┤
│  0x00        │  UTF-8 JSON (control)    │  ← file-start, file-end
│  0x01        │  Raw binary chunks       │  ← file data (14KB each)
└──────────────┴──────────────────────────┘
```

- **Control messages** (0x00): JSON with file metadata (name, size, MIME type, UUID)
- **Data chunks** (0x01): Raw binary data in 14KB chunks for efficient streaming
- Each file gets a unique `crypto.randomUUID()` for tracking

### MIME Type Handling

FileSync maintains a comprehensive MIME type map (60+ types) to ensure files are correctly identified even on mobile browsers that don't report file types reliably.

---

## 🔒 Security Deep Dive

### 1. End-to-End Encryption (WebRTC DTLS-SRTP)

WebRTC mandates **DTLS-SRTP** encryption on all data channels. This means:

- **Every byte** sent between peers is encrypted with AES-128 or AES-256
- **DTLS handshake** provides mutual authentication of peers
- **No man-in-the-middle** can read the data in transit

> **Key Point**: FileSync doesn't add its own encryption layer — it doesn't need to. WebRTC's mandatory encryption is industry-standard, used by Google Meet, Zoom, and Microsoft Teams.

### 2. No Server Stores Your Files

- **Zero file storage**: Files are streamed directly between browsers and held only in memory (RAM)
- **No cloud upload**: When you "send" a file, it goes directly to the receiver's browser — no intermediate server
- **No database**: There is no database, no file storage backend, no logging server

### 3. PIN Security

- **6-digit PIN**: 1,000,000 possible combinations (10⁶)
- **No brute-force risk**: Each PIN can only be used once. Once a connection is established, that PIN is consumed
- **180-second timeout**: If no one connects within 3 minutes, the PIN expires
- **Not stored anywhere**: PINs are ephemeral — generated in the browser, used for signaling, then discarded
- **PeerJS prefix**: PINs are prefixed (`fs-s-XXXXXX` / `fs-r-XXXXXX`) to namespace connections

### 4. PeerJS Cloud Server

The **only** server dependency is the PeerJS cloud signaling server (`0.peerjs.com`). This server:

- **Only relays signaling data** (ICE candidates, SDP offers/answers) during connection setup
- **Never sees file data** — once the WebRTC connection is established, all file data flows directly between peers
- **Does not store signaling data** — messages are relayed in real-time and discarded
- **Is open-source**: You can [run your own PeerJS server](https://github.com/peers/peerjs-server) for complete server control

### 5. Browser Sandbox

- All file data exists only in the **browser's memory sandbox**
- Received files are stored as **in-memory Blobs**, not on disk
- Users explicitly click "Save" to download files to their device
- No cookies, no localStorage, no IndexedDB used for file data

---

## 🛡 Can FileSync Be Hacked?

No system is 100% unhackable, but FileSync is designed with strong security properties. Here's an honest assessment:

### Attack Vectors & Mitigations

| Attack | Risk Level | Mitigation |
|--------|-----------|------------|
| **PIN Brute-Force** | Low | 1M combinations; single-use PINs; 180s timeout |
| **MITM on WebRTC** | Very Low | DTLS encryption; browser-enforced certificate pinning |
| **Malicious Signaling Server** | Low-Medium | Server never sees file data; self-host option available |
| **QR Code Spoofing** | Low | QR encodes URL + PIN; user verifies PIN matches |
| **Browser Exploits** | Low | Standard browser security model; no native code |
| **Network Sniffing** | Very Low | All traffic is DTLS-encrypted |
| **Social Engineering** | Medium | User awareness needed (share PIN only with intended recipient) |

### Honest Limitations

1. **Signaling server trust**: The default PeerJS cloud server could theoretically be compromised. An attacker controlling the signaling server could:
   - Redirect connections to a malicious peer (but DTLS would prevent data theft)
   - Log which PINs are in use and when
   - **Mitigation**: Host your own PeerJS server for complete control

2. **PIN interception**: If someone overhears or sees your PIN, they could connect instead of the intended recipient
   - **Mitigation**: Share PINs securely (in person, encrypted messaging, etc.)

3. **No file integrity verification**: FileSync doesn't compute checksums/hashes of transferred files
   - **Mitigation**: WebRTC's SCTP transport provides reliable, ordered delivery with built-in integrity checks. For critical transfers, verify file hashes independently.

4. **No authentication beyond PIN**: Anyone with the PIN can connect
   - **Mitigation**: The PIN acts as a one-time password. For stronger security, use additional out-of-band verification.

---

## ✨ Features

- 🔢 **6-Digit PIN Pairing** — Simple, human-readable connection codes
- 📱 **QR Code Scanning** — Scan to connect instantly; QR encodes full URL for one-tap connection
- 📂 **Any File Type** — 60+ MIME types supported with automatic detection
- 📦 **Any File Size** — Chunked streaming (14KB chunks) handles large files
- 🔒 **End-to-End Encrypted** — Mandatory WebRTC DTLS encryption
- 📲 **PWA Support** — Install on home screen, works offline (after initial load)
- 📋 **Transfer History** — Track sent and received files with progress bars
- 🎨 **Modern Dark UI** — Gradient accents, glass-morphism, smooth animations
- ⚡ **Zero Configuration** — No signup, no setup, no account needed
- 🌐 **Cross-Platform** — Works on any modern browser (Chrome, Firefox, Safari, Edge)

---

## 🚀 Getting Started

### Prerequisites

- [Node.js](https://nodejs.org/) 18+
- npm (comes with Node.js)

### Installation

```bash
# Clone the repository
git clone https://github.com/saurabhpan98/FileSync.git
cd FileSync

# Install dependencies
npm install

# Start development server
npm run dev

# Build for production
npm run build

# Preview production build
npm run preview
```

### Usage

1. Open the app on two devices (or two browser tabs)
2. **Device A**: Click **"Send — Generate PIN"**
3. **Device B**: Enter the 6-digit PIN or scan the QR code
4. Once connected, select files and send
5. Received files appear in the "Received" section — click "Save" to download

---

## 📁 Project Structure

```
FileSync/
├── public/
│   ├── favicon.svg
│   ├── manifest.json
│   └── icons/              # PWA icons (192px, 512px, maskable)
├── src/
│   ├── main.jsx            # React entry point
│   ├── App.jsx             # Main app component (UI, state, logic)
│   ├── peerManager.js      # WebRTC/PeerJS abstraction layer
│   └── index.css           # Tailwind + custom styles/animations
├── index.html              # HTML shell with splash screen
├── vite.config.js          # Vite + PWA plugin config
├── package.json            # Dependencies and scripts
└── README.md               # This file
```

---

## ❓ FAQ

### Is SwiftSync truly serverless?

**Almost.** The file transfer itself is 100% peer-to-peer with no server involvement. However, the initial connection setup uses the **PeerJS cloud signaling server** to exchange WebRTC connection details. You can self-host your own PeerJS server for a fully self-contained setup.

### Does SwiftSync work over the internet?

**Yes!** WebRTC uses ICE/STUN/TURN to establish connections across NATs and firewalls. For direct connections, both devices need to be reachable. If both are behind restrictive NATs, a TURN relay server is needed (PeerJS cloud provides this, or you can configure your own).

### Does SwiftSync work on the same network (LAN)?

**Yes, and it's even faster!** On the same network, WebRTC establishes a direct LAN connection with minimal latency.

### Can I transfer files between different browsers/devices?

**Yes!** FileSync works across any modern browsers: Chrome, Firefox, Safari, Edge, and their mobile versions.

### What happens if the connection drops?

If the WebRTC connection drops, the transfer is interrupted. You'll need to reconnect with a new PIN and re-send the files. FileSync does not currently support resume functionality.

### Is there a file size limit?

**No hard limit.** Since files are streamed in 14KB chunks, extremely large files (multi-GB) are possible. However, browser memory limits apply — both sender and receiver need enough RAM to hold the file. For very large files, consider using dedicated file transfer tools.

### Can I use SwiftSync offline?

**Partially.** Once the PWA is installed and the app shell is cached, the UI loads offline. However, an internet connection is needed for the PeerJS signaling during connection setup. After the WebRTC connection is established, files can transfer over LAN without internet.

---

## 📄 License

Apache 2.0 License — see the [LICENSE](LICENSE) file for details.

---

**Made with ❤️ by [Saurabh Panchal](https://github.com/saurabhpan98)**
