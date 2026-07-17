import baileys from '@whiskeysockets/baileys';
const {
    default: makeWASocket,
    useMultiFileAuthState,
    DisconnectReason,
    fetchLatestBaileysVersion,
    makeCacheableSignalKeyStore,
} = baileys;
import axios from 'axios';
import pino from 'pino';
import http from 'http';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const QRCode = require('qrcode');

const WEBHOOK_URL   = process.env.WEBHOOK_URL;
const WEBHOOK_TOKEN = process.env.WEBHOOK_TOKEN;
const ACCOUNT_NAME  = process.env.ACCOUNT_NAME || 'default';
const AUTH_DIR      = process.env.AUTH_DIR || './auth';
const PORT          = process.env.PORT || 3000;

if (!WEBHOOK_URL || !WEBHOOK_TOKEN) {
    console.error('Missing WEBHOOK_URL or WEBHOOK_TOKEN env vars');
    process.exit(1);
}

const logger = pino({ level: 'silent' });

let currentQR = null;
let connected = false;

// HTTP server: sirve el QR como imagen en el navegador
const server = http.createServer(async (req, res) => {
    if (req.url === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: connected ? 'connected' : 'waiting_qr', account: ACCOUNT_NAME }));
        return;
    }

    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });

    if (connected) {
        res.end(`<!DOCTYPE html><html><body style="font-family:sans-serif;text-align:center;padding:40px">
            <h2>✅ WhatsApp conectado</h2>
            <p>Cuenta: <strong>${ACCOUNT_NAME}</strong></p>
            <p>Los mensajes se reenvían a Servixia.</p>
        </body></html>`);
        return;
    }

    if (!currentQR) {
        res.end(`<!DOCTYPE html><html><head><meta http-equiv="refresh" content="3"></head>
            <body style="font-family:sans-serif;text-align:center;padding:40px">
            <h2>⏳ Generando QR...</h2>
            <p>Esta página se recarga automáticamente.</p>
        </body></html>`);
        return;
    }

    try {
        const qrDataUrl = await QRCode.toDataURL(currentQR, { width: 300, margin: 2 });
        res.end(`<!DOCTYPE html><html><head><meta http-equiv="refresh" content="20"></head>
            <body style="font-family:sans-serif;text-align:center;padding:40px">
            <h2>📱 Escanea con WhatsApp</h2>
            <p>WhatsApp → Dispositivos vinculados → Vincular dispositivo</p>
            <img src="${qrDataUrl}" style="max-width:300px;border:2px solid #25d366;border-radius:8px" />
            <p style="color:#666;font-size:13px">Se renueva cada 20s. Si expira, recarga.</p>
        </body></html>`);
    } catch (err) {
        res.end(`<p>Error: ${err.message}</p>`);
    }
});

server.listen(PORT, () => {
    console.log(`[QR Server] Puerto ${PORT} listo — abre la URL del deployment para escanear el QR`);
});

async function sendToServixia(senderPhone, senderName, preview) {
    try {
        await axios.post(WEBHOOK_URL, {
            account:      ACCOUNT_NAME,
            sender_phone: senderPhone,
            sender_name:  senderName,
            preview:      preview?.substring(0, 500),
            received_at:  new Date().toISOString(),
        }, {
            headers: { 'X-Webhook-Token': WEBHOOK_TOKEN },
            timeout: 8000,
        });
        console.log(`[${new Date().toISOString()}] ✓ Notificado: ${senderName || senderPhone}`);
    } catch (err) {
        console.error(`[${new Date().toISOString()}] ✗ Webhook error: ${err.message}`);
    }
}

async function connect() {
    const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
    const { version } = await fetchLatestBaileysVersion();
    console.log(`[${new Date().toISOString()}] Conectando con protocolo WA ${version.join('.')}`);

    const sock = makeWASocket({
        version,
        logger,
        auth: {
            creds: state.creds,
            keys: makeCacheableSignalKeyStore(state.keys, logger),
        },
        printQRInTerminal: false,
        generateHighQualityLinkPreview: false,
        browser: ['Chrome', 'Chrome', '124.0.0'],
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', ({ connection, lastDisconnect, qr }) => {
        if (qr) {
            currentQR = qr;
            console.log(`[${new Date().toISOString()}] 📱 QR listo — abre la URL del deployment para escanearlo`);
        }

        if (connection === 'open') {
            connected = true;
            currentQR = null;
            console.log(`[${new Date().toISOString()}] ✅ Conectado a WhatsApp (cuenta: ${ACCOUNT_NAME})`);
        }

        if (connection === 'close') {
            connected = false;
            const err  = lastDisconnect?.error;
            const code = err?.output?.statusCode;
            console.log(`[${new Date().toISOString()}] Desconectado. Código: ${code ?? 'none'}. Error: ${err?.message ?? 'desconocido'}`);

            if (code === DisconnectReason.loggedOut) {
                console.error('Sesión cerrada. Borra el directorio auth/ y vuelve a escanear el QR.');
                process.exit(1);
            }

            // Jitter aleatorio entre 15-45s para no parecer bot
            const delay = 15000 + Math.floor(Math.random() * 30000);
            console.log(`Reconectando en ${Math.round(delay / 1000)}s...`);
            setTimeout(connect, delay);
        }
    });

    sock.ev.on('messages.upsert', async ({ messages, type }) => {
        if (type !== 'notify') return;

        for (const msg of messages) {
            // Ignorar mensajes propios
            if (msg.key.fromMe) continue;
            // Ignorar mensajes de grupos
            if (msg.key.remoteJid?.endsWith('@g.us')) continue;

            const senderPhone = msg.key.remoteJid?.replace('@s.whatsapp.net', '') ?? '';
            const senderName  = msg.pushName ?? '';
            const preview     = msg.message?.conversation
                             ?? msg.message?.extendedTextMessage?.text
                             ?? msg.message?.imageMessage?.caption
                             ?? '[archivo]';

            await sendToServixia(senderPhone, senderName, preview);
        }
    });
}

connect();
